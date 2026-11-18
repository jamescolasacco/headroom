import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import NIOSSL
import NIOWebSocket

/// Keeps this computer reachable through the Headroom relay (docs/RELAY.md), always: signed in to an account,
/// your devices reach it from anywhere; signed in or not, a guest code finds it. No port forwarding, no setup.
///
/// A control WebSocket stays open to the relay. When a viewer arrives, the relay sends {"t":"open","id":…} (with
/// the viewer's address, country, and whether they came with a guest code); this computer then opens a tunnel
/// WebSocket whose binary messages carry the viewer's raw HTTP bytes, and serves it with the same HTTP stack as
/// direct connections, marked as relayed (never local, only session paths).
public final class RelayService {
    public static let shared = RelayService()

    private weak var server: HttpServer?
    private let lock = NSLock()
    private var generation = 0
    /// The relay (and credential) the control connection is for; nil when not connected or connecting.
    private var target: String?
    private var slotWaiters: [String: (Result<(slot: String, expires: Date), SupportService.CodeError>) -> Void] = [:]
    private var control: Channel?
    private var state = "off"           // off | connecting | online | retrying
    private var relayId: String?
    private var lastError: String?
    private var backoff: TimeInterval = 1
    private var nextAttempt = Date.distantPast
    private var timer: DispatchSourceTimer?
    private lazy var tls: NIOSSLContext? = {
        var c = TLSConfiguration.makeClientConfiguration()
        c.applicationProtocols = ["http/1.1"]
        return try? NIOSSLContext(configuration: c)
    }()

    public func start(server: HttpServer) {
        self.server = server
        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    private struct Target {
        let base: URL
        /// This computer's sign-in to its account; nil when it isn't signed in (then only guest codes reach it).
        let token: String?
        var key: String { base.absoluteString + "|" + (token ?? "-") }
    }

    private var wanted: Target? {
        let c = ConfigStore.current
        let server = c.account?.server ?? c.server
        guard let url = URL(string: server), url.host != nil, url.scheme == "https" || url.scheme == "http" else { return nil }
        return Target(base: url, token: c.account?.token)
    }

    private func tick() {
        let want = wanted
        lock.lock()
        let have = target, ch = control, due = Date() >= nextAttempt
        if have != nil, have != want?.key {
            // Left the account, joined another, or turned the relay off.
            generation += 1
            target = nil; control = nil; relayId = nil; lastError = nil
            backoff = 1; nextAttempt = .distantPast
            state = want == nil ? "off" : "connecting"
            let waiters = takeWaiters()
            lock.unlock()
            ch?.close(promise: nil)
            SupportService.shared.relayDropped()
            for w in waiters { w(.failure(.offline(nil))) }
            return
        }
        if want == nil { state = "off" }
        lock.unlock()
        if let want, have == nil, due { connect(want) }
    }

    // ------------------------------------------------------------------ control connection

    private func connect(_ t: Target) {
        lock.lock()
        generation += 1
        let gen = generation
        target = t.key
        if state != "retrying" { state = "connecting" }
        lock.unlock()
        let handler = RelayControlHandler { [weak self] msg in self?.onControl(msg, gen: gen, base: t.base) }
        var headers = [("X-Headroom-Host-Id", HostInfo.hostId), ("X-Headroom-Name", HostInfo.name)]
        if let token = t.token { headers.append(("Authorization", "Bearer \(token)")) }
        openWebSocket(t.base, path: "/api/relay/control", headers: headers, maxFrame: 1 << 16,
                      install: { try $0.pipeline.syncOperations.addHandler(handler) }) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let ch):
                self.lock.lock()
                let current = gen == self.generation
                if current { self.control = ch }
                self.lock.unlock()
                if !current { ch.close(promise: nil); return }
                ch.closeFuture.whenComplete { [weak self] _ in self?.dropped(gen, error: nil) }
            case .failure(let e):
                self.dropped(gen, error: e)
            }
        }
    }

    private func onControl(_ msg: JSONObject, gen: Int, base: URL) {
        switch msg.str("t") {
        case "hello":
            lock.lock()
            guard gen == generation else { lock.unlock(); return }
            let first = relayId != msg.str("relayId") || state != "online"
            relayId = msg.str("relayId")
            state = "online"
            lastError = nil
            backoff = 1
            lock.unlock()
            if first { Log.info("relay", "connected to \(base.host ?? "the relay")\(ConfigStore.current.account == nil ? " (not signed in: reachable with guest codes)" : "")") }
        case "open":
            guard let nonce = msg.str("id"), nonce.count <= 64, nonce.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return }
            let country = msg.str("country").flatMap { $0.count <= 8 && $0.allSatisfy(\.isLetter) ? $0.uppercased() : nil }
            openTunnel(base, nonce: nonce, clientIp: msg.str("client"), guest: msg.bool("guest"), country: country)
        case "slot":
            guard let id = msg.str("id") else { return }
            lock.lock(); let waiter = slotWaiters.removeValue(forKey: id); lock.unlock()
            if let slot = msg.str("slot"), slot.count == 4, slot.allSatisfy(\.isNumber) {
                let expires = msg.str("expires").flatMap(ISO8601.parse) ?? Date().addingTimeInterval(600)
                waiter?(.success((slot, expires)))
            } else {
                waiter?(.failure(.failed("Headroom is busy right now. Try again in a minute.")))
            }
        default:
            break
        }
    }

    private func dropped(_ gen: Int, error: Error?) {
        lock.lock()
        guard gen == generation else { lock.unlock(); return }
        let wasOnline = state == "online"
        target = nil
        control = nil
        relayId = nil
        let waiters = takeWaiters()
        var wait = backoff
        if let e = error as? RelayError, case .status(let code) = e {
            // Rejected: removed from the account (it notices at its next check-in), too many computers from this
            // network without an account, or no relay on that server.
            wait = code == 404 ? 300 : 60
            lastError = code == 404 ? "This server doesn't run a relay." : code == 429 ? "Too many computers from this network are connected without an account." : "The relay refused this computer (HTTP \(code))."
        } else if let error {
            lastError = Self.describe(error)
        } else {
            lastError = "Connection to the relay closed."
        }
        state = "retrying"
        nextAttempt = Date().addingTimeInterval(wait)
        backoff = min(backoff * 2, 30)
        let message = lastError ?? ""
        lock.unlock()
        SupportService.shared.relayDropped()
        for w in waiters { w(.failure(.offline(message))) }
        if wasOnline || backoff <= 2 { Log.warn("relay", "\(message) Retrying in \(Int(wait)) s.") }
    }

    private func takeWaiters() -> [(Result<(slot: String, expires: Date), SupportService.CodeError>) -> Void] { // under lock
        let w = Array(slotWaiters.values)
        slotWaiters.removeAll()
        return w
    }

    // ------------------------------------------------------------------ guest codes

    /// Asks the relay for the first 4 digits of a guest code (a "slot" that routes /c/<slot>/ here).
    func requestSlot(_ done: @escaping (Result<(slot: String, expires: Date), SupportService.CodeError>) -> Void) {
        let id = Bytes.base64Url(Bytes.random(6))
        lock.lock()
        guard let ch = control, state == "online" else {
            let why = lastError
            lock.unlock()
            done(.failure(.offline(why)))
            return
        }
        slotWaiters[id] = done
        lock.unlock()
        send(ch, ["t": "slot", "id": id])
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let w = self.slotWaiters.removeValue(forKey: id); self.lock.unlock()
            w?(.failure(.failed("Headroom didn't answer. Try again.")))
        }
    }

    /// The code was used, cancelled or withdrawn: the relay stops routing it here.
    func releaseSlot() {
        lock.lock(); let ch = control; lock.unlock()
        if let ch { send(ch, ["t": "slot-release"]) }
    }

    private func send(_ ch: Channel, _ msg: JSONObject) {
        let text = String(decoding: JSON.data(msg), as: UTF8.self)
        ch.eventLoop.execute {
            let frame = WebSocketFrame(fin: true, opcode: .text, maskKey: .random(), data: ch.allocator.buffer(string: text))
            ch.writeAndFlush(frame, promise: nil)
        }
    }

    /// Where an accepted guest's session continues (its code is used up): this computer's own path on the relay.
    var relayPath: String? {
        lock.lock(); defer { lock.unlock() }
        return state == "online" ? relayId.map { "/r/\($0)" } : nil
    }

    /// The Headroom website people open (for guest links).
    public var publicBase: String {
        let c = ConfigStore.current
        let s = c.account?.server ?? c.server
        return s.hasSuffix("/") ? String(s.dropLast()) : s
    }

    // ------------------------------------------------------------------ tunnels

    private func openTunnel(_ base: URL, nonce: String, clientIp: String?, guest: Bool, country: String?) {
        guard let server else { return }
        let ip = clientIp.flatMap { $0.count <= 64 ? NetInterfaces.normalize($0) : nil }
        openWebSocket(base, path: "/api/relay/tunnel/\(nonce)", headers: [], maxFrame: 1 << 24, install: { ch in
            try ch.pipeline.syncOperations.addHandler(WebSocketByteBridge())
            try server.adoptRelayed(ch, remoteIP: ip, guest: guest, country: country)
        }) { result in
            if case .failure(let e) = result { Log.warn("relay", "couldn't open a tunnel for \(ip ?? "?"): \(Self.describe(e))") }
        }
    }

    // ------------------------------------------------------------------ connecting

    enum RelayError: Error {
        case notReady, tls, status(Int), closed
    }

    /// Connects to the relay and upgrades to a WebSocket; `install` adds the handlers that use it (on the event loop).
    private func openWebSocket(_ base: URL, path: String, headers: [(String, String)], maxFrame: Int,
                               install: @escaping (Channel) throws -> Void, done: @escaping (Result<Channel, Error>) -> Void) {
        guard let server, let host = base.host else { done(.failure(RelayError.notReady)); return }
        let secure = base.scheme == "https"
        let port = base.port ?? (secure ? 443 : 80)
        let prefix = base.path.hasSuffix("/") ? String(base.path.dropLast()) : base.path
        var h = HTTPHeaders()
        h.add(name: "Host", value: (host.contains(":") ? "[\(host)]" : host) + (base.port.map { ":\($0)" } ?? ""))
        h.add(name: "User-Agent", value: "Headroom/\(HostInfo.version) (macOS)")
        h.add(name: "Content-Length", value: "0")
        for (k, v) in headers { h.add(name: k, value: v) }
        let tls = secure ? self.tls : nil
        if secure && tls == nil { done(.failure(RelayError.tls)); return }
        let once = Once(done)
        let headersToSend = h
        ClientBootstrap(group: server.group)
            .connectTimeout(.seconds(10))
            .channelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
            .channelOption(ChannelOptions.socketOption(.so_keepalive), value: 1)
            // Same small buffers as direct connections: the session's priority pump relies on them.
            .channelOption(ChannelOptions.writeBufferWaterMark, value: .init(low: 64 * 1024, high: 256 * 1024))
            .channelInitializer { ch in
                do {
                    if let tls {
                        try ch.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: tls, serverHostname: Self.isIPAddress(host) ? nil : host))
                    }
                    let request = UpgradeRequestHandler(path: prefix + path, headers: headersToSend) { once.call(.failure($0)) }
                    let upgrader = NIOWebSocketClientUpgrader(maxFrameSize: maxFrame, automaticErrorHandling: true) { ch, _ in
                        ch.eventLoop.makeCompletedFuture {
                            try install(ch)
                            once.call(.success(ch))
                        }
                    }
                    try ch.pipeline.syncOperations.addHTTPClientHandlers(
                        leftOverBytesStrategy: .forwardBytes,
                        withClientUpgrade: (upgraders: [upgrader], completionHandler: { ctx in ctx.pipeline.removeHandler(request, promise: nil) }))
                    try ch.pipeline.syncOperations.addHandler(request)
                    return ch.eventLoop.makeSucceededVoidFuture()
                } catch {
                    return ch.eventLoop.makeFailedFuture(error)
                }
            }
            .connect(host: host, port: port)
            .whenFailure { once.call(.failure($0)) }
    }

    // ------------------------------------------------------------------ status

    public var statusJson: JSONObject {
        let site = publicBase
        lock.lock(); defer { lock.unlock() }
        var o: JSONObject = ["state": state, "site": site]
        if let lastError, state != "online" { o["error"] = lastError }
        return o
    }

    private static func isIPAddress(_ s: String) -> Bool {
        var v4 = in_addr(), v6 = in6_addr()
        return inet_pton(AF_INET, s, &v4) == 1 || inet_pton(AF_INET6, s, &v6) == 1
    }

    private static func describe(_ e: Error) -> String {
        if let r = e as? RelayError {
            switch r {
            case .notReady: return "Not ready."
            case .tls: return "Couldn't set up TLS."
            case .status(let c): return "The relay answered HTTP \(c)."
            case .closed: return "The relay closed the connection."
            }
        }
        if let io = e as? IOError { return "Can't reach the relay (\(io.description))." }
        if e is NIOConnectionError || "\(e)".contains("connect") { return "Can't reach the relay." }
        if let ssl = e as? NIOSSLError { return "Secure connection to the relay failed (\(ssl))." }
        return "\(e)"
    }
}

/// Calls the completion once, whichever path (connect failure, HTTP error, success) gets there first.
private final class Once<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var fn: ((T) -> Void)?
    init(_ fn: @escaping (T) -> Void) { self.fn = fn }
    func call(_ v: T) {
        lock.lock(); let f = fn; fn = nil; lock.unlock()
        f?(v)
    }
}

/// Sends the WebSocket upgrade request; reports a non-101 answer (e.g. 401 after leaving the account).
private final class UpgradeRequestHandler: ChannelInboundHandler, RemovableChannelHandler {
    typealias InboundIn = HTTPClientResponsePart
    typealias OutboundOut = HTTPClientRequestPart

    private let path: String
    private let headers: HTTPHeaders
    private let failed: (Error) -> Void

    init(path: String, headers: HTTPHeaders, failed: @escaping (Error) -> Void) {
        self.path = path
        self.headers = headers
        self.failed = failed
    }

    func channelActive(context: ChannelHandlerContext) {
        let head = HTTPRequestHead(version: .http1_1, method: .GET, uri: path, headers: headers)
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
        context.fireChannelActive()
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        // Only reached when the server didn't switch protocols.
        if case .head(let h) = unwrapInboundIn(data) {
            failed(RelayService.RelayError.status(Int(h.status.code)))
            context.close(promise: nil)
        }
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        failed(error)
        context.close(promise: nil)
    }

    func channelInactive(context: ChannelHandlerContext) {
        failed(RelayService.RelayError.closed)
        context.fireChannelInactive()
    }
}

/// The control connection: JSON text messages from the relay; answers pings; drops a silent connection.
private final class RelayControlHandler: ChannelInboundHandler {
    typealias InboundIn = WebSocketFrame
    typealias OutboundOut = WebSocketFrame

    private let onMessage: (JSONObject) -> Void
    private var lastHeard = Date()
    private var watchdog: RepeatedTask?

    init(onMessage: @escaping (JSONObject) -> Void) { self.onMessage = onMessage }

    func handlerAdded(context: ChannelHandlerContext) {
        // The relay pings every 25 s; three missed pings mean the path is gone (sleep, network change).
        watchdog = context.eventLoop.scheduleRepeatedTask(initialDelay: .seconds(30), delay: .seconds(30)) { [weak self] _ in
            guard let self else { return }
            if Date().timeIntervalSince(self.lastHeard) > 80 { context.close(promise: nil) }
        }
    }

    func handlerRemoved(context: ChannelHandlerContext) { watchdog?.cancel() }

    func channelInactive(context: ChannelHandlerContext) {
        watchdog?.cancel()
        context.fireChannelInactive()
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        lastHeard = Date()
        let frame = unwrapInboundIn(data)
        switch frame.opcode {
        case .text:
            var d = frame.unmaskedData
            if let bytes = d.readBytes(length: d.readableBytes), let msg = JSON.parse(bytes) { onMessage(msg) }
        case .ping:
            let pong = WebSocketFrame(fin: true, opcode: .pong, maskKey: .random(), data: frame.unmaskedData)
            context.writeAndFlush(wrapOutboundOut(pong), promise: nil)
        case .connectionClose:
            context.close(promise: nil)
        default:
            break
        }
    }
}

/// Turns a tunnel's WebSocket into a plain byte stream for the HTTP server above it: binary messages in, binary
/// messages (masked, as a client must) out.
private final class WebSocketByteBridge: ChannelDuplexHandler {
    typealias InboundIn = WebSocketFrame
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = IOData
    typealias OutboundOut = WebSocketFrame

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let frame = unwrapInboundIn(data)
        switch frame.opcode {
        case .binary, .continuation:
            context.fireChannelRead(wrapInboundOut(frame.unmaskedData))
        case .ping:
            context.writeAndFlush(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .pong, maskKey: .random(), data: frame.unmaskedData)), promise: nil)
        case .connectionClose:
            context.close(promise: nil)
        default:
            break
        }
    }

    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        switch unwrapOutboundIn(data) {
        case .byteBuffer(let buf):
            context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, maskKey: .random(), data: buf)), promise: promise)
        case .fileRegion:
            promise?.fail(ChannelError.operationUnsupported) // never produced: file responses are sent as buffers
        }
    }
}
