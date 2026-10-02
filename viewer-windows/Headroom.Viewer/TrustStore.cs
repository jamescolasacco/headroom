using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace Headroom.Viewer;

/// <summary>
/// Certificates the viewer trusts *for itself only* (never added to Windows' trust store).
/// Each Headroom computer has its own self-signed local CA. After the user confirms the fingerprint once
/// (trust on first use) we pin the computer's server key: WebView2 is started with
/// --ignore-certificate-errors-spki-list so HTTPS, fetch and WebSockets to it work. The server keeps that
/// key across certificate renewals, so the pin lasts. (Pinning the CA itself doesn't work: Windows' TLS
/// stack never sends a self-signed root, and Chromium only matches keys the server presents.)
/// </summary>
public static class TrustStore
{
    public sealed record Pin(string Host, string Spki, string Fingerprint, string Subject, DateTimeOffset Added);

    private static readonly string FilePath = Path.Combine(Program.DataDir, "trusted-hosts.json");
    private static List<Pin>? _pins;

    public static IReadOnlyList<Pin> Pins => _pins ??= Load();

    private static List<Pin> Load()
    {
        try { return JsonSerializer.Deserialize<List<Pin>>(File.ReadAllText(FilePath)) ?? new(); }
        catch { return new(); }
    }

    public static void Add(Pin pin)
    {
        var list = Pins.Where(p => !(p.Host == pin.Host && p.Spki == pin.Spki)).ToList();
        list.Add(pin);
        _pins = list;
        Directory.CreateDirectory(Program.DataDir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(list, new JsonSerializerOptions { WriteIndented = true }));
    }

    /// <summary>Chromium switch value: comma-separated base64 SHA-256 SPKI hashes.</summary>
    public static string SpkiList => string.Join(",", Pins.Select(p => p.Spki).Distinct());

    public static string SpkiHash(X509Certificate2 cert) =>
        Convert.ToBase64String(SHA256.HashData(cert.PublicKey.ExportSubjectPublicKeyInfo()));

    /// <summary>First 128 bits of SHA-256(SPKI) in hex — the "server key fingerprint" Headroom Server shows.</summary>
    public static string KeyFingerprint(X509Certificate2 cert)
    {
        var hex = Convert.ToHexString(SHA256.HashData(cert.PublicKey.ExportSubjectPublicKeyInfo()))[..32];
        return string.Join(" ", Enumerable.Range(0, 8).Select(i => hex.Substring(i * 4, 4)));
    }

    /// <param name="Leaf">The server certificate to pin.</param>
    /// <param name="IssuedByHostCa">True if the host's own CA (from its setup port) verifiably issued it.</param>
    public sealed record ProbeResult(bool PubliclyTrusted, X509Certificate2? Leaf, bool IssuedByHostCa, string? Error);

    /// <summary>
    /// Connects to https://host:port and returns its certificate. If it isn't publicly trusted, also checks
    /// it against the host's local CA (downloaded from the plain-HTTP setup port) as a consistency check.
    /// </summary>
    public static async Task<ProbeResult> ProbeAsync(Uri url, int helperPort = 7080)
    {
        X509Certificate2? leaf = null;
        bool trusted = false;
        try
        {
            using var tcp = new TcpClient();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            await tcp.ConnectAsync(url.Host, url.Port, cts.Token);
            using var ssl = new SslStream(tcp.GetStream(), false, (_, cert, _, errors) =>
            {
                if (cert != null) leaf = new X509Certificate2(cert);
                trusted = errors == SslPolicyErrors.None;
                return true; // inspection only — nothing is sent over this connection
            });
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = url.Host }, cts.Token);
        }
        catch (Exception ex)
        {
            return new ProbeResult(false, null, false, $"Couldn't reach {url.Host}:{url.Port} ({ex.Message}).");
        }
        if (leaf == null) return new ProbeResult(false, null, false, "The computer didn't present a certificate.");
        if (trusted) return new ProbeResult(true, leaf, false, null);

        bool issuedByHostCa = false;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
            var der = await http.GetByteArrayAsync($"http://{FormatHost(url.Host)}:{helperPort}/headroom-ca.crt");
            var ca = X509CertificateLoader.LoadCertificate(der);
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(ca);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            issuedByHostCa = chain.Build(leaf);
        }
        catch { /* setup port unreachable: the user's fingerprint check is what matters */ }
        return new ProbeResult(false, leaf, issuedByHostCa, null);
    }

    private static string FormatHost(string host) => host.Contains(':') && !host.StartsWith('[') ? $"[{host}]" : host;
}
