using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Headroom.Viewer;

/// <summary>
/// A Headroom Viewer window: the web client (bundled, served from a virtual HTTPS origin so WebCodecs has a
/// secure context) in WebView2, plus the native pieces a browser can't do — certificate trust, full-screen
/// window handling, clipboard access without prompts, and (see KeyboardHook) system-shortcut capture.
/// </summary>
public sealed class ViewerWindow : Form
{
    private WebView2? _web;
    private string _startUrl;
    private bool _fullscreen;
    private FormBorderStyle _savedBorder;
    private FormWindowState _savedState;
    private Rectangle _savedBounds;
    public bool SessionActive { get; private set; }
    public string? SessionHost { get; private set; }
    public CoreWebView2? Core => _web?.CoreWebView2;
    public event Action<ViewerWindow>? SessionChanged;

    public ViewerWindow(string startUrl)
    {
        _startUrl = startUrl;
        Text = "Headroom Viewer";
        Icon = Program.AppIcon;
        ClientSize = new Size(1280, 800);
        MinimumSize = new Size(480, 360);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(11, 13, 17);
        KeyPreview = false;
        _ = AttachWebViewAsync();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int on = 1;
        // The viewer is dark by design (it frames a remote desktop); match the title bar.
        DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
    }

    public async Task AttachWebViewAsync()
    {
        var web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(11, 13, 17) };
        Controls.Add(web);
        _web = web;
        try
        {
            var env = await ViewerEnvironment.GetAsync();
            await web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Controls.Remove(web);
            Controls.Add(new Label
            {
                Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White,
                Text = "Headroom Viewer needs the Microsoft Edge WebView2 Runtime.\nInstall it from https://developer.microsoft.com/microsoft-edge/webview2/",
            });
            return;
        }
        var core = web.CoreWebView2;
        core.SetVirtualHostNameToFolderMapping(ViewerEnvironment.VirtualHost, ViewerEnvironment.ClientFolder, CoreWebView2HostResourceAccessKind.Allow);
        var s = core.Settings;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;          // Ctrl+wheel / Ctrl+= belong to the remote
        s.AreBrowserAcceleratorKeysEnabled = false; // F5, Ctrl+R, Ctrl+P, Ctrl+F... go to the remote
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.AreDefaultContextMenusEnabled = Debugger.IsAttached;
        s.AreDevToolsEnabled = Debugger.IsAttached || Environment.GetEnvironmentVariable("HEADROOM_DEVTOOLS") == "1";
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;

        core.PermissionRequested += (_, e) =>
        {
            // Our own bundled client only: clipboard sync without prompts, local-network connections, downloads.
            if (!e.Uri.StartsWith($"https://{ViewerEnvironment.VirtualHost}/", StringComparison.OrdinalIgnoreCase)) return;
            var kind = e.PermissionKind.ToString();
            if (kind is "ClipboardRead" or "MultipleAutomaticDownloads" or "LocalNetworkAccess" or "LocalNetwork" or "Autoplay")
                e.State = CoreWebView2PermissionState.Allow;
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (e.Uri.StartsWith($"https://{ViewerEnvironment.VirtualHost}/", StringComparison.OrdinalIgnoreCase))
                Program.OpenWindow(e.Uri);
            else if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && u.Scheme is "http" or "https")
                Process.Start(new ProcessStartInfo(u.ToString()) { UseShellExecute = true });
        };
        core.ContainsFullScreenElementChanged += (_, _) => SetFullscreen(core.ContainsFullScreenElement);
        core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Headroom Viewer" : core.DocumentTitle.Replace("— Headroom", "— Headroom Viewer");
        core.WebMessageReceived += OnWebMessage;
        core.Navigate(_startUrl);
    }

    /// <summary>Drop the WebView (before an environment restart) and remember where we were.</summary>
    public void DetachWebView()
    {
        if (_web == null) return;
        _startUrl = _web.Source?.ToString() ?? _startUrl;
        Controls.Remove(_web);
        _web.Dispose();
        _web = null;
        SessionActive = false;
    }

    public void Navigate(string url)
    {
        _startUrl = url;
        Core?.Navigate(url);
    }

    public void PostJson(object message)
    {
        try { Core?.PostWebMessageAsJson(JsonSerializer.Serialize(message)); } catch { }
    }

    // ------------------------------------------------------------------ page -> native

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonElement root;
        try { root = JsonDocument.Parse(e.WebMessageAsJson).RootElement; } catch { return; }
        var cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() : null;
        switch (cmd)
        {
            case "trustHost":
                await TrustHostAsync(root.GetProperty("url").GetString() ?? "");
                break;
            case "session":
                SessionActive = root.TryGetProperty("active", out var a) && a.GetBoolean();
                SessionHost = root.TryGetProperty("host", out var hn) ? hn.GetString() : null;
                SessionChanged?.Invoke(this);
                break;
            case "newWindow":
                Program.OpenWindow(root.GetProperty("url").GetString() ?? ViewerEnvironment.StartUrl);
                break;
            case "setClipboard":
                var text = root.GetProperty("text").GetString();
                if (text != null) try { Clipboard.SetText(text); } catch { }
                break;
        }
    }

    private async Task TrustHostAsync(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https")
        {
            PostJson(new { cmd = "trustResult", url, ok = false, reason = "Not an HTTPS address." });
            return;
        }
        UseWaitCursor = true;
        var probe = await TrustStore.ProbeAsync(uri);
        UseWaitCursor = false;
        if (probe.PubliclyTrusted)
        {
            PostJson(new { cmd = "trustResult", url, ok = true, reason = "already-trusted" });
            return;
        }
        if (probe.Leaf == null)
        {
            PostJson(new { cmd = "trustResult", url, ok = false, reason = probe.Error ?? "Couldn't read the computer's certificate." });
            return;
        }
        var leaf = probe.Leaf;
        var name = leaf.GetNameInfo(System.Security.Cryptography.X509Certificates.X509NameType.SimpleName, false);
        var answer = MessageBox.Show(this,
            $"First connection to {uri.Host}.\n\nIt identifies itself as {name}{(probe.IssuedByHostCa ? " (Headroom certificate verified)" : "")}.\n\n" +
            $"Server key fingerprint:\n    {TrustStore.KeyFingerprint(leaf)}\n\n" +
            "If this is your computer, Headroom Server → Connection shows the same fingerprint. Trust it?",
            "Trust this computer?", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes)
        {
            PostJson(new { cmd = "trustResult", url, ok = false, reason = "declined" });
            return;
        }
        TrustStore.Add(new TrustStore.Pin(uri.Host, TrustStore.SpkiHash(leaf), TrustStore.KeyFingerprint(leaf), leaf.Subject, DateTimeOffset.UtcNow));
        // The new pin only takes effect in a fresh browser process; reopen the add-computer flow afterwards.
        _startUrl = $"{ViewerEnvironment.StartUrl}#add={Uri.EscapeDataString(uri.GetLeftPart(UriPartial.Authority))}";
        await Program.RestartBrowserAsync(this, _startUrl);
    }

    // ------------------------------------------------------------------ full screen

    public void SetFullscreen(bool on)
    {
        if (on == _fullscreen) return;
        _fullscreen = on;
        if (on)
        {
            _savedBorder = FormBorderStyle;
            _savedState = WindowState;
            _savedBounds = Bounds;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            FormBorderStyle = _savedBorder;
            Bounds = _savedBounds;
            WindowState = _savedState;
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);
}
