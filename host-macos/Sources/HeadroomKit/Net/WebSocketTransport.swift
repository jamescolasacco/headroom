import Foundation
import NIOCore
import NIOWebSocket

public final class EncodedVideoFrame {
    public let epoch: Int
    public let frameId: UInt32
    public let data: [UInt8]
    public let keyFrame: Bool
    public let captureTimeUs: Int64
    public let encodeMs: Double

    init(epoch: Int, frameId: UInt32, data: [UInt8], keyFrame: Bool, captureTimeUs: Int64, encodeMs: Double) {
        self.epoch = epoch
        self.frameId = frameId
        self.data = data
        self.keyFrame = keyFrame
        self.captureTimeUs = captureTimeUs
        self.encodeMs = encodeMs
    }
}

/// What a WebSocket transport reports to its owner. Called on the owner's serial queue, in order.
public protocol WebSocketPeer: AnyObject {
    func webSocketOpened(_ transport: WebSocketTransport)
    func webSocketText(_ bytes: [UInt8])
    func webSocketBinary(_ bytes: [UInt8])
    func webSocketClosed()
    /// The last fragment of `frame` is about to be written (register it as in flight before the ack can arrive).
    /// Called on the event loop, not the peer's queue.
    func videoFrameWillComplete(_ frame: EncodedVideoFrame)
}

/// One upgraded WebSocket. Everything multiplexes over it with a strictly prioritised send loop:
/// control/cursor > audio > video, and video frames are cut into 64 KiB fragments, so a cursor update or
/// audio packet never waits behind a large keyframe. Writes only happen while the channel is writable
/// (small NIO watermarks), which keeps lower-priority data from piling up below the queue.
public final class WebSocketTransport: ChannelInboundHandler {
    public typealias InboundIn = WebSocketFrame
    public typealias OutboundOut = WebSocketFrame

    public let remoteIP: String?
    public let isTLS: Bool
    /// Serial queue the peer's callbacks run on (keeps the event loop free; preserves message order).
    public let queue: DispatchQueue
    public weak var peer: WebSocketPeer?

    private let lock = NSLock()
    private var control: [(bytes: [UInt8], text: Bool)] = []
    private var audio: [[UInt8]] = []
    private var video: [EncodedVideoFrame] = []
    private var current: EncodedVideoFrame?
    private var offset = 0
    private var videoQueuedCount = 0
    private var pumpScheduled = false
    private var closed = false

    private var context: ChannelHandlerContext?
    private var loop: EventLoop?

    public init(remoteIP: String?, isTLS: Bool, makePeer: (WebSocketTransport) -> WebSocketPeer) {
        self.remoteIP = remoteIP
        self.isTLS = isTLS
        queue = DispatchQueue(label: "headroom.session", qos: .userInteractive)
        let p = makePeer(self)
        peer = p
        strongPeer = p
    }

    /// The transport owns its peer until the socket closes.
    private var strongPeer: WebSocketPeer?

    // ------------------------------------------------------------------ channel events (event loop)

    public func handlerAdded(context: ChannelHandlerContext) {
        self.context = context
        loop = context.eventLoop
        queue.async { [weak self] in
            guard let self else { return }
            self.peer?.webSocketOpened(self)
        }
    }

    public func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let frame = unwrapInboundIn(data)
        switch frame.opcode {
        case .text:
            var d = frame.unmaskedData
            let bytes = d.readBytes(length: d.readableBytes) ?? []
            queue.async { [weak self] in self?.peer?.webSocketText(bytes) }
        case .binary:
            var d = frame.unmaskedData
            let bytes = d.readBytes(length: d.readableBytes) ?? []
            queue.async { [weak self] in self?.peer?.webSocketBinary(bytes) }
        case .ping:
            let pong = WebSocketFrame(fin: true, opcode: .pong, data: frame.unmaskedData)
            context.writeAndFlush(wrapOutboundOut(pong), promise: nil)
        case .connectionClose:
            if !closedSent {
                closedSent = true
                var b = context.channel.allocator.buffer(capacity: 2)
                b.writeInteger(UInt16(1000))
                let close = WebSocketFrame(fin: true, opcode: .connectionClose, data: b)
                context.writeAndFlush(wrapOutboundOut(close)).whenComplete { _ in context.close(promise: nil) }
            } else {
                context.close(promise: nil)
            }
        default:
            break
        }
    }

    private var closedSent = false

    public func channelWritabilityChanged(context: ChannelHandlerContext) {
        if context.channel.isWritable { pump(context) }
        context.fireChannelWritabilityChanged()
    }

    public func channelInactive(context: ChannelHandlerContext) {
        lock.lock()
        closed = true
        control.removeAll()
        audio.removeAll()
        video.removeAll()
        current = nil
        videoQueuedCount = 0
        lock.unlock()
        self.context = nil
        // Capture strongly: NIO drops this handler right after, and nothing else may still own the transport —
        // a weak capture would silently skip the session's cleanup.
        queue.async {
            self.peer?.webSocketClosed()
            self.strongPeer = nil
        }
        context.fireChannelInactive()
    }

    public func errorCaught(context: ChannelHandlerContext, error: Error) {
        Log.debug("ws", "socket error from \(remoteIP ?? "?"): \(error)")
        context.close(promise: nil)
    }

    // ------------------------------------------------------------------ sending (any thread)

    public func sendText(_ bytes: [UInt8]) { enqueueControl(bytes, text: true) }
    public func sendBinary(_ bytes: [UInt8]) { enqueueControl(bytes, text: false) }

    private func enqueueControl(_ bytes: [UInt8], text: Bool) {
        lock.lock()
        if closed { lock.unlock(); return }
        control.append((bytes, text))
        lock.unlock()
        schedulePump()
    }

    /// Audio is dropped rather than queued deeply: late audio is worse than a gap.
    public func sendAudio(_ bytes: [UInt8]) {
        lock.lock()
        if closed || audio.count > 25 { lock.unlock(); return }
        audio.append(bytes)
        lock.unlock()
        schedulePump()
    }

    public func sendVideo(_ frame: EncodedVideoFrame) {
        lock.lock()
        if closed { lock.unlock(); return }
        video.append(frame)
        videoQueuedCount += 1
        lock.unlock()
        schedulePump()
    }

    /// Frames handed to the transport whose last fragment hasn't reached the socket yet.
    public var videoQueued: Int { lock.lock(); defer { lock.unlock() }; return videoQueuedCount }

    public func close(code: WebSocketErrorCode = .normalClosure, reason: String = "") {
        guard let loop else { return }
        loop.execute { [weak self] in
            guard let self, let context = self.context, !self.closedSent else { return }
            self.closedSent = true
            var b = context.channel.allocator.buffer(capacity: 2 + reason.utf8.count)
            b.write(webSocketErrorCode: code)
            b.writeString(String(reason.prefix(120)))
            let frame = WebSocketFrame(fin: true, opcode: .connectionClose, data: b)
            context.writeAndFlush(self.wrapOutboundOut(frame)).whenComplete { _ in
                // Give the peer a moment to answer, then drop the connection regardless.
                context.eventLoop.scheduleTask(in: .seconds(2)) { context.close(promise: nil) }
            }
        }
    }

    private func schedulePump() {
        lock.lock()
        if pumpScheduled || closed { lock.unlock(); return }
        pumpScheduled = true
        lock.unlock()
        loop?.execute { [weak self] in
            guard let self, let ctx = self.context else { return }
            self.pump(ctx)
        }
    }

    private func pump(_ context: ChannelHandlerContext) {
        lock.lock(); pumpScheduled = false; lock.unlock()
        var wrote = false
        while context.channel.isWritable {
            var item: (bytes: [UInt8], text: Bool)?
            var audioItem: [UInt8]?
            var frame: EncodedVideoFrame?
            var fragOffset = 0
            lock.lock()
            if !control.isEmpty {
                item = control.removeFirst()
            } else if !audio.isEmpty {
                audioItem = audio.removeFirst()
            } else {
                if current == nil, !video.isEmpty {
                    current = video.removeFirst()
                    offset = 0
                }
                frame = current
                fragOffset = offset
            }
            lock.unlock()

            if let item {
                let buf = context.channel.allocator.buffer(bytes: item.bytes)
                context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: item.text ? .text : .binary, data: buf)), promise: nil)
                wrote = true
                continue
            }
            if let audioItem {
                let buf = context.channel.allocator.buffer(bytes: audioItem)
                context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, data: buf)), promise: nil)
                wrote = true
                continue
            }
            guard let frame else { break }

            let data = frame.data
            let len = min(Wire.maxFragmentPayload, data.count - fragOffset)
            let last = fragOffset + len >= data.count
            var flags: Wire.VideoFlags = []
            if frame.keyFrame { flags.insert(.key) }
            if fragOffset == 0 { flags.insert(.first) }
            if last { flags.insert(.last) }
            let header = Wire.videoHeader(flags: flags, epoch: frame.epoch, frameId: frame.frameId, total: data.count,
                                          offset: fragOffset, captureUs: frame.captureTimeUs, encodeMs: frame.encodeMs)
            var buf = context.channel.allocator.buffer(capacity: header.count + len)
            buf.writeBytes(header)
            buf.writeBytes(data[fragOffset..<(fragOffset + len)])
            if last {
                // Register before sending: on a fast link the client's ack can beat the write completing.
                peer?.videoFrameWillComplete(frame)
                lock.lock(); current = nil; lock.unlock()
                let p = context.eventLoop.makePromise(of: Void.self)
                p.futureResult.whenComplete { [weak self] _ in
                    guard let self else { return }
                    self.lock.lock(); self.videoQueuedCount = max(0, self.videoQueuedCount - 1); self.lock.unlock()
                }
                context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, data: buf)), promise: p)
            } else {
                lock.lock(); offset = fragOffset + len; lock.unlock()
                context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, data: buf)), promise: nil)
            }
            // Flush per fragment: TLS only hands bytes to the socket (and so only updates writability) on flush.
            // Without this a whole keyframe would sit ahead of the next cursor or audio message.
            context.flush()
            wrote = false
        }
        if wrote { context.flush() }
    }
}
