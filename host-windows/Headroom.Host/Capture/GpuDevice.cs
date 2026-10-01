using Headroom.Host.Util;
using SharpGen.Runtime;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.MediaFoundation;

namespace Headroom.Host.Capture;

/// <summary>
/// One D3D11 device per physical adapter, shared by every capture source, color converter and
/// hardware encoder on that adapter (zero-copy: desktop texture -> NV12 texture -> NVENC/QSV/AMF).
/// Multithread protection is enabled because capture, conversion and the async MFT all touch it.
/// </summary>
public sealed class GpuDevice : IDisposable
{
    private static readonly object CacheGate = new();
    private static readonly Dictionary<long, GpuDevice> Cache = new();

    public long Luid { get; }
    public string AdapterName { get; }
    public uint VendorId { get; }
    public IDXGIAdapter1 Adapter { get; }
    public ID3D11Device Device { get; }
    public ID3D11DeviceContext Context { get; }
    public ID3D11VideoDevice VideoDevice { get; }
    public ID3D11VideoContext VideoContext { get; }
    private readonly ID3D11Multithread _multithread;
    private IMFDXGIDeviceManager? _mfManager;
    private readonly object _mfGate = new();

    public bool IsRemoved
    {
        get
        {
            try { return Device.DeviceRemovedReason.Failure; } catch { return true; }
        }
    }

    private GpuDevice(IDXGIAdapter1 adapter)
    {
        Adapter = adapter;
        var desc = adapter.Description1;
        Luid = desc.Luid;
        AdapterName = desc.Description;
        VendorId = desc.VendorId;

        var flags = DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport;
        var levels = new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0, FeatureLevel.Level_10_1 };
        // An explicit adapter requires DriverType.Unknown.
        var hr = D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, flags, levels, out ID3D11Device? device, out ID3D11DeviceContext? context);
        if (hr.Failure || device == null)
        {
            // Some virtual display adapters have no video engine; retry without VideoSupport.
            hr = D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport, levels, out device, out context);
            hr.CheckError();
        }
        Device = device!;
        Context = context!;
        _multithread = Device.QueryInterface<ID3D11Multithread>();
        _multithread.SetMultithreadProtected(true);
        VideoDevice = Device.QueryInterface<ID3D11VideoDevice>();
        VideoContext = Context.QueryInterface<ID3D11VideoContext>();
        Log.Info("gpu", $"created D3D11 device on '{AdapterName}' (vendor 0x{VendorId:X4}, luid {Luid:X})");
    }

    /// <summary>Returns (creating if needed) the device for this adapter. Takes ownership of <paramref name="adapter"/>.</summary>
    public static GpuDevice Get(IDXGIAdapter1 adapter)
    {
        var luid = adapter.Description1.Luid;
        lock (CacheGate)
        {
            if (Cache.TryGetValue(luid, out var existing))
            {
                if (!existing.IsRemoved)
                {
                    adapter.Dispose();
                    return existing;
                }
                Log.Warn("gpu", $"device on '{existing.AdapterName}' was removed; recreating");
                Cache.Remove(luid);
                existing.Dispose();
            }
            var dev = new GpuDevice(adapter);
            Cache[luid] = dev;
            return dev;
        }
    }

    public static void Invalidate(GpuDevice device)
    {
        lock (CacheGate)
        {
            if (Cache.TryGetValue(device.Luid, out var d) && ReferenceEquals(d, device)) Cache.Remove(device.Luid);
        }
    }

    /// <summary>Media Foundation DXGI device manager for hardware MFTs (created lazily).</summary>
    public IMFDXGIDeviceManager MfDeviceManager
    {
        get
        {
            lock (_mfGate)
            {
                if (_mfManager == null)
                {
                    MediaFoundationRuntime.EnsureStarted();
                    _mfManager = MediaFactory.MFCreateDXGIDeviceManager();
                    _mfManager.ResetDevice(Device).CheckError();
                }
                return _mfManager;
            }
        }
    }

    public void Lock() => _multithread.Enter();
    public void Unlock() => _multithread.Leave();

    public void Dispose()
    {
        _mfManager?.Dispose();
        VideoContext.Dispose();
        VideoDevice.Dispose();
        _multithread.Dispose();
        Context.Dispose();
        Device.Dispose();
        Adapter.Dispose();
    }
}

public static class MediaFoundationRuntime
{
    private static int _started;

    public static void EnsureStarted()
    {
        if (Interlocked.Exchange(ref _started, 1) == 0)
        {
            MediaFactory.MFStartup(true).CheckError();
        }
    }
}
