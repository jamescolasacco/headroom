using System.Runtime.InteropServices;
using Headroom.Host.Util;
using Vortice.DXGI;

namespace Headroom.Host.Capture;

public sealed record MonitorInfo
{
    /// <summary>GDI device name, e.g. \\.\DISPLAY1 — stable id used by the protocol.</summary>
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required int X { get; init; }
    public required int Y { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required bool Primary { get; init; }
    public required double RefreshHz { get; init; }
    public required double Scale { get; init; }
    public required int Rotation { get; init; } // degrees
    public required long AdapterLuid { get; init; }
    public required string AdapterName { get; init; }
    public required int AdapterIndex { get; init; }
    public required int OutputIndex { get; init; }
}

public static class Displays
{
    public static List<MonitorInfo> Enumerate()
    {
        var result = new List<MonitorInfo>();
        var names = DisplayConfigNames.Query();
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (int a = 0; factory.EnumAdapters1((uint)a, out var adapter).Success; a++)
        {
            using (adapter)
            {
                var adesc = adapter.Description1;
                for (int o = 0; adapter.EnumOutputs((uint)o, out var output).Success; o++)
                {
                    using (output)
                    {
                        var d = output.Description;
                        if (!d.AttachedToDesktop) continue;
                        var r = d.DesktopCoordinates;
                        names.TryGetValue(d.DeviceName, out var info);
                        uint dpi = 96;
                        try
                        {
                            if (GetDpiForMonitor(d.Monitor, 0, out var dx, out _) == 0) dpi = dx;
                        }
                        catch { }
                        result.Add(new MonitorInfo
                        {
                            Id = d.DeviceName,
                            Name = string.IsNullOrWhiteSpace(info.FriendlyName) ? FallbackName(d.DeviceName) : info.FriendlyName,
                            X = r.Left,
                            Y = r.Top,
                            Width = r.Right - r.Left,
                            Height = r.Bottom - r.Top,
                            Primary = r.Left == 0 && r.Top == 0,
                            RefreshHz = info.RefreshHz > 0 ? info.RefreshHz : 60,
                            Scale = dpi / 96.0,
                            Rotation = d.Rotation switch
                            {
                                ModeRotation.Rotate90 => 90,
                                ModeRotation.Rotate180 => 180,
                                ModeRotation.Rotate270 => 270,
                                _ => 0,
                            },
                            AdapterLuid = adesc.Luid,
                            AdapterName = adesc.Description,
                            AdapterIndex = a,
                            OutputIndex = o,
                        });
                    }
                }
            }
        }
        // Primary first, then left-to-right, top-to-bottom: matches how people think about their layout.
        result.Sort((x, y) =>
        {
            if (x.Primary != y.Primary) return x.Primary ? -1 : 1;
            int c = x.X.CompareTo(y.X);
            return c != 0 ? c : x.Y.CompareTo(y.Y);
        });
        return result;
    }

    private static string FallbackName(string deviceName)
    {
        var idx = deviceName.IndexOf("DISPLAY", StringComparison.OrdinalIgnoreCase);
        return idx >= 0 ? "Display " + deviceName[(idx + 7)..] : deviceName;
    }

    /// <summary>Bounding rectangle of all monitors (the Windows virtual desktop).</summary>
    public static (int X, int Y, int W, int H) VirtualBounds(IEnumerable<MonitorInfo> monitors)
    {
        var list = monitors.ToList();
        if (list.Count == 0) return (0, 0, 0, 0);
        int l = list.Min(m => m.X), t = list.Min(m => m.Y);
        int r = list.Max(m => m.X + m.Width), b = list.Max(m => m.Y + m.Height);
        return (l, t, r - l, b - t);
    }

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(nint hmonitor, int dpiType, out uint dpiX, out uint dpiY);
}

/// <summary>Friendly monitor names ("DELL U2720Q") and refresh rates via the DisplayConfig API.</summary>
internal static unsafe class DisplayConfigNames
{
    public record struct Info(string FriendlyName, double RefreshHz);

    private const uint QDC_ONLY_ACTIVE_PATHS = 2;
    private const uint GET_SOURCE_NAME = 1;
    private const uint GET_TARGET_NAME = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID { public uint Low; public int High; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathSourceInfo { public LUID AdapterId; public uint Id; public uint ModeInfoIdx; public uint StatusFlags; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathTargetInfo
    {
        public LUID AdapterId; public uint Id; public uint ModeInfoIdx; public uint OutputTechnology; public uint Rotation;
        public uint Scaling; public uint RefreshNum; public uint RefreshDen; public uint ScanLineOrdering; public int TargetAvailable; public uint StatusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathInfo { public PathSourceInfo Source; public PathTargetInfo Target; public uint Flags; }

    [StructLayout(LayoutKind.Sequential, Size = 64)]
    private struct ModeInfo { public uint InfoType; public uint Id; public LUID AdapterId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Header { public uint Type; public uint Size; public LUID AdapterId; public uint Id; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SourceName
    {
        public Header Header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string ViewGdiDeviceName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TargetName
    {
        public Header Header;
        public uint Flags; public uint OutputTechnology; public ushort EdidManufactureId; public ushort EdidProductCodeId; public uint ConnectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string MonitorFriendlyDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string MonitorDevicePath;
    }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);

    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PathInfo[] paths, ref uint numModes, [Out] ModeInfo[] modes, nint topology);

    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")]
    private static extern int GetSourceName(ref SourceName info);

    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")]
    private static extern int GetTargetName(ref TargetName info);

    public static Dictionary<string, Info> Query()
    {
        var map = new Dictionary<string, Info>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out var np, out var nm) != 0) return map;
            var paths = new PathInfo[np];
            var modes = new ModeInfo[nm];
            if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, 0) != 0) return map;
            for (int i = 0; i < np; i++)
            {
                var p = paths[i];
                var src = new SourceName { Header = new Header { Type = GET_SOURCE_NAME, Size = (uint)Marshal.SizeOf<SourceName>(), AdapterId = p.Source.AdapterId, Id = p.Source.Id } };
                if (GetSourceName(ref src) != 0) continue;
                var tgt = new TargetName { Header = new Header { Type = GET_TARGET_NAME, Size = (uint)Marshal.SizeOf<TargetName>(), AdapterId = p.Target.AdapterId, Id = p.Target.Id } };
                string friendly = GetTargetName(ref tgt) == 0 ? tgt.MonitorFriendlyDeviceName : "";
                double hz = p.Target.RefreshDen != 0 ? (double)p.Target.RefreshNum / p.Target.RefreshDen : 0;
                map[src.ViewGdiDeviceName] = new Info(friendly, Math.Round(hz, 2));
            }
        }
        catch (Exception ex)
        {
            Log.Debug("displays", $"DisplayConfig query failed: {ex.Message}");
        }
        return map;
    }
}
