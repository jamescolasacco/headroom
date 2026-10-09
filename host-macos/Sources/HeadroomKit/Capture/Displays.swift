import AppKit
import CoreGraphics
import Foundation

public struct MonitorInfo: Equatable {
    /// CGDirectDisplayID as a string — the id the protocol uses.
    public let id: String
    public let displayID: CGDirectDisplayID
    public let name: String
    /// Global desktop rectangle in points (top-left origin, main display at 0,0). Input and cursor use this.
    public let bounds: CGRect
    /// Native pixel size: what gets captured (the backing-store resolution of scaled Retina modes).
    public let width: Int
    public let height: Int
    public let primary: Bool
    public let refreshHz: Double
    /// Pixels per point.
    public let scale: Double
    public let rotation: Int
    public var isTestPattern = false

    /// Protocol form. x/y are the display's global position in points (macOS has no global pixel space
    /// across displays of different densities); width/height are the pixels streamed.
    public var json: JSONObject {
        ["id": id, "name": name, "x": Int(bounds.minX), "y": Int(bounds.minY), "width": width, "height": height,
         "primary": primary, "refreshHz": refreshHz, "scale": scale, "rotation": rotation]
    }
}

public enum Displays {
    private static let namesLock = NSLock()
    private static var names: [CGDirectDisplayID: (name: String, maxFps: Int)] = [:]
    private static var observing = false

    /// Fake display for development and automated tests (HEADROOM_TEST_PATTERN=1, or WxH like 1280x720):
    /// lets the whole pipeline run without the Screen Recording permission.
    public static let testPatternSize: (Int, Int)? = {
        guard let v = ProcessInfo.processInfo.environment["HEADROOM_TEST_PATTERN"], !v.isEmpty, v != "0" else { return nil }
        let parts = v.lowercased().split(separator: "x").compactMap { Int($0) }
        if parts.count == 2, parts[0] >= 64, parts[1] >= 64 { return (parts[0] & ~1, parts[1] & ~1) }
        return (1920, 1080)
    }()

    public static func enumerate() -> [MonitorInfo] {
        if let (w, h) = testPatternSize {
            let main = CGDisplayBounds(CGMainDisplayID())
            var m = MonitorInfo(id: "test", displayID: CGMainDisplayID(), name: "Test pattern", bounds: main.isEmpty ? CGRect(x: 0, y: 0, width: w, height: h) : main,
                                width: w, height: h, primary: true, refreshHz: 60, scale: 1, rotation: 0)
            m.isTestPattern = true
            return [m]
        }
        refreshNamesIfNeeded()
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return [] }
        var result = [MonitorInfo]()
        for id in ids.prefix(Int(count)) {
            // Mirrored displays show the same content: stream only the mirror set's master.
            if CGDisplayIsInMirrorSet(id) != 0 && CGDisplayMirrorsDisplay(id) != kCGNullDirectDisplay { continue }
            let bounds = CGDisplayBounds(id)
            guard bounds.width > 0, bounds.height > 0 else { continue }
            let mode = CGDisplayCopyDisplayMode(id)
            let pw = Double(mode?.pixelWidth ?? Int(bounds.width)), ph = Double(mode?.pixelHeight ?? Int(bounds.height))
            // Modes report unrotated pixels; the bounds are rotated. Compare long sides.
            let scale = max(1, max(pw, ph) / max(bounds.width, bounds.height))
            let width = Int((bounds.width * scale).rounded()) & ~1
            let height = Int((bounds.height * scale).rounded()) & ~1
            namesLock.lock()
            let info = names[id]
            namesLock.unlock()
            var hz = mode?.refreshRate ?? 0
            if hz <= 0 { hz = Double(info?.maxFps ?? 60) }
            if hz <= 0 { hz = 60 }
            result.append(MonitorInfo(
                id: String(id), displayID: id,
                name: info?.name ?? (CGDisplayIsBuiltin(id) != 0 ? "Built-in Display" : "Display \(id)"),
                bounds: bounds, width: width, height: height,
                primary: CGDisplayIsMain(id) != 0, refreshHz: (hz * 100).rounded() / 100,
                scale: (scale * 100).rounded() / 100, rotation: Int(CGDisplayRotation(id))))
        }
        // Primary first, then left-to-right, top-to-bottom: matches how people think about their layout.
        result.sort { a, b in
            if a.primary != b.primary { return a.primary }
            if a.bounds.minX != b.bounds.minX { return a.bounds.minX < b.bounds.minX }
            return a.bounds.minY < b.bounds.minY
        }
        return result
    }

    public static func find(_ id: String) -> MonitorInfo? { enumerate().first { $0.id == id } }

    /// Friendly names ("LG UltraFine", "Built-in Retina Display") come from NSScreen, which belongs to the
    /// main thread; cache them and refresh when the display configuration changes.
    private static func refreshNamesIfNeeded() {
        namesLock.lock()
        let empty = names.isEmpty
        namesLock.unlock()
        if !empty && observing { return }
        if Thread.isMainThread { loadNames() } else { DispatchQueue.main.sync { loadNames() } }
    }

    private static func loadNames() {
        var map: [CGDirectDisplayID: (String, Int)] = [:]
        for s in NSScreen.screens {
            guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            map[CGDirectDisplayID(n.uint32Value)] = (s.localizedName, s.maximumFramesPerSecond)
        }
        namesLock.lock()
        names = map
        let start = !observing
        observing = true
        namesLock.unlock()
        if start {
            NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in
                loadNames()
            }
        }
    }
}
