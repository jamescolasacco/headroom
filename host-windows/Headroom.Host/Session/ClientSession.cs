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
/// Audio priority (the viewer's choice, for music), as on the Mac host: sound is never dropped here; video fragments are
/// 4-16 KiB and paced (VideoPacer) to just under what big frames show the path carries; video gets about one
/// bandwidth-delay product in flight (64 KiB at least), starts at 2.5 Mb/s, backs off at 25 ms of queueing (WebSocket
/// pings measure the queue on the way to the viewer) or when sound waits 25 ms, and its ceiling leaves room for the
/// sound. A sound the connection can't carry steps down (lossless, then Opus from 510 kbps) to what fits, never dropped.
///
/// Latency control on TCP: frames are never queued. The pipeline asks <see cref="CanSendVideo"/> before
/// encoding; it's false while a frame is waiting for the socket or while unacknowledged bytes exceed
/// ~1.5x the bandwidth-delay product. Sharpening passes of a still screen ask <see cref="CanSendRefinement"/>
/// instead: only into an idle path. The client acks each frame on arrival, which gives us delivery rate and
/// queueing delay (RTT above the observed minimum) — the inputs to the bitrate controller.
/// </summary>
public sealed class ClientSession : IVideoSink
{
    private readonly WebSocket _ws;
    private readonly IPAddress? _remoteIp;
    /// <summary>The connection's socket (through the relay: its loopback end), and through the relay the tunnel's end of that hop.</summary>
    private readonly System.Net.Sockets.Socket? _socket, _tunnelSocket;
    private readonly CancellationTokenSource _cts = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    /// <summary>Where <see cref="_clock"/> started, as a Stopwatch timestamp: puts times taken elsewhere (when sound was captured) on it.</summary>
    private readonly long _clockStart = Stopwatch.GetTimestamp();
    private readonly InputContext _input = new();

    private readonly ConcurrentQueue<(byte[] Data, WebSocketMessageType Type)> _control = new();
    /// <summary>Sound to send, with when each packet was queued (audio priority measures how long it waits).</summary>
    private readonly ConcurrentQueue<(byte[] Data, long QueuedUs)> _audio = new();
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
    /// <summary>Whether this PC's settings let the session have its sound, as the viewer was last told (welcome, permissions).</summary>
    private bool _audioAllowed;
    private readonly object _audioGate = new();
    // The sound the viewer asked for (`start`, `audio`) and what it gets, under _audioGate.
    private bool _audioPcm;
    private bool _audioPriority;
    /// <summary>It asked for a sound this host doesn't make (it gets Opus): say so once.</summary>
    private bool _audioUnsupported;
    /// <summary>Bandwidth steps down from what it asked for (with priority): lossless to Opus, then Opus's rate.</summary>
    private int _audioStep;
    private AudioService.Format _audioFormat;
    /// <summary>The last `audio-mode` the viewer got (null: none, so it assumes Opus without priority).</summary>
    private string? _audioModeTold;
    private readonly Action<AudioService.Packet> _onAudio;
    /// <summary>Audio priority in effect (asked for, and sound on): the transport puts sound first and video yields to it.</summary>
    private volatile bool _priority;
    /// <summary>What the sound needs of the connection, kept free of video while <see cref="_priority"/>.</summary>
    private volatile int _audioKbps;
    private long _audioDropped;         // packets let go (priority: only past PriorityAudioQueue), since the session began
    private int _socketSendBuffer = -1, _tunnelReceiveBuffer = -1; // as they were before audio priority (-1: untouched)
    /// <summary>Audio priority: up to ~2 s of sound waits to be sent; past that the oldest goes, so the delay stays bounded.</summary>
    private const int PriorityAudioQueue = 200;
    /// <summary>Audio priority, through the relay: the loopback hop to RelayService keeps this little (each end).</summary>
    private const int PriorityLoopbackBuffer = 16 * 1024;
    // Audio priority: how long sound waits from being queued to reaching the socket, and how much went (_audioStatsGate).
    private readonly object _audioStatsGate = new();
    private readonly List<long> _audioDelaysUs = new(); // since the last stats
    private long _audioTickMaxUs;                       // since the last tick
    private long _audioWrittenBytes;                    // reached the socket, since priority went on
    private long _audioAcceptedBytes;                   // queued (Interlocked), since priority went on
    private long _videoBytesOut;                        // picture handed to the socket (Interlocked), since priority went on
    // The step-down watch on this session's own queue (AudioRateWatch), per packet on the capture thread (_rateGate).
    private readonly object _rateGate = new();
    private readonly AudioRateWatch _rateWatch = new();
    private bool _rateWatchArmed;
    private bool _stepPending;
    private double _stepCarriedKbps;
    /// <summary>The step-down watch on the way to the viewer (pings), on the tick loop.</summary>
    private readonly PathBacklogWatch _pathWatch = new();
    private long _audioStepHoldUntilUs;
    // Pings (audio priority): WebSocket pings carrying their send time, which the viewer's WebSocket answers by itself
    // (through the relay too); the round trips show what's queued on the way (_pingGate).
    private readonly PingStream? _pings;
    private readonly object _pingGate = new();
    private readonly List<long> _pingsOut = new();      // not answered yet: when each was sent
    private readonly List<(long Us, double Ms)> _pongs = new(); // the last 2 s
    private int _pongCount;
    private double _pongMinMs = double.MaxValue;
    /// <summary>
    /// welcome sent -> `start` received, before any sound or picture flows: the path's round trip without a queue. With
    /// audio priority it seeds the minimum RTT (lossless sound already filling the path hides it from the first frames).
    /// </summary>
    private long _welcomeSentUs;
    private double _handshakeRttMs = double.MaxValue;
    /// <summary>With audio priority, video fragments leave no faster than this (_paceGate).</summary>
    private readonly VideoPacer _pacer = new();
    private readonly object _paceGate = new();
    // How long sound waited for the socket, logged every 30 s (tick loop).
    private long _audioLogSinceUs;
    private int _audioLogPackets;
    private double _audioLogP95Ms, _audioLogMaxMs;
    /// <summary>Where the picture's bitrate starts for a session with audio priority, before anything is measured.</summary>
    public const int PriorityStartKbps = 2500;
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
    /// <summary>
    /// Frames sent and not acked yet. Behind: sent while a sharpening pass was still on its way. FirstUs, FirstBytes:
    /// when its first fragment went and how big it was; PaceKbps: the video pace then (audio priority's path estimate).
    /// </summary>
    private readonly Dictionary<uint, (long SentUs, int Bytes, bool Refinement, bool Behind, long FirstUs, int FirstBytes, int PaceKbps)> _inflight = new();
    /// <summary>With audio priority: what big frames say the path carries for video, and the pace set from it.</summary>
    private readonly VideoPathEstimate _pathEstimate = new();
    private int _paceKbps;
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

    public ClientSession(WebSocket ws, IPAddress? remoteIp, bool relayed = false, bool guest = false, string? country = null,
        System.Net.Sockets.Socket? socket = null, System.Net.Sockets.Socket? tunnelSocket = null, PingStream? pings = null)
    {
        _ws = ws;
        _remoteIp = remoteIp;
        _relayed = relayed;
        _guest = guest;
        Country = country;
        _socket = socket;
        _tunnelSocket = tunnelSocket;
        _onAudio = OnAudioPacket;
        _pings = pings;
        if (pings != null) pings.Pong = OnPong;
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
        if (ServerSwitch.Shared.Stopped)
        {
            // Stop server while this one was being let in (its sign-in's key looked up, an Accept): nobody can connect now.
            if (_device.Id.StartsWith("guest:", StringComparison.Ordinal)) SupportService.Shared.Revoke(_device.Id);
            await SendJsonDirect(new { t = "error", code = "ended", message = $"Headroom Server is stopped on {HostInfo.Name}." });
            await CloseAsync(WebSocketCloseStatus.NormalClosure, "stopped");
            return false;
        }
        var cfg = ConfigStore.Current;
        var rights = AuthService.Allowed(_device.Id) ?? new SessionRights(false, false, false, _device.Id.StartsWith("guest:", StringComparison.Ordinal));
        _rights = rights;
        _viewOnly = !rights.Input;
        _audioAllowed = AudioPermitted;
        Log.Info("session", $"{Id}: '{_device.Name}' connected from {_remoteIp}");

        await SendJsonDirect(new
        {
            t = "welcome",
            session = Id,
            touchPinch = true,
            host = HostInfo.Describe(),
            monitors = Displays.Enumerate().Select(MonitorJson).ToArray(),
            device = new { id = _device.Id, name = _device.Name },
            permissions = new
            {
                input = !_viewOnly,
                clipboard = rights.Clipboard,
                files = rights.Files,
                audio = _audioAllowed,
            },
            limits = new { maxFps = cfg.Video.MaxFps, maxBitrateKbps = cfg.Video.MaxBitrateKbps },
            elevated = InputInjector.IsSystem,
            hostTimeUs = NowUs,
            resumeToken,
            support = resumeToken != null ? true : (bool?)null,
            relayPath,
        });
        _welcomeSentUs = NowUs;
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
        // Sound is this PC's setting (not a right of its own): turned off, it stops for running sessions too.
        bool audio = AudioPermitted;
        lock (_rightsGate)
        {
            if (r == _rights && audio == _audioAllowed) return;
            _rights = r;
            _viewOnly = !r.Input;
            _audioAllowed = audio;
        }
        if (!r.Input) InputInjector.Instance.ReleaseAll(_input);
        if (!audio) SetAudio(false);
        SyncClipboard();
        Enqueue(new
        {
            t = "permissions",
            permissions = new { input = r.Input, files = r.Files, clipboard = r.Clipboard, audio },
        });
        Log.Info("session", $"{Id}: now control={r.Input} files={r.Files} clipboard={r.Clipboard} sound={audio}");
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
            case Wire.TouchPinch when b.Length == 14:
            {
                int phase = b[1]; // begin, update, end, cancel
                if (phase > 3) return;
                var mon = _pipeline?.Source?.Monitor ?? _pipeline?.Monitor;
                (int, int, int) points = default;
                if (phase <= 1)
                {
                    if (mon == null || mon.Width < 3 || mon.Height < 1) return;
                    float nx = BinaryPrimitives.ReadSingleLittleEndian(b.AsSpan(2));
                    float ny = BinaryPrimitives.ReadSingleLittleEndian(b.AsSpan(6));
                    float scale = BinaryPrimitives.ReadSingleLittleEndian(b.AsSpan(10));
                    if (!float.IsFinite(nx) || !float.IsFinite(ny) || !float.IsFinite(scale) || scale <= 0) return;
                    points = TouchPinch.Positions(mon.X, mon.Y, mon.Width, mon.Height,
                        Math.Clamp(nx, 0, 1), Math.Clamp(ny, 0, 1), mon.Scale, Math.Clamp(scale, 0.05f, 12f));
                }
                InputInjector.Instance.Pinch(_input, phase, points, () => !_closed && !_viewOnly,
                    () => Enqueue(new { t = "pinchUnavailable" }));
                break;
            }
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
                if (_welcomeSentUs > 0)
                {
                    _handshakeRttMs = (NowUs - _welcomeSentUs) / 1000.0;
                    _welcomeSentUs = 0;
                }
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
                RequestAudio(root, "mode", "priority", start: false);
                SetAudio(Bool(root, "enabled"));
                break;
            case "file-token" when rights.Files:
            {
                var path = Str(root, "path");
                if (path != null && _device != null)
                {
                    var tok = AuthService.CreateEphemeral(_device.Id, "download", path, TimeSpan.FromMinutes(2));
                    object? id = (object?)Str(root, "id") ?? Int(root, "id");
                    Enqueue(new { t = "file-token", path, token = tok, id });
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
        if (!retry)
        {
            RequestAudio(root, "audioMode", "audioPriority", start: true);
            SetAudio(root.TryGetProperty("audio", out var a) ? a.GetBoolean() : (bool?)null);
        }
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
            MaxBitrateKbps = _maxKbps,
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

    /// <summary>This PC's settings let the session have its sound.</summary>
    private bool AudioPermitted
    {
        get
        {
            var cfg = ConfigStore.Current;
            return cfg.Permissions.Audio && cfg.Audio.Enabled && !SameMachine;
        }
    }

    /// <summary>
    /// The sound the viewer asks for: in `start` (absent: Opus without priority) or `audio` (absent: as it was). Asking
    /// again, or for something else, undoes the bandwidth steps. Applied by <see cref="SetAudio"/>.
    /// </summary>
    private void RequestAudio(JsonElement root, string modeName, string priorityName, bool start)
    {
        lock (_audioGate)
        {
            bool pcm = _audioPcm, priority = _audioPriority, asked = false;
            if (root.TryGetProperty(modeName, out var m) && m.ValueKind == JsonValueKind.String)
            {
                var mode = m.GetString();
                pcm = mode == "pcm24";
                if (mode != "pcm24" && mode != "opus") _audioUnsupported = true;
                asked = true;
            }
            else if (start) pcm = false;
            if (root.TryGetProperty(priorityName, out var p) && p.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                priority = p.GetBoolean();
                asked = true;
            }
            else if (start) priority = false;
            // `start` repeats the request with every stream change: only a different one undoes the steps there.
            if (pcm != _audioPcm || priority != _audioPriority || (asked && !start)) _audioStep = 0;
            _audioPcm = pcm;
            _audioPriority = priority;
        }
    }

    /// <summary>Sound on or off (null: as it is), with what the viewer asked for (<see cref="RequestAudio"/>).</summary>
    private void SetAudio(bool? on)
    {
        bool enabled;
        lock (_audioGate) enabled = on ?? _audioEnabled;
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
        // (The viewer's messages, the tick loop and a settings change can all get here.)
        lock (_audioGate) ApplyAudioLocked(enabled, null);
    }

    /// <summary>
    /// After anything that can change the sound (asked for, stepped down, turned on or off): tells the viewer (audio-mode)
    /// and sets the transport before the first packet of it is queued (control goes out ahead of sound), then moves the
    /// subscription. Caller holds _audioGate.
    /// </summary>
    private void ApplyAudioLocked(bool enabled, string? reason)
    {
        var format = AudioFormatLocked();
        bool was = _audioEnabled, change = enabled != was || (enabled && format != _audioFormat);
        if (change)
        {
            _audioEnabled = enabled;
            _audioFormat = format;
        }
        if (enabled) TellAudioModeLocked(reason);
        if (change)
        {
            ApplyPriorityLocked();
            if (enabled && !was) AudioService.Instance.Subscribe(_onAudio, format);
            else if (!enabled) AudioService.Instance.Unsubscribe(_onAudio);
            else AudioService.Instance.Update(_onAudio, format);
        }
        lock (_rateGate)
        {
            _rateWatch.Reset();
            _rateWatchArmed = _priority && _audioStep + 1 < AudioLadder(_audioPcm).Length;
        }
    }

    /// <summary>
    /// The formats a session with priority steps down through when its path can't carry the one before: lossless (if asked
    /// for), then Opus from the top rate down.
    /// </summary>
    public static AudioService.Format[] AudioLadder(bool pcm)
    {
        var ladder = new List<AudioService.Format>();
        if (pcm) ladder.Add(new AudioService.Format(true, true, AudioService.PcmKbps));
        foreach (int kbps in AudioService.PriorityOpusKbps) ladder.Add(new AudioService.Format(false, true, kbps));
        return ladder.ToArray();
    }

    /// <summary>
    /// Where to step down to: the first format below <paramref name="from"/> whose rate fits in <paramref name="fraction"/>
    /// of what the path carried (kbps); the last one if none does. Always at least one step while there's one left.
    /// </summary>
    public static int StepDown(AudioService.Format[] ladder, int from, double carriedKbps, double fraction = 0.8)
    {
        if (from + 1 >= ladder.Length) return from;
        int i = from + 1;
        while (i < ladder.Length - 1 && AudioService.WireKbps(ladder[i]) > carriedKbps * fraction) i++;
        return i;
    }

    /// <summary>What the viewer gets now: what it asked for, less the bandwidth steps the connection forced.</summary>
    private AudioService.Format AudioFormatLocked()
    {
        if (!_audioPriority) return new AudioService.Format(_audioPcm, false, 0);
        var ladder = AudioLadder(_audioPcm);
        return ladder[Math.Min(_audioStep, ladder.Length - 1)];
    }

    /// <summary>
    /// `audio-mode` when what the viewer gets changed, or with a reason. A viewer that only ever gets Opus without
    /// priority is told nothing, as by older hosts.
    /// </summary>
    private void TellAudioModeLocked(string? reason)
    {
        var f = _audioFormat;
        if (reason == null && _audioUnsupported) reason = "unsupported";
        string mode = f.Pcm ? "pcm24" : "opus";
        int kbps = f.Pcm ? AudioService.PcmKbps : f.Priority ? f.Kbps : AudioService.NormalOpusKbps;
        string told = $"{mode}/{f.Priority}/{kbps}";
        bool assumed = _audioModeTold == null && !f.Pcm && !f.Priority;
        if (reason == null && (assumed || told == _audioModeTold)) return;
        _audioModeTold = told;
        _audioUnsupported = false;
        Enqueue(reason == null
            ? new { t = "audio-mode", mode, priority = f.Priority, kbps }
            : (object)new { t = "audio-mode", mode, priority = f.Priority, kbps, reason });
    }

    /// <summary>The transport and flow control follow the sound: priority while it's on and asked for. Caller holds _audioGate.</summary>
    private void ApplyPriorityLocked()
    {
        var f = _audioFormat;
        bool on = _audioEnabled && f.Priority;
        // Room the picture leaves for the sound: its rate with headers, and a tenth more (as the Mac host).
        _audioKbps = on ? (int)(AudioService.WireKbps(f) * 1.1) : 0;
        if (on != _priority)
        {
            long now = NowUs;
            if (on)
            {
                lock (_audioStatsGate)
                {
                    _audioDelaysUs.Clear();
                    _audioTickMaxUs = 0;
                    _audioWrittenBytes = 0;
                }
                Interlocked.Exchange(ref _audioAcceptedBytes, 0);
                Interlocked.Exchange(ref _videoBytesOut, 0);
                lock (_pingGate) _pingsOut.Clear();
                _audioLogSinceUs = now;
                _audioLogPackets = 0;
                _audioLogP95Ms = _audioLogMaxMs = 0;
            }
            _priority = on;
            SetSocketBuffers(on);
            int target, pace;
            lock (_flowGate)
            {
                // Nothing measured yet (the usual case: priority asked for in `start`): the picture starts modestly, so its
                // first big frames can't swamp a slow path before the bitrate controller has heard from it.
                if (on && _ackWindow.Count == 0 && _inflight.Count == 0 && _minRttMs == double.MaxValue)
                    _targetKbps = Math.Min(_targetKbps, Math.Max(_minKbps, PriorityStartKbps));
                if (on && _handshakeRttMs < _minRttMs) _minRttMs = _handshakeRttMs;
                target = _targetKbps;
                _paceKbps = on ? VideoPaceKbps(target, _minKbps, _pathEstimate.PaceKbps(now)) : 0;
                pace = _paceKbps;
            }
            SetVideoPace(pace, now);
            if (on) _pipeline?.SetBitrate(target);
            Log.Info("session", on ? $"{Id}: audio priority on: sound first, video paced (from {pace} kbps) in fragments of 4-16 KiB" : $"{Id}: audio priority off");
        }
        // The picture's ceiling leaves room for the sound: down to it now if the target is above.
        int ceiling = VideoCeilingKbps, lowered = 0;
        lock (_flowGate)
        {
            if (_targetKbps > ceiling)
            {
                _targetKbps = ceiling;
                lowered = ceiling;
            }
        }
        if (lowered > 0) _pipeline?.SetBitrate(lowered);
    }

    /// <summary>
    /// With audio priority, a relayed session keeps little in its loopback hop to RelayService (this socket's send buffer,
    /// the tunnel's receive buffer), so sound never queues behind much picture there. Sockets facing the network keep
    /// Windows' own sizing (its ideal send backlog follows the path): a fixed SO_SNDBUF there would also cap the bytes in
    /// flight, so on a long path it would cut the throughput, the sound's included, rather than the queue.
    /// </summary>
    private void SetSocketBuffers(bool priority)
    {
        if (!_relayed) return;
        try
        {
            if (_socket != null)
            {
                if (_socketSendBuffer < 0) _socketSendBuffer = _socket.SendBufferSize;
                _socket.SendBufferSize = priority ? PriorityLoopbackBuffer : _socketSendBuffer;
            }
            if (_tunnelSocket != null)
            {
                if (_tunnelReceiveBuffer < 0) _tunnelReceiveBuffer = _tunnelSocket.ReceiveBufferSize;
                _tunnelSocket.ReceiveBufferSize = priority ? PriorityLoopbackBuffer : _tunnelReceiveBuffer;
            }
        }
        catch (Exception ex) when (ex is System.Net.Sockets.SocketException or ObjectDisposedException)
        {
            Log.Debug("session", $"{Id}: socket buffers: {ex.Message}");
        }
    }

    /// <summary>A Stopwatch timestamp (when sound was captured) on this session's clock: <see cref="NowUs"/>, welcome's hostTimeUs, pong's host.</summary>
    private long AudioUs(long ticks)
    {
        long d = ticks - _clockStart, f = Stopwatch.Frequency;
        return d / f * 1_000_000 + d % f * 1_000_000 / f;
    }

    /// <summary>
    /// On the capture thread (or the audio clock's): queues the packet and, with priority, watches whether the way out
    /// keeps up with the sound (AudioRateWatch). Never takes _audioGate.
    /// </summary>
    private void OnAudioPacket(AudioService.Packet p)
    {
        if (!_priority)
        {
            // Drop audio rather than build a backlog: late audio is worse than a gap.
            if (_audio.Count > 25)
            {
                Interlocked.Increment(ref _audioDropped);
                return;
            }
            _audio.Enqueue((Wire.Audio(p.Codec, p.Sequence, AudioUs(p.Timestamp), p.Data), NowUs));
            _sendSignal.Release();
            return;
        }
        // Audio priority: never dropped here; up to ~2 s waits (past that the oldest goes, so the delay stays bounded), and
        // the sound steps down long before that.
        var bytes = Wire.Audio(p.Codec, p.Sequence, AudioUs(p.Timestamp), p.Data);
        long now = NowUs;
        if (_audio.Count >= PriorityAudioQueue && _audio.TryDequeue(out _)) Interlocked.Increment(ref _audioDropped);
        _audio.Enqueue((bytes, now));
        Interlocked.Add(ref _audioAcceptedBytes, bytes.Length);
        _sendSignal.Release();
        lock (_rateGate)
        {
            if (!_rateWatchArmed || _stepPending) return;
            long written;
            lock (_audioStatsGate) written = _audioWrittenBytes;
            if (_rateWatch.Update(now, AudioBacklogUs(now), Interlocked.Read(ref _audioAcceptedBytes), written) is not { } carried) return;
            _stepPending = true; // the tick loop steps down
            _stepCarriedKbps = carried;
        }
    }

    /// <summary>
    /// The path can't carry this sound: down the ladder to the highest rate that fits 80% of what it carried (at least one
    /// step), told with reason "bandwidth"; then 5 s for what queued to drain before the way to the viewer is judged again.
    /// Never back up by itself (the viewer can ask again), and never down to dropping it. Tick loop.
    /// </summary>
    private void StepAudioDown(double carriedKbps, string why)
    {
        lock (_rateGate) _stepPending = false;
        lock (_audioGate)
        {
            if (!_audioEnabled || !_audioPriority || _closed) return;
            var ladder = AudioLadder(_audioPcm);
            int from = Math.Min(_audioStep, ladder.Length - 1);
            int to = StepDown(ladder, from, carriedKbps);
            if (to <= from) return;
            _audioStep = to;
            _audioStepHoldUntilUs = NowUs + 5_000_000;
            _pathWatch.Reset();
            Log.Warn("session", $"{Id}: {why}: {Describe(ladder[from])} doesn't fit, stepping down to {Describe(ladder[to])}");
            ApplyAudioLocked(true, "bandwidth");
        }
    }

    private static string Describe(AudioService.Format f) => f.Pcm ? $"lossless ({AudioService.PcmKbps} kbps)" : $"Opus {f.Kbps} kbps";

    // ------------------------------------------------------------------------------------------- audio priority's measurements

    /// <summary>How long the oldest queued sound packet has waited (0: none queued).</summary>
    private long AudioBacklogUs(long now) => _audio.TryPeek(out var head) ? Math.Max(0, now - head.QueuedUs) : 0;

    /// <summary>Send loop, audio priority: a packet reached the socket after waiting since <paramref name="queuedUs"/>.</summary>
    private void AudioWritten(long queuedUs, int bytes)
    {
        long d = Math.Max(0, NowUs - queuedUs);
        lock (_audioStatsGate)
        {
            if (_audioDelaysUs.Count < 4000) _audioDelaysUs.Add(d);
            if (d > _audioTickMaxUs) _audioTickMaxUs = d;
            _audioWrittenBytes += bytes;
        }
    }

    /// <summary>The longest any packet waited for the socket since the last call, or the oldest one still waiting.</summary>
    private long TakeAudioTickMaxUs()
    {
        long backlog = AudioBacklogUs(NowUs);
        lock (_audioStatsGate)
        {
            long most = Math.Max(_audioTickMaxUs, backlog);
            _audioTickMaxUs = 0;
            return most;
        }
    }

    /// <summary>Sound that reached the socket plus picture handed to it, since priority went on: what goes to the viewer.</summary>
    private long PriorityBytesOut()
    {
        lock (_audioStatsGate) return _audioWrittenBytes + Interlocked.Read(ref _videoBytesOut);
    }

    /// <summary>How long sound waited from being queued to reaching the socket, since the last stats.</summary>
    public readonly record struct AudioQueueReport(int Packets, double P50Ms, double P95Ms, double MaxMs, double BacklogMs, long Dropped);

    private AudioQueueReport TakeAudioQueueReport()
    {
        long[] delays;
        lock (_audioStatsGate)
        {
            delays = _audioDelaysUs.ToArray();
            _audioDelaysUs.Clear();
        }
        double backlogMs = AudioBacklogUs(NowUs) / 1000.0;
        long dropped = Interlocked.Read(ref _audioDropped);
        if (delays.Length == 0) return new AudioQueueReport(0, 0, 0, 0, backlogMs, dropped);
        Array.Sort(delays);
        double At(double p) => delays[Math.Min(delays.Length - 1, (int)(p * delays.Length))] / 1000.0;
        return new AudioQueueReport(delays.Length, At(0.5), At(0.95), delays[delays.Length - 1] / 1000.0, backlogMs, dropped);
    }

    /// <summary>Every 30 s with audio priority: how long sound waited for the socket (the worst second's p95, and the most).</summary>
    private void LogAudioQueue(AudioQueueReport r, long now)
    {
        _audioLogPackets += r.Packets;
        _audioLogP95Ms = Math.Max(_audioLogP95Ms, r.P95Ms);
        _audioLogMaxMs = Math.Max(_audioLogMaxMs, r.MaxMs);
        if (now - _audioLogSinceUs < 30_000_000) return;
        int pongs;
        double fastest;
        lock (_pingGate)
        {
            pongs = _pongCount;
            fastest = _pongMinMs == double.MaxValue ? 0 : _pongMinMs;
        }
        Log.Info("session", $"{Id}: sound waited for the socket: p95 {_audioLogP95Ms:0.0} ms (worst second), max {_audioLogMaxMs:0.0} ms over {_audioLogPackets} packets; dropped {r.Dropped}; pings answered {pongs} (fastest {fastest:0.0} ms)");
        _audioLogSinceUs = now;
        _audioLogPackets = 0;
        _audioLogP95Ms = _audioLogMaxMs = 0;
    }

    /// <summary>Tick loop, audio priority: a ping carrying its send time (this session's clock).</summary>
    private void SendPing(long now)
    {
        if (_pings == null) return;
        lock (_pingGate)
        {
            if (!_pings.TrySendPing(now)) return; // the last one is still waiting for the connection
            _pingsOut.Add(now);
            if (_pingsOut.Count > 64) _pingsOut.RemoveAt(0);
        }
    }

    /// <summary>The viewer answered a ping (PingStream, on the receive path): its round trip, if the ping was ours.</summary>
    private void OnPong(long sentUs)
    {
        long now = NowUs;
        lock (_pingGate)
        {
            if (!_pingsOut.Contains(sentUs)) return;
            // A viewer may answer only the latest of several pings: every older one counts as answered too.
            _pingsOut.RemoveAll(t => t <= sentUs);
            double ms = Math.Max(0, now - sentUs) / 1000.0;
            _pongs.Add((now, ms));
            _pongs.RemoveAll(x => now - x.Us > 2_000_000);
            _pongCount++;
            if (ms < _pongMinMs) _pongMinMs = ms;
        }
    }

    private int PongCount
    {
        get { lock (_pingGate) return _pongCount; }
    }

    /// <summary>
    /// With audio priority: how much is queued on the way to the viewer (ms), from the pings: the smallest round trip of
    /// the last second (jitter doesn't count, a standing queue does), or how long the oldest unanswered ping has been out
    /// if that's longer, less the path's own round trip (the smallest seen, or the handshake's). Null until pings say.
    /// </summary>
    private double? PathQueueMs(long now)
    {
        lock (_pingGate)
        {
            double baseMs = Math.Min(_pongMinMs, _handshakeRttMs);
            if (baseMs == double.MaxValue) return null;
            double recent = double.MaxValue;
            foreach (var pong in _pongs)
                if (now - pong.Us <= 1_000_000 && pong.Ms < recent) recent = pong.Ms;
            double waiting = _pingsOut.Count > 0 ? Math.Max(0, now - _pingsOut[0]) / 1000.0 : 0;
            if (recent == double.MaxValue && waiting <= 0) return null;
            return Math.Max(0, Math.Max(recent == double.MaxValue ? 0 : recent, waiting) - baseMs);
        }
    }

    /// <summary>With audio priority: the fastest video may leave (0: unpaced).</summary>
    private void SetVideoPace(int kbps, long now)
    {
        lock (_paceGate) _pacer.SetRate(_priority ? kbps : 0, now);
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

    public bool CanSendRefinement
    {
        get
        {
            if (Volatile.Read(ref _videoQueued) > 0) return false;
            lock (_flowGate) return _inflight.Count == 0;
        }
    }

    public bool CanSendVideo
    {
        get
        {
            bool ok;
            if (Volatile.Read(ref _videoQueued) > 0) ok = false;
            // Audio priority: sound waiting to be sent means the connection is full, and the picture gives way first.
            else if (_priority && _audio.Count > 2) ok = false;
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
    private int _congestedTicks;              // ticks in a row that looked congested (AdaptBitrate)

    private long InflightBudgetBytes()
    {
        // ~1.5x bandwidth-delay product using delivery rate, with sane floors/caps.
        double rateBytesPerMs = DeliveryRateKbps() / 8.0;
        double rtt = _minRttMs == double.MaxValue ? 50 : _minRttMs;
        // Audio priority: about one bandwidth-delay product of picture in flight, so little of it ever waits ahead of sound.
        if (_priority) return PriorityVideoBudget(DeliveryRateKbps(), rtt);
        long bdp = (long)(rateBytesPerMs * (rtt + 40) * 1.5);
        long floor = Math.Max(256 * 1024, _targetKbps * 1000L / 8 / 10); // at least 100 ms of target bitrate
        return Math.Clamp(bdp, floor, 6 * 1024 * 1024);
    }

    /// <summary>
    /// Video allowed unacknowledged with audio priority: ~1.1x the bandwidth-delay product (the picture's delivery rate
    /// times the path's minimum RTT), at least 64 KiB, at most 6 MiB (as the Mac host).
    /// </summary>
    public static long PriorityVideoBudget(double deliveryKbps, double minRttMs) =>
        Math.Clamp((long)(deliveryKbps / 8.0 * Math.Max(0, minRttMs) * 1.1), 64 * 1024, 6 * 1024 * 1024);

    /// <summary>Queueing delay that counts as congestion: 60 ms, or 25 with audio priority.</summary>
    public static double CongestionDelayMs(bool priority) => priority ? 25 : 60;

    /// <summary>The picture's ceiling: the cap, less the sound's room with audio priority, never under the floor.</summary>
    public static int VideoCeiling(int capKbps, int minKbps, int audioKbps) => Math.Max(minKbps, capKbps - audioKbps);

    /// <summary>
    /// With audio priority, video leaves no faster than this (the send loop paces its fragments): 1.5x the bitrate target,
    /// so frames of the average size never wait while a big one (a whole new screen) is spread out instead of landing in
    /// the path's bottleneck all at once ahead of the sound. Once big frames have measured the path, its pace
    /// (VideoPathEstimate.PaceKbps: just under what the path carries for video), never above 1.5x the target nor under
    /// 100 kbps, so the picture doesn't stop (as the Mac host).
    /// </summary>
    public static int VideoPaceKbps(int targetKbps, int minKbps, double? pathKbps)
    {
        int byTarget = Math.Max(targetKbps, minKbps) * 3 / 2;
        return pathKbps is { } path ? Math.Max(100, Math.Min(byTarget, (int)path)) : byTarget;
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
        long now = NowUs;
        int newPace = 0;
        lock (_flowGate)
        {
            // Acks are cumulative-ish: anything older than the acked frame is also delivered.
            var acked = _inflight.Where(kv => (int)(kv.Key - frameId) <= 0).ToList();
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
                    // Only a frame whose transmission is a small part of its round trip says what the path's delay
                    // is: a big one (a whole new screen, a sharpening pass) is mostly its own transmission, which the
                    // estimate above can overshoot, and the min RTT fell to ~0 again. And a frame that waited behind
                    // a sharpening pass measures our own extra traffic, not the path.
                    if (!kv.Value.Behind && serializationMs < rtt / 2)
                    {
                        double sample = Math.Max(0.1, rtt - serializationMs);
                        if (sample < _minRttMs) _minRttMs = sample;
                        _srttMs = _srttMs == 0 ? sample : _srttMs * 0.875 + sample * 0.125;
                    }
                    // With audio priority a big frame also says what the path carries for video: pace by it at once.
                    if (_priority && _minRttMs != double.MaxValue
                        && _pathEstimate.Add(kv.Value.Bytes, kv.Value.FirstBytes, kv.Value.FirstUs, now, _minRttMs, kv.Value.PaceKbps))
                    {
                        _paceKbps = VideoPaceKbps(_targetKbps, _minKbps, _pathEstimate.PaceKbps(now));
                        newPace = _paceKbps;
                    }
                }
            }
            if (_inflightBytes < 0) _inflightBytes = 0;
        }
        if (newPace > 0) SetVideoPace(newPace, now);
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
        long firstUs = 0;            // when the current frame's first fragment went
        int firstBytes = 0;          // ... and how big it was
        int waitMs = Timeout.Infinite; // audio priority: the pacer holds video back, so look again then
        while (!ct.IsCancellationRequested)
        {
            if (waitMs == Timeout.Infinite) await _sendSignal.WaitAsync(ct);
            else await _sendSignal.WaitAsync(waitMs, ct);
            waitMs = Timeout.Infinite;
            while (!ct.IsCancellationRequested)
            {
                if (_control.TryDequeue(out var c))
                {
                    await _ws.SendAsync(c.Data, c.Type, true, ct);
                    continue;
                }
                if (_audio.TryDequeue(out var a))
                {
                    await _ws.SendAsync(a.Data, WebSocketMessageType.Binary, true, ct);
                    if (_priority) AudioWritten(a.QueuedUs, a.Data.Length);
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
                    int len;
                    if (_priority)
                    {
                        // Audio priority: fragments of ~20 ms of the pace (4-16 KiB), let out no faster than the pace
                        // (VideoPacer); sound and control still go out as they come.
                        long wait;
                        lock (_paceGate)
                        {
                            len = Math.Min(_pacer.FragmentPayload, data.Length - offset);
                            wait = _pacer.Take(Wire.VideoHeaderSize + len + 4, NowUs) ?? 0;
                        }
                        if (wait > 0)
                        {
                            waitMs = (int)Math.Clamp((wait + 999) / 1000, 1, 1000);
                            break;
                        }
                        Interlocked.Add(ref _videoBytesOut, Wire.VideoHeaderSize + len);
                    }
                    else len = Math.Min(Wire.MaxFragmentPayload, data.Length - offset);
                    if (offset == 0)
                    {
                        firstUs = NowUs;
                        firstBytes = len;
                    }
                    var flags = (current.KeyFrame ? Wire.VideoFlags.Key : 0)
                                | (current.Refinement ? Wire.VideoFlags.Refine : 0)
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
                            bool behind = _inflight.Values.Any(v => v.Refinement);
                            _inflight[current.FrameId] = (NowUs, data.Length, current.Refinement, behind, firstUs, firstBytes, _paceKbps);
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
            if (_priority) SendPing(now);
            bool step;
            double carried;
            lock (_rateGate)
            {
                step = _stepPending;
                carried = _stepCarriedKbps;
            }
            if (step) StepAudioDown(carried, $"its queue here held over 300 ms for 2 s while the path carried {carried:0} kbps of it");
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

    /// <summary>The most video may use: with audio priority, the cap less the sound's room.</summary>
    private int VideoCeilingKbps => _priority ? VideoCeiling(_maxKbps, _minKbps, _audioKbps) : _maxKbps;

    private void AdaptBitrate(long now)
    {
        if (_pipeline == null) return;
        // With audio priority, sound that waited for the socket means the picture is taking its room, and the pings say
        // what's queued beyond this computer.
        bool priority = _priority;
        long audioWaitUs = priority ? TakeAudioTickMaxUs() : 0;
        double? pathQueue = priority ? PathQueueMs(now) : null;
        long bytesOut = priority ? PriorityBytesOut() : 0;
        bool congested;
        long blocked;
        double usedKbps;
        lock (_flowGate)
        {
            blocked = _blockedUsSinceTick + (_blockedSinceUs != 0 ? now - _blockedSinceUs : 0);
            _blockedUsSinceTick = 0;
            if (_blockedSinceUs != 0) _blockedSinceUs = now;
            DeliveryRateKbps(); // drops acks older than a second
            usedKbps = _ackWindowBytes * 8.0 / 1000.0; // what arrived in the last second
            // Re-learn min RTT every 30 s in case the path changed (e.g. Wi-Fi -> LAN).
            if (now - _minRttResetUs > 30_000_000) { _minRttResetUs = now; if (_inflight.Count == 0) _minRttMs = double.MaxValue; }
            // With audio priority the pings' estimate (jitter doesn't count), else the frames' smoothed RTT over their minimum.
            double queueDelay = priority && pathQueue is { } q ? q : _minRttMs == double.MaxValue ? 0 : _srttMs - _minRttMs;
            // Congested = a ready frame spent >40% of a tick waiting for the network, or the path shows queueing
            // delay (bufferbloat) beyond what serialization explains, two ticks running. One big frame (a whole new
            // screen) holds the next back for a tick: that's the picture, not the link. Sharpening passes wait for an
            // idle path (CanSendRefinement), so they never count. With audio priority the threshold is 25 ms, and sound
            // that waited over 25 ms for the socket counts too.
            bool audioLate = priority && audioWaitUs > 25_000;
            _congestedTicks = blocked > 100_000 || queueDelay > CongestionDelayMs(priority) || audioLate ? _congestedTicks + 1 : 0;
            congested = _congestedTicks >= 2;
        }
        int target = _targetKbps;
        if (congested)
        {
            _lastCongestionUs = now;
            if (now - _lastRateChangeUs > 400_000)
            {
                // Multiplicative decrease, deeper when frames waited for the network nearly the whole tick. Never
                // down to what was delivered lately: that's what the screen needed (right after it was still,
                // next to nothing), not what the link carries, and dropping to it took a 10 Mb/s link under 2.
                double next = target * (blocked > 200_000 ? 0.7 : 0.8);
                target = (int)Math.Max(_minKbps, next);
            }
        }
        else if (now - _lastCongestionUs > 2_000_000 && now - _lastRateChangeUs > 1_000_000 && usedKbps > target * 0.5)
        {
            // Up only while the stream uses at least half of it: a screen that's mostly still says nothing about
            // what the link can carry (between page jumps the target climbed to 33 Mb/s on a 10 Mb/s link).
            target = Math.Min(VideoCeilingKbps, (int)(target * 1.12) + 200);
        }
        if (priority)
        {
            // With audio priority the picture never aims above ~90% of what big frames showed the path carries for it.
            double? path;
            lock (_flowGate) path = _pathEstimate.PathKbps(now);
            if (path is { } p) target = Math.Min(target, Math.Max(_minKbps, (int)(p * 0.9)));
            target = Math.Min(target, VideoCeilingKbps);
        }
        if (target != _targetKbps && Math.Abs(target - _targetKbps) > _targetKbps * 0.04)
        {
            _targetKbps = target;
            _lastRateChangeUs = now;
            _pipeline.SetBitrate(target);
        }
        if (!priority) return;
        int pace;
        lock (_flowGate)
        {
            _paceKbps = VideoPaceKbps(_targetKbps, _minKbps, _pathEstimate.PaceKbps(now));
            pace = _paceKbps;
        }
        SetVideoPace(pace, now);
        // The sound itself doesn't fit: the way to the viewer stays queued over 300 ms although the picture has already
        // yielded (paced to what the path carries for it, its bitrate cut to near its floor).
        bool videoAtFloor = _targetKbps <= _minKbps * 2;
        if (now >= _audioStepHoldUntilUs && pathQueue is { } queue
            && _pathWatch.Update(now, queue, videoAtFloor, PongCount, bytesOut) is { } carried)
            StepAudioDown(carried, $"the way to the viewer stayed queued over 300 ms for 2 s without draining (the picture at its floor; it carried ~{carried:0} kbps)");
    }

    private void SendStats(long now)
    {
        double secs = Math.Max(0.001, (now - _lastTickUs) / 1_000_000.0);
        _lastTickUs = now;
        _statsFps = Interlocked.Exchange(ref _framesSinceTick, 0);
        _statsKbps = Interlocked.Exchange(ref _bytesSinceTick, 0) * 8 / 1000.0 / secs;
        double minRtt, srtt;
        lock (_flowGate) { minRtt = _minRttMs == double.MaxValue ? 0 : _minRttMs; srtt = _srttMs; }
        if (!_priority)
        {
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
            return;
        }
        // Audio priority: how long sound waited from being queued to reaching the socket (the last second: p95 and the
        // most), what's still waiting, and what was let go (only past the ~2 s cap).
        var r = TakeAudioQueueReport();
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
            audioQueueMs = Math.Round(r.P95Ms, 1, MidpointRounding.AwayFromZero),
            audioQueueMaxMs = Math.Round(r.MaxMs, 1, MidpointRounding.AwayFromZero),
            audioBacklogMs = Math.Round(r.BacklogMs, 1, MidpointRounding.AwayFromZero),
            audioDropped = r.Dropped,
        });
        LogAudioQueue(r, now);
    }

    // ------------------------------------------------------------------------------------------- teardown

    /// <summary>Lets go of the keys and mouse buttons this viewer holds, without ending the session.</summary>
    internal void ReleaseHeldInput() => InputInjector.Instance.ReleaseAll(_input);

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
        lock (_audioGate)
        {
            if (_audioEnabled) AudioService.Instance.Unsubscribe(_onAudio);
            _audioEnabled = false;
        }
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

/// <summary>
/// The upgraded connection under a session's WebSocket. Everything passes through unchanged; on top, the session can send
/// WebSocket pings that carry their send time (8 bytes) and hears the viewer's pongs: browsers answer pings by themselves
/// (RFC 6455), as does Node's ws, and through the relay too, which only carries bytes. System.Net.WebSockets has no API
/// for either. Pings go between the WebSocket's own frames: it writes each frame with one WriteAsync (and flushes), and
/// every write and flush here takes the same lock.
/// </summary>
public sealed class PingStream : Stream
{
    private readonly Stream _inner;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private int _pinging;
    // The viewer's frames (client frames are masked), followed byte by byte to find pongs. Reads come one at a time.
    private int _part;              // 0: first byte, 1: length byte, 2: extended length, 3: mask, 4: payload
    private int _extLeft;           // extended length bytes still to come
    private long _length;           // the frame's payload length
    private long _at;               // payload bytes read
    private bool _pong, _masked;
    private int _maskAt;
    private readonly byte[] _mask = new byte[4];
    private readonly byte[] _payload = new byte[8];
    private bool _lost;             // the frames stopped making sense: no more pongs, the bytes still pass

    public PingStream(Stream inner) => _inner = inner;

    /// <summary>The 8 bytes of a pong (little-endian), on the read path: our ping's payload if it answers one of ours.</summary>
    public Action<long>? Pong { get; set; }

    /// <summary>Sends a ping carrying <paramref name="payload"/>; false (nothing sent) while the last one waits for the connection.</summary>
    public bool TrySendPing(long payload)
    {
        if (Interlocked.CompareExchange(ref _pinging, 1, 0) != 0) return false;
        _ = SendPingAsync(payload);
        return true;
    }

    public async Task SendPingAsync(long payload)
    {
        try
        {
            var frame = new byte[10];
            frame[0] = 0x89; // FIN, ping
            frame[1] = 8;    // not masked (this is the server), 8 bytes
            BinaryPrimitives.WriteInt64LittleEndian(frame.AsSpan(2), payload);
            await _writeLock.WaitAsync().ConfigureAwait(false);
            try
            {
                await _inner.WriteAsync(frame).ConfigureAwait(false);
                await _inner.FlushAsync().ConfigureAwait(false);
            }
            finally
            {
                _writeLock.Release();
            }
        }
        catch
        {
            // The connection is going: the session ends on its own.
        }
        finally
        {
            Volatile.Write(ref _pinging, 0);
        }
    }

    public override bool CanRead => _inner.CanRead;
    public override bool CanSeek => false;
    public override bool CanWrite => _inner.CanWrite;
    public override bool CanTimeout => _inner.CanTimeout;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();

    public override int Read(byte[] buffer, int offset, int count)
    {
        int n = _inner.Read(buffer, offset, count);
        if (n > 0) Scan(buffer.AsSpan(offset, n));
        return n;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        int n = await _inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        if (n > 0) Scan(buffer.Span.Slice(0, n));
        return n;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override void Write(byte[] buffer, int offset, int count)
    {
        _writeLock.Wait();
        try { _inner.Write(buffer, offset, count); }
        finally { _writeLock.Release(); }
    }

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { await _inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false); }
        finally { _writeLock.Release(); }
    }

    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override void Flush()
    {
        _writeLock.Wait();
        try { _inner.Flush(); }
        finally { _writeLock.Release(); }
    }

    public override async Task FlushAsync(CancellationToken cancellationToken)
    {
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { await _inner.FlushAsync(cancellationToken).ConfigureAwait(false); }
        finally { _writeLock.Release(); }
    }

    public override ValueTask DisposeAsync() => _inner.DisposeAsync();

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }

    /// <summary>Follows the viewer's frames through <paramref name="data"/>; never throws (a read must not fail on our account).</summary>
    private void Scan(ReadOnlySpan<byte> data)
    {
        if (_lost) return;
        try
        {
            int i = 0;
            while (i < data.Length)
            {
                switch (_part)
                {
                    case 0:
                        _pong = (data[i++] & 0x0F) == 0x0A;
                        _part = 1;
                        break;
                    case 1:
                    {
                        byte b = data[i++];
                        _masked = (b & 0x80) != 0;
                        int len = b & 0x7F;
                        _length = 0;
                        if (len >= 126)
                        {
                            _extLeft = len == 126 ? 2 : 8;
                            _part = 2;
                        }
                        else
                        {
                            _length = len;
                            Begin();
                        }
                        break;
                    }
                    case 2:
                        _length = (_length << 8) | data[i++];
                        if (--_extLeft == 0)
                        {
                            if (_length < 0) { _lost = true; return; }
                            Begin();
                        }
                        break;
                    case 3:
                        _mask[_maskAt++] = data[i++];
                        if (_maskAt == 4) Payload();
                        break;
                    default:
                    {
                        int take = (int)Math.Min(_length - _at, data.Length - i);
                        if (_pong && _length == 8)
                            for (int k = 0; k < take; k++)
                            {
                                byte v = data[i + k];
                                _payload[_at + k] = _masked ? (byte)(v ^ _mask[(_at + k) & 3]) : v;
                            }
                        i += take;
                        _at += take;
                        if (_at == _length) End();
                        break;
                    }
                }
            }
        }
        catch
        {
            _lost = true;
        }
    }

    private void Begin()
    {
        _maskAt = 0;
        if (_masked) _part = 3;
        else Payload();
    }

    private void Payload()
    {
        _at = 0;
        _part = 4;
        if (_length == 0) End();
    }

    private void End()
    {
        _part = 0;
        if (!_pong || _length != 8) return;
        try { Pong?.Invoke(BinaryPrimitives.ReadInt64LittleEndian(_payload)); }
        catch { }
    }
}

/// <summary>
/// Hands ASP.NET's WebSocket handshake a <see cref="PingStream"/> over the upgraded connection: its handshake, keep-alive
/// and framing stay exactly as they were, and the session can ping the viewer (audio priority's queue estimate).
/// Installed per /ws request ahead of the WebSockets middleware, which takes this feature when it runs.
/// </summary>
public sealed class PingUpgradeFeature : Microsoft.AspNetCore.Http.Features.IHttpUpgradeFeature
{
    private readonly Microsoft.AspNetCore.Http.Features.IHttpUpgradeFeature _inner;

    public PingUpgradeFeature(Microsoft.AspNetCore.Http.Features.IHttpUpgradeFeature inner) => _inner = inner;

    /// <summary>The upgraded connection, once there is one.</summary>
    public PingStream? Pings { get; private set; }

    public bool IsUpgradableRequest => _inner.IsUpgradableRequest;

    public async Task<Stream> UpgradeAsync()
    {
        var pings = new PingStream(await _inner.UpgradeAsync().ConfigureAwait(false));
        Pings = pings;
        return pings;
    }
}

/// <summary>
/// Paces video fragments for a session with audio priority (a token bucket): a frame bigger than the path takes at once
/// would otherwise land in its bottleneck buffer whole, and every sound packet after it waits until it drains. Sound and
/// control messages are never paced. On a slow path fragments are smaller too (~20 ms of the pace, 4-16 KiB): one 16 KiB
/// fragment holds a 2 Mb/s link for 65 ms. The same numbers as the Mac host's VideoPacer.
/// </summary>
public sealed class VideoPacer
{
    public const int SmallestFragment = 4 * 1024;

    private double _tokens;
    private long _lastUs;

    /// <summary>Bytes per second; 0: no pacing.</summary>
    public double Rate { get; private set; }

    /// <summary>Payload bytes per fragment at this pace.</summary>
    public int FragmentPayload =>
        Rate > 0 ? Math.Min(Wire.PriorityFragmentPayload, Math.Max(SmallestFragment, (int)(Rate * 0.020))) : Wire.PriorityFragmentPayload;

    /// <summary>One whole fragment may always go at once.</summary>
    public double Burst => Math.Max(FragmentPayload + Wire.VideoHeaderSize + 14, Rate * 0.010);

    public void SetRate(int kbps, long nowUs)
    {
        bool wasOff = Rate == 0;
        Rate = Math.Max(0, kbps) * 1000.0 / 8;
        if (wasOff && Rate > 0)
        {
            _tokens = Burst;
            _lastUs = nowUs;
        }
    }

    /// <summary>Takes <paramref name="bytes"/> if the bucket has them (null); otherwise how long (µs) until it will.</summary>
    public long? Take(int bytes, long nowUs)
    {
        if (Rate <= 0) return null;
        _tokens = Math.Min(Burst, _tokens + Math.Max(0, nowUs - _lastUs) * Rate / 1_000_000);
        _lastUs = nowUs;
        double need = bytes;
        if (_tokens >= need || _tokens >= Burst) // a fragment bigger than the bucket goes once it's full
        {
            _tokens -= need;
            return null;
        }
        return (long)Math.Ceiling((Math.Min(need, Burst) - _tokens) / Rate * 1_000_000);
    }
}

/// <summary>
/// What the path carries for video, measured on big frames (with audio priority): a frame's bytes (less its first
/// fragment, which leaves at once) over the time from that first fragment leaving to its ack, less the path's minimum
/// RTT. Sound sharing the path is left out by itself (its bytes cross in between). A frame paced faster than the path
/// measures the path; one paced slower measures the pace (LimitedByPace), and then the pace climbs 10% a frame until the
/// path shows (PaceKbps). The same rules as the Mac host's VideoPathEstimate.
/// </summary>
public sealed class VideoPathEstimate
{
    public readonly record struct Sample(long Us, double Kbps, bool LimitedByPace);

    public const int MinBytes = 32 * 1024;
    public const double MinSpanMs = 40;
    public const long MaxAgeUs = 15_000_000;

    private readonly List<Sample> _samples = new();

    public IReadOnlyList<Sample> Samples => _samples;

    /// <summary>A frame was acked: whether it was big and slow enough to count.</summary>
    public bool Add(int bytes, int firstFragment, long firstWriteUs, long ackUs, double minRttMs, int paceKbps)
    {
        if (bytes < MinBytes || firstWriteUs <= 0) return false;
        double spanMs = (ackUs - firstWriteUs) / 1000.0 - minRttMs;
        if (spanMs < MinSpanMs) return false;
        double kbps = Math.Max(0, bytes - firstFragment) * 8 / spanMs;
        _samples.Add(new Sample(ackUs, kbps, paceKbps > 0 && kbps >= paceKbps * 0.95));
        if (_samples.Count > 3) _samples.RemoveAt(0);
        return true;
    }

    /// <summary>The median of the last three recent samples (the lower of two): what to pace by.</summary>
    public double? Kbps(long nowUs) => Median(_samples.Where(s => nowUs - s.Us <= MaxAgeUs));

    /// <summary>The same, from samples the path limited (not the pace): what the path really carries.</summary>
    public double? PathKbps(long nowUs) => Median(_samples.Where(s => nowUs - s.Us <= MaxAgeUs && !s.LimitedByPace));

    /// <summary>
    /// What to pace video by: just under what the path showed it carries, or 10% over the pace when the last big frame was
    /// held back by the pace (the path's limit isn't known yet). Null until a recent big frame says.
    /// </summary>
    public double? PaceKbps(long nowUs)
    {
        if (_samples.Count == 0) return null;
        var last = _samples[_samples.Count - 1];
        if (nowUs - last.Us > MaxAgeUs) return null;
        if (last.LimitedByPace) return last.Kbps * 1.1;
        return PathKbps(nowUs) * 0.97;
    }

    private static double? Median(IEnumerable<Sample> samples)
    {
        var k = samples.Select(s => s.Kbps).OrderBy(x => x).ToList();
        return k.Count == 0 ? (double?)null : k[(k.Count - 1) / 2];
    }
}

/// <summary>
/// Sound with audio priority that the path can't carry: this session's queue held more than 300 ms for over 2 s while
/// sound kept reaching the socket, but less of it than was made. Then Update says how much got through (kbps), to pick
/// what fits. A stall (next to nothing got through) says nothing about the rate, and a queue that keeps up isn't too much
/// sound: both wait for the next window. The same rules as the Mac host's AudioRateWatch.
/// </summary>
public sealed class AudioRateWatch
{
    public const long BacklogLimitUs = 300_000;
    public const long WindowUs = 2_000_000;

    private bool _open;
    private long _us, _queued, _written;

    /// <summary>Per packet: how long the oldest queued packet has waited, and bytes queued and written so far. Not null: too slow, and what was carried (kbps).</summary>
    public double? Update(long nowUs, long backlogUs, long queuedBytes, long writtenBytes)
    {
        if (backlogUs <= BacklogLimitUs)
        {
            _open = false;
            return null;
        }
        if (!_open)
        {
            _open = true;
            (_us, _queued, _written) = (nowUs, queuedBytes, writtenBytes);
            return null;
        }
        long span = nowUs - _us;
        if (span <= WindowUs) return null;
        long queued = queuedBytes - _queued, written = writtenBytes - _written;
        (_us, _queued, _written) = (nowUs, queuedBytes, writtenBytes);
        if (written * 10 < queued) return null;        // a stall
        if (written * 100 >= queued * 97) return null; // keeping up with what's made
        return written * 8.0 / (span / 1000.0);        // bits per ms = kbps
    }

    public void Reset() => _open = false;
}

/// <summary>
/// The sound itself is more than the way to the viewer carries (with audio priority, the picture already at its floor):
/// the queue on the way (from pings) stayed over 300 ms for more than 2 s and didn't drain meanwhile (fell less than
/// 50 ms), while answers kept coming (a stall says nothing about the rate). A queue that drains, even slowly (what built
/// up before a step down), says the sound now fits. Then what the path carried: what was sent over the window divided by
/// (1 + the queue's growth), since a queue grows by (sent - carried) / carried. The same rules as the Mac host's
/// PathBacklogWatch.
/// </summary>
public sealed class PathBacklogWatch
{
    public const double LimitMs = 300;
    public const long WindowUs = 2_000_000;

    private bool _open;
    private long _us, _bytesOut;
    private double _delayMs;
    private int _pongs;

    /// <summary>Per tick: the queue (ms), whether the picture is at its floor, answers so far, bytes sent so far. Not null: what the path carried (kbps) when the sound doesn't fit.</summary>
    public double? Update(long nowUs, double queueDelayMs, bool videoAtFloor, int pongs, long bytesOut)
    {
        if (!videoAtFloor || !(queueDelayMs > LimitMs))
        {
            _open = false;
            return null;
        }
        if (!_open)
        {
            _open = true;
            (_us, _delayMs, _pongs, _bytesOut) = (nowUs, queueDelayMs, pongs, bytesOut);
            return null;
        }
        long spanUs = nowUs - _us;
        if (spanUs <= WindowUs) return null;
        double startDelay = _delayMs;
        int startPongs = _pongs;
        long startBytes = _bytesOut;
        (_us, _delayMs, _pongs, _bytesOut) = (nowUs, queueDelayMs, pongs, bytesOut);
        if (pongs - startPongs < 3 || !(queueDelayMs > startDelay - 50)) return null;
        double spanMs = spanUs / 1000.0;
        double growth = Math.Max(0, (queueDelayMs - startDelay) / spanMs);
        return (bytesOut - startBytes) * 8 / spanMs / (1 + growth);
    }

    public void Reset() => _open = false;
}
