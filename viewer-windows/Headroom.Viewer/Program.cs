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
        w.FormClosed += (_, _) =>
        {
            Windows.Remove(w);
            if (Windows.Count == 0) Context.ExitThread();
        };
        w.Show();
        return w;
    }

    /// <summary>Restart WebView2 so newly pinned certificates apply; the requesting window reloads at <paramref name="url"/>.</summary>
    public static async Task RestartBrowserAsync(ViewerWindow requester, string url)
    {
        foreach (var w in Windows) w.DetachWebView();
        await ViewerEnvironment.RestartAsync();
        foreach (var w in Windows.ToList())
        {
            if (w == requester) w.Navigate(url);
            await w.AttachWebViewAsync();
        }
    }
}
