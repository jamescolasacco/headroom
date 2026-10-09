import AppKit
import UniformTypeIdentifiers
import WebKit

/// A Headroom Viewer window: the bundled web client in a WKWebView, plus the native pieces a browser can't
/// do — certificate trust per computer, system-shortcut capture, WebCodecs audio, downloads and windows.
final class ViewerWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    let window: NSWindow
    private(set) var web: WKWebView!
    private var titleObservation: NSKeyValueObservation?
    private(set) var sessionActive = false
    private(set) var sessionHost: String?
    var onClose: ((ViewerWindow) -> Void)?

    init(url: URL) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        window.title = "Headroom Viewer"
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua) // the viewer frames a remote desktop: always dark
        window.backgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.067, alpha: 1)
        window.minSize = NSSize(width: 480, height: 360)
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.tabbingMode = .disallowed

        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(ClientScheme(), forURLScheme: ClientScheme.scheme)
        cfg.websiteDataStore = .default() // the address book lives in this origin's localStorage
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.preferences.isElementFullscreenEnabled = true
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        Self.enableWebKitFeatures(cfg.preferences, ["WebCodecsAudioEnabled", "FullScreenKeyboardLock"])
        cfg.userContentController.add(WeakHandler(self), name: "headroom")
        if ProcessInfo.processInfo.environment["HEADROOM_DEVTOOLS"] == "1" { cfg.preferences.setValue(true, forKey: "developerExtrasEnabled") }

        let web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.allowsMagnification = false
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = self
        web.uiDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = ProcessInfo.processInfo.environment["HEADROOM_DEVTOOLS"] == "1" }
        window.contentView = web
        self.web = web
        titleObservation = web.observe(\.title) { [weak self] w, _ in
            let t = (w.title ?? "").replacingOccurrences(of: "— Headroom", with: "— Headroom Viewer")
            self?.window.title = t.isEmpty ? "Headroom Viewer" : t
        }
        web.load(URLRequest(url: url))
    }

    /// WebCodecs' AudioDecoder (the Opus stream) is off by default in WKWebView; turn on WebKit's own switch.
    private static func enableWebKitFeatures(_ prefs: WKPreferences, _ keys: [String]) {
        let sel = NSSelectorFromString("_features")
        guard let m = class_getClassMethod(WKPreferences.self, sel) else { return }
        typealias Features = @convention(c) (AnyClass, Selector) -> NSArray
        let all = unsafeBitCast(method_getImplementation(m), to: Features.self)(WKPreferences.self, sel)
        let setSel = NSSelectorFromString("_setEnabled:forFeature:")
        guard prefs.responds(to: setSel), let imp = prefs.method(for: setSel) else { return }
        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let set = unsafeBitCast(imp, to: SetEnabled.self)
        for f in all {
            let obj = f as AnyObject
            if let key = obj.value(forKey: "key") as? String, keys.contains(key) { set(prefs, setSel, true, obj) }
        }
    }

    func show() {
        if let key = NSApp.keyWindow, key !== window {
            window.setFrameTopLeftPoint(NSPoint(x: key.frame.minX + 28, y: key.frame.maxY - 28))
        } else {
            window.center()
        }
        window.makeKeyAndOrderFront(nil)
    }

    func navigate(_ url: URL) { web.load(URLRequest(url: url)) }

    /// Native -> page: a 'headroom-native' event (see web/js/platform.js).
    func post(_ msg: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: msg), let json = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('headroom-native', { detail: \(json) }))")
    }

    // ------------------------------------------------------------------ page -> native

    func userContentController(_ u: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only our own client, in the top frame, may drive the native side.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == ClientScheme.scheme,
              message.frameInfo.securityOrigin.host == ClientScheme.host else { return }
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "trustHost":
            trustHost(body["url"] as? String ?? "")
        case "session":
            sessionActive = body["active"] as? Bool ?? false
            sessionHost = body["host"] as? String
            updateShortcutCapture()
        case "newWindow":
            if let s = body["url"] as? String, let u = URL(string: s), u.scheme == ClientScheme.scheme { AppDelegate.shared.openWindow(u) }
        case "setClipboard":
            if let t = body["text"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(t, forType: .string)
            }
        default:
            break
        }
    }

    // ------------------------------------------------------------------ certificate trust

    /// Every TLS challenge from the page — navigation, fetch, WebSocket — comes through here. Publicly trusted
    /// certificates (Tailscale) pass normally; a Headroom computer's own certificate passes if its key is pinned.
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        Self.answer(challenge, completionHandler)
    }

    func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        Self.answer(challenge, completionHandler)
    }

    static func answer(_ challenge: URLAuthenticationChallenge, _ done: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            return done(.performDefaultHandling, nil)
        }
        if TrustStore.isPinned(host: space.host, trust: trust) {
            done(.useCredential, URLCredential(trust: trust))
        } else {
            done(.performDefaultHandling, nil)
        }
    }

    private func trustHost(_ s: String) {
        guard let url = URL(string: s), url.scheme == "https", let host = url.host else {
            post(["cmd": "trustResult", "url": s, "ok": false, "reason": "Not an HTTPS address."])
            return
        }
        NSCursor.operationNotAllowed.push()
        TrustStore.probe(url) { [weak self] probe in
            DispatchQueue.main.async {
                NSCursor.pop()
                self?.finishTrust(s, url, host, probe)
            }
        }
    }

    private func finishTrust(_ s: String, _ url: URL, _ host: String, _ probe: TrustStore.ProbeResult) {
        if probe.publiclyTrusted {
            post(["cmd": "trustResult", "url": s, "ok": true, "reason": "already-trusted"])
            return
        }
        guard let leaf = probe.leaf else {
            post(["cmd": "trustResult", "url": s, "ok": false, "reason": probe.error ?? "Couldn't read the computer's certificate."])
            return
        }
        let a = NSAlert()
        a.messageText = "Trust this computer?"
        a.informativeText = """
            First connection to \(host).

            It identifies itself as \(TrustStore.subjectName(leaf))\(probe.issuedByHostCa ? ", with a certificate from the Headroom CA this address serves" : "").

            Server key fingerprint:
                \(TrustStore.fingerprint(leaf))

            If this is your computer, Headroom Server → Connection shows the same fingerprint.
            """
        a.addButton(withTitle: "Cancel")
        a.addButton(withTitle: "Trust")
        a.beginSheetModal(for: window) { [weak self] r in
            guard let self else { return }
            guard r == .alertSecondButtonReturn, let spki = TrustStore.spkiHash(leaf) else {
                self.post(["cmd": "trustResult", "url": s, "ok": false, "reason": "declined"])
                return
            }
            TrustStore.add(.init(host: host, spki: spki, fingerprint: TrustStore.fingerprint(leaf), subject: TrustStore.subjectName(leaf), added: Date()))
            // Pins apply to the very next request (no browser restart needed, unlike WebView2): resume adding.
            let origin = "\(url.scheme!)://\(host.contains(":") ? "[\(host)]" : host)\(url.port.map { ":\($0)" } ?? "")"
            var c = URLComponents(url: ClientScheme.startUrl, resolvingAgainstBaseURL: false)!
            c.fragment = "add=\(origin.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? origin)"
            self.navigate(c.url!)
        }
    }

    // ------------------------------------------------------------------ navigation, windows, downloads

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if url.scheme == ClientScheme.scheme || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            return decisionHandler(.allow)
        }
        // Anything else leaving the app (help links, the certificate setup page) opens in the default browser.
        if action.targetFrame?.isMainFrame != false {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).lastPathComponent
        var dest = dir.appendingPathComponent(name.isEmpty ? "download" : name)
        var i = 1
        let stem = dest.deletingPathExtension().lastPathComponent, ext = dest.pathExtension
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(stem) (\(i))" : "\(stem) (\(i)).\(ext)")
            i += 1
        }
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.scheme == ClientScheme.scheme { AppDelegate.shared.openWindow(url) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = false
        p.canChooseFiles = true
        p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page process crashed or was reclaimed: reload rather than show a blank window.
        webView.reload()
    }

    // ------------------------------------------------------------------ system shortcuts

    /// System shortcuts go to the remote only while this window is focused and showing a session.
    func updateShortcutCapture() {
        AppDelegate.shared.updateShortcutCapture()
    }

    var wantsShortcuts: Bool { sessionActive && window.isKeyWindow && NSApp.isActive }

    func windowDidBecomeKey(_ notification: Notification) { updateShortcutCapture() }
    func windowDidResignKey(_ notification: Notification) { updateShortcutCapture() }

    func windowWillClose(_ notification: Notification) {
        sessionActive = false
        titleObservation = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "headroom")
        web.loadHTMLString("", baseURL: nil) // ends the session socket promptly
        onClose?(self)
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with the window.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(u, didReceive: m) }
}
