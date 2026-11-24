import Foundation
import XCTest
@testable import HeadroomKit

final class UploadTests: XCTestCase {
    func testReservationFallbackPreservesFilesAndCleansUpOnFailure() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let source = dir.appendingPathComponent("source"), dest = dir.appendingPathComponent("dest")
        try Data([1]).write(to: source)
        try Data([2]).write(to: dest)
        XCTAssertEqual(FileApi.UploadSink.moveWithReservation(source.path, to: dest.path), EEXIST)
        XCTAssertEqual(try Data(contentsOf: dest), Data([2]))
        try fm.removeItem(at: dest)
        XCTAssertEqual(FileApi.UploadSink.moveWithReservation(source.path, to: dest.path), 0)
        XCTAssertEqual(try Data(contentsOf: dest), Data([1]))
        let missing = dir.appendingPathComponent("missing").path
        XCTAssertEqual(FileApi.UploadSink.moveWithReservation(source.path, to: missing), ENOENT)
        XCTAssertFalse(fm.fileExists(atPath: missing))
    }

    func testSameNameUploadsAndCancellationPreserveEveryCompletedFile() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let name = "session notes.txt"
        let existing = dir.appendingPathComponent(name)
        try Data([99]).write(to: existing)
        let sinks = try (0..<32).map { _ in try FileApi.UploadSink(dir: dir.path, name: name, remote: nil) }
        for (i, sink) in sinks.enumerated() { try sink.write([UInt8(i)]) }
        DispatchQueue.concurrentPerform(iterations: sinks.count) { i in
            if i == 0 {
                sinks[i].abort()
            } else {
                do {
                    try sinks[i].write([255])
                    XCTAssertEqual(sinks[i].finish().status.code, 200)
                } catch {
                    XCTFail("upload \(i) failed: \(error)")
                }
            }
        }
        XCTAssertEqual(try Data(contentsOf: existing), Data([99]))
        let files = try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 32)
        let copies = try Set(files.filter { $0.lastPathComponent != name }.map { try Data(contentsOf: $0) })
        XCTAssertEqual(copies, Set((1..<32).map { Data([UInt8($0), 255]) }))
    }
}
