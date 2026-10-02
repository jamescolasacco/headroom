using System.Runtime.InteropServices;
using Headroom.Host.Platform;
using Headroom.Host.Util;
using SharpGen.Runtime;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace Headroom.Host.Capture;

public sealed class CursorShape
{
    public required uint Id { get; init; }          // content hash, lets clients cache shapes
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required int HotX { get; init; }
    public required int HotY { get; init; }
    public required byte[] Rgba { get; init; }
}

public enum CaptureStatus { Starting, Ok, SecureDesktop, Unavailable }

/// <summary>
/// DXGI Desktop Duplication of a single monitor. One instance per monitor, shared by every viewer
/// (ref-counted through <see cref="CaptureHub"/>).
///
/// Threading/devices: AcquireNextFrame holds its D3D11 device's lock while it waits for the next desktop
/// update, which stalls any encoder sharing that device (measured 40+ ms per frame on NVIDIA). So duplication
/// runs on a private capture device; every new image is copied into a keyed-mutex shared texture that the
/// shared "work" device (<see cref="Gpu"/>: conversion + hardware encode) opens. Consumers read it via
/// <see cref="WithLatest"/>, which takes the keyed mutex so GPU work on the two devices is ordered.
/// </summary>
public sealed class CaptureSource : IDisposable
{
    private const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027);
    private const int DXGI_ERROR_ACCESS_LOST = unchecked((int)0x887A0026);
    private const int DXGI_ERROR_INVALID_CALL = unchecked((int)0x887A0001);
    private const int DXGI_ERROR_UNSUPPORTED = unchecked((int)0x887A0004);
    private const int DXGI_ERROR_SESSION_DISCONNECTED = unchecked((int)0x887A0028);
    private const int DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = unchecked((int)0x887A0022);
    private const int DXGI_ERROR_DEVICE_REMOVED = unchecked((int)0x887A0005);
    private const int DXGI_ERROR_DEVICE_RESET = unchecked((int)0x887A0007);
    private const int E_ACCESSDENIED = unchecked((int)0x80070005);
    private const int WAIT_TIMEOUT = 0x102;

    private readonly Thread _thread;
    private volatile bool _stop;
    private readonly object _subGate = new();
    private readonly List<AutoResetEvent> _frameSignals = new();
    private readonly object _latestGate = new();

    // capture-side (private device, only touched by the capture thread)
    private ID3D11Device? _capDevice;
    private ID3D11DeviceContext? _capContext;
    private long _capLuid;
    private IDXGIOutputDuplication? _dup;
    private ID3D11Texture2D? _capShared;
    private IDXGIKeyedMutex? _capMutex;

    // work-side (shared GpuDevice)
    private ID3D11Texture2D? _workShared;
    private IDXGIKeyedMutex? _workMutex;
    private int _texWidth, _texHeight;

    public MonitorInfo Monitor { get; private set; }
    /// <summary>The shared work device (conversion + encoding) on the monitor's adapter.</summary>
    public GpuDevice? Gpu { get; private set; }
    public long FrameVersion => Interlocked.Read(ref _frameVersion);
    private long _frameVersion;
    /// <summary>Bumped whenever the shared texture is recreated (size/format/device change).</summary>
    public long Generation => Interlocked.Read(ref _generation);
    private long _generation;
    public int TextureWidth => _texWidth;
    public int TextureHeight => _texHeight;
    public int Rotation { get; private set; }
    public CaptureStatus Status { get; private set; } = CaptureStatus.Starting;
    public bool HasImage => _workShared != null && FrameVersion > 0;

    // Cursor state (desktop coordinates relative to the monitor's top-left).
    public int CursorX { get; private set; }
    public int CursorY { get; private set; }
    public bool CursorVisible { get; private set; }
    public CursorShape? Shape { get; private set; }
    public event Action<CaptureSource>? CursorMoved;
    public event Action<CaptureSource, CursorShape>? CursorShapeChanged;
    public event Action<CaptureSource, CaptureStatus>? StatusChanged;

    public CaptureSource(MonitorInfo monitor)
    {
        Monitor = monitor;
        _thread = new Thread(Run) { IsBackground = true, Name = $"capture {monitor.Id}", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    public AutoResetEvent Subscribe()
    {
        var ev = new AutoResetEvent(true);
        lock (_subGate) _frameSignals.Add(ev);
        return ev;
    }

    public void Unsubscribe(AutoResetEvent ev)
    {
        lock (_subGate) _frameSignals.Remove(ev);
        ev.Dispose();
    }

    private void SignalFrame()
    {
        lock (_subGate)
            foreach (var ev in _frameSignals) ev.Set();
    }

    /// <summary>
    /// Runs <paramref name="action"/> with the newest desktop texture (on <see cref="Gpu"/>) while holding the
    /// keyed mutex. Returns false if no image is available or the texture is busy longer than the timeout.
    /// </summary>
    public bool WithLatest(Action<ID3D11Texture2D> action, int timeoutMs = 50)
    {
        lock (_latestGate)
        {
            if (_workShared == null || _workMutex == null) return false;
            int r = KeyedMutex.Acquire(_workMutex, 0, (uint)timeoutMs);
            if (r != 0) return false;
            try { action(_workShared); }
            finally { _workMutex.ReleaseSync(0); }
            return true;
        }
    }

    private void SetStatus(CaptureStatus s)
    {
        if (Status == s) return;
        Status = s;
        Log.Info("capture", $"{Monitor.Id}: {s}");
        StatusChanged?.Invoke(this, s);
        SignalFrame();
    }

    private void Run()
    {
        uint taskIndex = 0;
        var mmcss = Native.AvSetMmThreadCharacteristicsW("Capture", ref taskIndex);
        var desktop = new InputDesktopFollower();
        desktop.Sync();
        long lastDesktopCheck = 0;
        int failures = 0;

        while (!_stop)
        {
            try
            {
                if (_dup == null)
                {
                    desktop.Sync();
                    if (!TryCreateDuplication(out int hr))
                    {
                        // E_ACCESSDENIED while the secure desktop (UAC / lock screen) is up and we're not SYSTEM.
                        bool secure = hr == E_ACCESSDENIED || desktop.Blocked ||
                                      (InputDesktopFollower.QueryInputDesktopName() is { } n && !n.Equals("Default", StringComparison.OrdinalIgnoreCase));
                        SetStatus(secure ? CaptureStatus.SecureDesktop : CaptureStatus.Unavailable);
                        failures++;
                        Thread.Sleep(Math.Min(1000, 100 * failures));
                        continue;
                    }
                    failures = 0;
                    SetStatus(CaptureStatus.Ok);
                }

                // Desktop switches (UAC, lock screen) normally surface as ACCESS_LOST, but check explicitly too.
                if (Environment.TickCount64 - lastDesktopCheck > 500)
                {
                    lastDesktopCheck = Environment.TickCount64;
                    if (desktop.Sync()) { ResetDuplication(); continue; }
                }

                var result = _dup!.AcquireNextFrame(100, out var info, out var resource);
                if (result.Code == DXGI_ERROR_WAIT_TIMEOUT) continue;
                if (result.Code == DXGI_ERROR_ACCESS_LOST || result.Code == DXGI_ERROR_INVALID_CALL)
                {
                    ResetDuplication();
                    continue;
                }
                if (result.Code == DXGI_ERROR_DEVICE_REMOVED || result.Code == DXGI_ERROR_DEVICE_RESET)
                    throw new SharpGenException(result);
                if (result.Failure)
                {
                    Log.Warn("capture", $"{Monitor.Id}: AcquireNextFrame failed 0x{result.Code:X8}");
                    ResetDuplication();
                    Thread.Sleep(50);
                    continue;
                }

                bool newImage = false;
                try
                {
                    if (info.LastPresentTime != 0 && resource != null)
                    {
                        using var tex = resource.QueryInterface<ID3D11Texture2D>();
                        newImage = CopyToShared(tex);
                    }
                    if (info.LastMouseUpdateTime != 0) UpdateCursorPosition(info.PointerPosition.Visible);
                    if (info.PointerShapeBufferSize > 0) ReadPointerShape(info.PointerShapeBufferSize);
                }
                finally
                {
                    resource?.Dispose();
                    _dup.ReleaseFrame();
                }
                if (newImage)
                {
                    Interlocked.Increment(ref _frameVersion);
                    SignalFrame();
                }
            }
            catch (SharpGenException ex) when (ex.ResultCode.Code == DXGI_ERROR_DEVICE_REMOVED || ex.ResultCode.Code == DXGI_ERROR_DEVICE_RESET)
            {
                Log.Error("capture", $"{Monitor.Id}: GPU device lost (driver update/TDR); recreating");
                ResetDuplication();
                DestroyDevices();
                if (Gpu != null) GpuDevice.Invalidate(Gpu);
                Gpu = null;
                Thread.Sleep(500);
            }
            catch (Exception ex)
            {
                Log.Error("capture", $"{Monitor.Id}: capture loop error", ex);
                ResetDuplication();
                Thread.Sleep(250);
            }
        }

        ResetDuplication();
        DestroyDevices();
        if (mmcss != 0) Native.AvRevertMmThreadCharacteristics(mmcss);
    }

    private bool TryCreateDuplication(out int hr)
    {
        hr = 0;
        // Re-resolve the monitor every time: resolution, rotation or adapter may have changed.
        var current = Displays.Enumerate().FirstOrDefault(m => m.Id.Equals(Monitor.Id, StringComparison.OrdinalIgnoreCase));
        if (current == null)
        {
            hr = DXGI_ERROR_UNSUPPORTED;
            return false;
        }
        Monitor = current;

        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        if (factory.EnumAdapters1((uint)current.AdapterIndex, out var adapter).Failure) return false;
        IDXGIOutput? output = null;
        try
        {
            if (adapter.EnumOutputs((uint)current.OutputIndex, out output).Failure) return false;
            if (!output.Description.DeviceName.Equals(current.Id, StringComparison.OrdinalIgnoreCase)) return false;
            long luid = adapter.Description1.Luid;

            if (_capDevice == null || _capLuid != luid)
            {
                DestroyDevices();
                var levels = new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0, FeatureLevel.Level_10_1 };
                D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport, levels,
                    out ID3D11Device? dev, out ID3D11DeviceContext? ctx).CheckError();
                _capDevice = dev;
                _capContext = ctx;
                _capLuid = luid;
            }
            if (Gpu == null || Gpu.Luid != luid || Gpu.IsRemoved)
            {
                // GpuDevice.Get takes ownership of the adapter reference it's given.
                factory.EnumAdapters1((uint)current.AdapterIndex, out var adapterForWork).CheckError();
                Gpu = GpuDevice.Get(adapterForWork);
                ReleaseShared();
            }

            try
            {
                // DuplicateOutput1 lets DWM hand us BGRA even for HDR/advanced-color desktops.
                using var output5 = output.QueryInterfaceOrNull<IDXGIOutput5>();
                if (output5 != null)
                    _dup = output5.DuplicateOutput1(_capDevice, new[] { Format.B8G8R8A8_UNorm });
                else
                {
                    using var output1 = output.QueryInterface<IDXGIOutput1>();
                    _dup = output1.DuplicateOutput(_capDevice);
                }
            }
            catch (SharpGenException ex)
            {
                hr = ex.ResultCode.Code;
                if (hr == DXGI_ERROR_UNSUPPORTED)
                {
                    using var output1 = output.QueryInterface<IDXGIOutput1>();
                    _dup = output1.DuplicateOutput(_capDevice);
                }
                else
                {
                    if (hr != E_ACCESSDENIED && hr != DXGI_ERROR_NOT_CURRENTLY_AVAILABLE && hr != DXGI_ERROR_SESSION_DISCONNECTED)
                        Log.Warn("capture", $"{Monitor.Id}: DuplicateOutput failed 0x{hr:X8}");
                    return false;
                }
            }

            var desc = _dup.Description;
            Rotation = desc.Rotation switch
            {
                ModeRotation.Rotate90 => 90,
                ModeRotation.Rotate180 => 180,
                ModeRotation.Rotate270 => 270,
                _ => 0,
            };
            Log.Info("capture", $"{Monitor.Id} ({Monitor.Name}) duplicating {desc.ModeDescription.Width}x{desc.ModeDescription.Height} " +
                                $"{desc.ModeDescription.Format} rot={Rotation} on '{Gpu!.AdapterName}'");
            return true;
        }
        finally
        {
            output?.Dispose();
            adapter.Dispose();
        }
    }

    private void ResetDuplication()
    {
        try { _dup?.Dispose(); } catch { }
        _dup = null;
    }

    private void ReleaseShared()
    {
        lock (_latestGate)
        {
            _workMutex?.Dispose(); _workMutex = null;
            _workShared?.Dispose(); _workShared = null;
        }
        _capMutex?.Dispose(); _capMutex = null;
        _capShared?.Dispose(); _capShared = null;
        _texWidth = _texHeight = 0;
    }

    private void DestroyDevices()
    {
        ReleaseShared();
        _capContext?.Dispose(); _capContext = null;
        _capDevice?.Dispose(); _capDevice = null;
        _capLuid = 0;
    }

    private bool CopyToShared(ID3D11Texture2D src)
    {
        var d = src.Description;
        if (_capShared == null || _texWidth != (int)d.Width || _texHeight != (int)d.Height)
        {
            ReleaseShared();
            _capShared = _capDevice!.CreateTexture2D(new Texture2DDescription
            {
                Width = d.Width,
                Height = d.Height,
                MipLevels = 1,
                ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default,
                BindFlags = BindFlags.ShaderResource | BindFlags.RenderTarget,
                CPUAccessFlags = CpuAccessFlags.None,
                MiscFlags = ResourceOptionFlags.SharedKeyedMutex,
            });
            _capMutex = _capShared.QueryInterface<IDXGIKeyedMutex>();
            using (var res = _capShared.QueryInterface<IDXGIResource>())
            {
                var handle = res.SharedHandle;
                var gpu = Gpu!;
                gpu.Lock();
                try
                {
                    var opened = gpu.Device.OpenSharedResource<ID3D11Texture2D>(handle);
                    lock (_latestGate)
                    {
                        _workShared = opened;
                        _workMutex = opened.QueryInterface<IDXGIKeyedMutex>();
                    }
                }
                finally { gpu.Unlock(); }
            }
            _texWidth = (int)d.Width;
            _texHeight = (int)d.Height;
            Interlocked.Increment(ref _generation);
        }

        if (KeyedMutex.Acquire(_capMutex!, 0, 100) != 0) return false; // a consumer is stuck; drop this frame
        try { _capContext!.CopyResource(_capShared, src); }
        finally { _capMutex!.ReleaseSync(0); }
        return true;
    }

    private void UpdateCursorPosition(bool visibleOnThisOutput)
    {
        var ci = new Native.CURSORINFO { cbSize = Marshal.SizeOf<Native.CURSORINFO>() };
        int x = CursorX, y = CursorY;
        bool showing = visibleOnThisOutput;
        if (Native.GetCursorInfo(ref ci))
        {
            x = ci.ptScreenPos.X - Monitor.X;
            y = ci.ptScreenPos.Y - Monitor.Y;
            showing &= (ci.flags & 1) != 0; // CURSOR_SHOWING
        }
        if (x == CursorX && y == CursorY && showing == CursorVisible) return;
        CursorX = x;
        CursorY = y;
        CursorVisible = showing;
        CursorMoved?.Invoke(this);
    }

    private byte[] _shapeBuffer = new byte[64 * 64 * 4];

    private unsafe void ReadPointerShape(uint size)
    {
        if (_shapeBuffer.Length < size) _shapeBuffer = new byte[size];
        OutduplPointerShapeInfo shapeInfo;
        fixed (byte* p = _shapeBuffer)
        {
            var r = _dup!.GetFramePointerShape((uint)_shapeBuffer.Length, (nint)p, out _, out shapeInfo);
            if (r.Failure) return;
        }
        var shape = PointerShapes.ToRgba(_shapeBuffer, shapeInfo);
        if (shape == null) return;
        if (Shape != null && Shape.Id == shape.Id) return;
        Shape = shape;
        CursorShapeChanged?.Invoke(this, shape);
    }

    public void Dispose()
    {
        _stop = true;
        _thread.Join(2000);
    }
}

/// <summary>
/// IDXGIKeyedMutex::AcquireSync returns WAIT_TIMEOUT (0x102) — a *success* HRESULT — which Vortice's void
/// wrapper swallows. Call the vtable (slot 8: IUnknown 3 + IDXGIObject 4 + IDXGIDeviceSubObject 1) directly.
/// </summary>
internal static unsafe class KeyedMutex
{
    public static int Acquire(IDXGIKeyedMutex mutex, ulong key, uint timeoutMs)
    {
        var fn = (delegate* unmanaged[Stdcall]<nint, ulong, uint, int>)(*(nint**)mutex.NativePointer)[8];
        return fn(mutex.NativePointer, key, timeoutMs);
    }
}

/// <summary>Converts the three DXGI pointer formats into straight RGBA usable as a CSS cursor.</summary>
public static class PointerShapes
{
    private const uint Monochrome = 1, Color = 2, MaskedColor = 4;

    public static CursorShape? ToRgba(byte[] src, OutduplPointerShapeInfo info)
    {
        int w = (int)info.Width;
        int h = info.Type == Monochrome ? (int)info.Height / 2 : (int)info.Height;
        int pitch = (int)info.Pitch;
        if (w <= 0 || h <= 0 || w > 512 || h > 512) return null;
        var rgba = new byte[w * h * 4];
        // Pixels that should invert the screen can't be expressed in CSS; draw them black and
        // add a white halo afterwards so the I-beam stays visible on dark backgrounds.
        var invert = new bool[w * h];

        switch (info.Type)
        {
            case Monochrome:
                for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int bit = 0x80 >> (x & 7);
                    bool and = (src[y * pitch + (x >> 3)] & bit) != 0;
                    bool xor = (src[(y + h) * pitch + (x >> 3)] & bit) != 0;
                    int o = (y * w + x) * 4;
                    if (!and && !xor) Set(rgba, o, 0, 0, 0, 255);
                    else if (!and && xor) Set(rgba, o, 255, 255, 255, 255);
                    else if (and && xor) { Set(rgba, o, 0, 0, 0, 255); invert[y * w + x] = true; }
                    // and && !xor: transparent
                }
                break;
            case Color:
                for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int s = y * pitch + x * 4, o = (y * w + x) * 4;
                    Set(rgba, o, src[s + 2], src[s + 1], src[s], src[s + 3]);
                }
                break;
            case MaskedColor:
                for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    int s = y * pitch + x * 4, o = (y * w + x) * 4;
                    byte b = src[s], g = src[s + 1], r = src[s + 2], mask = src[s + 3];
                    if (mask == 0) Set(rgba, o, r, g, b, 255);
                    else if (r != 0 || g != 0 || b != 0) { Set(rgba, o, 0, 0, 0, 255); invert[y * w + x] = true; }
                }
                break;
            default:
                return null;
        }

        bool anyInvert = false;
        foreach (var v in invert) if (v) { anyInvert = true; break; }
        if (anyInvert)
        {
            for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int o = (y * w + x) * 4;
                if (rgba[o + 3] != 0) continue;
                bool near = false;
                for (int dy = -1; dy <= 1 && !near; dy++)
                for (int dx = -1; dx <= 1 && !near; dx++)
                {
                    int nx = x + dx, ny = y + dy;
                    if (nx >= 0 && ny >= 0 && nx < w && ny < h && invert[ny * w + nx]) near = true;
                }
                if (near) Set(rgba, o, 255, 255, 255, 200);
            }
        }

        uint hash = 2166136261;
        foreach (var bt in rgba) hash = (hash ^ bt) * 16777619;
        hash = (hash ^ (uint)w) * 16777619;
        hash = (hash ^ (uint)info.HotSpot.X) * 16777619;
        hash = (hash ^ (uint)info.HotSpot.Y) * 16777619;

        return new CursorShape { Id = hash, Width = w, Height = h, HotX = info.HotSpot.X, HotY = info.HotSpot.Y, Rgba = rgba };
    }

    private static void Set(byte[] a, int o, byte r, byte g, byte b, byte alpha)
    {
        a[o] = r; a[o + 1] = g; a[o + 2] = b; a[o + 3] = alpha;
    }
}
