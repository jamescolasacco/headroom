using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Headroom.Server;

/// <summary>
/// The "Headroom Server" window: the settings panel (served by the engine at /admin.html) in WebView2,
/// inside a native window. Closing it only hides it — the tray icon keeps running.
/// </summary>
public sealed class SettingsWindow : Form
{
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(11, 13, 17) };
    private readonly Func<Task<bool>> _startServer;
    private bool _ready;
    private bool _onAdminPage;
    private string _pendingSection = "status";
    private bool _reallyClose;

    /// <summary>Close for good (app exit) instead of hiding.</summary>
    public void CloseForExit()
    {
        _reallyClose = true;
        Close();
    }

    public SettingsWindow(Icon icon, Func<Task<bool>> startServer)
    {
        _startServer = startServer;
        Text = "Headroom Server";
        Icon = icon;
        ClientSize = new Size(960, 680);
        MinimumSize = new Size(560, 420);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(11, 13, 17);
        Controls.Add(_web);
        _ = InitAsync();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (SystemUsesDarkTheme())
        {
            int on = 1;
            DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
        }
    }

    private async Task InitAsync()
    {
        try
        {
            var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Headroom", "ServerUI");
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await _web.EnsureCoreWebView2Async(env);
            var s = _web.CoreWebView2.Settings;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.AreDevToolsEnabled = Debugger.IsAttached || Environment.GetEnvironmentVariable("HEADROOM_DEVTOOLS") == "1";
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            _web.CoreWebView2.WebMessageReceived += OnWebMessage;
            _web.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                // Links that would open a new window (help, downloads) go to the default browser.
                e.Handled = true;
                OpenExternal(e.Uri);
            };
            _web.CoreWebView2.NavigationCompleted += (_, e) =>
            {
                _onAdminPage = e.IsSuccess && _web.Source?.AbsolutePath.EndsWith("/admin.html", StringComparison.OrdinalIgnoreCase) == true;
                if (!e.IsSuccess && !(_web.Source?.ToString() ?? "about:").StartsWith("about:", StringComparison.Ordinal)) ShowOffline();
            };
            _ready = true;
            Navigate(_pendingSection, reload: true);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Controls.Remove(_web);
            Controls.Add(new Label
            {
                Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White,
                Text = "The Microsoft Edge WebView2 Runtime is required.\nInstall it from https://developer.microsoft.com/microsoft-edge/webview2/",
            });
        }
    }

    /// <summary>Show a settings section ("status", "pair", "devices", ...).</summary>
    public void Navigate(string section, bool reload = false)
    {
        _pendingSection = section;
        if (!_ready) return;
        if (_onAdminPage && !reload)
        {
            _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { cmd = "navigate", section }));
            return;
        }
        _web.CoreWebView2.Navigate($"{AdminClient.BaseUrl}/admin.html#{section}");
    }

    public void ShowOffline()
    {
        if (!_ready) return;
        _onAdminPage = false;
        _web.CoreWebView2.NavigateToString(OfflineHtml);
    }

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            switch (root.GetProperty("cmd").GetString())
            {
                case "openFolder":
                    var path = root.GetProperty("path").GetString();
                    if (path != null && Directory.Exists(path)) Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
                    else MessageBox.Show(this, "That folder isn't accessible from your account (in service mode it's limited to administrators).", "Headroom Server");
                    break;
                case "copy":
                    var text = root.GetProperty("text").GetString();
                    if (text != null) Clipboard.SetText(text);
                    break;
                case "startServer":
                    if (await _startServer()) Navigate(_pendingSection, reload: true);
                    break;
            }
        }
        catch { }
    }

    private static void OpenExternal(string uri)
    {
        if (Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https"))
            Process.Start(new ProcessStartInfo(u.ToString()) { UseShellExecute = true });
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_reallyClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    private static bool SystemUsesDarkTheme()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);

    private const string OfflineHtml = """
<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
<style>
:root{--bg:#0b0d11;--fg:#e8ebf0;--muted:#8d97a5;--card:#13161c;--line:#262b35;--accent:#5b9dff;--bad:#ef5b5b}
@media (prefers-color-scheme: light){:root{--bg:#f5f6f8;--fg:#141820;--muted:#5d6875;--card:#fff;--line:#dfe3e8;--accent:#1f6feb}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 32px;max-width:440px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 18px}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 18px;font:600 15px "Segoe UI",system-ui;cursor:pointer}
</style></head><body><div class="card">
<h1>The Headroom server isn't running</h1>
<p>Other devices can't connect until it's started.</p>
<button onclick="chrome.webview.postMessage({cmd:'startServer'})">Start server</button>
</div></body></html>
""";
}
