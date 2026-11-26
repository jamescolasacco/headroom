using System.Diagnostics;
using System.Runtime.InteropServices;
using Concentus;
using Concentus.Enums;
using Headroom.Host.Config;
using Headroom.Host.Session;
using Headroom.Host.Util;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Headroom.Host.Services;

/// <summary>
/// System audio ("what you hear") via WASAPI loopback, cut into 10 ms frames and sent to each viewer the way it asked
/// (<see cref="Format"/>): Opus (CELT low-delay) or lossless 24-bit PCM. One capture shared by all viewers; started on
/// the first subscriber, stopped after the last leaves.
/// WASAPI delivers nothing while no app is playing. Without audio priority that simply produces no packets (the client's
/// jitter buffer resets on the gap). A viewer with audio priority gets digital silence on the clock instead
/// (<see cref="AudioFramer"/>), so its timeline never has holes.
/// </summary>
public sealed class AudioService
{
    public static AudioService Instance { get; } = new();

    /// <summary>
    /// One 10 ms frame for one viewer. Sequence: +1 per frame, the same number for every viewer. Timestamp: when the
    /// frame's first sample was captured, a <see cref="Stopwatch.GetTimestamp"/> value.
    /// </summary>
    public readonly record struct Packet(uint Sequence, long Timestamp, Wire.AudioCodec Codec, byte[] Data);

    /// <summary>
    /// What one viewer gets. Pcm: 24-bit PCM, else Opus. Priority: every frame, digital silence as codec 2 (on the clock
    /// even while the device is quiet), Opus at Kbps; without priority, Opus at this PC's setting.
    /// </summary>
    public readonly record struct Format(bool Pcm, bool Priority, int Kbps);

    public const int SampleRate = 48000;
    public const int Channels = 2;
    public const int FrameSamples = 480; // 10 ms per channel

    /// <summary>Lossless: 48000 × 2 × 24 bits.</summary>
    public const int PcmKbps = 2304;

    /// <summary>
    /// Opus with audio priority: from the top (the most Opus carries in stereo) down, one step at a time while the
    /// connection can't carry it (as the Mac host, whose top is AudioToolbox's 512).
    /// </summary>
    public static readonly int[] PriorityOpusKbps = { 510, 256, 128, 64 };

    /// <summary>Opus without priority: this PC's setting, as always.</summary>
    public static int NormalOpusKbps => Math.Clamp(ConfigStore.Current.Audio.BitrateKbps, 32, 256);

    /// <summary>
    /// Tests only: `headroom run --test-audio=music` sends the deterministic signal of <see cref="TestMusic"/> instead of
    /// this PC's sound. A flag rather than an environment variable, because Headroom Server starts its engine as
    /// `headroom run` too and would inherit a variable left set; neither it nor the service (`agent`) passes this flag.
    /// </summary>
    public static bool TestMusicMode { get; } = IsTestMusic(Environment.GetCommandLineArgs());

    /// <summary>The command line (program first) of a foreground `run` with --test-audio=music.</summary>
    public static bool IsTestMusic(string[] commandLine)
    {
        // As Program.Main reads it: --data= and --webroot= go anywhere, then the command (default `run`).
        var args = commandLine.Skip(1)
            .Where(a => !a.StartsWith("--data=", StringComparison.OrdinalIgnoreCase) && !a.StartsWith("--webroot=", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        var command = args.Length > 0 && !args[0].StartsWith('-') ? args[0].ToLowerInvariant() : "run";
        return command == "run" && args.Any(a => a.Equals("--test-audio=music", StringComparison.OrdinalIgnoreCase));
    }

    private readonly object _gate = new();      // viewers, starting and stopping
    private readonly object _frameGate = new(); // the frames (capture thread, clock, test music); never waits for _gate
    private readonly AudioPacketizer _packets = new();
    private readonly AudioFramer _framer;
    private WasapiRecorder? _recorder;
    private bool _capturing;                    // under _frameGate: frames are wanted
    private Timer? _watchdog;
    private Timer? _clock;                      // a viewer with priority listens: silence while the device is quiet
    private string? _deviceId;
    private volatile bool _restartPending;
    // Test music (under _frameGate, its timer under _gate).
    private Timer? _musicTimer;
    private TestMusic? _music;
    private long _musicStart;
    private long _musicFrames;
    private readonly float[] _musicBuffer = new float[4800 * Channels];

    private AudioService() => _framer = new AudioFramer(_packets.Process);

    public void Subscribe(Action<Packet> handler, Format format)
    {
        lock (_gate)
        {
            bool added;
            lock (_frameGate) added = _packets.Add(handler, format);
            if (added && _packets.Count == 1) StartLocked();
            SyncClockLocked();
        }
    }

    /// <summary>A viewer's sound changed: PCM or Opus, priority, or its Opus rate (a bandwidth step).</summary>
    public void Update(Action<Packet> handler, Format format)
    {
        lock (_gate)
        {
            lock (_frameGate) _packets.Update(handler, format);
            SyncClockLocked();
        }
    }

    public void Unsubscribe(Action<Packet> handler)
    {
        lock (_gate)
        {
            lock (_frameGate) _packets.Remove(handler);
            if (_packets.Count == 0) StopLocked();
            else SyncClockLocked();
        }
    }

    private void StartLocked()
    {
        if (TestMusicMode)
        {
            StartMusicLocked();
            return;
        }
        try
        {
            _recorder = new WasapiRecorderBuilder()
                .WithLoopbackCapture()
                .WithFormat(WaveFormat.CreateIeeeFloatWaveFormat(SampleRate, Channels))
                .WithBufferLength(20)
                .WithMmcssThreadPriority("Pro Audio")
                .Build();
            _recorder.DataAvailable += OnData;
            _recorder.RecordingStopped += OnStopped;
            _deviceId = _recorder.DeviceId;
            lock (_frameGate)
            {
                _framer.Reset();
                _capturing = true;
            }
            _recorder.StartRecording();
            Log.Info("audio", $"loopback capture started on '{_recorder.DeviceFriendlyName}' ({_recorder.WaveFormat})");
            // Follow default-device changes (headphones plugged in, etc.).
            _watchdog ??= new Timer(_ => CheckDevice(), null, 2000, 2000);
        }
        catch (Exception ex)
        {
            Log.Warn("audio", $"audio capture unavailable: {ex.Message}");
            StopLocked();
        }
    }

    private void StopLocked()
    {
        _watchdog?.Dispose();
        _watchdog = null;
        _clock?.Dispose();
        _clock = null;
        _musicTimer?.Dispose();
        _musicTimer = null;
        lock (_frameGate) _capturing = false;
        if (_recorder != null)
        {
            _recorder.DataAvailable -= OnData;
            _recorder.RecordingStopped -= OnStopped;
            try { _recorder.StopRecording(); } catch { }
            // Joins the capture thread: never hold _frameGate here (OnData may be waiting for it).
            try { _recorder.Dispose(); } catch { }
            _recorder = null;
            Log.Info("audio", "loopback capture stopped");
        }
        lock (_frameGate)
        {
            if (_music != null) Log.Info("audio", "test music stopped");
            _music = null;
            _framer.Reset();
            _framer.Continuous = false;
            _packets.ReleaseEncoders(); // Opus only while someone wants it
        }
    }

    /// <summary>Silence on the clock only while the capture runs and a viewer with priority listens.</summary>
    private void SyncClockLocked()
    {
        bool want = _recorder != null && _packets.AnyPriority;
        lock (_frameGate) _framer.Continuous = want;
        if (want) _clock ??= new Timer(_ => OnClock(), null, 10, 10);
        else if (_clock != null)
        {
            _clock.Dispose();
            _clock = null;
        }
    }

    private void OnClock()
    {
        try
        {
            lock (_frameGate)
            {
                if (_capturing && _framer.Continuous) _framer.Fill(Stopwatch.GetTimestamp());
            }
        }
        catch (Exception ex)
        {
            Log.Debug("audio", $"audio clock failed: {ex.Message}"); // a timer callback must never throw
        }
    }

    private void CheckDevice()
    {
        try
        {
            using var en = new MMDeviceEnumerator();
            using var dev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            if (dev.ID != _deviceId || _restartPending)
            {
                lock (_gate)
                {
                    if (_packets.Count == 0) return;
                    _restartPending = false;
                    Log.Info("audio", "default output device changed; restarting capture");
                    StopLocked();
                    StartLocked();
                    SyncClockLocked();
                }
            }
        }
        catch { }
    }

    private void OnStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception != null)
        {
            Log.Warn("audio", $"capture stopped: {e.Exception.Message}");
            _restartPending = true;
        }
    }

    private void OnData(ReadOnlySpan<byte> buffer, AudioClientBufferFlags flags, long devicePosition, long qpcPosition)
    {
        long now = Stopwatch.GetTimestamp();
        var samples = MemoryMarshal.Cast<byte, float>(buffer);
        int frames = samples.Length / Channels;
        if (frames == 0) return;
        bool timed = (flags & AudioClientBufferFlags.TimestampError) == 0;
        long start = CaptureTicks(qpcPosition, timed, frames, now, Stopwatch.Frequency);
        try
        {
            lock (_frameGate)
            {
                if (!_capturing) return;
                _framer.Push(samples.Slice(0, frames * Channels), (flags & AudioClientBufferFlags.Silent) != 0, start,
                    timed ? devicePosition : -1, (flags & AudioClientBufferFlags.DataDiscontinuity) != 0);
            }
        }
        catch (Exception ex)
        {
            Log.Debug("audio", $"audio frame failed: {ex.Message}");
        }
    }

    /// <summary>
    /// When a WASAPI packet's first frame was captured, as a <see cref="Stopwatch.GetTimestamp"/> value: the device's own
    /// performance-counter time (IAudioCaptureClient::GetBuffer gives it in 100 ns units), or, when that's flagged
    /// invalid, missing or not within the last second, now less the packet's length.
    /// </summary>
    public static long CaptureTicks(long qpc100ns, bool valid, int frames, long now, long frequency)
    {
        if (valid && qpc100ns > 0)
        {
            long t = qpc100ns / 10_000_000 * frequency + qpc100ns % 10_000_000 * frequency / 10_000_000;
            if (now - t >= 0 && now - t < frequency) return t;
        }
        return now - (long)frames * frequency / SampleRate;
    }

    // ------------------------------------------------------------------------------------------- test music

    private void StartMusicLocked()
    {
        lock (_frameGate)
        {
            _framer.Reset();
            _music = new TestMusic();
            _musicStart = Stopwatch.GetTimestamp();
            _musicFrames = 0;
            _capturing = true;
        }
        _musicTimer = new Timer(_ => OnMusic(), null, 10, 10);
        Log.Info("audio", "test music started (--test-audio=music): the deterministic signal instead of this PC's sound");
    }

    /// <summary>
    /// Exactly 48 kHz on the host clock on average: each tick makes the frames up to (now - start) × 48000, so timer
    /// jitter never changes the rate. Frame n is captured at start + n / 48000 s; packet k carries frames [480k, 480k+480).
    /// </summary>
    private void OnMusic()
    {
        try
        {
            lock (_frameGate)
            {
                if (!_capturing || _music == null) return;
                long f = Stopwatch.Frequency;
                long due = (Stopwatch.GetTimestamp() - _musicStart) * SampleRate / f - _musicFrames;
                while (due > 0)
                {
                    int n = (int)Math.Min(due, _musicBuffer.Length / Channels);
                    var chunk = _musicBuffer.AsSpan(0, n * Channels);
                    _music.Next(chunk);
                    _framer.Push(chunk, false, _musicStart + _musicFrames * f / SampleRate, _musicFrames, false);
                    _musicFrames += n;
                    due -= n;
                }
            }
        }
        catch (Exception ex)
        {
            Log.Debug("audio", $"test music failed: {ex.Message}"); // a timer callback must never throw
        }
    }
}

/// <summary>
/// The deterministic test signal of the audio-priority brief (HEADROOM_TEST_AUDIO=music on the Mac host): three
/// triangles and noise, 3 s of sound then 1 s of digital silence, in integer math so every implementation (Swift, JS,
/// this) agrees bit for bit. Every sample is q / 2^23 for a 24-bit q, exact in a float.
/// </summary>
public sealed class TestMusic
{
    private uint _p1, _p2, _p3;
    private uint _sL = 0x12345678, _sR = 0x9E3779B9;
    private long _n;

    /// <summary>The next frames, interleaved L R into <paramref name="stereo"/>.</summary>
    public void Next(Span<float> stereo)
    {
        for (int i = 0; i + 1 < stereo.Length; i += 2)
        {
            var (l, r) = NextQ();
            stereo[i] = l / 8388608f;
            stereo[i + 1] = r / 8388608f;
        }
    }

    /// <summary>The next frame as 24-bit values.</summary>
    public (int L, int R) NextQ()
    {
        int l = (Tri(_p1) >> 2) + (Tri(_p2) >> 3) + (Tri(_p3) >> 4) + Noise(_sL);
        int r = (Tri(_p1 + (1u << 30)) >> 2) + (Tri(_p2) >> 4) + (Tri(_p3 + (1u << 31)) >> 3) + Noise(_sR);
        if (_n % 192000 >= 144000) l = r = 0;
        _p1 += 19685267u;
        _p2 += 157482134u;
        _p3 += 629928537u;
        _sL = _sL * 1664525u + 1013904223u;
        _sR = _sR * 1664525u + 1013904223u;
        _n++;
        return (l, r);
    }

    /// <summary>[-2^22, 2^22)</summary>
    private static int Tri(uint p)
    {
        uint v = p >> 8;
        uint t = v < (1u << 23) ? v : (1u << 24) - 1 - v;
        return (int)t - (1 << 22);
    }

    /// <summary>±2^18</summary>
    private static int Noise(uint s) => (int)((s >> 8) - (1u << 23)) >> 5;
}

/// <summary>
/// Cuts captured sound into 10 ms frames (480 stereo samples). While <see cref="Continuous"/> (a viewer with audio
/// priority listens) it also keeps them on the host clock: WASAPI loopback delivers nothing while no app plays, so
/// <see cref="Fill"/> adds digital silence at the real rate, and when sound comes back after such a gap (or after the
/// device lost some), the gap is closed with silence so the captured samples land where they were captured. Only digital
/// silence is ever added or skipped, never captured sound. Not continuous, frames are simply the captured samples in
/// order, as before. Not thread-safe: the caller serializes every call. Times are <see cref="Stopwatch"/> ticks.
/// </summary>
public sealed class AudioFramer
{
    /// <summary>
    /// A whole frame (960 interleaved values, valid only during the call), whether any of it was captured (rather than
    /// only silence added on the clock), and when its first sample was captured.
    /// </summary>
    public delegate void FrameHandler(float[] frame, bool captured, long startTicks);

    private const int Rate = AudioService.SampleRate;
    private const int Values = AudioService.FrameSamples * AudioService.Channels;

    private readonly FrameHandler _onFrame;
    private readonly long _freq;
    /// <summary>Gaps between packets within this are timing noise, not missing sound.</summary>
    private readonly long _tolerance;
    /// <summary>
    /// The device delivers within this (WASAPI's 20 ms buffer and scheduling): no packet for longer after digital
    /// silence means it went quiet. Also how far behind the clock the silence added then runs.
    /// </summary>
    private readonly long _quietAfterSilence;
    /// <summary>After sound, only this much later, so a stalled capture thread never gets silence put into its sound.</summary>
    private readonly long _quietAfterSound;
    /// <summary>A longer gap (asleep, or nobody needed the clock) isn't filled: the timeline jumps.</summary>
    private readonly long _maxFill;

    private readonly float[] _frame = new float[Values];
    private int _count;              // values in _frame
    private long _frameStart;        // when _frame[0] was captured
    private bool _frameCaptured;     // _frame holds captured samples, not only added silence

    private bool _timeline;          // _next is known
    private long _next;              // when the sample after the last one framed was (or would have been) captured
    private long _nextPosition = -1; // the device's frame position expected next, -1 if unknown
    private long _shift;             // packets in order with the last go this much later than captured (see Push)
    private bool _quiet;             // the last packet was digital silence
    private bool _adding;            // adding silence on the clock: the device is quiet
    private long _addFrom;           // ... since then
    private long _added;             // ... this many samples (per channel)

    public AudioFramer(FrameHandler onFrame, long ticksPerSecond = 0)
    {
        _onFrame = onFrame;
        _freq = ticksPerSecond > 0 ? ticksPerSecond : Stopwatch.Frequency;
        _tolerance = _freq * 5 / 1000;
        _quietAfterSilence = _freq * 40 / 1000;
        _quietAfterSound = _freq / 5;
        _maxFill = _freq;
    }

    /// <summary>A viewer with priority listens: keep the frames on the clock.</summary>
    public bool Continuous { get; set; }

    /// <summary>
    /// Captured samples (interleaved stereo; zeros if <paramref name="silent"/>), the first captured at
    /// <paramref name="startTicks"/>. <paramref name="position"/>: the device's frame position of the first (-1 if
    /// unknown); <paramref name="discontinuity"/>: the device lost samples before these.
    /// </summary>
    public void Push(ReadOnlySpan<float> samples, bool silent, long startTicks, long position, bool discontinuity)
    {
        int frames = samples.Length / 2;
        if (frames == 0) return;
        bool quiet = silent || IsZero(samples);
        long nextPosition = position >= 0 ? position + frames : -1;
        // In order with the last packet: the device's position says so (its clock times jitter by a millisecond or so), or,
        // should its positions be no use, its clock time is where the last packet ended.
        bool inOrder = _timeline && !_adding && !discontinuity
            && (position < 0 || position == _nextPosition || Math.Abs(startTicks - _next) <= _tolerance);
        if (!Continuous) _shift = 0;
        if (inOrder) startTicks += _shift;
        else if (Continuous && _timeline)
        {
            _shift = 0;
            long gap = startTicks - _next;
            if (gap > _maxFill) Flush();
            else if (gap > _tolerance) AddSilence(TicksToFrames(gap), _next);
            else if (gap < -_tolerance)
            {
                // The clock's silence already covers the start of these: their leading digital silence is skipped (never
                // sound), and what's left goes on right after it, later than captured by the rest of the overlap.
                long overlap = Math.Min(frames, TicksToFrames(-gap));
                int skip = 0;
                while (skip < overlap && (silent || (samples[2 * skip] == 0f && samples[2 * skip + 1] == 0f))) skip++;
                samples = samples.Slice(2 * skip);
                frames -= skip;
                long at = startTicks + FramesToTicks(skip);
                if (at < _next)
                {
                    _shift = _next - at;
                    at = _next;
                }
                startTicks = at;
            }
        }
        if (frames > 0)
        {
            Append(samples, silent, frames, startTicks);
            _next = startTicks + FramesToTicks(frames);
        }
        _timeline = true;
        _adding = false;
        _nextPosition = nextPosition;
        _quiet = quiet;
    }

    /// <summary>The clock, every ~10 ms while <see cref="Continuous"/>: while the device is quiet, digital silence up to a little before <paramref name="now"/>.</summary>
    public void Fill(long now)
    {
        if (!Continuous) return;
        if (!_timeline)
        {
            _timeline = true;
            _next = now - _quietAfterSilence;
            _nextPosition = -1;
            _quiet = true;
        }
        if (!_adding)
        {
            if (now - _next <= (_quiet ? _quietAfterSilence : _quietAfterSound)) return; // the device may still deliver
            _adding = true;
            _addFrom = _next;
            _added = 0;
        }
        long target = now - _quietAfterSilence;
        if (target - _next > _maxFill)
        {
            Flush();
            _addFrom = _next = target;
            _added = 0;
            return;
        }
        long due = (target - _addFrom) * Rate / _freq - _added;
        if (due <= 0) return;
        AddSilence(due, _next);
        _added += due;
        _next = _addFrom + _added * _freq / Rate;
        if (_added >= Rate * 3600L)
        {
            // An hour of quiet: start counting again from here, so the arithmetic stays small.
            _addFrom = _next;
            _added = 0;
        }
    }

    /// <summary>Forgets everything (the capture stopped or starts again).</summary>
    public void Reset()
    {
        _count = 0;
        _frameCaptured = false;
        _timeline = false;
        _adding = false;
        _nextPosition = -1;
        _shift = 0;
        _quiet = false;
    }

    /// <summary>Completes the frame being built with silence and sends it.</summary>
    private void Flush()
    {
        if (_count > 0) AddSilence((Values - _count) / 2, _frameStart + FramesToTicks(_count / 2));
    }

    private void Append(ReadOnlySpan<float> samples, bool silent, int frames, long start)
    {
        int done = 0;
        while (done < frames)
        {
            if (_count == 0)
            {
                _frameStart = start + FramesToTicks(done);
                _frameCaptured = false;
            }
            int take = Math.Min(frames - done, (Values - _count) / 2);
            if (silent) Array.Clear(_frame, _count, take * 2);
            else samples.Slice(done * 2, take * 2).CopyTo(_frame.AsSpan(_count));
            _count += take * 2;
            _frameCaptured = true;
            done += take;
            if (_count == Values) Emit();
        }
    }

    private void AddSilence(long frames, long start)
    {
        long done = 0;
        while (done < frames)
        {
            if (_count == 0)
            {
                _frameStart = start + FramesToTicks(done);
                _frameCaptured = false;
            }
            int take = (int)Math.Min(frames - done, (Values - _count) / 2);
            Array.Clear(_frame, _count, take * 2);
            _count += take * 2;
            done += take;
            if (_count == Values) Emit();
        }
    }

    private void Emit()
    {
        _count = 0;
        _onFrame(_frame, _frameCaptured, _frameStart);
    }

    private long FramesToTicks(long frames) => frames * _freq / Rate;

    private long TicksToFrames(long ticks) => (ticks * Rate + _freq / 2) / _freq;

    private static bool IsZero(ReadOnlySpan<float> samples)
    {
        foreach (var v in samples)
            if (v != 0f) return false;
        return true;
    }
}

/// <summary>
/// Turns each 10 ms frame into what every viewer asked for (<see cref="AudioService.Format"/>), all under one sequence
/// number per frame. Opus exists only while someone wants it: one encoder shared by the viewers without priority (this
/// PC's bitrate, every captured frame, as before), and one per viewer with priority (its own rate, stepped down in place
/// so the sound doesn't break). Not thread-safe: the caller serializes every call.
/// </summary>
public sealed class AudioPacketizer
{
    private sealed class Viewer
    {
        public readonly Action<AudioService.Packet> Handler;
        public AudioService.Format Format;
        public IOpusEncoder? Encoder;   // with priority, Opus
        public int EncoderKbps;
        public bool Sounding;           // ... the encoder's last frame had sound, so the next silent one still goes through it
        public int SilentFrames;        // without priority, PCM: frames of digital silence in a row

        public Viewer(Action<AudioService.Packet> handler, AudioService.Format format)
        {
            Handler = handler;
            Format = format;
        }
    }

    private Viewer[] _viewers = Array.Empty<Viewer>();
    private IOpusEncoder? _shared;
    private uint _seq;
    private readonly byte[] _opusOut = new byte[1500];
    private readonly byte[] _scratch = new byte[Wire.PcmPayloadSize];
    private readonly float[] _last = new float[Wire.PcmFrames * 2]; // the frame before, to start an encoder mid-stream
    private bool _hasLast;

    public int Count => _viewers.Length;

    public bool AnyPriority => _viewers.Any(v => v.Format.Priority);

    /// <summary>False if it was there already (its format is updated then).</summary>
    public bool Add(Action<AudioService.Packet> handler, AudioService.Format format)
    {
        if (Find(handler) != null)
        {
            Update(handler, format);
            return false;
        }
        var all = new List<Viewer>(_viewers) { new Viewer(handler, format) };
        _viewers = all.ToArray();
        return true;
    }

    public void Update(Action<AudioService.Packet> handler, AudioService.Format format)
    {
        var v = Find(handler);
        if (v == null) return;
        v.Format = format;
        v.SilentFrames = 0;
        // Opus only while someone wants it; back to Opus later, a fresh encoder starts it cleanly.
        if (!format.Priority || format.Pcm) ReleaseEncoder(v);
        ReleaseSharedIfUnused();
    }

    public void Remove(Action<AudioService.Packet> handler)
    {
        var v = Find(handler);
        if (v == null) return;
        _viewers = _viewers.Where(x => x != v).ToArray();
        ReleaseEncoder(v);
        ReleaseSharedIfUnused();
    }

    /// <summary>The capture stopped: no encoders until someone needs one again.</summary>
    public void ReleaseEncoders()
    {
        foreach (var v in _viewers) ReleaseEncoder(v);
        Release(ref _shared);
        _hasLast = false;
    }

    /// <summary>One frame (<see cref="AudioFramer.FrameHandler"/>): a packet for every viewer that gets one.</summary>
    public void Process(float[] frame, bool captured, long startTicks)
    {
        uint seq = ++_seq;
        var viewers = _viewers;
        bool pcmWanted = false, priority = false;
        foreach (var v in viewers)
        {
            pcmWanted |= v.Format.Pcm;
            priority |= v.Format.Priority;
        }
        var samples = new ReadOnlySpan<float>(frame, 0, Wire.PcmFrames * 2);
        byte[] pcm = pcmWanted ? new byte[Wire.PcmPayloadSize] : _scratch;
        // Digital silence is judged on what PCM would carry: every sample 0 at 24 bits.
        bool zero = (pcmWanted || priority) && Wire.WritePcm24(samples, pcm);
        byte[]? shared = null;
        bool sharedDone = false;
        foreach (var v in viewers)
        {
            var f = v.Format;
            Wire.AudioCodec codec;
            byte[]? data;
            if (f.Priority)
            {
                if (zero && (f.Pcm || !v.Sounding))
                {
                    codec = Wire.AudioCodec.Silence;
                    data = Wire.SilencePayload();
                }
                else if (f.Pcm)
                {
                    codec = Wire.AudioCodec.Pcm24;
                    data = pcm;
                }
                else
                {
                    // Opus. The first silent frame after sound still goes through the encoder: its packet carries the end
                    // of the sound (the encoder's 2.5 ms look-ahead), and the viewer's decoder then rests on silence as the
                    // encoder does. Sent as silence instead, that end would be lost and play at the next sound (a click).
                    data = EncodeFor(v, samples);
                    v.Sounding = !zero && data != null;
                    codec = data != null ? Wire.AudioCodec.Opus : Wire.AudioCodec.Silence;
                    data ??= Wire.SilencePayload();
                }
            }
            else
            {
                if (!captured) continue; // silence added on the clock is only for viewers with priority
                if (f.Pcm)
                {
                    // Like the Mac host without priority: nothing after 200 ms of digital silence.
                    v.SilentFrames = zero ? v.SilentFrames + 1 : 0;
                    if (v.SilentFrames > 20) continue;
                    codec = Wire.AudioCodec.Pcm24;
                    data = pcm;
                }
                else
                {
                    if (!sharedDone)
                    {
                        shared = EncodeShared(samples);
                        sharedDone = true;
                    }
                    codec = Wire.AudioCodec.Opus;
                    data = shared;
                }
            }
            if (data == null) continue;
            try { v.Handler(new AudioService.Packet(seq, startTicks, codec, data)); }
            catch (Exception ex) { Log.Debug("audio", $"audio subscriber failed: {ex.Message}"); }
        }
        samples.CopyTo(_last);
        _hasLast = true;
    }

    private byte[]? EncodeShared(ReadOnlySpan<float> samples)
    {
        try
        {
            _shared ??= NewEncoder(AudioService.NormalOpusKbps);
            int n = _shared.Encode(samples, Wire.PcmFrames, _opusOut, _opusOut.Length);
            return n > 0 ? _opusOut.AsSpan(0, n).ToArray() : null;
        }
        catch (Exception ex)
        {
            Log.Debug("audio", $"opus encode failed: {ex.Message}");
            return null;
        }
    }

    private byte[]? EncodeFor(Viewer v, ReadOnlySpan<float> samples)
    {
        try
        {
            int kbps = Math.Clamp(v.Format.Kbps, 6, 510);
            if (v.Encoder == null)
            {
                v.Encoder = NewEncoder(kbps);
                v.EncoderKbps = kbps;
                // Starting mid-stream (from lossless, or a new viewer): the frame before goes in first, so the encoder's
                // look-ahead holds what really came before and its first packet carries on from it (as the Mac host).
                if (_hasLast) v.Encoder.Encode(_last, Wire.PcmFrames, _opusOut, _opusOut.Length);
            }
            else if (v.EncoderKbps != kbps)
            {
                v.Encoder.Bitrate = kbps * 1000; // a bandwidth step, in place: the sound carries on without a break
                v.EncoderKbps = kbps;
            }
            int n = v.Encoder.Encode(samples, Wire.PcmFrames, _opusOut, _opusOut.Length);
            return n > 0 ? _opusOut.AsSpan(0, n).ToArray() : null;
        }
        catch (Exception ex)
        {
            Log.Debug("audio", $"opus encode failed: {ex.Message}");
            return null;
        }
    }

    /// <summary>Opus as this host has always made it: CELT low-delay, VBR, tuned for music.</summary>
    private static IOpusEncoder NewEncoder(int kbps)
    {
        var e = OpusCodecFactory.CreateEncoder(AudioService.SampleRate, AudioService.Channels, OpusApplication.OPUS_APPLICATION_RESTRICTED_LOWDELAY);
        try
        {
            e.Bitrate = kbps * 1000;
            e.Complexity = 6;
            e.UseVBR = true;
            e.SignalType = OpusSignal.OPUS_SIGNAL_MUSIC;
            return e;
        }
        catch
        {
            e.Dispose();
            throw;
        }
    }

    private Viewer? Find(Action<AudioService.Packet> handler)
    {
        foreach (var v in _viewers)
            if (v.Handler == handler) return v;
        return null;
    }

    private void ReleaseSharedIfUnused()
    {
        foreach (var v in _viewers)
            if (!v.Format.Priority && !v.Format.Pcm) return;
        Release(ref _shared);
    }

    private static void ReleaseEncoder(Viewer v)
    {
        Release(ref v.Encoder);
        v.Sounding = false;
    }

    private static void Release(ref IOpusEncoder? encoder)
    {
        try { encoder?.Dispose(); } catch { }
        encoder = null;
    }
}
