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
}

public struct PipelineSettings {
    public var monitor: MonitorInfo
    public var maxFps = 60
    public var bitrateKbps = 12000
    public var maxWidth = 0   // 0 = native
    public var maxHeight = 0
    public var encoderPreference = "auto"
}

/// One viewer's video stream: waits for new frames from the shared CaptureSource, encodes, and hands frames
/// to the sink. Frames are only produced when the screen changes (plus a few "refinement" frames once it goes
/// still, so text sharpens to full quality), capped at maxFps, and skipped — never queued — when the network
/// can't keep up. (Port of the Windows host's VideoPipeline.cs.)
public final class VideoPipeline {
    private static let refinementFrames = 4
    private static let refinementIntervalMs: Int64 = 70
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
        var nextFrameAt: Int64 = 0
        var lastVersion: Int64 = -1
        var refinementLeft = 0
        var nextRefineAt: Int64 = 0

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
            stateLock.unlock()
            if pending > 0 { encoder?.setBitrate(pending) }

            now = Clock.nowMs
            let version = src.frameVersion
            let fresh = version != lastVersion
            let refine = !fresh && refinementLeft > 0 && now >= nextRefineAt
            let key = keyframeRequested
            if !fresh && !refine && !key { continue }
            if now < nextFrameAt { continue } // fps cap; the wait above wakes us in time

            guard let sink else { break } // the session is gone: stop rather than spin
            guard sink.canSendVideo else {
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
            if encodeOne(src, key: key) {
                if key { keyframeRequested = false }
                if fresh {
                    lastVersion = version
                    refinementLeft = Self.refinementFrames
                } else if refine {
                    refinementLeft -= 1
                }
                nextRefineAt = now + Self.refinementIntervalMs
                nextFrameAt = now + Int64(1000 / max(1, settings.maxFps))
            }
        }
        tearDownEncoder()
        detachSource()
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
                                                            bitrateKbps: settings.bitrateKbps, preference: settings.encoderPreference)) { [weak self] p in
                self?.onEncoded(p, epoch: epoch)
            }
            encoder = enc
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

    private func encodeOne(_ src: CaptureSource, key: Bool) -> Bool {
        guard let enc = encoder, enc.inFlight < Self.maxEncoderInFlight, let pb = src.latest else { return false }
        guard enc.encode(pb, captureUs: Clock.nowUs, forceKeyFrame: key) else { return false }
        framesEncoded += 1
        return true
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
        frameId &+= 1
        let frame = EncodedVideoFrame(epoch: epoch, frameId: frameId, data: processed.data, keyFrame: processed.keyFrame,
                                      captureTimeUs: p.captureUs, encodeMs: p.encodeMs)
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
