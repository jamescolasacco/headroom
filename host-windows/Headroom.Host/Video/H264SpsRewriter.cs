namespace Headroom.Host.Video;

/// <summary>
/// Rewrites an H.264 SPS so its VUI declares bitstream_restriction with max_num_reorder_frames = 0 and
/// max_dec_frame_buffering = max_num_ref_frames.
///
/// Why: without these, decoders must assume frames may be reordered and buffer output — Chrome ~4 frames,
/// Safari's VideoToolbox path ~16 frames (hundreds of ms of added latency). Our encoder never uses
/// B-frames, so the declaration is truthful. Same fix as Sunshine's cbs.cpp. Every field is read and
/// re-written verbatim except the VUI tail.
/// </summary>
public static class H264SpsRewriter
{
    /// <param name="nal">SPS NAL unit including its 1-byte header, with emulation prevention bytes.</param>
    public static byte[] Rewrite(byte[] nal, out bool changed)
    {
        changed = false;
        try
        {
            var rbsp = Unescape(nal.AsSpan(1));
            var r = new BitReader(rbsp);
            var w = new BitWriter();

            int profile = (int)Copy(r, w, 8);
            Copy(r, w, 8); // constraint flags + reserved
            Copy(r, w, 8); // level_idc
            CopyUe(r, w);  // seq_parameter_set_id
            int chromaFormat = 1;
            if (profile is 100 or 110 or 122 or 244 or 44 or 83 or 86 or 118 or 128 or 138 or 139 or 134 or 135)
            {
                chromaFormat = (int)CopyUe(r, w);
                if (chromaFormat == 3) Copy(r, w, 1);
                CopyUe(r, w); // bit_depth_luma_minus8
                CopyUe(r, w); // bit_depth_chroma_minus8
                Copy(r, w, 1); // qpprime_y_zero_transform_bypass_flag
                if (Copy(r, w, 1) != 0) // seq_scaling_matrix_present_flag
                {
                    int lists = chromaFormat != 3 ? 8 : 12;
                    for (int i = 0; i < lists; i++)
                        if (Copy(r, w, 1) != 0) CopyScalingList(r, w, i < 6 ? 16 : 64);
                }
            }
            CopyUe(r, w); // log2_max_frame_num_minus4
            uint pocType = CopyUe(r, w);
            if (pocType == 0) CopyUe(r, w);
            else if (pocType == 1)
            {
                Copy(r, w, 1);
                CopySe(r, w);
                CopySe(r, w);
                uint n = CopyUe(r, w);
                for (int i = 0; i < n; i++) CopySe(r, w);
            }
            uint maxRefFrames = CopyUe(r, w);
            Copy(r, w, 1); // gaps_in_frame_num_value_allowed_flag
            CopyUe(r, w);  // pic_width_in_mbs_minus1
            CopyUe(r, w);  // pic_height_in_map_units_minus1
            if (Copy(r, w, 1) == 0) Copy(r, w, 1); // frame_mbs_only_flag / mb_adaptive_frame_field_flag
            Copy(r, w, 1); // direct_8x8_inference_flag
            if (Copy(r, w, 1) != 0) { CopyUe(r, w); CopyUe(r, w); CopyUe(r, w); CopyUe(r, w); } // cropping

            bool vuiPresent = r.Read(1) != 0;
            w.Write(1, 1);
            if (vuiPresent)
            {
                if (Copy(r, w, 1) != 0) // aspect_ratio_info_present_flag
                {
                    if (Copy(r, w, 8) == 255) { Copy(r, w, 16); Copy(r, w, 16); }
                }
                if (Copy(r, w, 1) != 0) Copy(r, w, 1); // overscan
                if (Copy(r, w, 1) != 0) // video_signal_type_present_flag
                {
                    Copy(r, w, 3); Copy(r, w, 1);
                    if (Copy(r, w, 1) != 0) { Copy(r, w, 8); Copy(r, w, 8); Copy(r, w, 8); }
                }
                if (Copy(r, w, 1) != 0) { CopyUe(r, w); CopyUe(r, w); } // chroma_loc
                if (Copy(r, w, 1) != 0) { Copy(r, w, 32); Copy(r, w, 32); Copy(r, w, 1); } // timing
                bool nalHrd = Copy(r, w, 1) != 0;
                if (nalHrd) CopyHrd(r, w);
                bool vclHrd = Copy(r, w, 1) != 0;
                if (vclHrd) CopyHrd(r, w);
                if (nalHrd || vclHrd) Copy(r, w, 1); // low_delay_hrd_flag
                Copy(r, w, 1); // pic_struct_present_flag
                bool restriction = r.Read(1) != 0;
                if (restriction)
                {
                    r.Read(1); r.ReadUe(); r.ReadUe(); r.ReadUe(); r.ReadUe();
                    uint reorder = r.ReadUe();
                    uint dpb = r.ReadUe();
                    if (reorder == 0 && dpb <= Math.Max(1, maxRefFrames)) return nal; // already optimal
                }
            }
            else
            {
                // No VUI from the encoder: write one with BT.709 limited-range signalling.
                w.Write(0, 1);              // aspect_ratio_info_present_flag
                w.Write(0, 1);              // overscan_info_present_flag
                w.Write(1, 1);              // video_signal_type_present_flag
                w.Write(5, 3);              // video_format: unspecified
                w.Write(0, 1);              // video_full_range_flag
                w.Write(1, 1);              // colour_description_present_flag
                w.Write(1, 8); w.Write(1, 8); w.Write(1, 8); // BT.709
                w.Write(0, 1);              // chroma_loc_info_present_flag
                w.Write(0, 1);              // timing_info_present_flag
                w.Write(0, 1);              // nal_hrd
                w.Write(0, 1);              // vcl_hrd
                w.Write(0, 1);              // pic_struct_present_flag
            }
            w.Write(1, 1);        // bitstream_restriction_flag
            w.Write(1, 1);        // motion_vectors_over_pic_boundaries_flag
            w.WriteUe(2);         // max_bytes_per_pic_denom
            w.WriteUe(1);         // max_bits_per_mb_denom
            w.WriteUe(16);        // log2_max_mv_length_horizontal
            w.WriteUe(16);        // log2_max_mv_length_vertical
            w.WriteUe(0);         // max_num_reorder_frames
            w.WriteUe(Math.Max(1, maxRefFrames)); // max_dec_frame_buffering
            w.WriteTrailingBits();

            var escaped = Escape(w.ToArray());
            var result = new byte[escaped.Length + 1];
            result[0] = nal[0];
            escaped.CopyTo(result, 1);
            changed = true;
            return result;
        }
        catch (Exception)
        {
            return nal; // never break the stream over an optimisation
        }
    }

    private static uint Copy(BitReader r, BitWriter w, int bits)
    {
        uint v = r.Read(bits);
        w.Write(v, bits);
        return v;
    }

    private static uint CopyUe(BitReader r, BitWriter w)
    {
        uint v = r.ReadUe();
        w.WriteUe(v);
        return v;
    }

    private static int CopySe(BitReader r, BitWriter w)
    {
        uint code = r.ReadUe();
        w.WriteUe(code);
        return (int)((code & 1) != 0 ? (code + 1) / 2 : -(code / 2));
    }

    private static void CopyScalingList(BitReader r, BitWriter w, int size)
    {
        int last = 8, next = 8;
        for (int j = 0; j < size; j++)
        {
            if (next != 0)
            {
                int delta = CopySe(r, w);
                next = (last + delta + 256) % 256;
            }
            last = next == 0 ? last : next;
        }
    }

    private static void CopyHrd(BitReader r, BitWriter w)
    {
        uint cpbCnt = CopyUe(r, w);
        Copy(r, w, 4); Copy(r, w, 4);
        for (int i = 0; i <= cpbCnt; i++) { CopyUe(r, w); CopyUe(r, w); Copy(r, w, 1); }
        Copy(r, w, 5); Copy(r, w, 5); Copy(r, w, 5); Copy(r, w, 5);
    }

    public static byte[] Unescape(ReadOnlySpan<byte> ebsp)
    {
        var o = new List<byte>(ebsp.Length);
        int zeros = 0;
        foreach (var b in ebsp)
        {
            if (zeros >= 2 && b == 3) { zeros = 0; continue; }
            o.Add(b);
            zeros = b == 0 ? zeros + 1 : 0;
        }
        return o.ToArray();
    }

    public static byte[] Escape(ReadOnlySpan<byte> rbsp)
    {
        var o = new List<byte>(rbsp.Length + 8);
        int zeros = 0;
        foreach (var b in rbsp)
        {
            if (zeros >= 2 && b <= 3) { o.Add(3); zeros = 0; }
            o.Add(b);
            zeros = b == 0 ? zeros + 1 : 0;
        }
        return o.ToArray();
    }

    private sealed class BitReader
    {
        private readonly byte[] _d;
        private int _pos;
        public BitReader(byte[] d) => _d = d;

        public uint Read(int n)
        {
            uint v = 0;
            for (int i = 0; i < n; i++)
            {
                if (_pos >> 3 >= _d.Length) throw new EndOfStreamException();
                v = (v << 1) | (uint)((_d[_pos >> 3] >> (7 - (_pos & 7))) & 1);
                _pos++;
            }
            return v;
        }

        public uint ReadUe()
        {
            int zeros = 0;
            while (Read(1) == 0)
            {
                if (++zeros > 31) throw new InvalidDataException("bad exp-golomb");
            }
            return zeros == 0 ? 0 : (uint)((1L << zeros) - 1 + Read(zeros));
        }
    }

    private sealed class BitWriter
    {
        private readonly List<byte> _o = new();
        private int _bit;
        private byte _cur;

        public void Write(uint v, int n)
        {
            for (int i = n - 1; i >= 0; i--)
            {
                _cur = (byte)((_cur << 1) | (int)((v >> i) & 1));
                if (++_bit == 8) { _o.Add(_cur); _cur = 0; _bit = 0; }
            }
        }

        public void WriteUe(uint v)
        {
            ulong x = (ulong)v + 1;
            int len = 0;
            for (ulong t = x; t > 1; t >>= 1) len++;
            Write(0, len);
            // write x in (len + 1) bits
            for (int i = len; i >= 0; i--) Write((uint)((x >> i) & 1), 1);
        }

        public void WriteTrailingBits()
        {
            Write(1, 1);
            while (_bit != 0) Write(0, 1);
        }

        public byte[] ToArray() => _o.ToArray();
    }
}
