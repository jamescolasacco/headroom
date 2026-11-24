import Foundation
import XCTest
@testable import HeadroomKit

final class UploadTests: XCTestCase {
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
        sinks[0].abort()
        for i in (1..<sinks.count).reversed() {
            try sinks[i].write([255])
            XCTAssertEqual(sinks[i].finish().status.code, 200)
        }
        XCTAssertEqual(try Data(contentsOf: existing), Data([99]))
        let files = try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 32)
        let copies = try Set(files.filter { $0.lastPathComponent != name }.map { try Data(contentsOf: $0) })
        XCTAssertEqual(copies, Set((1..<32).map { Data([UInt8($0), 255]) }))
    }
}
