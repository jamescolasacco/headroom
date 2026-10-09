import AppKit
import CoreGraphics
import Foundation

/// Follows the system cursor for every capture source: position at 120 Hz (cheap), shape at 30 Hz from
/// NSCursor.currentSystem (main thread). The video is captured without the cursor; viewers draw this one
/// locally so it moves with zero lag, using the Mac's real cursor shape (I-beam, resize arrows…).
public final class CursorTracker {
    public static let shared = CursorTracker()

    public final class Image {
        let image: NSImage
        /// Hot spot in points, top-left origin.
        let hotSpot: CGPoint
        /// Hash of a 1x rendering: identifies the shape.
        let key: UInt32
        init(image: NSImage, hotSpot: CGPoint, key: UInt32) { self.image = image; self.hotSpot = hotSpot; self.key = key }
    }

    public struct State {
        public var location: CGPoint
        public var visible: Bool
        public var image: Image?
    }

    public typealias Token = Int

    private let queue = DispatchQueue(label: "headroom.cursor", qos: .userInteractive)
    private let lock = NSLock()
    private var listeners: [Token: (State) -> Void] = [:]
    private var nextToken = 1
    private var timer: DispatchSourceTimer?
    private var shapeTimer: Timer?
    private var state = State(location: .zero, visible: true, image: nil)
    private var lastSent: (CGPoint, Bool, UInt32)?
    private var shapeCache: [String: CursorShape] = [:]

    public func add(_ fn: @escaping (State) -> Void) -> Token {
        lock.lock()
        let t = nextToken
        nextToken += 1
        listeners[t] = fn
        let start = timer == nil
        lock.unlock()
        if start { startPolling() }
        // New listeners get the current state right away.
        queue.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); let s = self.state; let l = self.listeners[t]; self.lock.unlock()
            l?(s)
        }
        return t
    }

    public func remove(_ t: Token) {
        lock.lock()
        listeners[t] = nil
        let stop = listeners.isEmpty
        let tm = timer
        if stop { timer = nil }
        lock.unlock()
        if stop {
            tm?.cancel()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.lock.lock(); let empty = self.listeners.isEmpty; self.lock.unlock()
                if empty { self.shapeTimer?.invalidate(); self.shapeTimer = nil }
            }
        }
    }

    private func startPolling() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .milliseconds(8), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.pollPosition() }
        lock.lock(); timer = t; lock.unlock()
        t.resume()
        DispatchQueue.main.async { [weak self] in
            guard let self, self.shapeTimer == nil else { return }
            self.pollShape()
            let st = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.pollShape() }
            RunLoop.main.add(st, forMode: .common)
            self.shapeTimer = st
        }
    }

    private func pollPosition() {
        guard let loc = CGEvent(source: nil)?.location else { return }
        // macOS has no public API for another process's cursor visibility; the cursor counts as shown.
        lock.lock()
        state.location = loc
        emitLocked()
    }

    /// Must be called with `lock` held; releases it.
    private func emitLocked() {
        let s = state
        let key = s.image?.key ?? 0
        if let last = lastSent, last.0 == s.location, last.1 == s.visible, last.2 == key {
            lock.unlock()
            return
        }
        lastSent = (s.location, s.visible, key)
        let ls = Array(listeners.values)
        lock.unlock()
        for l in ls { l(s) }
    }

    private var warnedNoCursor = false

    private func pollShape() {
        // Deprecated API that Apple says will eventually return nil; viewers then keep a default arrow.
        guard let cursor = NSCursor.currentSystem else {
            if !warnedNoCursor {
                warnedNoCursor = true
                Log.warn("cursor", "the system cursor shape isn't available; viewers will show a default arrow")
            }
            return
        }
        let img = cursor.image
        let key = Self.fingerprint(img) ^ (UInt32(max(0, min(255, cursor.hotSpot.x))) << 8 | UInt32(max(0, min(255, cursor.hotSpot.y))))
        lock.lock()
        let changed = state.image?.key != key
        lock.unlock()
        guard changed else { return }
        let image = Image(image: img, hotSpot: cursor.hotSpot, key: key)
        queue.async { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.state.image = image
            self.emitLocked()
        }
    }

    /// The shape rendered at `scale` pixels per point, as straight-alpha RGBA (cached).
    public func shape(_ img: Image, scale: Double) -> CursorShape {
        let s = max(0.5, min(4, scale))
        let cacheKey = "\(img.key)@\(s)"
        lock.lock()
        if let c = shapeCache[cacheKey] { lock.unlock(); return c }
        lock.unlock()
        let size = img.image.size
        let w = max(1, min(256, Int((size.width * s).rounded())))
        let h = max(1, min(256, Int((size.height * s).rounded())))
        var rgba = Self.render(img.image, w, h)
        // Unpremultiply (CSS cursors and ImageData are straight alpha).
        for i in stride(from: 0, to: rgba.count, by: 4) {
            let a = Int(rgba[i + 3])
            if a > 0 && a < 255 {
                rgba[i] = UInt8(min(255, Int(rgba[i]) * 255 / a))
                rgba[i + 1] = UInt8(min(255, Int(rgba[i + 1]) * 255 / a))
                rgba[i + 2] = UInt8(min(255, Int(rgba[i + 2]) * 255 / a))
            }
        }
        let hx = min(w - 1, max(0, Int((img.hotSpot.x * s).rounded())))
        let hy = min(h - 1, max(0, Int((img.hotSpot.y * s).rounded())))
        var hash: UInt32 = 2166136261
        for b in rgba { hash = (hash ^ UInt32(b)) &* 16777619 }
        hash = (hash ^ UInt32(w)) &* 16777619
        hash = (hash ^ UInt32(hx)) &* 16777619
        hash = (hash ^ UInt32(hy)) &* 16777619
        let shape = CursorShape(id: hash, width: w, height: h, hotX: hx, hotY: hy, rgba: rgba)
        lock.lock()
        if shapeCache.count > 64 { shapeCache.removeAll() }
        shapeCache[cacheKey] = shape
        lock.unlock()
        return shape
    }

    static func render(_ image: NSImage, _ w: Int, _ h: Int) -> [UInt8] {
        var data = [UInt8](repeating: 0, count: w * h * 4)
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB) else { return data }
        var rect = CGRect(x: 0, y: 0, width: w, height: h)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return data }
        data.withUnsafeMutableBytes { p in
            guard let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            ctx.interpolationQuality = .high
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return data
    }

    static func fingerprint(_ image: NSImage) -> UInt32 {
        let w = max(1, Int(image.size.width)), h = max(1, Int(image.size.height))
        let px = render(image, min(w, 64), min(h, 64))
        var hash: UInt32 = 2166136261
        for b in px { hash = (hash ^ UInt32(b)) &* 16777619 }
        hash = (hash ^ UInt32(w)) &* 16777619
        return hash
    }
}
