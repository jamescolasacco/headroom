import AppKit
import HeadroomUpdate

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    static let shared = AppDelegate()
    private var windows: [ViewerWindow] = []
    /// The app menu's update item: "Check for Updates…", then "Restart to Update to 1.2.3" once one is downloaded.
    var updateItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        openWindow(ClientScheme.startUrl)
        NSApp.activate(ignoringOtherApps: true)
        let nc = NotificationCenter.default
        nc.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.updateShortcutCapture() }
        nc.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.updateShortcutCapture() }
        nc.addObserver(forName: Updater.didChange, object: Updater.shared, queue: .main) { [weak self] n in
            if let s = n.userInfo?["state"] as? Updater.State { self?.updateChanged(s) }
        }
        Updater.shared.start()
    }

    // ------------------------------------------------------------------ updates

    /// The menu item says where the update is; every window's page hears it too (its "Restart to update" banner).
    private func updateChanged(_ s: Updater.State) {
        switch s.phase {
        case .checking: updateItem?.title = "Checking for Updates…"
        case .downloading: updateItem?.title = "Downloading Update… \(Int(s.progress * 100))%"
        case .ready: updateItem?.title = "Restart to Update to \(s.available ?? "")"
        default: updateItem?.title = "Check for Updates…"
        }
        windows.forEach { $0.post(s.json) }
    }

    @objc func updateMenuAction(_ sender: Any?) {
        if Updater.shared.state.phase == .ready { restartToUpdate() } else { Updater.shared.check(userInitiated: true) }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard item === updateItem else { return true }
        return ![.checking, .downloading].contains(Updater.shared.state.phase)
    }

    /// Installs the downloaded update: Headroom Viewer quits, is replaced and opens again. A session ends, so ask.
    func restartToUpdate() {
        guard Updater.shared.state.phase == .ready, let v = Updater.shared.state.available else { return }
        let live = windows.filter(\.sessionActive).compactMap(\.sessionHost)
        if !live.isEmpty || windows.contains(where: \.sessionActive) {
            let a = NSAlert()
            a.messageText = "Restart to update to \(v)?"
            a.informativeText = "Headroom Viewer closes and opens again, which ends your session\(live.isEmpty ? "" : " with \(live.joined(separator: ", "))"). You can connect again right after."
            a.alertStyle = .warning
            a.addButton(withTitle: "Restart and Update")
            a.addButton(withTitle: "Cancel")
            if a.runModal() != .alertFirstButtonReturn { return }
        }
        do { try Updater.shared.install() } catch {
            let a = NSAlert()
            a.messageText = "Couldn't install the update"
            a.informativeText = "\(error)\n\nYou can install it by hand from https://github.com/jamescolasacco/headroom/releases/latest."
            a.runModal()
            return
        }
        NSApp.terminate(nil)
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
