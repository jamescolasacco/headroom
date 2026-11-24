using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace Headroom.Update;

/// <summary>
/// Headroom's updater for the Windows apps (Headroom Server's tray app and Headroom Viewer; the same file is in
/// both): it checks the latest GitHub release now and then, downloads it in the background, checks it, and then
/// offers "Restart to update". It never restarts by itself: a remote-access app that restarts while you're away
/// could leave you outside. The Mac apps have the same rules (update-macos/).
///
/// What it trusts (every file comes from https://github.com/&lt;repo&gt;/releases/latest/download/):
///  - SHA256SUMS.txt lists the release's files and their SHA-256; when this app was built with Headroom's signing
///    certificate (update-signing.cer next to it), SHA256SUMS.txt.sig must be that certificate's signature over
///    it, or nothing is installed;
///  - update.json (listed in SHA256SUMS.txt) says which version it is; only a newer one is installed;
///  - the download is that version's installer (Headroom-Server-Setup.exe / Headroom-Viewer-Setup.exe, the same
///    one people download), which installs it silently: Apps &amp; Features shows the new version too.
/// </summary>
public sealed class Updater : IDisposable
{
    public enum App { Server, Viewer }

    public sealed record State(string Phase, string Current, string? Version, double Progress, string? Message, DateTime? CheckedAt)
    {
        /// <summary>For the web pages (the Server window, the Viewer's home screen).</summary>
        public object Json => new
        {
            cmd = "update", phase = Phase, current = Current, version = Version, progress = Progress, message = Message,
            checkedAt = CheckedAt?.ToUniversalTime().ToString("o"),
        };
    }

    private const string DefaultRepo = "jamescolasacco/headroom";
    private readonly App _app;
    private readonly Uri _base;
    private readonly byte[]? _certificate;
    private readonly string _cacheDir;
    private readonly HttpClient _http;
    private System.Threading.Timer? _timer;
    private int _busy;
    private readonly object _lock = new();
    /// <summary>The verified installer (its file name in the version's folder, and its SHA-256).</summary>
    private string? _setupName, _setupSha;

    public string Current { get; }
    public State Now { get; private set; }
    /// <summary>Raised on a background thread: marshal to the UI thread before touching controls.</summary>
    public event Action<State>? Changed;

    public Updater(App app)
    {
        _app = app;
        Current = CurrentVersion();
        Now = new State("idle", Current, null, 0, null, null);
        var repo = Assembly.GetEntryAssembly()?.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "HeadroomUpdateRepo")?.Value;
        _base = new Uri($"https://github.com/{(string.IsNullOrWhiteSpace(repo) ? DefaultRepo : repo)}/releases/latest/download/");
#if DEBUG
        if (Environment.GetEnvironmentVariable("HEADROOM_UPDATE_BASE") is { Length: > 0 } b && Uri.TryCreate(b, UriKind.Absolute, out var u)) _base = u; // tests
#endif
        var cert = Path.Combine(AppContext.BaseDirectory, "update-signing.cer");
        _certificate = File.Exists(cert) ? File.ReadAllBytes(cert) : null;
        _cacheDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Headroom", "Updates", app.ToString());
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"Headroom-Updater/{Current}");
    }

    /// <summary>Installed where the installers put it (so its installer can replace it there).</summary>
    public bool CanInstallHere
    {
        get
        {
            var here = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd('\\');
            var standard = _app == App.Server
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Headroom")
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Headroom Viewer");
            return string.Equals(here, Path.GetFullPath(standard).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>The release's page (…/releases/latest), for installing by hand.</summary>
    public string ReleasesPage => new Uri(_base, "..").ToString().TrimEnd('/');

    /// <summary>Checks a little after launch, then every 6 hours. Old downloads are tidied away first.</summary>
    public void Start(TimeSpan? first = null, TimeSpan? every = null)
    {
        CleanUp();
        _timer?.Dispose();
        _timer = new System.Threading.Timer(_ => Check(), null, first ?? TimeSpan.FromSeconds(20), every ?? TimeSpan.FromHours(6));
    }

    /// <summary>Looks for a newer release and, when there is one, downloads and checks it (nothing is installed yet).</summary>
    public void Check(bool userInitiated = false)
    {
        lock (_lock)
        {
            if (_busy == 1 || Now.Phase == "ready") { if (userInitiated) Raise(); return; }
            _busy = 1;
        }
        Set(Now with { Phase = "checking", Message = null });
        _ = Task.Run(async () =>
        {
            try { await RunAsync(); }
            catch (Exception e) { Set(Now with { Phase = "failed", Message = Describe(e), CheckedAt = DateTime.Now }); }
            finally { lock (_lock) _busy = 0; }
        });
    }

    /// <summary>
    /// Starts the downloaded update's own installer, which stops this app, replaces it and opens it again; Headroom
    /// Server's needs administrator rights (one Windows prompt). False when the person said no there, or it failed
    /// (with <paramref name="error"/>). The caller exits right after a true.
    /// </summary>
    public bool Install(out string? error)
    {
        error = null;
        if (Now.Phase != "ready" || Now.Version is not { } version) { error = "There's no downloaded update to install."; return false; }
        var setup = Path.Combine(_cacheDir, version, _setupName ?? "");
        try
        {
            if (_setupName == null || _setupSha == null || !File.Exists(setup) || Sha256File(setup) != _setupSha || !Validate(setup, version))
                throw new UpdateException("The downloaded update is incomplete.");
        }
        catch (Exception e)
        {
            error = Describe(e);
            Set(Now with { Phase = "failed", Message = error, CheckedAt = DateTime.Now });
            return false;
        }
        const string silent = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS";
        ProcessStartInfo psi;
        if (_app == App.Viewer)
        {
            // Same user, same rights: the installer straight from the download (it opens the new Viewer at the end).
            psi = new ProcessStartInfo(setup, silent);
        }
        else
        {
            // As administrator (it replaces Program Files and restarts the service). The download sits in this
            // user's folder, so the elevated side doesn't run it from there: it copies it into a folder only
            // administrators can change, checks its SHA-256 again (from the signed checksums) and runs that copy.
            var ps = string.Join("\n",
                "$ErrorActionPreference = 'Stop'",
                $"$src = '{setup.Replace("'", "''")}'",
                $"$sha = '{_setupSha}'",
                "$dir = Join-Path $env:windir ('Temp\\HeadroomUpdate-' + [guid]::NewGuid())",
                "New-Item -ItemType Directory -Path $dir | Out-Null",
                "try {",
                "  $exe = Join-Path $dir 'Headroom-Server-Setup.exe'",
                "  Copy-Item -LiteralPath $src -Destination $exe",
                "  if ((Get-FileHash -Algorithm SHA256 $exe).Hash -ne $sha) { throw 'The update changed after it was checked.' }",
                // WaitForExit, not -Wait: -Wait also waits for what the installer opens (the tray app) to exit.
                $"  (Start-Process -FilePath $exe -ArgumentList '{silent}' -PassThru).WaitForExit()",
                "} finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }");
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(ps));
            psi = new ProcessStartInfo("powershell.exe", $"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {encoded}") { Verb = "runas" };
        }
        psi.UseShellExecute = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        try
        {
            Process.Start(psi);
            return true;
        }
        catch (Win32Exception e) when (e.NativeErrorCode == 1223) { return false; } // "No" at the Windows prompt
        catch (Exception e) { error = e.Message; return false; }
    }

    // ------------------------------------------------------------------ the check

    private async Task RunAsync()
    {
        var sums = await FetchAsync("SHA256SUMS.txt");
        if (_certificate != null)
        {
            byte[] sig;
            try { sig = await FetchAsync("SHA256SUMS.txt.sig"); }
            catch (HttpRequestException e) when (e.StatusCode == System.Net.HttpStatusCode.NotFound) { throw new UpdateException("The latest release isn't signed, so it wasn't installed."); }
            if (!Verify(sums, sig, _certificate)) throw new UpdateException("The latest release's signature doesn't match Headroom's certificate, so it wasn't installed.");
        }
        var hashes = ParseSums(Encoding.UTF8.GetString(sums));
        var manifestBytes = await FetchAsync("update.json");
        if (!hashes.TryGetValue("update.json", out var mh) || mh != Sha256(manifestBytes)) throw new UpdateException("update.json didn't match its checksum, so it wasn't installed.");
        using var manifest = JsonDocument.Parse(manifestBytes);
        var version = manifest.RootElement.TryGetProperty("version", out var v) ? v.GetString() : null;
        if (string.IsNullOrEmpty(version)) throw new UpdateException("The latest release doesn't say its version.");
        if (!IsNewer(version, Current))
        {
            Set(Now with { Phase = "current", Version = null, CheckedAt = DateTime.Now });
            return;
        }
        var assetKey = _app == App.Server ? "windowsServer" : "windowsViewer";
        var asset = manifest.RootElement.TryGetProperty(assetKey, out var a) && a.GetString() is { Length: > 0 } n ? n
            : _app == App.Server ? "Headroom-Server-Setup.exe" : "Headroom-Viewer-Setup.exe";
        if (!hashes.TryGetValue(asset, out var expected)) throw new UpdateException($"{asset} isn't in the release's checksums.");

        var dir = Path.Combine(_cacheDir, version);
        var setup = Path.Combine(dir, asset);
        if (File.Exists(setup) && Sha256File(setup) == expected && Validate(setup, version))
        {
            (_setupName, _setupSha) = (asset, expected);
            Set(Now with { Phase = "ready", Version = version, Progress = 1, CheckedAt = DateTime.Now });
            return;
        }
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        Directory.CreateDirectory(dir);
        Set(Now with { Phase = "downloading", Version = version, Progress = 0 });
        await DownloadAsync(asset, setup);
        if (Sha256File(setup) != expected) throw new UpdateException($"{asset} didn't match its checksum, so it wasn't installed.");
        if (!Validate(setup, version)) throw new UpdateException("The download isn't a Headroom installer for that version.");
        (_setupName, _setupSha) = (asset, expected);
        Set(Now with { Phase = "ready", Progress = 1, CheckedAt = DateTime.Now });
    }

    /// <summary>The installer says it's that version (its file version, set from the release's version).</summary>
    private static bool Validate(string setup, string version)
    {
        var v = FileVersionInfo.GetVersionInfo(setup);
        var text = !string.IsNullOrEmpty(v.ProductVersion) ? v.ProductVersion! : v.FileVersion ?? "";
        var found = Strip(text);
        return found.Length > 0 && !IsNewer(found, version) && !IsNewer(version, found); // 1.2.3 is 1.2.3.0
    }

    private async Task<byte[]> FetchAsync(string name)
    {
        using var r = await _http.GetAsync(new Uri(_base, name), HttpCompletionOption.ResponseContentRead);
        r.EnsureSuccessStatusCode();
        return await r.Content.ReadAsByteArrayAsync();
    }

    private async Task DownloadAsync(string name, string path)
    {
        using var r = await _http.GetAsync(new Uri(_base, name), HttpCompletionOption.ResponseHeadersRead);
        r.EnsureSuccessStatusCode();
        var total = r.Content.Headers.ContentLength ?? 0;
        await using var src = await r.Content.ReadAsStreamAsync();
        await using var dst = File.Create(path);
        var buf = new byte[1 << 16];
        long done = 0;
        double last = 0;
        int n;
        while ((n = await src.ReadAsync(buf)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, n));
            done += n;
            if (total > 0)
            {
                var p = (double)done / total;
                if (p - last >= 0.02) { last = p; Set(Now with { Progress = p }); }
            }
        }
    }

    /// <summary>Downloads of versions that are installed now (or older) are no longer needed.</summary>
    private void CleanUp()
    {
        try
        {
            if (!Directory.Exists(_cacheDir)) return;
            foreach (var d in Directory.GetDirectories(_cacheDir))
                if (!IsNewer(Path.GetFileName(d), Current)) Directory.Delete(d, recursive: true);
        }
        catch { }
    }

    private void Set(State s)
    {
        lock (_lock) Now = s;
        Raise();
    }

    private void Raise()
    {
        var s = Now;
        try { Changed?.Invoke(s); } catch { }
    }

    // ------------------------------------------------------------------ checks

    /// <summary>RSA PKCS#1 v1.5 with SHA-256: the signature `openssl dgst -sha256 -sign` makes.</summary>
    public static bool Verify(byte[] data, byte[] signature, byte[] certificateDer)
    {
        try
        {
            using var cert = X509CertificateLoader.LoadCertificate(certificateDer);
            using var rsa = cert.GetRSAPublicKey();
            return rsa != null && rsa.VerifyData(data, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        }
        catch { return false; }
    }

    /// <summary>`sha256sum` output: "&lt;64 hex&gt;  &lt;name&gt;" (a "*" before the name in binary mode).</summary>
    public static Dictionary<string, string> ParseSums(string text)
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            var sp = line.IndexOf(' ');
            if (sp != 64) continue;
            var name = line[(sp + 1)..].Trim().TrimStart('*');
            if (name.Length > 0) d[name] = line[..64].ToLowerInvariant();
        }
        return d;
    }

    public static bool IsNewer(string a, string b)
    {
        static int[] Parse(string v) => v.Split('.').Select(p => int.TryParse(new string(p.TakeWhile(char.IsDigit).ToArray()), out var n) ? n : 0).ToArray();
        var pa = Parse(a);
        var pb = Parse(b);
        for (int i = 0; i < Math.Max(pa.Length, pb.Length); i++)
        {
            int x = i < pa.Length ? pa[i] : 0, y = i < pb.Length ? pb[i] : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static string Sha256(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    private static string Sha256File(string path)
    {
        using var f = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant();
    }

    private static string Strip(string v) => v.Split('+', '-')[0].Trim();

    private static string CurrentVersion()
    {
        var a = Assembly.GetEntryAssembly();
        var v = a?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? a?.GetName().Version?.ToString(3) ?? "0";
        return Strip(v);
    }

    private static string Describe(Exception e) => e switch
    {
        UpdateException u => u.Message,
        HttpRequestException { StatusCode: { } c } => $"GitHub answered {(int)c} when checking for updates.",
        HttpRequestException or TaskCanceledException => "Couldn't reach GitHub to check for updates.",
        _ => $"Couldn't check for updates ({e.Message}).",
    };

    public void Dispose()
    {
        _timer?.Dispose();
        _http.Dispose();
    }
}

public sealed class UpdateException(string message) : Exception(message);
