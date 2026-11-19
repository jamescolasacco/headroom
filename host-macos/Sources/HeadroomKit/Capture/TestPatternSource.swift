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

    /// HEADROOM_TEST_PATTERN_STYLE=desktop: a page of small text (as in a browser or editor) that scrolls for 2 s,
    /// then holds still for 2 s, beside a photo. Far harder to encode than the bars, so stream quality and bitrate
    /// can be measured on something like a real desktop.
    private static let desktopStyle = ProcessInfo.processInfo.environment["HEADROOM_TEST_PATTERN_STYLE"] == "desktop"
    private var page: CGImage?
    private var photo: CGImage?

    private func tick() {
        frame += 1
        // Bars: 4 s of motion, then 2 s still. Desktop: 2 s of scrolling, then 2 s still.
        if Self.desktopStyle ? frame > 1 && frame % 240 >= 120 : frame > 1 && frame % 360 >= 240 { return }
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
            if Self.desktopStyle { drawDesktop(ctx, w, h) } else { draw(ctx, w, h) }
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

    /// The desktop style: the page (drawn once, three screens tall) scrolled 6 px a frame, and the photo beside it.
    private func drawDesktop(_ c: CGContext, _ w: Int, _ h: Int) {
        let W = CGFloat(w), H = CGFloat(h)
        if page == nil { page = Self.renderPage(width: Int(W * 0.7), height: h * 3) }
        if photo == nil { photo = Self.renderPhoto(width: Int(W * 0.25), height: Int(H * 0.45)) }
        guard let page, let photo else { return }
        c.setFillColor(CGColor(gray: 0.93, alpha: 1))
        c.fill(CGRect(x: 0, y: 0, width: W, height: H))
        // Scrolled further each cycle (the still half holds the last position); wraps at the end of the page.
        let scrolled = CGFloat((frame / 240) * 120 + min(frame % 240, 120)) * 6
        let offset = scrolled.truncatingRemainder(dividingBy: CGFloat(page.height) - H)
        // Bottom-left origin: the page's top row at the top of the screen, then `offset` rows further down.
        c.draw(page, in: CGRect(x: 0, y: H - CGFloat(page.height) + offset, width: CGFloat(page.width), height: CGFloat(page.height)))
        c.draw(photo, in: CGRect(x: W * 0.73, y: H * 0.5, width: CGFloat(photo.width), height: CGFloat(photo.height)))
        c.saveGState()
        c.translateBy(x: 0, y: H)
        c.scaleBy(x: 1, y: -1)
        text(c, "frame \(frame)", x: W * 0.73, y: H * 0.6, size: 28)
        c.restoreGState()
    }

    private static let words = """
        Remote desktop streams are mostly text: menus, code, mail and web pages, where every pixel of every letter \
        counts. Encoders built for film spread their bits over smooth motion; on a screen the edges are what you see, \
        so a page scrolling past at sixty frames a second is the hardest thing to send well. When the scrolling \
        stops, the next few frames sharpen what stayed blurry. Headroom sends frames only when something changes.
        """.split(separator: " ").map(String.init)

    /// A light page of 13-pt text (26 px: Retina), with headings and links, the way a browser or editor looks.
    private static func renderPage(width: Int, height: Int) -> CGImage? {
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        c.setFillColor(CGColor(gray: 0.99, alpha: 1))
        c.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let body = CTFontCreateWithName("Helvetica" as CFString, 26, nil)
        let heading = CTFontCreateWithName("Helvetica-Bold" as CFString, 40, nil)
        var y = CGFloat(height) - 80, i = 0, line = 0
        while y > 40 {
            let isHeading = line % 14 == 0
            var s = ""
            while s.count < (isHeading ? 30 : Int(Double(width) / 13.5)) { s += words[i % words.count] + " "; i += 7 }
            let color = line % 9 == 4 ? CGColor(red: 0.1, green: 0.35, blue: 0.85, alpha: 1) : CGColor(gray: 0.12, alpha: 1)
            let attrs: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): isHeading ? heading : body,
                                                         .init(kCTForegroundColorAttributeName as String): color]
            c.textPosition = CGPoint(x: 60, y: y)
            CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs)), c)
            y -= isHeading ? 64 : 38
            line += 1
        }
        return c.makeImage()
    }

    /// Smooth light and colour with fine grain, the way a photo looks to an encoder.
    private static func renderPhoto(width: Int, height: Int) -> CGImage? {
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: cs,
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let data = c.data else { return nil }
        let p = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
        var seed: UInt32 = 2463534242
        for y in 0..<height {
            for x in 0..<width {
                seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
                let grain = Int(seed % 24) - 12
                let fx = Double(x) / Double(width), fy = Double(y) / Double(height)
                let r = 90 + 120 * fx + 30 * sin(fy * 9), g = 140 + 60 * sin(fx * 5 + fy * 3), b = 200 - 110 * fy
                let o = (y * width + x) * 4
                p[o] = UInt8(max(0, min(255, Int(b) + grain))); p[o + 1] = UInt8(max(0, min(255, Int(g) + grain)))
                p[o + 2] = UInt8(max(0, min(255, Int(r) + grain))); p[o + 3] = 255
            }
        }
        return c.makeImage()
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
