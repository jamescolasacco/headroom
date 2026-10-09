import AppKit
import Foundation
import NIOWebSocket

/// One connected viewer. Owns its WebSocket transport, video pipeline, input context and subscriptions.
///
/// Latency control on TCP (same design as the Windows host): frames are never queued. The pipeline asks
/// `canSendVideo` before encoding; it's false while a frame is waiting for the socket or while
/// unacknowledged bytes exceed ~1.5x the bandwidth-delay product. The client acks each frame on arrival,
/// which gives delivery rate and queueing delay (RTT above the observed minimum) — the inputs to the
/// bitrate controller (AIMD between the min and max limits).
public final class ClientSession: WebSocketPeer, VideoSink {
    public let id = Bytes.base64Url(Bytes.random(6))
    public let connectedAt = Date()
    public private(set) var device: PairedDevice?
    public var remoteAddress: String { transport?.remoteIP ?? "?" }

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
    private var closed = false
    private var handshakeTimer: DispatchWorkItem?
    private var tickTimer: DispatchSourceTimer?
    private var sameMachineNotified = false
    private var timeoutLogged = false

    // Flow control / congestion state, under `flowLock` (touched by the pipeline and the event loop too).
    private let flowLock = NSLock()
    private var inflight: [UInt32: (sentUs: Int64, bytes: Int)] = [:]
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
        guard let dev = AuthService.validateToken(root.str("token"), ip: ip) else {
            sendJson(["t": "error", "code": "unauthorized", "message": "This device is not paired (or was revoked). Pair again."])
            transport?.close(code: .policyViolation, reason: "unauthorized")
            return
        }
        device = dev
        handshakeDone = true
        let cfg = ConfigStore.current
        viewOnly = dev.viewOnly || !cfg.permissions.input
        Log.info("session", "\(id): '\(dev.name)' connected from \(ip ?? "?")")

        sendJson([
            "t": "welcome",
            "session": id,
            "host": HostInfo.describe(),
            "monitors": Displays.enumerate().map(\.json),
            "device": ["id": dev.id, "name": dev.name],
            "permissions": [
                "input": !viewOnly,
                "clipboard": cfg.permissions.clipboard,
                "files": cfg.permissions.fileTransfer,
                "audio": cfg.permissions.audio && cfg.audio.enabled && !sameMachine,
            ],
            "limits": ["maxFps": cfg.video.maxFps, "maxBitrateKbps": cfg.video.maxBitrateKbps],
            "elevated": false,
            "hostTimeUs": Clock.nowUs,
        ])
        if !viewOnly && !Permissions.accessibility {
            sendJson(["t": "notice", "level": "warn", "message": "This Mac hasn't given Headroom the Accessibility permission yet, so your mouse and keyboard can't control it. (System Settings → Privacy & Security → Accessibility)"])
        }
        SessionManager.register(self)
        startTicking()
    }

    // ------------------------------------------------------------------------------------------- receive

    public func webSocketText(_ bytes: [UInt8]) {
        lastReceiveUs = Clock.nowUs
        guard let root = JSON.parse(bytes) else {
            Log.warn("session", "\(id): bad message")
            return
        }
        if !handshakeDone { handshake(root); return }
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
        let cfg = ConfigStore.current
        switch root.str("t") {
        case "ping":
            sendJson(["t": "pong", "id": root.int("id") as Any?, "ts": root.double("ts") ?? 0, "host": Clock.nowUs])
        case "start":
            startStream(root)
        case "keyframe":
            pipeline?.requestKeyframe()
        case "monitors":
            sendJson(["t": "monitors", "monitors": Displays.enumerate().map(\.json)])
        case "clip" where cfg.permissions.clipboard:
            if let text = root.str("text") {
                clipLock.lock(); lastClipboardSent = text; clipLock.unlock() // don't echo it back
                ClipboardService.shared.setText(text)
            }
        case "clip-get" where cfg.permissions.clipboard:
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
        case "file-token" where cfg.permissions.fileTransfer && !viewOnly:
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
            sendJson(["t": "status", "capture": "unavailable", "detail": "no displays"])
            return
        }
        let wanted = root.str("monitor")
        let monitor = monitors.first { $0.id == wanted } ?? monitors[0]
        var maxFps = min(max(root.int("maxFps") ?? cfg.video.maxFps, 5), max(5, cfg.video.maxFps))
        // Never exceed what the display can show.
        maxFps = min(maxFps, max(30, Int(monitor.refreshHz.rounded())))
        let clientMax = root.int("maxBitrateKbps") ?? cfg.video.maxBitrateKbps
        flowLock.lock()
        maxKbps = min(max(clientMax, cfg.video.minBitrateKbps), cfg.video.maxBitrateKbps)
        targetKbps = min(max(targetKbps, minKbps), maxKbps)
        let bitrate = targetKbps
        flowLock.unlock()
        let settings = PipelineSettings(monitor: monitor, maxFps: maxFps, bitrateKbps: bitrate,
                                        maxWidth: root.int("maxWidth") ?? 0, maxHeight: root.int("maxHeight") ?? 0,
                                        encoderPreference: cfg.video.encoder)
        if let p = pipeline { p.updateSettings(settings) } else { pipeline = VideoPipeline(settings: settings, sink: self, initialEpoch: epochBase) }
        attachCursor()
        if let a = root.boolIfPresent("audio") { setAudio(a) }
        if cfg.permissions.clipboard && !clipboardSubscribed {
            clipboardSubscribed = true
            ClipboardService.shared.subscribe(self) { [weak self] text in self?.onClipboardChanged(text) }
        }
        Log.info("session", "\(id): stream \(monitor.id) (\(monitor.name)) max \(maxFps) fps, \(maxKbps) kbps cap, view-only=\(viewOnly)")
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
    private var sameMachine: Bool { NetInterfaces.isLocal(transport?.remoteIP) }

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

    /// ~1.5x bandwidth-delay product using delivery rate, with sane floors/caps. Caller holds flowLock.
    private func inflightBudgetBytes() -> Int {
        let rateBytesPerMs = deliveryRateKbps() / 8.0
        let rtt = minRttMs == .greatestFiniteMagnitude ? 50 : minRttMs
        let bdp = Int(rateBytesPerMs * (rtt + 40) * 1.5)
        let floor = max(256 * 1024, targetKbps * 1000 / 8 / 10) // at least 100 ms of target bitrate
        return min(max(bdp, floor), 6 * 1024 * 1024)
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
        inflight[frame.frameId] = (Clock.nowUs, frame.data.count)
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
                // Remove the frame's own transmission time (bits / delivery rate) so a big keyframe on a modest
                // link doesn't look like queueing; what's left approximates path RTT + queueing.
                let kbps = deliveryRateKbps()
                let serializationMs = kbps > 0 ? Double(v.bytes) * 8.0 / kbps : 0
                let sample = max(0.1, rtt - serializationMs)
                if sample < minRttMs { minRttMs = sample }
                srttMs = srttMs == 0 ? sample : srttMs * 0.875 + sample * 0.125
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
        let delivery = deliveryRateKbps()
        // Re-learn min RTT every 30 s in case the path changed (e.g. Wi-Fi -> Ethernet).
        if now - minRttResetUs > 30_000_000 {
            minRttResetUs = now
            if inflight.isEmpty { minRttMs = .greatestFiniteMagnitude }
        }
        let queueDelay = minRttMs == .greatestFiniteMagnitude ? 0 : srttMs - minRttMs
        // Congested = a ready frame spent >40% of this tick waiting for the network, or the path shows
        // sustained queueing delay (bufferbloat) beyond what serialization explains.
        let congested = blocked > 100_000 || queueDelay > 60
        var target = targetKbps
        if congested {
            lastCongestionUs = now
            if now - lastRateChangeUs > 400_000 {
                // Multiplicative decrease, but never below what we've proven we can deliver.
                target = Int(max(Double(minKbps), min(Double(target) * 0.8, max(delivery * 0.85, Double(minKbps)))))
            }
        } else if now - lastCongestionUs > 2_000_000 && now - lastRateChangeUs > 1_000_000 {
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

    public func disconnect(_ reason: String) {
        Log.info("session", "\(id): disconnect requested (\(reason))")
        transport?.close(code: .normalClosure, reason: reason)
    }

    public func webSocketClosed() {
        guard !closed else { return }
        closed = true
        handshakeTimer?.cancel()
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
