import AppKit
import Foundation
import NIOCore
import NIOSSL
import NIOPosix

/// Starts the host: certificates, HTTPS/WSS on 7443 (Headroom Viewer on the same network), the settings window on
/// 127.0.0.1:7080, the relay connection and the account check-in; then runs the main run loop (AppKit pieces —
/// cursor shape, pasteboard, display names — live on the main thread).
public enum Engine {
    private static var server: HttpServer?
    private static var webHost: WebHost?
    private static var signalSources: [DispatchSourceSignal] = []
    private static var parentWatch: DispatchSourceProcess?

    /// Returns a process exit code (only on failure; on success it runs until terminated).
    public static func run(banner: Bool) -> Int32 {
        Paths.ensurePrivateDir(Paths.dataDir)
        let cfg = ConfigStore.current
        _ = HostInfo.hostId

        // A background app: no Dock icon, no menu bar, but a window-server connection and a main run loop.
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        _ = Displays.enumerate() // warms the display-name cache on the main thread

        let certs = CertificateManager()
        do {
            try certs.initialize()
        } catch {
            Log.error("tls", "certificate setup failed", error)
            return 1
        }
        let host = WebHost(certs: certs)
        let srv = HttpServer(app: host)
        let loopbackOnly = ProcessInfo.processInfo.environment["HEADROOM_BIND"] == "loopback"
        do {
            let tls = try NIOSSLContext(configuration: certs.makeTlsConfiguration())
            try srv.listen(port: cfg.port, tls: tls, loopbackOnly: loopbackOnly)
            if cfg.httpHelperPort > 0 { try srv.listen(port: cfg.httpHelperPort, tls: nil, loopbackOnly: true) } // settings: this Mac only
        } catch let e as IOError where e.errnoCode == EADDRINUSE {
            Log.error("main", "Port \(cfg.port) or \(cfg.httpHelperPort) is already in use. Is Headroom already running?")
            srv.shutdown()
            return 2
        } catch {
            Log.error("main", "could not start the server", error)
            srv.shutdown()
            return 1
        }
        server = srv
        webHost = host
        AccountService.shared.start(certs: certs, web: host)
        RelayService.shared.start(server: srv)

        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            s.setEventHandler { shutdown(code: 0) }
            s.resume()
            signalSources.append(s)
        }

        // Started by Headroom Server (the menu-bar app): never outlive it, even if it crashes.
        if let ppid = ProcessInfo.processInfo.environment["HEADROOM_PARENT_PID"].flatMap(Int32.init), ppid > 1 {
            let watch = DispatchSource.makeProcessSource(identifier: ppid, eventMask: .exit, queue: .main)
            watch.setEventHandler { Log.info("main", "Headroom Server exited; stopping"); shutdown(code: 0) }
            watch.resume()
            parentWatch = watch
            if getppid() != ppid { shutdown(code: 0) }
        }

        if banner { printBanner(host) }
        Log.info("main", "Headroom \(HostInfo.version) on \(HostInfo.machineName) (macOS \(HostInfo.osVersion)); data \(Paths.dataDir)")
        if Displays.testPatternSize != nil { Log.warn("main", "TEST PATTERN mode: viewers see a synthetic display, not this Mac's screen") }
        if !Permissions.screenRecording { Log.warn("main", Permissions.screenRecordingHint) }
        if !Permissions.accessibility { Log.warn("main", Permissions.accessibilityHint) }
        app.run()
        return 0
    }

    public static func shutdown(code: Int32) {
        Log.info("main", "shutting down")
        for s in SessionManager.active { s.disconnect("host is shutting down") }
        DispatchQueue.global().async {
            Thread.sleep(forTimeInterval: 0.3)
            server?.shutdown()
            Log.flush()
            exit(code)
        }
    }

    private static func printBanner(_ host: WebHost) {
        let cfg = ConfigStore.current
        var s = "\n  Headroom \(HostInfo.version) — \(HostInfo.name)\n\n"
        if let a = cfg.account {
            s += "  Signed in as \(a.email): open \(a.server) on any device and sign in to connect.\n"
        } else {
            s += "  Not signed in to a Headroom account. Sign in from the settings: http://localhost:\(cfg.httpHelperPort)/\n"
        }
        s += "  To let someone connect with a code, use the settings (Let someone connect).\n"
        if !Permissions.screenRecording { s += "\n  ! \(Permissions.screenRecordingHint)\n" }
        if !Permissions.accessibility { s += "  ! \(Permissions.accessibilityHint)\n" }
        print(s)
        fflush(stdout)
    }
}
