import Foundation

/// Win32-style auto-reset event: `set()` wakes one waiter (or the next `wait`), then resets itself.
/// Lets the capture sources signal "new frame" to each pipeline without counting signals.
public final class AutoResetEvent {
    private let cond = NSCondition()
    private var signaled: Bool

    public init(_ initial: Bool = false) { signaled = initial }

    public func set() {
        cond.lock()
        signaled = true
        cond.signal()
        cond.unlock()
    }

    /// Returns true if signaled, false on timeout.
    @discardableResult
    public func wait(timeoutMs: Int) -> Bool {
        cond.lock(); defer { cond.unlock() }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while !signaled {
            if !cond.wait(until: deadline) { break }
        }
        let was = signaled
        signaled = false
        return was
    }
}
