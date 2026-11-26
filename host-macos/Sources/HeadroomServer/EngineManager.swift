import Foundation

/// Owns the engine process (`headroom agent`, next to this app's executable). It is started as our child,
/// so macOS attributes its Screen Recording / Accessibility use to Headroom Server, and it watches our PID so
/// it never outlives us. Restarted automatically if it exits unexpectedly.
final class EngineManager {
    private var process: Process?
    private var startedAt = Date.distantPast
    private(set) var userStopped = false
    /// The engine exited with 2: another engine was serving on its ports, so it stood aside (see retryIfPortsFree).
    private(set) var stoodAside = false
    private var asideRetries = 0
    private var nextAsideRetry = Date.distantPast
    private var restarts: [Date] = []
    private let path: String
    var onExit: (() -> Void)?

    init(path: String = EngineManager.enginePath) { self.path = path }

    static var enginePath: String {
        if let e = ProcessInfo.processInfo.environment["HEADROOM_ENGINE"], FileManager.default.isExecutableFile(atPath: e) { return e }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/headroom").path
    }

    static var engineExists: Bool { FileManager.default.isExecutableFile(atPath: enginePath) }

    var running: Bool { process?.isRunning == true }

    var pid: pid_t? { running ? process?.processIdentifier : nil }

    @discardableResult
    func start() -> Bool {
        userStopped = false
        stoodAside = false
        if running { return true }
        guard FileManager.default.isExecutableFile(atPath: path) else {
            NSLog("Headroom Server: engine not found at \(path)")
            return false
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["agent"]
        var env = ProcessInfo.processInfo.environment
        env["HEADROOM_PARENT_PID"] = String(getpid())
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(proc) }
        }
        do {
            try p.run()
        } catch {
            NSLog("Headroom Server: could not start engine: \(error)")
            return false
        }
        process = p
        startedAt = Date()
        return true
    }

    private func exited(_ proc: Process) {
        guard proc === process else { return }
        process = nil
        if Date().timeIntervalSince(startedAt) > 30 { asideRetries = 0 } // it served: a later conflict starts afresh
        // Exit code 2 = ports in use (another engine is already serving): don't fight it.
        if !userStopped && proc.terminationReason == .exit && proc.terminationStatus == 2 { stoodAside = true }
        onExit?()
        guard !userStopped, !stoodAside else { return }
        restarts = restarts.filter { $0 > Date().addingTimeInterval(-60) }
        guard restarts.count < 5 else {
            NSLog("Headroom Server: engine keeps exiting; not restarting")
            return
        }
        restarts.append(Date())
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, !self.userStopped, !self.running else { return }
            self.start()
        }
    }

    /// Call when nobody answers on the engine's ports. If ours stood aside for another engine, that one has gone:
    /// serve again, or this Mac would stay unreachable. Retries wait 4 s, then twice as long each time (up to 5
    /// minutes), in case the other engine still holds a port without answering.
    func retryIfPortsFree() {
        guard stoodAside, !userStopped, !running, Date() >= nextAsideRetry else { return }
        nextAsideRetry = Date().addingTimeInterval(min(300, 4 * pow(2, Double(asideRetries))))
        asideRetries += 1
        start()
    }

    /// Stops the engine (SIGTERM, then SIGKILL after 3 s).
    func stop() {
        userStopped = true
        guard let p = process, p.isRunning else { process = nil; return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
    }
}
