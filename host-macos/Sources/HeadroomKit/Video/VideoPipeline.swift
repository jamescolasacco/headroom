import CoreMedia
import CoreVideo
import Foundation

public struct VideoStreamConfig {
    public let epoch: Int
    public let codec: String
    public let description: [UInt8]
    public let width: Int
    public let height: Int
    public let sourceWidth: Int
    public let sourceHeight: Int
    public let monitorId: String
    public let encoderName: String
    public let hardware: Bool
    public let fullRange: Bool
}

public protocol VideoSink: AnyObject {
    func onVideoConfig(_ config: VideoStreamConfig)
    func onVideoFrame(_ frame: EncodedVideoFrame)
    func onCaptureStatus(_ status: CaptureStatus, detail: String?)
    /// Flow control: false while the network path is full (the frame is skipped, not queued).
    var canSendVideo: Bool { get }
    /// Sharpening a still screen is extra: it goes only into an idle path (nothing in flight), so it never delays a
    /// new picture or looks like congestion.
    var canSendRefinement: Bool { get }
}

public struct PipelineSettings {
    public var monitor: MonitorInfo
    public var maxFps = 60
    public var bitrateKbps = 12000
    /// The most the session allows: sharpening a still screen may spend up to this for a moment.
    public var maxBitrateKbps = 0
    public var maxWidth = 0   // 0 = native
    public var maxHeight = 0
    public var encoderPreference = "auto"
}

/// One viewer's video stream: waits for new frames from the shared CaptureSource, encodes, and hands frames
/// to the sink. Frames are only produced when the screen changes (plus sharpening passes once it holds still,
/// until text is at full quality), capped at maxFps, and skipped — never queued — when the network can't keep
/// up. (Port of the Windows host's VideoPipeline.cs.)
public final class VideoPipeline {
    /// Sharpening a screen that went still: the same picture encoded again, each time coding what the last one lost,
    /// up to 20 times, 70 ms apart (later if the path is busy), until three passes in a row come out tiny. At the
    /// stream's own bitrate: above it (`boost`) the encoder paid the extra back on the next scroll's frames, which
    /// came out worse (measured with tools/stream-check.mjs --source). Only a whole new picture (`keyFirst`) gets
    /// twice the bitrate: after a fast scroll on 10 Mb/s it was 43.5 dB 0.6 s after the stop, 41 at the stream's.
    struct Refinement {
        /// At most this many times.
        var maxFrames: Int
        /// This far apart (0: the stream's frame interval).
        var intervalMs: Int64
        /// The bitrate while sharpening, as a multiple of the stream's (up to the session's maximum).
        var boost: Double
        /// Done early once a pass comes out smaller than this many bytes per pixel: nothing left to sharpen.
        var convergedBytesPerPixel: Double
        /// The first pass is a whole new picture (a keyframe) rather than a correction of the smudged one: always
        /// (true), never (false), or (nil) when the picture left on the screen came out smudged (stillSmudged).
        var keyFirst: Bool? = nil
        /// That whole new picture's bitrate, as a multiple of the stream's (HEADROOM_REFINE_KEY_BOOST).
        var keyBoost = 2.0

        /// The defaults, or HEADROOM_REFINE="<max frames>,<interval ms>,<boost>,<converged bytes per pixel>[,key|nokey]".
        static let current: Refinement = {
            var r = Refinement(maxFrames: 20, intervalMs: 70, boost: 1, convergedBytesPerPixel: 0.0005)
            let parts = (ProcessInfo.processInfo.environment["HEADROOM_REFINE"] ?? "").split(separator: ",").map(String.init)
            if parts.count > 0, let n = Int(parts[0]) { r.maxFrames = n }
            if parts.count > 1, let n = Int64(parts[1]) { r.intervalMs = n }
            if parts.count > 2, let n = Double(parts[2]) { r.boost = n }
            if parts.count > 3, let n = Double(parts[3]) { r.convergedBytesPerPixel = n }
            if parts.count > 4 { r.keyFirst = parts[4] == "key" ? true : parts[4] == "nokey" ? false : nil }
            if let s = ProcessInfo.processInfo.environment["HEADROOM_REFINE_KEY_BOOST"], let n = Double(s) { r.keyBoost = n }
            return r
        }()
    }
    private static let refinement = Refinement.current
    private static let maxH264Dimension = 4096
    private static let maxEncoderInFlight = 2

    private weak var sink: VideoSink?
    private var thread: Thread?
    private let done = DispatchSemaphore(value: 0)
    private let stateLock = NSLock()
    private var stopFlag = false
    private var keyframeRequestedFlag = true
    private var pendingBitrate = 0
    private var settings: PipelineSettings
    private var pendingSettings: PipelineSettings?

    private var source: CaptureSource?
    private var signal: AutoResetEvent?
    private var encoder: H264Encoder?
    private var builtGeneration: Int64 = -1
    private var lastStatus: CaptureStatus = .starting
    private var sourceDims = (0, 0)

    // Encoder-callback state (VideoToolbox's thread), under `stateLock`.
    private var epochValue: Int
    private var bitstream = H264Bitstream()
    private var configSentForEpoch = -1
    private var frameId: UInt32 = 0
    private var lastEncodeMsValue = 0.0
    private var encoderNameValue: String?
    // Sharpening passes of the still picture now on screen (`stillSeq` counts new pictures): how many came out tiny
    // in a row (onEncoded), and when the last one did.
    private var stillSeq = 0
    private var passSeq: [Int64: Int] = [:]  // a pass's capture time → the still picture it sharpens
    private var tinyPasses = 0
    private var lastTinyAtMs: Int64 = 0
    /// After a tiny pass the next one waits this long, and twice as long after a second: after a scroll that needed
    /// more than its share the encoder pays it back with near-empty frames for a second or so, and sharpening that
    /// took those for "done" left the picture smudged.
    private static let recheckMs: Int64 = 400
    /// Sharpening starts once the screen has held still this long: one late frame in the middle of a scroll isn't a
    /// stop (passes sent then would only hold up the frames after them).
    private static let stillAfterMs: Int64 = 100
    /// A whole new picture only once the screen has held still this long: it's big, and the frames of a scroll that
    /// goes on after a short pause would wait behind it.
    private static let keyStillMs: Int64 = 150
    /// New pictures lately, when and at what quantizer (onEncoded), and when the picture on screen was last whole and
    /// sharp (a whole new picture sent, or sharpening done). Under `stateLock`.
    private var recentFreshQp: [(ms: Int64, qp: Int)] = []
    private var sharpAtMs: Int64 = 0
    /// From this quantizer up, text comes out smudged.
    private static let smudgedQp = 30

    // The bitrate the session asked for, and whether the encoder is running above it to sharpen a still screen.
    private var targetKbps = 0
    private var boost = 1.0   // the encoder's bitrate is the target times this (more while sharpening)

    public private(set) var framesEncoded = 0
    public private(set) var framesSkippedForFlowControl = 0

    public var lastEncodeMs: Double { stateLock.lock(); defer { stateLock.unlock() }; return lastEncodeMsValue }
    public var encoderName: String? { stateLock.lock(); defer { stateLock.unlock() }; return encoderNameValue }
    public var monitor: MonitorInfo { stateLock.lock(); defer { stateLock.unlock() }; return settings.monitor }
    public var currentSource: CaptureSource? { stateLock.lock(); defer { stateLock.unlock() }; return source }

    public init(settings: PipelineSettings, sink: VideoSink, initialEpoch: Int) {
        self.settings = settings
        self.sink = sink
        epochValue = initialEpoch
        let t = Thread { [weak self] in self?.run() }
        t.name = "video-pipeline"
        t.qualityOfService = .userInteractive
        thread = t
        t.start()
    }

    public func requestKeyframe() {
        stateLock.lock(); keyframeRequestedFlag = true; let sig = signal; stateLock.unlock()
        sig?.set()
    }

    public func setBitrate(_ kbps: Int) {
        stateLock.lock(); pendingBitrate = kbps; stateLock.unlock()
    }

    /// Switch monitor / resolution / fps without tearing down the viewer connection.
    public func updateSettings(_ s: PipelineSettings) {
        stateLock.lock(); pendingSettings = s; let sig = signal; stateLock.unlock()
        sig?.set()
    }

    private var stopping: Bool { stateLock.lock(); defer { stateLock.unlock() }; return stopFlag }
    private var keyframeRequested: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return keyframeRequestedFlag }
        set { stateLock.lock(); keyframeRequestedFlag = newValue; stateLock.unlock() }
    }

    private func run() {
        defer { done.signal() }
        attachSource(settings.monitor)
        targetKbps = settings.bitrateKbps
        var nextFrameAt: Int64 = 0
        var lastVersion: Int64 = -1
        var stillSince: Int64 = 0   // when the newest new picture went out
        var refinementLeft = 0
        var nextRefineAt: Int64 = 0
        let r = Self.refinement

        while !stopping {
            var now = Clock.nowMs
            var wait: Int64 = 250
            if refinementLeft > 0 { wait = min(250, max(1, nextRefineAt - now)) }
            if nextFrameAt > now { wait = min(wait, max(1, nextFrameAt - now)) }
            signal?.wait(timeoutMs: Int(wait))
            if stopping { break }

            applyPendingSettings()
            guard let src = source else { continue }
            let st = src.status
            if st != lastStatus {
                lastStatus = st
                sink?.onCaptureStatus(st, detail: src.statusDetail)
                if st == .ok { keyframeRequested = true }
            }
            if st != .ok || !src.hasImage { continue }

            stateLock.lock()
            let pending = pendingBitrate
            pendingBitrate = 0
            let tiny = tinyPasses, tinyAt = lastTinyAtMs
            stateLock.unlock()
            if pending > 0 { targetKbps = pending; applyBitrate() }
            // A pass that comes out tiny: nothing left to sharpen, or the encoder had spent its budget for the moment
            // (right after a scroll or a whole new screen). Passes a while later tell which: three tiny, it's done.
            if refinementLeft > 0 && tiny >= 3 { refinementLeft = 0; setBoost(1); markSharp() }
            else if refinementLeft > 0 && tiny > 0 { nextRefineAt = max(nextRefineAt, tinyAt + Self.recheckMs << Int64(tiny - 1)) }

            now = Clock.nowMs
            let version = src.frameVersion
            let fresh = version != lastVersion
            let refine = !fresh && refinementLeft > 0 && now >= nextRefineAt
            let key = keyframeRequested
            if !fresh && !refine && !key { continue }
            if now < nextFrameAt { continue } // fps cap; the wait above wakes us in time

            guard let sink else { break } // the session is gone: stop rather than spin
            let sharpening = refine && !key
            let wholePicture = sharpening && refinementLeft == r.maxFrames && (r.keyFirst ?? stillSmudged(now))
            if wholePicture && now < stillSince + Self.keyStillMs {
                nextRefineAt = stillSince + Self.keyStillMs
                continue
            }
            if sharpening && !sink.canSendRefinement {
                nextRefineAt = now + 4 // the path is busy: sharpen once it's idle
                continue
            }
            guard sharpening || sink.canSendVideo else {
                framesSkippedForFlowControl += 1
                // Don't spin: poll again shortly. The frame isn't lost — we'll send the newest one.
                Thread.sleep(forTimeInterval: 0.002)
                signal?.set()
                continue
            }

            guard ensureBuilt(src) else {
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }
            // Sharpening has its own bitrate (a whole new picture, more); a new picture goes back to the stream's.
            setBoost(wholePicture ? r.keyBoost : sharpening ? r.boost : 1)
            if let sent = encodeOne(src, key: key || wholePicture, sharpen: sharpening, stillVersion: lastVersion) {
                if key { keyframeRequested = false }
                let frameInterval = Int64(1000 / max(1, settings.maxFps))
                let passInterval = r.intervalMs > 0 ? r.intervalMs : frameInterval
                if sent.refinement {
                    refinementLeft -= 1
                    if refinementLeft == 0 { setBoost(1) }
                    if wholePicture { markSharp() }
                    nextRefineAt = now + passInterval
                } else {
                    lastVersion = sent.version
                    stillSince = now
                    refinementLeft = r.maxFrames
                    nextRefineAt = now + max(passInterval, Self.stillAfterMs)
                }
                nextFrameAt = now + frameInterval
            }
        }
        tearDownEncoder()
        detachSource()
    }

    /// Whether the picture left on the still screen came out smudged: a new picture in the second before, since it was
    /// last sharp, was coded at QP 30 or more (the encoder was short of bits for what was changing, as in a fast
    /// scroll). Any of them, not just the last: a caret blinking or a clock ticking right after the stop is a sharp
    /// little update on a smudged screen. Then the first sharpening pass is a whole new picture: it gets a keyframe's
    /// budget and is sharp in one go (44.7 dB 0.63 s after a fast scroll stopped, on 10 Mb/s), where corrections of
    /// the smudged one, each at a frame's budget, took 1-2 s to reach 38-41 dB. Typing, slow scrolls and page jumps
    /// come out sharp already and don't need it.
    private func stillSmudged(_ now: Int64) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return recentFreshQp.contains { $0.ms > sharpAtMs && now - $0.ms <= 1000 && $0.qp >= Self.smudgedQp }
    }

    /// The picture on screen is whole and sharp as of now.
    private func markSharp() {
        stateLock.lock(); sharpAtMs = Clock.nowMs; stateLock.unlock()
    }

    /// The encoder at the stream's bitrate, or above it while sharpening.
    private func applyBitrate() {
        guard let enc = encoder, targetKbps > 0 else { return }
        var kbps = targetKbps
        if boost > 1 {
            let cap = settings.maxBitrateKbps > 0 ? settings.maxBitrateKbps : Int.max
            kbps = max(targetKbps, min(cap, Int(Double(targetKbps) * boost)))
        }
        enc.setBitrate(kbps)
    }

    private func setBoost(_ b: Double) {
        let b = max(1, b)
        guard b != boost else { return }
        boost = b
        applyBitrate()
    }

    private func applyPendingSettings() {
        stateLock.lock()
        let next = pendingSettings
        pendingSettings = nil
        stateLock.unlock()
        guard let next else { return }
        let monitorChanged = next.monitor.id != settings.monitor.id
        stateLock.lock(); settings = next; stateLock.unlock()
        tearDownEncoder() // resolution/fps/encoder may differ — rebuild lazily
        if monitorChanged {
            detachSource()
            attachSource(next.monitor)
        }
        keyframeRequested = true
    }

    private func attachSource(_ m: MonitorInfo) {
        let src = CaptureHub.acquire(m)
        let sig = src.subscribe()
        stateLock.lock()
        source = src
        signal = sig
        stateLock.unlock()
        lastStatus = .starting
    }

    private func detachSource() {
        stateLock.lock()
        let src = source, sig = signal
        source = nil
        stateLock.unlock()
        guard let src else { return }
        if let sig { src.unsubscribe(sig) }
        CaptureHub.release(src)
    }

    private func ensureBuilt(_ src: CaptureSource) -> Bool {
        if encoder != nil && builtGeneration == src.generation { return true }
        tearDownEncoder()
        guard let latest = src.latest else { return false }
        let srcW = CVPixelBufferGetWidth(latest), srcH = CVPixelBufferGetHeight(latest)

        var scale = 1.0
        if settings.maxWidth > 0 { scale = min(scale, Double(settings.maxWidth) / Double(srcW)) }
        if settings.maxHeight > 0 { scale = min(scale, Double(settings.maxHeight) / Double(srcH)) }
        scale = min(scale, min(Double(Self.maxH264Dimension) / Double(srcW), Double(Self.maxH264Dimension) / Double(srcH)))
        let outW = max(64, Int((Double(srcW) * scale).rounded())) & ~1
        let outH = max(64, Int((Double(srcH) * scale).rounded())) & ~1

        stateLock.lock()
        epochValue += 1
        let epoch = epochValue
        bitstream = H264Bitstream() // forces SPS/PPS (decoder config) to be re-sent with the next IDR
        stateLock.unlock()
        do {
            let enc = try H264Encoder.create(EncoderOptions(width: outW, height: outH, fps: settings.maxFps,
                                                            bitrateKbps: targetKbps > 0 ? targetKbps : settings.bitrateKbps,
                                                            preference: settings.encoderPreference)) { [weak self] p in
                self?.onEncoded(p, epoch: epoch)
            }
            encoder = enc
            boost = 1
            stateLock.lock(); encoderNameValue = enc.name; stateLock.unlock()
        } catch {
            Log.error("pipeline", "encoder creation failed", error)
            sink?.onCaptureStatus(.unavailable, detail: "video encoder unavailable: \(error)")
            return false
        }
        builtGeneration = src.generation
        keyframeRequested = true
        sourceDims = (srcW, srcH)
        Log.info("pipeline", "stream \(src.monitor.id) \(srcW)x\(srcH) -> \(outW)x\(outH) @\(settings.maxFps)fps epoch \(epoch)")
        return true
    }

    /// Encodes the newest picture: a sharpening pass (`sharpen`) only if it's still the one last sent
    /// (`stillVersion`); one that changed meanwhile goes out as the new picture it is.
    private func encodeOne(_ src: CaptureSource, key: Bool, sharpen: Bool, stillVersion: Int64) -> (version: Int64, refinement: Bool)? {
        guard let enc = encoder, enc.inFlight < Self.maxEncoderInFlight, let newest = src.latestAndVersion else { return nil }
        let (pb, version) = newest
        let refinement = sharpen && version == stillVersion
        let us = Clock.nowUs
        stateLock.lock()
        if refinement { passSeq[us] = stillSeq } else { stillSeq += 1; tinyPasses = 0; passSeq.removeAll() }
        stateLock.unlock()
        guard enc.encode(pb, captureUs: us, forceKeyFrame: key, refinement: refinement) else { return nil }
        framesEncoded += 1
        return (version, refinement)
    }

    /// Encoder output (VideoToolbox's callback thread).
    private func onEncoded(_ p: EncodedPacket, epoch: Int) {
        stateLock.lock()
        guard epoch == epochValue, let processed = bitstream.process(p.sample) else { stateLock.unlock(); return }
        lastEncodeMsValue = p.encodeMs
        var config: VideoStreamConfig?
        if processed.configChanged || (processed.keyFrame && configSentForEpoch != epoch) {
            configSentForEpoch = epoch
            let enc = encoder
            config = VideoStreamConfig(epoch: epoch, codec: bitstream.codecString(), description: bitstream.buildAvcC(),
                                       width: enc?.width ?? 0, height: enc?.height ?? 0, sourceWidth: sourceDims.0, sourceHeight: sourceDims.1,
                                       monitorId: settings.monitor.id, encoderName: enc?.name ?? "VideoToolbox", hardware: enc?.isHardware ?? false,
                                       fullRange: false)
        }
        guard configSentForEpoch == epoch else { stateLock.unlock(); return } // no decoder config yet: deltas are useless
        if !p.refinement, let qp = processed.qp {
            let now = Clock.nowMs
            recentFreshQp.removeAll { now - $0.ms > 2000 }
            recentFreshQp.append((now, qp))
        }
        Log.debug("pipeline", "frame \(frameId &+ 1): \(processed.data.count / 1024) KB, QP \(processed.qp.map(String.init) ?? "?")\(processed.keyFrame ? ", key" : "")\(p.refinement ? ", sharpening" : "")")
        if p.refinement, let seq = passSeq.removeValue(forKey: p.captureUs), seq == stillSeq,
           Self.refinement.convergedBytesPerPixel > 0, let enc = encoder {
            if Double(processed.data.count) < Double(enc.width * enc.height) * Self.refinement.convergedBytesPerPixel {
                tinyPasses += 1
                lastTinyAtMs = Clock.nowMs
            } else {
                tinyPasses = 0
            }
        }
        frameId &+= 1
        let frame = EncodedVideoFrame(epoch: epoch, frameId: frameId, data: processed.data, keyFrame: processed.keyFrame,
                                      captureTimeUs: p.captureUs, encodeMs: p.encodeMs, refinement: p.refinement)
        stateLock.unlock()
        if let config { sink?.onVideoConfig(config) }
        sink?.onVideoFrame(frame)
    }

    private func tearDownEncoder() {
        encoder?.invalidate()
        encoder = nil
        builtGeneration = -1
    }

    public func dispose() {
        stateLock.lock(); stopFlag = true; let sig = signal; stateLock.unlock()
        sig?.set()
        _ = done.wait(timeout: .now() + 3)
    }
}
