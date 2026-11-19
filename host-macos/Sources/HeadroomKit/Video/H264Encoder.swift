import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

public struct EncoderOptions {
    public var width: Int
    public var height: Int
    public var fps: Int
    public var bitrateKbps: Int
    /// auto | hardware | software
    public var preference: String
}

public struct EncodedPacket {
    public let sample: CMSampleBuffer
    public let captureUs: Int64
    public let encodeMs: Double
    /// A frame of a still screen encoded again to sharpen it (VideoPipeline's refinement), not a new picture.
    public let refinement: Bool
}

/// How the encoder spends bits. Screen content changes little most of the time and a lot at once (a scroll, a
/// window opening): it needs room for the big frames, and a still screen should end up sharp.
public struct RateControl {
    /// Apple's low-latency rate control: every frame about the same size (made for video calls).
    public var lowLatency: Bool
    /// The encoder's quicker, lower-quality mode.
    public var speedOverQuality: Bool
    /// The most it may send in any `burstWindow` seconds, as a multiple of the average rate.
    public var burstMultiple: Double
    public var burstWindow: Double

    /// The defaults, or HEADROOM_VT_RC="lowlatency|normal,speed|quality,<multiple>,<window s>" (for measuring).
    public static let current: RateControl = {
        var rc = RateControl(lowLatency: true, speedOverQuality: true, burstMultiple: 1.5, burstWindow: 0.2)
        let parts = (ProcessInfo.processInfo.environment["HEADROOM_VT_RC"] ?? "").split(separator: ",").map(String.init)
        if parts.count > 0, !parts[0].isEmpty { rc.lowLatency = parts[0] != "normal" }
        if parts.count > 1 { rc.speedOverQuality = parts[1] != "quality" }
        if parts.count > 2, let m = Double(parts[2]) { rc.burstMultiple = m }
        if parts.count > 3, let w = Double(parts[3]) { rc.burstWindow = w }
        return rc
    }()
}

/// H.264 through VideoToolbox, configured for one-in/one-out ultra-low latency like the Windows encoder:
/// Apple's low-latency rate control (infinite GOP, no B-frames, no lookahead), real-time mode, no frame
/// delay, on-demand IDR frames. Prefers the hardware encoder; falls back to the software one.
///
/// Frames are first copied (and scaled, and converted to NV12 if needed) into the encoder's own pool by a
/// VTPixelTransferSession on the GPU, so the capture buffers go straight back to ScreenCaptureKit.
public final class H264Encoder {
    public let name: String
    public let isHardware: Bool
    public let width: Int
    public let height: Int
    public private(set) var bitrateKbps: Int

    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private let fps: Int
    private let onOutput: (EncodedPacket) -> Void
    private let lock = NSLock()
    private var inFlightCount = 0
    private var submitted: [Int64: (us: Int64, refinement: Bool)] = [:]  // capture µs -> when it was submitted, and what it is
    private let rc = RateControl.current

    public var inFlight: Int { lock.lock(); defer { lock.unlock() }; return inFlightCount }

    private struct Attempt { let label: String; let spec: [CFString: Any]; let lowLatency: Bool }

    public static func create(_ o: EncoderOptions, onOutput: @escaping (EncodedPacket) -> Void) throws -> H264Encoder {
        var attempts = [Attempt]()
        if o.preference != "software" && RateControl.current.lowLatency {
            attempts.append(Attempt(label: "Apple H.264 (hardware, low latency)", spec: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
            ], lowLatency: true))
        }
        if o.preference != "software" {
            attempts.append(Attempt(label: "Apple H.264 (hardware)", spec: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
            ], lowLatency: false))
        }
        if o.preference != "hardware" {
            attempts.append(Attempt(label: "Apple H.264 (software)", spec: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: false,
            ], lowLatency: false))
        }
        var errors = [String]()
        for a in attempts {
            do {
                return try H264Encoder(o, a, onOutput: onOutput)
            } catch {
                errors.append("\(a.label): \(error)")
                Log.warn("encoder", "\(a.label) failed: \(error)")
            }
        }
        throw EncoderError.noEncoder(errors.joined(separator: "; "))
    }

    public enum EncoderError: Error, CustomStringConvertible {
        case status(String, OSStatus)
        case noEncoder(String)
        public var description: String {
            switch self {
            case .status(let what, let st): return "\(what) failed (\(st))"
            case .noEncoder(let s): return "no usable H.264 encoder: \(s)"
            }
        }
    }

    private init(_ o: EncoderOptions, _ a: Attempt, onOutput: @escaping (EncodedPacket) -> Void) throws {
        width = o.width
        height = o.height
        fps = max(1, o.fps)
        bitrateKbps = o.bitrateKbps
        self.onOutput = onOutput

        let sourceAttrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: o.width,
            kCVPixelBufferHeightKey: o.height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var s: VTCompressionSession?
        var st = VTCompressionSessionCreate(allocator: nil, width: Int32(o.width), height: Int32(o.height), codecType: kCMVideoCodecType_H264,
                                            encoderSpecification: a.spec as CFDictionary, imageBufferAttributes: sourceAttrs as CFDictionary,
                                            compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard st == noErr, let session = s else { throw EncoderError.status("VTCompressionSessionCreate", st) }
        self.session = session

        func set(_ key: CFString, _ value: Any, required: Bool = false) throws {
            let r = VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
            if r != noErr {
                if required { throw EncoderError.status("set \(key)", r) }
                Log.debug("encoder", "\(a.label): \(key) not supported (\(r))")
            }
        }
        try set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!, required: true)
        try set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!, required: true)
        try set(kVTCompressionPropertyKey_ProfileLevel, a.lowLatency ? kVTProfileLevel_H264_ConstrainedHigh_AutoLevel : kVTProfileLevel_H264_High_AutoLevel)
        try set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC)
        try set(kVTCompressionPropertyKey_ExpectedFrameRate, fps as NSNumber)
        try set(kVTCompressionPropertyKey_AverageBitRate, (o.bitrateKbps * 1000) as NSNumber, required: true)
        try set(kVTCompressionPropertyKey_DataRateLimits, Self.dataRateLimits(o.bitrateKbps, RateControl.current) as CFArray)
        // Keyframes only on demand (viewer join, decoder error, resolution change): IDRs are 10-20x larger
        // than P-frames and every periodic one is a latency spike on a constrained link.
        try set(kVTCompressionPropertyKey_MaxKeyFrameInterval, 0x7FFF_FFFF as NSNumber)
        try set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 0 as NSNumber)
        try set(kVTCompressionPropertyKey_MaxFrameDelayCount, 0 as NSNumber)
        try set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, RateControl.current.speedOverQuality ? kCFBooleanTrue! : kCFBooleanFalse!)
        // VUI: BT.709 primaries/transfer/matrix, limited range. Browsers honour these.
        try set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
        try set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
        try set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        st = VTCompressionSessionPrepareToEncodeFrames(session)
        guard st == noErr else { VTCompressionSessionInvalidate(session); throw EncoderError.status("PrepareToEncodeFrames", st) }

        var hw: CFTypeRef?
        VTSessionCopyProperty(session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, allocator: nil, valueOut: &hw)
        isHardware = (hw as? Bool) ?? a.spec[kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder] as? Bool ?? false
        name = a.label

        var t: VTPixelTransferSession?
        st = VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &t)
        guard st == noErr, let transfer = t else { VTCompressionSessionInvalidate(session); throw EncoderError.status("VTPixelTransferSessionCreate", st) }
        VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Normal)
        VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_DestinationColorPrimaries, value: kCVImageBufferColorPrimaries_ITU_R_709_2)
        VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_DestinationTransferFunction, value: kCVImageBufferTransferFunction_ITU_R_709_2)
        VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_DestinationYCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        if #available(macOS 13.0, *) {
            VTSessionSetProperty(transfer, key: kVTPixelTransferPropertyKey_RealTime, value: kCFBooleanTrue)
        }
        self.transfer = transfer
        Log.info("encoder", "using '\(name)' \(o.width)x\(o.height)@\(fps) \(o.bitrateKbps) kbps, bursts up to \(rc.burstMultiple)x per \(rc.burstWindow) s\(rc.speedOverQuality ? "" : ", quality first")")
    }

    /// A hard cap over a short window, so one big frame can't flood the link.
    private static func dataRateLimits(_ kbps: Int, _ rc: RateControl) -> [NSNumber] {
        let bytesPerWindow = Double(kbps) * 1000 / 8 * rc.burstMultiple * rc.burstWindow
        return [NSNumber(value: bytesPerWindow), NSNumber(value: rc.burstWindow)]
    }

    /// Converts `source` into an encoder buffer and submits it. Returns false if the frame was not accepted.
    public func encode(_ source: CVPixelBuffer, captureUs: Int64, forceKeyFrame: Bool, refinement: Bool = false) -> Bool {
        guard let session, let transfer, let pool = VTCompressionSessionGetPixelBufferPool(session) else { return false }
        var dstOut: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &dstOut) == kCVReturnSuccess, let dst = dstOut else { return false }
        guard VTPixelTransferSessionTransferImage(transfer, from: source, to: dst) == noErr else { return false }
        CVBufferSetAttachment(dst, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(dst, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(dst, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)

        lock.lock()
        inFlightCount += 1
        submitted[captureUs] = (Clock.nowUs, refinement)
        if submitted.count > 64 { submitted.removeAll() }
        lock.unlock()

        let props: CFDictionary? = forceKeyFrame ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary : nil
        let pts = CMTime(value: captureUs, timescale: 1_000_000)
        let st = VTCompressionSessionEncodeFrame(session, imageBuffer: dst, presentationTimeStamp: pts, duration: .invalid,
                                                 frameProperties: props, infoFlagsOut: nil) { [weak self] status, flags, sample in
            self?.encoded(status, flags, sample, captureUs)
        }
        if st != noErr {
            lock.lock(); inFlightCount -= 1; submitted[captureUs] = nil; lock.unlock()
            Log.warn("encoder", "EncodeFrame failed (\(st))")
            return false
        }
        return true
    }

    private func encoded(_ status: OSStatus, _ flags: VTEncodeInfoFlags, _ sample: CMSampleBuffer?, _ captureUs: Int64) {
        lock.lock()
        inFlightCount = max(0, inFlightCount - 1)
        let info = submitted.removeValue(forKey: captureUs)
        lock.unlock()
        guard status == noErr, !flags.contains(.frameDropped), let sample else {
            if status != noErr { Log.warn("encoder", "encode error \(status)") }
            return
        }
        let ms = info.map { Double(Clock.nowUs - $0.us) / 1000 } ?? 0
        onOutput(EncodedPacket(sample: sample, captureUs: captureUs, encodeMs: ms, refinement: info?.refinement ?? false))
    }

    public func setBitrate(_ kbps: Int) {
        guard let session, kbps != bitrateKbps else { return }
        bitrateKbps = kbps
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (kbps * 1000) as NSNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: Self.dataRateLimits(kbps, rc) as CFArray)
    }

    public func invalidate() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        transfer = nil
    }

    deinit { invalidate() }
}
