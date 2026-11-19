namespace Headroom.Host.Video;

/// <summary>
/// The quantizer a picture was coded at: its first slice's QP, from 0 (finest) to 51 (coarsest), read from the slice
/// header with the stream's SPS and PPS. Screen text coded above ~30 looks smudged; 22 and under, sharp. The encoders
/// don't say it themselves, and the pipeline needs it to know whether the picture left on a still screen is smudged.
/// (Port of the Mac host's H264SliceQp.swift.)
/// </summary>
public sealed class H264SliceQp
{
    private sealed record Sps(int FrameNumBits, int PocType, int PocLsbBits, bool DeltaPocAlwaysZero, bool FrameMbsOnly,
                              bool SeparateColourPlane, int ChromaArrayType);
    private sealed record Pps(bool Cabac, bool BottomFieldPicOrder, bool RedundantPicCnt, int RefIdxL0, int RefIdxL1,
                              bool WeightedPred, int WeightedBipred, int PicInitQp);
    private Sps? _sps;
    private Pps? _pps;

    /// <summary>An SPS or PPS NAL unit (with its header byte, emulation prevention bytes in place).</summary>
    public void ParameterSet(ReadOnlySpan<byte> nal)
    {
        if (nal.IsEmpty) return;
        try
        {
            switch (nal[0] & 0x1F)
            {
                case 7: _sps = ParseSps(nal); break;
                case 8: _pps = ParsePps(nal); break;
            }
        }
        catch (Exception ex) when (ex is EndOfStreamException or InvalidDataException) { }
    }

    /// <summary>The QP of the slice whose NAL unit (with its header byte) this is; null when it can't be read.</summary>
    public int? Qp(ReadOnlySpan<byte> nal)
    {
        var sps = _sps;
        var pps = _pps;
        if (sps == null || pps == null || nal.IsEmpty) return null;
        int type = nal[0] & 0x1F, refIdc = (nal[0] >> 5) & 3;
        if (type != 1 && type != 5) return null;
        try
        {
            var r = new H264SpsRewriter.BitReader(H264SpsRewriter.Unescape(nal.Slice(1, Math.Min(96, nal.Length - 1))));
            r.ReadUe();                                              // first_mb_in_slice
            int sliceType = (int)(r.ReadUe() % 5);                   // 0 P, 1 B, 2 I, 3 SP, 4 SI
            r.ReadUe();                                              // pic_parameter_set_id (there's one)
            if (sps.SeparateColourPlane) r.Read(2);
            r.Read(sps.FrameNumBits);                                // frame_num
            bool field = false;
            if (!sps.FrameMbsOnly) { field = r.Read(1) != 0; if (field) r.Read(1); }
            if (type == 5) r.ReadUe();                               // idr_pic_id
            if (sps.PocType == 0)
            {
                r.Read(sps.PocLsbBits);
                if (pps.BottomFieldPicOrder && !field) Se(r);
            }
            else if (sps.PocType == 1 && !sps.DeltaPocAlwaysZero)
            {
                Se(r);
                if (pps.BottomFieldPicOrder && !field) Se(r);
            }
            if (pps.RedundantPicCnt) r.ReadUe();
            bool p = sliceType == 0 || sliceType == 3, b = sliceType == 1;
            if (b) r.Read(1);                                        // direct_spatial_mv_pred_flag
            int l0 = pps.RefIdxL0, l1 = pps.RefIdxL1;
            if ((p || b) && r.Read(1) != 0)                          // num_ref_idx_active_override_flag
            {
                l0 = (int)r.ReadUe() + 1;
                if (b) l1 = (int)r.ReadUe() + 1;
            }
            if (sliceType != 2 && sliceType != 4)                    // ref_pic_list_modification
            {
                for (int list = 0; list < (b ? 2 : 1); list++)
                {
                    if (r.Read(1) == 0) continue;
                    while (true)
                    {
                        uint idc = r.ReadUe();
                        if (idc == 3) break;
                        if (idc > 2) return null;
                        r.ReadUe();
                    }
                }
            }
            if ((pps.WeightedPred && p) || (pps.WeightedBipred == 1 && b)) // pred_weight_table
            {
                r.ReadUe();
                if (sps.ChromaArrayType != 0) r.ReadUe();
                foreach (int count in b ? new[] { l0, l1 } : new[] { l0 })
                {
                    for (int i = 0; i < count; i++)
                    {
                        if (r.Read(1) != 0) { Se(r); Se(r); }
                        if (sps.ChromaArrayType != 0 && r.Read(1) != 0) for (int k = 0; k < 4; k++) Se(r);
                    }
                }
            }
            if (refIdc != 0)                                         // dec_ref_pic_marking
            {
                if (type == 5) r.Read(2);
                else if (r.Read(1) != 0)
                {
                    while (true)
                    {
                        uint op = r.ReadUe();
                        if (op == 0) break;
                        if (op > 6) return null;
                        if (op == 1 || op == 3) r.ReadUe();
                        if (op == 2) r.ReadUe();
                        if (op == 3 || op == 6) r.ReadUe();
                        if (op == 4) r.ReadUe();
                    }
                }
            }
            if (pps.Cabac && sliceType != 2 && sliceType != 4) r.ReadUe(); // cabac_init_idc
            int qp = pps.PicInitQp + Se(r);
            return qp is >= 0 and <= 51 ? qp : null;
        }
        catch (Exception ex) when (ex is EndOfStreamException or InvalidDataException)
        {
            return null;
        }
    }

    private static int Se(H264SpsRewriter.BitReader r)
    {
        int k = (int)r.ReadUe();
        return (k & 1) == 1 ? (k + 1) / 2 : -(k / 2);
    }

    private static Sps ParseSps(ReadOnlySpan<byte> nal)
    {
        var r = new H264SpsRewriter.BitReader(H264SpsRewriter.Unescape(nal.Slice(1)));
        int profile = (int)r.Read(8);
        r.Read(16);                                                  // constraint flags, level_idc
        r.ReadUe();                                                  // seq_parameter_set_id
        bool separate = false;
        int chromaArrayType = 1;
        if (profile is 100 or 110 or 122 or 244 or 44 or 83 or 86 or 118 or 128 or 138 or 139 or 134 or 135)
        {
            int chroma = (int)r.ReadUe();
            if (chroma == 3) separate = r.Read(1) != 0;
            chromaArrayType = separate ? 0 : chroma;
            r.ReadUe(); r.ReadUe();                                  // bit depths
            r.Read(1);                                               // qpprime_y_zero_transform_bypass_flag
            if (r.Read(1) != 0)                                      // seq_scaling_matrix_present_flag
            {
                for (int i = 0; i < (chroma != 3 ? 8 : 12); i++)
                {
                    if (r.Read(1) == 0) continue;
                    int last = 8, next = 8;
                    for (int j = 0; j < (i < 6 ? 16 : 64) && next != 0; j++)
                    {
                        next = (last + Se(r) + 256) % 256;
                        last = next == 0 ? last : next;
                    }
                }
            }
        }
        int frameNumBits = (int)r.ReadUe() + 4;
        int pocType = (int)r.ReadUe();
        int pocLsbBits = 4;
        bool deltaPocAlwaysZero = false;
        if (pocType == 0) pocLsbBits = (int)r.ReadUe() + 4;
        else if (pocType == 1)
        {
            deltaPocAlwaysZero = r.Read(1) != 0;
            Se(r); Se(r);
            uint n = r.ReadUe();
            for (uint i = 0; i < n; i++) Se(r);
        }
        r.ReadUe(); r.Read(1);                                       // max_num_ref_frames, gaps
        r.ReadUe(); r.ReadUe();                                      // size in macroblocks
        bool frameMbsOnly = r.Read(1) != 0;
        return new Sps(frameNumBits, pocType, pocLsbBits, deltaPocAlwaysZero, frameMbsOnly, separate, chromaArrayType);
    }

    private static Pps ParsePps(ReadOnlySpan<byte> nal)
    {
        var r = new H264SpsRewriter.BitReader(H264SpsRewriter.Unescape(nal.Slice(1)));
        r.ReadUe(); r.ReadUe();                                      // pps id, sps id
        bool cabac = r.Read(1) != 0;
        bool bottomFieldPicOrder = r.Read(1) != 0;
        if (r.ReadUe() != 0) throw new InvalidDataException("slice groups");  // not from our encoders
        int l0 = (int)r.ReadUe() + 1, l1 = (int)r.ReadUe() + 1;
        bool weightedPred = r.Read(1) != 0;
        int weightedBipred = (int)r.Read(2);
        int picInitQp = 26 + Se(r);
        Se(r); Se(r);                                                // pic_init_qs, chroma_qp_index_offset
        r.Read(1); r.Read(1);                                        // deblocking control, constrained intra
        bool redundant = r.Read(1) != 0;
        return new Pps(cabac, bottomFieldPicOrder, redundant, l0, l1, weightedPred, weightedBipred, picInitQp);
    }
}
