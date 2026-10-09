import Foundation

/// Owns the engine process (`headroom agent`, next to this app's executable). It is started as our child,
/// so macOS attributes its Screen Recording / Accessibility use to Headroom Server, and it watches our PID so
/// it never outlives us. Restarted automatically if it exits unexpectedly.
final class EngineManager {
    private var process: Process?
    private(set) var userStopped = false
    private var restarts: [Date] = []
    var onExit: (() -> Void)?

    static var enginePath: String {
        if let e = ProcessInfo.processInfo.environment["HEADROOM_ENGINE"], FileManager.default.isExecutableFile(atPath: e) { return e }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/headroom").path
    }

    static var engineExists: Bool { FileManager.default.isExecutableFile(atPath: enginePath) }

    var running: Bool { process?.isRunning == true }

    @discardableResult
    func start() -> Bool {
        userStopped = false
        if running { return true }
        guard Self.engineExists else {
            NSLog("Headroom Server: engine not found at \(Self.enginePath)")
            return false
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: Self.enginePath)
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
        return true
    }

    private func exited(_ proc: Process) {
        guard proc === process else { return }
        process = nil
        onExit?()
        guard !userStopped else { return }
        // Exit code 2 = ports in use (another engine is already serving): don't fight it.
        if proc.terminationReason == .exit && proc.terminationStatus == 2 { return }
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
