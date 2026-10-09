import AppKit
import WebKit

/// The "Headroom Server" window: the settings panel (served by the engine at /admin.html) in a WKWebView,
/// inside a native window. Closing it only hides it — the menu-bar icon keeps running.
final class SettingsWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let window: NSWindow
    private let web: WKWebView
    private let startServer: (@escaping (Bool) -> Void) -> Void
    private var onAdminPage = false
    private var pendingSection = "status"
    var onClose: (() -> Void)?

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
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(red: 0.04, green: 0.05, blue: 0.07, alpha: 1) : NSColor(red: 0.96, green: 0.965, blue: 0.97, alpha: 1)
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

    /// Show a settings section ("status", "pair", "devices", ...).
    func navigate(_ section: String, reload: Bool = false) {
        pendingSection = section
        if onAdminPage && !reload {
            let json = String(data: try! JSONSerialization.data(withJSONObject: ["cmd": "navigate", "section": section]), encoding: .utf8)!
            web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('headroom-native', { detail: \(json) }))")
            return
        }
        if let url = URL(string: "\(AdminClient.baseUrl)/admin.html#\(section)") { web.load(URLRequest(url: url)) }
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
            startServer { [weak self] ok in if ok { self?.navigate(self?.pendingSection ?? "status", reload: true) } }
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
        // Certificate downloads and anything off-host open in the default browser.
        if action.navigationType == .linkActivated && (!local || url.path.hasPrefix("/headroom-ca")) || url.scheme == "x-apple.systempreferences" {
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
:root{--bg:#0b0d11;--fg:#e8ebf0;--muted:#8d97a5;--card:#13161c;--line:#262b35;--accent:#5b9dff}
@media (prefers-color-scheme: light){:root{--bg:#f5f6f8;--fg:#141820;--muted:#5d6875;--card:#fff;--line:#dfe3e8;--accent:#1f6feb}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 32px;max-width:440px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 18px}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 18px;font:600 15px -apple-system,system-ui;cursor:pointer}
</style></head><body><div class="card">
<h1>The Headroom server isn't running</h1>
<p>Other devices can't connect until it's started.</p>
<button onclick="webkit.messageHandlers.headroom.postMessage({cmd:'startServer'})">Start server</button>
</div></body></html>
"""
}

/// WKUserContentController retains its handlers; this breaks the cycle with the window controller.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(u, didReceive: m) }
}
