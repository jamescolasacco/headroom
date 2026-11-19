using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Headroom.Host.Capture;
using Headroom.Host.Config;
using Headroom.Host.Input;
using Headroom.Host.Platform;
using Headroom.Host.Security;
using Headroom.Host.Services;
using Headroom.Host.Util;
using Headroom.Host.Video;

namespace Headroom.Host.Session;

/// <summary>
/// One connected viewer. Owns the WebSocket, its video pipeline, input context and subscriptions.
///
/// Transport: everything multiplexes over one WSS connection. The send loop is strictly prioritised
/// (control/cursor &gt; audio &gt; video) and video frames are cut into 64 KiB fragments, so a cursor update or
/// audio packet never waits behind a large keyframe.
///
/// Latency control on TCP: frames are never queued. The pipeline asks <see cref="CanSendVideo"/> before
/// encoding; it's false while a frame is waiting for the socket or while unacknowledged bytes exceed
/// ~1.5x the bandwidth-delay product. The client acks each frame on arrival, which gives us delivery rate
/// and queueing delay (RTT above the observed minimum) — the inputs to the bitrate controller.
/// </summary>
public sealed class ClientSession : IVideoSink
{
    private readonly WebSocket _ws;
    private readonly IPAddress? _remoteIp;
    private readonly CancellationTokenSource _cts = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly InputContext _input = new();

    private readonly ConcurrentQueue<(byte[] Data, WebSocketMessageType Type)> _control = new();
    private readonly ConcurrentQueue<byte[]> _audio = new();
    private readonly ConcurrentQueue<EncodedVideoFrame> _video = new();
    private readonly SemaphoreSlim _sendSignal = new(0);
    private int _videoQueued;

    private PairedDevice? _device;
    private VideoPipeline? _pipeline;
    private CaptureSource? _cursorSource;
    private readonly HashSet<uint> _sentShapes = new();
    private volatile bool _viewOnly;
    private volatile SessionRights _rights = new(false, false, false, false);
    private readonly object _rightsGate = new();
    private bool _audioEnabled;
    private int _epochBase;
    private string? _lastClipboardSent;
    private bool _clipboardSubscribed;
    private volatile bool _closed;
    /// <summary>Serialises starting the stream: the viewer's `start`, and <see cref="FollowDisplays"/> on the tick loop.</summary>
    private readonly object _streamGate = new();
    /// <summary>The viewer's last `start` (JSON), to start the stream again as displays come and go; null once it ends.</summary>
    private volatile string? _startJson;
    private long _lastDisplayCheckUs;
    private int _displayGoneChecks;
    /// <summary>A read started while a guest waited for approval; the receive loop picks it up.</summary>
    private Task<(WebSocketMessageType Type, byte[] Data)?>? _carriedReceive;

    // flow control / congestion state
    private readonly object _flowGate = new();
    private readonly Dictionary<uint, (long SentUs, int Bytes)> _inflight = new();
    private long _inflightBytes;
    private double _minRttMs = double.MaxValue;
    private long _minRttResetUs;
    private double _srttMs;
    private readonly Queue<(long Us, int Bytes)> _ackWindow = new();
    private long _ackWindowBytes;
    private int _targetKbps;
    private int _maxKbps;
    private int _minKbps;
    private long _lastRateChangeUs;
    private long _lastCongestionUs;
    private int _framesSinceTick;
    private long _bytesSinceTick;
    private long _lastTickUs;
    private int _statsFps;
    private double _statsKbps;

    public string Id { get; } = AuthService.Base64Url(System.Security.Cryptography.RandomNumberGenerator.GetBytes(6));
    public PairedDevice? Device => _device;
    public string RemoteAddress => (_remoteIp?.ToString() ?? "?") + (_relayed ? " (via relay)" : "");
    /// <summary>Came through the relay.</summary>
    private readonly bool _relayed;
    /// <summary>Came with a guest code (through the relay's /c/&lt;code&gt;/): may only start a guest session.</summary>
    private readonly bool _guest;
    /// <summary>The viewer's country, as the relay saw it (approximate location for the Accept prompt).</summary>
    public string? Country { get; }
    /// <summary>What this session may do (shown, and changeable for guests, in the settings window).</summary>
    public SessionRights Rights => _rights;
    public DateTime ConnectedAt { get; } = DateTime.UtcNow;

    private long NowUs => _clock.ElapsedTicks * 1_000_000 / Stopwatch.Frequency;

    public ClientSession(WebSocket ws, IPAddress? remoteIp, bool relayed = false, bool guest = false, string? country = null)
    {
        _ws = ws;
        _remoteIp = remoteIp;
        _relayed = relayed;
        _guest = guest;
        Country = country;
        var v = ConfigStore.Current.Video;
        _maxKbps = v.MaxBitrateKbps;
        _minKbps = v.MinBitrateKbps;
        _targetKbps = Math.Min(v.StartBitrateKbps, _maxKbps);
    }

    public async Task RunAsync(CancellationToken appStopping)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(appStopping, _cts.Token);
        var ct = linked.Token;
        try
        {
            if (!await HandshakeAsync(ct)) return;
            SessionManager.Register(this);
            var sendTask = Task.Run(() => SendLoopAsync(ct), ct);
            var tickTask = Task.Run(() => TickLoopAsync(ct), ct);
            await ReceiveLoopAsync(ct);
            _cts.Cancel();
            await Task.WhenAll(Swallow(sendTask), Swallow(tickTask));
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException ex)
        {
            Log.Debug("session", $"{Id}: socket closed ({ex.WebSocketErrorCode})");
        }
        catch (Exception ex)
        {
            Log.Error("session", $"{Id}: session error", ex);
        }
        finally
        {
            Cleanup();
        }
    }

    private static async Task Swallow(Task t)
    {
        try { await t; } catch { }
    }

    // ------------------------------------------------------------------------------------------- handshake

    private async Task<bool> HandshakeAsync(CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var msg = await ReceiveMessageAsync(timeout.Token);
        if (msg == null || msg.Value.Type != WebSocketMessageType.Text)
        {
            await CloseAsync(WebSocketCloseStatus.PolicyViolation, "expected hello");
            return false;
        }
        using var doc = JsonDocument.Parse(msg.Value.Data);
        var root = doc.RootElement;
        if (Str(root, "t") != "hello")
        {
            await CloseAsync(WebSocketCloseStatus.PolicyViolation, "expected hello");
            return false;
        }
        var retry = AuthService.RetryAfter(_remoteIp);
        if (retry != null)
        {
            await SendJsonDirect(new { t = "error", code = "rate-limited", retryAfter = (int)retry.Value.TotalSeconds });
            await CloseAsync(WebSocketCloseStatus.PolicyViolation, "rate limited");
            return false;
        }
        string? resumeToken = null, relayPath = null;
        if (root.TryGetProperty("support", out var support) && support.ValueKind == JsonValueKind.Object)
        {
            // Guest codes only arrive through the relay's code path (which throttles guessing too).
            if (!_guest)
            {
                await SendJsonDirect(new { t = "error", code = "bad-code", message = "Enter the code at the Headroom website." });
                await CloseAsync(WebSocketCloseStatus.PolicyViolation, "code outside the relay");
                return false;
            }
            if (await GuestHandshakeAsync(support, ct) is not { } accepted) return false;
            (_device, resumeToken) = accepted;
            relayPath = RelayService.Shared.RelayPath;
        }
        else if (!_guest)
        {
            _device = AuthService.ValidateToken(Str(root, "token"), _remoteIp);
        }
        if (_device == null)
        {
            await SendJsonDirect(new { t = "error", code = "unauthorized", message = "This computer doesn't accept this sign-in right now." });
            await CloseAsync(WebSocketCloseStatus.PolicyViolation, "unauthorized");
            return false;
        }
        var cfg = ConfigStore.Current;
        var rights = AuthService.Allowed(_device.Id) ?? new SessionRights(false, false, false, _device.Id.StartsWith("guest:", StringComparison.Ordinal));
        _rights = rights;
        _viewOnly = !rights.Input;
        Log.Info("session", $"{Id}: '{_device.Name}' connected from {_remoteIp}");

        await SendJsonDirect(new
        {
            t = "welcome",
            session = Id,
            host = HostInfo.Describe(),
            monitors = Displays.Enumerate().Select(MonitorJson).ToArray(),
            device = new { id = _device.Id, name = _device.Name },
            permissions = new
            {
                input = !_viewOnly,
                clipboard = rights.Clipboard,
                files = rights.Files,
                audio = cfg.Permissions.Audio && cfg.Audio.Enabled && !SameMachine,
            },
            limits = new { maxFps = cfg.Video.MaxFps, maxBitrateKbps = cfg.Video.MaxBitrateKbps },
            elevated = InputInjector.IsSystem,
            hostTimeUs = NowUs,
            resumeToken,
            support = resumeToken != null ? true : (bool?)null,
            relayPath,
        });
        return true;
    }

    /// <summary>
    /// Someone with a guest code: check it, ask the person here (always), then start a session that can resume with
    /// the key sent in welcome, on this PC's own relay path (the code is used up). Null if it doesn't go ahead.
    /// </summary>
    private async Task<(PairedDevice Device, string Token)?> GuestHandshakeAsync(JsonElement support, CancellationToken ct)
    {
        if (!SupportService.Shared.Verify(Str(support, "code")))
        {
            AuthService.RecordFailure(_remoteIp);
            await SendJsonDirect(new { t = "error", code = "bad-code", message = "That code is wrong, expired or already used. Ask for a new one." });
            await CloseAsync(WebSocketCloseStatus.PolicyViolation, "bad code");
            return null;
        }
        var name = GuestName(Str(support, "name"));
        var ip = _remoteIp?.ToString();
        var waiting = new { t = "pending", message = $"Waiting for the person at {HostInfo.Name} to accept…" };
        await SendJsonDirect(waiting);
        var decided = SupportService.Shared.RequestApprovalAsync(name, ip, Country, ct);
        // Keep reading while they decide, to notice a guest who leaves (anything they send meanwhile is ignored).
        var receive = ReceiveMessageAsync(ct);
        try
        {
            while (!decided.IsCompleted)
            {
                var tick = Task.Delay(TimeSpan.FromSeconds(20), ct);
                var first = await Task.WhenAny(decided, receive, tick);
                if (first == receive)
                {
                    if (receive.IsCompletedSuccessfully && receive.Result != null) { receive = ReceiveMessageAsync(ct); continue; }
                    _ = Swallow(receive);
                    return null; // gone while waiting: the request is withdrawn below
                }
                // Repeated so proxies don't close a connection that's quiet while they decide.
                if (first == tick && !ct.IsCancellationRequested) await SendJsonDirect(waiting);
            }
        }
        finally
        {
            if (!decided.IsCompleted) SupportService.Shared.Withdraw(name, ip);
        }
        var decision = await decided;
        if (decision == null)
        {
            _ = Swallow(receive);
            await SendJsonDirect(new { t = "error", code = "declined", message = $"The person at {HostInfo.Name} didn't accept." });
            await CloseAsync(WebSocketCloseStatus.PolicyViolation, "declined");
            return null;
        }
        AuthService.RecordSuccess(_remoteIp);
        var started = SupportService.Shared.StartSession(name, decision, ip);
        Log.Info("guest", $"{Id}: guest session for '{name}' from {ip ?? "?"}");
        _carriedReceive = receive;
        return started;
    }

    /// <summary>The name a guest typed: shown as unverified. Only printable characters, kept short.</summary>
    private static string GuestName(string? given)
    {
        var sb = new StringBuilder();
        foreach (var r in (given ?? "").EnumerateRunes())
        {
            if (Rune.GetUnicodeCategory(r) is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.OtherNotAssigned
                or UnicodeCategory.Surrogate or UnicodeCategory.PrivateUse) continue;
            sb.Append(r.ToString());
        }
        var t = sb.ToString().Trim();
        if (t.Length == 0) return "Someone";
        var info = new StringInfo(t);
        return info.LengthInTextElements > 40 ? info.SubstringByTextElements(0, 40).TrimEnd() : t;
    }

    /// <summary>What this session may do changed (from the settings window, or this PC's settings): apply it now.</summary>
    public void ApplyRights()
    {
        if (_device is not { } dev || _closed) return;
        var r = AuthService.Allowed(dev.Id);
        if (r == null)
        {
            Disconnect("access ended");
            return;
        }
        lock (_rightsGate)
        {
            if (r == _rights) return;
            _rights = r;
            _viewOnly = !r.Input;
        }
        if (!r.Input) InputInjector.Instance.ReleaseAll(_input);
        SyncClipboard();
        var cfg = ConfigStore.Current;
        Enqueue(new
        {
            t = "permissions",
            permissions = new { input = r.Input, files = r.Files, clipboard = r.Clipboard, audio = cfg.Permissions.Audio && cfg.Audio.Enabled && !SameMachine },
        });
        Log.Info("session", $"{Id}: now control={r.Input} files={r.Files} clipboard={r.Clipboard}");
    }

    /// <summary>Follows clipboard changes on this PC while the session may share the clipboard and is streaming.</summary>
    private void SyncClipboard()
    {
        lock (_rightsGate)
        {
            bool want = !_closed && _rights.Clipboard && _pipeline != null;
            if (want == _clipboardSubscribed) return;
            _clipboardSubscribed = want;
            if (want) ClipboardService.Instance.Changed += OnClipboardChanged;
            else ClipboardService.Instance.Changed -= OnClipboardChanged;
        }
    }

    public static object MonitorJson(MonitorInfo m) => new
    {
        id = m.Id, name = m.Name, x = m.X, y = m.Y, width = m.Width, height = m.Height,
        primary = m.Primary, refreshHz = m.RefreshHz, scale = m.Scale, rotation = m.Rotation,
    };

    // ------------------------------------------------------------------------------------------- receive

    private readonly byte[] _recvBuffer = new byte[64 * 1024];
    private readonly MemoryStream _recvAccum = new();

    private async Task<(WebSocketMessageType Type, byte[] Data)?> ReceiveMessageAsync(CancellationToken ct)
    {
        _recvAccum.SetLength(0);
        while (true)
        {
            var r = await _ws.ReceiveAsync(_recvBuffer, ct);
            if (r.MessageType == WebSocketMessageType.Close) return null;
            _recvAccum.Write(_recvBuffer, 0, r.Count);
            if (_recvAccum.Length > 16 * 1024 * 1024) throw new InvalidDataException("message too large");
            if (r.EndOfMessage) return (r.MessageType, _recvAccum.ToArray());
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
        {
            var carried = _carriedReceive;
            _carriedReceive = null;
            var msg = carried != null ? await carried : await ReceiveMessageAsync(ct);
            if (msg == null) break;
            _lastReceiveUs = NowUs;
            try
            {
                if (msg.Value.Type == WebSocketMessageType.Binary) HandleBinary(msg.Value.Data);
                else HandleJson(msg.Value.Data);
            }
            catch (Exception ex)
            {
                Log.Warn("session", $"{Id}: bad message: {ex.Message}");
            }
        }
    }

    private long _lastReceiveUs;

    private void HandleBinary(byte[] b)
    {
        if (b.Length == 0) return;
        switch (b[0])
        {
            case Wire.FrameAck when b.Length >= 5:
                OnAck(BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(1)));
                return;
        }
        if (_viewOnly) return;
        switch (b[0])
        {
            case Wire.MouseAbs when b.Length >= 9:
            {
                float nx = BinaryPrimitives.ReadSingleLittleEndian(b.AsSpan(1));
                float ny = BinaryPrimitives.ReadSingleLittleEndian(b.AsSpan(5));
                var mon = _pipeline?.Source?.Monitor ?? _pipeline?.Monitor;
                if (mon == null || float.IsNaN(nx) || float.IsNaN(ny)) return;
                int x = mon.X + Math.Clamp((int)(nx * mon.Width), 0, mon.Width - 1);
                int y = mon.Y + Math.Clamp((int)(ny * mon.Height), 0, mon.Height - 1);
                InputInjector.Instance.MoveTo(x, y);
                break;
            }
            case Wire.MouseRel when b.Length >= 5:
                InputInjector.Instance.MoveBy(BinaryPrimitives.ReadInt16LittleEndian(b.AsSpan(1)), BinaryPrimitives.ReadInt16LittleEndian(b.AsSpan(3)));
                break;
            case Wire.MouseButton when b.Length >= 3:
                InputInjector.Instance.Button(_input, b[1], b[2] != 0);
                break;
            case Wire.MouseWheel when b.Length >= 5:
                InputInjector.Instance.Wheel(BinaryPrimitives.ReadInt16LittleEndian(b.AsSpan(1)), BinaryPrimitives.ReadInt16LittleEndian(b.AsSpan(3)));
                break;
            case Wire.KeyEvent when b.Length >= 4:
            {
                bool down = (b[1] & 1) != 0;
                int len = b[2];
                if (b.Length < 3 + len) return;
                var code = Encoding.ASCII.GetString(b, 3, len);
                InputInjector.Instance.Key(_input, code, down);
                break;
            }
        }
    }

    private void HandleJson(byte[] data)
    {
        using var doc = JsonDocument.Parse(data);
        var root = doc.RootElement;
        var rights = _rights;
        switch (Str(root, "t"))
        {
            case "ping":
                Enqueue(new { t = "pong", id = Int(root, "id"), ts = root.TryGetProperty("ts", out var ts) ? ts.GetDouble() : 0, host = NowUs });
                break;
            case "start":
                lock (_streamGate) StartStream(root);
                break;
            case "keyframe":
                _pipeline?.RequestKeyframe();
                break;
            case "monitors":
                Enqueue(new { t = "monitors", monitors = Displays.Enumerate().Select(MonitorJson).ToArray() });
                break;
            case "clip" when rights.Clipboard:
            {
                var text = Str(root, "text");
                if (text != null)
                {
                    _lastClipboardSent = text; // don't echo it back
                    ClipboardService.Instance.SetText(text);
                }
                break;
            }
            case "clip-get" when rights.Clipboard:
            {
                var text = ClipboardService.Instance.GetText();
                Enqueue(new { t = "clip", text = text ?? "", requested = true });
                break;
            }
            case "text" when !_viewOnly:
                InputInjector.Instance.Text(Str(root, "s") ?? "");
                break;
            case "locks" when !_viewOnly:
                InputInjector.Instance.SyncLocks(Bool(root, "caps"), Bool(root, "num"), root.TryGetProperty("scroll", out var sc) ? sc.GetBoolean() : null);
                break;
            case "release":
                InputInjector.Instance.ReleaseAll(_input);
                break;
            case "special" when !_viewOnly:
                HandleSpecial(Str(root, "action") ?? "");
                break;
            case "audio":
                SetAudio(Bool(root, "enabled"));
                break;
            case "file-token" when rights.Files:
            {
                var path = Str(root, "path");
                if (path != null && _device != null)
                {
                    var tok = AuthService.CreateEphemeral(_device.Id, "download", path, TimeSpan.FromMinutes(2));
                    Enqueue(new { t = "file-token", path, token = tok, id = Int(root, "id") });
                }
                break;
            }
        }
    }

    private void HandleSpecial(string action)
    {
        switch (action)
        {
            case "cad":
                // The service performs SendSAS (it must come from a service); fall back to calling it
                // ourselves when running as SYSTEM without the pipe, else offer Task Manager.
                if (ServiceBridge.RequestSas()) break;
                if (InputInjector.IsSystem && InputInjector.Instance.SecureAttention()) break;
                InputInjector.Instance.Chord("ControlLeft", "ShiftLeft", "Escape");
                Enqueue(new { t = "notice", level = "warn", message = "Ctrl+Alt+Del needs Headroom installed as a service (headroom service install). Opened Task Manager instead." });
                break;
            case "lock":
                InputInjector.Instance.LockWorkstation();
                break;
            case "taskmgr":
                InputInjector.Instance.Chord("ControlLeft", "ShiftLeft", "Escape");
                break;
        }
    }

    /// <summary>
    /// Starts or changes the stream; callers hold _streamGate. <paramref name="retry"/>: <see cref="FollowDisplays"/>
    /// starting it again from the viewer's last request, whose audio setting may be out of date by then.
    /// </summary>
    private void StartStream(JsonElement root, bool retry = false)
    {
        _startJson = root.GetRawText();
        // Sound needs no display, so it follows the request even while there's no picture to show.
        if (!retry && root.TryGetProperty("audio", out var a)) SetAudio(a.GetBoolean());
        var cfg = ConfigStore.Current;
        var monitors = Displays.Enumerate();
        if (monitors.Count == 0)
        {
            // The only monitor is off or unplugged: say so, and FollowDisplays starts the stream once one is back.
            Log.Info("session", $"{Id}: no display to stream; waiting for one");
            OnCaptureStatus(CaptureStatus.Unavailable, Displays.NoneConnected);
            return;
        }
        var wanted = Str(root, "monitor");
        var monitor = monitors.FirstOrDefault(m => m.Id.Equals(wanted, StringComparison.OrdinalIgnoreCase)) ?? monitors[0];
        int maxFps = Math.Clamp(Int(root, "maxFps") ?? cfg.Video.MaxFps, 5, Math.Max(5, cfg.Video.MaxFps));
        // Never exceed what the monitor can show.
        maxFps = (int)Math.Min(maxFps, Math.Max(30, Math.Round(monitor.RefreshHz)));
        int clientMaxKbps = Int(root, "maxBitrateKbps") ?? cfg.Video.MaxBitrateKbps;
        lock (_flowGate)
        {
            _maxKbps = Math.Clamp(clientMaxKbps, cfg.Video.MinBitrateKbps, cfg.Video.MaxBitrateKbps);
            _targetKbps = Math.Clamp(_targetKbps, _minKbps, _maxKbps);
        }
        var settings = new PipelineSettings
        {
            Monitor = monitor,
            MaxFps = maxFps,
            BitrateKbps = _targetKbps,
            MaxWidth = Int(root, "maxWidth") ?? 0,
            MaxHeight = Int(root, "maxHeight") ?? 0,
            EncoderPreference = cfg.Video.Encoder,
            FullRange = false,
        };
        if (_pipeline == null)
        {
            _pipeline = new VideoPipeline(settings, this, _epochBase);
        }
        else
        {
            _pipeline.UpdateSettings(settings);
        }
        AttachCursor();
        SyncClipboard();
        Log.Info("session", $"{Id}: stream {monitor.Id} ({monitor.Name}) max {maxFps} fps, {_maxKbps} kbps cap, view-only={_viewOnly}");
    }

    // ------------------------------------------------------------------------------------------- cursor

    private void AttachCursor()
    {
        // Pipeline attaches its capture source asynchronously; poll briefly from the tick loop.
        var src = _pipeline?.Source;
        if (src == null || ReferenceEquals(src, _cursorSource)) return;
        DetachCursor();
        _cursorSource = src;
        src.CursorMoved += OnCursorMoved;
        src.CursorShapeChanged += OnCursorShape;
        if (src.Shape != null) OnCursorShape(src, src.Shape);
        OnCursorMoved(src);
    }

    private void DetachCursor()
    {
        if (_cursorSource == null) return;
        _cursorSource.CursorMoved -= OnCursorMoved;
        _cursorSource.CursorShapeChanged -= OnCursorShape;
        _cursorSource = null;
    }

    private void OnCursorMoved(CaptureSource src) => EnqueueBinary(Wire.CursorPos(src.CursorX, src.CursorY, src.CursorVisible));

    private void OnCursorShape(CaptureSource src, CursorShape shape)
    {
        bool cached;
        lock (_sentShapes) cached = !_sentShapes.Add(shape.Id);
        EnqueueBinary(cached
            ? Wire.CursorShapeMessage(shape.Id, 0, 0, 0, 0, null)
            : Wire.CursorShapeMessage(shape.Id, shape.Width, shape.Height, shape.HotX, shape.HotY, shape.Rgba));
    }

    // ------------------------------------------------------------------------------------------- clipboard / audio

    private void OnClipboardChanged(string text)
    {
        if (text == _lastClipboardSent) return;
        _lastClipboardSent = text;
        Enqueue(new { t = "clip", text });
    }

    /// <summary>Viewer runs on this very PC (loopback or one of our own addresses).</summary>
    private bool SameMachine =>
        !_relayed && _remoteIp != null && (IPAddress.IsLoopback(_remoteIp) || CertificateManager.GetLocalAddresses().Any(a => a.Equals(_remoteIp.IsIPv4MappedToIPv6 ? _remoteIp.MapToIPv4() : _remoteIp)));

    private bool _sameMachineNotified;

    private void SetAudio(bool enabled)
    {
        var cfg = ConfigStore.Current;
        enabled &= cfg.Audio.Enabled && cfg.Permissions.Audio;
        if (enabled && SameMachine)
        {
            // Playing captured system audio back on the same PC re-captures it: an instant feedback loop.
            enabled = false;
            if (!_sameMachineNotified)
            {
                _sameMachineNotified = true;
                Enqueue(new { t = "notice", level = "info", message = "Audio is off: you're viewing this PC from itself, which would echo." });
            }
        }
        if (enabled == _audioEnabled) return;
        _audioEnabled = enabled;
        if (enabled) AudioService.Instance.Subscribe(OnAudioPacket);
        else AudioService.Instance.Unsubscribe(OnAudioPacket);
    }

    private void OnAudioPacket(AudioService.Packet p)
    {
        // Drop audio rather than build a backlog: late audio is worse than a gap.
        if (_audio.Count > 25) return;
        _audio.Enqueue(Wire.Audio(p.Sequence, p.TimeUs, p.Data));
        _sendSignal.Release();
    }

    // ------------------------------------------------------------------------------------------- video sink

    public void OnVideoConfig(VideoStreamConfig c)
    {
        _epochBase = c.Epoch;
        Enqueue(new
        {
            t = "video-config",
            epoch = c.Epoch,
            codec = c.Codec,
            description = Convert.ToBase64String(c.Description),
            width = c.Width,
            height = c.Height,
            sourceWidth = c.SourceWidth,
            sourceHeight = c.SourceHeight,
            monitor = c.MonitorId,
            encoder = c.EncoderName,
            hardware = c.Hardware,
            fullRange = c.FullRange,
        });
        AttachCursorSoon();
    }

    private void AttachCursorSoon() => ThreadPool.QueueUserWorkItem(_ => AttachCursor());

    public void OnVideoFrame(EncodedVideoFrame frame)
    {
        Interlocked.Increment(ref _videoQueued);
        _video.Enqueue(frame);
        _sendSignal.Release();
        Interlocked.Increment(ref _framesSinceTick);
        Interlocked.Add(ref _bytesSinceTick, frame.Data.Length);
    }

    public void OnCaptureStatus(CaptureStatus status, string? detail)
    {
        string s = status switch
        {
            CaptureStatus.Ok => "ok",
            CaptureStatus.SecureDesktop => "secure-desktop",
            CaptureStatus.Starting => "starting",
            _ => "unavailable",
        };
        Enqueue(new { t = "status", capture = s, detail, elevated = InputInjector.IsSystem });
    }

    public bool CanSendVideo
    {
        get
        {
            bool ok;
            if (Volatile.Read(ref _videoQueued) > 0) ok = false;
            else
            {
                lock (_flowGate)
                {
                    ok = _inflight.Count == 0 || (_inflightBytes < InflightBudgetBytes() && _inflight.Count < 12);
                }
            }
            // The pipeline polls this every ~2 ms while it holds a frame, so what signals congestion is
            // how *long* a ready frame waited — not how many times we were asked.
            long now = NowUs;
            lock (_flowGate)
            {
                if (!ok)
                {
                    if (_blockedSinceUs == 0) _blockedSinceUs = now;
                }
                else if (_blockedSinceUs != 0)
                {
                    _blockedUsSinceTick += now - _blockedSinceUs;
                    _blockedSinceUs = 0;
                }
            }
            return ok;
        }
    }

    private long _blockedSinceUs;
    private long _blockedUsSinceTick;

    private long InflightBudgetBytes()
    {
        // ~1.5x bandwidth-delay product using delivery rate, with sane floors/caps.
        double rateBytesPerMs = DeliveryRateKbps() / 8.0;
        double rtt = _minRttMs == double.MaxValue ? 50 : _minRttMs;
        long bdp = (long)(rateBytesPerMs * (rtt + 40) * 1.5);
        long floor = Math.Max(256 * 1024, _targetKbps * 1000L / 8 / 10); // at least 100 ms of target bitrate
        return Math.Clamp(bdp, floor, 6 * 1024 * 1024);
    }

    private double DeliveryRateKbps()
    {
        long now = NowUs;
        while (_ackWindow.Count > 0 && now - _ackWindow.Peek().Us > 1_000_000)
            _ackWindowBytes -= _ackWindow.Dequeue().Bytes;
        if (_ackWindow.Count < 2) return _targetKbps;
        long spanUs = Math.Max(1, now - _ackWindow.Peek().Us);
        spanUs = Math.Max(spanUs, 250_000);
        return _ackWindowBytes * 8.0 / (spanUs / 1000.0); // bits per ms == kbps
    }

    private void OnAck(uint frameId)
    {
        lock (_flowGate)
        {
            // Acks are cumulative-ish: anything older than the acked frame is also delivered.
            var acked = _inflight.Where(kv => (int)(kv.Key - frameId) <= 0).ToList();
            long now = NowUs;
            foreach (var kv in acked)
            {
                _inflight.Remove(kv.Key);
                _inflightBytes -= kv.Value.Bytes;
                _ackWindow.Enqueue((now, kv.Value.Bytes));
                _ackWindowBytes += kv.Value.Bytes;
                if (kv.Key == frameId)
                {
                    double rtt = (now - kv.Value.SentUs) / 1000.0;
                    // Remove the frame's own transmission time so a big keyframe on a modest link doesn't look
                    // like queueing; what's left approximates path RTT + queueing. At the rate we may send (the
                    // target) when that's higher than the delivery rate: delivery is only what the screen needed
                    // lately (when little changes, little is sent), and dividing by it made frames "take" longer
                    // than the whole round trip, so the min RTT fell to ~0, every RTT looked like queueing, and on
                    // any path over ~60 ms the bitrate kept dropping to its floor.
                    double kbps = Math.Max(DeliveryRateKbps(), _targetKbps);
                    double serializationMs = kbps > 0 ? kv.Value.Bytes * 8.0 / kbps : 0;
                    double sample = Math.Max(0.1, rtt - serializationMs);
                    if (sample < _minRttMs) _minRttMs = sample;
                    _srttMs = _srttMs == 0 ? sample : _srttMs * 0.875 + sample * 0.125;
                }
            }
            if (_inflightBytes < 0) _inflightBytes = 0;
        }
    }

    // ------------------------------------------------------------------------------------------- send loop

    private void Enqueue(object message)
    {
        _control.Enqueue((JsonSerializer.SerializeToUtf8Bytes(message, JsonOpts), WebSocketMessageType.Text));
        _sendSignal.Release();
    }

    private void EnqueueBinary(byte[] data)
    {
        _control.Enqueue((data, WebSocketMessageType.Binary));
        _sendSignal.Release();
    }

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private async Task SendJsonDirect(object message)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, JsonOpts);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private async Task SendLoopAsync(CancellationToken ct)
    {
        var header = new byte[Wire.VideoHeaderSize + Wire.MaxFragmentPayload];
        EncodedVideoFrame? current = null;
        int offset = 0;
        while (!ct.IsCancellationRequested)
        {
            await _sendSignal.WaitAsync(ct);
            while (!ct.IsCancellationRequested)
            {
                if (_control.TryDequeue(out var c))
                {
                    await _ws.SendAsync(c.Data, c.Type, true, ct);
                    continue;
                }
                if (_audio.TryDequeue(out var a))
                {
                    await _ws.SendAsync(a, WebSocketMessageType.Binary, true, ct);
                    continue;
                }
                if (current == null && _video.TryDequeue(out var next))
                {
                    current = next;
                    offset = 0;
                }
                if (current != null)
                {
                    var data = current.Data;
                    int len = Math.Min(Wire.MaxFragmentPayload, data.Length - offset);
                    var flags = (current.KeyFrame ? Wire.VideoFlags.Key : 0)
                                | (offset == 0 ? Wire.VideoFlags.First : 0)
                                | (offset + len >= data.Length ? Wire.VideoFlags.Last : 0);
                    Wire.WriteVideoHeader(header, flags, current.Epoch, current.FrameId, data.Length, offset, current.CaptureTimeUs, current.EncodeMs);
                    Buffer.BlockCopy(data, offset, header, Wire.VideoHeaderSize, len);
                    bool last = offset + len >= data.Length;
                    if (last)
                    {
                        // Register before sending: on a fast link the client's ack can beat SendAsync's return.
                        lock (_flowGate)
                        {
                            _inflight[current.FrameId] = (NowUs, data.Length);
                            _inflightBytes += data.Length;
                        }
                    }
                    await _ws.SendAsync(new ArraySegment<byte>(header, 0, Wire.VideoHeaderSize + len), WebSocketMessageType.Binary, true, ct);
                    offset += len;
                    if (last)
                    {
                        current = null;
                        Interlocked.Decrement(ref _videoQueued);
                    }
                    continue;
                }
                break;
            }
        }
    }

    // ------------------------------------------------------------------------------------------- periodic

    private async Task TickLoopAsync(CancellationToken ct)
    {
        _lastTickUs = NowUs;
        _lastReceiveUs = NowUs;
        long lastStats = 0;
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(250, ct);
            long now = NowUs;
            if (now - _lastReceiveUs > 20_000_000)
            {
                Log.Info("session", $"{Id}: no traffic for 20 s; closing");
                _cts.Cancel();
                break;
            }
            AttachCursor();
            try { FollowDisplays(now); }
            catch (Exception ex) { Log.Warn("session", $"{Id}: display check failed: {ex.Message}"); }
            AdaptBitrate(now);
            if (now - lastStats >= 1_000_000)
            {
                lastStats = now;
                SendStats(now);
            }
        }
    }

    /// <summary>
    /// Keeps the stream the viewer asked for on a display that exists. A monitor switched off at its button can leave
    /// Windows' display list (over DisplayPort it's as good as unplugged): with no display at all there's nothing to
    /// stream, and the stream starts here once one is back. A streamed display that stays gone while others remain
    /// (or that came back under another name) is swapped for the one asked for, or the main display. Checked once a
    /// second, and only while there's no stream or its capture is unavailable.
    /// </summary>
    private void FollowDisplays(long now)
    {
        var request = _startJson;
        if (request == null || now - _lastDisplayCheckUs < 1_000_000) return;
        _lastDisplayCheckUs = now;
        var pipeline = _pipeline;
        if (pipeline != null && pipeline.Source?.Status != CaptureStatus.Unavailable)
        {
            _displayGoneChecks = 0;
            return;
        }
        var monitors = Displays.Enumerate();
        if (monitors.Count == 0) return; // still none: the viewer was told, and a running capture keeps trying too
        if (pipeline != null)
        {
            // Its display is listed (again): the capture picks it up by itself. Otherwise give it 3 checks, as a display
            // can drop out of the list for a moment while Windows changes modes.
            var streamed = pipeline.Monitor.Id;
            if (monitors.Any(m => m.Id.Equals(streamed, StringComparison.OrdinalIgnoreCase)))
            {
                _displayGoneChecks = 0;
                return;
            }
            if (++_displayGoneChecks < 3) return;
        }
        _displayGoneChecks = 0;
        lock (_streamGate)
        {
            // Look again next time if a start got in meanwhile (this saw it half done), or the session is ending.
            if (!ReferenceEquals(_startJson, request) || !ReferenceEquals(_pipeline, pipeline)) return;
            Log.Info("session", $"{Id}: displays changed; starting the stream again");
            Enqueue(new { t = "monitors", monitors = monitors.Select(MonitorJson).ToArray() });
            using var doc = JsonDocument.Parse(request);
            StartStream(doc.RootElement, retry: true);
        }
    }

    private void AdaptBitrate(long now)
    {
        if (_pipeline == null) return;
        bool congested;
        double delivery;
        long blocked;
        lock (_flowGate)
        {
            blocked = _blockedUsSinceTick + (_blockedSinceUs != 0 ? now - _blockedSinceUs : 0);
            _blockedUsSinceTick = 0;
            if (_blockedSinceUs != 0) _blockedSinceUs = now;
            delivery = DeliveryRateKbps();
            // Re-learn min RTT every 30 s in case the path changed (e.g. Wi-Fi -> LAN).
            if (now - _minRttResetUs > 30_000_000) { _minRttResetUs = now; if (_inflight.Count == 0) _minRttMs = double.MaxValue; }
            double queueDelay = _minRttMs == double.MaxValue ? 0 : _srttMs - _minRttMs;
            // Congested = a ready frame spent >40% of this tick waiting for the network, or the path
            // shows sustained queueing delay (bufferbloat) beyond what serialization explains.
            congested = blocked > 100_000 || queueDelay > 60;
        }
        int target = _targetKbps;
        if (congested)
        {
            _lastCongestionUs = now;
            if (now - _lastRateChangeUs > 400_000)
            {
                // Multiplicative decrease. Only when frames waited for the network is the delivery rate the
                // link's, so aim just under it then; otherwise it's what the screen needed (often far less than
                // the link can carry), and dropping to it cut a fast link to the floor at one hiccup.
                double next = target * 0.8;
                if (blocked > 50_000) next = Math.Min(next, delivery * 0.9);
                target = (int)Math.Max(_minKbps, next);
            }
        }
        else if (now - _lastCongestionUs > 2_000_000 && now - _lastRateChangeUs > 1_000_000)
        {
            target = Math.Min(_maxKbps, (int)(target * 1.12) + 200);
        }
        if (target != _targetKbps && Math.Abs(target - _targetKbps) > _targetKbps * 0.04)
        {
            _targetKbps = target;
            _lastRateChangeUs = now;
            _pipeline.SetBitrate(target);
        }
    }

    private void SendStats(long now)
    {
        double secs = Math.Max(0.001, (now - _lastTickUs) / 1_000_000.0);
        _lastTickUs = now;
        _statsFps = Interlocked.Exchange(ref _framesSinceTick, 0);
        _statsKbps = Interlocked.Exchange(ref _bytesSinceTick, 0) * 8 / 1000.0 / secs;
        double minRtt, srtt;
        lock (_flowGate) { minRtt = _minRttMs == double.MaxValue ? 0 : _minRttMs; srtt = _srttMs; }
        Enqueue(new
        {
            t = "stats",
            fps = Math.Round(_statsFps / secs, 1),
            kbps = Math.Round(_statsKbps),
            targetKbps = _targetKbps,
            encodeMs = Math.Round(_pipeline?.LastEncodeMs ?? 0, 2),
            encoder = _pipeline?.EncoderName,
            frameRttMs = Math.Round(srtt, 1),
            minRttMs = Math.Round(minRtt, 1),
        });
    }

    // ------------------------------------------------------------------------------------------- teardown

    /// <summary>
    /// Ends the session from this side. The viewer hears why first, in words for a person, so it shows
    /// "Session ended" with the reason instead of trying to reconnect.
    /// </summary>
    public void Disconnect(string reason)
    {
        Log.Info("session", $"{Id}: disconnect requested ({reason})");
        var host = HostInfo.Name;
        var message = reason switch
        {
            "stopped by the person at the computer" => $"The person at {host} stopped the session.",
            "host is shutting down" => $"Headroom Server on {host} was stopped.",
            "device revoked" or "access ended" => $"This sign-in no longer has access to {host}.",
            _ => $"{host} ended the session.",
        };
        Enqueue(new { t = "error", code = "ended", message });
        _ = Task.Run(async () =>
        {
            // Give the send loop a moment to deliver it (it sends control messages before any more video).
            for (int i = 0; i < 20 && !_control.IsEmpty; i++) await Task.Delay(25);
            await Task.Delay(50);
            await CloseAsync(WebSocketCloseStatus.NormalClosure, reason);
            _cts.Cancel();
        });
    }

    private async Task CloseAsync(WebSocketCloseStatus status, string reason)
    {
        try
        {
            if (_ws.State == WebSocketState.Open)
            {
                using var t = new CancellationTokenSource(2000);
                await _ws.CloseOutputAsync(status, reason, t.Token);
            }
        }
        catch { }
    }

    private void Cleanup()
    {
        // No more (re)starts: the tick loop can outlive the receive loop (a dropped socket) and would otherwise be able to
        // start a pipeline (and audio) after this has torn them down.
        lock (_streamGate) _startJson = null;
        InputInjector.Instance.ReleaseAll(_input);
        DetachCursor();
        if (_audioEnabled) AudioService.Instance.Unsubscribe(OnAudioPacket);
        lock (_rightsGate)
        {
            _closed = true;
            _clipboardSubscribed = false;
            ClipboardService.Instance.Changed -= OnClipboardChanged;
        }
        _pipeline?.Dispose();
        _pipeline = null;
        if (_device != null)
        {
            SessionManager.Unregister(this);
            Log.Info("session", $"{Id}: '{_device.Name}' disconnected after {(DateTime.UtcNow - ConnectedAt):hh\\:mm\\:ss}");
        }
    }

    // ------------------------------------------------------------------------------------------- json helpers

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int? Int(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    private static bool Bool(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
