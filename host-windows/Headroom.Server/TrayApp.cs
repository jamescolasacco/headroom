using System.Reflection;
using Microsoft.Win32;

namespace Headroom.Server;

/// <summary>
/// Notification-area icon for the Headroom host, like VNC Server's: shows whether anyone is connected, pops a
/// notification when someone connects or leaves, asks before a guest gets in, shows the Stop bar while anyone is
/// connected, and gives quick actions.
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
    private readonly StopBar _stopBar;
    private ServerStatus? _status;
    private Dictionary<string, ViewerInfo> _knownViewers = new();
    private readonly bool _launchedInTray;
    private bool _firstPoll = true;
    private bool _startingEngine;
    private bool _userStopped;
    private int _offlinePolls;

    public TrayApp(bool showWindow)
    {
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        _launchedInTray = !showWindow;
        _stopBar = new StopBar();
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
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowWindow("home"); };
        _tray.BalloonTipClicked += (_, _) => ShowWindow("home");
        _poll.Tick += async (_, _) => await PollAsync();
        _poll.Start();
        _ = PollAsync();
        if (showWindow) ShowWindow("home");
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
            _stopBar.SetViewers(Array.Empty<ViewerInfo>(), "", () => { }, () => { });
            _tray.Icon = _idleIcon;
            _tray.Text = EngineManager.ServiceInstalled ? "Headroom Server — service not running" : "Headroom Server — starting…";
            if (_offlinePolls == 3 && _window is { Visible: true }) _window.ShowOffline();
            return;
        }
        bool wasOffline = _status == null && !_firstPoll;
        _offlinePolls = 0;
        _status = st;

        var ids = st.Viewers.GroupBy(v => v.Id).ToDictionary(g => g.Key, g => g.First());
        if (!_firstPoll && st.NotifyOnConnect)
        {
            foreach (var v in st.Viewers.Where(v => !_knownViewers.ContainsKey(v.Id)))
                Notify(v.Guest ? $"“{v.Device}” (guest) connected" : $"{v.Device} connected",
                    $"From {v.Address}. Click Stop in the bar at the top of the screen to end it.");
            foreach (var (_, v) in _knownViewers.Where(kv => !ids.ContainsKey(kv.Key)))
                Notify($"{v.Device} disconnected", "The remote session ended.");
        }
        else if (_firstPoll && !st.SignedIn && _launchedInTray)
        {
            Notify("Headroom is running", "Click here to sign in, or to let someone connect with a code.");
        }
        _knownViewers = ids;
        _firstPoll = false;
        ShowSupportPrompts(st.SupportRequests);
        _stopBar.SetViewers(st.Viewers, st.HostName, StopFromBar, () => ShowWindow("home"));

        int n = st.Viewers.Count;
        _tray.Icon = n > 0 ? _activeIcon : _idleIcon;
        var text = n switch
        {
            0 => st.Online ? $"Headroom Server — ready ({st.HostName})" : "Headroom Server — connecting to Headroom…",
            1 => $"Headroom — {st.Viewers[0].Device} connected",
            _ => $"Headroom — {n} people connected",
        };
        _tray.Text = text.Length > 127 ? text[..127] : text;
        if (wasOffline && _window is { Visible: true }) _window.Navigate("home", reload: true);
    }

    /// <summary>The Stop bar's button: one session ends; with several, everyone's.</summary>
    private async void StopFromBar()
    {
        if (_status?.Viewers is { Count: 1 } only) await _admin.StopAsync(only[0].Id);
        else await _admin.DisconnectAllAsync();
        await PollAsync();
    }

    private void Notify(string title, string text) => _tray.ShowBalloonTip(5000, title, text, ToolTipIcon.None);

    // ------------------------------------------------------------------ guests

    private readonly Dictionary<string, SupportPrompt> _prompts = new();

    /// <summary>
    /// Someone entered your guest code: Accept, View only or Decline, and what else they may do (files and clipboard
    /// start unticked). A prompt closes by itself when its request is answered in the settings window or times out.
    /// </summary>
    private void ShowSupportPrompts(IReadOnlyList<SupportRequest> requests)
    {
        foreach (var (id, prompt) in _prompts.ToArray())
        {
            if (requests.Any(r => r.Id == id)) continue;
            _prompts.Remove(id);
            if (!prompt.IsDisposed) prompt.Dismiss();
        }
        foreach (var r in requests.Where(r => !_prompts.ContainsKey(r.Id)))
        {
            var prompt = new SupportPrompt(r, async (accept, viewOnly, files, clipboard) =>
            {
                await _admin.AnswerSupportAsync(r.Id, accept, viewOnly, files, clipboard);
                await PollAsync();
            });
            _prompts[r.Id] = prompt;
            prompt.Show();
            prompt.Activate();
            System.Media.SystemSounds.Asterisk.Play();
        }
    }

    // ------------------------------------------------------------------ menu

    private void BuildMenu()
    {
        var m = _tray.ContextMenuStrip!;
        m.Items.Clear();
        var st = _status;
        string header = st == null
            ? (EngineManager.ServiceInstalled ? "Service not running" : "Server not running")
            : st.Viewers.Count > 0 ? string.Join(", ", st.Viewers.Select(v => v.Device)) + " connected"
            : st.Online ? "Ready — nobody connected" : "Connecting to Headroom…";
        if (header.Length > 80) header = header[..80] + "…";
        m.Items.Add(new ToolStripMenuItem(header) { Enabled = false });
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add(new ToolStripMenuItem("Open Headroom Server…", null, (_, _) => ShowWindow("home")) { Font = new Font(m.Font, FontStyle.Bold) });
        m.Items.Add(new ToolStripMenuItem("Let Someone Connect…", null, (_, _) => ShowWindow("connect")) { Enabled = st != null });
        if (st is { Viewers.Count: > 0 })
            m.Items.Add(new ToolStripMenuItem("Stop everyone's session", null, async (_, _) => { await _admin.DisconnectAllAsync(); await PollAsync(); }));

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

    /// <summary>Start with Windows (in the notification area): the per-user Run key.</summary>
    public static bool AutostartEnabled
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
        _stopBar.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _tray.Dispose();
            _poll.Dispose();
            _engine.Dispose();
            _stopBar.Dispose();
        }
        base.Dispose(disposing);
    }
}
