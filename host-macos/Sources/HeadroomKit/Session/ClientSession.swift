import AppKit
import Foundation
import NIOWebSocket

/// One connected viewer. Owns its WebSocket transport, video pipeline, input context and subscriptions.
///
/// Latency control on TCP (same design as the Windows host): frames are never queued. The pipeline asks
/// `canSendVideo` before encoding; it's false while a frame is waiting for the socket or while
/// unacknowledged bytes exceed ~1.5x the bandwidth-delay product. Sharpening passes of a still screen ask
/// `canSendRefinement` instead: only into an idle path. The client acks each frame on arrival, which gives
/// delivery rate and queueing delay (RTT above the observed minimum) — the inputs to the bitrate controller
/// (AIMD between the min and max limits).
///
/// Audio priority (asked for by the viewer, `audioPriority`): the sound comes first. The transport never drops it and
/// keeps little picture below it; video is paced (VideoPaceControl) and may have ~1.1x the BDP in flight (a floor of ~60 ms
/// of the pace, 16–64 KiB), congestion starts at 25 ms of queueing (or sound waiting 25 ms for the socket), and the video
/// ceiling leaves room for the sound. If the path can't
/// carry the sound (AudioRateWatch), it steps down: lossless -> Opus 510 -> 256 -> 128 -> 64 kbps, each step announced
/// with `audio-mode`; only the viewer moves it back up.
public final class ClientSession: WebSocketPeer, VideoSink {
    public let id = Bytes.base64Url(Bytes.random(6))
    public let connectedAt = Date()
    public private(set) var device: PairedDevice?
    public var remoteAddress: String { (transport?.remoteIP ?? "?") + (transport?.relayed == true ? " (via relay)" : "") }
    /// The viewer's country, as the relay saw it.
    public var country: String? { transport?.country }
    /// What this session may do (shown, and changeable for guests, in the settings window).
    public private(set) var rights = SessionRights(input: false, files: false, clipboard: false, guest: false)

    private weak var transport: WebSocketTransport?
    private let input = InputContext()
    private var pipeline: VideoPipeline?
    private var cursorSource: CaptureSource?
    private var sentShapes = Set<UInt32>()
    private let shapesLock = NSLock()
    private var viewOnly = false
    private var audioEnabled = false
    /// Whether this computer's settings let the session have its sound, as the viewer was last told (welcome, permissions).
    private var audioAllowed = false
    // What sound the viewer asked for (session queue): Opus or lossless, with or without audio priority. With priority,
    // `audioStep` is how far down the ladder (audioLadder) the path made it step; only the viewer moves it back up.
    private var audioMode: AudioService.Mode = .opus
    private var audioPriority = false
    private var audioStep = 0
    /// Asked for a mode this host doesn't have: said with the next audio-mode.
    private var audioUnsupported = false
    private var subscribedFormat: AudioService.Format?
    /// The last audio-mode sent (nil: none yet, so the viewer assumes Opus without priority).
    private var announcedFormat: AudioService.Format?
    /// Audio on with priority: the transport and flow control are set for it.
    private var priorityActive = false
    // The step-down watch, run per packet on the audio queue (under audioLock).
    private let audioLock = NSLock()
    private var rateWatch = AudioRateWatch()
    private var rateWatchArmed = false
    private var stepPending = false
    /// The end-to-end rule (session queue): the path's queueing delay stayed over 300 ms for 2 s with the picture already
    /// at its floor, so the sound itself doesn't fit. After any step, 5 s for the queue to drain before judging again.
    private var fitWatch = AudioFitWatch()
    private var audioStepHoldUntilUs: Int64 = 0
    /// When the sound last stepped (down or up): recovery waits 15 s after it.
    private var lastStepUs: Int64 = 0
    // Stalls (session queue): over 250 ms without a pong or an ack, ended by a burst of answers whose round trips fall
    // (the held pings released together). A stall says nothing about the path's rate: the fit watch starts over after
    // one, and steps at most one rung within 5 s of it. A gap after which answers keep coming later and later is the
    // path slowing down, not a stall (a drop to 300 kb/s spaces the answers over 250 ms apart).
    private var stalls = StallDetector()
    private var lastStallEndUs: Int64 = .min / 2
    /// What the path carries, from the pings as markers (PathRateMeter), and the picture's share of the last reading
    /// taken while backed up, kept for 20 s (with 10 s the pace climbed back over it on a link still slow). Session queue.
    private var rateMeter = PathRateMeter()
    private var videoShareCap: (kbps: Int, untilUs: Int64)?
    private var pingTimer: DispatchSourceTimer?
    // How long sound waited for the socket, logged every 30 s (session queue).
    private var audioLogSinceUs: Int64 = 0
    private var audioLogPackets = 0
    private var audioLogP95Ms = 0.0
    private var audioLogMaxMs = 0.0
    private var epochBase = 0
    private var lastClipboardSent: String?
    private let clipLock = NSLock()
    private var clipboardSubscribed = false
    private var handshakeDone = false
    /// A guest code was right and the person at this computer is being asked: ignore further hellos.
    private var awaitingApproval = false
    private var pendingWho: (name: String, ip: String?)?
    private var pendingTimer: DispatchSourceTimer?
    private var closed = false
    private var handshakeTimer: DispatchWorkItem?
    private var tickTimer: DispatchSourceTimer?
    private var sameMachineNotified = false
    private var timeoutLogged = false
    /// The viewer's `start`, waiting for a display: this Mac had none (its display asleep, or the lid closed). The tick
    /// keeps waking it and starts the stream as soon as one is there.
    private var waitingStart: JSONObject?
    private var lastDisplayCheckUs: Int64 = 0
    private var lastWakeUs: Int64 = 0
    private var shownNoDisplay = ""

    // Flow control / congestion state, under `flowLock` (touched by the pipeline and the event loop too).
    private let flowLock = NSLock()
    /// Frames sent and not acked yet. `behind`: sent while a sharpening pass was still on its way.
    private var inflight: [UInt32: (sentUs: Int64, bytes: Int, refinement: Bool, behind: Bool, firstUs: Int64, firstBytes: Int, paceKbps: Int)] = [:]
    private var inflightBytes = 0
    private var minRttMs = Double.greatestFiniteMagnitude
    private var minRttResetUs: Int64 = 0
    private var srttMs = 0.0
    private var ackWindow: [(us: Int64, bytes: Int)] = []
    private var ackWindowBytes = 0
    private var targetKbps: Int
    /// The bitrate controller's ceiling: `capKbps`, less the sound's room with audio priority.
    private var maxKbps: Int
    /// The viewer's cap, within this computer's limits.
    private var capKbps: Int
    private var minKbps: Int
    /// The session has audio priority: tighter in-flight budget and congestion threshold, room left for the sound.
    private var priorityFlow = false
    /// With audio priority: what big frames say the path carries for video, the pace kept from that and the pings
    /// (VideoPaceControl), and the pace in force (recorded with each frame).
    private var pathEstimate = VideoPathEstimate()
    private var paceControl = VideoPaceControl()
    private var paceKbps = 0
    /// The pings' queue estimate at the last tick (session queue).
    private var lastPathQueueMs: Double?
    /// welcome sent -> `start` received, before any sound or picture flows: the path's round trip without a queue. With
    /// audio priority it seeds the minimum RTT, which the first frames can't give when lossless sound has already filled
    /// the path (they measured 494 ms on a 40 ms path, and the queue went unseen).
    private var welcomeSentUs: Int64 = 0
    private var handshakeRttMs: Double?
    /// With audio priority the transport pings the viewer every tick: the answers' round trips (last 2 s) and the
    /// smallest seen (session queue).
    private var pongs: [(us: Int64, rttMs: Double)] = []
    private var pongCount = 0
    private var pongMinMs = Double.greatestFiniteMagnitude
    private var lastRateChangeUs: Int64 = 0
    private var lastCongestionUs: Int64 = 0
    private var blockedSinceUs: Int64 = 0
    private var blockedUsSinceTick: Int64 = 0
    private var congestedTicks = 0          // ticks in a row that looked congested (adaptBitrate)

    // Stats (atomic-ish counters under statsLock).
    private let statsLock = NSLock()
    private var framesSinceTick = 0
    private var bytesSinceTick = 0
    private var lastTickUs: Int64 = 0
    private var lastStatsUs: Int64 = 0
    private var lastReceiveUs: Int64 = 0

    init(transport: WebSocketTransport) {
        self.transport = transport
        let v = ConfigStore.current.video
        maxKbps = v.maxBitrateKbps
        capKbps = v.maxBitrateKbps
        minKbps = v.minBitrateKbps
        targetKbps = min(v.startBitrateKbps, maxKbps)
    }

    private var queue: DispatchQueue { transport?.queue ?? .global() }

    // ------------------------------------------------------------------------------------------- handshake

    public func webSocketOpened(_ t: WebSocketTransport) {
        lastReceiveUs = Clock.nowUs
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, !self.handshakeDone, !self.closed else { return }
            self.transport?.close(code: .policyViolation, reason: "expected hello")
        }
        handshakeTimer = timeout
        t.queue.asyncAfter(deadline: .now() + 10, execute: timeout)
    }

    private func handshake(_ root: JSONObject) {
        handshakeTimer?.cancel()
        let ip = transport?.remoteIP
        guard root.str("t") == "hello" else {
            transport?.close(code: .policyViolation, reason: "expected hello")
            return
        }
        if let retry = AuthService.retryAfter(ip) {
            sendJson(["t": "error", "code": "rate-limited", "retryAfter": Int(retry)])
            transport?.close(code: .policyViolation, reason: "rate limited")
            return
        }
        let guestPath = transport?.guest == true
        if let support = root["support"] as? JSONObject {
            // Guest codes only arrive through the relay's code path (which throttles guessing too).
            guard guestPath else {
                sendJson(["t": "error", "code": "bad-code", "message": "Enter the code at the Headroom website."])
                transport?.close(code: .policyViolation, reason: "code outside the relay")
                return
            }
            supportHandshake(support, root: root, ip: ip)
            return
        }
        guard !guestPath, let dev = AuthService.validateToken(root.str("token"), ip: ip) else {
            sendJson(["t": "error", "code": "unauthorized", "message": "This computer doesn't accept this sign-in right now."])
            transport?.close(code: .policyViolation, reason: "unauthorized")
            return
        }
        completeHandshake(dev, ip: ip)
    }

    /// Someone with a guest code: check it, ask the person here (always), then start a session that can resume
    /// with the key sent in `welcome`, on this computer's own relay path (the code is used up).
    private func supportHandshake(_ support: JSONObject, root: JSONObject, ip: String?) {
        guard SupportService.shared.verify(support.str("code") ?? "") else {
            AuthService.recordFailure(ip)
            sendJson(["t": "error", "code": "bad-code", "message": "That code is wrong, expired or already used. Ask for a new one."])
            transport?.close(code: .policyViolation, reason: "bad code")
            return
        }
        // The name is whatever they typed: shown as unverified. Only printable characters, kept short.
        let given = (support.str("name") ?? "").unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !CharacterSet.illegalCharacters.contains($0) }
        let trimmed = String(String.UnicodeScalarView(given)).trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmed.isEmpty ? "Someone" : String(trimmed.prefix(40))
        awaitingApproval = true
        pendingWho = (name, ip)
        let waiting: JSONObject = ["t": "pending", "message": "Waiting for the person at \(HostInfo.name) to accept…"]
        sendJson(waiting)
        // Keeps the connection alive through proxies while they decide.
        let keepAlive = DispatchSource.makeTimerSource(queue: queue)
        keepAlive.schedule(deadline: .now() + 20, repeating: 20)
        keepAlive.setEventHandler { [weak self] in self?.sendJson(waiting) }
        keepAlive.resume()
        pendingTimer = keepAlive
        SupportService.shared.requestApproval(name: name, ip: ip, country: transport?.country) { [weak self] decision in
            guard let self else { return }
            self.queue.async {
                self.pendingTimer?.cancel()
                self.pendingTimer = nil
                self.pendingWho = nil
                guard !self.closed else { return }
                guard let decision else {
                    self.sendJson(["t": "error", "code": "declined", "message": "The person at \(HostInfo.name) didn't accept."])
                    self.transport?.close(code: .policyViolation, reason: "declined")
                    return
                }
                AuthService.recordSuccess(ip)
                let (dev, token) = SupportService.shared.startSession(name: name, decision: decision, ip: ip)
                Log.info("guest", "\(self.id): guest session for '\(name)' from \(ip ?? "?")")
                var extra: JSONObject = ["resumeToken": token, "support": true]
                if let path = RelayService.shared.relayPath { extra["relayPath"] = path }
                self.completeHandshake(dev, ip: ip, extra: extra)
            }
        }
    }

    private func completeHandshake(_ dev: PairedDevice, ip: String?, extra: JSONObject = [:]) {
        // Stop server while this one was being let in (its sign-in's key looked up, an Accept): nobody can connect now.
        if ServerSwitch.shared.stopped {
            if dev.id.hasPrefix("guest:") { SupportService.shared.revoke(dev.id) }
            sendJson(["t": "error", "code": "ended", "message": "Headroom Server is stopped on \(HostInfo.name)."])
            transport?.close(code: .normalClosure, reason: "stopped")
            return
        }
        awaitingApproval = false
        device = dev
        handshakeDone = true
        let cfg = ConfigStore.current
        rights = AuthService.allowed(dev.id) ?? SessionRights(input: false, files: false, clipboard: false, guest: dev.id.hasPrefix("guest:"))
        viewOnly = !rights.input
        audioAllowed = audioPermitted
        Log.info("session", "\(id): '\(dev.name)' connected from \(ip ?? "?")")

        sendJson(extra.merging([
            "t": "welcome",
            "session": id,
            "host": HostInfo.describe(),
            "monitors": Displays.enumerate().map(\.json),
            "device": ["id": dev.id, "name": dev.name],
            "permissions": [
                "input": !viewOnly,
                "clipboard": rights.clipboard,
                "files": rights.files,
                "audio": audioAllowed,
            ],
            "limits": ["maxFps": cfg.video.maxFps, "maxBitrateKbps": cfg.video.maxBitrateKbps],
            "elevated": false,
            "hostTimeUs": Clock.nowUs,
        ]) { _, new in new })
        welcomeSentUs = Clock.nowUs
        if !viewOnly && !Permissions.accessibility && !TestInput.enabled { // test input posts nothing: no permission needed
            sendJson(["t": "notice", "level": "warn", "message": "This Mac hasn't given Headroom the Accessibility permission yet, so your mouse and keyboard can't control it. (System Settings → Privacy & Security → Accessibility)"])
        }
        SessionManager.register(self)
        startTicking()
    }

    /// What this session may do changed (from the settings window, or this computer's settings): apply it now.
    public func applyRights() {
        queue.async { [weak self] in
            guard let self, self.handshakeDone, !self.closed, let dev = self.device else { return }
            guard let r = AuthService.allowed(dev.id) else { self.disconnect("access ended"); return }
            // Sound is this computer's setting (not a right of its own): turned off, it stops for running sessions too.
            let audio = self.audioPermitted
            guard r != self.rights || audio != self.audioAllowed else { return }
            self.rights = r
            self.viewOnly = !r.input
            self.audioAllowed = audio
            if !audio { self.setAudio(false) }
            if self.viewOnly { InputInjector.shared.releaseAll(self.input) }
            if r.clipboard && self.pipeline != nil && !self.clipboardSubscribed {
                self.clipboardSubscribed = true
                ClipboardService.shared.subscribe(self) { [weak self] text in self?.onClipboardChanged(text) }
            } else if !r.clipboard && self.clipboardSubscribed {
                self.clipboardSubscribed = false
                ClipboardService.shared.unsubscribe(self)
            }
            var p = r.json
            p["audio"] = audio
            self.sendJson(["t": "permissions", "permissions": p])
            Log.info("session", "\(self.id): now control=\(r.input) files=\(r.files) clipboard=\(r.clipboard) sound=\(audio)")
        }
    }

    // ------------------------------------------------------------------------------------------- receive

    public func webSocketText(_ bytes: [UInt8]) {
        lastReceiveUs = Clock.nowUs
        guard let root = JSON.parse(bytes) else {
            Log.warn("session", "\(id): bad message")
            return
        }
        if !handshakeDone { if !awaitingApproval { handshake(root) }; return }
        handleJson(root)
    }

    public func webSocketBinary(_ b: [UInt8]) {
        lastReceiveUs = Clock.nowUs
        guard handshakeDone, !b.isEmpty else {
            if !handshakeDone { transport?.close(code: .policyViolation, reason: "expected hello") }
            return
        }
        if b[0] == Wire.frameAck, b.count >= 5 {
            onAck(b.u32(at: 1))
            return
        }
        if viewOnly { return }
        switch b[0] {
        case Wire.mouseAbs where b.count >= 9:
            let nx = Double(b.f32(at: 1)), ny = Double(b.f32(at: 5))
            guard nx.isFinite, ny.isFinite else { return }
            guard let mon = pipeline?.currentSource?.monitor ?? pipeline?.monitor else { return }
            let r = mon.bounds
            let x = r.minX + min(max(nx, 0), 0.99999) * r.width
            let y = r.minY + min(max(ny, 0), 0.99999) * r.height
            InputInjector.shared.moveTo(x, y)
        case Wire.mouseRel where b.count >= 5:
            InputInjector.shared.moveBy(Int(b.i16(at: 1)), Int(b.i16(at: 3)))
        case Wire.mouseButton where b.count >= 3:
            InputInjector.shared.button(input, Int(b[1]), down: b[2] != 0)
        case Wire.mouseWheel where b.count >= 5:
            InputInjector.shared.wheel(Int(b.i16(at: 1)), Int(b.i16(at: 3)))
        case Wire.keyEvent where b.count >= 4:
            let down = (b[1] & 1) != 0
            let len = Int(b[2])
            guard b.count >= 3 + len, let code = String(bytes: b[3..<(3 + len)], encoding: .ascii) else { return }
            InputInjector.shared.key(input, code, down: down)
        default:
            break
        }
    }

    private func handleJson(_ root: JSONObject) {
        switch root.str("t") {
        case "ping":
            sendJson(["t": "pong", "id": root.int("id") as Any?, "ts": root.double("ts") ?? 0, "host": Clock.nowUs])
        case "start":
            if welcomeSentUs > 0 {
                handshakeRttMs = Double(Clock.nowUs - welcomeSentUs) / 1000
                welcomeSentUs = 0
            }
            startStream(root)
        case "keyframe":
            pipeline?.requestKeyframe()
        case "monitors":
            sendJson(["t": "monitors", "monitors": Displays.enumerate().map(\.json)])
        case "clip" where rights.clipboard:
            if let text = root.str("text") {
                clipLock.lock(); lastClipboardSent = text; clipLock.unlock() // don't echo it back
                ClipboardService.shared.setText(text)
            }
        case "clip-get" where rights.clipboard:
            let text = ClipboardService.shared.getText()
            sendJson(["t": "clip", "text": text ?? "", "requested": true])
        case "text" where !viewOnly:
            InputInjector.shared.text(root.str("s") ?? "")
        case "locks" where !viewOnly:
            InputInjector.shared.syncLocks(caps: root.bool("caps"))
        case "release":
            InputInjector.shared.releaseAll(input)
        case "special" where !viewOnly:
            handleSpecial(root.str("action") ?? "")
        case "audio":
            takeAudioRequest(mode: root.str("mode"), priority: root.boolIfPresent("priority"), fromStart: false)
            setAudio(root.bool("enabled"))
        case "file-token" where rights.files:
            if let path = root.str("path"), let dev = device {
                let tok = AuthService.createEphemeral(deviceId: dev.id, purpose: "download", value: path, lifetime: 120)
                sendJson(["t": "file-token", "path": path, "token": tok, "id": root["id"] as Any?])
            }
        default:
            break
        }
    }

    /// The Windows-centric actions mapped to their Mac equivalents.
    private func handleSpecial(_ action: String) {
        // Test input (HEADROOM_TEST_INPUT): recorded, never performed here; ⌥⌘Esc still goes to the recorder as its keys.
        if TestInput.enabled {
            InputInjector.shared.recordSpecial(action)
            if action == "cad" { InputInjector.shared.chord(["MetaLeft", "AltLeft", "Escape"]) }
            return
        }
        switch action {
        case "cad":
            // No Ctrl+Alt+Del on a Mac: the closest thing is Force Quit Applications (⌥⌘Esc).
            InputInjector.shared.chord(["MetaLeft", "AltLeft", "Escape"])
        case "lock":
            InputInjector.shared.lockScreen()
        case "taskmgr":
            DispatchQueue.main.async {
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/System/Applications/Utilities/Activity Monitor.app"),
                                                   configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
            }
        default:
            break
        }
    }

    private func startStream(_ root: JSONObject) {
        let cfg = ConfigStore.current
        let monitors = Displays.enumerate()
        guard !monitors.isEmpty else {
            // Asleep (a sleeping display isn't listed) or the lid closed: wake it, and start when there's one to show.
            if waitingStart == nil { Log.info("session", "\(id): no display yet (asleep, or the lid is closed); waking it") }
            waitingStart = root
            takeAudioRequest(mode: root.str("audioMode"), priority: root.boolIfPresent("audioPriority"), fromStart: true)
            if let a = root.boolIfPresent("audio") { setAudio(a) } else if audioEnabled { applyAudioFormat() }
            SessionManager.wakeDisplay()
            lastWakeUs = Clock.nowUs
            tellNoDisplay()
            return
        }
        waitingStart = nil
        shownNoDisplay = ""
        let wanted = root.str("monitor")
        let monitor = monitors.first { $0.id == wanted } ?? monitors[0]
        var maxFps = min(max(root.int("maxFps") ?? cfg.video.maxFps, 5), max(5, cfg.video.maxFps))
        // Never exceed what the display can show.
        maxFps = min(maxFps, max(30, Int(monitor.refreshHz.rounded())))
        let clientMax = root.int("maxBitrateKbps") ?? cfg.video.maxBitrateKbps
        takeAudioRequest(mode: root.str("audioMode"), priority: root.boolIfPresent("audioPriority"), fromStart: true)
        let reserve = priorityActive ? audioReserveKbps : 0
        flowLock.lock()
        capKbps = min(max(clientMax, cfg.video.minBitrateKbps), cfg.video.maxBitrateKbps)
        maxKbps = Self.videoCeiling(capKbps: capKbps, minKbps: minKbps, audioKbps: reserve)
        targetKbps = min(max(targetKbps, minKbps), maxKbps)
        let bitrate = targetKbps, ceiling = maxKbps
        flowLock.unlock()
        let settings = PipelineSettings(monitor: monitor, maxFps: maxFps, bitrateKbps: bitrate, maxBitrateKbps: ceiling,
                                        maxWidth: root.int("maxWidth") ?? 0, maxHeight: root.int("maxHeight") ?? 0,
                                        encoderPreference: cfg.video.encoder)
        if let p = pipeline { p.updateSettings(settings) } else { pipeline = VideoPipeline(settings: settings, sink: self, initialEpoch: epochBase) }
        attachCursor()
        if let a = root.boolIfPresent("audio") { setAudio(a) } else if audioEnabled { applyAudioFormat() }
        if rights.clipboard && !clipboardSubscribed {
            clipboardSubscribed = true
            ClipboardService.shared.subscribe(self) { [weak self] text in self?.onClipboardChanged(text) }
        }
        Log.info("session", "\(id): stream \(monitor.id) (\(monitor.name)) max \(maxFps) fps, \(maxKbps) kbps cap, view-only=\(viewOnly)")
    }

    /// Waiting for a display (see waitingStart): once a second, look; every few, nudge it awake again and say why there's
    /// nothing yet (the lid may have been opened or closed meanwhile).
    private func followDisplays(_ now: Int64) {
        guard let request = waitingStart, now - lastDisplayCheckUs >= 1_000_000 else { return }
        lastDisplayCheckUs = now
        let monitors = Displays.enumerate()
        if !monitors.isEmpty {
            Log.info("session", "\(id): the display is awake; starting the stream")
            sendJson(["t": "monitors", "monitors": monitors.map(\.json)])
            startStream(request)
        } else if now - lastWakeUs >= 5_000_000 {
            lastWakeUs = now
            SessionManager.wakeDisplay()
            tellNoDisplay()
        }
    }

    private func tellNoDisplay() {
        let detail = Displays.noDisplayDetail
        guard detail != shownNoDisplay else { return }
        shownNoDisplay = detail
        sendJson(["t": "status", "capture": "unavailable", "detail": detail])
    }

    // ------------------------------------------------------------------------------------------- cursor

    private func attachCursor() {
        // The pipeline attaches its capture source on its own thread; this runs again from the tick loop.
        guard let src = pipeline?.currentSource, src !== cursorSource else { return }
        detachCursor()
        cursorSource = src
        src.addCursorListener(self, moved: { [weak self] s in self?.onCursorMoved(s) }, shape: { [weak self] s, shape in self?.onCursorShape(s, shape) })
        if let shape = src.shape { onCursorShape(src, shape) }
        onCursorMoved(src)
    }

    private func detachCursor() {
        cursorSource?.removeCursorListener(self)
        cursorSource = nil
    }

    private func onCursorMoved(_ s: CaptureSource) {
        let c = s.cursor
        transport?.sendBinary(Wire.cursorPos(x: c.x, y: c.y, visible: c.visible))
    }

    private func onCursorShape(_ s: CaptureSource, _ shape: CursorShape) {
        shapesLock.lock()
        let cached = !sentShapes.insert(shape.id).inserted
        shapesLock.unlock()
        transport?.sendBinary(cached
            ? Wire.cursorShapeMessage(id: shape.id, w: 0, h: 0, hotX: 0, hotY: 0, rgba: nil)
            : Wire.cursorShapeMessage(id: shape.id, w: shape.width, h: shape.height, hotX: shape.hotX, hotY: shape.hotY, rgba: shape.rgba))
    }

    // ------------------------------------------------------------------------------------------- clipboard / audio

    private func onClipboardChanged(_ text: String) {
        clipLock.lock()
        let dup = text == lastClipboardSent
        lastClipboardSent = text
        clipLock.unlock()
        if !dup { sendJson(["t": "clip", "text": text]) }
    }

    /// Viewer runs on this very Mac (loopback or one of our own addresses).
    private var sameMachine: Bool { transport?.relayed != true && NetInterfaces.isLocal(transport?.remoteIP) }

    /// This computer's settings let the session have its sound.
    private var audioPermitted: Bool {
        let cfg = ConfigStore.current
        return cfg.permissions.audio && cfg.audio.enabled && !sameMachine
    }

    private func setAudio(_ wanted: Bool) {
        let cfg = ConfigStore.current
        var enabled = wanted && cfg.audio.enabled && cfg.permissions.audio
        if enabled && sameMachine {
            // Playing captured system audio back on the same Mac re-captures it: an instant feedback loop.
            enabled = false
            if !sameMachineNotified {
                sameMachineNotified = true
                sendJson(["t": "notice", "level": "info", "message": "Audio is off: you're viewing this Mac from itself, which would echo."])
            }
        }
        guard enabled != audioEnabled else {
            if enabled { applyAudioFormat() }
            return
        }
        audioEnabled = enabled
        if enabled {
            let f = effectiveAudioFormat
            subscribedFormat = f
            AudioService.shared.subscribe(self, format: f) { [weak self] p in self?.onAudioPacket(p) }
        } else {
            AudioService.shared.unsubscribe(self)
            subscribedFormat = nil
        }
        applyAudioFormat(starting: enabled)
    }

    /// `audioMode` / `audioPriority` of a `start`, or `mode` / `priority` of an `audio` message (absent: unchanged).
    /// Asking for a mode again (an `audio` message with `mode`, a `start` with a different one, priority turned on)
    /// starts from the top again after a step down; a `start` that repeats the same mode keeps the step.
    private func takeAudioRequest(mode: String?, priority: Bool?, fromStart: Bool) {
        if let m = mode {
            let parsed = AudioService.Mode(rawValue: m)
            if parsed == nil {
                audioUnsupported = true
                Log.info("audio", "\(id): asked for sound as '\(m.prefix(16))', which this host doesn't have; Opus instead")
            }
            let next = parsed ?? .opus
            if !fromStart || next != audioMode { audioStep = 0 }
            audioMode = next
        }
        if let p = priority, p != audioPriority {
            audioPriority = p
            audioStep = 0
        }
    }

    /// The formats a session with priority steps down through when its path can't carry the one before: lossless (if
    /// asked for), then Opus from the top bitrate down.
    static func audioLadder(_ mode: AudioService.Mode) -> [AudioService.Format] {
        let opus = AudioService.opusSteps.map { AudioService.Format(mode: .opus, priority: true, kbps: $0) }
        return mode == .pcm24 ? [AudioService.Format(mode: .pcm24, priority: true)] + opus : opus
    }

    /// Where to step down to: the first format below `current` whose rate fits in `fraction` of what the path carried
    /// and leaves room to drain what's queued (`queueMs` at that rate) within 3 s; the last one if none does.
    static func stepDown(_ ladder: [AudioService.Format], from current: Int, carriedKbps: Double, queueMs: Double = 0,
                         fraction: Double = 0.8) -> Int {
        guard current + 1 < ladder.count else { return current }
        let room = min(carriedKbps * fraction, carriedKbps - 16 - max(0, queueMs) * carriedKbps / 3000)
        var i = current + 1
        while i < ladder.count - 1 && Double(AudioService.wireKbps(ladder[i])) > room { i += 1 }
        return i
    }

    private var effectiveAudioFormat: AudioService.Format {
        guard audioPriority else { return AudioService.Format(mode: audioMode, priority: false, kbps: AudioService.configuredOpusKbps) }
        let ladder = Self.audioLadder(audioMode)
        return ladder[min(audioStep, ladder.count - 1)]
    }

    /// Room the picture leaves for the sound with audio priority (its rate plus ~10% for the network's headers).
    private var audioReserveKbps: Int { Int(Double(AudioService.wireKbps(effectiveAudioFormat)) * 1.1) }

    /// What a format needs from the path (kbps): the sound and its headers, 5%, and a little picture.
    static func needKbps(_ f: AudioService.Format) -> Double { Double(AudioService.wireKbps(f)) * 1.05 + 64 }

    private static func kbps(_ f: AudioService.Format) -> Int {
        f.mode == .pcm24 ? AudioService.pcm24Kbps : f.priority ? f.kbps : AudioService.configuredOpusKbps
    }

    private static func describe(_ f: AudioService.Format) -> String {
        f.mode == .pcm24 ? "lossless (\(AudioService.pcm24Kbps) kbps)" : "Opus \(kbps(f)) kbps"
    }

    /// After anything that can change this session's sound: asked for, stepped down, turned on or off. Sets the
    /// transport and flow control for priority, moves the subscription, and tells the viewer (audio-mode) when what
    /// it gets differs from what it was told (or assumes: Opus without priority).
    private func applyAudioFormat(reason: String? = nil, starting: Bool = false) {
        let active = audioEnabled && audioPriority
        if active != priorityActive {
            priorityActive = active
            transport?.setAudioPriority(active)
            flowLock.lock()
            priorityFlow = active
            // Nothing measured yet (the usual case: priority asked for with the stream's start): the picture starts
            // modestly, so its first big frames can't swamp a slow path before the bitrate controller has heard from it.
            let nothingMeasured = ackWindow.isEmpty && inflight.isEmpty && minRttMs == .greatestFiniteMagnitude
            if active && nothingMeasured { targetKbps = min(targetKbps, max(minKbps, Self.priorityStartKbps)) }
            if active, let h = handshakeRttMs, h < minRttMs { minRttMs = h }
            let target = targetKbps
            // The pace starts at 1.5 Mb/s until paced frames have measured the path (the first keyframe of a text page is
            // ~115 kB whatever the bitrate: at 3.75 Mb/s it filled a 2 Mb/s path's buffer ahead of the sound), or at
            // the bitrate a stream already running had settled on. Only frames paced from now on measure the path.
            pathEstimate = VideoPathEstimate()
            paceControl = VideoPaceControl(startKbps: nothingMeasured ? VideoPaceControl.startKbps : max(VideoPaceControl.startKbps, target))
            paceKbps = active ? paceControl.paceKbps : 0
            let pace = paceKbps
            flowLock.unlock()
            if active {
                transport?.setVideoPace(kbps: pace)
                pipeline?.setBitrate(target)
            }
            audioLogSinceUs = Clock.nowUs
            audioLogPackets = 0; audioLogP95Ms = 0; audioLogMaxMs = 0
            fitWatch.reset() // the transport's byte counts start over
            stalls = StallDetector()
            rateMeter = PathRateMeter()
            videoShareCap = nil
            pingTimer?.cancel()
            pingTimer = nil
            if active {
                // Pings every 100 ms: answers then come at most ~180 ms apart even with ±40 ms of jitter, so a 250 ms gap
                // is a stall, not jitter.
                let t = DispatchSource.makeTimerSource(queue: queue)
                t.schedule(deadline: .now(), repeating: .milliseconds(Self.pingIntervalMs), leeway: .milliseconds(5))
                t.setEventHandler { [weak self] in
                    guard let self, let ping = self.transport?.sendPing() else { return }
                    self.rateMeter.sent(sentUs: ping.sentUs, bytesOut: ping.bytesOut)
                }
                t.resume()
                pingTimer = t
            }
            Log.info("audio", active
                ? "\(id): audio priority on: sound first, video fragments 16 KiB, send buffer 16/48 KiB, TCP_NOTSENT_LOWAT 16 KiB"
                : "\(id): audio priority off")
        }
        applyVideoCeiling()
        guard audioEnabled else {
            audioLock.lock(); rateWatchArmed = false; rateWatch.reset(); audioLock.unlock()
            return
        }
        let f = effectiveAudioFormat
        if f != subscribedFormat {
            AudioService.shared.setFormat(self, f)
            subscribedFormat = f
        }
        audioLock.lock()
        rateWatch.reset()
        rateWatchArmed = active && audioStep + 1 < Self.audioLadder(audioMode).count
        audioLock.unlock()

        var why = reason
        if audioUnsupported { audioUnsupported = false; why = why ?? "unsupported" }
        let isDefault = f.mode == .opus && !f.priority
        let differs = announcedFormat.map { $0 != f } ?? !isDefault
        guard why != nil || differs || (starting && !isDefault) else { return }
        announcedFormat = f
        var msg: JSONObject = ["t": "audio-mode", "mode": f.mode.rawValue, "priority": f.priority, "kbps": Self.kbps(f)]
        if let why { msg["reason"] = why }
        sendJson(msg)
        Log.info("audio", "\(id): sound is \(Self.describe(f))\(f.priority ? " with priority" : "")\(why.map { " (\($0))" } ?? "")")
    }

    /// Audio queue (AudioService's): every packet for this session.
    private func onAudioPacket(_ p: AudioService.Packet) {
        guard let t = transport else { return }
        t.sendAudio(p.wire)
        audioLock.lock()
        guard rateWatchArmed, !stepPending else { audioLock.unlock(); return }
        let flow = t.audioFlow
        let verdict = rateWatch.update(nowUs: Clock.nowUs, backlogUs: flow.backlogUs, queuedBytes: flow.queuedBytes, writtenBytes: flow.writtenBytes)
        guard case .tooSlow(let carried) = verdict else { audioLock.unlock(); return }
        stepPending = true
        audioLock.unlock()
        queue.async { [weak self] in
            self?.stepAudioDown(carriedKbps: carried, why: "its queue here held over 300 ms for 2 s while the path carried \(Int(carried)) kbps of it")
        }
    }

    /// The path can't carry this sound (AudioRateWatch): one step down the ladder, or more if what it carried says so.
    /// Never back up on its own: the viewer can ask again.
    private func stepAudioDown(carriedKbps: Double?, queueMs: Double = 0, why: String) {
        audioLock.lock(); stepPending = false; audioLock.unlock()
        guard audioEnabled, audioPriority, !closed else { return }
        let ladder = Self.audioLadder(audioMode)
        let from = min(audioStep, ladder.count - 1)
        var to = carriedKbps.map { Self.stepDown(ladder, from: from, carriedKbps: $0, queueMs: queueMs) } ?? min(from + 1, ladder.count - 1)
        // Within 5 s of a stall, one rung at most: what was measured around it is no measure of the path.
        if Clock.nowUs - lastStallEndUs < 5_000_000 { to = min(to, from + 1) }
        guard to > from else { return }
        audioStep = to
        lastStepUs = Clock.nowUs
        audioStepHoldUntilUs = Clock.nowUs + 1_500_000
        if let carried = carriedKbps {
            // The picture must not take back the room the step made (a page jump flooded 300 kb/s right after one).
            flowLock.lock()
            let share = Self.videoShareKbps(capacityKbps: carried, soundKbps: Double(AudioService.wireKbps(ladder[to])))
            videoShareCap = (share, Clock.nowUs + 20_000_000)
            paceControl.limit(kbps: share)
            paceKbps = paceControl.paceKbps
            let pace = paceKbps
            flowLock.unlock()
            transport?.setVideoPace(kbps: pace)
        }
        fitWatch.reset()
        Log.warn("audio", "\(id): \(why): \(Self.describe(ladder[from])) doesn't fit, stepping down to \(Self.describe(ladder[to]))")
        applyAudioFormat(reason: "bandwidth")
    }

    /// Back up one Opus rung after a step down (never to lossless on its own: the viewer asks for that): 15 s since the
    /// last step, the path clear (under 15 ms queued) and carrying at least twice what the next rung needs, by what
    /// video was let through (its pace, or what big frames showed) plus the sound now. Announced, reason "recovered".
    private func maybeStepUp(_ now: Int64, queueMs: Double?) {
        guard audioEnabled, audioPriority, let q = queueMs else { return }
        let ladder = Self.audioLadder(audioMode)
        let highest = ladder.firstIndex { $0.mode == .opus } ?? 0 // Opus at the top rate
        let current = min(audioStep, ladder.count - 1)
        guard current > highest, now - lastStepUs >= 15_000_000 else { return }
        flowLock.lock()
        let video = max(Double(paceKbps), pathEstimate.pathKbps(nowUs: now) ?? 0)
        flowLock.unlock()
        guard Self.canStepUp(queueMs: q, carriedKbps: video + Double(AudioService.wireKbps(ladder[current])), next: ladder[current - 1]) else { return }
        audioStep = current - 1
        lastStepUs = now
        Log.info("audio", "\(id): the way to the viewer is clear again (carrying ~\(Int(video)) kbps of picture besides the sound): "
            + "\(Self.describe(ladder[current])) -> \(Self.describe(ladder[current - 1]))")
        applyAudioFormat(reason: "recovered")
    }

    /// Recovery's test (see maybeStepUp).
    static func canStepUp(queueMs: Double, carriedKbps: Double, next: AudioService.Format) -> Bool {
        queueMs < 15 && carriedKbps >= 2 * needKbps(next)
    }

    /// The picture's ceiling: with audio priority it leaves room for the sound. Session queue.
    private func applyVideoCeiling() {
        let reserve = priorityActive ? audioReserveKbps : 0
        flowLock.lock()
        let ceiling = Self.videoCeiling(capKbps: capKbps, minKbps: minKbps, audioKbps: reserve)
        guard ceiling != maxKbps else { flowLock.unlock(); return }
        maxKbps = ceiling
        var apply = false
        if targetKbps > maxKbps { targetKbps = maxKbps; apply = true }
        let target = targetKbps
        flowLock.unlock()
        if apply { pipeline?.setBitrate(target) }
    }

    static func videoCeiling(capKbps: Int, minKbps: Int, audioKbps: Int) -> Int { max(minKbps, capKbps - audioKbps) }

    // ------------------------------------------------------------------------------------------- video sink

    public func onVideoConfig(_ c: VideoStreamConfig) {
        epochBase = c.epoch
        sendJson([
            "t": "video-config", "epoch": c.epoch, "codec": c.codec,
            "description": Data(c.description).base64EncodedString(),
            "width": c.width, "height": c.height, "sourceWidth": c.sourceWidth, "sourceHeight": c.sourceHeight,
            "monitor": c.monitorId, "encoder": c.encoderName, "hardware": c.hardware, "fullRange": c.fullRange,
        ])
        queue.async { [weak self] in self?.attachCursor() }
    }

    public func onVideoFrame(_ frame: EncodedVideoFrame) {
        transport?.sendVideo(frame)
        statsLock.lock()
        framesSinceTick += 1
        bytesSinceTick += frame.data.count
        statsLock.unlock()
    }

    public func onCaptureStatus(_ status: CaptureStatus, detail: String?) {
        let s: String
        switch status {
        case .ok: s = "ok"
        case .secureDesktop: s = "secure-desktop"
        case .starting: s = "starting"
        case .unavailable: s = "unavailable"
        }
        sendJson(["t": "status", "capture": s, "detail": detail as Any?, "elevated": false])
    }

    public var canSendVideo: Bool {
        let queued = transport?.videoQueued ?? 1
        let now = Clock.nowUs
        flowLock.lock(); defer { flowLock.unlock() }
        let ok = queued == 0 && (inflight.isEmpty || (inflightBytes < inflightBudgetBytes() && inflight.count < 12))
        // The pipeline polls this every ~2 ms while it holds a frame, so what signals congestion is how *long*
        // a ready frame waited — not how many times we were asked.
        if !ok {
            if blockedSinceUs == 0 { blockedSinceUs = now }
        } else if blockedSinceUs != 0 {
            blockedUsSinceTick += now - blockedSinceUs
            blockedSinceUs = 0
        }
        return ok
    }

    public var canSendRefinement: Bool {
        let queued = transport?.videoQueued ?? 1
        flowLock.lock(); defer { flowLock.unlock() }
        return queued == 0 && inflight.isEmpty
    }

    /// ~1.5x bandwidth-delay product using delivery rate, with sane floors/caps. Caller holds flowLock.
    /// With audio priority, ~1.1x with a 64 KiB floor (priorityVideoBudget): less picture ahead of the sound.
    private func inflightBudgetBytes() -> Int {
        let rtt = minRttMs == .greatestFiniteMagnitude ? 50 : minRttMs
        if priorityFlow { return Self.priorityVideoBudget(deliveryKbps: deliveryRateKbps(), minRttMs: rtt, paceKbps: paceKbps) }
        let rateBytesPerMs = deliveryRateKbps() / 8.0
        let bdp = Int(rateBytesPerMs * (rtt + 40) * 1.5)
        let floor = max(256 * 1024, targetKbps * 1000 / 8 / 10) // at least 100 ms of target bitrate
        return min(max(bdp, floor), 6 * 1024 * 1024)
    }

    /// Video allowed unacknowledged with audio priority: ~1.1x the bandwidth-delay product (the picture's delivery rate
    /// times the path's minimum RTT), at most 6 MiB, at least ~60 ms of the pace within 16–64 KiB (a fixed 64 KiB is
    /// 260 ms of a 2 Mb/s path).
    static func priorityVideoBudget(deliveryKbps: Double, minRttMs: Double, paceKbps: Int) -> Int {
        let bdp = deliveryKbps / 8.0 * max(0, minRttMs) * 1.1 // kbps / 8 = bytes per ms
        let floor = min(max(paceKbps / 8 * 60, 16 * 1024), 64 * 1024)
        return min(max(Int(bdp), floor), 6 * 1024 * 1024)
    }

    /// Queueing delay (smoothed RTT above the minimum) that counts as congestion: 60 ms, or 25 with audio priority.
    static func congestionDelayMs(priority: Bool) -> Double { priority ? 25 : 60 }

    /// Where the picture's bitrate starts for a session with audio priority, before anything is measured.
    static let priorityStartKbps = 2500

    /// The most video may leave at with audio priority: 1.5x the bitrate target, so frames of the average size never
    /// wait while a big one (a whole new screen) is spread out instead of landing in the path's bottleneck at once.
    static func paceCeilingKbps(targetKbps: Int, minKbps: Int) -> Int { max(targetKbps, minKbps) * 3 / 2 }

    /// The picture's share of a path carrying `capacityKbps` with the sound at `soundKbps` on it: 75% of the rest (room
    /// for framing and bursts), at least 16 kbps.
    static func videoShareKbps(capacityKbps: Double, soundKbps: Double) -> Int { max(16, Int((capacityKbps - soundKbps) * 0.75)) }

    /// What arrived in the last second, in kbps (none: 0). Caller holds flowLock.
    private func sentLastSecondKbps() -> Double {
        _ = deliveryRateKbps() // drops acks older than a second
        return Double(ackWindowBytes) * 8.0 / 1000.0
    }

    /// Caller holds flowLock.
    private func deliveryRateKbps() -> Double {
        let now = Clock.nowUs
        while let first = ackWindow.first, now - first.us > 1_000_000 {
            ackWindowBytes -= first.bytes
            ackWindow.removeFirst()
        }
        guard ackWindow.count >= 2, let first = ackWindow.first else { return Double(targetKbps) }
        let spanUs = max(250_000, max(1, now - first.us))
        return Double(ackWindowBytes) * 8.0 / (Double(spanUs) / 1000.0) // bits per ms == kbps
    }

    public func videoFrameWillComplete(_ frame: EncodedVideoFrame) {
        flowLock.lock()
        let behind = inflight.values.contains { $0.refinement }
        inflight[frame.frameId] = (Clock.nowUs, frame.data.count, frame.refinement, behind, frame.firstWriteUs, frame.firstFragmentBytes, paceKbps)
        inflightBytes += frame.data.count
        flowLock.unlock()
    }

    private func onAck(_ frameId: UInt32) {
        if priorityActive { stalls.evidence(nowUs: Clock.nowUs) }
        flowLock.lock()
        let now = Clock.nowUs
        var newPace = 0
        // Acks are cumulative-ish: anything older than the acked frame is also delivered.
        for (fid, v) in inflight where Int32(bitPattern: fid &- frameId) <= 0 {
            inflight[fid] = nil
            inflightBytes -= v.bytes
            ackWindow.append((now, v.bytes))
            ackWindowBytes += v.bytes
            if fid == frameId {
                let rtt = Double(now - v.sentUs) / 1000.0
                // Remove the frame's own transmission time so a big keyframe on a modest link doesn't look like
                // queueing; what's left approximates path RTT + queueing. At the rate we may send (the target)
                // when that's higher than the delivery rate: delivery is only what the screen needed lately (when
                // little changes, little is sent), and dividing by it made frames "take" longer than the whole
                // round trip, so the min RTT fell to ~0, every RTT looked like queueing, and on any path over
                // ~60 ms the bitrate kept dropping to its floor.
                let kbps = max(deliveryRateKbps(), Double(targetKbps))
                let serializationMs = kbps > 0 ? Double(v.bytes) * 8.0 / kbps : 0
                // Only a frame whose transmission is a small part of its round trip says what the path's delay is:
                // a big one (a whole new screen, a sharpening pass) is mostly its own transmission, which the
                // estimate above can overshoot, and the min RTT fell to ~0 again. And a frame that waited behind a
                // sharpening pass measures our own extra traffic, not the path.
                if !v.behind && serializationMs < rtt / 2 {
                    let sample = max(0.1, rtt - serializationMs)
                    if sample < minRttMs { minRttMs = sample }
                    srttMs = srttMs == 0 ? sample : srttMs * 0.875 + sample * 0.125
                }
                // With audio priority a big frame paced under it also says what the path carries for video: pace by it.
                if priorityFlow && minRttMs != .greatestFiniteMagnitude && v.paceKbps > 0,
                   pathEstimate.add(bytes: v.bytes, firstFragment: v.firstBytes, firstWriteUs: v.firstUs, ackUs: now, minRttMs: minRttMs, paceKbps: v.paceKbps),
                   let sample = pathEstimate.samples.last {
                    paceControl.frame(measuredKbps: sample.kbps, limitedByPace: sample.limitedByPace, pathQueueMs: lastPathQueueMs,
                                      ceilingKbps: Self.paceCeilingKbps(targetKbps: targetKbps, minKbps: minKbps))
                    paceKbps = paceControl.paceKbps
                    newPace = paceKbps
                }
            }
        }
        if inflightBytes < 0 { inflightBytes = 0 }
        flowLock.unlock()
        if newPace > 0 { transport?.setVideoPace(kbps: newPace) }
    }

    public func webSocketPong(sentUs: Int64, rttUs: Int64) {
        let now = Clock.nowUs, ms = Double(rttUs) / 1000
        if priorityActive { rateMeter.answered(sentUs: sentUs, nowUs: now) }
        if priorityActive, let ended = stalls.pong(nowUs: now, rttMs: ms) {
            lastStallEndUs = ended
            fitWatch.reset() // only what the path does after the stall counts
        }
        pongs.append((now, ms))
        pongs.removeAll { now - $0.us > 2_000_000 }
        pongCount += 1
        if ms < pongMinMs { pongMinMs = ms }
    }

    static let pingIntervalMs = 100

    /// With audio priority: how much is queued on the way to the viewer (ms), from the pings: the smallest round trip
    /// answered within the window (jitter doesn't count, a standing queue does), less the path's own round trip (the
    /// smallest seen, or the handshake's). Session queue.
    private func pathQueueMs(_ now: Int64, windowUs: Int64 = 1_000_000) -> Double? {
        let base = min(pongMinMs, handshakeRttMs ?? .greatestFiniteMagnitude)
        guard base < .greatestFiniteMagnitude, let recent = pongs.filter({ now - $0.us <= windowUs }).map(\.rttMs).min() else { return nil }
        return max(0, recent - base)
    }

    // ------------------------------------------------------------------------------------------- periodic

    private func startTicking() {
        let now = Clock.nowUs
        lastTickUs = now
        lastStatsUs = now
        lastReceiveUs = now
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        tickTimer = t
    }

    private func tick() {
        let now = Clock.nowUs
        guard let transport else {
            webSocketClosed() // backstop: the transport is gone, so clean up even if its close never reached us
            return
        }
        if now - lastReceiveUs > 20_000_000 {
            if !timeoutLogged {
                timeoutLogged = true
                Log.info("session", "\(id): no traffic for 20 s; closing")
            }
            transport.close(code: .goingAway, reason: "timeout")
            return
        }
        attachCursor()
        if waitingStart != nil { followDisplays(now) }
        adaptBitrate(now)
        if now - lastStatsUs >= 1_000_000 {
            lastStatsUs = now
            sendStats(now)
        }
    }

    private func adaptBitrate(_ now: Int64) {
        guard let pipeline else { return }
        // With audio priority, sound that waited for the socket means the picture is taking its room; and the pings say
        // what's queued beyond this computer.
        let audioWaitUs = priorityActive ? transport?.takeAudioTickMaxUs() ?? 0 : 0
        // From answered pings only: a stall brings no new answers, so it's no evidence about the path's rate, for the
        // sound (the fit watch), the picture's pace or its bitrate. (Counting the unanswered ones grew the estimate
        // during a stall and stepped the sound down on cellular.)
        let pathQueue = priorityActive ? pathQueueMs(now) : nil
        let recentQueue = priorityActive ? pathQueueMs(now, windowUs: 500_000) : nil
        let quickQueue = priorityActive ? pathQueueMs(now, windowUs: 300_000) : nil
        let bytesOut = priorityActive ? transport?.priorityBytesOut ?? 0 : 0
        let pacedWaits = priorityActive ? transport?.takePacedWaits() ?? 0 : 0
        let capacityKbps = priorityActive ? rateMeter.kbps(nowUs: now) : nil
        let soundWire = Double(AudioService.wireKbps(effectiveAudioFormat))
        lastPathQueueMs = pathQueue
        flowLock.lock()
        let blocked = blockedUsSinceTick + (blockedSinceUs != 0 ? now - blockedSinceUs : 0)
        blockedUsSinceTick = 0
        if blockedSinceUs != 0 { blockedSinceUs = now }
        // Re-learn min RTT every 30 s in case the path changed (e.g. Wi-Fi -> Ethernet).
        if now - minRttResetUs > 30_000_000 {
            minRttResetUs = now
            if inflight.isEmpty { minRttMs = .greatestFiniteMagnitude }
        }
        // With audio priority the pings' estimate (jitter doesn't count), else the frames' smoothed RTT over their minimum.
        let queueDelay = priorityFlow ? pathQueue ?? 0 : minRttMs == .greatestFiniteMagnitude ? 0 : srttMs - minRttMs
        // Congested = a ready frame spent >40% of a tick waiting for the network, or the path shows queueing delay
        // (bufferbloat) beyond what serialization explains, two ticks running. One big frame (a whole new screen)
        // holds the next back for a tick: that's the picture, not the link. Sharpening passes wait for an idle path
        // (canSendRefinement), so they never count.
        // With audio priority the threshold is 25 ms, and sound that waited over 25 ms for the socket counts too.
        let audioLate = priorityFlow && audioWaitUs > 25_000
        congestedTicks = blocked > 100_000 || queueDelay > Self.congestionDelayMs(priority: priorityFlow) || audioLate ? congestedTicks + 1 : 0
        let congested = congestedTicks >= 2
        var target = targetKbps
        if congested {
            lastCongestionUs = now
            if now - lastRateChangeUs > 400_000 {
                // Multiplicative decrease, deeper when frames waited for the network nearly the whole tick. Never
                // down to what was delivered lately: that's what the screen needed (right after it was still,
                // next to nothing), not what the link carries, and dropping to it took a 10 Mb/s link under 2.
                let next = Double(target) * (blocked > 200_000 ? 0.7 : 0.8)
                target = Int(max(Double(minKbps), next))
            }
        } else if now - lastCongestionUs > 2_000_000 && now - lastRateChangeUs > 1_000_000 && sentLastSecondKbps() > Double(target) * 0.5 {
            // Up only while the stream uses at least half of it: a screen that's mostly still says nothing about
            // what the link can carry (between page jumps the target climbed to 33 Mb/s on a 10 Mb/s link).
            target = min(maxKbps, Int(Double(target) * 1.12) + 200)
        }
        // With audio priority the picture never aims above ~90% of what big frames showed the path carries for it.
        if priorityFlow, let path = pathEstimate.pathKbps(nowUs: now) { target = min(target, max(minKbps, Int(path * 0.9))) }
        var apply = false
        if target != targetKbps && Double(abs(target - targetKbps)) > Double(targetKbps) * 0.04 {
            targetKbps = target
            lastRateChangeUs = now
            apply = true
        }
        if priorityFlow {
            paceControl.tick(pathQueueMs: pathQueue, pacedWaits: pacedWaits, ceilingKbps: Self.paceCeilingKbps(targetKbps: targetKbps, minKbps: minKbps))
            // Backed up, with the path's rate measured: the picture gets at most 75% of what's left after the sound, for
            // 20 s after the last such reading.
            if let q = recentQueue, q > 100, let cap = capacityKbps {
                videoShareCap = (Self.videoShareKbps(capacityKbps: cap, soundKbps: soundWire), now + 20_000_000)
            }
            if let c = videoShareCap {
                if now < c.untilUs { paceControl.limit(kbps: c.kbps) } else { videoShareCap = nil }
            }
            paceKbps = paceControl.paceKbps
        }
        let pace = priorityFlow ? paceKbps : 0
        // The sound itself doesn't fit (with audio priority): the path stays queued over 300 ms although the picture is
        // already at its floor. Fresh RTT samples only: a smoothed RTT nobody updated says nothing about now.
        // The picture has yielded (paced to what the path carries for it, its bitrate cut to near its floor).
        let videoAtFloor = targetKbps <= minKbps * 2
        flowLock.unlock()
        if apply { pipeline.setBitrate(target) }
        if pace > 0 { transport?.setVideoPace(kbps: pace) }
        let needKbps = Self.needKbps(effectiveAudioFormat)
        // The path is backed up (over 100 ms queued, within 300 ms) and what it delivers, measured between pings, is
        // clearly less than the sound needs (under 90%): step now, straight to what fits and drains (the growth-based
        // estimate lagged: 423 kb/s read on 300). On a path that isn't backed up the answers come as fast as they were
        // sent, which reads near the sound's own rate: the 90% keeps that from counting.
        if priorityActive && now >= audioStepHoldUntilUs, let q = quickQueue, q > 100,
           let carried = capacityKbps, carried < needKbps * 0.9 {
            stepAudioDown(carriedKbps: carried, queueMs: q,
                          why: "the way to the viewer is backed up and delivers ~\(Int(carried)) kbps, less than the sound needs (~\(Int(needKbps)))")
        } else if priorityActive && now >= audioStepHoldUntilUs, let q = recentQueue,
           let fit = fitWatch.update(nowUs: now, queueMs: q, bytesOut: bytesOut, pongs: pongCount, needKbps: needKbps, videoAtFloor: videoAtFloor) {
            stepAudioDown(carriedKbps: fit.carriedKbps, queueMs: q, why: fit.peak
                ? "the way to the viewer queued over 450 ms without draining (it carried ~\(Int(fit.carriedKbps)) kbps)"
                : "the way to the viewer queued up while carrying ~\(Int(fit.carriedKbps)) kbps, less than the sound needs (~\(Int(needKbps)))")
        } else if priorityActive {
            maybeStepUp(now, queueMs: pathQueue)
        }
    }

    private func sendStats(_ now: Int64) {
        let secs = max(0.001, Double(now - lastTickUs) / 1_000_000)
        lastTickUs = now
        statsLock.lock()
        let frames = framesSinceTick, bytes = bytesSinceTick
        framesSinceTick = 0
        bytesSinceTick = 0
        statsLock.unlock()
        flowLock.lock()
        let minRtt = minRttMs == .greatestFiniteMagnitude ? 0 : minRttMs
        let srtt = srttMs, target = targetKbps
        flowLock.unlock()
        var stats: JSONObject = [
            "t": "stats",
            "fps": (Double(frames) / secs * 10).rounded() / 10,
            "kbps": (Double(bytes) * 8 / 1000 / secs).rounded(),
            "targetKbps": target,
            "encodeMs": ((pipeline?.lastEncodeMs ?? 0) * 100).rounded() / 100,
            "encoder": pipeline?.encoderName as Any?,
            "frameRttMs": (srtt * 10).rounded() / 10,
            "minRttMs": (minRtt * 10).rounded() / 10,
        ]
        if priorityActive, let t = transport {
            // How long sound waited from being queued to reaching the socket (last second), and what's still waiting.
            let r = t.takeAudioQueueReport()
            stats["audioQueueMs"] = (r.p95Ms * 10).rounded() / 10
            stats["audioQueueMaxMs"] = (r.maxMs * 10).rounded() / 10
            stats["audioBacklogMs"] = (r.backlogMs * 10).rounded() / 10
            stats["audioDropped"] = r.dropped
            logAudioQueue(r, now: now)
        }
        sendJson(stats)
    }

    /// Every 30 s with audio priority: how long sound waited for the socket (worst second's p95, and the maximum).
    private func logAudioQueue(_ r: AudioQueueReport, now: Int64) {
        audioLogPackets += r.packets
        audioLogP95Ms = max(audioLogP95Ms, r.p95Ms)
        audioLogMaxMs = max(audioLogMaxMs, r.maxMs)
        guard now - audioLogSinceUs >= 30_000_000 else { return }
        Log.info("audio", "\(id): sound waited for the socket: p95 \(String(format: "%.1f", audioLogP95Ms)) ms (worst second), "
            + "max \(String(format: "%.1f", audioLogMaxMs)) ms over \(audioLogPackets) packets; dropped \(r.dropped)")
        audioLogSinceUs = now
        audioLogPackets = 0
        audioLogP95Ms = 0
        audioLogMaxMs = 0
    }

    // ------------------------------------------------------------------------------------------- teardown

    /// Lets go of the keys and mouse buttons this viewer holds, without ending the session.
    func releaseHeldInput() { InputInjector.shared.releaseAll(input) }

    /// Ends the session from this side. The viewer hears why first, in words for a person, so it shows
    /// "Session ended" with the reason instead of trying to reconnect.
    public func disconnect(_ reason: String) {
        Log.info("session", "\(id): disconnect requested (\(reason))")
        let host = HostInfo.name
        let message: String
        switch reason {
        case "stopped by the person at the computer": message = "The person at \(host) stopped the session."
        case "host is shutting down": message = "Headroom Server on \(host) was stopped."
        case "device revoked", "access ended": message = "This sign-in no longer has access to \(host)."
        default: message = "\(host) ended the session."
        }
        sendJson(["t": "error", "code": "ended", "message": message])
        transport?.close(code: .normalClosure, reason: reason)
    }

    public func webSocketClosed() {
        guard !closed else { return }
        closed = true
        handshakeTimer?.cancel()
        pendingTimer?.cancel()
        if let who = pendingWho { SupportService.shared.withdraw(name: who.name, ip: who.ip) } // left while waiting
        tickTimer?.cancel()
        tickTimer = nil
        pingTimer?.cancel()
        pingTimer = nil
        InputInjector.shared.releaseAll(input)
        detachCursor()
        if audioEnabled { AudioService.shared.unsubscribe(self) }
        if clipboardSubscribed { ClipboardService.shared.unsubscribe(self) }
        let p = pipeline
        pipeline = nil
        DispatchQueue.global().async { p?.dispose() }
        if let device {
            SessionManager.unregister(self)
            let d = Int(Date().timeIntervalSince(connectedAt))
            Log.info("session", "\(id): '\(device.name)' disconnected after \(String(format: "%02d:%02d:%02d", d / 3600, d / 60 % 60, d % 60))")
        }
    }

    private func sendJson(_ obj: JSONObject) {
        transport?.sendText(JSON.bytes(obj))
    }
}

/// Sound with audio priority that the path can't carry: its queue held more than 300 ms for over 2 s while sound kept
/// reaching the socket, but less of it than was made. Then `tooSlow` says how much got through (kbps), to pick what
/// fits. A stall (next to nothing got through) says nothing about the rate, and a queue that keeps up isn't too much
/// sound: both wait for the next window.
struct AudioRateWatch {
    static let backlogLimitUs: Int64 = 300_000
    static let windowUs: Int64 = 2_000_000

    enum Verdict: Equatable {
        case fine
        case tooSlow(carriedKbps: Double)
    }

    private var window: (us: Int64, queued: Int64, written: Int64)?

    /// Per packet: how long the oldest queued packet has waited, and bytes queued / written so far.
    mutating func update(nowUs: Int64, backlogUs: Int64, queuedBytes: Int64, writtenBytes: Int64) -> Verdict {
        guard backlogUs > Self.backlogLimitUs else { window = nil; return .fine }
        guard let w = window else {
            window = (nowUs, queuedBytes, writtenBytes)
            return .fine
        }
        let span = nowUs - w.us
        guard span > Self.windowUs else { return .fine }
        window = (nowUs, queuedBytes, writtenBytes)
        let queued = queuedBytes - w.queued, written = writtenBytes - w.written
        if written * 10 < queued { return .fine }        // a stall
        if written * 100 >= queued * 97 { return .fine } // keeping up with what's made
        return .tooSlow(carriedKbps: Double(written) * 8 / (Double(span) / 1000)) // bits per ms = kbps
    }

    mutating func reset() { window = nil }
}

/// What the path carries for video, measured on big frames (with audio priority): a frame's bytes (less its first
/// fragment, which leaves at once) over the time from that first fragment leaving to its ack, less the path's minimum
/// RTT. Sound sharing the path is left out by itself (its bytes cross in between). A frame paced faster than the path
/// measures the path; one paced slower measures the pace (`limitedByPace`). VideoPaceControl paces by these.
struct VideoPathEstimate {
    struct Sample {
        let us: Int64
        let kbps: Double
        let limitedByPace: Bool
    }

    static let minBytes = 32 * 1024
    static let minSpanMs = 40.0
    static let maxAgeUs: Int64 = 15_000_000

    private(set) var samples: [Sample] = []

    /// A frame was acked: whether it was big and slow enough to count.
    @discardableResult
    mutating func add(bytes: Int, firstFragment: Int = 0, firstWriteUs: Int64, ackUs: Int64, minRttMs: Double, paceKbps: Int) -> Bool {
        guard bytes >= Self.minBytes, firstWriteUs > 0 else { return false }
        let spanMs = Double(ackUs - firstWriteUs) / 1000 - minRttMs
        guard spanMs >= Self.minSpanMs else { return false }
        let kbps = Double(max(0, bytes - firstFragment)) * 8 / spanMs
        samples.append(Sample(us: ackUs, kbps: kbps, limitedByPace: paceKbps > 0 && kbps >= Double(paceKbps) * 0.95))
        if samples.count > 3 { samples.removeFirst() }
        return true
    }

    /// The median of the last three recent samples (the lower of two): what to pace by.
    func kbps(nowUs: Int64) -> Double? { Self.median(samples.filter { nowUs - $0.us <= Self.maxAgeUs }) }

    /// The same, from samples the path limited (not the pace): what the path really carries.
    func pathKbps(nowUs: Int64) -> Double? { Self.median(samples.filter { nowUs - $0.us <= Self.maxAgeUs && !$0.limitedByPace }) }

    private static func median(_ s: [Sample]) -> Double? {
        let k = s.map(\.kbps).sorted()
        return k.isEmpty ? nil : k[(k.count - 1) / 2]
    }
}

/// Whether the sound fits the way to the viewer (with audio priority), from the queue the pings measure, every tick.
/// - Growing: over the last second the queue grew by 50 ms or more (at least 10 ms in each half), to over 100 ms, while
///   answers kept coming, and what
///   the path carried meanwhile (sent / (1 + growth): a queue grows by (sent - carried) / carried) is less than the
///   sound needs. It doesn't fit: step down now, before the viewer's buffer runs dry. The path's capacity decides, so a
///   picture flood on a path that carries the sound doesn't count.
/// - Peak: the queue is over 450 ms and not draining (fell less than 50 ms in the second), with the picture already
///   yielded (at its floor) or the path carrying less than 1.25x what the sound needs. Catches a backlog that the
///   sound's silences keep draining: lossless music, 1 s of silence in 4, built ~700 ms a cycle on 2 Mb/s.
/// A stall (no answers) says nothing about the rate. Returns what the path carried (kbps), to pick the step.
struct AudioFitWatch {
    static let growMinMs = 100.0
    static let growPerMs = 0.05 // 50 ms a second
    static let peakMs = 450.0

    private var history: [(us: Int64, queueMs: Double, bytesOut: Int64, pongs: Int)] = []

    mutating func update(nowUs: Int64, queueMs: Double, bytesOut: Int64, pongs: Int, needKbps: Double,
                         videoAtFloor: Bool) -> (carriedKbps: Double, peak: Bool)? {
        history.append((nowUs, queueMs, bytesOut, pongs))
        history.removeAll { nowUs - $0.us > 1_600_000 }
        guard let then = history.last(where: { nowUs - $0.us >= 900_000 }), pongs - then.pongs >= 3 else { return nil }
        let midQueueMs: Double = history.last(where: { nowUs - $0.us >= 400_000 })?.queueMs ?? then.queueMs
        let spanMs = Double(nowUs - then.us) / 1000
        let growth = (queueMs - then.queueMs) / spanMs
        let carried = Double(bytesOut - then.bytesOut) * 8 / spanMs / (1 + max(0, growth))
        // Growth in both halves of the second: a stall's jump and drain isn't a path that can't keep up.
        let sustained = midQueueMs - then.queueMs >= 10 && queueMs - midQueueMs >= 10
        var verdict: (carriedKbps: Double, peak: Bool)?
        if queueMs > Self.growMinMs && growth >= Self.growPerMs && sustained && carried < needKbps {
            verdict = (carried, false)
        } else if queueMs > Self.peakMs && queueMs > then.queueMs - 50 && (videoAtFloor || carried < needKbps * 1.25) {
            verdict = (carried, true)
        }
        if verdict != nil { history.removeAll() }
        return verdict
    }

    mutating func reset() { history.removeAll() }
}

/// The pace of video with audio priority (kbps). It starts at 1.5 Mb/s until paced frames have measured the path; a
/// big frame the path held back sets it just under what the path carried (0.97x), one the pace held back lifts it to
/// 1.25x that while the path stays clear (under 15 ms queued). Every tick it backs off 15% while the path is queued
/// (over 30 ms by the pings) and climbs 8% while video waited on the pace and the path stayed clear. Never above 1.5x
/// the bitrate target, never under 100 kbps.
struct VideoPaceControl {
    static let startKbps = 1500

    private(set) var kbps: Int

    init(startKbps: Int = VideoPaceControl.startKbps) { kbps = startKbps }

    mutating func frame(measuredKbps: Double, limitedByPace: Bool, pathQueueMs: Double?, ceilingKbps: Int) {
        if !limitedByPace {
            kbps = Int(measuredKbps * 0.97)
        } else if (pathQueueMs ?? 0) < 15 {
            kbps = max(kbps, Int(measuredKbps * 1.25))
        }
        clamp(ceilingKbps)
    }

    mutating func tick(pathQueueMs: Double?, pacedWaits: Int, ceilingKbps: Int) {
        if let q = pathQueueMs, q > 30 {
            kbps = kbps * 85 / 100
        } else if pacedWaits > 0 && (pathQueueMs ?? 0) < 15 {
            kbps = kbps * 108 / 100
        }
        clamp(ceilingKbps)
        // The sound over 300 ms behind: the picture all but stops (16 kb/s) until it has caught up.
        held = (pathQueueMs ?? 0) > 300
    }

    private(set) var held = false

    /// No faster than `kbps` (from a measurement of the path).
    mutating func limit(kbps cap: Int) { kbps = max(16, min(kbps, cap)) }

    /// What the pacer gets.
    var paceKbps: Int { held ? 16 : kbps }

    private mutating func clamp(_ ceiling: Int) { kbps = min(max(kbps, 100), max(ceiling, 100)) }
}

/// Stalls on the way to the viewer (with audio priority), from the pings (every 100 ms) and the frames' acks: over 250 ms
/// without either, ended by a burst, the next answer within 150 ms coming back at least 50 ms faster (the pings held
/// during the stall, released together). A gap after which the answers keep coming later and later is the path slowing
/// down (a drop to 300 kb/s spaced them over 250 ms apart), and counts as evidence like any other.
struct StallDetector {
    static let gapUs: Int64 = 250_000
    static let burstUs: Int64 = 150_000
    static let burstDropMs = 50.0

    private var lastUs: Int64 = 0
    private var gapEnd: (us: Int64, rttMs: Double)?

    /// An ack (or anything else showing the path delivers).
    mutating func evidence(nowUs: Int64) { lastUs = nowUs }

    /// A pong. Returns when a stall ended, once this answer confirms one.
    mutating func pong(nowUs: Int64, rttMs: Double) -> Int64? {
        var ended: Int64?
        if let g = gapEnd {
            let burst = nowUs - g.us <= Self.burstUs && rttMs <= g.rttMs - Self.burstDropMs
            if burst { ended = g.us }
            if burst || nowUs - g.us > Self.burstUs { gapEnd = nil }
        }
        if lastUs > 0 && nowUs - lastUs > Self.gapUs { gapEnd = (nowUs, rttMs) }
        lastUs = nowUs
        return ended
    }
}

/// What the way to the viewer carries, with the pings as markers (with audio priority): the host knows what it sent
/// between two pings, and while the path is backed up the answers come back as far apart as the path took to deliver
/// it. Rate per answer = bytes between the two pings / time between their answers; the median of the latest (up to 5
/// within 600 ms, at least 3). Only meaningful while the path is backed up (the caller checks the queue): otherwise answers come as
/// fast as they were sent. After a stall the held answers arrive together, which reads as a high rate: harmless.
struct PathRateMeter {
    private var pings: [(sentUs: Int64, bytesOut: Int64)] = []
    private var last: (arrivalUs: Int64, sentUs: Int64, bytesOut: Int64)?
    private var samples: [(us: Int64, kbps: Double)] = []

    mutating func sent(sentUs: Int64, bytesOut: Int64) {
        pings.append((sentUs, bytesOut))
        if pings.count > 64 { pings.removeFirst() }
    }

    mutating func answered(sentUs: Int64, nowUs: Int64) {
        guard let ping = pings.first(where: { $0.sentUs == sentUs }) else { return }
        pings.removeAll { $0.sentUs <= sentUs }
        if let l = last, sentUs > l.sentUs, nowUs - l.arrivalUs >= 1_000 {
            let kbps = Double(ping.bytesOut - l.bytesOut) * 8 / (Double(nowUs - l.arrivalUs) / 1000)
            samples.append((nowUs, kbps))
            samples.removeAll { nowUs - $0.us > 1_000_000 }
        }
        last = (nowUs, sentUs, ping.bytesOut)
    }

    /// kbps: the median of the latest samples (up to 5, within 600 ms; at least 3), or nil. Recent ones only: older
    /// ones, from before the path changed, kept the median up for a second after a drop.
    func kbps(nowUs: Int64) -> Double? {
        let k = samples.filter { nowUs - $0.us <= 600_000 }.suffix(5).map(\.kbps).sorted()
        return k.count >= 3 ? k[k.count / 2] : nil
    }
}
