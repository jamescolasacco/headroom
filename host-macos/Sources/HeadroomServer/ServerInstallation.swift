import AppKit
import Darwin

enum ServerInstallation {
    static let bundleID = "app.headroom.server"
    static let showSettings = Notification.Name("app.headroom.server.showSettings")

    static var applicationDirectories: [URL] {
        [.localDomainMask, .userDomainMask].flatMap { FileManager.default.urls(for: .applicationDirectory, in: $0) }
    }

    static func preferredURL(for current: URL, in directories: [URL]) -> URL? {
        let me = current.resolvingSymlinksInPath().standardizedFileURL.path
        for directory in directories {
            let app = directory.appendingPathComponent("Headroom Server.app", isDirectory: true)
            guard let bundle = Bundle(url: app), bundle.bundleIdentifier == bundleID,
                  let exe = bundle.executableURL, FileManager.default.isExecutableFile(atPath: exe.path) else { continue }
            return app.resolvingSymlinksInPath().standardizedFileURL.path == me ? nil : app
        }
        return nil // A portable installation is supported when there is no installed app.
    }

    static func canUpdate(ownEngine: pid_t?, servingEngine: pid_t?) -> Bool {
        servingEngine == nil || servingEngine == ownEngine
    }

    static func runningOwner(of engine: pid_t) -> NSRunningApplication? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(engine, PROC_PIDTBSDINFO, 0, &info, size) == size,
              let app = NSRunningApplication(processIdentifier: pid_t(info.pbi_ppid)),
              app.bundleIdentifier == bundleID, !app.isTerminated else { return nil }
        return app
    }
}
