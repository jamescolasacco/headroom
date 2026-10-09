import AppKit

/// While a window with a live session is focused, macOS's own system shortcuts — ⌘Tab, ⌘Space, ⌃↑/⌃↓
/// (Mission Control), ⌘⇧3/4/5 (screenshots), ⌃⌘Q — are switched off for the whole system and arrive at the
/// viewer as ordinary key events, which the page forwards to the remote computer. This is the same
/// window-server switch VMware Fusion and Parallels use ("send system shortcuts to the guest"); it needs no
/// permission. It's restored as soon as the window loses focus, the session ends or the app quits.
enum SystemShortcuts {
    private typealias MainConnection = @convention(c) () -> Int32
    private typealias SetMode = @convention(c) (Int32, Int32) -> Int32
    private static let disableMode: Int32 = 1   // kCGSGlobalHotKeyDisable
    private static let enableMode: Int32 = 0    // kCGSGlobalHotKeyEnable

    private static let fns: (MainConnection, SetMode)? = {
        let h = dlopen(nil, RTLD_NOW)
        guard let m = dlsym(h, "CGSMainConnectionID"), let s = dlsym(h, "CGSSetGlobalHotKeyOperatingMode") else { return nil }
        return (unsafeBitCast(m, to: MainConnection.self), unsafeBitCast(s, to: SetMode.self))
    }()

    static var available: Bool { fns != nil }
    private(set) static var captured = false

    /// Capture (true) or give back (false) the system shortcuts. Idempotent.
    static func capture(_ on: Bool) {
        guard on != captured, let (main, set) = fns else { return }
        _ = set(main(), on ? disableMode : enableMode)
        captured = on
    }
}
