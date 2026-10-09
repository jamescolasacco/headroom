import CoreGraphics
import CoreVideo
import Foundation

public enum CaptureStatus: Equatable {
    case starting, ok, secureDesktop, unavailable
}

public struct CursorShape {
    /// Content hash: lets clients cache shapes.
    public let id: UInt32
    public let width: Int
    public let height: Int
    public let hotX: Int
    public let hotY: Int
    public let rgba: [UInt8]
}

/// One display's frames, shared by every viewer streaming it (ref-counted through CaptureHub). Holds the
/// newest image, bumps `frameVersion` whenever the screen changes, and signals each subscriber's event
/// (the Windows host's CaptureSource does the same with DXGI duplication). Also relays the cursor in this
/// display's pixel coordinates.
public class CaptureSource: NSObject {
    private var monitorValue: MonitorInfo
    private let lock = NSLock()
    private var signals: [AutoResetEvent] = []
    private var latestBuffer: CVPixelBuffer?
    private var version: Int64 = 0
    private var gen: Int64 = 0
    private var statusValue: CaptureStatus = .starting
    private var detailValue: String?

    // Cursor (pixels relative to this display's top-left), under `lock`.
    private var cursorPos = (x: 0, y: 0, visible: false)
    private var shapeValue: CursorShape?
    private var cursorListeners: [ObjectIdentifier: (moved: (CaptureSource) -> Void, shape: (CaptureSource, CursorShape) -> Void)] = [:]
    private var cursorToken: CursorTracker.Token?

    init(monitor: MonitorInfo) {
        monitorValue = monitor
        super.init()
    }

    /// The display (re-resolved on every capture restart and display change, so read it through the lock).
    public var monitor: MonitorInfo { lock.lock(); defer { lock.unlock() }; return monitorValue }
    public var cursor: (x: Int, y: Int, visible: Bool) { lock.lock(); defer { lock.unlock() }; return cursorPos }
    public var shape: CursorShape? { lock.lock(); defer { lock.unlock() }; return shapeValue }

    // ------------------------------------------------------------------ frames

    public var frameVersion: Int64 { lock.lock(); defer { lock.unlock() }; return version }
    /// Bumped whenever the frame geometry changes (resolution / display mode).
    public var generation: Int64 { lock.lock(); defer { lock.unlock() }; return gen }
    public var status: CaptureStatus { lock.lock(); defer { lock.unlock() }; return statusValue }
    public var statusDetail: String? { lock.lock(); defer { lock.unlock() }; return detailValue }
    public var hasImage: Bool { lock.lock(); defer { lock.unlock() }; return latestBuffer != nil && version > 0 }

    /// The newest frame (retained by the caller for as long as it needs it).
    public var latest: CVPixelBuffer? { lock.lock(); defer { lock.unlock() }; return latestBuffer }

    public func subscribe() -> AutoResetEvent {
        let ev = AutoResetEvent(true)
        lock.lock(); signals.append(ev); lock.unlock()
        return ev
    }

    public func unsubscribe(_ ev: AutoResetEvent) {
        lock.lock(); signals.removeAll { $0 === ev }; lock.unlock()
    }

    func signalAll() {
        lock.lock(); let s = signals; lock.unlock()
        for e in s { e.set() }
    }

    /// A new image: becomes `latest`, bumps the version and wakes the pipelines.
    func publish(_ pb: CVPixelBuffer) {
        lock.lock()
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        if let old = latestBuffer, CVPixelBufferGetWidth(old) != w || CVPixelBufferGetHeight(old) != h { gen += 1 }
        latestBuffer = pb
        version += 1
        lock.unlock()
        signalAll()
    }

    func setStatus(_ s: CaptureStatus, detail: String? = nil) {
        lock.lock()
        let changed = statusValue != s || detailValue != detail
        statusValue = s
        detailValue = detail
        if s != .ok { latestBuffer = nil }
        lock.unlock()
        if changed {
            Log.info("capture", "\(monitor.id): \(s)\(detail.map { " (\($0))" } ?? "")")
            signalAll()
        }
    }

    func updateMonitor(_ m: MonitorInfo) {
        lock.lock()
        if m.width != monitorValue.width || m.height != monitorValue.height { gen += 1 }
        monitorValue = m
        lock.unlock()
    }

    func bumpGeneration() {
        lock.lock(); gen += 1; latestBuffer = nil; lock.unlock()
    }

    // ------------------------------------------------------------------ lifecycle (overridden)

    func start() {
        cursorToken = CursorTracker.shared.add { [weak self] in self?.onCursor($0) }
    }

    func stop() {
        if let t = cursorToken { CursorTracker.shared.remove(t) }
        cursorToken = nil
    }

    // ------------------------------------------------------------------ cursor

    public func addCursorListener(_ owner: AnyObject, moved: @escaping (CaptureSource) -> Void, shape: @escaping (CaptureSource, CursorShape) -> Void) {
        lock.lock(); cursorListeners[ObjectIdentifier(owner)] = (moved, shape); lock.unlock()
    }

    public func removeCursorListener(_ owner: AnyObject) {
        lock.lock(); cursorListeners[ObjectIdentifier(owner)] = nil; lock.unlock()
    }

    private func onCursor(_ s: CursorTracker.State) {
        let m = monitor
        let b = m.bounds
        let sx = Double(m.width) / b.width, sy = Double(m.height) / b.height
        let x = Int(((s.location.x - b.minX) * sx).rounded(.down))
        let y = Int(((s.location.y - b.minY) * sy).rounded(.down))
        let inside = s.location.x >= b.minX && s.location.x < b.maxX && s.location.y >= b.minY && s.location.y < b.maxY
        let visible = s.visible && inside

        var newShape: CursorShape?
        if let img = s.image {
            // Render at this display's density so the cursor matches the video's pixel scale.
            let sh = CursorTracker.shared.shape(img, scale: m.isTestPattern ? sx : m.scale)
            if sh.id != shape?.id { newShape = sh }
        }
        lock.lock()
        let moved = x != cursorPos.x || y != cursorPos.y || visible != cursorPos.visible
        cursorPos = (x, y, visible)
        if let newShape { shapeValue = newShape }
        let listeners = Array(cursorListeners.values)
        lock.unlock()
        if let newShape { for l in listeners { l.shape(self, newShape) } }
        if moved { for l in listeners { l.moved(self) } }
    }
}

/// Ref-counted registry so several viewers share one capture per display.
public enum CaptureHub {
    private static let lock = NSLock()
    private static var sources: [String: (source: CaptureSource, refs: Int)] = [:]

    public static func acquire(_ monitor: MonitorInfo) -> CaptureSource {
        lock.lock(); defer { lock.unlock() }
        if let e = sources[monitor.id] {
            sources[monitor.id] = (e.source, e.refs + 1)
            return e.source
        }
        let src: CaptureSource = monitor.isTestPattern ? TestPatternSource(monitor: monitor) : ScreenCaptureSource(monitor: monitor)
        sources[monitor.id] = (src, 1)
        src.start()
        return src
    }

    public static func release(_ source: CaptureSource) {
        lock.lock()
        guard let (key, e) = sources.first(where: { $0.value.source === source }) else { lock.unlock(); return }
        var toStop: CaptureSource?
        if e.refs <= 1 { sources[key] = nil; toStop = source } else { sources[key] = (source, e.refs - 1) }
        lock.unlock()
        toStop?.stop()
    }
}
