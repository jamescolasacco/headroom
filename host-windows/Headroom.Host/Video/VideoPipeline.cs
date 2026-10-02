using System.Diagnostics;
using Headroom.Host.Capture;
using Headroom.Host.Platform;
using Headroom.Host.Util;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace Headroom.Host.Video;

public sealed record VideoStreamConfig(
    int Epoch, string Codec, byte[] Description, int Width, int Height,
    int SourceWidth, int SourceHeight, string MonitorId, string EncoderName, bool Hardware, bool FullRange);

public sealed record EncodedVideoFrame(int Epoch, uint FrameId, byte[] Data, bool KeyFrame, long CaptureTimeUs, double EncodeMs);

public interface IVideoSink
{
    void OnVideoConfig(VideoStreamConfig config);
    void OnVideoFrame(EncodedVideoFrame frame);
    void OnCaptureStatus(CaptureStatus status, string? detail);
    /// <summary>Flow control: false while the network path is full (the frame is skipped, not queued).</summary>
    bool CanSendVideo { get; }
}

public sealed class PipelineSettings
{
    public required MonitorInfo Monitor { get; init; }
    public int MaxFps { get; init; } = 60;
    public int BitrateKbps { get; init; } = 12000;
    public int MaxWidth { get; init; } = 0;   // 0 = native
    public int MaxHeight { get; init; } = 0;
    public string EncoderPreference { get; init; } = "auto";
    public bool FullRange { get; init; }
}

/// <summary>
/// One viewer's video stream: waits for new desktop frames from the shared <see cref="CaptureSource"/>,
/// converts on the GPU, encodes, and hands frames to the sink. Frames are only produced when the screen
/// changes (plus a few "refinement" frames once it goes still, so text sharpens to full quality),
/// capped at MaxFps, and skipped — never queued — when the network can't keep up.
/// </summary>
public sealed class VideoPipeline : IDisposable
{
    private const int NV12PoolSize = 4;
    private const int RefinementFrames = 4;
    private const int RefinementIntervalMs = 70;
    private const int MaxH264Dimension = 4096;

    private readonly IVideoSink _sink;
    private readonly Thread _thread;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private H264Bitstream _bitstream = new();
    private volatile bool _stop;
    private volatile bool _keyframeRequested = true;
    private volatile int _pendingBitrate;
    private PipelineSettings _settings;
    private PipelineSettings? _pendingSettings;
    private readonly object _settingsGate = new();

    private CaptureSource? _source;
    private AutoResetEvent? _signal;
    private VideoConverter? _converter;
    private MfH264Encoder? _encoder;
    private readonly ID3D11Texture2D?[] _nv12 = new ID3D11Texture2D?[NV12PoolSize];
    private ID3D11Texture2D? _staging;
    private int _poolIndex;
    private long _builtGeneration = -1;
    private int _epoch;
    private uint _frameId;
    private readonly Dictionary<long, long> _captureTimes = new();
    private CaptureStatus _lastStatus = CaptureStatus.Starting;

    public int Epoch => _epoch;
    public string? EncoderName => _encoder?.Name;
    public int CurrentBitrateKbps => _encoder?.BitrateKbps ?? _settings.BitrateKbps;
    public MonitorInfo Monitor => _settings.Monitor;
    public CaptureSource? Source => _source;
    public double LastEncodeMs { get; private set; }
    public int FramesEncoded { get; private set; }
    public int FramesSkippedForFlowControl { get; private set; }

    public VideoPipeline(PipelineSettings settings, IVideoSink sink, int initialEpoch)
    {
        _settings = settings;
        _sink = sink;
        _epoch = initialEpoch;
        _thread = new Thread(Run) { IsBackground = true, Name = "video-pipeline", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    public void RequestKeyframe() => _keyframeRequested = true;

    public void SetBitrate(int kbps) => _pendingBitrate = kbps;

    /// <summary>Switch monitor / resolution / fps without tearing down the viewer connection.</summary>
    public void UpdateSettings(PipelineSettings settings)
    {
        lock (_settingsGate) _pendingSettings = settings;
        _signal?.Set();
    }

    public long ElapsedUs => _clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency;

    private void Run()
    {
        uint taskIndex = 0;
        var mmcss = Native.AvSetMmThreadCharacteristicsW("Games", ref taskIndex);
        Native.timeBeginPeriod(1);
        try
        {
            AttachSource(_settings.Monitor);
            long nextFrameAt = 0;
            long lastVersion = -1;
            int refinementLeft = 0;
            long nextRefineAt = 0;

            while (!_stop)
            {
                long now = _clock.ElapsedMilliseconds;
                int wait = 250;
                if (refinementLeft > 0) wait = (int)Math.Clamp(nextRefineAt - now, 1, 250);
                if (nextFrameAt > now) wait = (int)Math.Min(wait, Math.Max(1, nextFrameAt - now));
                _signal!.WaitOne(wait);
                if (_stop) break;

                ApplyPendingSettings();
                var src = _source!;
                if (src.Status != _lastStatus)
                {
                    _lastStatus = src.Status;
                    _sink.OnCaptureStatus(src.Status, src.Status == CaptureStatus.SecureDesktop ? "secure-desktop" : null);
                    if (src.Status == CaptureStatus.Ok) _keyframeRequested = true;
                }
                if (src.Status != CaptureStatus.Ok || !src.HasImage || src.Gpu == null) continue;

                int pending = Interlocked.Exchange(ref _pendingBitrate, 0);
                if (pending > 0) _encoder?.SetBitrate(pending);

                now = _clock.ElapsedMilliseconds;
                long version = src.FrameVersion;
                bool fresh = version != lastVersion;
                bool refine = !fresh && refinementLeft > 0 && now >= nextRefineAt;
                bool key = _keyframeRequested;
                if (!fresh && !refine && !key) continue;
                if (now < nextFrameAt) continue; // fps cap; the wait above wakes us in time

                if (!_sink.CanSendVideo)
                {
                    FramesSkippedForFlowControl++;
                    // Don't spin: poll again shortly. The frame isn't lost — we'll send the newest one.
                    Thread.Sleep(2);
                    _signal.Set();
                    continue;
                }

                try
                {
                    if (!EnsureBuilt(src)) { Thread.Sleep(100); continue; }
                    if (EncodeOne(src, key))
                    {
                        if (key) _keyframeRequested = false;
                        if (fresh)
                        {
                            lastVersion = version;
                            refinementLeft = RefinementFrames;
                        }
                        else if (refine) refinementLeft--;
                        nextRefineAt = now + RefinementIntervalMs;
                        nextFrameAt = now + 1000 / Math.Max(1, _settings.MaxFps);
                    }
                }
                catch (Exception ex)
                {
                    Log.Error("pipeline", "encode failed; rebuilding", ex);
                    TearDownEncoder();
                    Thread.Sleep(200);
                }
            }
        }
        catch (Exception ex)
        {
            Log.Error("pipeline", "pipeline crashed", ex);
            _sink.OnCaptureStatus(CaptureStatus.Unavailable, ex.Message);
        }
        finally
        {
            TearDownEncoder();
            DetachSource();
            Native.timeEndPeriod(1);
            if (mmcss != 0) Native.AvRevertMmThreadCharacteristics(mmcss);
        }
    }

    private void ApplyPendingSettings()
    {
        PipelineSettings? next;
        lock (_settingsGate)
        {
            next = _pendingSettings;
            _pendingSettings = null;
        }
        if (next == null) return;
        bool monitorChanged = !next.Monitor.Id.Equals(_settings.Monitor.Id, StringComparison.OrdinalIgnoreCase);
        _settings = next;
        if (monitorChanged)
        {
            TearDownEncoder();
            DetachSource();
            AttachSource(next.Monitor);
        }
        else
        {
            TearDownEncoder(); // resolution/fps/encoder may differ — rebuild lazily
        }
        _keyframeRequested = true;
    }

    private void AttachSource(MonitorInfo monitor)
    {
        _source = CaptureHub.Acquire(monitor);
        _signal = _source.Subscribe();
        _lastStatus = CaptureStatus.Starting;
    }

    private void DetachSource()
    {
        if (_source == null) return;
        if (_signal != null) _source.Unsubscribe(_signal);
        CaptureHub.Release(_source);
        _source = null;
        _signal = null;
    }

    private bool EnsureBuilt(CaptureSource src)
    {
        if (_encoder != null && _builtGeneration == src.Generation && _converter != null) return true;
        TearDownEncoder();

        int texW = src.TextureWidth, texH = src.TextureHeight;
        bool swap = src.Rotation is 90 or 270;
        int srcW = swap ? texH : texW, srcH = swap ? texW : texH;

        double scale = 1.0;
        if (_settings.MaxWidth > 0) scale = Math.Min(scale, (double)_settings.MaxWidth / srcW);
        if (_settings.MaxHeight > 0) scale = Math.Min(scale, (double)_settings.MaxHeight / srcH);
        scale = Math.Min(scale, Math.Min((double)MaxH264Dimension / srcW, (double)MaxH264Dimension / srcH));
        int outW = Math.Max(64, (int)Math.Round(srcW * scale)) & ~1;
        int outH = Math.Max(64, (int)Math.Round(srcH * scale)) & ~1;

        var gpu = src.Gpu!;
        _converter = new VideoConverter(gpu, texW, texH, outW, outH, src.Rotation, _settings.FullRange);
        _encoder = MfH264Encoder.Create(gpu, new EncoderOptions
        {
            Width = outW,
            Height = outH,
            Fps = _settings.MaxFps,
            BitrateKbps = _settings.BitrateKbps,
            Preference = _settings.EncoderPreference,
            FullRange = _settings.FullRange,
        }, OnEncoded);
        for (int i = 0; i < NV12PoolSize; i++) _nv12[i] = _converter.CreateOutputTexture(_encoder.AcceptsTextures);
        if (!_encoder.AcceptsTextures)
        {
            gpu.Lock();
            try
            {
                _staging = gpu.Device.CreateTexture2D(new Texture2DDescription
                {
                    Width = (uint)outW, Height = (uint)outH, MipLevels = 1, ArraySize = 1, Format = Format.NV12,
                    SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Staging,
                    BindFlags = BindFlags.None, CPUAccessFlags = CpuAccessFlags.Read,
                });
            }
            finally { gpu.Unlock(); }
        }
        _builtGeneration = src.Generation;
        _epoch++;
        _bitstream = new H264Bitstream(); // forces SPS/PPS (decoder config) to be re-sent with the next IDR
        _keyframeRequested = true;
        _sourceDims = (srcW, srcH);
        Log.Info("pipeline", $"stream {src.Monitor.Id} {srcW}x{srcH} -> {outW}x{outH} @{_settings.MaxFps}fps epoch {_epoch}");
        return true;
    }

    private (int W, int H) _sourceDims;

    private unsafe bool EncodeOne(CaptureSource src, bool key)
    {
        var enc = _encoder!;
        // Keep at most NV12PoolSize-1 frames inside the encoder so we never overwrite one it's reading.
        if (enc.InFlight >= NV12PoolSize - 1) return false;
        var tex = _nv12[_poolIndex]!;
        _poolIndex = (_poolIndex + 1) % NV12PoolSize;

        long captureUs = ElapsedUs;
        var conv = _converter!;
        if (!src.WithLatest(latest => conv.Convert(latest, tex))) return false;
        long hns = captureUs * 10;
        lock (_captureTimes) _captureTimes[hns] = captureUs;

        bool accepted;
        if (enc.AcceptsTextures)
        {
            accepted = enc.EncodeTexture(tex, hns, key);
        }
        else
        {
            var gpu = src.Gpu!;
            int w = conv.OutputWidth, h = conv.OutputHeight;
            var bytes = new byte[w * h * 3 / 2];
            gpu.Lock();
            try
            {
                gpu.Context.CopyResource(_staging!, tex);
                var map = gpu.Context.Map(_staging!, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
                try
                {
                    byte* p = (byte*)map.DataPointer;
                    int pitch = (int)map.RowPitch;
                    fixed (byte* dst = bytes)
                    {
                        for (int y = 0; y < h; y++) Buffer.MemoryCopy(p + y * pitch, dst + y * w, w, w);
                        // NV12 chroma plane starts after `h` rows of the (padded) luma plane.
                        byte* uv = p + pitch * h;
                        for (int y = 0; y < h / 2; y++) Buffer.MemoryCopy(uv + y * pitch, dst + w * h + y * w, w, w);
                    }
                }
                finally { gpu.Context.Unmap(_staging!, 0); }
            }
            finally { gpu.Unlock(); }
            accepted = enc.EncodeBytes(bytes, hns, key);
        }
        if (!accepted)
        {
            lock (_captureTimes) _captureTimes.Remove(hns);
            return false;
        }
        FramesEncoded++;
        return true;
    }

    /// <summary>Encoder output callback (MFT event thread or pipeline thread for sync encoders).</summary>
    private void OnEncoded(EncodedPacket packet)
    {
        var enc = _encoder;
        var conv = _converter;
        if (enc == null || conv == null) return;
        var processed = _bitstream.Process(packet.AnnexB);
        if (processed == null) return;
        LastEncodeMs = packet.EncodeMs;
        long captureUs;
        lock (_captureTimes)
        {
            if (!_captureTimes.Remove(packet.TimeHns, out captureUs)) captureUs = packet.TimeHns / 10;
            if (_captureTimes.Count > 64) _captureTimes.Clear();
        }
        if (processed.ConfigChanged || (processed.KeyFrame && !_configSentForEpoch.Equals(_epoch)))
        {
            _configSentForEpoch = _epoch;
            _sink.OnVideoConfig(new VideoStreamConfig(_epoch, _bitstream.CodecString(), _bitstream.BuildAvcC(),
                conv.OutputWidth, conv.OutputHeight, _sourceDims.W, _sourceDims.H, _settings.Monitor.Id,
                enc.Name, enc.IsHardware, _settings.FullRange));
        }
        if (_configSentForEpoch != _epoch) return; // no decoder config yet: client can't use delta frames
        _sink.OnVideoFrame(new EncodedVideoFrame(_epoch, ++_frameId, processed.Data, processed.KeyFrame, captureUs, packet.EncodeMs));
    }

    private int _configSentForEpoch = -1;

    private void TearDownEncoder()
    {
        _encoder?.Dispose();
        _encoder = null;
        for (int i = 0; i < NV12PoolSize; i++)
        {
            if (_nv12[i] != null) { _converter?.Forget(_nv12[i]!); _nv12[i]!.Dispose(); _nv12[i] = null; }
        }
        _staging?.Dispose();
        _staging = null;
        _converter?.Dispose();
        _converter = null;
        _builtGeneration = -1;
    }

    public void Dispose()
    {
        _stop = true;
        _signal?.Set();
        _thread.Join(3000);
    }
}
