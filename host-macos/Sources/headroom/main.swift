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

let command = args.first.map { ["--help", "-h"].contains($0) ? "help" : ($0.hasPrefix("-") ? "run" : $0.lowercased()) } ?? "run"
let rest = args.first.map { $0.hasPrefix("-") ? args : Array(args.dropFirst()) } ?? []
if ProcessInfo.processInfo.environment["HEADROOM_DEBUG"] == "1" { Log.minLevel = .debug }
if command == "agent" { Log.consoleEnabled = false }
Log.initialize(logDir: ["run", "agent"].contains(command) ? Paths.logDir : nil)

func usage(_ code: Int32) -> Int32 {
    print("""
        Headroom remote desktop host (macOS)

          headroom [run]              start the host (default)
          headroom permissions        show (and request) Screen Recording / Accessibility
          headroom selftest [secs]    capture + encode test, writes an .h264 file
          headroom keys <text>        which key each character of <text> is typed with (this Mac's layout)

        Options:     --data=<dir> --webroot=<dir> --loopback --test-pattern[=WxH]
        Environment: HEADROOM_DATA (data dir), HEADROOM_WEBROOT (client dir), HEADROOM_DEBUG=1,
                     HEADROOM_BIND=loopback, HEADROOM_TEST_PATTERN=1 (synthetic display, no permission needed)
        """)
    return code
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
case "permissions": code = permissions(rest)
case "selftest": code = SelfTest.run(rest)
case "keys": print(KeyboardLayout.explain(rest.joined(separator: " "))); code = 0
case "help", "--help", "-h": code = usage(0)
default: code = usage(1)
}
Log.flush()
exit(code)
