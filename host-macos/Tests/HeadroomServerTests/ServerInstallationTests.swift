import XCTest
@testable import HeadroomServer

final class ServerInstallationTests: XCTestCase {
    func testUpdateRequiresOwnershipOfTheLiveEngine() {
        XCTAssertTrue(ServerInstallation.canUpdate(ownEngine: 421, servingEngine: 421))
        XCTAssertFalse(ServerInstallation.canUpdate(ownEngine: 421, servingEngine: 733))
        XCTAssertFalse(ServerInstallation.canUpdate(ownEngine: nil, servingEngine: 733))
        XCTAssertTrue(ServerInstallation.canUpdate(ownEngine: nil, servingEngine: nil))
    }
}
