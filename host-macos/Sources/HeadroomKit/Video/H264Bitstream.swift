import CoreMedia
import Foundation

/// Converts VideoToolbox output into what WebCodecs wants in "avc" mode:
///  * an avcC decoder configuration record (sent once per SPS/PPS change as VideoDecoderConfig.description),
///    built from the format description's parameter sets with the SPS rewritten for zero reordering;
///  * access units as 4-byte length-prefixed NAL units, without SPS/PPS/AUD/SEI/filler.
/// Same output as the Windows host's H264Bitstream.cs (which starts from Annex B instead).
public final class H264Bitstream {
    private var rawSps: [UInt8]?
    private(set) var sps: [UInt8]?
    private(set) var pps: [UInt8]?
    private var configDirty = true
    public private(set) var spsRewritten = false

    public struct Output {
        public let data: [UInt8]
        public let keyFrame: Bool
        public let configChanged: Bool
    }

    public init() {}

    public func process(_ sample: CMSampleBuffer) -> Output? {
        guard let fmt = CMSampleBufferGetFormatDescription(sample) else { return nil }
        var headerLen: Int32 = 4
        var count = 0
        if let s = parameterSet(fmt, 0, &count, &headerLen), s != rawSps {
            rawSps = s
            // Declare "no reordering" so browser decoders output each frame immediately.
            let r = H264SpsRewriter.rewrite(s)
            sps = r.sps
            spsRewritten = r.changed
            configDirty = true
        }
        if count > 1, let p = parameterSet(fmt, 1, &count, &headerLen), p != pps {
            pps = p
            configDirty = true
        }

        guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0 else { return nil }
        var raw = [UInt8](repeating: 0, count: length)
        guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &raw) == noErr else { return nil }

        let lenSize = Int(headerLen)
        var out = [UInt8]()
        out.reserveCapacity(length)
        var key = false
        var pos = 0
        while pos + lenSize <= raw.count {
            var n = 0
            for i in 0..<lenSize { n = (n << 8) | Int(raw[pos + i]) }
            pos += lenSize
            guard n > 0, pos + n <= raw.count else { break }
            let type = raw[pos] & 0x1F
            switch type {
            case 1...5:
                if type == 5 { key = true }
                out.append(UInt8((n >> 24) & 0xFF)); out.append(UInt8((n >> 16) & 0xFF))
                out.append(UInt8((n >> 8) & 0xFF)); out.append(UInt8(n & 0xFF))
                out.append(contentsOf: raw[pos..<(pos + n)])
            case 7:
                // In-band SPS (not expected in AVCC output, but handle it like the Annex-B path does).
                let s = Array(raw[pos..<(pos + n)])
                if s != rawSps { rawSps = s; let r = H264SpsRewriter.rewrite(s); sps = r.sps; spsRewritten = r.changed; configDirty = true }
            case 8:
                let p = Array(raw[pos..<(pos + n)])
                if p != pps { pps = p; configDirty = true }
            default:
                break // 6 SEI, 9 AUD, 12 filler, others: dropped
            }
            pos += n
        }
        if out.isEmpty { return nil }
        // A sync sample without an IDR NAL can't happen with H.264, but trust the attachment too.
        if !key, let atts = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
           let first = atts.first, (first[kCMSampleAttachmentKey_NotSync] as? Bool) != true, (first[kCMSampleAttachmentKey_DependsOnOthers] as? Bool) == false {
            key = true
        }
        let changed = key && configDirty && sps != nil && pps != nil
        if changed { configDirty = false }
        return Output(data: out, keyFrame: key, configChanged: changed)
    }

    private func parameterSet(_ fmt: CMFormatDescription, _ index: Int, _ count: inout Int, _ headerLen: inout Int32) -> [UInt8]? {
        var ptr: UnsafePointer<UInt8>?
        var size = 0
        let st = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: index, parameterSetPointerOut: &ptr,
                                                                     parameterSetSizeOut: &size, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &headerLen)
        guard st == noErr, let ptr, size > 0 else { return nil }
        return Array(UnsafeBufferPointer(start: ptr, count: size))
    }

    public func buildAvcC() -> [UInt8] {
        guard let sps, let pps, sps.count >= 4 else { return [] }
        var b = [UInt8]()
        b.append(1)          // configurationVersion
        b.append(sps[1])     // AVCProfileIndication
        b.append(sps[2])     // profile_compatibility
        b.append(sps[3])     // AVCLevelIndication
        b.append(0xFF)       // 6 bits reserved + lengthSizeMinusOne = 3
        b.append(0xE1)       // 3 bits reserved + numOfSequenceParameterSets = 1
        b.append(UInt8((sps.count >> 8) & 0xFF)); b.append(UInt8(sps.count & 0xFF))
        b.append(contentsOf: sps)
        b.append(1)          // numOfPictureParameterSets
        b.append(UInt8((pps.count >> 8) & 0xFF)); b.append(UInt8(pps.count & 0xFF))
        b.append(contentsOf: pps)
        if [100, 110, 122, 144].contains(Int(sps[1])) {
            b.append(0xFC | 1)   // chroma_format_idc = 1 (4:2:0)
            b.append(0xF8 | 0)   // bit_depth_luma_minus8
            b.append(0xF8 | 0)   // bit_depth_chroma_minus8
            b.append(0)          // numOfSequenceParameterSetExt
        }
        return b
    }

    /// RFC 6381 codec string, e.g. avc1.640033.
    public func codecString() -> String {
        guard let sps, sps.count >= 4 else { return "avc1.640028" }
        return String(format: "avc1.%02x%02x%02x", sps[1], sps[2], sps[3])
    }

    /// Annex-B form of the current parameter sets (for writing .h264 files in the self-test).
    public func annexBParameterSets() -> [UInt8] {
        guard let sps, let pps else { return [] }
        return [0, 0, 0, 1] + sps + [0, 0, 0, 1] + pps
    }
}
