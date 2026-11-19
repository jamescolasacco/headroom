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
    private var inflight: [UInt32: (sentUs: Int64, bytes: Int, refinement: Bool, behind: Bool)] = [:]
    private var inflightBytes = 0
    private var minRttMs = Double.greatestFiniteMagnitude
    private var minRttResetUs: Int64 = 0
    private var srttMs = 0.0
    private var ackWindow: [(us: Int64, bytes: Int)] = []
    private var ackWindowBytes = 0
    private var targetKbps: Int
    private var maxKbps: Int
    private var minKbps: Int
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
        awaitingApproval = false
        device = dev
        handshakeDone = true
        let cfg = ConfigStore.current
        rights = AuthService.allowed(dev.id) ?? SessionRights(input: false, files: false, clipboard: false, guest: dev.id.hasPrefix("guest:"))
        viewOnly = !rights.input
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
                "audio": cfg.permissions.audio && cfg.audio.enabled && !sameMachine,
            ],
            "limits": ["maxFps": cfg.video.maxFps, "maxBitrateKbps": cfg.video.maxBitrateKbps],
            "elevated": false,
            "hostTimeUs": Clock.nowUs,
        ]) { _, new in new })
        if !viewOnly && !Permissions.accessibility {
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
            guard r != self.rights else { return }
            self.rights = r
            self.viewOnly = !r.input
            if self.viewOnly { InputInjector.shared.releaseAll(self.input) }
            if r.clipboard && self.pipeline != nil && !self.clipboardSubscribed {
                self.clipboardSubscribed = true
                ClipboardService.shared.subscribe(self) { [weak self] text in self?.onClipboardChanged(text) }
            } else if !r.clipboard && self.clipboardSubscribed {
                self.clipboardSubscribed = false
                ClipboardService.shared.unsubscribe(self)
            }
            let cfg = ConfigStore.current
            var p = r.json
            p["audio"] = cfg.permissions.audio && cfg.audio.enabled && !self.sameMachine
            self.sendJson(["t": "permissions", "permissions": p])
            Log.info("session", "\(self.id): now control=\(r.input) files=\(r.files) clipboard=\(r.clipboard)")
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
            if let a = root.boolIfPresent("audio") { setAudio(a) }
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
        flowLock.lock()
        maxKbps = min(max(clientMax, cfg.video.minBitrateKbps), cfg.video.maxBitrateKbps)
        targetKbps = min(max(targetKbps, minKbps), maxKbps)
        let bitrate = targetKbps, ceiling = maxKbps
        flowLock.unlock()
        let settings = PipelineSettings(monitor: monitor, maxFps: maxFps, bitrateKbps: bitrate, maxBitrateKbps: ceiling,
                                        maxWidth: root.int("maxWidth") ?? 0, maxHeight: root.int("maxHeight") ?? 0,
                                        encoderPreference: cfg.video.encoder)
        if let p = pipeline { p.updateSettings(settings) } else { pipeline = VideoPipeline(settings: settings, sink: self, initialEpoch: epochBase) }
        attachCursor()
        if let a = root.boolIfPresent("audio") { setAudio(a) }
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
        guard enabled != audioEnabled else { return }
        audioEnabled = enabled
        if enabled {
            AudioService.shared.subscribe(self) { [weak self] p in
                self?.transport?.sendAudio(Wire.audio(seq: p.seq, timeUs: p.timeUs, opus: p.data))
            }
        } else {
            AudioService.shared.unsubscribe(self)
        }
    }

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
    private func inflightBudgetBytes() -> Int {
        let rateBytesPerMs = deliveryRateKbps() / 8.0
        let rtt = minRttMs == .greatestFiniteMagnitude ? 50 : minRttMs
        let bdp = Int(rateBytesPerMs * (rtt + 40) * 1.5)
        let floor = max(256 * 1024, targetKbps * 1000 / 8 / 10) // at least 100 ms of target bitrate
        return min(max(bdp, floor), 6 * 1024 * 1024)
    }

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
        inflight[frame.frameId] = (Clock.nowUs, frame.data.count, frame.refinement, behind)
        inflightBytes += frame.data.count
        flowLock.unlock()
    }

    private func onAck(_ frameId: UInt32) {
        flowLock.lock(); defer { flowLock.unlock() }
        let now = Clock.nowUs
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
            }
        }
        if inflightBytes < 0 { inflightBytes = 0 }
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
        flowLock.lock()
        let blocked = blockedUsSinceTick + (blockedSinceUs != 0 ? now - blockedSinceUs : 0)
        blockedUsSinceTick = 0
        if blockedSinceUs != 0 { blockedSinceUs = now }
        // Re-learn min RTT every 30 s in case the path changed (e.g. Wi-Fi -> Ethernet).
        if now - minRttResetUs > 30_000_000 {
            minRttResetUs = now
            if inflight.isEmpty { minRttMs = .greatestFiniteMagnitude }
        }
        let queueDelay = minRttMs == .greatestFiniteMagnitude ? 0 : srttMs - minRttMs
        // Congested = a ready frame spent >40% of a tick waiting for the network, or the path shows queueing delay
        // (bufferbloat) beyond what serialization explains, two ticks running. One big frame (a whole new screen)
        // holds the next back for a tick: that's the picture, not the link. Sharpening passes wait for an idle path
        // (canSendRefinement), so they never count.
        congestedTicks = blocked > 100_000 || queueDelay > 60 ? congestedTicks + 1 : 0
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
        var apply = false
        if target != targetKbps && Double(abs(target - targetKbps)) > Double(targetKbps) * 0.04 {
            targetKbps = target
            lastRateChangeUs = now
            apply = true
        }
        flowLock.unlock()
        if apply { pipeline.setBitrate(target) }
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
        sendJson([
            "t": "stats",
            "fps": (Double(frames) / secs * 10).rounded() / 10,
            "kbps": (Double(bytes) * 8 / 1000 / secs).rounded(),
            "targetKbps": target,
            "encodeMs": ((pipeline?.lastEncodeMs ?? 0) * 100).rounded() / 100,
            "encoder": pipeline?.encoderName as Any?,
            "frameRttMs": (srtt * 10).rounded() / 10,
            "minRttMs": (minRtt * 10).rounded() / 10,
        ])
    }

    // ------------------------------------------------------------------------------------------- teardown

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
