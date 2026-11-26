import AppKit
import Foundation

/// Text clipboard sync. macOS has no clipboard-change notification, so the pasteboard's change count is
/// polled (4 Hz, only while someone is subscribed). Our own writes are recognised by change count so they
/// don't echo back to the viewer that sent them.
public final class ClipboardService {
    public static let shared = ClipboardService()

    /// This Mac's clipboard. Tests only (HEADROOM_TEST_PASTEBOARD=<name>, with the test pattern): a private named
    /// pasteboard instead, so a test engine never reads or replaces what the person here copied.
    static let pasteboard: NSPasteboard = {
        guard Displays.testPatternSize != nil, let name = ProcessInfo.processInfo.environment["HEADROOM_TEST_PASTEBOARD"], !name.isEmpty else {
            return .general
        }
        Log.warn("clipboard", "TEST: the clipboard is the private pasteboard '\(name)', not this Mac's")
        return NSPasteboard(name: NSPasteboard.Name(name))
    }()

    /// Viewers get clipboard text in one WebSocket message, and every leg (this engine, the relay) takes messages up to
    /// 16 MiB: more would drop the session's connection. Larger text isn't synced (the web client holds the same limit).
    public static let maxTextBytes = 4 << 20
    static func fits(_ text: String) -> Bool { text.utf8.count <= maxTextBytes }

    private let lock = NSLock()
    private var listeners: [ObjectIdentifier: (String) -> Void] = [:]
    private var timer: Timer?
    private var lastChangeCount = -1
    private var ownChangeCount = -1
    private var lastText: String?

    public func subscribe(_ owner: AnyObject, _ fn: @escaping (String) -> Void) {
        lock.lock()
        listeners[ObjectIdentifier(owner)] = fn
        let start = listeners.count == 1
        lock.unlock()
        if start {
            DispatchQueue.main.async { [self] in
                guard timer == nil else { return }
                lastChangeCount = Self.pasteboard.changeCount
                lastText = Self.pasteboard.string(forType: .string)
                let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.poll() }
                RunLoop.main.add(t, forMode: .common)
                timer = t
            }
        }
    }

    public func unsubscribe(_ owner: AnyObject) {
        lock.lock()
        listeners[ObjectIdentifier(owner)] = nil
        let stop = listeners.isEmpty
        lock.unlock()
        if stop {
            DispatchQueue.main.async { [self] in
                lock.lock(); let empty = listeners.isEmpty; lock.unlock()
                if empty { timer?.invalidate(); timer = nil }
            }
        }
    }

    private func poll() {
        let pb = Self.pasteboard
        let cc = pb.changeCount
        guard cc != lastChangeCount else { return }
        lastChangeCount = cc
        if cc == ownChangeCount { return }
        // Ignore password managers' concealed items.
        if pb.types?.contains(NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")) == true { return }
        guard let text = pb.string(forType: .string), text != lastText else { return }
        lastText = text
        guard Self.fits(text) else {
            Log.info("clipboard", "not synced: \(text.utf8.count) bytes of text is more than viewers take")
            return
        }
        lock.lock(); let ls = Array(listeners.values); lock.unlock()
        for l in ls { l(text) }
    }

    public func setText(_ text: String) {
        DispatchQueue.main.async { [self] in
            let pb = Self.pasteboard
            pb.clearContents()
            pb.setString(text, forType: .string)
            ownChangeCount = pb.changeCount
            lastChangeCount = ownChangeCount
            lastText = text
        }
    }

    /// Current clipboard text (none when it's more than viewers take).
    public func getText() -> String? {
        let text = Thread.isMainThread ? Self.pasteboard.string(forType: .string) : DispatchQueue.main.sync { Self.pasteboard.string(forType: .string) }
        return text.flatMap { Self.fits($0) ? $0 : nil }
    }
}
