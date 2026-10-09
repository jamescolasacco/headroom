import AppKit
import Foundation

/// `headroom selftest [seconds]`: captures the main display (or the test pattern), encodes it through the
/// real pipeline and writes an Annex-B .h264 file you can inspect with ffprobe/ffplay. Prints frame count,
/// encoder, sizes and timings.
public enum SelfTest {
    final class Sink: VideoSink {
        var out = Data()
        var sps: [UInt8] = [], pps: [UInt8] = []
        var frames = 0, keyFrames = 0, bytes = 0
        var encodeMsSum = 0.0
        var config: VideoStreamConfig?
        var statusLog: [String] = []
        let lock = NSLock()

        var canSendVideo: Bool { true }

        func onVideoConfig(_ c: VideoStreamConfig) {
            lock.lock(); defer { lock.unlock() }
            config = c
            // avcC: [5] 0xE1, [6..7] spsLen, sps, [n] numPps, [..] ppsLen, pps
            let d = c.description
            guard d.count > 8 else { return }
            let spsLen = Int(d[6]) << 8 | Int(d[7])
            sps = Array(d[8..<(8 + spsLen)])
            let p = 8 + spsLen + 1
            let ppsLen = Int(d[p]) << 8 | Int(d[p + 1])
            pps = Array(d[(p + 2)..<(p + 2 + ppsLen)])
        }

        func onVideoFrame(_ f: EncodedVideoFrame) {
            lock.lock(); defer { lock.unlock() }
            frames += 1
            bytes += f.data.count
            encodeMsSum += f.encodeMs
            if f.keyFrame {
                keyFrames += 1
                out.append(contentsOf: [0, 0, 0, 1] + sps + [0, 0, 0, 1] + pps)
            }
            var i = 0
            while i + 4 <= f.data.count {
                let n = Int(f.data[i]) << 24 | Int(f.data[i + 1]) << 16 | Int(f.data[i + 2]) << 8 | Int(f.data[i + 3])
                i += 4
                guard n > 0, i + n <= f.data.count else { break }
                out.append(contentsOf: [0, 0, 0, 1])
                out.append(contentsOf: f.data[i..<(i + n)])
                i += n
            }
        }

        func onCaptureStatus(_ status: CaptureStatus, detail: String?) {
            lock.lock(); statusLog.append("\(status)\(detail.map { " (\($0))" } ?? "")"); lock.unlock()
        }
    }

    public static func run(_ args: [String]) -> Int32 {
        let seconds = args.first.flatMap(Double.init) ?? 5
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        guard let monitor = Displays.enumerate().first else {
            print("No displays found.")
            return 1
        }
        if !monitor.isTestPattern && !Permissions.screenRecording {
            print(Permissions.screenRecordingHint)
            print("(Or run with HEADROOM_TEST_PATTERN=1 to test encoding with a synthetic display.)")
        }
        print("Capturing \(monitor.name) (\(monitor.width)x\(monitor.height) @\(Int(monitor.refreshHz)) Hz) for \(seconds) s…")
        let sink = Sink()
        let cfg = ConfigStore.current.video
        let pipeline = VideoPipeline(settings: PipelineSettings(monitor: monitor, maxFps: 60, bitrateKbps: cfg.startBitrateKbps,
                                                                encoderPreference: cfg.encoder), sink: sink, initialEpoch: 0)
        let start = Date()
        var result: Int32 = 0
        DispatchQueue.global().async {
            Thread.sleep(forTimeInterval: seconds)
            pipeline.dispose()
            sink.lock.lock()
            let elapsed = Date().timeIntervalSince(start)
            let path = (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent("headroom-selftest.h264")
            try? sink.out.write(to: URL(fileURLWithPath: path))
            if let c = sink.config {
                print("encoder:   \(c.encoderName) (\(c.hardware ? "hardware" : "software")), \(c.codec), \(c.width)x\(c.height) from \(c.sourceWidth)x\(c.sourceHeight)")
            }
            print("status:    \(sink.statusLog.joined(separator: " -> "))")
            print("frames:    \(sink.frames) (\(sink.keyFrames) key) in \(String(format: "%.1f", elapsed)) s = \(String(format: "%.1f", Double(sink.frames) / elapsed)) fps")
            print("bitrate:   \(String(format: "%.0f", Double(sink.bytes) * 8 / 1000 / elapsed)) kbps; mean encode \(String(format: "%.2f", sink.frames > 0 ? sink.encodeMsSum / Double(sink.frames) : 0)) ms")
            print("wrote:     \(path) (\(sink.out.count) bytes) — inspect with: ffprobe -show_streams \(path)")
            result = sink.frames > 0 ? 0 : 1
            sink.lock.unlock()
            Log.flush()
            exit(result)
        }
        app.run()
        return result
    }
}
