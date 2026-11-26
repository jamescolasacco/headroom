import Foundation
import XCTest
@testable import HeadroomKit

final class LogTests: XCTestCase {
    /// A log write that fails (a full disk, a closed console) costs that line, never the engine. FileHandle.write(_:)
    /// raised an Objective-C exception for it, which aborted the process: seen when this Mac's disk filled up overnight.
    func testAFailedLogWriteDoesNotEndTheProcess() throws {
        let saved = Log.file, console = Log.consoleEnabled
        defer { Log.file = saved; Log.consoleEnabled = console }
        Log.consoleEnabled = false
        Log.file = try XCTUnwrap(FileHandle(forReadingAtPath: "/dev/null")) // every write to it fails
        Log.info("test", "this line can't be written")
        Log.flush()
        Log.warn("test", "nor this one")
        Log.flush()
    }
}
