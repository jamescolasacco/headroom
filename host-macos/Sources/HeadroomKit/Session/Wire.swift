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

    public struct VideoFlags: OptionSet {
        public let rawValue: UInt8
        public init(rawValue: UInt8) { self.rawValue = rawValue }
        public static let key = VideoFlags(rawValue: 1)
        public static let first = VideoFlags(rawValue: 2)
        public static let last = VideoFlags(rawValue: 4)
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

    /// [0] type, [1..3] reserved, [4..7] seq, [8..15] host µs, [16..] opus packet
    public static func audio(seq: UInt32, timeUs: Int64, opus: [UInt8]) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: 16)
        b[0] = audioPacket
        b.putU32(seq, at: 4)
        b.putI64(timeUs, at: 8)
        b.append(contentsOf: opus)
        return b
    }
}
