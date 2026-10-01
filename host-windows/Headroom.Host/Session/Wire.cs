using System.Buffers.Binary;

namespace Headroom.Host.Session;

/// <summary>
/// Binary message layouts (all little-endian). JSON text frames carry everything else.
/// Keep in sync with web/js/protocol.js and docs/PROTOCOL.md.
/// </summary>
public static class Wire
{
    // host -> client
    public const byte VideoFragment = 0x01;
    public const byte CursorPosition = 0x02;
    public const byte AudioPacket = 0x03;
    public const byte CursorShape = 0x05;

    // client -> host
    public const byte MouseAbs = 0x10;
    public const byte MouseRel = 0x11;
    public const byte MouseButton = 0x12;
    public const byte MouseWheel = 0x13;
    public const byte KeyEvent = 0x14;
    public const byte FrameAck = 0x15;

    public const int VideoHeaderSize = 28;
    public const int MaxFragmentPayload = 64 * 1024;

    [Flags]
    public enum VideoFlags : byte { Key = 1, First = 2, Last = 4 }

    /// <summary>
    /// [0] type, [1] flags, [2..3] epoch, [4..7] frameId, [8..11] total length, [12..15] offset,
    /// [16..23] capture time (host µs), [24..25] encode time (0.1 ms), [26..27] reserved, [28..] payload
    /// </summary>
    public static void WriteVideoHeader(Span<byte> b, VideoFlags flags, int epoch, uint frameId, int total, int offset, long captureUs, double encodeMs)
    {
        b[0] = VideoFragment;
        b[1] = (byte)flags;
        BinaryPrimitives.WriteUInt16LittleEndian(b[2..], (ushort)epoch);
        BinaryPrimitives.WriteUInt32LittleEndian(b[4..], frameId);
        BinaryPrimitives.WriteInt32LittleEndian(b[8..], total);
        BinaryPrimitives.WriteInt32LittleEndian(b[12..], offset);
        BinaryPrimitives.WriteInt64LittleEndian(b[16..], captureUs);
        BinaryPrimitives.WriteUInt16LittleEndian(b[24..], (ushort)Math.Clamp(encodeMs * 10, 0, 65535));
        BinaryPrimitives.WriteUInt16LittleEndian(b[26..], 0);
    }

    /// <summary>[0] type, [1] flags (1 = visible), [2..3] reserved, [4..7] x, [8..11] y (source-monitor pixels)</summary>
    public static byte[] CursorPos(int x, int y, bool visible)
    {
        var b = new byte[12];
        b[0] = CursorPosition;
        b[1] = (byte)(visible ? 1 : 0);
        BinaryPrimitives.WriteInt32LittleEndian(b.AsSpan(4), x);
        BinaryPrimitives.WriteInt32LittleEndian(b.AsSpan(8), y);
        return b;
    }

    /// <summary>
    /// [0] type, [1] flags, [2..3] reserved, [4..7] shape id, [8..9] w, [10..11] h, [12..13] hotX, [14..15] hotY, [16..] RGBA.
    /// w == 0 means "use the cached shape with this id".
    /// </summary>
    public static byte[] CursorShapeMessage(uint id, int w, int h, int hx, int hy, byte[]? rgba)
    {
        var b = new byte[16 + (rgba?.Length ?? 0)];
        b[0] = CursorShape;
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), id);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(8), (ushort)w);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(10), (ushort)h);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(12), (ushort)hx);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(14), (ushort)hy);
        rgba?.CopyTo(b.AsSpan(16));
        return b;
    }

    /// <summary>[0] type, [1..3] reserved, [4..7] seq, [8..15] host µs, [16..] opus packet</summary>
    public static byte[] Audio(uint seq, long timeUs, ReadOnlySpan<byte> opus)
    {
        var b = new byte[16 + opus.Length];
        b[0] = AudioPacket;
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), seq);
        BinaryPrimitives.WriteInt64LittleEndian(b.AsSpan(8), timeUs);
        opus.CopyTo(b.AsSpan(16));
        return b;
    }
}
