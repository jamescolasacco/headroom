using System.Diagnostics;
using System.Reflection;
using Headroom.Update;

namespace Headroom.Viewer;

/// <summary>HeadroomViewer.exe — the Windows viewer app (address book + remote sessions).</summary>
public static class Program
{
    public static string DataDir { get; } = Environment.GetEnvironmentVariable("HEADROOM_VIEWER_DATA") is { Length: > 0 } d
        ? d : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Headroom Viewer");
    public static Icon AppIcon { get; private set; } = SystemIcons.Application;
    public static Updater Updates { get; } = new(Updater.App.Viewer);
    private static readonly List<ViewerWindow> Windows = new();
    private static readonly ApplicationContext Context = new();
    private static readonly KeyboardHook Hook = new(hwnd => Windows.FirstOrDefault(w => w.SessionActive && w.IsHandleCreated && w.Handle == hwnd));

    /// <summary>The system-shortcut hook only runs while at least one window has a live session.</summary>
    private static void UpdateHook()
    {
        if (Windows.Any(w => w.SessionActive)) Hook.Install(); else Hook.Uninstall();
    }

    [STAThread]
    public static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetColorMode(SystemColorMode.Dark);
        using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("headroom.ico")!) AppIcon = new Icon(s);
        Directory.CreateDirectory(DataDir);

        OpenWindow(ViewerEnvironment.StartUrl);
        // Every window's page hears about updates (its "Restart to update" banner).
        var ui = SynchronizationContext.Current;
        Updates.Changed += s => ui?.Post(_ => { foreach (var w in Windows.ToList()) w.PostJson(s.Json); }, null);
        Updates.Start();
        Application.Run(Context); // exits when the last window closes
        Updates.Dispose();
    }

    /// <summary>Installs the downloaded update: Headroom Viewer closes, is replaced and opens again. A session ends, so ask.</summary>
    public static void RestartToUpdate()
    {
        var up = Updates.Now;
        if (up.Phase != "ready" || up.Version == null) return;
        if (!Updates.CanInstallHere)
        {
            Process.Start(new ProcessStartInfo(Updates.ReleasesPage) { UseShellExecute = true });
            return;
        }
        if (AnySessionActive)
        {
            var hosts = string.Join(", ", Windows.Where(w => w.SessionActive).Select(w => w.SessionHost).OfType<string>());
            var r = MessageBox.Show($"Headroom Viewer closes and opens again, which ends your session{(hosts.Length > 0 ? $" with {hosts}" : "")}. You can connect again right after.\n\nRestart and update to {up.Version}?",
                "Headroom Viewer", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r != DialogResult.Yes) return;
        }
        if (!Updates.Install(out var error))
        {
            if (error != null)
                MessageBox.Show($"Couldn't install the update: {error}\n\nYou can install it by hand from {Updates.ReleasesPage}.", "Headroom Viewer", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        foreach (var w in Windows.ToList()) w.Close(); // the last one ends the app; the installer opens the new one
    }

    public static ViewerWindow OpenWindow(string url)
    {
        var w = new ViewerWindow(url);
        Windows.Add(w);
        w.SessionChanged += _ => UpdateHook();
        w.FormClosed += (_, _) =>
        {
            Windows.Remove(w);
            UpdateHook();
            if (Windows.Count == 0) { Hook.Dispose(); Context.ExitThread(); }
        };
        w.Show();
        return w;
    }

    public static bool AnySessionActive => Windows.Any(w => w.SessionActive);

    /// <summary>Restart WebView2 so newly pinned certificates apply; the requesting window reloads at <paramref name="url"/>.</summary>
    public static async Task RestartBrowserAsync(ViewerWindow requester, string url)
    {
        foreach (var w in Windows) w.DetachWebView();
        UpdateHook();
        await ViewerEnvironment.RestartAsync();
        foreach (var w in Windows.ToList())
        {
            if (w == requester) w.Navigate(url);
            await w.AttachWebViewAsync();
        }
    }
}
