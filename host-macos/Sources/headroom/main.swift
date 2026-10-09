import Foundation
import HeadroomKit

// headroom — the macOS host engine and command-line tool (counterpart of headroom.exe).

var args = Array(CommandLine.arguments.dropFirst())
// --data=<dir> / --webroot=<dir> override the data directory and client files (development).
for a in args {
    if a.hasPrefix("--data=") { setenv("HEADROOM_DATA", (String(a.dropFirst(7)) as NSString).expandingTildeInPath.absolutePath, 1) }
    if a.hasPrefix("--webroot=") { setenv("HEADROOM_WEBROOT", (String(a.dropFirst(10)) as NSString).expandingTildeInPath.absolutePath, 1) }
    // --test-pattern[=WxH]: stream a synthetic display (no Screen Recording needed); --loopback: no LAN exposure.
    if a == "--test-pattern" { setenv("HEADROOM_TEST_PATTERN", "1", 1) }
    if a.hasPrefix("--test-pattern=") { setenv("HEADROOM_TEST_PATTERN", String(a.dropFirst(15)), 1) }
    if a == "--loopback" { setenv("HEADROOM_BIND", "loopback", 1) }
}
args.removeAll { $0.hasPrefix("--data=") || $0.hasPrefix("--webroot=") || $0.hasPrefix("--test-pattern") || $0 == "--loopback" }

extension String {
    var absolutePath: String {
        hasPrefix("/") ? self : (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(self)
    }
}

let command = args.first.map { $0.hasPrefix("-") ? "run" : $0.lowercased() } ?? "run"
let rest = args.first.map { $0.hasPrefix("-") ? args : Array(args.dropFirst()) } ?? []
if ProcessInfo.processInfo.environment["HEADROOM_DEBUG"] == "1" { Log.minLevel = .debug }
if command == "agent" { Log.consoleEnabled = false }
Log.initialize(logDir: ["run", "agent"].contains(command) ? Paths.logDir : nil)

func usage(_ code: Int32) -> Int32 {
    print("""
        Headroom remote desktop host (macOS)

          headroom [run]              start the host (default)
          headroom set-password       set the password used to pair new devices
          headroom pair               show a one-time pairing code (host must be running)
          headroom devices            list paired devices
          headroom revoke <id>        revoke a paired device
          headroom permissions        show (and request) Screen Recording / Accessibility
          headroom selftest [secs]    capture + encode test, writes an .h264 file

        Options:     --data=<dir> --webroot=<dir> --loopback --test-pattern[=WxH]
        Environment: HEADROOM_DATA (data dir), HEADROOM_WEBROOT (client dir), HEADROOM_DEBUG=1,
                     HEADROOM_BIND=loopback, HEADROOM_TEST_PATTERN=1 (synthetic display, no permission needed)
        """)
    return code
}

func readSecret(_ prompt: String) -> String {
    if isatty(STDIN_FILENO) == 0 {
        print(prompt, terminator: "")
        return readLine() ?? ""
    }
    guard let p = getpass(prompt) else { return "" }
    return String(cString: p)
}

func setPassword(_ args: [String]) -> Int32 {
    var pw = args.first
    if pw == nil {
        let a = readSecret("New password (min 8 chars): ")
        let b = readSecret("Repeat: ")
        guard a == b else { print("Passwords don't match."); return 1 }
        pw = a
    }
    do {
        try AuthService.setPassword(pw!)
    } catch {
        print(error)
        return 1
    }
    print("Password saved. Use it to pair new devices (paired devices keep working).")
    return 0
}

func pair() -> Int32 {
    let port = ConfigStore.current.httpHelperPort
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/admin/paircode")!)
    req.httpMethod = "POST"
    req.timeoutInterval = 5
    let done = DispatchSemaphore(value: 0)
    var result: Int32 = 1
    URLSession.shared.dataTask(with: req) { data, resp, err in
        defer { done.signal() }
        guard let data, (resp as? HTTPURLResponse)?.statusCode == 200, let j = JSON.parse(data), let code = j.str("code") else {
            print("Could not reach the running host on port \(port): \(err?.localizedDescription ?? "bad response")")
            return
        }
        print("Pairing code (valid 10 minutes, single use): \(code.prefix(5))-\(code.dropFirst(5))")
        print("Or open one of these on the new device:")
        for u in (j["urls"] as? [String]) ?? [] { print("  " + u) }
        result = 0
    }.resume()
    done.wait()
    return result
}

func devices() -> Int32 {
    let ds = ConfigStore.current.devices
    if ds.isEmpty { print("No paired devices."); return 0 }
    let f = DateFormatter()
    f.dateStyle = .short
    f.timeStyle = .short
    for d in ds {
        let name = d.name.padding(toLength: 28, withPad: " ", startingAt: 0)
        print("\(d.id)  \(name) paired \(f.string(from: d.created))  last seen \(d.lastSeen.map(f.string) ?? "never")  \(d.lastAddress ?? "")\(d.viewOnly ? "  [view-only]" : "")")
    }
    return 0
}

func revoke(_ args: [String]) -> Int32 {
    guard let id = args.first else { print("usage: headroom revoke <device-id>"); return 1 }
    let ok = AuthService.revokeDevice(id)
    print(ok ? "Revoked. (A running host disconnects it on its next reconnect attempt.)" : "No such device.")
    return ok ? 0 : 1
}

func permissions(_ args: [String]) -> Int32 {
    print("Screen Recording: \(Permissions.screenRecording ? "granted" : "not granted")")
    print("Accessibility:    \(Permissions.accessibility ? "granted" : "not granted")")
    if args.contains("--request") {
        if !Permissions.screenRecording { Permissions.requestScreenRecording() }
        if !Permissions.accessibility { Permissions.requestAccessibility() }
        print("Requested. Grant them in System Settings → Privacy & Security, then restart the host.")
    } else if !Permissions.screenRecording || !Permissions.accessibility {
        print("Run `headroom permissions --request` to show the macOS prompts.")
    }
    return 0
}

let code: Int32
switch command {
case "run": code = Engine.run(banner: true)
case "agent": code = Engine.run(banner: false)
case "set-password": code = setPassword(rest)
case "pair": code = pair()
case "devices": code = devices()
case "revoke": code = revoke(rest)
case "permissions": code = permissions(rest)
case "selftest": code = SelfTest.run(rest)
case "help", "--help", "-h": code = usage(0)
default: code = usage(1)
}
Log.flush()
exit(code)
