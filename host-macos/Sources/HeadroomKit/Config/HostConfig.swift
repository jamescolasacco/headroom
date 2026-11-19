import Foundation

// Same JSON schema (camelCase) and defaults as the Windows host's HostConfig.cs, so the two stay
// interchangeable and the admin page reads both. Every field decodes with a default: older or newer
// config files never fail to load.

public struct HostConfig: Codable {
    /// Stable random id so viewers can recognise this host across address changes.
    public var hostId: String?
    /// HTTPS port for Headroom Viewer on the same network (sessions and file transfer only).
    public var port = 7443
    /// Loopback-only port for this Mac's settings window. 0 disables it.
    public var httpHelperPort = 7080
    /// The name shown in your account and to people who connect (default: the computer's name).
    public var displayName: String?

    public var video = VideoSettings()
    public var audio = AudioSettings()
    /// What your own devices (signed in to your account) may do. Guests get what you allow when you accept them.
    public var permissions = PermissionSettings()
    public var tls = TlsSettings()

    /// Lock the Mac when the last viewer disconnects.
    public var lockOnDisconnect = false
    /// Show a notification when someone connects (menu-bar app).
    public var notifyOnConnect = true
    /// The Headroom service: accounts, and the relay that makes this computer reachable from anywhere.
    public var server = HostConfig.defaultServer
    /// Signed in to a Headroom account (with this computer's own sign-in there), if it is.
    public var account: AccountLink?

    public static let defaultServer = "https://headroom.colasac.co"

    /// Headroom's service moved from relay.colasac.co (gone) to headroom.colasac.co: the same server, so sign-ins made
    /// at the old address keep working at the new one.
    static func moved(_ server: String) -> String {
        let s = server.hasSuffix("/") ? String(server.dropLast()) : server
        return s.lowercased() == "https://relay.colasac.co" ? defaultServer : server
    }

    public init() {}

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        hostId = try c.decodeIfPresent(String.self, forKey: .hostId)
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? 7443
        httpHelperPort = try c.decodeIfPresent(Int.self, forKey: .httpHelperPort) ?? 7080
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        video = try c.decodeIfPresent(VideoSettings.self, forKey: .video) ?? VideoSettings()
        audio = try c.decodeIfPresent(AudioSettings.self, forKey: .audio) ?? AudioSettings()
        permissions = try c.decodeIfPresent(PermissionSettings.self, forKey: .permissions) ?? PermissionSettings()
        tls = try c.decodeIfPresent(TlsSettings.self, forKey: .tls) ?? TlsSettings()
        lockOnDisconnect = try c.decodeIfPresent(Bool.self, forKey: .lockOnDisconnect) ?? false
        notifyOnConnect = try c.decodeIfPresent(Bool.self, forKey: .notifyOnConnect) ?? true
        server = HostConfig.moved((try? c.decodeIfPresent(String.self, forKey: .server)) ?? HostConfig.defaultServer)
        // Sign-ins from before email accounts (usernames) don't work any more: start signed out.
        account = try? c.decodeIfPresent(AccountLink.self, forKey: .account)
        if let a = account { account?.server = HostConfig.moved(a.server) }
    }
}

/// This computer's sign-in to an account: its own credential there (not the account password) and the last list
/// of sign-ins it received, so it keeps working through a short outage.
public struct AccountLink: Codable {
    public var server: String
    public var email: String
    public var accountId: String
    public var deviceId: String
    public var token: String
    public var devices: [AccountService.Device]
}

/// Who a session belongs to: one of your account's sign-ins ("account:<id>") or a guest ("guest:<id>").
public struct PairedDevice: Codable {
    public var id = ""
    public var name = ""
    /// SHA-256 of the bearer token (tokens are 256-bit random, so a fast hash is sufficient).
    public var tokenHash = ""
    public var created = Date()
    public var lastSeen: Date?
    public var lastAddress: String?
    public var viewOnly = false

    public init(id: String, name: String, tokenHash: String, created: Date, lastAddress: String?) {
        self.id = id
        self.name = name
        self.tokenHash = tokenHash
        self.created = created
        self.lastAddress = lastAddress
    }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        tokenHash = try c.decodeIfPresent(String.self, forKey: .tokenHash) ?? ""
        created = try c.decodeIfPresent(Date.self, forKey: .created) ?? Date()
        lastSeen = try c.decodeIfPresent(Date.self, forKey: .lastSeen)
        lastAddress = try c.decodeIfPresent(String.self, forKey: .lastAddress)
        viewOnly = try c.decodeIfPresent(Bool.self, forKey: .viewOnly) ?? false
    }

    /// The shape the admin API returns (no token hash).
    var adminJson: JSONObject {
        ["id": id, "name": name, "created": created, "lastSeen": lastSeen as Any?, "lastAddress": lastAddress as Any?, "viewOnly": viewOnly]
    }
}

public struct VideoSettings: Codable {
    /// auto | hardware | software
    public var encoder = "auto"
    public var maxFps = 60
    /// Upper bound for adaptive bitrate (kbps).
    public var maxBitrateKbps = 40000
    public var startBitrateKbps = 12000
    public var minBitrateKbps = 800

    public init() {}
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        encoder = try c.decodeIfPresent(String.self, forKey: .encoder) ?? "auto"
        maxFps = try c.decodeIfPresent(Int.self, forKey: .maxFps) ?? 60
        maxBitrateKbps = try c.decodeIfPresent(Int.self, forKey: .maxBitrateKbps) ?? 40000
        startBitrateKbps = try c.decodeIfPresent(Int.self, forKey: .startBitrateKbps) ?? 12000
        minBitrateKbps = try c.decodeIfPresent(Int.self, forKey: .minBitrateKbps) ?? 800
    }

    var json: JSONObject {
        ["encoder": encoder, "maxFps": maxFps, "maxBitrateKbps": maxBitrateKbps, "startBitrateKbps": startBitrateKbps, "minBitrateKbps": minBitrateKbps]
    }
}

public struct AudioSettings: Codable {
    public var enabled = true
    public var bitrateKbps = 128

    public init() {}
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        bitrateKbps = try c.decodeIfPresent(Int.self, forKey: .bitrateKbps) ?? 128
    }

    var json: JSONObject { ["enabled": enabled, "bitrateKbps": bitrateKbps] }
}

public struct PermissionSettings: Codable {
    public var clipboard = true
    public var fileTransfer = true
    public var audio = true
    public var input = true

    public init() {}
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        clipboard = try c.decodeIfPresent(Bool.self, forKey: .clipboard) ?? true
        fileTransfer = try c.decodeIfPresent(Bool.self, forKey: .fileTransfer) ?? true
        audio = try c.decodeIfPresent(Bool.self, forKey: .audio) ?? true
        input = try c.decodeIfPresent(Bool.self, forKey: .input) ?? true
    }

    var json: JSONObject { ["clipboard": clipboard, "fileTransfer": fileTransfer, "audio": audio, "input": input] }
}

public struct TlsSettings: Codable {
    /// auto (Tailscale cert when available, else local CA) | local | tailscale | custom
    public var mode = "auto"
    public var certFile: String?
    public var keyFile: String?
    /// Extra DNS names / IPs to put in the self-signed certificate.
    public var extraNames: [String] = []

    public init() {}
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "auto"
        certFile = try c.decodeIfPresent(String.self, forKey: .certFile)
        keyFile = try c.decodeIfPresent(String.self, forKey: .keyFile)
        extraNames = try c.decodeIfPresent([String].self, forKey: .extraNames) ?? []
    }
}

/// Loads/saves the config atomically and serializes concurrent mutations.
public enum ConfigStore {
    private static let lock = NSRecursiveLock()
    private static var cached: HostConfig?

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .custom { date, enc in
            var c = enc.singleValueContainer()
            try c.encode(ISO8601.string(date))
        }
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let c = try dec.singleValueContainer()
            let s = try c.decode(String.self)
            guard let date = ISO8601.parse(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "bad date \(s)")
            }
            return date
        }
        return d
    }()

    public static var current: HostConfig {
        lock.lock(); defer { lock.unlock() }
        if let c = cached { return c }
        let c = load()
        cached = c
        return c
    }

    private static func load() -> HostConfig {
        let path = Paths.configFile
        guard FileManager.default.fileExists(atPath: path) else { return HostConfig() }
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            return try decoder.decode(HostConfig.self, from: data)
        } catch {
            Log.error("config", "failed to read config, using defaults", error)
            return HostConfig()
        }
    }

    public static func reload() {
        lock.lock(); defer { lock.unlock() }
        cached = load()
    }

    /// Mutate and persist under a lock.
    public static func update(_ mutate: (inout HostConfig) -> Void) {
        lock.lock(); defer { lock.unlock() }
        var c = cached ?? load()
        mutate(&c)
        cached = c
        do {
            Paths.ensurePrivateDir(Paths.dataDir)
            try Paths.writePrivate(try encoder.encode(c), to: Paths.configFile)
        } catch {
            Log.error("config", "failed to save config", error)
        }
    }
}
