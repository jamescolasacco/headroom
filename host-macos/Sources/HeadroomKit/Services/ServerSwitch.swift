import Foundation

/// "Stop server" (Headroom Server's window, menu-bar menu): while stopped, nobody can reach this Mac. The relay
/// connection closes, so your devices see it as offline; direct connections and guest codes are refused, and any
/// sessions end. The engine keeps running, so the settings window works as usual: sign in, settings, and so on.
/// Not saved: Headroom Server starts it again the next time it starts.
public final class ServerSwitch {
    public static let shared = ServerSwitch()

    private let lock = NSLock()
    private var isStopped = false

    public var stopped: Bool {
        lock.lock(); defer { lock.unlock() }
        return isStopped
    }

    public func stop() {
        lock.lock(); let was = isStopped; isStopped = true; lock.unlock()
        guard !was else { return }
        Log.info("main", "stopped from Headroom Server: nobody can connect until it's started")
        SupportService.shared.cancelCode()
        SupportService.shared.revokeAll()
        for s in SessionManager.active { s.disconnect("Headroom Server was stopped on this computer") }
        // The relay connection closes on its next tick: RelayService wants none while stopped.
    }

    public func start() {
        lock.lock(); let was = isStopped; isStopped = false; lock.unlock()
        if was { Log.info("main", "started from Headroom Server") }
    }
}
