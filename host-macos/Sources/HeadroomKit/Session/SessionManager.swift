import Foundation
import IOKit.pwr_mgt

/// Tracks connected viewers: keeps the Mac (and its display) awake while anyone is connected, and locks the
/// screen when the last one leaves if configured.
public enum SessionManager {
    private static let lock = NSLock()
    private static var sessions: [ClientSession] = []
    private static var assertion: IOPMAssertionID = 0
    private static var activityAssertion: IOPMAssertionID = 0
    private static var changedHandlers: [() -> Void] = []

    public static var active: [ClientSession] { lock.lock(); defer { lock.unlock() }; return sessions }

    public static func onChanged(_ fn: @escaping () -> Void) {
        lock.lock(); changedHandlers.append(fn); lock.unlock()
    }

    static func register(_ s: ClientSession) {
        if let id = s.device?.id, id.hasPrefix("guest:") { SupportService.shared.sessionStarted(id) }
        lock.lock()
        sessions.append(s)
        if assertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                        "Headroom: a viewer is connected" as CFString, &assertion)
            Log.debug("power", "keeping system and display awake while viewers are connected")
        }
        // Wake the display if it was asleep (like moving the mouse).
        IOPMAssertionDeclareUserActivity("Headroom viewer connected" as CFString, kIOPMUserActiveLocal, &activityAssertion)
        let handlers = changedHandlers
        lock.unlock()
        Displays.testDisplayWake()
        handlers.forEach { $0() }
    }

    static func unregister(_ s: ClientSession) {
        if let id = s.device?.id, id.hasPrefix("guest:") { SupportService.shared.sessionEnded(id) }
        lock.lock()
        sessions.removeAll { $0 === s }
        let last = sessions.isEmpty
        if last && assertion != 0 {
            IOPMAssertionRelease(assertion)
            assertion = 0
        }
        let handlers = changedHandlers
        lock.unlock()
        handlers.forEach { $0() }
        if last && ConfigStore.current.lockOnDisconnect {
            Log.info("session", "last viewer left; locking the screen")
            InputInjector.shared.lockScreen()
        }
    }

    /// Wakes the display, and the Mac from a dark wake, as moving the mouse would: a viewer is waiting to see it.
    static func wakeDisplay() {
        lock.lock()
        IOPMAssertionDeclareUserActivity("Headroom viewer waiting for the display" as CFString, kIOPMUserActiveLocal, &activityAssertion)
        lock.unlock()
        Displays.testDisplayWake()
    }

    public static func disconnectDevice(_ deviceId: String) {
        for s in active where s.device?.id == deviceId { s.disconnect("device revoked") }
    }

    /// What a session may do changed (a guest's rights, or this computer's settings): tell the running sessions.
    public static func rightsChanged(_ deviceId: String? = nil) {
        for s in active where deviceId == nil || s.device?.id == deviceId { s.applyRights() }
        let handlers = { lock.lock(); defer { lock.unlock() }; return changedHandlers }()
        handlers.forEach { $0() }
    }
}
