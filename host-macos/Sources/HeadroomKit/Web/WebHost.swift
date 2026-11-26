import Foundation
import NIOCore
import NIOHTTP1

/// All HTTP endpoints — the same API as the Windows host (docs/PROTOCOL.md §6). To the network (Headroom Viewer on
/// the same network, and the relay) only sessions and file transfer; the settings window and its API only on this
/// Mac's loopback.
public final class WebHost: HttpApp {
    let certs: CertificateManager

    public init(certs: CertificateManager) {
        self.certs = certs
    }

    // ------------------------------------------------------------------ HttpApp

    public func beginStreaming(_ req: HttpRequest) -> HttpStreamDecision? {
        guard req.method == .POST, req.path == "/api/files/upload" else { return nil }
        guard req.isTLS || req.isLoopback || (req.isRelayed && !req.isGuest) else { return .respond(.status(.forbidden)) }
        if ServerSwitch.shared.stopped { return .respond(.json(["error": "stopped"], status: .serviceUnavailable)) }
        return FileApi.beginUpload(req)
    }

    /// No sessions while the server is stopped (see ServerSwitch): the request then gets a 503 from handle().
    public func shouldUpgradeWebSocket(path: String, remoteIP: String?, isTLS: Bool, relayed: Bool) -> Bool {
        path == "/ws" && !ServerSwitch.shared.stopped && (isTLS || relayed || NetInterfaces.isLoopback(remoteIP))
    }

    public func webSocketHandler(remoteIP: String?, isTLS: Bool, relayed: Bool, guest: Bool, country: String?) -> ChannelHandler {
        WebSocketTransport(remoteIP: remoteIP, isTLS: isTLS, relayed: relayed, guest: guest, country: country) { ClientSession(transport: $0) }
    }

    /// What the network may reach: sessions and their file transfers (the relay forwards nothing else either;
    /// this is the second lock). With a guest code, before being accepted: only this computer's name and the session.
    static func networkAllows(_ path: String, guest: Bool) -> Bool {
        if guest { return path == "/api/info" }
        return path == "/api/info" || path == "/api/me" || ["/api/files/list", "/api/files/download", "/api/files/upload", "/api/files/mkdir"].contains(path)
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

    public func handle(_ req: HttpRequest) -> HttpResponse {
        let path = req.path
        // Stopped: nothing for the network, and no sessions here either; the settings window works as usual.
        if ServerSwitch.shared.stopped && (!req.isLoopback || path == "/ws") {
            return .json(["error": "stopped", "message": "Headroom Server is stopped on this computer."], status: .serviceUnavailable)
        }
        if !req.isLoopback {
            if req.method == .OPTIONS, path.hasPrefix("/api") { return .status(.noContent) }
            guard Self.networkAllows(path, guest: req.isGuest), req.isTLS || req.isRelayed else { return .json(["error": "not-available"], status: .forbidden) }
        }
        if path.hasPrefix("/api/admin") {
            guard adminAllowed(req) else { return .json(["error": "admin API is only available on the host itself"], status: .forbidden) }
            return admin(req, String(path.dropFirst("/api/admin".count)))
        }
        if path.hasPrefix("/api"), req.method == .OPTIONS { return .status(.noContent) }

        switch (req.method, path) {
        case (.GET, "/api/info"):
            return .json(["host": HostInfo.describe()])
        case (.GET, "/api/me"):
            guard let dev = AuthService.validateToken(req.bearerToken, ip: req.remoteIP, touch: false) else {
                return .json(["error": "unauthorized"], status: .unauthorized)
            }
            return .json(["device": ["id": dev.id, "name": dev.name], "host": HostInfo.describe()])
        case (.GET, "/api/files/list"): return FileApi.list(req)
        case (.GET, "/api/files/download"): return FileApi.download(req) // GET only: redeeming spends the single-use token
        case (.POST, "/api/files/mkdir"): return FileApi.mkdir(req)
        default:
            break
        }

        if path == "/ws" { return .status(.badRequest) }
        if path.hasPrefix("/api") { return .status(.notFound) }
        // The settings window (this Mac only).
        if req.method == .GET || req.method == .HEAD { return StaticFiles.serve(path == "/" ? "/admin.html" : path, req) }
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

    // ------------------------------------------------------------------ admin (loopback only)

    private func admin(_ req: HttpRequest, _ sub: String) -> HttpResponse {
        let body = req.json
        switch (req.method, sub) {
        case (.GET, "/status"):
            return .json(status())
        case (.POST, "/server/stop"):
            ServerSwitch.shared.stop()
            return .json(["ok": true])
        case (.POST, "/server/start"):
            ServerSwitch.shared.start()
            return .json(["ok": true])
        case (.POST, "/sessions/disconnect-all"):
            SupportService.shared.revokeAll()
            for s in SessionManager.active { s.disconnect("stopped by the person at the computer") }
            return .json(["ok": true])
        case (.POST, "/support/code"):
            // "Let someone connect": a 9-digit code, and a link with it.
            if ServerSwitch.shared.stopped {
                return .json(["error": "stopped", "message": "Headroom Server is stopped. Start it, then create a code."], status: .conflict)
            }
            let done = DispatchSemaphore(value: 0)
            var out: HttpResponse = .status(.internalServerError)
            SupportService.shared.createCode { result in
                switch result {
                case .success(let c): out = .json(["code": c.code, "expiresAt": c.expires, "link": c.link])
                case .failure(let e): out = .json(["error": "unavailable", "message": e.description], status: .serviceUnavailable)
                }
                done.signal()
            }
            _ = done.wait(timeout: .now() + 12)
            return out
        case (.DELETE, "/support/code"):
            SupportService.shared.cancelCode()
            return .json(["ok": true])
        case (.POST, "/settings"):
            var rightsChanged = false
            ConfigStore.update { c in
                if let v = body.boolIfPresent("lockOnDisconnect") { c.lockOnDisconnect = v }
                if let v = body.int("maxFps") { c.video.maxFps = min(max(v, 10), 240) }
                if let v = body.int("maxBitrateKbps") { c.video.maxBitrateKbps = min(max(v, 1000), 200_000) }
                if let v = body.str("encoder"), ["auto", "hardware", "software"].contains(v) { c.video.encoder = v }
                if let v = body.boolIfPresent("audio") { c.audio.enabled = v; rightsChanged = true } // sound stops for running sessions too
                if let v = body.boolIfPresent("clipboard") { c.permissions.clipboard = v; rightsChanged = true }
                if let v = body.boolIfPresent("fileTransfer") { c.permissions.fileTransfer = v; rightsChanged = true }
                if let v = body.boolIfPresent("input") { c.permissions.input = v; rightsChanged = true }
                if let v = body.boolIfPresent("notifyOnConnect") { c.notifyOnConnect = v }
                if body["displayName"] != nil {
                    let n = String((body.str("displayName") ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
                    c.displayName = n.isEmpty ? nil : n
                }
                // Another Headroom server (self-hosting, testing); takes effect for the next sign-in and the relay.
                if let v = body.str("server") { c.server = AccountService.normalizeServer(v) ?? HostConfig.defaultServer }
            }
            if rightsChanged { SessionManager.rightsChanged() }
            if body["displayName"] != nil { DispatchQueue.global().async { AccountService.shared.sync() } } // the new name, in the account now
            return .json(["ok": true])
        case (.POST, "/account/join"):
            // The password goes to Headroom only; this computer keeps its own sign-in there.
            switch AccountService.shared.join(email: body.str("email") ?? "", password: body.str("password") ?? "", totp: body.str("totp")) {
            case .success(let email): return .json(["ok": true, "email": email])
            case .failure(let e):
                let status: HTTPResponseStatus = e.code == "bad-credentials" || e.code == "totp-required" || e.code == "bad-totp" ? .unauthorized : .badRequest
                return .json(["error": e.code, "message": e.description], status: status)
            }
        case (.POST, "/account/leave"):
            AccountService.shared.leave()
            return .json(["ok": true])
        case (.POST, "/account/sync"):
            return .json(["ok": AccountService.shared.sync()])
        case (.GET, "/test-input"), (.POST, "/test-input/reset"):
            // Test input (HEADROOM_TEST_INPUT with the test pattern): what reached the "app in front" instead of this Mac.
            guard TestInput.enabled else {
                return .json(["error": "test-input-off", "message": "Start the engine with HEADROOM_TEST_INPUT=<file.jsonl> and --test-pattern."], status: .notFound)
            }
            if req.method == .POST { TestInput.shared.reset() }
            return .json(TestInput.shared.state)
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
            // A guest's access ends for good: it may not come back with its resume key.
            if let id = s.device?.id, id.hasPrefix("guest:") { SupportService.shared.revoke(id) }
            s.disconnect("stopped by the person at the computer")
            return .json(["ok": true])
        }
        if req.method == .POST, parts.count == 3, parts[0] == "sessions", parts[2] == "rights" {
            // A guest's control, files and clipboard, changed while connected.
            guard let s = SessionManager.active.first(where: { $0.id == parts[1] }), let id = s.device?.id, id.hasPrefix("guest:") else { return .status(.notFound) }
            SupportService.shared.setRights(id, input: body.boolIfPresent("input"), files: body.boolIfPresent("files"), clipboard: body.boolIfPresent("clipboard"))
            return .json(["ok": true])
        }
        if req.method == .POST, parts.count == 3, parts[0] == "support", parts[1] == "requests" {
            let ok = SupportService.shared.decide(id: parts[2], accept: body.bool("accept"), viewOnly: body.bool("viewOnly"),
                                                  files: body.bool("files"), clipboard: body.bool("clipboard"))
            return ok ? .json(["ok": true]) : .json(["error": "That request is no longer waiting."], status: .notFound)
        }
        return .status(.notFound)
    }

    func status() -> JSONObject {
        let c = ConfigStore.current
        return [
            "host": HostInfo.describe(),
            "port": c.port,
            "sessions": SessionManager.active.filter { $0.device != nil }.map { s -> JSONObject in
                [
                    "id": s.id, "device": s.device?.name as Any?, "deviceId": s.device?.id as Any?,
                    "guest": s.rights.guest, "remoteAddress": s.remoteAddress, "country": s.country as Any?,
                    "connectedAt": s.connectedAt, "rights": s.rights.json,
                ]
            },
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "stopped": ServerSwitch.shared.stopped, // "Stop server": nobody can connect (ServerSwitch)
            "lanAddresses": NetInterfaces.ipv4Addresses(),
            "dataDir": Paths.dataDir,
            "logDir": Paths.logDir,
            "permissions": Permissions.json,
            "testPattern": Displays.testPatternSize != nil,
            "testInput": TestInput.logPath as Any?,
            "account": AccountService.shared.statusJson as Any?,
            "relay": RelayService.shared.statusJson,
            "support": SupportService.shared.statusJson,
            "settings": [
                "video": c.video.json, "audio": c.audio.json, "permissions": c.permissions.json,
                "lockOnDisconnect": c.lockOnDisconnect, "displayName": c.displayName as Any?, "notifyOnConnect": c.notifyOnConnect,
                "server": c.server,
            ] as JSONObject,
        ]
    }

    /// How Headroom Viewer on the same network reaches this Mac directly (reported to the account).
    public func serverUrls() -> [String] {
        let port = ConfigStore.current.port
        var urls = [String]()
        if let ts = certs.tailscaleName { urls.append("https://\(ts):\(port)/") }
        urls.append("https://\(HostInfo.localHostName.lowercased()).local:\(port)/")
        for ip in NetInterfaces.ipv4Addresses() { urls.append("https://\(ip):\(port)/") }
        return urls
    }
}

/// The settings window's files (no-cache = always revalidate, so updates land immediately).
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
