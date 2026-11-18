import AppKit
import HeadroomUpdate
import WebKit

/// The "Headroom Server" window: the settings panel (served by the engine at /admin.html) in a WKWebView,
/// inside a native window. Closing it only hides it — the menu-bar icon keeps running.
final class SettingsWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let window: NSWindow
    private let web: WKWebView
    private let startServer: (@escaping (Bool) -> Void) -> Void
    private var onAdminPage = false
    private var pendingSection = "home"
    var onClose: (() -> Void)?
    /// "Restart to update" in the page (the app asks first if someone is connected).
    var installUpdate: (() -> Void)?

    init(startServer: @escaping (@escaping (Bool) -> Void) -> Void) {
        self.startServer = startServer
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        let content = WKUserContentController()
        cfg.userContentController = content
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 960, height: 680), configuration: cfg)
        web.setValue(false, forKey: "drawsBackground") // no white flash before the page paints
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 680),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        content.add(WeakHandler(self), name: "headroom")
        web.navigationDelegate = self
        web.uiDelegate = self
        window.title = "Headroom Server"
        window.contentView = web
        window.minSize = NSSize(width: 560, height: 420)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.backgroundColor = NSColor(name: nil) { a in
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0.035, green: 0.043, blue: 0.063, alpha: 1) : NSColor(srgbRed: 0.933, green: 0.945, blue: 0.961, alpha: 1)
        }
        window.setFrameAutosaveName("HeadroomServerSettings")
        if !window.setFrameUsingName("HeadroomServerSettings") { window.center() }
    }

    func show(_ section: String) {
        navigate(section)
        NSApp.setActivationPolicy(.regular) // a Dock icon while the window is open, like any app window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Show a section ("home", "connect", "account", "settings").
    func navigate(_ section: String, reload: Bool = false) {
        pendingSection = section
        if onAdminPage && !reload {
            let json = String(data: try! JSONSerialization.data(withJSONObject: ["cmd": "navigate", "section": section]), encoding: .utf8)!
            web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('headroom-native', { detail: \(json) }))")
            return
        }
        if let url = URL(string: "\(AdminClient.baseUrl)/admin.html#\(section)") { web.load(URLRequest(url: url)) }
    }

    private func sendToPage(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('headroom-native', { detail: \(json) }))")
    }

    /// The updater's state, for the page's update line (Settings) and banner (Home).
    func sendUpdate(_ s: Updater.State) {
        if onAdminPage { sendToPage(s.json) }
    }

    func reloadIfOffline() {
        if !onAdminPage { navigate(pendingSection, reload: true) }
    }

    func showOffline() {
        onAdminPage = false
        web.loadHTMLString(Self.offlineHtml, baseURL: nil)
    }

    // ------------------------------------------------------------------ page -> native

    func userContentController(_ u: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "openFolder":
            if let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) {
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            }
        case "copy":
            if let text = body["text"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        case "openUrl":
            if let s = body["url"] as? String, let u = URL(string: s), ["x-apple.systempreferences", "https", "http"].contains(u.scheme ?? "") {
                NSWorkspace.shared.open(u)
            }
        case "startServer":
            startServer { [weak self] ok in if ok { self?.navigate(self?.pendingSection ?? "home", reload: true) } }
        case "getLoginItem":
            sendToPage(["cmd": "loginItem", "enabled": AppDelegate.loginEnabled])
        case "loginItem":
            AppDelegate.setLogin(body["enabled"] as? Bool ?? false)
            sendToPage(["cmd": "loginItem", "enabled": AppDelegate.loginEnabled])
        case "getUpdate":
            sendToPage(Updater.shared.state.json)
        case "checkUpdate":
            Updater.shared.check(userInitiated: true)
        case "installUpdate":
            installUpdate?()
        default:
            break
        }
    }

    // ------------------------------------------------------------------ navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onAdminPage = webView.url?.path.hasSuffix("/admin.html") == true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let local = url.host == "127.0.0.1" || url.host == "localhost"
        // Anything off this Mac (the Headroom website: create an account, forgot password) opens in the browser.
        if action.navigationType == .linkActivated && !local || url.scheme == "x-apple.systempreferences" {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    // ------------------------------------------------------------------ window

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        onClose?()
    }

    private static let offlineHtml = """
<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
<style>
:root{--room:#090b10;--ink:#eef1f6;--ink2:#aab2c0;--rim:rgba(255,255,255,.11);--off-a:#0f1218;--off-b:#171b24;--primary:#eef4ff;--on-primary:#0a0d14}
@media (prefers-color-scheme: light){:root{--room:#eef1f5;--ink:#0c0f15;--ink2:#454c59;--rim:rgba(12,15,21,.09);--off-a:#cdd3dc;--off-b:#dce1e8;--primary:#0c0f15;--on-primary:#fff}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--room);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:420px;text-align:center;padding:24px}
.screen{width:220px;aspect-ratio:16/10;margin:0 auto 24px;border-radius:12px;background:linear-gradient(118deg,var(--off-a) 0 44%,var(--off-b) 50%,var(--off-a) 57%);box-shadow:inset 0 0 0 1px var(--rim)}
h1{font-size:21px;margin:0 0 6px;letter-spacing:-.01em}p{color:var(--ink2);margin:0 0 20px}
button{background:var(--primary);color:var(--on-primary);border:0;border-radius:10px;padding:11px 20px;font:600 15px -apple-system,system-ui;cursor:pointer}
</style></head><body><main><div class="screen"></div>
<h1>The Headroom server isn't running</h1>
<p>Other devices can't connect until it's started.</p>
<button onclick="webkit.messageHandlers.headroom.postMessage({cmd:'startServer'})">Start server</button>
</main></body></html>
"""
}

/// WKUserContentController retains its handlers; this breaks the cycle with the window controller.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(u, didReceive: m) }
}
