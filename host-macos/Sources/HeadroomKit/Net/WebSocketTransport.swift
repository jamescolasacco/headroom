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
    public let refinement: Bool
    /// When its first fragment was handed to the socket, and how big that was (event loop; read in
    /// `videoFrameWillComplete`).
    var firstWriteUs: Int64 = 0
    var firstFragmentBytes = 0

    init(epoch: Int, frameId: UInt32, data: [UInt8], keyFrame: Bool, captureTimeUs: Int64, encodeMs: Double, refinement: Bool = false) {
        self.epoch = epoch
        self.frameId = frameId
        self.data = data
        self.keyFrame = keyFrame
        self.captureTimeUs = captureTimeUs
        self.encodeMs = encodeMs
        self.refinement = refinement
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
    /// The viewer answered one of our pings (`sendPing`) after `rttUs`.
    func webSocketPong(rttUs: Int64)
}

public extension WebSocketPeer {
    func webSocketPong(rttUs: Int64) {}
}

/// The transport's audio queue. Without audio priority, as before: past 25 queued packets (250 ms) new ones are
/// dropped (late sound is worse than a gap). With priority nothing is dropped unless 2 s are queued (then the oldest
/// go): the session steps its sound down long before that.
struct AudioSendQueue {
    struct Item {
        let bytes: [UInt8]
        let queuedUs: Int64
    }

    static let legacyLimit = 25
    static let priorityLimit = 200

    var priority = false
    private(set) var items: [Item] = []
    /// Packets dropped (priority: only past the 2 s cap).
    private(set) var dropped = 0
    /// Bytes accepted so far (dropped ones included).
    private(set) var acceptedBytes: Int64 = 0

    mutating func push(_ bytes: [UInt8], nowUs: Int64) {
        if priority {
            if items.count >= Self.priorityLimit { items.removeFirst(); dropped += 1 }
        } else if items.count > Self.legacyLimit {
            dropped += 1
            return
        }
        items.append(Item(bytes: bytes, queuedUs: nowUs))
        acceptedBytes += Int64(bytes.count)
    }

    mutating func pop() -> Item? { items.isEmpty ? nil : items.removeFirst() }

    mutating func removeAll() { items.removeAll() }

    /// How long the oldest queued packet has waited (0: none queued).
    func backlogUs(nowUs: Int64) -> Int64 { items.first.map { max(0, nowUs - $0.queuedUs) } ?? 0 }
}

/// Paces video fragments for a session with audio priority (a token bucket): a frame bigger than the path can take at
/// once would otherwise land in its bottleneck buffer whole, and every sound packet after it waits until it drains
/// (198 ms on a 4 Mb/s path for one full-screen change). Sound and control messages are never paced. On a slow path
/// fragments are smaller too (~20 ms of the pace, 4-16 KiB): one 16 KiB fragment holds a 2 Mb/s link for 65 ms.
struct VideoPacer {
    /// Bytes per second; 0: no pacing.
    private(set) var rate = 0.0
    private var tokens = 0.0
    private var lastUs: Int64 = 0

    static let smallestFragment = 4 * 1024

    /// Payload bytes per fragment at this pace.
    var fragmentPayload: Int {
        rate > 0 ? min(Wire.priorityFragmentPayload, max(Self.smallestFragment, Int(rate * 0.020))) : Wire.priorityFragmentPayload
    }

    /// One whole fragment may always go at once.
    var burst: Double { max(Double(fragmentPayload + Wire.videoHeaderSize + 14), rate * 0.010) }

    mutating func setRate(kbps: Int, nowUs: Int64) {
        let wasOff = rate == 0
        rate = Double(max(0, kbps)) * 1000 / 8
        if wasOff && rate > 0 { tokens = burst; lastUs = nowUs }
    }

    /// Takes `bytes` if the bucket has them; otherwise how long (µs) until it will.
    mutating func take(_ bytes: Int, nowUs: Int64) -> Int64? {
        guard rate > 0 else { return nil }
        tokens = min(burst, tokens + Double(max(0, nowUs - lastUs)) * rate / 1_000_000)
        lastUs = nowUs
        let need = Double(bytes)
        if tokens >= need || tokens >= burst { // a fragment bigger than the bucket goes once it's full
            tokens -= need
            return nil
        }
        return Int64(((min(need, burst) - tokens) / rate * 1_000_000).rounded(.up))
    }
}

/// How long sound waited from being queued to reaching the socket, for a session with audio priority.
public struct AudioQueueReport {
    public var packets = 0
    public var p50Ms = 0.0
    public var p95Ms = 0.0
    public var maxMs = 0.0
    /// Age of the oldest packet still queued.
    public var backlogMs = 0.0
    /// Dropped since the session started (only past the 2 s cap).
    public var dropped = 0
}

/// One upgraded WebSocket. Everything multiplexes over it with a strictly prioritised send loop:
/// control/cursor > audio > video, and video frames are cut into 64 KiB fragments, so a cursor update or
/// audio packet never waits behind a large keyframe. Writes only happen while the channel is writable
/// (small NIO watermarks), which keeps lower-priority data from piling up below the queue.
///
/// With audio priority (`setAudioPriority`) sound must never wait behind more than a little picture: fragments
/// are 16 KiB, the channel's write buffer is 16/48 KiB and the kernel keeps at most 16 KiB unsent
/// (TCP_NOTSENT_LOWAT), on this session's channel only (a relayed session's too: its WebSocket runs over the same
/// channel through RelayService's byte bridge). The audio queue doesn't drop, and how long sound waits is measured.
public final class WebSocketTransport: ChannelInboundHandler {
    public typealias InboundIn = WebSocketFrame
    public typealias OutboundOut = WebSocketFrame

    /// TCP_NOTSENT_LOWAT (netinet/tcp.h): the socket takes more only while less than this is unsent.
    private static let notSentLowat = ChannelOptions.Types.SocketOption(level: .tcp, name: NIOBSDSocket.Option(rawValue: 0x201))
    private static let priorityWaterMark = ChannelOptions.Types.WriteBufferWaterMark(low: 16 * 1024, high: 48 * 1024)
    private static let priorityNotSentLowat: SocketOptionValue = 16 * 1024

    public let remoteIP: String?
    public let isTLS: Bool
    /// Came through the relay.
    public let relayed: Bool
    /// Came with a guest code (through the relay's /c/<code>/): may only start a guest session.
    public let guest: Bool
    /// The viewer's country, as the relay saw it (approximate location for the Accept prompt).
    public let country: String?
    /// Serial queue the peer's callbacks run on (keeps the event loop free; preserves message order).
    public let queue: DispatchQueue
    public weak var peer: WebSocketPeer?

    private let lock = NSLock()
    private var control: [(bytes: [UInt8], opcode: WebSocketOpcode)] = []
    /// Our pings not answered yet: when each was sent (under `lock`).
    private var pingsOut: [Int64] = []
    private var audio = AudioSendQueue()
    // Audio priority measurements (under `lock`).
    private var audioDelaysUs: [Int64] = []   // since the last report
    private var audioTickMaxUs: Int64 = 0      // since the last takeAudioTickMaxUs
    private var audioWrittenBytes: Int64 = 0   // reached the socket, since priority was turned on
    private var videoBytesOut: Int64 = 0       // video fragments handed to the channel, since priority was turned on
    private var audioAcceptedAtPriority: Int64 = 0
    /// The channel's settings before audio priority changed them, put back when it's turned off (event loop).
    private var savedWaterMark: ChannelOptions.Types.WriteBufferWaterMark?
    private var savedNotSentLowat: SocketOptionValue?
    /// With audio priority, video fragments leave at most at this pace (VideoPacer), so a big frame doesn't land in the
    /// path's bottleneck all at once ahead of the sound (under `lock`).
    private var pacer = VideoPacer()
    private var paceWakeScheduled = false // event loop
    private var video: [EncodedVideoFrame] = []
    private var current: EncodedVideoFrame?
    private var offset = 0
    private var videoQueuedCount = 0
    private var pumpScheduled = false
    private var closed = false

    private var context: ChannelHandlerContext?
    private var loop: EventLoop?

    public init(remoteIP: String?, isTLS: Bool, relayed: Bool = false, guest: Bool = false, country: String? = nil,
                makePeer: (WebSocketTransport) -> WebSocketPeer) {
        self.remoteIP = remoteIP
        self.isTLS = isTLS
        self.relayed = relayed
        self.guest = guest
        self.country = country
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
        lock.lock(); let priority = audio.priority; lock.unlock()
        if priority { applyChannelSettings(context.channel, priority: true) }
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
        case .pong:
            // An answer to sendPing (it echoes the send time). A viewer may answer only the latest of several pings, so
            // every older one counts as answered too.
            var d = frame.unmaskedData
            guard d.readableBytes == 8, let bytes = d.readBytes(length: 8) else { break }
            let sentUs = Int64(bitPattern: UInt64(bytes[0]) | UInt64(bytes[1]) << 8 | UInt64(bytes[2]) << 16 | UInt64(bytes[3]) << 24
                | UInt64(bytes[4]) << 32 | UInt64(bytes[5]) << 40 | UInt64(bytes[6]) << 48 | UInt64(bytes[7]) << 56)
            lock.lock()
            let ours = pingsOut.contains(sentUs)
            pingsOut.removeAll { $0 <= sentUs }
            lock.unlock()
            guard ours else { break }
            let rtt = max(0, Clock.nowUs - sentUs)
            queue.async { [weak self] in self?.peer?.webSocketPong(rttUs: rtt) }
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
        pingsOut.removeAll()
        audio.removeAll()
        audioDelaysUs.removeAll()
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

    public func sendText(_ bytes: [UInt8]) { enqueueControl(bytes, opcode: .text) }
    public func sendBinary(_ bytes: [UInt8]) { enqueueControl(bytes, opcode: .binary) }

    /// A WebSocket ping carrying its send time: the viewer's WebSocket answers it by itself (browsers and Node do,
    /// RFC 6455), through the relay's tunnel too, and the round trip includes whatever is queued on the way to the
    /// viewer. With audio priority it shows a backlog that sits beyond this computer (in the relay, the network).
    public func sendPing() {
        var b = [UInt8](repeating: 0, count: 8)
        let now = Clock.nowUs
        b.putI64(now, at: 0)
        lock.lock()
        if closed { lock.unlock(); return }
        pingsOut.append(now)
        if pingsOut.count > 64 { pingsOut.removeFirst() }
        control.append((b, .ping))
        lock.unlock()
        schedulePump()
    }

    /// How long the oldest unanswered ping has been out (0: none).
    public var oldestPingAgeUs: Int64 {
        lock.lock(); defer { lock.unlock() }
        return pingsOut.first.map { max(0, Clock.nowUs - $0) } ?? 0
    }

    private func enqueueControl(_ bytes: [UInt8], opcode: WebSocketOpcode) {
        lock.lock()
        if closed { lock.unlock(); return }
        control.append((bytes, opcode))
        lock.unlock()
        schedulePump()
    }

    /// Without audio priority, audio is dropped rather than queued deeply: late audio is worse than a gap. With it,
    /// nothing is dropped (see AudioSendQueue).
    public func sendAudio(_ bytes: [UInt8]) {
        lock.lock()
        if closed { lock.unlock(); return }
        audio.push(bytes, nowUs: Clock.nowUs)
        lock.unlock()
        schedulePump()
    }

    /// Audio priority for this session: see the type's description. Off puts back what the channel had.
    public func setAudioPriority(_ on: Bool) {
        lock.lock()
        if audio.priority == on || closed { lock.unlock(); return }
        audio.priority = on
        audioDelaysUs.removeAll()
        audioTickMaxUs = 0
        audioWrittenBytes = 0
        videoBytesOut = 0
        audioAcceptedAtPriority = audio.acceptedBytes
        if !on { pacer.setRate(kbps: 0, nowUs: 0) }
        lock.unlock()
        loop?.execute { [weak self] in
            guard let self, let ctx = self.context else { return }
            self.applyChannelSettings(ctx.channel, priority: on)
            self.pump(ctx)
        }
    }

    /// Event loop.
    private func applyChannelSettings(_ ch: Channel, priority on: Bool) {
        guard let opts = ch.syncOptions else { return }
        do {
            if on {
                if savedWaterMark == nil { savedWaterMark = try opts.getOption(ChannelOptions.writeBufferWaterMark) }
                if savedNotSentLowat == nil { savedNotSentLowat = try opts.getOption(Self.notSentLowat) }
                try opts.setOption(ChannelOptions.writeBufferWaterMark, value: Self.priorityWaterMark)
                try opts.setOption(Self.notSentLowat, value: Self.priorityNotSentLowat)
            } else {
                if let w = savedWaterMark { try opts.setOption(ChannelOptions.writeBufferWaterMark, value: w) }
                if let n = savedNotSentLowat { try opts.setOption(Self.notSentLowat, value: n) }
                savedWaterMark = nil
                savedNotSentLowat = nil
            }
        } catch {
            Log.warn("ws", "couldn't \(on ? "set" : "restore") the socket options for audio priority: \(error)")
        }
    }

    /// Sound queued so far, sound that reached the socket (both since priority was turned on), and how long the oldest
    /// queued packet has waited.
    public var audioFlow: (queuedBytes: Int64, writtenBytes: Int64, backlogUs: Int64) {
        lock.lock(); defer { lock.unlock() }
        return (audio.acceptedBytes - audioAcceptedAtPriority, audioWrittenBytes, audio.backlogUs(nowUs: Clock.nowUs))
    }

    /// Sound that reached the socket plus picture handed to the channel, since priority was turned on: what this
    /// session sends towards the viewer.
    public var priorityBytesOut: Int64 {
        lock.lock(); defer { lock.unlock() }
        return audioWrittenBytes + videoBytesOut
    }

    /// The longest a packet waited (queued to the socket) since the last call, or the oldest one still waiting.
    public func takeAudioTickMaxUs() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        let m = max(audioTickMaxUs, audio.backlogUs(nowUs: Clock.nowUs))
        audioTickMaxUs = 0
        return m
    }

    /// How long sound waited since the last report.
    public func takeAudioQueueReport() -> AudioQueueReport {
        lock.lock()
        let delays = audioDelaysUs
        audioDelaysUs.removeAll(keepingCapacity: true)
        var r = AudioQueueReport()
        r.backlogMs = Double(audio.backlogUs(nowUs: Clock.nowUs)) / 1000
        r.dropped = audio.dropped
        lock.unlock()
        guard !delays.isEmpty else { return r }
        let s = delays.sorted()
        let at = { (p: Double) in Double(s[min(s.count - 1, Int(p * Double(s.count)))]) / 1000 }
        r.packets = s.count
        r.p50Ms = at(0.5)
        r.p95Ms = at(0.95)
        r.maxMs = Double(s[s.count - 1]) / 1000
        return r
    }

    /// With audio priority: the fastest video may leave (the session sets it from its bitrate target); 0 = unpaced.
    public func setVideoPace(kbps: Int) {
        lock.lock()
        pacer.setRate(kbps: audio.priority ? kbps : 0, nowUs: Clock.nowUs)
        lock.unlock()
    }

    /// Event loop: pump again once the pacer has room.
    private func schedulePacedPump(_ context: ChannelHandlerContext, inUs: Int64) {
        guard !paceWakeScheduled else { return }
        paceWakeScheduled = true
        context.eventLoop.scheduleTask(in: .microseconds(max(100, inUs))) { [weak self] in
            guard let self else { return }
            self.paceWakeScheduled = false
            if let ctx = self.context { self.pump(ctx) }
        }
    }

    /// Event loop: a priority-session audio packet reached the socket.
    private func audioWritten(queuedUs: Int64, bytes: Int) {
        let d = max(0, Clock.nowUs - queuedUs)
        lock.lock()
        if audioDelaysUs.count < 4000 { audioDelaysUs.append(d) }
        if d > audioTickMaxUs { audioTickMaxUs = d }
        audioWrittenBytes += Int64(bytes)
        lock.unlock()
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
            // Whatever is still waiting to be said (why the session ended) goes out before the close frame,
            // even when video has filled the socket.
            self.lock.lock()
            let pending = self.control
            self.control.removeAll()
            self.lock.unlock()
            for item in pending {
                let buf = context.channel.allocator.buffer(bytes: item.bytes)
                context.write(self.wrapOutboundOut(WebSocketFrame(fin: true, opcode: item.opcode, data: buf)), promise: nil)
            }
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
            var item: (bytes: [UInt8], opcode: WebSocketOpcode)?
            var audioItem: AudioSendQueue.Item?
            var frame: EncodedVideoFrame?
            var fragOffset = 0
            lock.lock()
            let priority = audio.priority
            if !control.isEmpty {
                item = control.removeFirst()
            } else if let a = audio.pop() {
                audioItem = a
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
                context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: item.opcode, data: buf)), promise: nil)
                wrote = true
                continue
            }
            if let audioItem {
                let buf = context.channel.allocator.buffer(bytes: audioItem.bytes)
                var promise: EventLoopPromise<Void>?
                if priority {
                    // Measured: queued -> handed to the socket.
                    let p = context.eventLoop.makePromise(of: Void.self)
                    let queuedUs = audioItem.queuedUs, bytes = audioItem.bytes.count
                    p.futureResult.whenSuccess { [weak self] in self?.audioWritten(queuedUs: queuedUs, bytes: bytes) }
                    promise = p
                }
                context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, data: buf)), promise: promise)
                wrote = true
                continue
            }
            guard let frame else { break }

            let data = frame.data
            var len = min(Wire.maxFragmentPayload, data.count - fragOffset)
            if priority {
                lock.lock()
                len = min(pacer.fragmentPayload, data.count - fragOffset)
                let wait = pacer.take(Wire.videoHeaderSize + len + 4, nowUs: Clock.nowUs)
                if wait == nil { videoBytesOut += Int64(Wire.videoHeaderSize + len) }
                lock.unlock()
                if let wait {
                    // Not yet: the fragment stays current; sound and control still go out as they come.
                    schedulePacedPump(context, inUs: wait)
                    break
                }
            }
            let last = fragOffset + len >= data.count
            var flags: Wire.VideoFlags = []
            if frame.keyFrame { flags.insert(.key) }
            if frame.refinement { flags.insert(.refine) }
            if fragOffset == 0 { flags.insert(.first); frame.firstWriteUs = Clock.nowUs; frame.firstFragmentBytes = len }
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
