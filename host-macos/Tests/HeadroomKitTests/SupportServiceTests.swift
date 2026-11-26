import XCTest
@testable import HeadroomKit

/// Guest requests and "Stop server": while stopped nobody gets in, not even someone already waiting for an answer.
final class SupportServiceTests: XCTestCase {
    override func tearDown() {
        ServerSwitch.shared.start()
        super.tearDown()
    }

    private var waiting: [JSONObject] { SupportService.shared.statusJson["requests"] as? [JSONObject] ?? [] }

    func testStopServerDeclinesWhoeverIsWaiting() {
        let answered = expectation(description: "the waiting guest hears no")
        var decision: SupportService.Decision? = SupportService.Decision(viewOnly: false, files: false, clipboard: false)
        SupportService.shared.requestApproval(name: "Waiting guest", ip: "192.0.2.1", country: nil) { d in
            decision = d
            answered.fulfill()
        }
        guard let id = waiting.first?["id"] as? String else { return XCTFail("the request isn't listed") }
        ServerSwitch.shared.stop()
        wait(for: [answered], timeout: 2)
        XCTAssertNil(decision)
        XCTAssertTrue(waiting.isEmpty, "a stopped server lists nobody waiting")
        XCTAssertFalse(SupportService.shared.decide(id: id, accept: true, viewOnly: false, files: true, clipboard: true),
                       "an Accept clicked after Stop server can't let them in")
    }

    func testNobodyStartsWaitingWhileStopped() {
        ServerSwitch.shared.stop()
        let answered = expectation(description: "refused at once")
        var decision: SupportService.Decision? = SupportService.Decision(viewOnly: false, files: false, clipboard: false)
        SupportService.shared.requestApproval(name: "Late guest", ip: nil, country: nil) { d in
            decision = d
            answered.fulfill()
        }
        wait(for: [answered], timeout: 2)
        XCTAssertNil(decision)
        XCTAssertTrue(waiting.isEmpty)
    }

    func testAnsweringStillWorksWhileRunning() {
        let answered = expectation(description: "accepted")
        var decision: SupportService.Decision?
        SupportService.shared.requestApproval(name: "Helper", ip: nil, country: nil) { d in
            decision = d
            answered.fulfill()
        }
        guard let id = waiting.first(where: { $0["name"] as? String == "Helper" })?["id"] as? String else { return XCTFail("not listed") }
        XCTAssertTrue(SupportService.shared.decide(id: id, accept: true, viewOnly: true, files: false, clipboard: true))
        wait(for: [answered], timeout: 2)
        XCTAssertEqual(decision?.viewOnly, true)
        XCTAssertEqual(decision?.clipboard, true)
        XCTAssertEqual(decision?.files, false)
    }
}
