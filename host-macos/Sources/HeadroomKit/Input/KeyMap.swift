import CoreGraphics

/// W3C KeyboardEvent.code -> macOS virtual key code (the kVK_* constants from HIToolbox/Events.h).
/// Virtual key codes are positional, so the Mac's keyboard layout decides which character is typed —
/// exactly what a physical keyboard plugged into the Mac would do, and what makes every shortcut work.
/// PC-only keys follow Apple's own mapping for PC keyboards (Insert = Help, PrtScn/ScrLk/Pause = F13/F14/F15).
public enum KeyMap {
    public struct Key {
        public let code: CGKeyCode
        /// Flags a real keyboard sets on this key's events (keypad, fn-row/navigation keys).
        public let flags: CGEventFlags
        /// For modifier keys: the flag this key contributes while held.
        public let modifier: CGEventFlags?
        /// For media keys: NX_KEYTYPE_* sent as a system-defined event instead of a key event.
        public let media: Int32?
    }

    public static func get(_ code: String) -> Key? { map[code] }

    public static func isModifier(_ code: String) -> Bool { map[code]?.modifier != nil }

    private static let fn = CGEventFlags.maskSecondaryFn
    private static let pad = CGEventFlags.maskNumericPad

    private static func k(_ c: CGKeyCode, _ flags: CGEventFlags = []) -> Key { Key(code: c, flags: flags, modifier: nil, media: nil) }
    private static func m(_ c: CGKeyCode, _ mod: CGEventFlags) -> Key { Key(code: c, flags: [], modifier: mod, media: nil) }
    private static func media(_ t: Int32) -> Key { Key(code: 0, flags: [], modifier: nil, media: t) }

    // Device-dependent modifier bits (IOLLEvent.h: NX_DEVICEL*KEYMASK); apps use them to tell left from right.
    static let leftControl = CGEventFlags(rawValue: 0x01), leftShift = CGEventFlags(rawValue: 0x02), rightShift = CGEventFlags(rawValue: 0x04)
    static let leftCommand = CGEventFlags(rawValue: 0x08), rightCommand = CGEventFlags(rawValue: 0x10)
    static let leftOption = CGEventFlags(rawValue: 0x20), rightOption = CGEventFlags(rawValue: 0x40), rightControl = CGEventFlags(rawValue: 0x2000)

    private static let map: [String: Key] = {
        var t: [String: Key] = [
            "KeyA": k(0x00), "KeyS": k(0x01), "KeyD": k(0x02), "KeyF": k(0x03), "KeyH": k(0x04), "KeyG": k(0x05),
            "KeyZ": k(0x06), "KeyX": k(0x07), "KeyC": k(0x08), "KeyV": k(0x09), "IntlBackslash": k(0x0A), "KeyB": k(0x0B),
            "KeyQ": k(0x0C), "KeyW": k(0x0D), "KeyE": k(0x0E), "KeyR": k(0x0F), "KeyY": k(0x10), "KeyT": k(0x11),
            "Digit1": k(0x12), "Digit2": k(0x13), "Digit3": k(0x14), "Digit4": k(0x15), "Digit6": k(0x16), "Digit5": k(0x17),
            "Equal": k(0x18), "Digit9": k(0x19), "Digit7": k(0x1A), "Minus": k(0x1B), "Digit8": k(0x1C), "Digit0": k(0x1D),
            "BracketRight": k(0x1E), "KeyO": k(0x1F), "KeyU": k(0x20), "BracketLeft": k(0x21), "KeyI": k(0x22), "KeyP": k(0x23),
            "Enter": k(0x24), "KeyL": k(0x25), "KeyJ": k(0x26), "Quote": k(0x27), "KeyK": k(0x28), "Semicolon": k(0x29),
            "Backslash": k(0x2A), "Comma": k(0x2B), "Slash": k(0x2C), "KeyN": k(0x2D), "KeyM": k(0x2E), "Period": k(0x2F),
            "Tab": k(0x30), "Space": k(0x31), "Backquote": k(0x32), "Backspace": k(0x33), "Escape": k(0x35),

            // Modifiers (left/right distinguished, like the hardware).
            "MetaLeft": m(0x37, [.maskCommand, leftCommand]), "MetaRight": m(0x36, [.maskCommand, rightCommand]),
            "OSLeft": m(0x37, [.maskCommand, leftCommand]), "OSRight": m(0x36, [.maskCommand, rightCommand]),
            "ShiftLeft": m(0x38, [.maskShift, leftShift]), "ShiftRight": m(0x3C, [.maskShift, rightShift]),
            "AltLeft": m(0x3A, [.maskAlternate, leftOption]), "AltRight": m(0x3D, [.maskAlternate, rightOption]),
            "ControlLeft": m(0x3B, [.maskControl, leftControl]), "ControlRight": m(0x3E, [.maskControl, rightControl]),
            "Fn": m(0x3F, .maskSecondaryFn),
            "CapsLock": k(0x39),

            // Keypad
            "NumpadDecimal": k(0x41, pad), "NumpadMultiply": k(0x43, pad), "NumpadAdd": k(0x45, pad), "NumLock": k(0x47, pad),
            "NumpadDivide": k(0x4B, pad), "NumpadEnter": k(0x4C, pad), "NumpadSubtract": k(0x4E, pad), "NumpadEqual": k(0x51, pad),
            "Numpad0": k(0x52, pad), "Numpad1": k(0x53, pad), "Numpad2": k(0x54, pad), "Numpad3": k(0x55, pad), "Numpad4": k(0x56, pad),
            "Numpad5": k(0x57, pad), "Numpad6": k(0x58, pad), "Numpad7": k(0x59, pad), "Numpad8": k(0x5B, pad), "Numpad9": k(0x5C, pad),
            "NumpadComma": k(0x5F, pad),

            // Function row
            "F1": k(0x7A, fn), "F2": k(0x78, fn), "F3": k(0x63, fn), "F4": k(0x76, fn), "F5": k(0x60, fn), "F6": k(0x61, fn),
            "F7": k(0x62, fn), "F8": k(0x64, fn), "F9": k(0x65, fn), "F10": k(0x6D, fn), "F11": k(0x67, fn), "F12": k(0x6F, fn),
            "F13": k(0x69, fn), "F14": k(0x6B, fn), "F15": k(0x71, fn), "F16": k(0x6A, fn), "F17": k(0x40, fn), "F18": k(0x4F, fn),
            "F19": k(0x50, fn), "F20": k(0x5A, fn),
            // PC keys, as macOS maps a PC keyboard
            "PrintScreen": k(0x69, fn), "ScrollLock": k(0x6B, fn), "Pause": k(0x71, fn),

            // Navigation
            "Insert": k(0x72, fn), "Help": k(0x72, fn), "Home": k(0x73, fn), "PageUp": k(0x74, fn), "Delete": k(0x75, fn),
            "End": k(0x77, fn), "PageDown": k(0x79, fn),
            "ArrowLeft": k(0x7B, [fn, pad]), "ArrowRight": k(0x7C, [fn, pad]), "ArrowDown": k(0x7D, [fn, pad]), "ArrowUp": k(0x7E, [fn, pad]),
            "ContextMenu": k(0x6E),

            // International
            "IntlYen": k(0x5D), "IntlRo": k(0x5E), "Lang1": k(0x68), "KanaMode": k(0x68), "Lang2": k(0x66),

            // Media keys are system-defined events (NX_KEYTYPE_*), not key codes.
            "AudioVolumeUp": media(0), "VolumeUp": media(0), "AudioVolumeDown": media(1), "VolumeDown": media(1),
            "AudioVolumeMute": media(7), "VolumeMute": media(7),
            "MediaPlayPause": media(16), "MediaTrackNext": media(17), "MediaTrackPrevious": media(18),
            "BrightnessUp": media(2), "BrightnessDown": media(3),
        ]
        t["NumpadClear"] = t["NumLock"]
        return t
    }()
}
