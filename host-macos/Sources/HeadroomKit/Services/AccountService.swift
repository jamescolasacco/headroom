import Foundation

/// Membership in a Headroom account (account-server/, docs/ACCOUNTS.md). When joined, this computer checks in
/// every ~20 s with how to reach it (addresses, certificate pin, CA) and receives the account's devices as
/// (id, name, token hash, view-only). Those devices then connect exactly like paired ones — the token each
/// presents was derived for this computer alone — without any pairing here.
///
/// The device list is cached in the config, so a short account-server outage doesn't lock anyone out; a device
/// removed from the account disappears at the next successful check-in and its sessions are closed.
public final class AccountService {
    public static let shared = AccountService()

    public struct Device: Codable, Equatable {
        public let id: String
        public let name: String
        public let tokenHash: String
        public let viewOnly: Bool
    }

    private let lock = NSLock()
    private var devices: [Device] = []
    private var lastSync: Date?
    private var lastAttempt = Date.distantPast
    private var lastError: String?
    private var interval: TimeInterval = 20
    private var timer: DispatchSourceTimer?
    private weak var certs: CertificateManager?
    private weak var web: WebHost?
    private let syncLock = NSLock()
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 10
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    public var linked: Bool { ConfigStore.current.account != nil }

    public func start(certs: CertificateManager, web: WebHost) {
        self.certs = certs
        self.web = web
        lock.lock()
        devices = ConfigStore.current.account?.devices ?? []
        lock.unlock()
        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in self?.tickIfDue() }
        t.resume()
        timer = t
    }

    private func tickIfDue() {
        guard linked else { return }
        lock.lock()
        let due = Date().timeIntervalSince(lastAttempt) >= interval
        lock.unlock()
        if due { _ = sync() }
    }

    /// The account device presenting this token hash, if any.
    func device(forHash hash: String) -> Device? {
        let h = Array(hash.utf8)
        lock.lock(); defer { lock.unlock() }
        return devices.first { Bytes.constantTimeEquals(Array($0.tokenHash.utf8), h) }
    }

    func device(id: String) -> Device? {
        lock.lock(); defer { lock.unlock() }
        return devices.first { $0.id == id }
    }

    /// For an unknown token: maybe it belongs to a device that signed in to the account seconds ago, so check in
    /// now rather than at the next scheduled time. Unknown tokens cause at most one check-in every 3 s: a request
    /// waits for that window instead of failing, and shares a check-in that started after it asked.
    /// Blocks (≤ ~18 s); callers run on session or request queues, never on the event loop.
    func refreshForUnknownToken() -> Bool {
        guard linked else { return false }
        let asked = Date()
        lock.lock()
        let wait = 3 - asked.timeIntervalSince(lastAttempt)
        lock.unlock()
        if wait > 0 { Thread.sleep(forTimeInterval: min(wait, 3)) }
        return sync(unlessSince: asked)
    }

    // ------------------------------------------------------------------ check-in

    /// One check-in (blocking, ≤ ~15 s). Returns true if the device list was refreshed.
    @discardableResult
    public func sync() -> Bool { sync(unlessSince: nil) }

    /// With `asked`: if a check-in started after that moment (and so has finished, once we hold the lock), its
    /// result is as fresh as a new one would be.
    private func sync(unlessSince asked: Date?) -> Bool {
        syncLock.lock(); defer { syncLock.unlock() }
        if let asked {
            lock.lock()
            let started = lastAttempt, succeeded = (lastSync ?? .distantPast) >= lastAttempt
            lock.unlock()
            if started > asked { return succeeded }
        }
        guard let link = ConfigStore.current.account, let url = URL(string: link.server + "/api/computer/heartbeat") else { return false }
        lock.lock(); lastAttempt = Date(); lock.unlock()
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(link.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = JSON.data(checkInBody())
        let (status, body, err) = send(req)
        if status == 401 {
            // This computer was removed from the account (or the account deleted).
            Log.warn("account", "this computer was removed from the account '\(link.username)'; leaving it")
            unlink(reason: "removed from the account")
            return false
        }
        guard status == 200, let body, let list = body["devices"] as? [JSONObject] else {
            let msg = err ?? "account server answered \(status)"
            lock.lock()
            let first = lastError != msg
            lastError = msg
            lock.unlock()
            if first { Log.warn("account", "check-in failed: \(msg)") }
            return false
        }
        let fresh = list.compactMap { d -> Device? in
            guard let id = d.str("id"), let hash = d.str("tokenHash") else { return nil }
            return Device(id: id, name: d.str("name") ?? "Device", tokenHash: hash, viewOnly: d.bool("viewOnly"))
        }
        if let i = body.int("interval"), i >= 5 { interval = TimeInterval(min(i, 300)) }
        lock.lock()
        let old = devices
        devices = fresh
        lastSync = Date()
        let hadError = lastError != nil
        lastError = nil
        lock.unlock()
        if hadError { Log.info("account", "check-in works again") }
        if old != fresh {
            ConfigStore.update { $0.account?.devices = fresh }
            // Removed devices, and devices that just became view-only, are disconnected (they reconnect view-only).
            let freshById = Dictionary(uniqueKeysWithValues: fresh.map { ($0.id, $0) })
            for d in old {
                let now = freshById[d.id]
                if now == nil || (now!.viewOnly && !d.viewOnly) || now!.tokenHash != d.tokenHash {
                    SessionManager.disconnectDevice(Self.localId(d.id))
                }
            }
        }
        return true
    }

    private func checkInBody() -> JSONObject {
        var o: JSONObject = [
            "hostId": HostInfo.hostId, "name": HostInfo.name, "os": "macos", "osVersion": HostInfo.osVersion, "version": HostInfo.version,
            "urls": web?.serverUrls() ?? [],
        ]
        if let certs {
            o["tailscale"] = certs.tailscaleName as Any?
            o["spki"] = certs.serverSpkiPin
            o["fingerprint"] = certs.serverKeyFingerprint
            o["ca"] = Data(certs.caCertificateDer).base64EncodedString()
        }
        return o
    }

    // ------------------------------------------------------------------ join / leave

    public enum JoinError: Error, CustomStringConvertible {
        case badServer, unreachable(String), rejected(String, String?)
        public var description: String {
            switch self {
            case .badServer: return "Enter the account server's address."
            case .unreachable(let m): return "Can't reach the account server (\(m))."
            case .rejected(let code, let msg): return msg ?? code
            }
        }
        public var code: String {
            switch self {
            case .badServer: return "bad-server"
            case .unreachable: return "unreachable"
            case .rejected(let c, _): return c
            }
        }
    }

    public static func normalizeServer(_ s: String) -> String? {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        if !t.lowercased().hasPrefix("http://") && !t.lowercased().hasPrefix("https://") { t = "https://" + t }
        guard let c = URLComponents(string: t), let host = c.host, !host.isEmpty, c.scheme == "https" || c.scheme == "http" else { return nil }
        var out = "\(c.scheme!)://\(host.contains(":") ? "[\(host)]" : host)"
        if let p = c.port { out += ":\(p)" }
        let path = c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path
        return out + path
    }

    /// Signs this computer in to an account (the computer gets its own credential; the password isn't stored).
    public func join(server: String, username: String, password: String, totp: String?) -> Result<String, JoinError> {
        guard let base = Self.normalizeServer(server), let url = URL(string: base + "/api/account/login") else { return .failure(.badServer) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = JSON.data(["username": username, "password": password, "totp": totp as Any?, "deviceName": HostInfo.name, "platform": "macos", "kind": "computer"])
        let (status, body, err) = send(req)
        if let err { return .failure(.unreachable(err)) }
        guard status == 200, let body, let token = body.str("token"), let account = body["account"] as? JSONObject, let device = body["device"] as? JSONObject else {
            return .failure(.rejected(body?.str("error") ?? "HTTP \(status)", body?.str("message")))
        }
        // Leaving a previous account first keeps it tidy (best effort).
        if ConfigStore.current.account != nil { leave() }
        let name = account.str("username") ?? username
        ConfigStore.update {
            $0.account = AccountLink(server: base, username: name, accountId: account.str("id") ?? "", deviceId: device.str("id") ?? "", token: token, devices: [])
        }
        lock.lock(); devices = []; lastError = nil; lastAttempt = .distantPast; lock.unlock()
        Log.info("account", "joined account '\(name)' at \(base)")
        sync()
        return .success(name)
    }

    public func leave() {
        guard let link = ConfigStore.current.account else { return }
        if let url = URL(string: link.server + "/api/account/logout") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("Bearer \(link.token)", forHTTPHeaderField: "Authorization")
            _ = send(req)
        }
        unlink(reason: "left the account")
    }

    private func unlink(reason: String) {
        lock.lock()
        let old = devices
        devices = []
        lastSync = nil
        lastError = nil
        lock.unlock()
        ConfigStore.update { $0.account = nil }
        for d in old { SessionManager.disconnectDevice(Self.localId(d.id)) }
        Log.info("account", "account link removed (\(reason))")
    }

    /// How account devices are named among this computer's devices and sessions.
    static func localId(_ id: String) -> String { "account:" + id }

    // ------------------------------------------------------------------ status

    public var statusJson: JSONObject? {
        guard let link = ConfigStore.current.account else { return nil }
        lock.lock(); defer { lock.unlock() }
        return [
            "server": link.server, "username": link.username, "lastSync": lastSync as Any?, "error": lastError as Any?,
            "devices": devices.map { ["id": Self.localId($0.id), "name": $0.name, "viewOnly": $0.viewOnly] as JSONObject },
        ]
    }

    // ------------------------------------------------------------------ http

    private func send(_ req: URLRequest) -> (Int, JSONObject?, String?) {
        let done = DispatchSemaphore(value: 0)
        var result: (Int, JSONObject?, String?) = (0, nil, nil)
        session.dataTask(with: req) { data, resp, err in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            result = (status, data.flatMap { JSON.parse($0) }, err.map { ($0 as NSError).localizedDescription })
            done.signal()
        }.resume()
        if done.wait(timeout: .now() + 15) == .timedOut { return (0, nil, "timed out") }
        return result
    }
}
