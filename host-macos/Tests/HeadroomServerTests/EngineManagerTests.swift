import XCTest
@testable import HeadroomServer

final class EngineManagerTests: XCTestCase {
    /// An engine that finds its ports taken (exit 2) is left alone, and starts again once nobody serves there.
    func testStandsAsideForAnotherEngineThenServesOnceThePortsAreFree() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let taken = dir.appendingPathComponent("ports-taken"), starts = dir.appendingPathComponent("starts")
        let engine = dir.appendingPathComponent("engine")
        try """
        #!/bin/sh
        echo start >> '\(starts.path)'
        if [ -e '\(taken.path)' ]; then exit 2; fi
        exec /bin/sleep 30
        """.write(to: engine, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)
        try Data().write(to: taken)
        let launches = { (try? String(contentsOf: starts, encoding: .utf8))?.split(separator: "\n").count ?? 0 }

        let manager = EngineManager(path: engine.path)
        var exits = 0
        manager.onExit = { exits += 1 }
        defer { manager.stop() }
        XCTAssertTrue(manager.start())
        spin(until: { exits == 1 })
        spin(seconds: 1.5) // a crashed engine restarts after 1 s; one that stood aside must not
        XCTAssertFalse(manager.running)
        XCTAssertTrue(manager.stoodAside)
        XCTAssertEqual(launches(), 1)

        manager.retryIfPortsFree() // still taken: one try, and it stands aside again
        spin(until: { exits == 2 })
        XCTAssertTrue(manager.stoodAside)
        manager.retryIfPortsFree() // too soon after the last try
        XCTAssertFalse(manager.running)
        XCTAssertEqual(launches(), 2)

        try fm.removeItem(at: taken)
        spin(seconds: 4.2)
        manager.retryIfPortsFree()
        XCTAssertTrue(manager.running)
        XCTAssertFalse(manager.stoodAside)
        spin(until: { launches() == 3 })

        manager.stop()
        manager.retryIfPortsFree() // stopped on purpose: stays stopped
        XCTAssertFalse(manager.running)
    }

    private func spin(until done: () -> Bool, timeout: TimeInterval = 5) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        XCTAssertTrue(done())
    }

    private func spin(seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    }
}
