import Carbon.HIToolbox
import XCTest
@testable import HeadroomKit

/// Which key types a character, on layouts and keyboards other than this Mac's own (read from the system's layouts;
/// nothing is selected or changed).
final class KeyboardLayoutTests: XCTestCase {
    private func layout(_ id: String) throws -> Data {
        let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
        guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource], let source = list.first,
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { throw XCTSkip("\(id) isn't installed") }
        return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    }

    private func keyboardType(_ kind: Int) -> UInt32 {
        UInt32((1...255).first { Int(KBGetLayoutType(Int16($0))) == kind } ?? 0)
    }

    private func key(_ table: [Character: KeyboardLayout.Stroke], _ ch: Character) -> String? {
        table[ch].map { "\($0.shift ? "Shift+" : "")\($0.code)" }
    }

    func testJisKeyboardTypesUnderscoreYenAndBarOnTheirOwnKeys() throws {
        let abc = try layout("com.apple.keylayout.ABC")
        let jis = KeyboardLayout.build(layout: abc, keyboardType: keyboardType(kKeyboardJIS))
        XCTAssertEqual(key(jis, "_"), "94")       // kVK_JIS_Underscore: Shift+Minus types = on a JIS keyboard
        XCTAssertEqual(key(jis, "¥"), "93")       // kVK_JIS_Yen
        XCTAssertEqual(key(jis, "|"), "Shift+93")
        XCTAssertEqual(key(jis, "="), "Shift+27")
        let ansi = KeyboardLayout.build(layout: abc, keyboardType: keyboardType(kKeyboardANSI))
        XCTAssertEqual(key(ansi, "_"), "Shift+27")
        XCTAssertEqual(key(ansi, "|"), "Shift+42")
        XCTAssertNil(ansi["¥"])
    }

    func testPositionalLayouts() throws {
        let ansi = keyboardType(kKeyboardANSI)
        let azerty = KeyboardLayout.build(layout: try layout("com.apple.keylayout.French"), keyboardType: ansi)
        XCTAssertEqual(key(azerty, "a"), "12")    // where a US keyboard has Q
        XCTAssertEqual(key(azerty, "1"), "Shift+18")
        XCTAssertEqual(key(azerty, "&"), "18")
        let qwertz = KeyboardLayout.build(layout: try layout("com.apple.keylayout.German"), keyboardType: ansi)
        XCTAssertEqual(key(qwertz, "z"), "16")    // kVK_ANSI_Y
        XCTAssertEqual(key(qwertz, "Ä"), "Shift+39")
        let dvorak = KeyboardLayout.build(layout: try layout("com.apple.keylayout.Dvorak"), keyboardType: ansi)
        XCTAssertEqual(key(dvorak, "o"), "1")     // kVK_ANSI_S
        XCTAssertEqual(key(dvorak, ","), "13")    // kVK_ANSI_W
    }
}
