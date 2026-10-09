import Foundation
import WebKit

/// Serves the bundled web client at headroom://app.headroom.local/. WebKit treats the custom scheme as a
/// secure context, so WebCodecs, AudioWorklet and crypto work exactly as on HTTPS, and the hostname matches
/// the Windows viewer's, so the client recognises it is running inside Headroom Viewer.
final class ClientScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "headroom"
    static let host = "app.headroom.local"
    static var startUrl: URL { URL(string: "\(scheme)://\(host)/index.html")! }

    /// Contents/Resources/client, or HEADROOM_CLIENT (development: point it at the repo's web/ folder).
    static let folder: URL = {
        if let d = ProcessInfo.processInfo.environment["HEADROOM_CLIENT"], !d.isEmpty { return URL(fileURLWithPath: d) }
        if let r = Bundle.main.resourceURL?.appendingPathComponent("client"), FileManager.default.fileExists(atPath: r.appendingPathComponent("index.html").path) { return r }
        // `swift run` from a checkout: walk up to the repo's web/ folder.
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            let c = dir.appendingPathComponent("web")
            if FileManager.default.fileExists(atPath: c.appendingPathComponent("index.html").path) { return c }
            dir.deleteLastPathComponent()
        }
        return Bundle.main.resourceURL?.appendingPathComponent("client") ?? URL(fileURLWithPath: "client")
    }()

    private static let types: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "json": "application/json",
        "webmanifest": "application/manifest+json", "svg": "image/svg+xml", "png": "image/png", "ico": "image/x-icon", "wasm": "application/wasm",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == Self.host else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        if path.hasSuffix("/") { path += "index.html" }
        let root = Self.folder.standardizedFileURL
        var file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        if !file.path.hasPrefix(root.path + "/") { task.didFailWithError(URLError(.noPermissionsToReadFile)); return }
        if !FileManager.default.fileExists(atPath: file.path) {
            // SPA fallback, like the hosts.
            if file.pathExtension.isEmpty { file = root.appendingPathComponent("index.html") } else {
                let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
                task.didReceive(resp)
                task.didFinish()
                return
            }
        }
        guard let data = try? Data(contentsOf: file) else { task.didFailWithError(URLError(.cannotOpenFile)); return }
        let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let headers = ["Content-Type": type.hasPrefix("text/") || type.hasSuffix("json") ? "\(type); charset=utf-8" : type,
                       "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
