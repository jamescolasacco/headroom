using Microsoft.Web.WebView2.Core;

namespace Headroom.Viewer;

/// <summary>
/// One WebView2 environment (browser process) shared by all viewer windows. Its command-line switches —
/// including the pinned-certificate list — are fixed for the life of the browser process, so trusting a new
/// computer means restarting it: every window drops its WebView, the browser process exits, and the windows
/// re-attach to a fresh environment.
/// </summary>
public static class ViewerEnvironment
{
    public const string VirtualHost = "app.headroom.local";
    public static string ClientFolder => Path.Combine(AppContext.BaseDirectory, "client");
    public static string StartUrl => $"https://{VirtualHost}/index.html";

    private static Task<CoreWebView2Environment>? _env;

    public static Task<CoreWebView2Environment> GetAsync() => _env ??= CreateAsync();

    private static async Task<CoreWebView2Environment> CreateAsync()
    {
        var args = new List<string>
        {
            // Keep decoding/rendering smooth when the window is partly covered.
            "--disable-features=CalculateNativeWinOcclusion",
            "--autoplay-policy=no-user-gesture-required",
        };
        var spki = TrustStore.SpkiList;
        if (spki.Length > 0) args.Add($"--ignore-certificate-errors-spki-list={spki}");
        // Development: expose Chrome DevTools Protocol for automated testing.
        if (int.TryParse(Environment.GetEnvironmentVariable("HEADROOM_CDP_PORT"), out var cdp)) args.Add($"--remote-debugging-port={cdp}");
        var options = new CoreWebView2EnvironmentOptions(string.Join(' ', args));
        return await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"), options);
    }

    /// <summary>Restarts the browser process (call after the windows have released their WebViews).</summary>
    public static async Task RestartAsync()
    {
        if (_env != null)
        {
            var env = await _env;
            var exited = new TaskCompletionSource();
            env.BrowserProcessExited += (_, _) => exited.TrySetResult();
            await Task.WhenAny(exited.Task, Task.Delay(5000));
        }
        _env = CreateAsync();
        await _env;
    }
}
