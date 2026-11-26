import Foundation

/// Binary message layouts (all little-endian). JSON text frames carry everything else.
/// Keep in sync with web/js/protocol.js, docs/PROTOCOL.md and the Windows host's Wire.cs.
public enum Wire {
    // host -> client
    public static let videoFragment: UInt8 = 0x01
    public static let cursorPosition: UInt8 = 0x02
    public static let audioPacket: UInt8 = 0x03
    public static let cursorShape: UInt8 = 0x05

    // client -> host
    public static let mouseAbs: UInt8 = 0x10
    public static let mouseRel: UInt8 = 0x11
    public static let mouseButton: UInt8 = 0x12
    public static let mouseWheel: UInt8 = 0x13
    public static let keyEvent: UInt8 = 0x14
    public static let frameAck: UInt8 = 0x15

    public static let videoHeaderSize = 28
    public static let maxFragmentPayload = 64 * 1024
    /// Video fragments of a session with audio priority: a sound packet never waits behind more than this much picture.
    public static let priorityFragmentPayload = 16 * 1024

    public static let audioHeaderSize = 16

    /// Byte [1] of an audio packet. Viewers that never asked for anything else only ever get `opus`.
    public enum AudioCodec: UInt8 {
        /// One Opus packet (10 ms).
        case opus = 0
        /// PCM signed 24-bit little-endian, interleaved stereo, 48 kHz, 480 frames (10 ms) = 2880 bytes.
        case pcm24 = 1
        /// Digital silence: the payload is the frame count (u16, 480). Only for sessions with audio priority.
        case silence = 2
    }

    public static let pcmFrames = 480
    public static let pcmPayloadSize = pcmFrames * 2 * 3

    public struct VideoFlags: OptionSet {
        public let rawValue: UInt8
        public init(rawValue: UInt8) { self.rawValue = rawValue }
        public static let key = VideoFlags(rawValue: 1)
        public static let first = VideoFlags(rawValue: 2)
        public static let last = VideoFlags(rawValue: 4)
        /// The still screen encoded again to sharpen it (refinement), not a new picture. Viewers needn't care.
        public static let refine = VideoFlags(rawValue: 8)
    }

    /// [0] type, [1] flags, [2..3] epoch, [4..7] frameId, [8..11] total length, [12..15] offset,
    /// [16..23] capture time (host µs), [24..25] encode time (0.1 ms), [26..27] reserved, [28..] payload
    public static func videoHeader(flags: VideoFlags, epoch: Int, frameId: UInt32, total: Int, offset: Int, captureUs: Int64, encodeMs: Double) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: videoHeaderSize)
        b[0] = videoFragment
        b[1] = flags.rawValue
        b.putU16(UInt16(truncatingIfNeeded: epoch), at: 2)
        b.putU32(frameId, at: 4)
        b.putI32(Int32(total), at: 8)
        b.putI32(Int32(offset), at: 12)
        b.putI64(captureUs, at: 16)
        b.putU16(UInt16(max(0, min(65535, encodeMs * 10))), at: 24)
        return b
    }

    /// [0] type, [1] flags (1 = visible), [2..3] reserved, [4..7] x, [8..11] y (source-monitor pixels)
    public static func cursorPos(x: Int, y: Int, visible: Bool) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: 12)
        b[0] = cursorPosition
        b[1] = visible ? 1 : 0
        b.putI32(Int32(clamping: x), at: 4)
        b.putI32(Int32(clamping: y), at: 8)
        return b
    }

    /// [0] type, [1] flags, [2..3] reserved, [4..7] shape id, [8..9] w, [10..11] h, [12..13] hotX, [14..15] hotY, [16..] RGBA.
    /// w == 0 means "use the cached shape with this id".
    public static func cursorShapeMessage(id: UInt32, w: Int, h: Int, hotX: Int, hotY: Int, rgba: [UInt8]?) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: 16)
        b[0] = cursorShape
        b.putU32(id, at: 4)
        b.putU16(UInt16(w), at: 8)
        b.putU16(UInt16(h), at: 10)
        b.putU16(UInt16(hotX), at: 12)
        b.putU16(UInt16(hotY), at: 14)
        if let rgba { b.append(contentsOf: rgba) }
        return b
    }

    /// [0] type, [1] codec (AudioCodec), [2..3] reserved, [4..7] seq (+1 per 10 ms), [8..15] host µs of the first
    /// sample at capture, [16..] payload
    public static func audio(codec: AudioCodec, seq: UInt32, timeUs: Int64, payload: [UInt8]) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: audioHeaderSize)
        b.reserveCapacity(audioHeaderSize + payload.count)
        putAudioHeader(&b, codec: codec, seq: seq, timeUs: timeUs)
        b.append(contentsOf: payload)
        return b
    }

    /// Codec 0: the same bytes as before codecs existed (byte 1 was reserved, always 0).
    public static func audio(seq: UInt32, timeUs: Int64, opus: [UInt8]) -> [UInt8] {
        audio(codec: .opus, seq: seq, timeUs: timeUs, payload: opus)
    }

    /// Codec 2: `frames` samples per channel of digital silence.
    public static func audioSilence(seq: UInt32, timeUs: Int64, frames: Int = pcmFrames) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: audioHeaderSize + 2)
        putAudioHeader(&b, codec: .silence, seq: seq, timeUs: timeUs)
        b.putU16(UInt16(clamping: frames), at: audioHeaderSize)
        return b
    }

    /// Codec 1: 480 stereo frames of float samples (interleaved L R, starting at `start`) as signed 24-bit LE.
    public static func audioPcm24(seq: UInt32, timeUs: Int64, samples: UnsafeBufferPointer<Float>, start: Int) -> [UInt8] {
        let count = pcmFrames * 2
        precondition(start >= 0 && start + count <= samples.count)
        var b = [UInt8](repeating: 0, count: audioHeaderSize + pcmPayloadSize)
        putAudioHeader(&b, codec: .pcm24, seq: seq, timeUs: timeUs)
        b.withUnsafeMutableBufferPointer { out in
            var o = audioHeaderSize
            for i in start..<(start + count) {
                let q = UInt32(bitPattern: pcm24(samples[i]))
                out[o] = UInt8(truncatingIfNeeded: q)
                out[o + 1] = UInt8(truncatingIfNeeded: q >> 8)
                out[o + 2] = UInt8(truncatingIfNeeded: q >> 16)
                o += 3
            }
        }
        return b
    }

    /// One float sample (full scale ±1.0) as a signed 24-bit value: x · 2^23 rounded to nearest (halves away from
    /// zero), clipped to [-2^23, 2^23 - 1]; NaN is 0. Exact for every k / 2^23 in range, so a 24-bit source survives
    /// bit for bit.
    @inline(__always)
    public static func pcm24(_ x: Float) -> Int32 {
        let v = x * 8_388_608 // a power of two: exact (or ±inf, clipped below)
        if v >= 8_388_607 { return 8_388_607 }
        if v <= -8_388_608 { return -8_388_608 }
        if v.isNaN { return 0 }
        return Int32(v.rounded(.toNearestOrAwayFromZero))
    }

    private static func putAudioHeader(_ b: inout [UInt8], codec: AudioCodec, seq: UInt32, timeUs: Int64) {
        b[0] = audioPacket
        b[1] = codec.rawValue
        b[2] = 0
        b[3] = 0
        b.putU32(seq, at: 4)
        b.putI64(timeUs, at: 8)
    }
}
