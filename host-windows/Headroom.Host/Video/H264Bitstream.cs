namespace Headroom.Host.Video;

/// <summary>
/// Converts encoder Annex-B output into what WebCodecs wants in "avc" mode:
///  * an avcC decoder configuration record (sent once per SPS/PPS change as VideoDecoderConfig.description)
///  * access units as 4-byte length-prefixed NAL units, without SPS/PPS/AUD/SEI/filler.
/// This form is accepted identically by Chrome, Edge, Firefox and Safari's VideoDecoder.
/// </summary>
public sealed class H264Bitstream
{
    private byte[]? _sps;
    private byte[]? _rawSps;
    public bool SpsRewritten { get; private set; }
    private byte[]? _pps;
    private bool _configDirty = true;

    public byte[]? Sps => _sps;
    public byte[]? Pps => _pps;

    public sealed record Output(byte[] Data, bool KeyFrame, bool ConfigChanged);

    public Output? Process(ReadOnlySpan<byte> annexB)
    {
        var nals = SplitAnnexB(annexB);
        bool key = false;
        int total = 0;
        foreach (var (off, len) in nals)
        {
            int type = annexB[off] & 0x1F;
            switch (type)
            {
                case 7:
                    var sps = annexB.Slice(off, len).ToArray();
                    if (_rawSps == null || !sps.AsSpan().SequenceEqual(_rawSps))
                    {
                        _rawSps = sps;
                        // Declare "no reordering" so browser decoders output each frame immediately.
                        _sps = H264SpsRewriter.Rewrite(sps, out bool rewritten);
                        SpsRewritten = rewritten;
                        _configDirty = true;
                    }
                    break;
                case 8:
                    var pps = annexB.Slice(off, len).ToArray();
                    if (_pps == null || !pps.AsSpan().SequenceEqual(_pps)) { _pps = pps; _configDirty = true; }
                    break;
                case 5:
                    key = true;
                    total += 4 + len;
                    break;
                case 1: case 2: case 3: case 4:
                    total += 4 + len;
                    break;
                // 6 SEI, 9 AUD, 12 filler, others: dropped
            }
        }
        if (total == 0) return null;

        var outBuf = new byte[total];
        int pos = 0;
        foreach (var (off, len) in nals)
        {
            int type = annexB[off] & 0x1F;
            if (type < 1 || type > 5) continue;
            outBuf[pos++] = (byte)(len >> 24);
            outBuf[pos++] = (byte)(len >> 16);
            outBuf[pos++] = (byte)(len >> 8);
            outBuf[pos++] = (byte)len;
            annexB.Slice(off, len).CopyTo(outBuf.AsSpan(pos));
            pos += len;
        }
        bool changed = key && _configDirty && _sps != null && _pps != null;
        if (changed) _configDirty = false;
        return new Output(outBuf, key, changed);
    }

    /// <summary>Returns (offset, length) of each NAL payload (start codes stripped).</summary>
    public static List<(int Offset, int Length)> SplitAnnexB(ReadOnlySpan<byte> data)
    {
        var result = new List<(int, int)>(8);
        int i = 0, n = data.Length;
        int start = -1;
        while (i + 2 < n)
        {
            if (data[i] == 0 && data[i + 1] == 0 && (data[i + 2] == 1 || (i + 3 < n && data[i + 2] == 0 && data[i + 3] == 1)))
            {
                int scLen = data[i + 2] == 1 ? 3 : 4;
                if (start >= 0)
                {
                    int end = i;
                    // trailing zero bytes belong to the next start code
                    while (end > start && data[end - 1] == 0) end--;
                    if (end > start) result.Add((start, end - start));
                }
                i += scLen;
                start = i;
                continue;
            }
            i++;
        }
        if (start >= 0 && start < n) result.Add((start, n - start));
        return result;
    }

    public byte[] BuildAvcC()
    {
        if (_sps == null || _pps == null) throw new InvalidOperationException("no SPS/PPS yet");
        var sps = _sps;
        var pps = _pps;
        var ms = new MemoryStream();
        ms.WriteByte(1);          // configurationVersion
        ms.WriteByte(sps[1]);     // AVCProfileIndication
        ms.WriteByte(sps[2]);     // profile_compatibility
        ms.WriteByte(sps[3]);     // AVCLevelIndication
        ms.WriteByte(0xFF);       // 6 bits reserved + lengthSizeMinusOne = 3
        ms.WriteByte(0xE1);       // 3 bits reserved + numOfSequenceParameterSets = 1
        ms.WriteByte((byte)(sps.Length >> 8));
        ms.WriteByte((byte)sps.Length);
        ms.Write(sps);
        ms.WriteByte(1);          // numOfPictureParameterSets
        ms.WriteByte((byte)(pps.Length >> 8));
        ms.WriteByte((byte)pps.Length);
        ms.Write(pps);
        int profile = sps[1];
        if (profile is 100 or 110 or 122 or 144)
        {
            ms.WriteByte(0xFC | 1);   // chroma_format_idc = 1 (4:2:0)
            ms.WriteByte(0xF8 | 0);   // bit_depth_luma_minus8
            ms.WriteByte(0xF8 | 0);   // bit_depth_chroma_minus8
            ms.WriteByte(0);          // numOfSequenceParameterSetExt
        }
        return ms.ToArray();
    }

    /// <summary>RFC 6381 codec string, e.g. avc1.640033.</summary>
    public string CodecString()
    {
        if (_sps == null) return "avc1.640028";
        return $"avc1.{_sps[1]:X2}{_sps[2]:X2}{_sps[3]:X2}".ToLowerInvariant();
    }
}
