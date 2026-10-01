namespace Headroom.Host.Util;

public static class Paths
{
    /// <summary>
    /// Machine-wide data directory shared by the interactive host and the SYSTEM service, so pairing
    /// survives switching between the two modes. Override with HEADROOM_DATA for development.
    /// </summary>
    public static string DataDir { get; } = ResolveDataDir();

    public static string ConfigFile => Path.Combine(DataDir, "config.json");
    public static string CertDir => Path.Combine(DataDir, "certs");
    public static string LogDir => Path.Combine(DataDir, "logs");

    public static string AppDir { get; } = AppContext.BaseDirectory;

    public static string WebRoot
    {
        get
        {
            var overrideDir = Environment.GetEnvironmentVariable("HEADROOM_WEBROOT");
            if (!string.IsNullOrEmpty(overrideDir) && Directory.Exists(overrideDir)) return overrideDir;
            return Path.Combine(AppDir, "wwwroot");
        }
    }

    private static string ResolveDataDir()
    {
        var overrideDir = Environment.GetEnvironmentVariable("HEADROOM_DATA");
        if (!string.IsNullOrEmpty(overrideDir)) return overrideDir;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Headroom");
    }
}
