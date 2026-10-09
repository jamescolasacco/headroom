using System.Reflection;

namespace Headroom.Viewer;

/// <summary>HeadroomViewer.exe — the Windows viewer app (address book + remote sessions).</summary>
public static class Program
{
    public static string DataDir { get; } = Environment.GetEnvironmentVariable("HEADROOM_VIEWER_DATA") is { Length: > 0 } d
        ? d : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Headroom Viewer");
    public static Icon AppIcon { get; private set; } = SystemIcons.Application;
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
        Application.Run(Context); // exits when the last window closes
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
