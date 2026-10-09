import AppKit
import Foundation

/// Text clipboard sync. macOS has no clipboard-change notification, so the pasteboard's change count is
/// polled (4 Hz, only while someone is subscribed). Our own writes are recognised by change count so they
/// don't echo back to the viewer that sent them.
public final class ClipboardService {
    public static let shared = ClipboardService()

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
                lastChangeCount = NSPasteboard.general.changeCount
                lastText = NSPasteboard.general.string(forType: .string)
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
        let pb = NSPasteboard.general
        let cc = pb.changeCount
        guard cc != lastChangeCount else { return }
        lastChangeCount = cc
        if cc == ownChangeCount { return }
        // Ignore password managers' concealed items.
        if pb.types?.contains(NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")) == true { return }
        guard let text = pb.string(forType: .string), text != lastText else { return }
        lastText = text
        lock.lock(); let ls = Array(listeners.values); lock.unlock()
        for l in ls { l(text) }
    }

    public func setText(_ text: String) {
        DispatchQueue.main.async { [self] in
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(text, forType: .string)
            ownChangeCount = pb.changeCount
            lastChangeCount = ownChangeCount
            lastText = text
        }
    }

    /// Current clipboard text.
    public func getText() -> String? {
        if Thread.isMainThread { return NSPasteboard.general.string(forType: .string) }
        return DispatchQueue.main.sync { NSPasteboard.general.string(forType: .string) }
    }
}
