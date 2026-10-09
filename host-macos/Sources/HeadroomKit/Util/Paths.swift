import Foundation

public enum Paths {
    /// Per-user data directory (config, certificates). The host runs in the user's session on macOS, so this
    /// lives in the user's Library. Override with HEADROOM_DATA (or --data=) for development.
    public static let dataDir: String = {
        if let d = ProcessInfo.processInfo.environment["HEADROOM_DATA"], !d.isEmpty { return d }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Headroom").path
    }()

    public static var configFile: String { (dataDir as NSString).appendingPathComponent("config.json") }
    public static var certDir: String { (dataDir as NSString).appendingPathComponent("certs") }

    /// ~/Library/Logs/Headroom (visible in Console.app), or <data>/logs when the data dir is overridden.
    public static let logDir: String = {
        if let d = ProcessInfo.processInfo.environment["HEADROOM_DATA"], !d.isEmpty {
            return (d as NSString).appendingPathComponent("logs")
        }
        let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
        return lib.appendingPathComponent("Logs/Headroom").path
    }()

    /// Directory of the running executable.
    public static let appDir: String = {
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return exe.deletingLastPathComponent().path
    }()

    /// The web client: HEADROOM_WEBROOT, else the app bundle's Resources/web, else a `web/` folder found by
    /// walking up from the executable (so `swift run` in a checkout just works).
    public static let webRoot: String = {
        let fm = FileManager.default
        if let d = ProcessInfo.processInfo.environment["HEADROOM_WEBROOT"], !d.isEmpty, fm.fileExists(atPath: d) { return d }
        // Contents/MacOS/headroom -> Contents/Resources/web
        let bundled = URL(fileURLWithPath: appDir).deletingLastPathComponent().appendingPathComponent("Resources/web").path
        if fm.fileExists(atPath: (bundled as NSString).appendingPathComponent("index.html")) { return bundled }
        var dir = URL(fileURLWithPath: appDir)
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("web")
            if fm.fileExists(atPath: candidate.appendingPathComponent("index.html").path) { return candidate.path }
            dir.deleteLastPathComponent()
        }
        return bundled
    }()

    /// Creates a directory readable only by this user.
    public static func ensurePrivateDir(_ path: String) {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) {
            try? fm.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
    }

    /// Atomic write with 0600 permissions (secrets live in these files).
    public static func writePrivate(_ data: Data, to path: String) throws {
        let tmp = path + ".tmp"
        let fm = FileManager.default
        fm.createFile(atPath: tmp, contents: data, attributes: [.posixPermissions: 0o600])
        guard fm.fileExists(atPath: tmp) else { throw CocoaError(.fileWriteUnknown) }
        if rename(tmp, path) != 0 { throw CocoaError(.fileWriteUnknown) }
    }
}
