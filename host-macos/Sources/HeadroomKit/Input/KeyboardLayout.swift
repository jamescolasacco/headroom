import AppKit
import Carbon.HIToolbox
import CoreGraphics

/// Which key types a character on this Mac's current keyboard layout (and whether it needs Shift), so typed text can
/// go as real key presses, the way a keyboard plugged into the Mac would type it. A key event that only carries a
/// string (CGEventKeyboardSetUnicodeString) types into ordinary fields, but secure ones (password fields, the lock
/// screen's) can ignore it. Characters the layout has no plain or Shift key for (emoji, accents reached through a dead
/// key or Option, other scripts) aren't here: those still go as a string.
public final class KeyboardLayout {
    static let shared = KeyboardLayout()

    /// `headroom keys <text>`: how each character of `text` would be typed on this Mac's layout, one per line.
    public static func explain(_ text: String) -> String {
        text.map { ch -> String in
            let shown = ch == " " ? "space" : String(ch)
            guard let s = shared.stroke(for: ch) else { return "\(shown)\tas text (this layout has no key for it)" }
            return "\(shown)\t\(s.shift ? "Shift+" : "")key \(s.code)"
        }.joined(separator: "\n")
    }

    struct Stroke {
        let code: CGKeyCode
        let shift: Bool
    }

    private let lock = NSLock()
    private var strokes: [Character: Stroke] = [:]
    private var builtAt = Date.distantPast
    private var observing = false

    private init() {}

    /// The key for `ch`, or nil. Call off the main thread (the layout is read there, as the Text Input APIs require).
    func stroke(for ch: Character) -> Stroke? {
        lock.lock()
        let stale = Date().timeIntervalSince(builtAt) > 30
        lock.unlock()
        if stale { refresh() }
        lock.lock(); defer { lock.unlock() }
        return strokes[ch]
    }

    private func refresh() {
        let built = Thread.isMainThread ? Self.build() : DispatchQueue.main.sync { Self.build() }
        lock.lock()
        strokes = built
        builtAt = Date()
        let watch = !observing
        observing = true
        lock.unlock()
        // Another layout picked from the menu (or the lock screen's own): read it again on the next character.
        if watch {
            DistributedNotificationCenter.default().addObserver(
                forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil, queue: nil
            ) { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self.builtAt = .distantPast; self.lock.unlock()
            }
        }
    }

    /// Every character the current layout types with one key, alone or with Shift (the plainer one wins when two keys type it).
    private static func build() -> [Character: Stroke] {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        return build(layout: data, keyboardType: UInt32(LMGetKbdType()))
    }

    /// The main block: letters, digits, punctuation, space (the keypad and function keys type nothing new), then a JIS
    /// keyboard's ¥ and _ keys: on a Mac with one, `_`, `¥` and `|` are only there.
    static let typingKeys = Array(0...0x32) + [0x5D, 0x5E]

    /// The keys of a layout (its 'uchr' data) for a keyboard type (LMGetKbdType: ANSI, ISO or JIS).
    static func build(layout data: Data, keyboardType: UInt32) -> [Character: Stroke] {
        var result: [Character: Stroke] = [:]
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            for shift in [false, true] {
                let modifiers: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xFF) : 0
                for code in typingKeys {
                    var deadKeyState: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers, keyboardType,
                                                0, &deadKeyState, chars.count, &length, &chars)
                    // A dead key (´ then e = é) types nothing by itself: it's no key for a character.
                    guard status == noErr, deadKeyState == 0, length > 0 else { continue }
                    let s = String(utf16CodeUnits: chars, count: length)
                    guard s.count == 1, let ch = s.first,
                          ch.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { continue }
                    if result[ch] == nil { result[ch] = Stroke(code: CGKeyCode(code), shift: shift) }
                }
            }
        }
        return result
    }
}
