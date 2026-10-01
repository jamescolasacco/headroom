using System.Diagnostics;
using System.Runtime.InteropServices;
using Concentus;
using Concentus.Enums;
using Headroom.Host.Config;
using Headroom.Host.Util;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Headroom.Host.Services;

/// <summary>
/// System audio ("what you hear") via WASAPI loopback -> Opus (10 ms, CELT low-delay) -> subscribers.
/// One capture shared by all viewers; started on first subscriber, stopped after the last leaves.
/// WASAPI delivers nothing while no app is playing, so silence simply produces no packets and the
/// client's jitter buffer resets on the gap.
/// </summary>
public sealed class AudioService
{
    public static AudioService Instance { get; } = new();

    public readonly record struct Packet(uint Sequence, long TimeUs, byte[] Data);

    private const int SampleRate = 48000;
    private const int Channels = 2;
    private const int FrameSamples = 480; // 10 ms per channel

    private readonly object _gate = new();
    private readonly List<Action<Packet>> _subscribers = new();
    private WasapiRecorder? _recorder;
    private IOpusEncoder? _encoder;
    private readonly float[] _pending = new float[FrameSamples * Channels * 8];
    private int _pendingCount;
    private readonly byte[] _opusOut = new byte[1500];
    private uint _seq;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private Timer? _watchdog;
    private string? _deviceId;
    private bool _restartPending;

    public void Subscribe(Action<Packet> handler)
    {
        lock (_gate)
        {
            _subscribers.Add(handler);
            if (_subscribers.Count == 1) StartLocked();
        }
    }

    public void Unsubscribe(Action<Packet> handler)
    {
        lock (_gate)
        {
            _subscribers.Remove(handler);
            if (_subscribers.Count == 0) StopLocked();
        }
    }

    private void StartLocked()
    {
        try
        {
            _encoder = OpusCodecFactory.CreateEncoder(SampleRate, Channels, OpusApplication.OPUS_APPLICATION_RESTRICTED_LOWDELAY);
            _encoder.Bitrate = Math.Clamp(ConfigStore.Current.Audio.BitrateKbps, 32, 256) * 1000;
            _encoder.Complexity = 6;
            _encoder.UseVBR = true;
            _encoder.SignalType = OpusSignal.OPUS_SIGNAL_MUSIC;

            _recorder = new WasapiRecorderBuilder()
                .WithLoopbackCapture()
                .WithFormat(WaveFormat.CreateIeeeFloatWaveFormat(SampleRate, Channels))
                .WithBufferLength(20)
                .WithMmcssThreadPriority("Pro Audio")
                .Build();
            _recorder.DataAvailable += OnData;
            _recorder.RecordingStopped += OnStopped;
            _deviceId = _recorder.DeviceId;
            _recorder.StartRecording();
            _pendingCount = 0;
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
        if (_recorder != null)
        {
            _recorder.DataAvailable -= OnData;
            _recorder.RecordingStopped -= OnStopped;
            try { _recorder.StopRecording(); } catch { }
            try { _recorder.Dispose(); } catch { }
            _recorder = null;
            Log.Info("audio", "loopback capture stopped");
        }
        _encoder?.Dispose();
        _encoder = null;
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
                    if (_subscribers.Count == 0) return;
                    _restartPending = false;
                    Log.Info("audio", "default output device changed; restarting capture");
                    StopLocked();
                    StartLocked();
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
        var enc = _encoder;
        if (enc == null) return;
        var samples = MemoryMarshal.Cast<byte, float>(buffer);
        bool silent = (flags & AudioClientBufferFlags.Silent) != 0;
        int i = 0;
        while (i < samples.Length)
        {
            int take = Math.Min(samples.Length - i, FrameSamples * Channels - _pendingCount);
            if (silent) _pending.AsSpan(_pendingCount, take).Clear();
            else samples.Slice(i, take).CopyTo(_pending.AsSpan(_pendingCount));
            _pendingCount += take;
            i += take;
            if (_pendingCount == FrameSamples * Channels)
            {
                _pendingCount = 0;
                int n;
                try { n = enc.Encode(_pending.AsSpan(0, FrameSamples * Channels), FrameSamples, _opusOut, _opusOut.Length); }
                catch (Exception ex) { Log.Debug("audio", $"opus encode failed: {ex.Message}"); continue; }
                if (n <= 0) continue;
                var packet = new Packet(++_seq, _clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency, _opusOut.AsSpan(0, n).ToArray());
                Action<Packet>[] subs;
                lock (_gate) subs = _subscribers.ToArray();
                foreach (var s in subs) s(packet);
            }
        }
    }
}
