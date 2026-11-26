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

    /// An uploaded file gets the mode any new file gets here (0644 with the usual umask), not mkstemp's owner-only 0600.
    func testUploadedFileHasTheUsualModeNotOwnerOnly() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let sink = try FileApi.UploadSink(dir: dir.path, name: "shared.txt", remote: nil)
        try sink.write([1, 2, 3])
        XCTAssertEqual(sink.finish().status.code, 200)
        let mode = try fm.attributesOfItem(atPath: dir.appendingPathComponent("shared.txt").path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, Int(FileApi.UploadSink.fileMode))
        let umaskNow = umask(0o022); umask(umaskNow)
        XCTAssertEqual(mode, Int(0o666 & ~umaskNow), "the same as a file created any other way")
    }

    /// File transfer turned off, or the guest stopped, while a file arrives: it isn't saved, and nothing is left.
    func testUploadInFlightIsDroppedWhenFileTransferEnds() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let support = SupportService.shared
        let (guest, _) = support.startSession(name: "upload test", decision: .init(viewOnly: false, files: true, clipboard: false), ip: nil)
        defer { support.revoke(guest.id) }

        let turnedOff = try FileApi.UploadSink(dir: dir.path, name: "turned off.bin", remote: nil, deviceId: guest.id)
        try turnedOff.write([1, 2, 3])
        support.setRights(guest.id, input: nil, files: false, clipboard: nil)
        try turnedOff.write([4, 5, 6])
        XCTAssertEqual(turnedOff.finish().status.code, 403)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: dir.path), [])

        support.setRights(guest.id, input: nil, files: true, clipboard: nil)
        let allowed = try FileApi.UploadSink(dir: dir.path, name: "allowed.bin", remote: nil, deviceId: guest.id)
        try allowed.write([7, 8])
        XCTAssertEqual(allowed.finish().status.code, 200)
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("allowed.bin")), Data([7, 8]))

        let stopped = try FileApi.UploadSink(dir: dir.path, name: "stopped.bin", remote: nil, deviceId: guest.id)
        try stopped.write([9])
        support.revoke(guest.id)
        XCTAssertEqual(stopped.finish().status.code, 403)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: dir.path), ["allowed.bin"])
    }
}
