import Foundation
import HeadroomUpdate

// Test harness for the updater: runs a real check (and, with --install, a real install) for an app that's
// installed somewhere, e.g. a scratch folder, against a "release" served from anywhere:
//
//   HEADROOM_UPDATE_BASE=http://127.0.0.1:8899/ update-check "<dir>/Headroom Viewer.app" [--install] [--cert <der>]
//
// It prints the updater's states, then (with --install) waits for the installed version to change.
let args = CommandLine.arguments.dropFirst()
guard let appPath = args.first(where: { $0.hasSuffix(".app") }) else {
    print("usage: update-check <app> [--install] [--cert <der>]")
    exit(2)
}
let app = URL(fileURLWithPath: appPath)
let env = ProcessInfo.processInfo.environment
guard let base = env["HEADROOM_UPDATE_BASE"].flatMap(URL.init(string:)) else { print("set HEADROOM_UPDATE_BASE"); exit(2) }
var certificate = (try? Data(contentsOf: app.appendingPathComponent("Contents/Resources/update-signing.cer")))
if let i = args.firstIndex(of: "--cert"), args.index(after: i) < args.endIndex {
    certificate = try? Data(contentsOf: URL(fileURLWithPath: args[args.index(after: i)]))
}
guard let info = Updater.bundleInfo(app) else { print("not an app: \(appPath)"); exit(2) }
let cache = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("headroom-update-check")
let updater = Updater(config: .init(base: base, current: info.version, appURL: app, certificate: certificate, cacheDir: cache))
print("installed: \(info.id) \(info.version); signed by \(Updater.signingRoot(of: app) ?? "ad-hoc"); certificate \(certificate == nil ? "none" : "embedded")")

var final: Updater.State?
let token = NotificationCenter.default.addObserver(forName: Updater.didChange, object: updater, queue: .main) { n in
    guard let s = n.userInfo?["state"] as? Updater.State else { return }
    if s.phase != .downloading || s.progress >= 1 || s.progress == 0 {
        print("  \(s.phase.rawValue)\(s.available.map { " \($0)" } ?? "")\(s.message.map { ": \($0)" } ?? "")")
    }
    if [.ready, .current, .failed].contains(s.phase) { final = s }
}
updater.check(userInitiated: true)
let deadline = Date().addingTimeInterval(120)
while final == nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
NotificationCenter.default.removeObserver(token)
guard let s = final else { print("timed out"); exit(1) }
guard args.contains("--install") else { exit(s.phase == .failed ? 1 : 0) }
guard s.phase == .ready, let version = s.available else { exit(1) }

do { try updater.install() } catch { print("install failed: \(error)"); exit(1) }
print("  installing \(version)…")
let until = Date().addingTimeInterval(60)
while Date() < until {
    if Updater.bundleInfo(app)?.version == version { print("installed \(version) ✓ (log: \(cache.path)/install.log)"); exit(0) }
    Thread.sleep(forTimeInterval: 0.5)
}
print("the installed version didn't change; see \(cache.path)/install.log")
exit(1)
