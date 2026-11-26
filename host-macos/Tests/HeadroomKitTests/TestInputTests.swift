import CoreGraphics
import XCTest
@testable import HeadroomKit

/// The test input recorder's model: the simulated text field, shortcuts, held modifiers and buttons, clicks.
final class TestInputTests: XCTestCase {
    private typealias M = TestInputModel.Mods

    /// A key pressed and let go, as the recorder decodes it.
    private func tap(_ m: inout TestInputModel, _ code: Int, _ chars: String, mods: M = [], base: String? = nil) {
        m.key(code: code, down: true, mods: mods, chars: chars, base: base ?? chars)
        m.key(code: code, down: false, mods: mods, chars: "", base: base ?? chars)
    }

    func testTypedKeysInsertAtTheEnd() {
        var m = TestInputModel()
        for (code, ch) in [(4, "h"), (14, "i"), (49, " ")] { tap(&m, code, ch) }
        tap(&m, 0, "A", mods: .shift, base: "a")
        XCTAssertEqual(m.field, "hi A")
        XCTAssertEqual(m.events, 8)
        XCTAssertEqual(m.shortcuts, [])
    }

    func testDeleteRemovesTheLastCharacterAndStopsAtEmpty() {
        var m = TestInputModel()
        tap(&m, 0, "ab")
        tap(&m, 51, "\u{8}")
        XCTAssertEqual(m.field, "a")
        tap(&m, 51, "\u{8}")
        tap(&m, 51, "\u{8}")
        XCTAssertEqual(m.field, "")
        XCTAssertEqual(m.last, "⌫ up")
    }

    func testShortcutsAreRecordedNotTyped() {
        var m = TestInputModel()
        tap(&m, 4, "h")
        tap(&m, 0, "a", mods: .command)
        tap(&m, 8, "c", mods: .control)
        tap(&m, 6, "Z", mods: [.command, .shift], base: "z")
        tap(&m, 53, "\u{1B}", mods: [.command, .option])
        XCTAssertEqual(m.field, "h")
        XCTAssertEqual(m.shortcuts, ["⌘A", "⌃C", "⇧⌘Z", "⌥⌘⎋"])
        // Shift and Option alone still type.
        tap(&m, 0, "å", mods: .option, base: "a")
        XCTAssertEqual(m.field, "hå")
    }

    func testNewlineTabAndKeysThatTypeNothing() {
        var m = TestInputModel()
        tap(&m, 0, "a")
        tap(&m, 36, "\r")
        tap(&m, 48, "\t")
        tap(&m, 76, "\u{3}")
        for (code, ch) in [(53, "\u{1B}"), (117, "\u{7F}"), (123, "\u{1C}"), (126, "\u{1E}"), (122, "\u{10}"), (115, "\u{1}")] { tap(&m, code, ch) }
        XCTAssertEqual(m.field, "a\n\t\n")
        XCTAssertEqual(m.overlayLines(fieldChars: 48)[0], "FIELD: a⏎⇥⏎▏")
    }

    func testUnicodeTextAndGraphemes() {
        var m = TestInputModel()
        // Strings from the text path arrive on key 0 with their own characters.
        tap(&m, 0, "h")
        tap(&m, 0, "é")
        tap(&m, 0, "llo w")
        tap(&m, 0, "ö")
        tap(&m, 0, "👩🏽‍💻")
        tap(&m, 0, "🇫🇷")
        XCTAssertEqual(m.field, "héllo wö👩🏽‍💻🇫🇷")
        tap(&m, 51, "\u{8}")
        XCTAssertEqual(m.field, "héllo wö👩🏽‍💻", "a flag is one character")
        tap(&m, 51, "\u{8}")
        XCTAssertEqual(m.field, "héllo wö", "a skin-toned ZWJ emoji is one character")
        tap(&m, 51, "\u{8}")
        XCTAssertEqual(m.field, "héllo w")
        // é as e + combining acute is one character too.
        tap(&m, 0, "e\u{301}")
        tap(&m, 51, "\u{8}")
        XCTAssertEqual(m.field, "héllo w")
    }

    func testModifiersHeldAndReleased() {
        var m = TestInputModel()
        m.flags(code: 56, mods: .shift)
        XCTAssertEqual(m.held.names, ["shift"])
        XCTAssertEqual(m.last, "shift-left down")
        m.flags(code: 55, mods: [.shift, .command])
        XCTAssertEqual(m.held.names, ["shift", "command"])
        m.flags(code: 56, mods: .command)
        XCTAssertEqual(m.held.names, ["command"])
        XCTAssertEqual(m.last, "shift-left up")
        m.flags(code: 55, mods: [])
        XCTAssertEqual(m.held.names, [])
        // Caps Lock is a lock, not a key held.
        m.caps(true)
        m.flags(code: 59, mods: [.control, .caps])
        XCTAssertEqual(m.held.names, ["control"])
        XCTAssertTrue(m.caps)
        XCTAssertEqual(m.overlayLines(fieldChars: 48)[1], "HELD: control capslock")
    }

    func testButtonsClicksScrollAndReset() {
        var m = TestInputModel()
        m.mouse(type: "moved", button: nil, x: 100, y: 50, clickState: 0, t: 1)
        m.mouse(type: "down", button: "left", x: 100, y: 50, clickState: 1, t: 2)
        XCTAssertEqual(m.buttons, ["left"])
        m.mouse(type: "dragged", button: "left", x: 120, y: 60, clickState: 0, t: 3)
        m.mouse(type: "up", button: "left", x: 120, y: 60, clickState: 1, t: 4)
        m.mouse(type: "down", button: "left", x: 120, y: 60, clickState: 2, t: 5)
        m.mouse(type: "up", button: "left", x: 120, y: 60, clickState: 2, t: 6)
        XCTAssertEqual(m.buttons, [])
        XCTAssertEqual(m.pointer, CGPoint(x: 120, y: 60))
        XCTAssertEqual(m.clicks.map(\.clickState), [1, 2])
        for i in 0..<25 { m.mouse(type: "down", button: "right", x: Double(i), y: 0, clickState: 1, t: 10 + i) }
        XCTAssertEqual(m.clicks.count, 20)
        XCTAssertEqual(m.clicks.last?.x, 24)
        m.scroll(dx: 0, dy: 100)
        m.scroll(dx: -10, dy: 5)
        XCTAssertEqual(m.scrollY, 105)
        XCTAssertEqual(m.scrollX, -10)
        m.special("lock")
        m.flags(code: 56, mods: .shift)
        tap(&m, 0, "x")
        m.reset()
        XCTAssertEqual(m.field, "")
        XCTAssertEqual(m.clicks.count, 0)
        XCTAssertEqual(m.specials, [])
        XCTAssertEqual(m.events, 0)
        XCTAssertEqual(m.scrollY, 0)
        // What's physically held stays.
        XCTAssertEqual(m.held.names, ["shift"])
        XCTAssertEqual(m.buttons, ["right"])
    }

    func testStateJsonAndOverlay() throws {
        var m = TestInputModel()
        tap(&m, 4, "h")
        m.mouse(type: "down", button: "left", x: 10, y: 20, clickState: 1, t: 7)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSON.data(m.json)) as? [String: Any])
        XCTAssertEqual(json["field"] as? String, "h")
        XCTAssertEqual(json["buttons"] as? [String], ["left"])
        XCTAssertEqual((json["pointer"] as? [String: Any])?["x"] as? Double, 10)
        XCTAssertEqual(json["events"] as? Int, 3)
        for key in ["field", "shortcuts", "held", "buttons", "pointer", "clicks", "scroll", "events", "specials"] {
            XCTAssertNotNil(json[key], key)
        }
        // The panel shows the end of a long field.
        tap(&m, 0, String(repeating: "x", count: 60) + "END")
        let lines = m.overlayLines(fieldChars: 10)
        XCTAssertEqual(lines[0], "FIELD: xxxxxxxEND▏")
        XCTAssertEqual(lines[1], "HELD: left")
        XCTAssertEqual(lines[3], "EVENTS: 5")
    }

    func testKeysLeftDownShowUntilTheirKeyUp() throws {
        var m = TestInputModel()
        m.key(code: 8, down: true, mods: .command, chars: "c", base: "c")
        m.key(code: 9, down: true, mods: [], chars: "v", base: "v")
        tap(&m, 4, "h")
        XCTAssertEqual(m.keysDown.map(\.label), ["C", "V"])
        XCTAssertEqual(m.overlayLines(fieldChars: 48)[1], "HELD: C V")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSON.data(m.json)) as? [String: Any])
        XCTAssertEqual(json["keys"] as? [String], ["C", "V"])
        m.reset()
        XCTAssertEqual(m.keysDown.count, 2, "what's held stays")
        m.key(code: 8, down: false, mods: [], chars: "", base: "c")
        m.key(code: 9, down: false, mods: [], chars: "", base: "v")
        XCTAssertEqual(m.keysDown.count, 0)
        XCTAssertEqual(m.overlayLines(fieldChars: 48)[1], "HELD: none")
    }

    func testFlagNamesFromEventFlags() {
        let f: CGEventFlags = [.maskShift, .maskCommand, .maskAlphaShift, .maskSecondaryFn]
        XCTAssertEqual(M(f).names, ["shift", "command", "caps", "fn"])
        XCTAssertEqual(M(CGEventFlags([.maskControl, .maskAlternate])).symbols, "⌃⌥")
    }
}
