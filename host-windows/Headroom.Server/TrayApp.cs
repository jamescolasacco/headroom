using System.Reflection;
using Microsoft.Win32;

namespace Headroom.Server;

/// <summary>
/// Notification-area icon for the Headroom host, like VNC Server's: shows whether anyone is connected,
/// pops a notification when a viewer connects/disconnects, and gives quick actions.
/// </summary>
public sealed class TrayApp : ApplicationContext
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "Headroom Server";

    private readonly NotifyIcon _tray;
    private readonly Icon _idleIcon, _activeIcon;
    private readonly AdminClient _admin = new();
    private readonly EngineManager _engine = new();
    private readonly System.Windows.Forms.Timer _poll = new() { Interval = 2000 };
    private readonly SynchronizationContext _ui;
    private SettingsWindow? _window;
    private ServerStatus? _status;
    private HashSet<string> _knownViewers = new();
    private bool _firstPoll = true;
    private bool _startingEngine;
    private bool _userStopped;
    private int _offlinePolls;

    public TrayApp(bool showWindow)
    {
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        _idleIcon = LoadIcon("headroom.ico");
        _activeIcon = LoadIcon("headroom-active.ico");
        _tray = new NotifyIcon
        {
            Icon = _idleIcon,
            Text = "Headroom Server",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip(),
        };
        _tray.ContextMenuStrip.Opening += (_, _) => BuildMenu();
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowWindow("status"); };
        _tray.BalloonTipClicked += (_, _) => ShowWindow("status");
        _poll.Tick += async (_, _) => await PollAsync();
        _poll.Start();
        _ = PollAsync();
        if (showWindow) ShowWindow("status");
    }

    private static Icon LoadIcon(string name)
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)!;
        return new Icon(s, SystemInformation.SmallIconSize);
    }

    // ------------------------------------------------------------------ status

    private async Task PollAsync()
    {
        var st = await _admin.GetStatusAsync();
        if (st == null)
        {
            _status = null;
            _offlinePolls++;
            // User mode: nobody else runs the engine, so we do (unless the service is installed).
            if (!EngineManager.ServiceInstalled && !_userStopped && !_startingEngine && !_engine.OwnsEngine && EngineManager.EngineExists)
            {
                _startingEngine = true;
                _engine.StartUserMode();
                _ = Task.Delay(4000).ContinueWith(_ => _startingEngine = false);
            }
            _tray.Icon = _idleIcon;
            _tray.Text = EngineManager.ServiceInstalled ? "Headroom Server — service not running" : "Headroom Server — starting…";
            if (_offlinePolls == 3 && _window is { Visible: true }) _window.ShowOffline();
            return;
        }
        bool wasOffline = _status == null && !_firstPoll;
        _offlinePolls = 0;
        _status = st;

        var ids = st.Viewers.Select(v => v.Id).ToHashSet();
        if (!_firstPoll)
        {
            foreach (var v in st.Viewers.Where(v => !_knownViewers.Contains(v.Id)))
                Notify($"{v.Device} connected", $"From {v.Address}. Open Headroom Server to disconnect it.");
            foreach (var gone in _knownViewers.Except(ids))
                Notify("Viewer disconnected", "A remote session ended.");
        }
        else if (st.DeviceCount == 0)
        {
            Notify("Headroom is running", "Click here to pair your phone or another computer.");
        }
        _knownViewers = ids;
        _firstPoll = false;

        int n = st.Viewers.Count;
        _tray.Icon = n > 0 ? _activeIcon : _idleIcon;
        var text = n switch
        {
            0 => $"Headroom Server — ready ({st.HostName})",
            1 => $"Headroom — {st.Viewers[0].Device} connected",
            _ => $"Headroom — {n} viewers connected",
        };
        _tray.Text = text.Length > 127 ? text[..127] : text;
        if (wasOffline && _window is { Visible: true }) _window.Navigate("status", reload: true);
    }

    private void Notify(string title, string text) => _tray.ShowBalloonTip(5000, title, text, ToolTipIcon.None);

    // ------------------------------------------------------------------ menu

    private void BuildMenu()
    {
        var m = _tray.ContextMenuStrip!;
        m.Items.Clear();
        var st = _status;
        string header = st == null
            ? (EngineManager.ServiceInstalled ? "Service not running" : "Server not running")
            : st.Viewers.Count == 0 ? "Ready — nobody connected"
            : string.Join(", ", st.Viewers.Select(v => v.Device)) + " connected";
        m.Items.Add(new ToolStripMenuItem(header) { Enabled = false });
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add(new ToolStripMenuItem("Open Headroom Server", null, (_, _) => ShowWindow("status")) { Font = new Font(m.Font, FontStyle.Bold) });
        m.Items.Add(new ToolStripMenuItem("Pair a device…", null, (_, _) => ShowWindow("pair")) { Enabled = st != null });

        var copy = new ToolStripMenuItem("Copy address") { Enabled = st != null && st.Urls.Count > 0 };
        if (st != null)
            foreach (var url in st.Urls)
                copy.DropDownItems.Add(url, null, (_, _) => Clipboard.SetText(url));
        m.Items.Add(copy);

        if (st is { Viewers.Count: > 0 })
            m.Items.Add(new ToolStripMenuItem("Disconnect everyone", null, async (_, _) => { await _admin.DisconnectAllAsync(); await PollAsync(); }));

        m.Items.Add(new ToolStripSeparator());
        if (EngineManager.ServiceInstalled)
        {
            m.Items.Add(new ToolStripMenuItem(st == null ? "Start service" : "Stop service", null, async (_, _) =>
            {
                bool start = _status == null;
                await Task.Run(() => EngineManager.ControlService(start));
                await PollAsync();
            }));
        }
        else
        {
            m.Items.Add(new ToolStripMenuItem(_engine.OwnsEngine || st != null ? "Stop server" : "Start server", null, async (_, _) =>
            {
                if (_engine.OwnsEngine) { _userStopped = true; _engine.StopUserMode(); }
                else { _userStopped = false; _engine.StartUserMode(); }
                await Task.Delay(1500);
                await PollAsync();
            }) { Enabled = EngineManager.EngineExists && (st == null || _engine.OwnsEngine) });
        }
        m.Items.Add(new ToolStripMenuItem("Start with Windows", null, (_, _) => SetAutostart(!AutostartEnabled)) { Checked = AutostartEnabled });
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add(new ToolStripMenuItem("Exit", null, (_, _) => Exit()));
    }

    public void ShowWindow(string section)
    {
        _ui.Post(_ =>
        {
            if (_window == null || _window.IsDisposed)
                _window = new SettingsWindow(LoadIconLarge(), StartServerFromWindowAsync);
            _window.Navigate(section);
            if (!_window.Visible) _window.Show();
            if (_window.WindowState == FormWindowState.Minimized) _window.WindowState = FormWindowState.Normal;
            _window.Activate();
        }, null);
    }

    private static Icon LoadIconLarge()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("headroom.ico")!;
        return new Icon(s, 32, 32);
    }

    private async Task<bool> StartServerFromWindowAsync()
    {
        if (EngineManager.ServiceInstalled) await Task.Run(() => EngineManager.ControlService(true));
        else { _userStopped = false; _engine.StartUserMode(); }
        for (int i = 0; i < 20; i++)
        {
            await Task.Delay(500);
            if (await _admin.GetStatusAsync() != null) { await PollAsync(); return true; }
        }
        return false;
    }

    // ------------------------------------------------------------------ autostart

    private static bool AutostartEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(RunValue) != null;
        }
    }

    public static void SetAutostart(bool on)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) key.SetValue(RunValue, $"\"{Environment.ProcessPath}\" --tray");
        else key.DeleteValue(RunValue, throwOnMissingValue: false);
    }

    // ------------------------------------------------------------------ exit

    private void Exit()
    {
        if (_engine.OwnsEngine && _status is { Viewers.Count: > 0 })
        {
            var r = MessageBox.Show("Someone is connected. Exiting stops the server and ends their session. Exit anyway?",
                "Headroom Server", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r != DialogResult.Yes) return;
        }
        _poll.Stop();
        _tray.Visible = false;
        _engine.Dispose(); // stops a user-mode engine; the service (if any) keeps running
        _window?.CloseForExit();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _tray.Dispose();
            _poll.Dispose();
            _engine.Dispose();
        }
        base.Dispose(disposing);
    }
}
