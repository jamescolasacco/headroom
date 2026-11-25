import AppKit
import Darwin
import HeadroomUpdate

enum ServerInstallation {
    static let showSettings = Notification.Name("app.headroom.server.showSettings")

    static func canUpdate(ownEngine: pid_t?, servingEngine: pid_t?) -> Bool {
        servingEngine == nil || servingEngine == ownEngine
    }

    static func runningOwner(of engine: pid_t) -> NSRunningApplication? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(engine, PROC_PIDTBSDINFO, 0, &info, size) == size,
              let app = NSRunningApplication(processIdentifier: pid_t(info.pbi_ppid)),
              app.bundleIdentifier == InstalledApplication.server.bundleID, !app.isTerminated else { return nil }
        return app
    }
}
