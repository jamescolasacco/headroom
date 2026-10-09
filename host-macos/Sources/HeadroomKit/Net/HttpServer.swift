import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import NIOSSL
import NIOWebSocket

// A small HTTP/1.1 + WebSocket server on SwiftNIO (the role Kestrel plays on Windows). Requests are
// buffered (bodies up to 1 MiB) and handled off the event loop — pairing runs 600k PBKDF2 rounds — except
// uploads, which the app streams to disk itself with backpressure. File responses stream in chunks.

public struct HttpRequest {
    public let method: HTTPMethod
    public let uri: String
    public let path: String
    public let query: [String: String]
    public let headers: HTTPHeaders
    public var body: [UInt8] = []
    public let remoteIP: String?
    public let isTLS: Bool
    /// Host header without the port.
    public let hostName: String

    public var isLoopback: Bool { NetInterfaces.isLoopback(remoteIP) }

    public var json: JSONObject { JSON.parse(body) ?? [:] }

    public var bearerToken: String? {
        guard let auth = headers.first(name: "authorization"), auth.lowercased().hasPrefix("bearer ") else { return nil }
        return String(auth.dropFirst(7)).trimmingCharacters(in: .whitespaces)
    }
}

public enum HttpBody {
    case empty
    case bytes([UInt8])
    /// Streams `length` bytes of the file starting at `offset`.
    case file(FileHandle, offset: UInt64, length: UInt64)
}

public struct HttpResponse {
    public var status: HTTPResponseStatus
    public var headers: HTTPHeaders
    public var body: HttpBody

    public init(status: HTTPResponseStatus = .ok, headers: HTTPHeaders = HTTPHeaders(), body: HttpBody = .empty) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    public static func json(_ value: Any, status: HTTPResponseStatus = .ok) -> HttpResponse {
        var h = HTTPHeaders()
        h.add(name: "Content-Type", value: "application/json; charset=utf-8")
        return HttpResponse(status: status, headers: h, body: .bytes(JSON.bytes(value)))
    }

    public static func text(_ s: String, contentType: String = "text/plain; charset=utf-8", status: HTTPResponseStatus = .ok) -> HttpResponse {
        var h = HTTPHeaders()
        h.add(name: "Content-Type", value: contentType)
        return HttpResponse(status: status, headers: h, body: .bytes(Array(s.utf8)))
    }

    public static func status(_ s: HTTPResponseStatus) -> HttpResponse { HttpResponse(status: s) }

    public static func redirect(_ location: String) -> HttpResponse {
        var h = HTTPHeaders()
        h.add(name: "Location", value: location)
        return HttpResponse(status: .found, headers: h)
    }
}

/// Receives a streamed request body (uploads). Methods are called on a private serial queue.
public protocol HttpBodySink: AnyObject {
    func write(_ bytes: [UInt8]) throws
    func finish() -> HttpResponse
    func abort()
}

public protocol HttpApp: AnyObject {
    /// Called on the event loop with the request head. Return `.stream(sink)` to receive the body yourself,
    /// `.respond(response)` to reject early, or nil to have the body buffered and passed to `handle`.
    func beginStreaming(_ req: HttpRequest) -> HttpStreamDecision?
    /// Called off the event loop with the complete request.
    func handle(_ req: HttpRequest) -> HttpResponse
    /// Headers every response gets (security headers, CORS for /api…).
    func decorate(_ req: HttpRequest, _ resp: inout HttpResponse)
    func shouldUpgradeWebSocket(path: String, remoteIP: String?, isTLS: Bool) -> Bool
    /// Builds the handler for an upgraded WebSocket channel.
    func webSocketHandler(remoteIP: String?, isTLS: Bool) -> ChannelHandler
}

public enum HttpStreamDecision {
    case stream(HttpBodySink)
    case respond(HttpResponse)
}

public final class HttpServer {
    public let group: MultiThreadedEventLoopGroup
    private var channels: [Channel] = []
    private let app: HttpApp

    public init(app: HttpApp) {
        self.app = app
        group = MultiThreadedEventLoopGroup(numberOfThreads: max(2, min(4, System.coreCount / 2)))
    }

    /// Binds `port` on all interfaces (dual-stack), or loopback only. `tls` nil = plain HTTP.
    public func listen(port: Int, tls: NIOSSLContext?, loopbackOnly: Bool) throws {
        let hosts = loopbackOnly ? ["127.0.0.1", "::1"] : ["::"]
        var bound = 0
        var lastError: Error?
        for host in hosts {
            do {
                let ch = try makeBootstrap(tls: tls).bind(host: host, port: port).wait()
                channels.append(ch)
                bound += 1
            } catch {
                lastError = error
                if host == "::" {
                    // No IPv6 stack: fall back to IPv4 only.
                    let ch = try makeBootstrap(tls: tls).bind(host: "0.0.0.0", port: port).wait()
                    channels.append(ch)
                    bound += 1
                }
            }
        }
        if bound == 0, let lastError { throw lastError }
    }

    private func makeBootstrap(tls: NIOSSLContext?) -> ServerBootstrap {
        let app = self.app
        let isTLS = tls != nil
        return ServerBootstrap(group: group)
            .serverChannelOption(ChannelOptions.backlog, value: 256)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
            .childChannelOption(ChannelOptions.socketOption(.so_keepalive), value: 1)
            // Small buffers: the session send loop is priority-ordered, so little may sit below it.
            .childChannelOption(ChannelOptions.writeBufferWaterMark, value: .init(low: 64 * 1024, high: 256 * 1024))
            .childChannelOption(ChannelOptions.maxMessagesPerRead, value: 16)
            .childChannelInitializer { channel in
                let remote = channel.remoteAddress?.ipAddress.map(NetInterfaces.normalize)
                if let tls {
                    do { try channel.pipeline.syncOperations.addHandler(NIOSSLServerHandler(context: tls)) } catch { return channel.eventLoop.makeFailedFuture(error) }
                }
                let upgrader = NIOWebSocketServerUpgrader(
                    maxFrameSize: 16 * 1024 * 1024,
                    automaticErrorHandling: true,
                    shouldUpgrade: { ch, _ in ch.eventLoop.makeSucceededFuture(HTTPHeaders()) },
                    upgradePipelineHandler: { ch, _ in
                        do {
                            try ch.pipeline.syncOperations.addHandler(NIOWebSocketFrameAggregator(
                                minNonFinalFragmentSize: 0, maxAccumulatedFrameCount: 4096, maxAccumulatedFrameSize: 16 * 1024 * 1024))
                            try ch.pipeline.syncOperations.addHandler(app.webSocketHandler(remoteIP: remote, isTLS: isTLS))
                            return ch.eventLoop.makeSucceededVoidFuture()
                        } catch {
                            return ch.eventLoop.makeFailedFuture(error)
                        }
                    })
                // The HTTP codec is assembled by hand (rather than configureHTTPServerPipeline) so that a WebSocket
                // upgrade works on any request of a keep-alive connection, not only the first one.
                let encoder = HTTPResponseEncoder()
                let decoder = ByteToMessageHandler(HTTPRequestDecoder(leftOverBytesStrategy: .forwardBytes))
                let pipelining = HTTPServerPipelineHandler()
                let errors = HTTPServerProtocolErrorHandler()
                let http = HttpHandler(app: app, remoteIP: remote, isTLS: isTLS, upgrader: upgrader, httpHandlers: [encoder, decoder, pipelining, errors])
                do {
                    try channel.pipeline.syncOperations.addHandlers([encoder, decoder, pipelining, errors, http])
                    return channel.eventLoop.makeSucceededVoidFuture()
                } catch {
                    return channel.eventLoop.makeFailedFuture(error)
                }
            }
    }

    public func shutdown() {
        for c in channels { try? c.close().wait() }
        try? group.syncShutdownGracefully()
    }
}

/// One HTTP connection: parses requests, dispatches them, writes responses (streaming file bodies).
final class HttpHandler: ChannelInboundHandler, RemovableChannelHandler {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart

    private static let maxBufferedBody = 1 << 20
    private static let uploadQueue = DispatchQueue(label: "headroom.http.upload")

    private let app: HttpApp
    private let remoteIP: String?
    private let isTLS: Bool
    private let upgrader: NIOWebSocketServerUpgrader
    private let httpHandlers: [RemovableChannelHandler]
    /// Set while switching to WebSocket: inbound data is held and replayed to the new handlers.
    private var upgrading = false
    private var upgradeHead: HTTPRequestHead?
    private var heldDuringUpgrade: [NIOAny] = []

    private var request: HttpRequest?
    private var keepAlive = true
    private var tooLarge = false
    private var sink: HttpBodySink?
    /// The response was already sent at head time (rejected upload); the body is ignored.
    private var answered = false
    /// Set on the upload queue when writing a chunk fails; later chunks are skipped.
    private let uploadFailed = Locked(false)
    private var pendingSinkBytes = 0
    private var readPaused = false

    init(app: HttpApp, remoteIP: String?, isTLS: Bool, upgrader: NIOWebSocketServerUpgrader, httpHandlers: [RemovableChannelHandler]) {
        self.app = app
        self.remoteIP = remoteIP
        self.isTLS = isTLS
        self.upgrader = upgrader
        self.httpHandlers = httpHandlers
    }

    private static func isWebSocketUpgrade(_ head: HTTPRequestHead) -> Bool {
        head.method == .GET
            && head.headers[canonicalForm: "connection"].contains { $0.lowercased() == "upgrade" }
            && head.headers.first(name: "upgrade")?.lowercased() == "websocket"
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        if upgrading {
            heldDuringUpgrade.append(data)
            return
        }
        switch unwrapInboundIn(data) {
        case .head(let head):
            let wsPath = head.uri.split(separator: "?", maxSplits: 1).first.map(String.init) ?? head.uri
            if Self.isWebSocketUpgrade(head), app.shouldUpgradeWebSocket(path: wsPath, remoteIP: remoteIP, isTLS: isTLS) {
                upgradeHead = head
                request = nil
                return
            }
            keepAlive = head.isKeepAlive
            tooLarge = false
            sink = nil
            answered = false
            uploadFailed.with { $0 = false }
            let parts = head.uri.split(separator: "?", maxSplits: 1)
            let rawPath = parts.first.map(String.init) ?? "/"
            let path = rawPath.removingPercentEncoding ?? rawPath
            let query = parts.count > 1 ? Self.parseQuery(String(parts[1])) : [:]
            var host = head.headers.first(name: "host") ?? ""
            if host.hasPrefix("[") { host = String(host.dropFirst().prefix { $0 != "]" }) } else if let c = host.lastIndex(of: ":") { host = String(host[..<c]) }
            let req = HttpRequest(method: head.method, uri: head.uri, path: path, query: query, headers: head.headers,
                                  remoteIP: remoteIP, isTLS: isTLS, hostName: host)
            request = req
            switch app.beginStreaming(req) {
            case .stream(let s)?: sink = s
            case .respond(let r)?:
                answered = true
                write(context: context, request: req, response: r)
            case nil: break
            }
        case .body(var buf):
            if upgradeHead != nil { return }
            guard var req = request else { return }
            if let sink {
                let bytes = buf.readBytes(length: buf.readableBytes) ?? []
                pendingSinkBytes += bytes.count
                // Backpressure: stop reading from the socket while the disk is behind.
                if pendingSinkBytes > 8 << 20, !readPaused {
                    readPaused = true
                    context.channel.setOption(ChannelOptions.autoRead, value: false).whenComplete { _ in }
                }
                let loop = context.eventLoop
                let failed = uploadFailed
                Self.uploadQueue.async { [weak self] in
                    if !failed.get {
                        do { try sink.write(bytes) } catch { failed.with { $0 = true } }
                    }
                    loop.execute {
                        guard let self else { return }
                        self.pendingSinkBytes -= bytes.count
                        if self.readPaused, self.pendingSinkBytes < 2 << 20 {
                            self.readPaused = false
                            context.channel.setOption(ChannelOptions.autoRead, value: true).whenComplete { _ in }
                            context.read()
                        }
                    }
                }
                return
            }
            if answered { return }
            if req.body.count + buf.readableBytes > Self.maxBufferedBody { tooLarge = true; return }
            req.body.append(contentsOf: buf.readBytes(length: buf.readableBytes) ?? [])
            request = req
        case .end:
            if let head = upgradeHead {
                upgradeHead = nil
                upgrade(context: context, head: head)
                return
            }
            guard let req = request else { return }
            request = nil
            if let sink {
                self.sink = nil
                let loop = context.eventLoop
                let failedFlag = uploadFailed
                Self.uploadQueue.async { [weak self] in
                    let failed = failedFlag.get
                    let resp: HttpResponse
                    if failed { sink.abort(); resp = .json(["error": "write failed"], status: .internalServerError) } else { resp = sink.finish() }
                    loop.execute { self?.write(context: context, request: req, response: resp) }
                }
                return
            }
            if answered { return }
            if tooLarge {
                write(context: context, request: req, response: .json(["error": "request too large"], status: .payloadTooLarge))
                return
            }
            let app = self.app
            let loop = context.eventLoop
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                var resp = app.handle(req)
                app.decorate(req, &resp)
                loop.execute { self?.writeRaw(context: context, request: req, response: resp) }
            }
        }
    }

    /// Answers 101, swaps the HTTP codec for the WebSocket one, then hands the channel to the app's handler.
    private func upgrade(context: ChannelHandlerContext, head: HTTPRequestHead) {
        upgrading = true
        let channel = context.channel
        upgrader.buildUpgradeResponse(channel: channel, upgradeRequest: head, initialResponseHeaders: HTTPHeaders()).whenComplete { result in
            switch result {
            case .failure:
                self.upgrading = false
                context.write(self.wrapOutboundOut(.head(HTTPResponseHead(version: .http1_1, status: .badRequest, headers: ["Content-Length": "0", "Connection": "close"]))), promise: nil)
                context.writeAndFlush(self.wrapOutboundOut(.end(nil))).whenComplete { _ in context.close(promise: nil) }
            case .success(let headers):
                context.write(self.wrapOutboundOut(.head(HTTPResponseHead(version: .http1_1, status: .switchingProtocols, headers: headers))), promise: nil)
                context.writeAndFlush(self.wrapOutboundOut(.end(nil))).flatMap { () -> EventLoopFuture<Void> in
                    let removals = self.httpHandlers.map { context.pipeline.removeHandler($0) }
                    return EventLoopFuture.andAllSucceed(removals, on: context.eventLoop)
                }.flatMap {
                    self.upgrader.upgrade(context: context, upgradeRequest: head)
                }.whenComplete { r in
                    switch r {
                    case .success:
                        let held = self.heldDuringUpgrade
                        self.heldDuringUpgrade = []
                        context.pipeline.removeHandler(context: context).whenComplete { _ in
                            for d in held { context.fireChannelRead(d) }
                        }
                    case .failure(let e):
                        Log.warn("http", "websocket upgrade failed: \(e)")
                        context.close(promise: nil)
                    }
                }
            }
        }
    }

    func channelInactive(context: ChannelHandlerContext) {
        if let sink {
            self.sink = nil
            Self.uploadQueue.async { sink.abort() }
        }
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        Log.debug("http", "connection error from \(remoteIP ?? "?"): \(error)")
        context.close(promise: nil)
    }

    private func write(context: ChannelHandlerContext, request: HttpRequest, response: HttpResponse) {
        var r = response
        app.decorate(request, &r)
        writeRaw(context: context, request: request, response: r)
    }

    private func writeRaw(context: ChannelHandlerContext, request: HttpRequest, response: HttpResponse) {
        guard context.channel.isActive else { return }
        var headers = response.headers
        let isHead = request.method == .HEAD
        let bodyless = response.status == .notModified || response.status == .noContent
        switch response.body {
        case .empty:
            if !bodyless { headers.replaceOrAdd(name: "Content-Length", value: "0") }
        case .bytes(let b):
            headers.replaceOrAdd(name: "Content-Length", value: String(b.count))
        case .file(_, _, let length):
            headers.replaceOrAdd(name: "Content-Length", value: String(length))
        }
        if !keepAlive { headers.replaceOrAdd(name: "Connection", value: "close") }
        let head = HTTPResponseHead(version: .http1_1, status: response.status, headers: headers)
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        let keepAlive = self.keepAlive
        let finish: () -> Void = {
            let p = context.eventLoop.makePromise(of: Void.self)
            context.writeAndFlush(self.wrapOutboundOut(.end(nil)), promise: p)
            if !keepAlive { p.futureResult.whenComplete { _ in context.close(promise: nil) } }
        }
        switch response.body {
        case .bytes(let b) where !isHead && !b.isEmpty:
            context.write(wrapOutboundOut(.body(.byteBuffer(context.channel.allocator.buffer(bytes: b)))), promise: nil)
            finish()
        case .file(let fh, let offset, let length) where !isHead:
            streamFile(context: context, fh: fh, offset: offset, remaining: length, finish: finish)
        case .file(let fh, _, _):
            try? fh.close()
            finish()
        default:
            finish()
        }
    }

    private static let fileQueue = DispatchQueue(label: "headroom.http.files", attributes: .concurrent)

    private func streamFile(context: ChannelHandlerContext, fh: FileHandle, offset: UInt64, remaining: UInt64, finish: @escaping () -> Void) {
        let loop = context.eventLoop
        Self.fileQueue.async {
            let chunk = Int(min(remaining, 256 * 1024))
            var data = Data()
            if chunk > 0 {
                do {
                    try fh.seek(toOffset: offset)
                    data = try fh.read(upToCount: chunk) ?? Data()
                } catch { data = Data() }
            }
            loop.execute {
                guard context.channel.isActive else { try? fh.close(); return }
                if data.isEmpty {
                    try? fh.close()
                    if remaining > 0 { context.close(promise: nil) } else { finish() } // truncated file: abort the response
                    return
                }
                let buf = context.channel.allocator.buffer(bytes: data)
                let p = loop.makePromise(of: Void.self)
                context.writeAndFlush(self.wrapOutboundOut(.body(.byteBuffer(buf))), promise: p)
                p.futureResult.whenComplete { result in
                    if case .failure = result { try? fh.close(); return }
                    let left = remaining - UInt64(data.count)
                    if left == 0 { try? fh.close(); finish() } else {
                        self.streamFile(context: context, fh: fh, offset: offset + UInt64(data.count), remaining: left, finish: finish)
                    }
                }
            }
        }
    }

    static func parseQuery(_ q: String) -> [String: String] {
        var out = [String: String]()
        for pair in q.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            let k = String(kv[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(kv[0])
            let v = kv.count > 1 ? (String(kv[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(kv[1])) : ""
            out[k] = v
        }
        return out
    }
}
