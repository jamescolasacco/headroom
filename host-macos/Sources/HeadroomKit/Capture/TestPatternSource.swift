import CoreGraphics
import CoreText
import CoreVideo
import Foundation

/// A synthetic display (HEADROOM_TEST_PATTERN=1): animated bars, a moving block, fine text and a frame
/// counter, drawn into IOSurface-backed BGRA buffers at 60 fps. Every few seconds it holds still so the
/// idle path (no new frames, refinement frames) gets exercised too. Used for development and automated
/// end-to-end tests where the Screen Recording permission isn't available.
final class TestPatternSource: CaptureSource {
    private var timer: DispatchSourceTimer?
    private var pool: CVPixelBufferPool?
    private var frame = 0
    private let queue = DispatchQueue(label: "headroom.testpattern", qos: .userInteractive)

    override func start() {
        super.start()
        let w = monitor.width, h = monitor.height
        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: w, kCVPixelBufferHeightKey: h,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey: 4] as CFDictionary, attrs as CFDictionary, &pool)
        setStatus(.ok)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / 60), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
        Log.info("capture", "test pattern \(w)x\(h) @60 fps")
    }

    override func stop() {
        super.stop()
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        frame += 1
        // 4 s of motion, then 2 s still.
        if frame > 1 && frame % 360 >= 240 { return }
        guard let pool else { return }
        var pbOut: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut) == kCVReturnSuccess, let pb = pbOut else { return }
        CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        CVPixelBufferLockBaseAddress(pb, [])
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        if let base = CVPixelBufferGetBaseAddress(pb), let cs = CGColorSpace(name: CGColorSpace.sRGB),
           let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: cs,
                               bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
            draw(ctx, w, h)
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        publish(pb)
    }

    private func draw(_ c: CGContext, _ w: Int, _ h: Int) {
        let W = CGFloat(w), H = CGFloat(h)
        // Flip to top-left origin.
        c.translateBy(x: 0, y: H)
        c.scaleBy(x: 1, y: -1)
        c.setFillColor(CGColor(red: 0.07, green: 0.08, blue: 0.11, alpha: 1))
        c.fill(CGRect(x: 0, y: 0, width: W, height: H))
        // SMPTE-ish colour bars across the top third.
        let bars: [(CGFloat, CGFloat, CGFloat)] = [(0.75, 0.75, 0.75), (0.75, 0.75, 0), (0, 0.75, 0.75), (0, 0.75, 0), (0.75, 0, 0.75), (0.75, 0, 0), (0, 0, 0.75)]
        let bw = W / CGFloat(bars.count)
        for (i, b) in bars.enumerated() {
            c.setFillColor(CGColor(red: b.0, green: b.1, blue: b.2, alpha: 1))
            c.fill(CGRect(x: CGFloat(i) * bw, y: 0, width: bw + 1, height: H / 3))
        }
        // Moving block.
        let t = CGFloat(frame) / 60
        let bx = (sin(t * 1.3) * 0.5 + 0.5) * (W - 200), by = H / 3 + 40 + (cos(t * 0.9) * 0.5 + 0.5) * (H / 3 - 200)
        c.setFillColor(CGColor(red: 0.36, green: 0.62, blue: 1, alpha: 1))
        c.fill(CGRect(x: bx, y: by, width: 160, height: 160))
        // Fine 1-px checkerboard strip: shows chroma/sharpness problems immediately.
        c.setFillColor(CGColor(gray: 1, alpha: 1))
        let strip = CGRect(x: 40, y: H - 180, width: min(600, W - 80), height: 40)
        var x = strip.minX
        while x < strip.maxX {
            var y = strip.minY
            while y < strip.maxY {
                if (Int(x) + Int(y)) % 2 == 0 { c.fill(CGRect(x: x, y: y, width: 1, height: 1)) }
                y += 1
            }
            x += 1
        }
        text(c, "Headroom test pattern   frame \(frame)   \(Self.clock.string(from: Date()))", x: 40, y: H - 110, size: max(18, H / 30))
        text(c, "The quick brown fox jumps over the lazy dog 0123456789", x: 40, y: H - 60, size: 14)
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    private func text(_ c: CGContext, _ s: String, x: CGFloat, y: CGFloat, size: CGFloat) {
        let font = CTFontCreateWithName("Menlo" as CFString, size, nil)
        let attrs: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): font, .init(kCTForegroundColorAttributeName as String): CGColor(gray: 0.95, alpha: 1)]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
        c.saveGState()
        // Text draws upright in a bottom-left system: undo the flip locally.
        c.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        c.textPosition = CGPoint(x: x, y: y)
        CTLineDraw(line, c)
        c.restoreGState()
    }
}
