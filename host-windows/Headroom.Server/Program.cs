namespace Headroom.Server;

/// <summary>
/// HeadroomServer.exe — the tray app. `--tray` starts in the notification area only (used at sign-in);
/// otherwise the settings window opens too. A second launch just brings the existing window forward.
/// </summary>
public static class Program
{
    private const string MutexName = @"Local\HeadroomServerTray";
    private const string ShowEventName = @"Local\HeadroomServerTray.Show";

    [STAThread]
    public static void Main(string[] args)
    {
        bool trayOnly = args.Contains("--tray", StringComparer.OrdinalIgnoreCase);
        if (args.Contains("--enable-autostart", StringComparer.OrdinalIgnoreCase)) { TrayApp.SetAutostart(true); return; }
        if (args.Contains("--disable-autostart", StringComparer.OrdinalIgnoreCase)) { TrayApp.SetAutostart(false); return; }

        using var mutex = new Mutex(true, MutexName, out bool first);
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        if (!first)
        {
            if (!trayOnly) showEvent.Set();
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetColorMode(SystemColorMode.System);

        var app = new TrayApp(showWindow: !trayOnly);
        // Second instances signal us to show the window.
        var waiter = new Thread(() =>
        {
            while (showEvent.WaitOne()) app.ShowWindow("status");
        }) { IsBackground = true, Name = "show-signal" };
        waiter.Start();
        Application.Run(app);
    }
}
