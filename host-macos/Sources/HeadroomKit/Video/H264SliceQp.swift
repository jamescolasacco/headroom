import Foundation

/// The quantizer a picture was coded at: its first slice's QP, from 0 (finest) to 51 (coarsest), read from the slice
/// header with the stream's SPS and PPS. Screen text coded above ~30 looks smudged; 22 and under, sharp. The encoders
/// don't say it themselves, and the pipeline needs it to know whether the picture left on a still screen is smudged.
/// (Port: host-windows/Headroom.Host/Video/H264SliceQp.cs.)
struct H264SliceQp {
    private struct Sps {
        var frameNumBits = 4, pocType = 0, pocLsbBits = 4
        var deltaPocAlwaysZero = false, frameMbsOnly = true, separateColourPlane = false, chromaArrayType = 1
    }
    private struct Pps {
        var cabac = false, bottomFieldPicOrder = false, redundantPicCnt = false
        var refIdxL0 = 1, refIdxL1 = 1, weightedPred = false, weightedBipred = 0, picInitQp = 26
    }
    private var sps: Sps?
    private var pps: Pps?

    /// An SPS or PPS NAL unit (with its header byte, emulation prevention bytes in place).
    mutating func parameterSet(_ nal: [UInt8]) {
        guard let first = nal.first else { return }
        switch first & 0x1F {
        case 7: sps = try? Self.parseSps(nal)
        case 8: pps = try? Self.parsePps(nal)
        default: break
        }
    }

    /// The QP of the slice whose NAL unit (with its header byte) this is; nil when it can't be read.
    func qp<C: Collection>(_ nal: C) -> Int? where C.Element == UInt8 {
        guard let sps, let pps, let header = nal.first else { return nil }
        let type = Int(header & 0x1F), refIdc = Int((header >> 5) & 3)
        guard type == 1 || type == 5 else { return nil }
        do {
            let r = H264SpsRewriter.BitReader(H264SpsRewriter.unescape(nal.dropFirst().prefix(96)))
            _ = try r.readUe()                                       // first_mb_in_slice
            let sliceType = Int(try r.readUe()) % 5                  // 0 P, 1 B, 2 I, 3 SP, 4 SI
            _ = try r.readUe()                                       // pic_parameter_set_id (there's one)
            if sps.separateColourPlane { _ = try r.read(2) }
            _ = try r.read(sps.frameNumBits)                         // frame_num
            var field = false
            if !sps.frameMbsOnly { field = try r.read(1) != 0; if field { _ = try r.read(1) } }
            if type == 5 { _ = try r.readUe() }                      // idr_pic_id
            if sps.pocType == 0 {
                _ = try r.read(sps.pocLsbBits)
                if pps.bottomFieldPicOrder && !field { _ = try Self.se(r) }
            } else if sps.pocType == 1 && !sps.deltaPocAlwaysZero {
                _ = try Self.se(r)
                if pps.bottomFieldPicOrder && !field { _ = try Self.se(r) }
            }
            if pps.redundantPicCnt { _ = try r.readUe() }
            let p = sliceType == 0 || sliceType == 3, b = sliceType == 1
            if b { _ = try r.read(1) }                               // direct_spatial_mv_pred_flag
            var l0 = pps.refIdxL0, l1 = pps.refIdxL1
            if p || b, try r.read(1) != 0 {                          // num_ref_idx_active_override_flag
                l0 = Int(try r.readUe()) + 1
                if b { l1 = Int(try r.readUe()) + 1 }
            }
            if sliceType != 2 && sliceType != 4 {                    // ref_pic_list_modification
                for _ in 0..<(b ? 2 : 1) {
                    guard try r.read(1) != 0 else { continue }
                    while true {
                        let idc = try r.readUe()
                        if idc == 3 { break }
                        guard idc <= 2 else { return nil }
                        _ = try r.readUe()
                    }
                }
            }
            if (pps.weightedPred && p) || (pps.weightedBipred == 1 && b) { // pred_weight_table
                _ = try r.readUe()
                if sps.chromaArrayType != 0 { _ = try r.readUe() }
                for count in (b ? [l0, l1] : [l0]) {
                    for _ in 0..<count {
                        if try r.read(1) != 0 { _ = try Self.se(r); _ = try Self.se(r) }
                        if sps.chromaArrayType != 0, try r.read(1) != 0 { for _ in 0..<4 { _ = try Self.se(r) } }
                    }
                }
            }
            if refIdc != 0 {                                         // dec_ref_pic_marking
                if type == 5 { _ = try r.read(2) }
                else if try r.read(1) != 0 {
                    while true {
                        let op = try r.readUe()
                        if op == 0 { break }
                        guard op <= 6 else { return nil }
                        if op == 1 || op == 3 { _ = try r.readUe() }
                        if op == 2 { _ = try r.readUe() }
                        if op == 3 || op == 6 { _ = try r.readUe() }
                        if op == 4 { _ = try r.readUe() }
                    }
                }
            }
            if pps.cabac && sliceType != 2 && sliceType != 4 { _ = try r.readUe() } // cabac_init_idc
            let qp = pps.picInitQp + (try Self.se(r))
            return (0...51).contains(qp) ? qp : nil
        } catch {
            return nil
        }
    }

    private static func se(_ r: H264SpsRewriter.BitReader) throws -> Int {
        let k = Int(try r.readUe())
        return k & 1 == 1 ? (k + 1) / 2 : -(k / 2)
    }

    private static func parseSps(_ nal: [UInt8]) throws -> Sps {
        let r = H264SpsRewriter.BitReader(H264SpsRewriter.unescape(nal.dropFirst()))
        var s = Sps()
        let profile = Int(try r.read(8))
        _ = try r.read(16)                                           // constraint flags, level_idc
        _ = try r.readUe()                                           // seq_parameter_set_id
        if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(profile) {
            let chroma = Int(try r.readUe())
            if chroma == 3 { s.separateColourPlane = try r.read(1) != 0 }
            s.chromaArrayType = s.separateColourPlane ? 0 : chroma
            _ = try r.readUe(); _ = try r.readUe()                   // bit depths
            _ = try r.read(1)                                        // qpprime_y_zero_transform_bypass_flag
            if try r.read(1) != 0 {                                  // seq_scaling_matrix_present_flag
                for i in 0..<(chroma != 3 ? 8 : 12) {
                    guard try r.read(1) != 0 else { continue }
                    var last = 8, next = 8
                    for _ in 0..<(i < 6 ? 16 : 64) where next != 0 {
                        next = (last + (try se(r)) + 256) % 256
                        last = next == 0 ? last : next
                    }
                }
            }
        }
        s.frameNumBits = Int(try r.readUe()) + 4
        s.pocType = Int(try r.readUe())
        if s.pocType == 0 {
            s.pocLsbBits = Int(try r.readUe()) + 4
        } else if s.pocType == 1 {
            s.deltaPocAlwaysZero = try r.read(1) != 0
            _ = try se(r); _ = try se(r)
            for _ in 0..<(try r.readUe()) { _ = try se(r) }
        }
        _ = try r.readUe(); _ = try r.read(1)                        // max_num_ref_frames, gaps
        _ = try r.readUe(); _ = try r.readUe()                       // size in macroblocks
        s.frameMbsOnly = try r.read(1) != 0
        return s
    }

    private static func parsePps(_ nal: [UInt8]) throws -> Pps {
        let r = H264SpsRewriter.BitReader(H264SpsRewriter.unescape(nal.dropFirst()))
        var p = Pps()
        _ = try r.readUe(); _ = try r.readUe()                       // pps id, sps id
        p.cabac = try r.read(1) != 0
        p.bottomFieldPicOrder = try r.read(1) != 0
        guard try r.readUe() == 0 else { throw H264SpsRewriter.BadGolomb() } // slice groups: not from our encoders
        p.refIdxL0 = Int(try r.readUe()) + 1
        p.refIdxL1 = Int(try r.readUe()) + 1
        p.weightedPred = try r.read(1) != 0
        p.weightedBipred = Int(try r.read(2))
        p.picInitQp = 26 + (try se(r))
        _ = try se(r); _ = try se(r)                                 // pic_init_qs, chroma_qp_index_offset
        _ = try r.read(1); _ = try r.read(1)                         // deblocking control, constrained intra
        p.redundantPicCnt = try r.read(1) != 0
        return p
    }
}
