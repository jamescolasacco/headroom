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
    public const byte TouchPinch = 0x16;

    public const int VideoHeaderSize = 28;
    public const int MaxFragmentPayload = 64 * 1024;
    /// <summary>Video fragments of a session with audio priority: a sound packet never waits behind more than this much picture.</summary>
    public const int PriorityFragmentPayload = 16 * 1024;

    public const int AudioHeaderSize = 16;

    /// <summary>Byte [1] of an audio packet. Viewers that never asked for anything else only ever get <see cref="AudioCodec.Opus"/>.</summary>
    public enum AudioCodec : byte
    {
        /// <summary>One Opus packet (10 ms).</summary>
        Opus = 0,
        /// <summary>PCM signed 24-bit little-endian, interleaved stereo, 48 kHz, 480 frames (10 ms) = 2880 bytes.</summary>
        Pcm24 = 1,
        /// <summary>Digital silence: the payload is the frame count (u16, 480). Only for sessions with audio priority.</summary>
        Silence = 2,
    }

    public const int PcmFrames = 480;
    public const int PcmPayloadSize = PcmFrames * 2 * 3;

    [Flags]
    public enum VideoFlags : byte { Key = 1, First = 2, Last = 4, /** the still screen encoded again to sharpen it */ Refine = 8 }

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

    /// <summary>
    /// [0] type, [1] codec (<see cref="AudioCodec"/>), [2..3] reserved, [4..7] seq (+1 per 10 ms), [8..15] host µs of the
    /// first sample at capture, [16..] payload
    /// </summary>
    public static byte[] Audio(AudioCodec codec, uint seq, long timeUs, ReadOnlySpan<byte> payload)
    {
        var b = new byte[AudioHeaderSize + payload.Length];
        b[0] = AudioPacket;
        b[1] = (byte)codec;
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), seq);
        BinaryPrimitives.WriteInt64LittleEndian(b.AsSpan(8), timeUs);
        payload.CopyTo(b.AsSpan(AudioHeaderSize));
        return b;
    }

    /// <summary>Codec 0: the same bytes as before codecs existed (byte 1 was reserved, always 0).</summary>
    public static byte[] Audio(uint seq, long timeUs, ReadOnlySpan<byte> opus) => Audio(AudioCodec.Opus, seq, timeUs, opus);

    /// <summary>Codec 2's payload: <paramref name="frames"/> samples per channel of digital silence (u16).</summary>
    public static byte[] SilencePayload(int frames = PcmFrames)
    {
        var b = new byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(b, (ushort)Math.Clamp(frames, 0, ushort.MaxValue));
        return b;
    }

    /// <summary>
    /// Codec 1's payload: interleaved float samples (L R L R …) as signed 24-bit little-endian, 3 bytes each, into
    /// <paramref name="dest"/>. True if every sample came out 0 (digital silence).
    /// </summary>
    public static bool WritePcm24(ReadOnlySpan<float> samples, Span<byte> dest)
    {
        bool zero = true;
        for (int i = 0, o = 0; i < samples.Length; i++, o += 3)
        {
            int q = Pcm24(samples[i]);
            zero &= q == 0;
            dest[o] = (byte)q;
            dest[o + 1] = (byte)(q >> 8);
            dest[o + 2] = (byte)(q >> 16);
        }
        return zero;
    }

    /// <summary>
    /// One float sample (full scale ±1.0) as a signed 24-bit value: x · 2^23 rounded to nearest (halves away from zero),
    /// clipped to [-2^23, 2^23 - 1]; NaN is 0. Exact for every k / 2^23 in range, so a 24-bit source survives bit for
    /// bit. The same as the Mac host's Wire.pcm24.
    /// </summary>
    public static int Pcm24(float x)
    {
        float v = x * 8388608f; // a power of two: exact (or ±infinity, clipped below)
        if (v >= 8388607f) return 8388607;
        if (v <= -8388608f) return -8388608;
        if (float.IsNaN(v)) return 0;
        return (int)MathF.Round(v, MidpointRounding.AwayFromZero);
    }
}
