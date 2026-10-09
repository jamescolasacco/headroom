import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    static let shared = AppDelegate()
    private var windows: [ViewerWindow] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        openWindow(ClientScheme.startUrl)
        NSApp.activate(ignoringOtherApps: true)
        let nc = NotificationCenter.default
        nc.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.updateShortcutCapture() }
        nc.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.updateShortcutCapture() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if windows.isEmpty { openWindow(ClientScheme.startUrl) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        SystemShortcuts.capture(false)
    }

    func openWindow(_ url: URL) {
        let w = ViewerWindow(url: url)
        w.onClose = { [weak self] closed in
            self?.windows.removeAll { $0 === closed }
            self?.updateShortcutCapture()
        }
        windows.append(w)
        w.show()
    }

    @objc func newWindow(_ sender: Any?) { openWindow(ClientScheme.startUrl) }

    func updateShortcutCapture() {
        SystemShortcuts.capture(windows.contains { $0.wantsShortcuts })
    }
}
