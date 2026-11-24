import CoreGraphics
import CoreVideo
import XCTest
@testable import HeadroomKit

final class CaptureTests: XCTestCase {
    func testSyntheticDisplayPublishesFrames() throws {
        let display = MonitorInfo(id: "test", displayID: 0, name: "Test", bounds: CGRect(x: 0, y: 0, width: 640, height: 360),
                                  width: 640, height: 360, primary: true, refreshHz: 60, scale: 1, rotation: 0, isTestPattern: true)
        let source = TestPatternSource(monitor: display)
        let signal = source.subscribe()
        source.start()
        defer { source.stop(); source.unsubscribe(signal) }
        let deadline = Date().addingTimeInterval(3)
        while source.frameVersion < 3 && Date() < deadline { signal.wait(timeoutMs: 100) }
        let (image, version) = try XCTUnwrap(source.latestAndVersion)
        XCTAssertGreaterThanOrEqual(version, 3)
        XCTAssertEqual(CVPixelBufferGetWidth(image), 640)
        XCTAssertEqual(CVPixelBufferGetHeight(image), 360)
    }
}
