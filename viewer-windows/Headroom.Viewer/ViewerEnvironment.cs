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

    /// <summary>The pinned keys the running browser process was started with.</summary>
    public static string ActiveSpkiList { get; private set; } = "";

    public static Task<CoreWebView2Environment> GetAsync()
    {
        if (_env == null || _env.IsFaulted || _env.IsCanceled) _env = CreateAsync();
        return _env;
    }

    private static async Task<CoreWebView2Environment> CreateAsync()
    {
        var args = new List<string>
        {
            // Keep decoding/rendering smooth when the window is partly covered.
            "--disable-features=CalculateNativeWinOcclusion",
            "--autoplay-policy=no-user-gesture-required",
        };
        var spki = TrustStore.SpkiList;
        ActiveSpkiList = spki;
        if (spki.Length > 0) args.Add($"--ignore-certificate-errors-spki-list={spki}");
        // Development: expose Chrome DevTools Protocol for automated testing.
        if (int.TryParse(Environment.GetEnvironmentVariable("HEADROOM_CDP_PORT"), out var cdp)) args.Add($"--remote-debugging-port={cdp}");
        var options = new CoreWebView2EnvironmentOptions(string.Join(' ', args));
        return await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"), options);
    }

    /// <summary>Observe process exit before closing the final WebView so an early exit is remembered.</summary>
    public static async Task RestartAsync(Action detachWindows)
    {
        var previous = _env;
        _env = null;
        if (previous is not { IsCompletedSuccessfully: true })
        {
            detachWindows();
            return;
        }
        var env = await previous;
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnExited(object? sender, CoreWebView2BrowserProcessExitedEventArgs args) => exited.TrySetResult();
        env.BrowserProcessExited += OnExited;
        try
        {
            detachWindows();
            await Task.WhenAny(exited.Task, Task.Delay(5000));
        }
        finally
        {
            env.BrowserProcessExited -= OnExited;
        }
    }
}
