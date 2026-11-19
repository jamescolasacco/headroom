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

/// <param name="Refinement">The still screen encoded again to sharpen it, not a new picture.</param>
public sealed record EncodedVideoFrame(int Epoch, uint FrameId, byte[] Data, bool KeyFrame, long CaptureTimeUs, double EncodeMs, bool Refinement = false);

public interface IVideoSink
{
    void OnVideoConfig(VideoStreamConfig config);
    void OnVideoFrame(EncodedVideoFrame frame);
    void OnCaptureStatus(CaptureStatus status, string? detail);
    /// <summary>Flow control: false while the network path is full (the frame is skipped, not queued).</summary>
    bool CanSendVideo { get; }
    /// <summary>Sharpening a still screen is extra: it goes only into an idle path (nothing in flight), so it never
    /// delays a new picture or looks like congestion.</summary>
    bool CanSendRefinement { get; }
}

public sealed class PipelineSettings
{
    public required MonitorInfo Monitor { get; init; }
    public int MaxFps { get; init; } = 60;
    public int BitrateKbps { get; init; } = 12000;
    /// <summary>The most the session allows: sharpening a still screen may spend up to this for a moment.</summary>
    public int MaxBitrateKbps { get; init; } = 0;
    public int MaxWidth { get; init; } = 0;   // 0 = native
    public int MaxHeight { get; init; } = 0;
    public string EncoderPreference { get; init; } = "auto";
    public bool FullRange { get; init; }
}

/// <summary>
/// One viewer's video stream: waits for new desktop frames from the shared <see cref="CaptureSource"/>,
/// converts on the GPU, encodes, and hands frames to the sink. Frames are only produced when the screen
/// changes (plus sharpening passes once it holds still, until text is at full quality),
/// capped at MaxFps, and skipped — never queued — when the network can't keep up.
/// </summary>
public sealed class VideoPipeline : IDisposable
{
    private const int NV12PoolSize = 4;
    private const int MaxH264Dimension = 4096;

    /// <summary>
    /// Sharpening a screen that went still: the same picture encoded again, each pass coding what the last one lost,
    /// up to 20 times, 70 ms apart (later if the path is busy), until three passes in a row come out tiny. At the
    /// stream's own bitrate: above it (Boost) the encoder paid the extra back on the next scroll's frames, which came
    /// out worse. Only a whole new picture (KeyFirst) gets twice the bitrate. HEADROOM_REFINE="max frames,interval ms
    /// (0: the frame interval),boost,converged bytes per pixel[,key|nokey]" overrides it (as on the Mac host, where it
    /// was measured).
    /// </summary>
    /// <param name="KeyFirst">The first pass is a whole new picture (a keyframe) rather than a correction of the smudged
    /// one: always (true), never (false), or (null) when the picture left on the screen came out smudged.</param>
    /// <param name="KeyBoost">That whole new picture's bitrate, as a multiple of the stream's (HEADROOM_REFINE_KEY_BOOST).</param>
    private sealed record Refinement(int MaxFrames, int IntervalMs, double Boost, double ConvergedBytesPerPixel, bool? KeyFirst = null, double KeyBoost = 2)
    {
        public static readonly Refinement Current = Parse(Environment.GetEnvironmentVariable("HEADROOM_REFINE"));
        private static Refinement Parse(string? s)
        {
            var r = new Refinement(20, 70, 1, 0.0005);
            var p = (s ?? "").Split(',');
            if (p.Length > 0 && int.TryParse(p[0], out var n)) r = r with { MaxFrames = n };
            if (p.Length > 1 && int.TryParse(p[1], out var ms)) r = r with { IntervalMs = ms };
            if (p.Length > 2 && double.TryParse(p[2], System.Globalization.CultureInfo.InvariantCulture, out var b)) r = r with { Boost = b };
            if (p.Length > 3 && double.TryParse(p[3], System.Globalization.CultureInfo.InvariantCulture, out var c)) r = r with { ConvergedBytesPerPixel = c };
            if (p.Length > 4) r = r with { KeyFirst = p[4] == "key" ? true : p[4] == "nokey" ? false : (bool?)null };
            if (double.TryParse(Environment.GetEnvironmentVariable("HEADROOM_REFINE_KEY_BOOST"), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var kb)) r = r with { KeyBoost = kb };
            return r;
        }
    }
    // Sharpening passes of the still picture now on screen (_stillSeq counts new pictures): how many came out tiny
    // in a row (OnEncoded), and when the last one did. Under _captureTimes.
    private int _stillSeq;
    private int _tinyPasses;
    private long _lastTinyAtMs;
    /// <summary>After a tiny pass the next one waits this long, and twice as long after a second: after a scroll that
    /// needed more than its share the encoder pays it back with near-empty frames for a second or so, and sharpening
    /// that took those for "done" left the picture smudged.</summary>
    private const int RecheckMs = 400;
    /// <summary>Sharpening starts once the screen has held still this long: one late frame in the middle of a scroll
    /// isn't a stop (passes sent then would only hold up the frames after them).</summary>
    private const int StillAfterMs = 100;
    /// <summary>A whole new picture only once the screen has held still this long: it's big, and the frames of a
    /// scroll that goes on after a short pause would wait behind it.</summary>
    private const int KeyStillMs = 150;
    private volatile int _lastFreshQp = -1;   // the quantizer of the newest new picture (OnEncoded; -1: unknown)
    /// <summary>From this quantizer up, text comes out smudged.</summary>
    private const int SmudgedQp = 30;
    private int _targetKbps;                // what the session asked for
    private double _boost = 1;              // the encoder runs at the target times this (more while sharpening)

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
    private readonly Dictionary<long, (long Us, bool Refinement, int StillSeq)> _captureTimes = new();
    private CaptureStatus _lastStatus = CaptureStatus.Starting;
    private string? _lastDetail;

    public int Epoch => _epoch;
    public string? EncoderName => _encoder?.Name;
    public int CurrentBitrateKbps => _targetKbps > 0 ? _targetKbps : _settings.BitrateKbps;
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
            _targetKbps = _settings.BitrateKbps;
            long nextFrameAt = 0;
            long lastVersion = -1;
            long stillSince = 0;    // when the newest new picture went out
            int refinementLeft = 0;
            long nextRefineAt = 0;
            var r = Refinement.Current;

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
                // The detail can change on its own too (the display went, then every display went).
                var detail = src.StatusDetail;
                if (src.Status != _lastStatus || detail != _lastDetail)
                {
                    _lastStatus = src.Status;
                    _lastDetail = detail;
                    _sink.OnCaptureStatus(src.Status, src.Status == CaptureStatus.SecureDesktop ? "secure-desktop" : detail);
                    if (src.Status == CaptureStatus.Ok) _keyframeRequested = true;
                }
                if (src.Status != CaptureStatus.Ok || !src.HasImage || src.Gpu == null) continue;

                int pending = Interlocked.Exchange(ref _pendingBitrate, 0);
                if (pending > 0) { _targetKbps = pending; ApplyBitrate(); }
                int tiny; long tinyAt;
                lock (_captureTimes) { tiny = _tinyPasses; tinyAt = _lastTinyAtMs; }
                // A pass that comes out tiny: nothing left to sharpen, or the encoder had spent its budget for the
                // moment (right after a scroll or a whole new screen). Passes a while later tell which: three tiny, done.
                if (refinementLeft > 0 && tiny >= 3) { refinementLeft = 0; SetBoost(1); }
                else if (refinementLeft > 0 && tiny > 0) nextRefineAt = Math.Max(nextRefineAt, tinyAt + ((long)RecheckMs << (tiny - 1)));

                now = _clock.ElapsedMilliseconds;
                long version = src.FrameVersion;
                bool fresh = version != lastVersion;
                bool refine = !fresh && refinementLeft > 0 && now >= nextRefineAt;
                bool key = _keyframeRequested;
                if (!fresh && !refine && !key) continue;
                if (now < nextFrameAt) continue; // fps cap; the wait above wakes us in time

                bool sharpening = refine && !key;
                bool wholePicture = sharpening && refinementLeft == r.MaxFrames && (r.KeyFirst ?? _lastFreshQp >= SmudgedQp);
                if (wholePicture && now < stillSince + KeyStillMs)
                {
                    nextRefineAt = stillSince + KeyStillMs;
                    continue;
                }
                if (sharpening && !_sink.CanSendRefinement)
                {
                    nextRefineAt = now + 4; // the path is busy: sharpen once it's idle
                    continue;
                }
                if (!sharpening && !_sink.CanSendVideo)
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
                    // Sharpening has its own bitrate (a whole new picture, more); a new picture goes back to the stream's.
                    SetBoost(wholePicture ? r.KeyBoost : sharpening ? r.Boost : 1);
                    if (EncodeOne(src, key || wholePicture, sharpening, lastVersion, out long sentVersion, out bool sentRefinement))
                    {
                        if (key) _keyframeRequested = false;
                        int frameInterval = 1000 / Math.Max(1, _settings.MaxFps);
                        int passInterval = r.IntervalMs > 0 ? r.IntervalMs : frameInterval;
                        if (sentRefinement)
                        {
                            if (--refinementLeft == 0) SetBoost(1);
                            nextRefineAt = now + passInterval;
                        }
                        else
                        {
                            lastVersion = sentVersion;
                            stillSince = now;
                            refinementLeft = r.MaxFrames;
                            nextRefineAt = now + Math.Max(passInterval, StillAfterMs);
                        }
                        nextFrameAt = now + frameInterval;
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

    /// <summary>The encoder at the stream's bitrate, or above it while sharpening.</summary>
    private void ApplyBitrate()
    {
        if (_encoder == null || _targetKbps <= 0) return;
        int kbps = _targetKbps;
        if (_boost > 1)
        {
            int cap = _settings.MaxBitrateKbps > 0 ? _settings.MaxBitrateKbps : int.MaxValue;
            kbps = Math.Max(_targetKbps, (int)Math.Min(cap, _targetKbps * _boost));
        }
        _encoder.SetBitrate(kbps);
    }

    private void SetBoost(double b)
    {
        b = Math.Max(1, b);
        if (b == _boost) return;
        _boost = b;
        ApplyBitrate();
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
        _lastDetail = null;
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
            BitrateKbps = _targetKbps > 0 ? _targetKbps : _settings.BitrateKbps,
            Preference = _settings.EncoderPreference,
            FullRange = _settings.FullRange,
        }, OnEncoded);
        _boost = 1;
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

    /// <summary>Encodes the newest picture: a sharpening pass (<paramref name="sharpen"/>) only if it's still the one
    /// last sent (<paramref name="stillVersion"/>); one that changed meanwhile goes out as the new picture it is.</summary>
    private unsafe bool EncodeOne(CaptureSource src, bool key, bool sharpen, long stillVersion, out long version, out bool refinement)
    {
        version = 0;
        refinement = false;
        var enc = _encoder!;
        // Keep at most NV12PoolSize-1 frames inside the encoder so we never overwrite one it's reading.
        if (enc.InFlight >= NV12PoolSize - 1) return false;
        var tex = _nv12[_poolIndex]!;
        _poolIndex = (_poolIndex + 1) % NV12PoolSize;

        long captureUs = ElapsedUs;
        var conv = _converter!;
        long v = 0;
        // The version is read while the picture is held, so it's the version of what's converted.
        if (!src.WithLatest(latest => { v = src.FrameVersion; conv.Convert(latest, tex); })) return false;
        version = v;
        refinement = sharpen && v == stillVersion;
        long hns = captureUs * 10;
        lock (_captureTimes)
        {
            if (!refinement) { _stillSeq++; _tinyPasses = 0; }
            _captureTimes[hns] = (captureUs, refinement, _stillSeq);
        }

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
        bool refinement;
        int stillSeq;
        lock (_captureTimes)
        {
            if (_captureTimes.Remove(packet.TimeHns, out var info)) (captureUs, refinement, stillSeq) = info;
            else (captureUs, refinement, stillSeq) = (packet.TimeHns / 10, false, -1);
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
        // The picture left on a still screen came out smudged (QP 30 or more: the encoder was short of bits for what
        // was changing, as in a fast scroll): the first sharpening pass is then a whole new picture. It gets a
        // keyframe's budget and is sharp in one go (measured on the Mac host: 44.7 dB 0.63 s after a fast scroll
        // stopped, on 10 Mb/s), where corrections of the smudged one, each at a frame's budget, took 1-2 s to reach
        // 38-41 dB. Typing, slow scrolls and page jumps come out sharp already and don't need it.
        if (!refinement) _lastFreshQp = processed.Qp ?? -1;
        if (Log.MinLevel <= Log.Level.Debug) Log.Debug("pipeline", $"frame {_frameId + 1}: {processed.Data.Length / 1024} KB, QP {(processed.Qp?.ToString() ?? "?")}{(processed.KeyFrame ? ", key" : "")}{(refinement ? ", sharpening" : "")}");
        var rc = Refinement.Current;
        if (refinement && rc.ConvergedBytesPerPixel > 0)
        {
            bool tiny = processed.Data.Length < conv.OutputWidth * conv.OutputHeight * rc.ConvergedBytesPerPixel;
            lock (_captureTimes)
            {
                if (stillSeq != _stillSeq) { } // a pass of a picture that's gone
                else if (tiny) { _tinyPasses++; _lastTinyAtMs = _clock.ElapsedMilliseconds; }
                else _tinyPasses = 0;
            }
        }
        _sink.OnVideoFrame(new EncodedVideoFrame(_epoch, ++_frameId, processed.Data, processed.KeyFrame, captureUs, packet.EncodeMs, refinement));
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
