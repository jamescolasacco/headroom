import Foundation
import NIOCore
import NIOHTTP1

/// All HTTP endpoints — the same API as the Windows host (docs/PROTOCOL.md §6), so the web client and the
/// settings page work unchanged against either.
public final class WebHost: HttpApp {
    let certs: CertificateManager
    private let pendingTotp = Locked<String?>(nil)

    public init(certs: CertificateManager) {
        self.certs = certs
    }

    // ------------------------------------------------------------------ HttpApp

    public func beginStreaming(_ req: HttpRequest) -> HttpStreamDecision? {
        guard req.method == .POST, req.path == "/api/files/upload" else { return nil }
        if !req.isTLS && !req.isLoopback { return .respond(redirectToHttps(req)) }
        return FileApi.beginUpload(req)
    }

    public func shouldUpgradeWebSocket(path: String, remoteIP: String?, isTLS: Bool) -> Bool {
        path == "/ws" && (isTLS || NetInterfaces.isLoopback(remoteIP))
    }

    public func webSocketHandler(remoteIP: String?, isTLS: Bool) -> ChannelHandler {
        WebSocketTransport(remoteIP: remoteIP, isTLS: isTLS) { ClientSession(transport: $0) }
    }

    public func decorate(_ req: HttpRequest, _ resp: inout HttpResponse) {
        let h = resp.headers
        var out = h
        out.replaceOrAdd(name: "X-Content-Type-Options", value: "nosniff")
        out.replaceOrAdd(name: "Referrer-Policy", value: "no-referrer")
        out.replaceOrAdd(name: "X-Frame-Options", value: "DENY")
        if req.path.hasPrefix("/api/admin") {
            out.replaceOrAdd(name: "Cache-Control", value: "no-store") // never CORS: see adminAllowed
        } else if req.path.hasPrefix("/api") {
            out.replaceOrAdd(name: "Cache-Control", value: "no-store")
            out.replaceOrAdd(name: "Access-Control-Allow-Origin", value: "*")
            out.replaceOrAdd(name: "Access-Control-Allow-Headers", value: "Authorization, Content-Type")
            out.replaceOrAdd(name: "Access-Control-Allow-Methods", value: "GET, POST, DELETE, OPTIONS")
            out.replaceOrAdd(name: "Access-Control-Max-Age", value: "600")
            if req.headers.contains(name: "Access-Control-Request-Private-Network") {
                out.replaceOrAdd(name: "Access-Control-Allow-Private-Network", value: "true")
            }
        }
        resp.headers = out
    }

    private func redirectToHttps(_ req: HttpRequest) -> HttpResponse {
        let host = req.hostName.contains(":") ? "[\(req.hostName)]" : req.hostName
        return .redirect("https://\(host):\(ConfigStore.current.port)\(req.uri)")
    }

    public func handle(_ req: HttpRequest) -> HttpResponse {
        var path = req.path
        if !req.isTLS && !req.isLoopback {
            // Plain-HTTP helper port, remote caller: only the CA bootstrap is available.
            guard ["/", "/trust", "/headroom-ca.crt", "/headroom-ca.mobileconfig", "/trust.css"].contains(path) else { return redirectToHttps(req) }
            if path == "/" { path = "/trust" }
        }
        if path.hasPrefix("/api/admin") {
            guard adminAllowed(req) else { return .json(["error": "admin API is only available on the host itself"], status: .forbidden) }
            return admin(req, String(path.dropFirst("/api/admin".count)))
        }
        if path.hasPrefix("/api"), req.method == .OPTIONS { return .status(.noContent) }

        switch (req.method, path) {
        // -------------------------------------------------------------- public
        case (.GET, "/api/info"):
            let c = ConfigStore.current
            return .json(["host": HostInfo.describe(), "paired": AuthService.hasPassword, "totp": c.totpEnabled, "port": c.port,
                          "tailscale": certs.tailscaleName as Any?, "loopback": req.isLoopback])
        case (.POST, "/api/pair"):
            return pair(req)
        case (.GET, "/api/me"):
            guard let dev = AuthService.validateToken(req.bearerToken, ip: req.remoteIP, touch: false) else {
                return .json(["error": "unauthorized"], status: .unauthorized)
            }
            return .json(["device": ["id": dev.id, "name": dev.name], "host": HostInfo.describe()])
        case (.GET, "/headroom-ca.crt"):
            var h = HTTPHeaders()
            h.add(name: "Content-Type", value: "application/x-x509-ca-cert")
            h.add(name: "Content-Disposition", value: "attachment; filename=\"headroom-ca.crt\"")
            return HttpResponse(headers: h, body: .bytes(certs.caCertificateDer))
        case (.GET, "/headroom-ca.mobileconfig"):
            var h = HTTPHeaders()
            h.add(name: "Content-Type", value: "application/x-apple-aspen-config")
            let fname = "Headroom-\(HostInfo.localHostName).mobileconfig"
            h.add(name: "Content-Disposition", value: "attachment; filename=\"\(fname)\"")
            return HttpResponse(headers: h, body: .bytes([UInt8](certs.buildMobileConfig())))
        case (.GET, "/trust"):
            return .text(TrustPage.render(req, certs: certs), contentType: "text/html; charset=utf-8")

        // -------------------------------------------------------------- files
        case (.GET, "/api/files/list"): return FileApi.list(req)
        case (.GET, "/api/files/download"): return FileApi.download(req) // GET only: redeeming spends the single-use token
        case (.POST, "/api/files/mkdir"): return FileApi.mkdir(req)

        default:
            break
        }

        if path == "/ws" { return .status(.badRequest) }
        if path.hasPrefix("/api") { return .status(.notFound) }
        if req.method == .GET || req.method == .HEAD { return StaticFiles.serve(path, req) }
        return .status(.methodNotAllowed)
    }

    /// The admin API is for this Mac's own settings window, CLI and browser — not for web pages. A loopback peer
    /// isn't enough: any page open in a local browser can send requests to 127.0.0.1. So also require:
    ///  * a loopback Host header (defeats DNS rebinding: evil.example resolving to 127.0.0.1);
    ///  * no foreign Origin and no cross-site Sec-Fetch-Site (defeats plain cross-site requests, including
    ///    "simple" text/plain POSTs that need no CORS preflight);
    ///  * no CORS at all on /api/admin, and preflights refused, so other origins can't read responses.
    private func adminAllowed(_ req: HttpRequest) -> Bool {
        guard req.isLoopback, req.method != .OPTIONS else { return false }
        let loopbackNames: Set<String> = ["localhost", "127.0.0.1", "::1"]
        guard loopbackNames.contains(req.hostName.lowercased()) else { return false }
        if let origin = req.headers.first(name: "origin"), origin != "null" {
            guard let host = URLComponents(string: origin)?.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
                  loopbackNames.contains(host) else { return false }
        } else if req.headers.first(name: "origin") == "null" {
            return false
        }
        if let site = req.headers.first(name: "sec-fetch-site")?.lowercased(), site != "same-origin", site != "none" { return false }
        return true
    }

    private func pair(_ req: HttpRequest) -> HttpResponse {
        let body = req.json
        let (result, token, device) = AuthService.pair(ip: req.remoteIP, password: body.str("password"), totp: body.str("totp"),
                                                       pairCode: body.str("code"), deviceName: body.str("deviceName") ?? "Device")
        switch result {
        case .ok:
            return .json(["token": token ?? "", "device": ["id": device?.id ?? "", "name": device?.name ?? ""], "host": HostInfo.describe()])
        case .totpRequired:
            return .json(["error": "totp-required"], status: .unauthorized)
        case .rateLimited:
            return .json(["error": "rate-limited", "retryAfter": Int(AuthService.retryAfter(req.remoteIP) ?? 60)], status: .tooManyRequests)
        case .notConfigured:
            return .json(["error": "not-configured", "message": "No password is set on this host yet. Use a pairing code, or set a password on the host."], status: .conflict)
        case .badCredentials:
            return .json(["error": "bad-credentials"], status: .unauthorized)
        }
    }

    // ------------------------------------------------------------------ admin (loopback only)

    private func admin(_ req: HttpRequest, _ sub: String) -> HttpResponse {
        let body = req.json
        switch (req.method, sub) {
        case (.GET, "/status"):
            return .json(status())
        case (.POST, "/password"):
            let pw = body.str("password") ?? ""
            guard pw.count >= 8 else { return .json(["error": "Password must be at least 8 characters."], status: .badRequest) }
            try? AuthService.setPassword(pw)
            Log.info("admin", "password changed")
            return .json(["ok": true])
        case (.POST, "/totp/setup"):
            // Two-factor (TOTP) for pairing: setup returns a secret + otpauth URI; it only takes effect once a
            // code from the authenticator app verifies.
            let secret = Totp.newSecret()
            pendingTotp.with { $0 = secret }
            return .json(["secret": secret, "uri": Totp.provisioningUri(secret: secret, account: HostInfo.name)])
        case (.POST, "/totp/enable"):
            guard let secret = pendingTotp.get else { return .json(["error": "Start setup first."], status: .badRequest) }
            guard Totp.verify(secret: secret, code: body.str("code") ?? "") else {
                return .json(["error": "That code didn't match. Check the time on your phone and try the next code."], status: .badRequest)
            }
            pendingTotp.with { $0 = nil }
            ConfigStore.update { $0.totpSecret = secret; $0.totpEnabled = true }
            Log.info("admin", "two-factor pairing enabled")
            return .json(["ok": true])
        case (.POST, "/totp/disable"):
            ConfigStore.update { $0.totpEnabled = false; $0.totpSecret = nil }
            Log.info("admin", "two-factor pairing disabled")
            return .json(["ok": true])
        case (.POST, "/paircode"):
            let code = AuthService.createPairCode(lifetime: 600)
            return .json(["code": code, "expiresInSeconds": 600, "urls": serverUrls().map { "\($0)#pair=\(code)" }])
        case (.POST, "/sessions/disconnect-all"):
            for s in SessionManager.active { s.disconnect("disconnected from the host") }
            return .json(["ok": true])
        case (.POST, "/settings"):
            ConfigStore.update { c in
                if let v = body.boolIfPresent("lockOnDisconnect") { c.lockOnDisconnect = v }
                if let v = body.int("maxFps") { c.video.maxFps = min(max(v, 10), 240) }
                if let v = body.int("maxBitrateKbps") { c.video.maxBitrateKbps = min(max(v, 1000), 200_000) }
                if let v = body.str("encoder"), ["auto", "hardware", "software"].contains(v) { c.video.encoder = v }
                if let v = body.boolIfPresent("audio") { c.audio.enabled = v }
                if let v = body.boolIfPresent("clipboard") { c.permissions.clipboard = v }
                if let v = body.boolIfPresent("fileTransfer") { c.permissions.fileTransfer = v }
                if let v = body.boolIfPresent("input") { c.permissions.input = v }
                if let v = body.boolIfPresent("notifyOnConnect") { c.notifyOnConnect = v }
                if body["displayName"] != nil {
                    let n = body.str("displayName")?.trimmingCharacters(in: .whitespaces) ?? ""
                    c.displayName = n.isEmpty ? nil : n
                }
            }
            return .json(["ok": true])
        case (.POST, "/permissions/request"):
            // Shows the macOS prompt (or, once declined, the user must use System Settings).
            switch body.str("kind") {
            case "screen": DispatchQueue.main.async { Permissions.requestScreenRecording() }
            case "accessibility": DispatchQueue.main.async { Permissions.requestAccessibility() }
            default: return .json(["error": "unknown permission"], status: .badRequest)
            }
            return .json(["ok": true])
        default:
            break
        }
        let parts = sub.split(separator: "/").map(String.init)
        if req.method == .POST, parts.count == 3, parts[0] == "sessions", parts[2] == "disconnect" {
            guard let s = SessionManager.active.first(where: { $0.id == parts[1] }) else { return .status(.notFound) }
            s.disconnect("disconnected from the host")
            return .json(["ok": true])
        }
        if parts.count == 2, parts[0] == "devices", req.method == .DELETE {
            let ok = AuthService.revokeDevice(parts[1])
            SessionManager.disconnectDevice(parts[1])
            return ok ? .json(["ok": true]) : .status(.notFound)
        }
        if parts.count == 3, parts[0] == "devices", parts[2] == "viewonly", req.method == .POST {
            let viewOnly = body.bool("viewOnly")
            ConfigStore.update { c in if let i = c.devices.firstIndex(where: { $0.id == parts[1] }) { c.devices[i].viewOnly = viewOnly } }
            return .json(["ok": true])
        }
        return .status(.notFound)
    }

    func status() -> JSONObject {
        let c = ConfigStore.current
        return [
            "host": HostInfo.describe(),
            "hasPassword": c.password != nil,
            "totpEnabled": c.totpEnabled,
            "port": c.port,
            "urls": serverUrls(),
            "tailscale": certs.tailscaleName as Any?,
            "devices": c.devices.map(\.adminJson),
            "sessions": SessionManager.active.map { s -> JSONObject in
                ["id": s.id, "device": s.device?.name as Any?, "deviceId": s.device?.id as Any?, "remoteAddress": s.remoteAddress, "connectedAt": s.connectedAt]
            },
            "elevated": false,
            "serviceInstalled": false,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "httpPort": c.httpHelperPort,
            "lanAddresses": NetInterfaces.ipv4Addresses(),
            "dataDir": Paths.dataDir,
            "logDir": Paths.logDir,
            "caThumbprint": certs.caThumbprint,
            "serverKeyFingerprint": certs.serverKeyFingerprint,
            "permissions": Permissions.json,
            "testPattern": Displays.testPatternSize != nil,
            "settings": [
                "video": c.video.json, "audio": c.audio.json, "permissions": c.permissions.json,
                "lockOnDisconnect": c.lockOnDisconnect, "displayName": c.displayName as Any?, "notifyOnConnect": c.notifyOnConnect,
            ] as JSONObject,
        ]
    }

    public func serverUrls() -> [String] {
        let port = ConfigStore.current.port
        var urls = [String]()
        if let ts = certs.tailscaleName { urls.append("https://\(ts):\(port)/") }
        urls.append("https://\(HostInfo.localHostName.lowercased()).local:\(port)/")
        for ip in NetInterfaces.ipv4Addresses() { urls.append("https://\(ip):\(port)/") }
        return urls
    }
}

/// The static client (no-cache = always revalidate, so updates land immediately; the service worker
/// provides offline start). Unknown non-API paths fall back to index.html (SPA).
enum StaticFiles {
    static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml", "png": "image/png", "ico": "image/x-icon", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "wasm": "application/wasm", "txt": "text/plain; charset=utf-8", "mobileconfig": "application/x-apple-aspen-config",
        "woff2": "font/woff2",
    ]

    static func serve(_ path: String, _ req: HttpRequest) -> HttpResponse {
        let root = URL(fileURLWithPath: Paths.webRoot).standardizedFileURL
        var rel = path
        if rel.hasSuffix("/") { rel += "index.html" }
        var file = root.appendingPathComponent(String(rel.drop { $0 == "/" })).standardizedFileURL
        var isDir: ObjCBool = false
        let fm = FileManager.default
        let inside = file.path == root.path || file.path.hasPrefix(root.path + "/")
        if !inside || !fm.fileExists(atPath: file.path, isDirectory: &isDir) || isDir.boolValue {
            if inside, isDir.boolValue, fm.fileExists(atPath: file.appendingPathComponent("index.html").path) {
                file = file.appendingPathComponent("index.html")
            } else if (path as NSString).pathExtension.isEmpty {
                file = root.appendingPathComponent("index.html") // SPA fallback
            } else {
                return .status(.notFound)
            }
        }
        guard let attrs = try? fm.attributesOfItem(atPath: file.path), let data = fm.contents(atPath: file.path) else { return .status(.notFound) }
        let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let etag = "\"\(String(Int(mtime * 1000), radix: 36))-\(String(data.count, radix: 36))\""
        var h = HTTPHeaders()
        h.add(name: "Cache-Control", value: "no-cache")
        h.add(name: "ETag", value: etag)
        h.add(name: "Content-Type", value: types[file.pathExtension.lowercased()] ?? "application/octet-stream")
        if file.lastPathComponent == "sw.js" { h.add(name: "Service-Worker-Allowed", value: "/") }
        if req.headers.first(name: "if-none-match") == etag { return HttpResponse(status: .notModified, headers: h) }
        return HttpResponse(status: .ok, headers: h, body: .bytes([UInt8](data)))
    }
}
