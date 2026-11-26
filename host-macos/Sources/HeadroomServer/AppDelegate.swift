import AppKit
import HeadroomUpdate
import ServiceManagement
import UserNotifications

/// Headroom Server's menu-bar presence, like VNC Server's: shows whether anyone is connected, notifies when a
/// viewer connects or leaves, and gives quick actions. Runs the engine itself and keeps it running.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private var statusItem: NSStatusItem!
    private let admin = AdminClient()
    private let engine = EngineManager()
    private var settings: SettingsWindow?
    private let stopBar = StopBar()
    private var status: ServerStatus?
    private var knownViewers = [String: ViewerInfo]()
    private var firstPoll = true
    private var offlinePolls = 0
    private var pollTimer: Timer?
    private var launchedAtLogin = false
    /// Guest requests already put in front of the user, and the one whose prompt is showing.
    private var askedRequests = Set<String>()
    private var alertRequest: String?
    private var pendingStart: [(Bool) -> Void] = []
    /// Updates: the version we've told the user about (once), and whether we're quitting to install one.
    private var announcedUpdate: String?
    private var updating = false
    private var handingOff = false
    private var switchingOwner = false
    private var checkingInstall = false
    /// Set once the menu bar has had a moment to place the icon (see updateDockIcon).
    private var menuBarSettled = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Launched as a login item: stay in the menu bar unless something needs the user.
        let ev = NSAppleEventManager.shared().currentAppleEvent
        launchedAtLogin = ev?.eventID == kAEOpenApplication && ev?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
            || CommandLine.arguments.contains("--tray")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if openInstalledCopyIfNeeded() { return }
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showExistingWindow),
            name: ServerInstallation.showSettings, object: String(getpid()))
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = StatusIcon.image(active: false)
        statusItem.button?.toolTip = "Headroom Server"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        // Whether macOS shows the icon can change (another menu-bar app quits, the icon is dragged elsewhere).
        if let w = statusItem.button?.window {
            NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: w, queue: .main) { [weak self] _ in
                self?.updateDockIcon()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.menuBarSettled = true
            self?.updateDockIcon()
        }

        UNUserNotificationCenter.current().delegate = self

        engine.onExit = { [weak self] in self?.poll() }
        NotificationCenter.default.addObserver(forName: Updater.didChange, object: Updater.shared, queue: .main) { [weak self] n in
            if let s = n.userInfo?["state"] as? Updater.State { self?.updateChanged(s) }
        }
        Updater.shared.start()
        engine.start()
        poll()
        let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
        if !launchedAtLogin { showWindow("home") }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !handingOff else { return false }
        showWindow("home") // opened again from Finder / Launchpad / Spotlight
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if updating || handingOff { return .terminateNow } // asked already: the installer is waiting for us to quit
        if let st = status, !st.viewers.isEmpty, engine.running {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert()
            a.messageText = "Someone is connected"
            a.informativeText = "Quitting stops the server and ends their session. Quit anyway?"
            a.alertStyle = .warning
            a.addButton(withTitle: "Quit")
            a.addButton(withTitle: "Cancel")
            if a.runModal() != .alertFirstButtonReturn { return .terminateCancel }
        }
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        DistributedNotificationCenter.default().removeObserver(self)
        pollTimer?.invalidate()
        engine.stop()
    }

    // A copy opened from a checkout or download must not start its own engine or updater
    // when Headroom Server is installed in Applications.
    private func openInstalledCopyIfNeeded() -> Bool {
        guard Bundle.main.bundleIdentifier == InstalledApplication.server.bundleID,
              let installed = InstalledApplication.server.preferredURL(for: Bundle.main.bundleURL) else { return false }
        handingOff = true
        InstalledApplication.server.open(installed, activate: !launchedAtLogin, arguments: launchedAtLogin ? ["--tray"] : []) { error in
            if let error { NSAlert(error: error).runModal() }
            NSApp.terminate(nil)
        }
        return true
    }

    @objc private func showExistingWindow(_ notification: Notification) {
        if !handingOff { showWindow("home") }
    }

    /// The ports elect one engine even if two portable copies start simultaneously.
    /// Send the user to its actual parent and leave any live session alone.
    private func handOffToOwner(of status: ServerStatus) -> Bool {
        guard engine.pid != status.pid, let owner = ServerInstallation.runningOwner(of: status.pid),
              owner.processIdentifier != getpid() else { return false }
        if !launchedAtLogin, let url = owner.bundleURL,
           let preferred = InstalledApplication.server.preferredURL(for: url),
           preferred.resolvingSymlinksInPath().path == Bundle.main.bundleURL.resolvingSymlinksInPath().path {
            // An older portable copy may already be running when the app is first installed.
            switchingOwner = true
            let alert = NSAlert()
            alert.messageText = "Switch to the installed Headroom Server?"
            let sessions = status.viewers.isEmpty ? "" : " Switching ends the current remote session."
            alert.informativeText = "Headroom Server is running from \(url.path). Switching quits that copy and starts \(preferred.path).\(sessions)"
            alert.addButton(withTitle: "Keep Current Server")
            alert.addButton(withTitle: "Switch to Installed Copy")
            if alert.runModal() == .alertSecondButtonReturn, owner.terminate() {
                waitForOwnerToQuit(owner, until: .now() + 15)
                return true
            }
            switchingOwner = false
        }
        handingOff = true
        if !launchedAtLogin {
            DistributedNotificationCenter.default().postNotificationName(ServerInstallation.showSettings,
                object: String(owner.processIdentifier), userInfo: nil, deliverImmediately: true)
            owner.activate(options: [.activateAllWindows])
        }
        NSApp.terminate(nil)
        return true
    }

    private func waitForOwnerToQuit(_ owner: NSRunningApplication, until deadline: DispatchTime) {
        admin.status { [weak self] live in
            guard let self else { return }
            if owner.isTerminated && (live == nil || live?.pid == self.engine.pid) {
                self.switchingOwner = false
                _ = self.engine.start()
                self.poll()
            } else if DispatchTime.now() < deadline {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForOwnerToQuit(owner, until: deadline) }
            } else {
                self.handingOff = true
                let alert = NSAlert()
                alert.messageText = "The other Headroom Server is still using the server port"
                alert.informativeText = "Quit that copy before opening the installed app again."
                alert.runModal()
                NSApp.terminate(nil)
            }
        }
    }

    // ------------------------------------------------------------------ status

    private func poll() {
        admin.status { [weak self] st in self?.apply(st) }
    }

    private func apply(_ st: ServerStatus?) {
        guard !handingOff, !switchingOwner else { return }
        if let st, handOffToOwner(of: st) { return }
        updateDockIcon()
        guard let st else {
            status = nil
            offlinePolls += 1
            // Ours stood aside for another engine on the same ports (one no Headroom Server app owns, so nobody
            // handed off), and nothing answers there now: serve again.
            if offlinePolls >= 2 { engine.retryIfPortsFree() }
            stopBar.update([], host: "", onStop: {}, onOpen: {})
            statusItem.button?.image = StatusIcon.image(active: false, warning: offlinePolls > 2)
            statusItem.button?.toolTip = engine.userStopped ? "Headroom Server — stopped" : "Headroom Server — starting…"
            if offlinePolls == 3, let s = settings, s.window.isVisible { s.showOffline() }
            return
        }
        let wasOffline = status == nil && !firstPoll
        offlinePolls = 0
        status = st
        let ids = Dictionary(uniqueKeysWithValues: st.viewers.map { ($0.id, $0) })
        if !firstPoll && st.notifyOnConnect {
            for v in st.viewers where knownViewers[v.id] == nil {
                notify(v.guest ? "“\(v.device)” (guest) connected" : "\(v.device) connected", "From \(v.address). Click Stop in the bar at the top of the screen to end it.")
            }
            for (id, v) in knownViewers where ids[id] == nil {
                notify("\(v.device) disconnected", "The remote session ended.")
            }
        } else if firstPoll && !st.signedIn && launchedAtLogin {
            notify("Headroom is running", "Open Headroom Server from the menu bar to sign in, or to let someone connect with a code.")
        }
        knownViewers = ids
        firstPoll = false
        askAboutSupportRequests(st.supportRequests)
        stopBar.update(st.viewers, host: st.hostName, onStop: { [weak self] in
            guard let self else { return }
            if let only = self.status?.viewers, only.count == 1 { self.admin.stop(only[0].id) { self.poll() } } else { self.admin.disconnectAll { self.poll() } }
        }, onOpen: { [weak self] in self?.showWindow("home") })

        let needsPermission = !st.screenRecording || !st.accessibility
        statusItem.button?.image = StatusIcon.image(active: !st.viewers.isEmpty, warning: (needsPermission || st.stopped) && st.viewers.isEmpty)
        if st.stopped {
            statusItem.button?.toolTip = "Headroom Server — stopped"
        } else {
            statusItem.button?.toolTip = switch st.viewers.count {
            case 0: needsPermission ? "Headroom Server — needs permission" : "Headroom Server — ready (\(st.hostName))"
            case 1: "Headroom — \(st.viewers[0].device) connected"
            default: "Headroom — \(st.viewers.count) viewers connected"
            }
        }
        if wasOffline { settings?.reloadIfOffline() }
    }

    /// Someone entered your guest code: Accept, View Only or Decline, and what else they may do (files and
    /// clipboard start unticked). The prompt goes away by itself if the request is answered in the settings window
    /// or times out.
    private func askAboutSupportRequests(_ requests: [SupportRequest]) {
        if let showing = alertRequest, !requests.contains(where: { $0.id == showing }) {
            NSApp.abortModal()
            return
        }
        guard alertRequest == nil, let r = requests.first(where: { !askedRequests.contains($0.id) }) else { return }
        askedRequests.insert(r.id)
        alertRequest = r.id
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let a = NSAlert()
            a.messageText = "“\(r.name)” wants to connect to this Mac"
            var from = [String]()
            if let c = r.country { from.append("\(Locale.current.localizedString(forRegionCode: c) ?? c) (approximate)") }
            if !r.address.isEmpty { from.append(r.address) }
            a.informativeText = "They entered your code. The name is what they typed — it isn't verified"
                + (from.isEmpty ? "." : ". From \(from.joined(separator: " · ")).")
                + "\n\nOnly accept if you know this person and asked for their help. Scammers call pretending to be support and ask for codes."
                + "\n\nAccept lets them see and control your screen; View Only lets them watch. Stop any time from the bar at the top of the screen. No answer in 2 minutes declines."
            a.alertStyle = .warning
            let files = NSButton(checkboxWithTitle: "Let them transfer files", target: nil, action: nil)
            let clip = NSButton(checkboxWithTitle: "Share clipboard", target: nil, action: nil)
            files.state = .off
            clip.state = .off
            let box = NSStackView(views: [files, clip])
            box.orientation = .vertical
            box.alignment = .leading
            box.spacing = 6
            box.frame = NSRect(x: 0, y: 0, width: 260, height: 44)
            a.accessoryView = box
            a.addButton(withTitle: "Decline")
            a.addButton(withTitle: "View Only")
            a.addButton(withTitle: "Accept")
            // The safe answer is the strong one: Decline is the default button (Return), and Esc declines too.
            a.buttons[0].keyEquivalent = "\r"
            a.buttons[1].keyEquivalent = ""
            a.buttons[2].keyEquivalent = ""
            let escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
                guard e.keyCode == 53, e.window === a.window else { return e } // 53 = Esc
                a.buttons[0].performClick(nil)
                return nil
            }
            NSApp.activate(ignoringOtherApps: true)
            NSSound(named: "Glass")?.play()
            let answer = a.runModal()
            if let escape { NSEvent.removeMonitor(escape) }
            self.alertRequest = nil
            let f = files.state == .on, c = clip.state == .on
            switch answer {
            case .alertFirstButtonReturn: self.admin.answerSupport(r.id, accept: false, viewOnly: false, files: false, clipboard: false)
            case .alertSecondButtonReturn: self.admin.answerSupport(r.id, accept: true, viewOnly: true, files: f, clipboard: c)
            case .alertThirdButtonReturn: self.admin.answerSupport(r.id, accept: true, viewOnly: false, files: f, clipboard: c)
            default: break // aborted: answered elsewhere or timed out
            }
            self.poll()
        }
    }

    /// Asks for notification permission the first time there is something to say, not at launch.
    private func notify(_ title: String, _ body: String) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { s in
            let post = { center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)) }
            if s.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .sound]) { ok, _ in if ok { post() } }
            } else if s.authorizationStatus == .authorized || s.authorizationStatus == .provisional {
                post()
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        showWindow("home")
        done()
    }

    // ------------------------------------------------------------------ updates

    private func updateChanged(_ s: Updater.State) {
        settings?.sendUpdate(s)
        guard s.phase == .ready, let v = s.available, announcedUpdate != v else { return }
        announcedUpdate = v
        notify("Headroom \(v) is ready", "Restart Headroom Server to update: from the menu bar, or in its window. It takes a few seconds.")
    }

    @objc private func checkForUpdates() { Updater.shared.check(userInitiated: true) }

    /// Installs the downloaded update: Headroom Server (and Headroom Viewer, if it's here) quit, are replaced, and
    /// open again. If someone is connected, ask first: their session ends.
    @objc func restartToUpdate() {
        guard !checkingInstall, !handingOff, !switchingOwner, Updater.shared.state.phase == .ready else { return }
        if let installed = InstalledApplication.server.preferredURL(for: Bundle.main.bundleURL) {
            let alert = NSAlert()
            alert.messageText = "Update the installed Headroom Server"
            alert.informativeText = "Quit this copy and open \(installed.path) to update it."
            alert.runModal()
            return
        }
        checkingInstall = true
        admin.status { [weak self] live in
            guard let self else { return }
            self.checkingInstall = false
            guard !self.handingOff, !self.switchingOwner else { return }
            let active = live ?? self.status
            if let active, !ServerInstallation.canUpdate(ownEngine: self.engine.pid, servingEngine: active.pid) {
                if self.handOffToOwner(of: active) { return }
                let alert = NSAlert()
                alert.messageText = "Another Headroom engine is running"
                alert.informativeText = "Stop that engine before updating this copy of Headroom Server."
                alert.runModal()
                return
            }
            self.installUpdate(active)
        }
    }

    private func installUpdate(_ active: ServerStatus?) {
        guard let v = Updater.shared.state.available else { return }
        if let st = active, !st.viewers.isEmpty {
            NSApp.activate(ignoringOtherApps: true)
            let a = NSAlert()
            a.messageText = "Restart to update to \(v)?"
            a.informativeText = "Headroom Server restarts, which ends the session with \(st.viewers.map(\.device).joined(separator: ", ")). They can connect again once it's back, in a few seconds."
            a.alertStyle = .warning
            a.addButton(withTitle: "Restart and Update")
            a.addButton(withTitle: "Cancel")
            if a.runModal() != .alertFirstButtonReturn { return }
        }
        do {
            try Updater.shared.install()
        } catch {
            let a = NSAlert()
            a.messageText = "Couldn't install the update"
            a.informativeText = "\(error)\n\nYou can install it by hand from https://github.com/jamescolasacco/headroom/releases/latest."
            a.runModal()
            return
        }
        updating = true
        NSApp.terminate(nil)
    }

    // ------------------------------------------------------------------ menu bar and Dock

    /// macOS drops menu-bar icons that don't fit: beside a MacBook's notch a full menu bar hides the newest ones,
    /// and menu-bar managers hide others on purpose. So Headroom Server has a Dock icon while its window is open, and
    /// also while macOS isn't showing its menu-bar icon: with the window closed it's still in reach, with the same
    /// quick actions on a right-click (applicationDockMenu).
    private func updateDockIcon(windowOpen: Bool? = nil) {
        guard menuBarSettled else { return } // a moment after launch, the menu bar has placed (or hidden) the icon
        let open = windowOpen ?? (settings?.window.isVisible == true)
        let iconShown = statusItem.button?.window?.occlusionState.contains(.visible) ?? false
        let policy: NSApplication.ActivationPolicy = open || !iconShown ? .regular : .accessory
        if NSApp.activationPolicy() != policy { NSApp.setActivationPolicy(policy) }
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        fillMenu(menu, dock: true)
        return menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) { fillMenu(menu) }

    /// The quick actions, for the menu-bar icon's menu and the Dock icon's (which has its own Quit).
    private func fillMenu(_ menu: NSMenu, dock: Bool = false) {
        menu.removeAllItems()
        let st = status
        let header: String
        if let st {
            header = st.stopped ? "Stopped — nobody can connect"
                : st.viewers.isEmpty ? (st.online ? "Ready — nobody connected" : "Connecting to Headroom…") : st.viewers.map(\.device).joined(separator: ", ") + " connected"
        } else {
            header = engine.userStopped ? "Server stopped" : "Server not running"
        }
        let h = NSMenuItem(title: header, action: nil, keyEquivalent: "")
        h.isEnabled = false
        menu.addItem(h)
        let up = Updater.shared.state
        if up.phase == .ready, let v = up.available {
            let r = item("Restart to Update to \(v)", #selector(restartToUpdate))
            r.attributedTitle = NSAttributedString(string: r.title, attributes: [.font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)])
            menu.addItem(r)
        }
        menu.addItem(.separator())
        menu.addItem(item("Open Headroom Server…", #selector(openWindow)))
        menu.addItem(item("Let Someone Connect…", #selector(openConnect), enabled: st != nil))
        if let st, !st.viewers.isEmpty { menu.addItem(item("Stop Everyone's Session", #selector(disconnectAll))) }

        if let st, !st.screenRecording || !st.accessibility {
            menu.addItem(.separator())
            if !st.screenRecording { menu.addItem(item("Allow Screen Recording…", #selector(allowScreen))) }
            if !st.accessibility { menu.addItem(item("Allow Accessibility (remote control)…", #selector(allowAccessibility))) }
        }

        menu.addItem(.separator())
        if let st, st.stopped {
            menu.addItem(item("Start Server", #selector(startServerItem)))
        } else if engine.running || st != nil {
            menu.addItem(item("Stop Server", #selector(stopServer), enabled: st != nil))
        } else {
            menu.addItem(item("Start Server", #selector(startServerItem), enabled: EngineManager.engineExists))
        }
        let login = item("Start at Login", #selector(toggleLogin))
        login.state = loginEnabled ? .on : .off
        menu.addItem(login)
        switch up.phase {
        case .checking: menu.addItem(item("Checking for Updates…", #selector(checkForUpdates), enabled: false))
        case .downloading: menu.addItem(item("Downloading Update \(up.available ?? "")… \(Int(up.progress * 100))%", #selector(checkForUpdates), enabled: false))
        case .ready: break
        default: menu.addItem(item("Check for Updates…", #selector(checkForUpdates)))
        }
        if !dock {
            menu.addItem(.separator())
            menu.addItem(item("Quit Headroom Server", #selector(quit), key: "q"))
        }
    }

    private func item(_ title: String, _ action: Selector, enabled: Bool = true, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
        i.target = self
        i.isEnabled = enabled
        return i
    }

    @objc private func openWindow() { showWindow("home") }
    @objc private func openConnect() { showWindow("connect") }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func disconnectAll() { admin.disconnectAll { [weak self] in self?.poll() } }

    @objc private func allowScreen() {
        admin.requestPermission("screen")
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc private func allowAccessibility() {
        admin.requestPermission("accessibility")
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    /// Stop Server: nobody can connect until Start Server, but the engine keeps running, so the window still works
    /// (settings, sign in…) and shows the server as stopped.
    @objc private func stopServer() {
        admin.setServer(running: false) { [weak self] in self?.poll() }
    }

    /// Start Server: after Stop Server, the engine lets people connect again; if it isn't running at all, it starts.
    @objc private func startServerItem() {
        if status?.stopped == true { admin.setServer(running: true) { [weak self] in self?.poll() } } else { startServer { _ in } }
    }

    /// Starts the engine and waits (up to 10 s) for its admin API to answer.
    private func startServer(_ done: @escaping (Bool) -> Void) {
        engine.start()
        var tries = 0
        func check() {
            admin.status { [weak self] st in
                guard let self else { return }
                if st != nil { self.apply(st); done(true); return }
                tries += 1
                if tries >= 20 { done(false); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: check)
            }
        }
        check()
    }

    // ------------------------------------------------------------------ login item

    static var loginEnabled: Bool { SMAppService.mainApp.status == .enabled }
    private var loginEnabled: Bool { Self.loginEnabled }

    @objc private func toggleLogin() { Self.setLogin(!loginEnabled) }

    static func setLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            let a = NSAlert()
            a.messageText = "Couldn't change Start at Login"
            a.informativeText = "\(error.localizedDescription)\n\nYou can also add Headroom Server in System Settings → General → Login Items."
            a.runModal()
        }
    }

    // ------------------------------------------------------------------ window

    func showWindow(_ section: String) {
        if settings == nil {
            settings = SettingsWindow { [weak self] done in self?.startServer(done) }
            settings?.installUpdate = { [weak self] in self?.restartToUpdate() }
            settings?.onClose = { [weak self] in self?.updateDockIcon(windowOpen: false) }
        }
        settings?.show(section)
    }
}
