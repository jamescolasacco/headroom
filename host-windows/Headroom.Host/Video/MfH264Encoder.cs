using System.Runtime.InteropServices;
using Headroom.Host.Capture;
using Headroom.Host.Util;
using SharpGen.Runtime;
using Vortice.Direct3D11;
using Vortice.MediaFoundation;

namespace Headroom.Host.Video;

public sealed class EncoderOptions
{
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required int Fps { get; init; }
    public required int BitrateKbps { get; init; }
    /// <summary>auto | hardware | software</summary>
    public string Preference { get; init; } = "auto";
    public bool FullRange { get; init; }
}

public sealed record EncodedPacket(byte[] AnnexB, bool KeyFrame, long TimeHns, double EncodeMs);

/// <summary>
/// H.264 encoding through a Media Foundation transform. Prefers the GPU vendor's hardware MFT
/// (NVENC / Quick Sync / AMF) fed directly with D3D11 NV12 textures; falls back to Microsoft's
/// software encoder with system-memory input. Configured for one-in/one-out ultra-low latency:
/// low-latency mode, no B-frames, CBR whose VBV lets one frame take half a second's worth (a whole new screen
/// comes out readable), on-demand IDR frames, effectively infinite GOP.
/// </summary>
public sealed unsafe class MfH264Encoder : IDisposable
{
    private static readonly Guid MFT_CATEGORY_VIDEO_ENCODER = new("f79eac7d-e545-4387-bdee-d647d7bde42a");
    private static readonly Guid MF_LOW_LATENCY = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    private static readonly Guid MFT_ENUM_ADAPTER_LUID = new("1d39518c-e220-4da8-a07f-ba172552d6b1");
    private static readonly Guid MFSampleExtension_CleanPoint = new("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a");
    private static readonly Guid CLSID_MSH264EncoderMFT = new("6ca50344-051a-4ded-9779-a43305165e35");
    private static readonly Guid MFT_TRANSFORM_CLSID_Attribute = new("6821c42b-65a4-4e82-99bc-9a88205ecd0c");

    private const uint MFT_ENUM_FLAG_SYNCMFT = 0x1;
    private const uint MFT_ENUM_FLAG_ASYNCMFT = 0x2;
    private const uint MFT_ENUM_FLAG_HARDWARE = 0x4;
    private const uint MFT_ENUM_FLAG_SORTANDFILTER = 0x40;

    private const int MF_E_TRANSFORM_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);
    private const int MF_E_TRANSFORM_STREAM_CHANGE = unchecked((int)0xC00D6D61);
    private const int MF_E_NOTACCEPTING = unchecked((int)0xC00D36B5);
    private const int MF_E_SHUTDOWN = unchecked((int)0xC00D3E85);

    private readonly IMFActivate? _activate;
    private readonly IMFTransform _mft;
    private readonly IMFMediaEventGenerator? _events;
    private readonly CodecApi? _codec;
    private readonly Action<EncodedPacket> _onOutput;
    private readonly SemaphoreSlim _needInput = new(0);
    private readonly object _mftGate = new();
    private readonly Thread? _eventThread;
    private readonly long _frameDuration;
    private readonly bool _providesSamples;
    private readonly int _outputBufferSize;
    private readonly Queue<(long Time, long SubmitTicks)> _pending = new();
    private volatile bool _disposed;
    private volatile bool _stopping;            // Dispose has begun: what still comes out is dropped
    private readonly ManualResetEventSlim _drained = new(false);
    private const int DrainTimeoutMs = 500;
    private int _inFlight;
    private int _bitrateKbps;
    private readonly int _fps;

    public static bool TraceEvents = Environment.GetEnvironmentVariable("HEADROOM_TRACE_MFT") == "1";
    public string Name { get; }
    public bool IsHardware { get; }
    public bool IsAsync { get; }
    public int Width { get; }
    public int Height { get; }
    public int InFlight => Volatile.Read(ref _inFlight);
    public int BitrateKbps => _bitrateKbps;

    /// <summary>Hardware encoders take D3D11 textures; the software one needs NV12 bytes in system memory.</summary>
    public bool AcceptsTextures => IsHardware;

    public static MfH264Encoder Create(GpuDevice gpu, EncoderOptions opts, Action<EncodedPacket> onOutput)
    {
        using (MfTrace.Call("MFStartup")) MediaFoundationRuntime.EnsureStarted();
        var errors = new List<string>();
        if (opts.Preference != "software")
        {
            foreach (var act in EnumerateHardware(gpu.Luid))
            {
                string name = SafeName(act);
                try
                {
                    return new MfH264Encoder(gpu, act, opts, onOutput, hardware: true, name);
                }
                catch (Exception ex)
                {
                    errors.Add($"{name}: {ex.Message}");
                    Log.Warn("encoder", $"hardware encoder '{name}' failed: {ex.Message}");
                    try { using (MfTrace.Call("IMFActivate.ShutdownObject", act)) act.ShutdownObject(); } catch { }
                    using (MfTrace.Call("IMFActivate.Release", act)) act.Dispose();
                }
            }
        }
        if (opts.Preference != "hardware")
        {
            foreach (var act in EnumerateSoftware())
            {
                string name = SafeName(act);
                try
                {
                    return new MfH264Encoder(gpu, act, opts, onOutput, hardware: false, name);
                }
                catch (Exception ex)
                {
                    errors.Add($"{name}: {ex.Message}");
                    Log.Warn("encoder", $"software encoder '{name}' failed: {ex.Message}");
                    using (MfTrace.Call("IMFActivate.Release", act)) act.Dispose();
                }
            }
        }
        throw new InvalidOperationException("No usable H.264 encoder: " + string.Join("; ", errors));
    }

    private static string SafeName(IMFActivate act)
    {
        try { using (MfTrace.Call("IMFActivate.GetString(FriendlyName)", act)) return act.GetString(TransformAttributeKeys.MftFriendlyNameAttribute) ?? "H.264 encoder"; }
        catch { return "H.264 encoder"; }
    }

    private static List<IMFActivate> EnumerateHardware(long luid)
    {
        var list = new List<IMFActivate>();
        var output = new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.H264 };
        // MFTEnum2 can filter by adapter so multi-GPU systems pick the encoder on the capturing GPU.
        try
        {
            IMFAttributes attrs;
            using (MfTrace.Call("MFCreateAttributes")) attrs = MediaFactory.MFCreateAttributes(1);
            try
            {
                using (MfTrace.Call("IMFAttributes.Set(adapter LUID)", attrs)) attrs.Set(MFT_ENUM_ADAPTER_LUID, (ulong)luid);
                nint arr;
                uint count;
                using (MfTrace.Call("MFTEnum2")) MediaFactory.MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, null, output, attrs, out arr, out count);
                for (int i = 0; i < count; i++) list.Add(new IMFActivate(Marshal.ReadIntPtr(arr, i * IntPtr.Size)));
                if (arr != 0) Marshal.FreeCoTaskMem(arr);
            }
            finally
            {
                using (MfTrace.Call("IMFAttributes.Release", attrs)) attrs.Dispose();
            }
        }
        catch (Exception ex)
        {
            Log.Debug("encoder", $"MFTEnum2 failed ({ex.Message}); falling back to MFTEnumEx");
        }
        if (list.Count == 0)
        {
            nint arr;
            uint count;
            using (MfTrace.Call("MFTEnumEx(hardware)")) MediaFactory.MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, null, output, out arr, out count);
            for (int i = 0; i < count; i++) list.Add(new IMFActivate(Marshal.ReadIntPtr(arr, i * IntPtr.Size)));
            if (arr != 0) Marshal.FreeCoTaskMem(arr);
        }
        if (MfTrace.Enabled) MfTrace.Note($"{list.Count} hardware encoder(s) on adapter {luid:X}");
        return list;
    }

    private static List<IMFActivate> EnumerateSoftware()
    {
        var list = new List<IMFActivate>();
        var output = new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.H264 };
        nint arr;
        uint count;
        using (MfTrace.Call("MFTEnumEx(software)")) MediaFactory.MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER, null, output, out arr, out count);
        for (int i = 0; i < count; i++) list.Add(new IMFActivate(Marshal.ReadIntPtr(arr, i * IntPtr.Size)));
        if (arr != 0) Marshal.FreeCoTaskMem(arr);
        // Put Microsoft's encoder first: it's the one guaranteed to accept our settings.
        list.Sort((a, b) => IsMs(b).CompareTo(IsMs(a)));
        return list;

        static bool IsMs(IMFActivate a)
        {
            try { using (MfTrace.Call("IMFActivate.GetGUID(CLSID)", a)) return a.GetGUID(MFT_TRANSFORM_CLSID_Attribute) == CLSID_MSH264EncoderMFT; } catch { return false; }
        }
    }

    private MfH264Encoder(GpuDevice gpu, IMFActivate activate, EncoderOptions opts, Action<EncodedPacket> onOutput, bool hardware, string name)
    {
        _activate = activate;
        _onOutput = onOutput;
        Name = name;
        IsHardware = hardware;
        Width = opts.Width;
        Height = opts.Height;
        _fps = Math.Max(1, opts.Fps);
        _bitrateKbps = opts.BitrateKbps;
        _frameDuration = 10_000_000L / _fps;

        using (MfTrace.Call("IMFActivate.ActivateObject(IMFTransform)", activate)) _mft = activate.ActivateObject<IMFTransform>();
        if (MfTrace.Enabled) MfTrace.Note($"MFT {_mft.NativePointer:X} '{name}'");
        IMFAttributes? attrs = null;
        try
        {
            using (MfTrace.Call("IMFTransform.GetAttributes", _mft)) attrs = _mft.Attributes;
            uint isAsync = 0;
            try { using (MfTrace.Call("IMFAttributes.GetUINT32(TransformAsync)", attrs)) isAsync = attrs.GetUInt32(TransformAttributeKeys.TransformAsync); } catch { }
            IsAsync = isAsync != 0;
            if (IsAsync) using (MfTrace.Call("IMFAttributes.Set(TransformAsyncUnlock)", attrs)) attrs.Set(TransformAttributeKeys.TransformAsyncUnlock, 1u).CheckError();
            try { using (MfTrace.Call("IMFAttributes.Set(LowLatency)", attrs)) attrs.Set(MF_LOW_LATENCY, 1u); } catch { }

            if (hardware)
            {
                uint d3d11Aware = 0;
                try { using (MfTrace.Call("IMFAttributes.GetUINT32(D3D11Aware)", attrs)) d3d11Aware = attrs.GetUInt32(TransformAttributeKeys.D3D11Aware); } catch { }
                if (d3d11Aware == 0) throw new NotSupportedException("encoder is not D3D11 aware");
                nint manager;
                using (MfTrace.Call("GpuDevice.MfDeviceManager")) manager = gpu.MfDeviceManager.NativePointer;
                using (MfTrace.Call("IMFTransform.ProcessMessage(SetD3DManager)", _mft)) _mft.ProcessMessage(TMessageType.MessageSetD3DManager, (nuint)manager);
            }

            // ---- codec properties. Must precede SetOutputType: encoders latch GOP/rate control when the
            //      output type is set (NVIDIA ignored the GOP when it was only set afterwards).
            using (MfTrace.Call("QueryInterface(ICodecAPI)", _mft)) _codec = CodecApi.From(_mft.NativePointer);
            ApplyCodecSettings(opts, hardware, log: true);

            // ---- output type first (required by hardware encoders)
            IMFMediaType outType;
            using (MfTrace.Call("MFCreateMediaType(output)")) outType = MediaFactory.MFCreateMediaType();
            try
            {
                using (MfTrace.Call("IMFAttributes.Set x12 (output type)", outType))
                {
                    outType.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video).CheckError();
                    outType.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.H264).CheckError();
                    outType.Set(MediaTypeAttributeKeys.AvgBitrate, (uint)(opts.BitrateKbps * 1000)).CheckError();
                    MediaFactory.MFSetAttributeSize(outType, MediaTypeAttributeKeys.FrameSize, (uint)Width, (uint)Height).CheckError();
                    MediaFactory.MFSetAttributeRatio(outType, MediaTypeAttributeKeys.FrameRate, (uint)_fps, 1).CheckError();
                    MediaFactory.MFSetAttributeRatio(outType, MediaTypeAttributeKeys.PixelAspectRatio, 1, 1).CheckError();
                    outType.Set(MediaTypeAttributeKeys.InterlaceMode, 2u).CheckError(); // MFVideoInterlace_Progressive
                    outType.Set(MediaTypeAttributeKeys.Mpeg2Profile, 100u).CheckError(); // High
                    // VUI: BT.709 primaries/transfer/matrix, limited or full range. Browsers honour these.
                    outType.Set(MediaTypeAttributeKeys.VideoPrimaries, 2u);      // MFVideoPrimaries_BT709
                    outType.Set(MediaTypeAttributeKeys.TransferFunction, 5u);    // MFVideoTransFunc_709
                    outType.Set(MediaTypeAttributeKeys.YuvMatrix, 1u);           // MFVideoTransferMatrix_BT709
                    outType.Set(MediaTypeAttributeKeys.VideoNominalRange, opts.FullRange ? 1u : 2u); // 0_255 : 16_235
                }
                using (MfTrace.Call("IMFTransform.SetOutputType", _mft)) _mft.SetOutputType(0, outType, 0);
            }
            finally
            {
                using (MfTrace.Call("IMFMediaType.Release(output)", outType)) outType.Dispose();
            }

            // ---- input type: NV12
            IMFMediaType? inType = null;
            for (int i = 0; ; i++)
            {
                IMFMediaType t;
                try { using (MfTrace.Call("IMFTransform.GetInputAvailableType", _mft)) t = _mft.GetInputAvailableType(0, i); }
                catch { break; }
                bool nv12;
                using (MfTrace.Call("IMFMediaType.GetGUID(Subtype)", t)) nv12 = t.GetGUID(MediaTypeAttributeKeys.Subtype) == VideoFormatGuids.NV12;
                if (nv12) { inType = t; break; }
                using (MfTrace.Call("IMFMediaType.Release", t)) t.Dispose();
            }
            if (inType == null)
            {
                using (MfTrace.Call("MFCreateMediaType(input) + IMFAttributes.Set x2"))
                {
                    inType = MediaFactory.MFCreateMediaType();
                    inType.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video).CheckError();
                    inType.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.NV12).CheckError();
                }
            }
            try
            {
                using (MfTrace.Call("IMFAttributes.Set x9 (input type)", inType))
                {
                    MediaFactory.MFSetAttributeSize(inType, MediaTypeAttributeKeys.FrameSize, (uint)Width, (uint)Height).CheckError();
                    MediaFactory.MFSetAttributeRatio(inType, MediaTypeAttributeKeys.FrameRate, (uint)_fps, 1).CheckError();
                    MediaFactory.MFSetAttributeRatio(inType, MediaTypeAttributeKeys.PixelAspectRatio, 1, 1);
                    inType.Set(MediaTypeAttributeKeys.InterlaceMode, 2u);
                    inType.Set(MediaTypeAttributeKeys.VideoPrimaries, 2u);
                    inType.Set(MediaTypeAttributeKeys.TransferFunction, 5u);
                    inType.Set(MediaTypeAttributeKeys.YuvMatrix, 1u);
                    inType.Set(MediaTypeAttributeKeys.VideoNominalRange, opts.FullRange ? 1u : 2u);
                    if (!hardware) inType.Set(MediaTypeAttributeKeys.DefaultStride, (uint)Width);
                }
                using (MfTrace.Call("IMFTransform.SetInputType", _mft)) _mft.SetInputType(0, inType, 0);
            }
            finally
            {
                using (MfTrace.Call("IMFMediaType.Release(input)", inType)) inType.Dispose();
            }

            // Re-apply after type negotiation: some drivers reset properties when types are set.
            ApplyCodecSettings(opts, hardware, log: false);

            OutputStreamInfo info;
            using (MfTrace.Call("IMFTransform.GetOutputStreamInfo", _mft)) info = _mft.GetOutputStreamInfo(0);
            _providesSamples = (info.Flags & (int)OutputStreamInfoFlags.OutputStreamProvidesSamples) != 0;
            _outputBufferSize = Math.Max(info.Size, Width * Height * 3 / 2);
            if (MfTrace.Enabled) MfTrace.Note($"output stream flags 0x{info.Flags:X}, size {info.Size}: output samples {(_providesSamples ? "the encoder's" : "ours")}");

            using (MfTrace.Call("IMFTransform.ProcessMessage(CommandFlush)", _mft)) _mft.ProcessMessage(TMessageType.MessageCommandFlush, 0);
            using (MfTrace.Call("IMFTransform.ProcessMessage(NotifyBeginStreaming)", _mft)) _mft.ProcessMessage(TMessageType.MessageNotifyBeginStreaming, 0);
            using (MfTrace.Call("IMFTransform.ProcessMessage(NotifyStartOfStream)", _mft)) _mft.ProcessMessage(TMessageType.MessageNotifyStartOfStream, 0);

            if (IsAsync)
            {
                using (MfTrace.Call("QueryInterface(IMFMediaEventGenerator)", _mft)) _events = _mft.QueryInterface<IMFMediaEventGenerator>();
                _eventThread = new Thread(EventLoop) { IsBackground = true, Name = "mft-events", Priority = ThreadPriority.AboveNormal };
                _eventThread.Start();
            }

            Log.Info("encoder", $"using '{Name}' ({(hardware ? "hardware" : "software")}, {(IsAsync ? "async" : "sync")}) {Width}x{Height}@{_fps} {opts.BitrateKbps} kbps, " +
                $"frames up to {VbvBits(opts.BitrateKbps) / 8 / 1024} KB{(hardware ? $", quality {QualityVsSpeed}" : "")}, output flags 0x{info.Flags:X}");
        }
        catch
        {
            using (MfTrace.Call("ICodecAPI.Release (failed)")) _codec?.Dispose();
            using (MfTrace.Call("IMFMediaEventGenerator.Release (failed)", _events)) _events?.Dispose();
            using (MfTrace.Call("IMFTransform.Release (failed)", _mft)) _mft.Dispose();
            throw;
        }
        finally
        {
            // GetAttributes hands over a reference of its own.
            if (attrs != null) using (MfTrace.Call("IMFAttributes.Release", attrs)) attrs.Dispose();
        }
    }

    private void ApplyCodecSettings(EncoderOptions opts, bool hardware, bool log)
    {
        if (_codec == null) return;
        void Set(string what, int hr) { if (log) TrySet(what, hr); }
        Set("LowLatencyMode", _codec.SetBool(CodecApi.AVLowLatencyMode, true));
        Set("RateControl=CBR", _codec.SetUInt32(CodecApi.AVEncCommonRateControlMode, CodecApi.RateControlCbr));
        Set("MeanBitRate", _codec.SetUInt32(CodecApi.AVEncCommonMeanBitRate, (uint)(opts.BitrateKbps * 1000)));
        Set("BufferSize", _codec.SetUInt32(CodecApi.AVEncCommonBufferSize, VbvBits(opts.BitrateKbps)));
        Set("BFrames=0", _codec.SetUInt32(CodecApi.AVEncMPVDefaultBPictureCount, 0));
        // Keyframes only on demand (viewer join, decoder error, resolution change): IDRs are 10-20x
        // larger than P-frames and every periodic one is a latency spike on a constrained link.
        Set("GOP", _codec.SetUInt32(CodecApi.AVEncMPVGOPSize, GopSize));
        Set("CABAC", _codec.SetBool(CodecApi.AVEncH264CABACEnable, true));
        Set("QualityVsSpeed", _codec.SetUInt32(CodecApi.AVEncCommonQualityVsSpeed, hardware ? QualityVsSpeed : 0u));
        if (!hardware) Set("Threads", _codec.SetUInt32(CodecApi.AVEncNumWorkerThreads, (uint)Math.Clamp(Environment.ProcessorCount / 2, 2, 8)));
    }

    // Measured on RTX 3070 @1080p: QVS 0 = 2.0 ms, 40 = 3.4 ms, 60+ = 5 ms per frame with ~3% smaller frames.
    // 40 is the knee at 60 fps; frames above 1440p use 20 so 4K stays well under a 60 Hz frame budget. At 30 fps or
    // less (15 is the default) a frame has 33+ ms, so it takes the sharper setting.
    private static readonly uint? QualityVsSpeedOverride = uint.TryParse(Environment.GetEnvironmentVariable("HEADROOM_QVS"), out var q) ? q : null;
    private uint QualityVsSpeed => QualityVsSpeedOverride ?? (_fps <= 30 ? 60u : Width * Height > 2560 * 1440 ? 20u : 40u);
    private static readonly uint GopSize = uint.TryParse(Environment.GetEnvironmentVariable("HEADROOM_GOP"), out var g) ? g : 0xFFFF;

    // How big one frame may get. A screen that changes all at once (a new page, a jump down one) needs many times
    // an average frame to come out readable; 3 frames' worth (as it was) left it smudged for seconds. Half a
    // second's worth (HEADROOM_VBV_MS), and never under 3 frames.
    private static readonly int VbvMs = int.TryParse(Environment.GetEnvironmentVariable("HEADROOM_VBV_MS"), out var vbv) && vbv > 0 ? vbv : 500;
    private uint VbvBits(int kbps) => (uint)Math.Min(uint.MaxValue, Math.Max(Math.Max(kbps * (long)VbvMs, kbps * 1000L * 3 / _fps), 400_000));

    private void TrySet(string what, int hr)
    {
        if (hr != 0) Log.Debug("encoder", $"{Name}: {what} not applied (0x{hr:X8})");
    }

    /// <summary>
    /// Submit an NV12 texture. Returns false (frame not taken) when the encoder isn't ready for input
    /// within <paramref name="waitMs"/> — the caller simply skips that frame.
    /// </summary>
    public bool EncodeTexture(ID3D11Texture2D nv12, long timeHns, bool forceKeyFrame, int waitMs = 20)
    {
        if (_disposed) return false;
        if (IsAsync && !_needInput.Wait(waitMs)) return false;
        IMFMediaBuffer buffer;
        using (MfTrace.Call("MFCreateDXGISurfaceBuffer", nv12)) buffer = MediaFactory.MFCreateDXGISurfaceBuffer(typeof(ID3D11Texture2D).GUID, nv12, 0, false);
        try
        {
            try { using (MfTrace.Call("IMFMediaBuffer.SetCurrentLength", buffer)) buffer.CurrentLength = buffer.MaxLength; } catch { }
            return Submit(buffer, timeHns, forceKeyFrame);
        }
        finally
        {
            using (MfTrace.Call("IMFMediaBuffer.Release(input)", buffer)) buffer.Dispose();
        }
    }

    /// <summary>Submit NV12 bytes (software encoder path).</summary>
    public bool EncodeBytes(ReadOnlySpan<byte> nv12, long timeHns, bool forceKeyFrame)
    {
        if (_disposed) return false;
        if (IsAsync && !_needInput.Wait(20)) return false;
        IMFMediaBuffer buffer;
        using (MfTrace.Call("MFCreateMemoryBuffer(input)")) buffer = MediaFactory.MFCreateMemoryBuffer(nv12.Length);
        try
        {
            nint ptr;
            using (MfTrace.Call("IMFMediaBuffer.Lock", buffer)) buffer.Lock(out ptr, out _, out _);
            try { nv12.CopyTo(new Span<byte>((void*)ptr, nv12.Length)); }
            finally { using (MfTrace.Call("IMFMediaBuffer.Unlock", buffer)) buffer.Unlock(); }
            using (MfTrace.Call("IMFMediaBuffer.SetCurrentLength", buffer)) buffer.CurrentLength = nv12.Length;
            return Submit(buffer, timeHns, forceKeyFrame);
        }
        finally
        {
            using (MfTrace.Call("IMFMediaBuffer.Release(input)", buffer)) buffer.Dispose();
        }
    }

    private bool Submit(IMFMediaBuffer buffer, long timeHns, bool forceKeyFrame)
    {
        IMFSample sample;
        using (MfTrace.Call("MFCreateSample(input)")) sample = MediaFactory.MFCreateSample();
        try
        {
            using (MfTrace.Call("IMFSample.AddBuffer + SetSampleTime + SetSampleDuration", sample))
            {
                sample.AddBuffer(buffer);
                sample.SampleTime = timeHns;
                sample.SampleDuration = _frameDuration;
            }
            lock (_mftGate)
            {
                if (forceKeyFrame) _codec?.SetUInt32(CodecApi.AVEncVideoForceKeyFrame, 1);
                lock (_pending) _pending.Enqueue((timeHns, System.Diagnostics.Stopwatch.GetTimestamp()));
                try
                {
                    if (TraceEvents) Log.Debug("encoder", $"t={System.Diagnostics.Stopwatch.GetTimestamp() / (System.Diagnostics.Stopwatch.Frequency / 1000)} ProcessInput time={timeHns}");
                    using (MfTrace.Call("IMFTransform.ProcessInput", sample)) _mft.ProcessInput(0, sample, 0);
                }
                catch (SharpGenException ex) when (ex.ResultCode.Code == MF_E_NOTACCEPTING && !IsAsync)
                {
                    DrainSync();
                    using (MfTrace.Call("IMFTransform.ProcessInput (again)", sample)) _mft.ProcessInput(0, sample, 0);
                }
                Interlocked.Increment(ref _inFlight);
                if (!IsAsync) DrainSync();
            }
            return true;
        }
        finally
        {
            using (MfTrace.Call("IMFSample.Release(input)", sample)) sample.Dispose();
        }
    }

    public void SetBitrate(int kbps)
    {
        if (_codec == null || kbps == _bitrateKbps) return;
        lock (_mftGate)
        {
            _bitrateKbps = kbps;
            _codec.SetUInt32(CodecApi.AVEncCommonMeanBitRate, (uint)(kbps * 1000));
            _codec.SetUInt32(CodecApi.AVEncCommonBufferSize, VbvBits(kbps));
        }
    }

    private void EventLoop()
    {
        while (!_disposed)
        {
            IMFMediaEvent ev;
            try
            {
                using (MfTrace.Call("IMFMediaEventGenerator.GetEvent", _events)) ev = _events!.GetEvent(0);
            }
            catch (SharpGenException ex)
            {
                if (ex.ResultCode.Code != MF_E_SHUTDOWN && !_disposed) Log.Warn("encoder", $"GetEvent failed: 0x{ex.ResultCode.Code:X8}");
                if (MfTrace.Enabled) MfTrace.Note($"GetEvent: 0x{ex.ResultCode.Code:X8}, the event thread leaves");
                break;
            }
            try
            {
                MediaEventTypes type;
                using (MfTrace.Call("IMFMediaEvent.GetType", ev)) type = ev.EventType;
                if (MfTrace.Enabled) MfTrace.Note($"event {type}");
                switch (type)
                {
                    case MediaEventTypes.TransformNeedInput:
                        if (TraceEvents) Log.Debug("encoder", $"t={System.Diagnostics.Stopwatch.GetTimestamp() / (System.Diagnostics.Stopwatch.Frequency / 1000)} NeedInput");
                        _needInput.Release();
                        break;
                    case MediaEventTypes.TransformHaveOutput:
                        if (TraceEvents) Log.Debug("encoder", $"t={System.Diagnostics.Stopwatch.GetTimestamp() / (System.Diagnostics.Stopwatch.Frequency / 1000)} HaveOutput");
                        // Never once Dispose has begun to shut it down: that's under this same lock.
                        lock (_mftGate)
                        {
                            if (!_disposed) PullOutput();
                        }
                        break;
                    case MediaEventTypes.TransformDrainComplete:
                        _drained.Set();
                        break;
                    default:
                        Log.Debug("encoder", $"MFT event {type}");
                        break;
                }
            }
            finally
            {
                using (MfTrace.Call("IMFMediaEvent.Release", ev)) ev.Dispose();
            }
        }
    }

    private void DrainSync()
    {
        while (PullOutput()) { }
    }

    /// <summary>Retrieves one output sample. Returns false when the MFT needs more input.</summary>
    private bool PullOutput()
    {
        IMFSample? allocated = null;
        IMFMediaBuffer? allocatedBuffer = null;
        if (!_providesSamples)
        {
            using (MfTrace.Call("MFCreateSample + MFCreateMemoryBuffer + IMFSample.AddBuffer (output)"))
            {
                allocated = MediaFactory.MFCreateSample();
                allocatedBuffer = MediaFactory.MFCreateMemoryBuffer(_outputBufferSize);
                allocated.AddBuffer(allocatedBuffer);
            }
        }
        var odb = new OutputDataBuffer { StreamID = 0, Sample = allocated! };
        try
        {
            SharpGen.Runtime.Result hr;
            using (MfTrace.Call("IMFTransform.ProcessOutput", allocated)) hr = _mft.ProcessOutput(0, 1, ref odb, out _);
            if (MfTrace.Enabled) MfTrace.Note($"ProcessOutput 0x{hr.Code:X8}, sample {odb.Sample?.NativePointer ?? 0:X}, events {odb.Events?.NativePointer ?? 0:X}");
            if (hr.Code == MF_E_TRANSFORM_NEED_MORE_INPUT) return false;
            if (hr.Code == MF_E_TRANSFORM_STREAM_CHANGE)
            {
                // Output type renegotiation: accept what the encoder now proposes.
                IMFMediaType t;
                using (MfTrace.Call("IMFTransform.GetOutputAvailableType", _mft)) t = _mft.GetOutputAvailableType(0, 0);
                try { using (MfTrace.Call("IMFTransform.SetOutputType (stream change)", _mft)) _mft.SetOutputType(0, t, 0); }
                finally { using (MfTrace.Call("IMFMediaType.Release", t)) t.Dispose(); }
                return true;
            }
            if (hr.Failure)
            {
                Log.Warn("encoder", $"ProcessOutput failed 0x{hr.Code:X8}");
                return false;
            }
            var sample = odb.Sample;
            if (sample == null) return true;
            // The sample comes back in a new wrapper that holds no reference of its own when it's the one we passed in:
            // only one the MFT made is released here. (Telling them apart by wrapper released ours twice, here and below.)
            bool ours = allocated != null && sample.NativePointer == allocated.NativePointer;
            try
            {
                bool key = false;
                try { using (MfTrace.Call("IMFSample.GetUINT32(CleanPoint)", sample)) key = sample.GetUInt32(MFSampleExtension_CleanPoint) != 0; } catch { }
                byte[] data;
                long time;
                IMFMediaBuffer buf;
                using (MfTrace.Call("IMFSample.ConvertToContiguousBuffer", sample)) buf = sample.ConvertToContiguousBuffer();
                try
                {
                    nint ptr;
                    int len;
                    using (MfTrace.Call("IMFMediaBuffer.Lock", buf)) buf.Lock(out ptr, out _, out len);
                    try { data = new ReadOnlySpan<byte>((void*)ptr, len).ToArray(); }
                    finally { using (MfTrace.Call("IMFMediaBuffer.Unlock", buf)) buf.Unlock(); }
                    using (MfTrace.Call("IMFSample.GetSampleTime", sample)) time = sample.SampleTime;
                }
                finally
                {
                    using (MfTrace.Call("IMFMediaBuffer.Release(output)", buf)) buf.Dispose();
                }

                if (TraceEvents) Log.Debug("encoder", $"output time={time} key={key} bytes={data.Length}");
                double encMs = 0;
                lock (_pending)
                {
                    while (_pending.Count > 0)
                    {
                        var p = _pending.Dequeue();
                        if (p.Time >= time)
                        {
                            encMs = System.Diagnostics.Stopwatch.GetElapsedTime(p.SubmitTicks).TotalMilliseconds;
                            break;
                        }
                    }
                }
                Interlocked.Decrement(ref _inFlight);
                // What comes out while it's being stopped (drained) is dropped, as a flush dropped it before.
                if (!_stopping) _onOutput(new EncodedPacket(data, key, time, encMs));
            }
            finally
            {
                if (!ours) using (MfTrace.Call("IMFSample.Release(output)", sample)) sample.Dispose();
            }
            return true;
        }
        finally
        {
            if (odb.Events != null) using (MfTrace.Call("IMFCollection.Release(events)", odb.Events)) odb.Events.Dispose();
            if (allocatedBuffer != null) using (MfTrace.Call("IMFMediaBuffer.Release(ours)", allocatedBuffer)) allocatedBuffer.Dispose();
            if (allocated != null) using (MfTrace.Call("IMFSample.Release(ours)", allocated)) allocated.Dispose();
        }
    }

    /// <summary>
    /// Stops the encoder, then lets go of it, in this order:
    /// 1. An async MFT first finishes the frames it was given: it's drained, and its event thread pulls out (and drops)
    ///    what it still makes, until the MFT says it's done (or DrainTimeoutMs), so nothing is mid-encode when it's shut
    ///    down and freed. Stopped with frames still in flight, NVIDIA's crashed this process (an access violation in
    ///    ntdll) at the end of a session and every few rounds of the teardown test; drained, it ran 120 teardowns clean.
    /// 2. Under _mftGate, which the event thread holds while it pulls output: the stream is ended and the MFT shut down,
    ///    so the thread is never inside ProcessOutput meanwhile; it leaves on MF_E_SHUTDOWN.
    /// 3. The native objects are released only after that thread has left. If it doesn't leave in time, they're kept
    ///    (a leak) rather than freed under it.
    /// </summary>
    public void Dispose()
    {
        lock (_mftGate)
        {
            if (_stopping) return;
            _stopping = true;
        }
        if (MfTrace.Enabled) MfTrace.Note($"stopping '{Name}' with {InFlight} frame(s) in flight");
        bool endOfStream = false;
        if (IsAsync && _eventThread != null)
        {
            bool draining = false;
            lock (_mftGate)
            {
                try
                {
                    using (MfTrace.Call("IMFTransform.ProcessMessage(NotifyEndOfStream)", _mft)) _mft.ProcessMessage(TMessageType.MessageNotifyEndOfStream, 0);
                    endOfStream = true;
                    using (MfTrace.Call("IMFTransform.ProcessMessage(CommandDrain)", _mft)) _mft.ProcessMessage(TMessageType.MessageCommandDrain, 0);
                    draining = true;
                }
                catch (Exception ex)
                {
                    Log.Debug("encoder", $"{Name}: couldn't drain ({ex.Message})");
                }
            }
            if (draining)
            {
                bool drained;
                using (MfTrace.Call("wait for TransformDrainComplete")) drained = _drained.Wait(DrainTimeoutMs);
                if (!drained) Log.Debug("encoder", $"{Name}: still not drained after {DrainTimeoutMs} ms; stopping it anyway");
            }
        }
        lock (_mftGate)
        {
            _disposed = true;
            try
            {
                if (!endOfStream) using (MfTrace.Call("IMFTransform.ProcessMessage(NotifyEndOfStream)", _mft)) _mft.ProcessMessage(TMessageType.MessageNotifyEndOfStream, 0);
                using (MfTrace.Call("IMFTransform.ProcessMessage(CommandFlush)", _mft)) _mft.ProcessMessage(TMessageType.MessageCommandFlush, 0);
                using (MfTrace.Call("IMFTransform.ProcessMessage(NotifyEndStreaming)", _mft)) _mft.ProcessMessage(TMessageType.MessageNotifyEndStreaming, 0);
            }
            catch { }
            try { using (MfTrace.Call("IMFActivate.ShutdownObject", _activate)) _activate?.ShutdownObject(); } catch { }
        }
        _needInput.Release(64);
        if (_eventThread != null)
        {
            bool left;
            using (MfTrace.Call("join mft-events")) left = _eventThread.Join(5000);
            if (!left)
            {
                Log.Warn("encoder", $"{Name}: its event thread didn't stop; keeping the encoder's objects rather than freeing them under it");
                return;
            }
        }
        using (MfTrace.Call("ICodecAPI.Release")) _codec?.Dispose();
        using (MfTrace.Call("IMFMediaEventGenerator.Release", _events)) _events?.Dispose();
        using (MfTrace.Call("IMFTransform.Release", _mft)) _mft.Dispose();
        using (MfTrace.Call("IMFActivate.Release", _activate)) _activate?.Dispose();
        _needInput.Dispose();
        _drained.Dispose();
        if (MfTrace.Enabled) MfTrace.Note($"stopped '{Name}'");
    }
}
