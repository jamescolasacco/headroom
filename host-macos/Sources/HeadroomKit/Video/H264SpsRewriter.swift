import Foundation

/// Rewrites an H.264 SPS so its VUI declares bitstream_restriction with max_num_reorder_frames = 0 and
/// max_dec_frame_buffering = max_num_ref_frames.
///
/// Why: without these, decoders must assume frames may be reordered and buffer output — Chrome ~4 frames,
/// Safari's VideoToolbox path ~16 frames (hundreds of ms of added latency). Our encoder never uses
/// B-frames, so the declaration is truthful. Same fix as Sunshine's cbs.cpp. Every field is read and
/// re-written verbatim except the VUI tail. (Port of the Windows host's H264SpsRewriter.cs.)
public enum H264SpsRewriter {
    struct EndOfStream: Error {}
    struct BadGolomb: Error {}

    /// - Parameter nal: SPS NAL unit including its 1-byte header, with emulation prevention bytes.
    public static func rewrite(_ nal: [UInt8]) -> (sps: [UInt8], changed: Bool) {
        do {
            let r = BitReader(unescape(nal[1...]))
            let w = BitWriter()

            let profile = Int(try copy(r, w, 8))
            _ = try copy(r, w, 8) // constraint flags + reserved
            _ = try copy(r, w, 8) // level_idc
            _ = try copyUe(r, w)  // seq_parameter_set_id
            if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(profile) {
                let chromaFormat = try copyUe(r, w)
                if chromaFormat == 3 { _ = try copy(r, w, 1) }
                _ = try copyUe(r, w) // bit_depth_luma_minus8
                _ = try copyUe(r, w) // bit_depth_chroma_minus8
                _ = try copy(r, w, 1) // qpprime_y_zero_transform_bypass_flag
                if try copy(r, w, 1) != 0 { // seq_scaling_matrix_present_flag
                    let lists = chromaFormat != 3 ? 8 : 12
                    for i in 0..<lists {
                        if try copy(r, w, 1) != 0 { try copyScalingList(r, w, i < 6 ? 16 : 64) }
                    }
                }
            }
            _ = try copyUe(r, w) // log2_max_frame_num_minus4
            let pocType = try copyUe(r, w)
            if pocType == 0 {
                _ = try copyUe(r, w)
            } else if pocType == 1 {
                _ = try copy(r, w, 1)
                _ = try copySe(r, w)
                _ = try copySe(r, w)
                let n = try copyUe(r, w)
                for _ in 0..<n { _ = try copySe(r, w) }
            }
            let maxRefFrames = try copyUe(r, w)
            _ = try copy(r, w, 1) // gaps_in_frame_num_value_allowed_flag
            _ = try copyUe(r, w)  // pic_width_in_mbs_minus1
            _ = try copyUe(r, w)  // pic_height_in_map_units_minus1
            if try copy(r, w, 1) == 0 { _ = try copy(r, w, 1) } // frame_mbs_only_flag / mb_adaptive_frame_field_flag
            _ = try copy(r, w, 1) // direct_8x8_inference_flag
            if try copy(r, w, 1) != 0 { for _ in 0..<4 { _ = try copyUe(r, w) } } // cropping

            let vuiPresent = try r.read(1) != 0
            w.write(1, 1)
            if vuiPresent {
                if try copy(r, w, 1) != 0 { // aspect_ratio_info_present_flag
                    if try copy(r, w, 8) == 255 { _ = try copy(r, w, 16); _ = try copy(r, w, 16) }
                }
                if try copy(r, w, 1) != 0 { _ = try copy(r, w, 1) } // overscan
                if try copy(r, w, 1) != 0 { // video_signal_type_present_flag
                    _ = try copy(r, w, 3); _ = try copy(r, w, 1)
                    if try copy(r, w, 1) != 0 { _ = try copy(r, w, 8); _ = try copy(r, w, 8); _ = try copy(r, w, 8) }
                }
                if try copy(r, w, 1) != 0 { _ = try copyUe(r, w); _ = try copyUe(r, w) } // chroma_loc
                if try copy(r, w, 1) != 0 { _ = try copy(r, w, 32); _ = try copy(r, w, 32); _ = try copy(r, w, 1) } // timing
                let nalHrd = try copy(r, w, 1) != 0
                if nalHrd { try copyHrd(r, w) }
                let vclHrd = try copy(r, w, 1) != 0
                if vclHrd { try copyHrd(r, w) }
                if nalHrd || vclHrd { _ = try copy(r, w, 1) } // low_delay_hrd_flag
                _ = try copy(r, w, 1) // pic_struct_present_flag
                let restriction = try r.read(1) != 0
                if restriction {
                    _ = try r.read(1); _ = try r.readUe(); _ = try r.readUe(); _ = try r.readUe(); _ = try r.readUe()
                    let reorder = try r.readUe()
                    let dpb = try r.readUe()
                    if reorder == 0 && dpb <= max(1, maxRefFrames) { return (nal, false) } // already optimal
                }
            } else {
                // No VUI from the encoder: write one with BT.709 limited-range signalling.
                w.write(0, 1)              // aspect_ratio_info_present_flag
                w.write(0, 1)              // overscan_info_present_flag
                w.write(1, 1)              // video_signal_type_present_flag
                w.write(5, 3)              // video_format: unspecified
                w.write(0, 1)              // video_full_range_flag
                w.write(1, 1)              // colour_description_present_flag
                w.write(1, 8); w.write(1, 8); w.write(1, 8) // BT.709
                w.write(0, 1)              // chroma_loc_info_present_flag
                w.write(0, 1)              // timing_info_present_flag
                w.write(0, 1)              // nal_hrd
                w.write(0, 1)              // vcl_hrd
                w.write(0, 1)              // pic_struct_present_flag
            }
            w.write(1, 1)        // bitstream_restriction_flag
            w.write(1, 1)        // motion_vectors_over_pic_boundaries_flag
            w.writeUe(2)         // max_bytes_per_pic_denom
            w.writeUe(1)         // max_bits_per_mb_denom
            w.writeUe(16)        // log2_max_mv_length_horizontal
            w.writeUe(16)        // log2_max_mv_length_vertical
            w.writeUe(0)         // max_num_reorder_frames
            w.writeUe(max(1, maxRefFrames)) // max_dec_frame_buffering
            w.writeTrailingBits()

            return ([nal[0]] + escape(w.bytes), true)
        } catch {
            return (nal, false) // never break the stream over an optimisation
        }
    }

    private static func copy(_ r: BitReader, _ w: BitWriter, _ bits: Int) throws -> UInt32 {
        let v = try r.read(bits)
        w.write(v, bits)
        return v
    }

    private static func copyUe(_ r: BitReader, _ w: BitWriter) throws -> UInt32 {
        let v = try r.readUe()
        w.writeUe(v)
        return v
    }

    private static func copySe(_ r: BitReader, _ w: BitWriter) throws -> Int {
        let code = try r.readUe()
        w.writeUe(code)
        return (code & 1) != 0 ? Int((code + 1) / 2) : -Int(code / 2)
    }

    private static func copyScalingList(_ r: BitReader, _ w: BitWriter, _ size: Int) throws {
        var last = 8, next = 8
        for _ in 0..<size {
            if next != 0 {
                let delta = try copySe(r, w)
                next = (last + delta + 256) % 256
            }
            last = next == 0 ? last : next
        }
    }

    private static func copyHrd(_ r: BitReader, _ w: BitWriter) throws {
        let cpbCnt = try copyUe(r, w)
        _ = try copy(r, w, 4); _ = try copy(r, w, 4)
        for _ in 0...cpbCnt { _ = try copyUe(r, w); _ = try copyUe(r, w); _ = try copy(r, w, 1) }
        for _ in 0..<4 { _ = try copy(r, w, 5) }
    }

    public static func unescape<C: Collection>(_ ebsp: C) -> [UInt8] where C.Element == UInt8 {
        var o = [UInt8](); o.reserveCapacity(ebsp.count)
        var zeros = 0
        for b in ebsp {
            if zeros >= 2 && b == 3 { zeros = 0; continue }
            o.append(b)
            zeros = b == 0 ? zeros + 1 : 0
        }
        return o
    }

    public static func escape(_ rbsp: [UInt8]) -> [UInt8] {
        var o = [UInt8](); o.reserveCapacity(rbsp.count + 8)
        var zeros = 0
        for b in rbsp {
            if zeros >= 2 && b <= 3 { o.append(3); zeros = 0 }
            o.append(b)
            zeros = b == 0 ? zeros + 1 : 0
        }
        return o
    }

    final class BitReader {
        private let d: [UInt8]
        private var pos = 0
        init(_ d: [UInt8]) { self.d = d }

        func read(_ n: Int) throws -> UInt32 {
            var v: UInt32 = 0
            for _ in 0..<n {
                guard pos >> 3 < d.count else { throw EndOfStream() }
                v = (v << 1) | UInt32((d[pos >> 3] >> (7 - UInt8(pos & 7))) & 1)
                pos += 1
            }
            return v
        }

        func readUe() throws -> UInt32 {
            var zeros = 0
            while try read(1) == 0 {
                zeros += 1
                if zeros > 31 { throw BadGolomb() }
            }
            return zeros == 0 ? 0 : UInt32((UInt64(1) << UInt64(zeros)) - 1 + UInt64(try read(zeros)))
        }
    }

    final class BitWriter {
        private(set) var bytes = [UInt8]()
        private var bit = 0
        private var cur: UInt8 = 0

        func write(_ v: UInt32, _ n: Int) {
            guard n > 0 else { return }
            for i in stride(from: n - 1, through: 0, by: -1) {
                cur = (cur << 1) | UInt8((v >> UInt32(i)) & 1)
                bit += 1
                if bit == 8 { bytes.append(cur); cur = 0; bit = 0 }
            }
        }

        func writeUe(_ v: UInt32) {
            let x = UInt64(v) + 1
            var len = 0
            var t = x
            while t > 1 { t >>= 1; len += 1 }
            write(0, len)
            for i in stride(from: len, through: 0, by: -1) { write(UInt32((x >> UInt64(i)) & 1), 1) }
        }

        func writeTrailingBits() {
            write(1, 1)
            while bit != 0 { write(0, 1) }
        }
    }
}
