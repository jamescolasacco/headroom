import Foundation

struct ViewerInfo: Equatable {
    let id: String
    let device: String
    let address: String
}

struct ServerStatus {
    let hostName: String
    let version: String
    let hasPassword: Bool
    let deviceCount: Int
    let viewers: [ViewerInfo]
    let urls: [String]
    let tailscale: String?
    let screenRecording: Bool
    let accessibility: Bool
    let notifyOnConnect: Bool
    let pid: Int32
}

/// Talks to the running engine's loopback-only admin API (the same one the settings page uses).
final class AdminClient {
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 3
        c.connectionProxyDictionary = [:] // loopback; never through a proxy
        return URLSession(configuration: c)
    }()

    /// The engine's plain-HTTP port (config.json httpHelperPort; HEADROOM_ADMIN_PORT overrides).
    static var port: Int {
        if let p = ProcessInfo.processInfo.environment["HEADROOM_ADMIN_PORT"].flatMap(Int.init) { return p }
        if let data = try? Data(contentsOf: URL(fileURLWithPath: dataDir).appendingPathComponent("config.json")),
           let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let p = j["httpHelperPort"] as? Int, p > 0 {
            return p
        }
        return 7080
    }

    static var dataDir: String {
        if let d = ProcessInfo.processInfo.environment["HEADROOM_DATA"], !d.isEmpty { return d }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Headroom").path
    }

    static var baseUrl: String { "http://127.0.0.1:\(port)" }

    func status(_ done: @escaping (ServerStatus?) -> Void) {
        request("GET", "/api/admin/status") { j in
            guard let j, let host = j["host"] as? [String: Any] else { return done(nil) }
            let perms = j["permissions"] as? [String: Any] ?? [:]
            let settings = j["settings"] as? [String: Any] ?? [:]
            let viewers = (j["sessions"] as? [[String: Any]] ?? []).map {
                ViewerInfo(id: $0["id"] as? String ?? "", device: $0["device"] as? String ?? "Viewer", address: $0["remoteAddress"] as? String ?? "")
            }
            done(ServerStatus(
                hostName: host["name"] as? String ?? Host.current().localizedName ?? "Mac",
                version: host["version"] as? String ?? "",
                hasPassword: j["hasPassword"] as? Bool ?? false,
                deviceCount: (j["devices"] as? [Any])?.count ?? 0,
                viewers: viewers,
                urls: j["urls"] as? [String] ?? [],
                tailscale: j["tailscale"] as? String,
                screenRecording: perms["screenRecording"] as? Bool ?? false,
                accessibility: perms["accessibility"] as? Bool ?? false,
                notifyOnConnect: settings["notifyOnConnect"] as? Bool ?? true,
                pid: Int32(j["pid"] as? Int ?? 0)))
        }
    }

    func disconnectAll(_ done: @escaping () -> Void = {}) {
        request("POST", "/api/admin/sessions/disconnect-all") { _ in done() }
    }

    func requestPermission(_ kind: String) {
        request("POST", "/api/admin/permissions/request", body: ["kind": kind]) { _ in }
    }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil, _ done: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: Self.baseUrl + path) else { return done(nil) }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        session.dataTask(with: r) { data, resp, _ in
            let ok = (resp as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            let j = ok ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } : nil
            DispatchQueue.main.async { done(j) }
        }.resume()
    }
}
