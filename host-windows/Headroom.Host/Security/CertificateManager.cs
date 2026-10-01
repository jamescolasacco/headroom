using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Headroom.Host.Config;
using Headroom.Host.Util;

namespace Headroom.Host.Security;

/// <summary>
/// Provides the TLS certificate for every incoming connection (selected by SNI):
///   * *.ts.net names     -> a real Let's Encrypt cert obtained with `tailscale cert` (no device setup needed)
///   * custom cert files  -> whatever the user configured
///   * everything else    -> a server cert issued by a per-host "Headroom Local CA". Install the CA once on
///                           each viewing device (iOS: download the profile from http://host:7080/).
/// Browsers require a secure context for WebCodecs, service workers and wss://, so this matters.
/// </summary>
public sealed class CertificateManager
{
    private readonly object _gate = new();
    private X509Certificate2? _ca;
    private X509Certificate2? _server;
    private X509Certificate2? _tailscale;
    private X509Certificate2? _custom;
    private string? _tailscaleName;
    private DateTime _tailscaleCheckedAt = DateTime.MinValue;
    private HashSet<string> _serverNames = new();
    private Timer? _refreshTimer;

    private static string CaFile => Path.Combine(Paths.CertDir, "ca.pfx.protected");
    private static string ServerFile => Path.Combine(Paths.CertDir, "server.pfx.protected");

    public X509Certificate2 CaCertificate => _ca ?? throw new InvalidOperationException("CA not initialized");
    public string? TailscaleName => _tailscaleName;

    public void Initialize()
    {
        Directory.CreateDirectory(Paths.CertDir);
        var tls = ConfigStore.Current.Tls;
        if (tls.Mode == "custom" && tls.CertFile != null)
        {
            try
            {
                _custom = LoadCustom(tls.CertFile, tls.KeyFile);
                Log.Info("tls", $"using custom certificate {_custom.Subject} (expires {_custom.NotAfter:d})");
            }
            catch (Exception ex)
            {
                Log.Error("tls", "failed to load custom certificate; falling back to local CA", ex);
            }
        }
        _ca = LoadOrCreateCa();
        EnsureServerCert(force: false);
        if (tls.Mode is "auto" or "tailscale") TryRefreshTailscale();
        _refreshTimer = new Timer(_ =>
        {
            try
            {
                EnsureServerCert(force: false);
                if (ConfigStore.Current.Tls.Mode is "auto" or "tailscale") TryRefreshTailscale();
            }
            catch (Exception ex) { Log.Error("tls", "certificate refresh failed", ex); }
        }, null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));
    }

    /// <summary>Kestrel ServerCertificateSelector.</summary>
    public X509Certificate2 Select(string? sniName)
    {
        if (_custom != null) return _custom;
        if (_tailscale != null && sniName != null && _tailscaleName != null &&
            sniName.Equals(_tailscaleName, StringComparison.OrdinalIgnoreCase))
            return _tailscale;
        lock (_gate) return _server!;
    }

    public IReadOnlyCollection<string> ServerNames
    {
        get { lock (_gate) return _serverNames.ToArray(); }
    }

    // ------------------------------------------------------------------------------------------- local CA

    private static X509Certificate2 LoadOrCreateCa()
    {
        if (File.Exists(CaFile))
        {
            try
            {
                var cert = LoadProtected(CaFile);
                if (cert.NotAfter > DateTime.UtcNow.AddDays(30)) return cert;
                Log.Warn("tls", "local CA is about to expire; creating a new one (devices must re-install it)");
            }
            catch (Exception ex)
            {
                Log.Error("tls", "could not read local CA; creating a new one", ex);
            }
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var name = new X500DistinguishedName($"CN=Headroom Local CA ({Environment.MachineName}), O=Headroom");
        var req = new CertificateRequest(name, key, HashAlgorithmName.SHA256);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign | X509KeyUsageFlags.DigitalSignature, true));
        req.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(req.PublicKey, false));
        var notBefore = DateTimeOffset.UtcNow.AddDays(-1);
        using var ca = req.CreateSelfSigned(notBefore, notBefore.AddYears(10));
        var reloaded = SaveProtected(ca, CaFile);
        File.Delete(ServerFile); // force re-issue under the new CA
        File.WriteAllBytes(Path.Combine(Paths.CertDir, "headroom-ca.crt"), reloaded.Export(X509ContentType.Cert));
        Log.Info("tls", $"created local CA {reloaded.Thumbprint}");
        return reloaded;
    }

    private void EnsureServerCert(bool force)
    {
        var names = CollectNames();
        lock (_gate)
        {
            if (!force && _server == null && File.Exists(ServerFile))
            {
                try
                {
                    var existing = LoadProtected(ServerFile);
                    if (IsIssuedBy(existing, _ca!)) _server = existing;
                }
                catch (Exception ex) { Log.Warn("tls", $"could not read server cert: {ex.Message}"); }
                if (_server != null) _serverNames = ReadSans(_server);
            }

            bool needsNew = force || _server == null
                            || _server.NotAfter < DateTime.Now.AddDays(30)
                            || !names.IsSubsetOf(_serverNames);
            if (!needsNew) return;

            // Keep previously seen names too so a temporarily-down interface doesn't churn the cert.
            var all = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
            all.UnionWith(_serverNames);
            _server = IssueServerCert(_ca!, all);
            _serverNames = all;
            SaveProtected(_server, ServerFile);
            Log.Info("tls", $"issued server certificate for: {string.Join(", ", all)}");
        }
    }

    private static X509Certificate2 IssueServerCert(X509Certificate2 ca, IEnumerable<string> names)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest(new X500DistinguishedName($"CN={Environment.MachineName}, O=Headroom"), key, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        foreach (var n in names)
        {
            if (IPAddress.TryParse(n, out var ip)) san.AddIpAddress(ip);
            else san.AddDnsName(n);
        }
        req.CertificateExtensions.Add(san.Build(true));
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyAgreement, true));
        // id-kp-serverAuth is mandatory for Apple platforms.
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, false));
        req.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(req.PublicKey, false));
        req.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(ca, true, false));

        var notBefore = DateTimeOffset.UtcNow.AddDays(-1);
        // Apple: TLS server certs must be valid for at most 825 days (398 for public roots). Stay under both.
        var notAfter = notBefore.AddDays(397);
        if (notAfter > ca.NotAfter) notAfter = ca.NotAfter.AddDays(-1);
        var serial = RandomNumberGenerator.GetBytes(16);
        serial[0] &= 0x7F;
        using var issued = req.Create(ca, notBefore, notAfter, serial);
        using var withKey = issued.CopyWithPrivateKey(key);
        return Reload(withKey);
    }

    private static HashSet<string> CollectNames()
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "::1" };
        var host = Environment.MachineName.ToLowerInvariant();
        names.Add(host);
        names.Add(host + ".local");
        try
        {
            var fqdn = Dns.GetHostEntry("").HostName;
            if (!string.IsNullOrEmpty(fqdn) && fqdn.Contains('.')) names.Add(fqdn.ToLowerInvariant());
        }
        catch { }
        foreach (var ip in GetLocalAddresses()) names.Add(ip.ToString());
        foreach (var extra in ConfigStore.Current.Tls.ExtraNames) if (!string.IsNullOrWhiteSpace(extra)) names.Add(extra.Trim());
        return names;
    }

    public static IEnumerable<IPAddress> GetLocalAddresses()
    {
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            IPInterfaceProperties props;
            try { props = nic.GetIPProperties(); } catch { continue; }
            foreach (var ua in props.UnicastAddresses)
            {
                var a = ua.Address;
                if (a.AddressFamily == AddressFamily.InterNetwork) yield return a;
                else if (a.AddressFamily == AddressFamily.InterNetworkV6 && !a.IsIPv6LinkLocal && !a.IsIPv6Multicast)
                {
                    // Skip temporary/privacy addresses: they rotate and would churn the certificate.
                    if (ua.SuffixOrigin == SuffixOrigin.Random) continue;
                    yield return new IPAddress(a.GetAddressBytes()); // strip scope id
                }
            }
        }
    }

    private static HashSet<string> ReadSans(X509Certificate2 cert)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var ext in cert.Extensions)
        {
            if (ext is X509SubjectAlternativeNameExtension sanExt)
            {
                foreach (var d in sanExt.EnumerateDnsNames()) set.Add(d);
                foreach (var ip in sanExt.EnumerateIPAddresses()) set.Add(ip.ToString());
            }
        }
        return set;
    }

    private static bool IsIssuedBy(X509Certificate2 cert, X509Certificate2 ca)
    {
        if (cert.Issuer != ca.Subject) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        return chain.Build(cert);
    }

    // ------------------------------------------------------------------------------------------- tailscale

    public static string? FindTailscaleExe()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale", "tailscale.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Tailscale", "tailscale.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private void TryRefreshTailscale()
    {
        if (DateTime.UtcNow - _tailscaleCheckedAt < TimeSpan.FromHours(6) && _tailscale != null) return;
        _tailscaleCheckedAt = DateTime.UtcNow;
        var exe = FindTailscaleExe();
        if (exe == null) return;
        try
        {
            var status = Run(exe, "status --json", 10000);
            if (status == null) return;
            using var doc = JsonDocument.Parse(status);
            string? dnsName = null;
            if (doc.RootElement.TryGetProperty("Self", out var self) && self.TryGetProperty("DNSName", out var dn))
                dnsName = dn.GetString()?.TrimEnd('.');
            bool certsEnabled = doc.RootElement.TryGetProperty("CertDomains", out var cd) && cd.ValueKind == JsonValueKind.Array && cd.GetArrayLength() > 0;
            if (string.IsNullOrEmpty(dnsName) || !certsEnabled)
            {
                Log.Info("tls", "Tailscale found but HTTPS certificates are not enabled for this tailnet (admin console > DNS > HTTPS Certificates).");
                return;
            }
            var certFile = Path.Combine(Paths.CertDir, "tailscale.crt");
            var keyFile = Path.Combine(Paths.CertDir, "tailscale.key");
            var output = Run(exe, $"cert --cert-file \"{certFile}\" --key-file \"{keyFile}\" {dnsName}", 60000);
            if (!File.Exists(certFile) || !File.Exists(keyFile))
            {
                Log.Warn("tls", $"tailscale cert did not produce files: {output}");
                return;
            }
            using var pem = X509Certificate2.CreateFromPemFile(certFile, keyFile);
            _tailscale = Reload(pem);
            _tailscaleName = dnsName;
            Log.Info("tls", $"Tailscale certificate ready for https://{dnsName}:{ConfigStore.Current.Port}/ (expires {_tailscale.NotAfter:d})");
        }
        catch (Exception ex)
        {
            Log.Warn("tls", $"Tailscale certificate unavailable: {ex.Message}");
        }
    }

    private static string? Run(string exe, string args, int timeoutMs)
    {
        var psi = new ProcessStartInfo(exe, args)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
        };
        using var p = Process.Start(psi);
        if (p == null) return null;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } return null; }
        return p.ExitCode == 0 ? stdout.Result : stdout.Result + stderr.Result;
    }

    // ------------------------------------------------------------------------------------------- helpers

    private static X509Certificate2 LoadCustom(string certFile, string? keyFile)
    {
        if (certFile.EndsWith(".pfx", StringComparison.OrdinalIgnoreCase) || certFile.EndsWith(".p12", StringComparison.OrdinalIgnoreCase))
            return X509CertificateLoader.LoadPkcs12FromFile(certFile, null, X509KeyStorageFlags.Exportable);
        using var pem = X509Certificate2.CreateFromPemFile(certFile, keyFile);
        return Reload(pem);
    }

    /// <summary>SChannel can't use ephemeral keys; round-trip through PKCS#12 to get a usable key.</summary>
    private static X509Certificate2 Reload(X509Certificate2 cert) =>
        X509CertificateLoader.LoadPkcs12(cert.Export(X509ContentType.Pkcs12), null, X509KeyStorageFlags.Exportable);

    private static X509Certificate2 SaveProtected(X509Certificate2 cert, string path)
    {
        var pfx = cert.Export(X509ContentType.Pkcs12);
        var protectedBytes = ProtectedData.Protect(pfx, Encoding.UTF8.GetBytes("headroom-cert"), DataProtectionScope.LocalMachine);
        File.WriteAllBytes(path, protectedBytes);
        return X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.Exportable);
    }

    private static X509Certificate2 LoadProtected(string path)
    {
        var pfx = ProtectedData.Unprotect(File.ReadAllBytes(path), Encoding.UTF8.GetBytes("headroom-cert"), DataProtectionScope.LocalMachine);
        return X509CertificateLoader.LoadPkcs12(pfx, null, X509KeyStorageFlags.Exportable);
    }

    /// <summary>An Apple configuration profile that installs the local CA (Settings > General > VPN &amp; Device Management).</summary>
    public byte[] BuildMobileConfig()
    {
        var der = Convert.ToBase64String(CaCertificate.Export(X509ContentType.Cert));
        var host = Environment.MachineName;
        var payloadUuid = DeterministicGuid("payload:" + CaCertificate.Thumbprint).ToString().ToUpperInvariant();
        var profileUuid = DeterministicGuid("profile:" + CaCertificate.Thumbprint).ToString().ToUpperInvariant();
        var xml = $"""
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>headroom-ca.cer</string>
      <key>PayloadContent</key><data>{der}</data>
      <key>PayloadDescription</key><string>Lets this device trust the Headroom host {System.Security.SecurityElement.Escape(host)}.</string>
      <key>PayloadDisplayName</key><string>Headroom Local CA ({System.Security.SecurityElement.Escape(host)})</string>
      <key>PayloadIdentifier</key><string>app.headroom.ca.{payloadUuid}</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>{payloadUuid}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Installs the certificate authority used by Headroom on {System.Security.SecurityElement.Escape(host)}. After installing, enable it in Settings &gt; General &gt; About &gt; Certificate Trust Settings.</string>
  <key>PayloadDisplayName</key><string>Headroom – {System.Security.SecurityElement.Escape(host)}</string>
  <key>PayloadIdentifier</key><string>app.headroom.profile.{profileUuid}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>{profileUuid}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
""";
        return Encoding.UTF8.GetBytes(xml);
    }

    private static Guid DeterministicGuid(string seed)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        var bytes = hash[..16];
        bytes[7] = (byte)((bytes[7] & 0x0F) | 0x40);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        return new Guid(bytes);
    }
}
