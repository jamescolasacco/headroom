import AppKit

public enum InstalledApplication: String, CaseIterable {
    case server = "Headroom Server"
    case viewer = "Headroom Viewer"

    public var bundleID: String {
        switch self {
        case .server: return "app.headroom.server"
        case .viewer: return "app.headroom.viewer"
        }
    }

    public static var directories: [URL] {
        [.localDomainMask, .userDomainMask].flatMap { FileManager.default.urls(for: .applicationDirectory, in: $0) }
    }

    /// Nil means this is already the preferred copy, or there is no installed app to hand off to.
    public func preferredURL(for current: URL, in directories: [URL] = InstalledApplication.directories) -> URL? {
        let me = current.resolvingSymlinksInPath().standardizedFileURL.path
        for directory in directories {
            let app = directory.appendingPathComponent(rawValue + ".app", isDirectory: true)
            guard let bundle = Bundle(url: app), bundle.bundleIdentifier == bundleID,
                  let exe = bundle.executableURL, FileManager.default.isExecutableFile(atPath: exe.path) else { continue }
            return app.resolvingSymlinksInPath().standardizedFileURL.path == me ? nil : app
        }
        return nil
    }

    public func open(_ app: URL, activate: Bool = true, arguments: [String] = [], completion: @escaping (Error?) -> Void) {
        let config = NSWorkspace.OpenConfiguration()
        config.allowsRunningApplicationSubstitution = false
        config.activates = activate
        config.arguments = arguments
        NSWorkspace.shared.openApplication(at: app, configuration: config) { _, error in
            DispatchQueue.main.async { completion(error) }
        }
    }
}
