namespace Headroom.Host.Input;

/// <summary>
/// W3C KeyboardEvent.code -> PC/AT set-1 scancode (+E0 "extended" flag), or a virtual key for keys that
/// are better injected as VKs (media/browser keys, Pause, PrintScreen, NumLock).
/// Scancodes are positional, so the host's keyboard layout decides which character is typed — exactly
/// what a physical keyboard plugged into the host would do, and what makes every shortcut work.
/// </summary>
public static class KeyMap
{
    public readonly record struct Key(ushort Scan, bool Extended, ushort Vk);

    private static readonly Dictionary<string, Key> Map = Build();

    public static bool TryGet(string code, out Key key) => Map.TryGetValue(code, out key);

    private static Key S(ushort scan) => new(scan, false, 0);
    private static Key E(ushort scan) => new(scan, true, 0);
    private static Key V(ushort vk, bool extended = false) => new(0, extended, vk);

    private static Dictionary<string, Key> Build()
    {
        var m = new Dictionary<string, Key>(StringComparer.Ordinal)
        {
            ["Escape"] = S(0x01),
            ["Digit1"] = S(0x02), ["Digit2"] = S(0x03), ["Digit3"] = S(0x04), ["Digit4"] = S(0x05), ["Digit5"] = S(0x06),
            ["Digit6"] = S(0x07), ["Digit7"] = S(0x08), ["Digit8"] = S(0x09), ["Digit9"] = S(0x0A), ["Digit0"] = S(0x0B),
            ["Minus"] = S(0x0C), ["Equal"] = S(0x0D), ["Backspace"] = S(0x0E), ["Tab"] = S(0x0F),
            ["KeyQ"] = S(0x10), ["KeyW"] = S(0x11), ["KeyE"] = S(0x12), ["KeyR"] = S(0x13), ["KeyT"] = S(0x14),
            ["KeyY"] = S(0x15), ["KeyU"] = S(0x16), ["KeyI"] = S(0x17), ["KeyO"] = S(0x18), ["KeyP"] = S(0x19),
            ["BracketLeft"] = S(0x1A), ["BracketRight"] = S(0x1B), ["Enter"] = S(0x1C), ["ControlLeft"] = S(0x1D),
            ["KeyA"] = S(0x1E), ["KeyS"] = S(0x1F), ["KeyD"] = S(0x20), ["KeyF"] = S(0x21), ["KeyG"] = S(0x22),
            ["KeyH"] = S(0x23), ["KeyJ"] = S(0x24), ["KeyK"] = S(0x25), ["KeyL"] = S(0x26),
            ["Semicolon"] = S(0x27), ["Quote"] = S(0x28), ["Backquote"] = S(0x29), ["ShiftLeft"] = S(0x2A), ["Backslash"] = S(0x2B),
            ["KeyZ"] = S(0x2C), ["KeyX"] = S(0x2D), ["KeyC"] = S(0x2E), ["KeyV"] = S(0x2F), ["KeyB"] = S(0x30),
            ["KeyN"] = S(0x31), ["KeyM"] = S(0x32), ["Comma"] = S(0x33), ["Period"] = S(0x34), ["Slash"] = S(0x35),
            ["ShiftRight"] = S(0x36), ["NumpadMultiply"] = S(0x37), ["AltLeft"] = S(0x38), ["Space"] = S(0x39), ["CapsLock"] = S(0x3A),
            ["F1"] = S(0x3B), ["F2"] = S(0x3C), ["F3"] = S(0x3D), ["F4"] = S(0x3E), ["F5"] = S(0x3F),
            ["F6"] = S(0x40), ["F7"] = S(0x41), ["F8"] = S(0x42), ["F9"] = S(0x43), ["F10"] = S(0x44),
            ["ScrollLock"] = S(0x46),
            ["Numpad7"] = S(0x47), ["Numpad8"] = S(0x48), ["Numpad9"] = S(0x49), ["NumpadSubtract"] = S(0x4A),
            ["Numpad4"] = S(0x4B), ["Numpad5"] = S(0x4C), ["Numpad6"] = S(0x4D), ["NumpadAdd"] = S(0x4E),
            ["Numpad1"] = S(0x4F), ["Numpad2"] = S(0x50), ["Numpad3"] = S(0x51), ["Numpad0"] = S(0x52), ["NumpadDecimal"] = S(0x53),
            ["IntlBackslash"] = S(0x56), ["F11"] = S(0x57), ["F12"] = S(0x58), ["NumpadEqual"] = S(0x59),
            ["F13"] = S(0x64), ["F14"] = S(0x65), ["F15"] = S(0x66), ["F16"] = S(0x67), ["F17"] = S(0x68), ["F18"] = S(0x69),
            ["F19"] = S(0x6A), ["F20"] = S(0x6B), ["F21"] = S(0x6C), ["F22"] = S(0x6D), ["F23"] = S(0x6E), ["F24"] = S(0x76),
            ["KanaMode"] = S(0x70), ["Lang2"] = S(0x71), ["Lang1"] = S(0x72), ["IntlRo"] = S(0x73),
            ["Convert"] = S(0x79), ["NonConvert"] = S(0x7B), ["IntlYen"] = S(0x7D), ["NumpadComma"] = S(0x7E),

            // E0-prefixed
            ["NumpadEnter"] = E(0x1C), ["ControlRight"] = E(0x1D), ["NumpadDivide"] = E(0x35), ["AltRight"] = E(0x38),
            ["Home"] = E(0x47), ["ArrowUp"] = E(0x48), ["PageUp"] = E(0x49), ["ArrowLeft"] = E(0x4B), ["ArrowRight"] = E(0x4D),
            ["End"] = E(0x4F), ["ArrowDown"] = E(0x50), ["PageDown"] = E(0x51), ["Insert"] = E(0x52), ["Delete"] = E(0x53),
            ["MetaLeft"] = E(0x5B), ["MetaRight"] = E(0x5C), ["OSLeft"] = E(0x5B), ["OSRight"] = E(0x5C), ["ContextMenu"] = E(0x5D),

            // Keys with special scancode sequences or no layout entry: inject as VKs.
            ["PrintScreen"] = V(0x2C, true),      // VK_SNAPSHOT
            ["Pause"] = V(0x13),                  // VK_PAUSE (E1 1D 45 can't be expressed as one scancode)
            ["NumLock"] = V(0x90, true),          // VK_NUMLOCK (scancode 0x45 collides with Pause)
            ["Power"] = E(0x5E), ["Sleep"] = V(0x5F), ["WakeUp"] = E(0x63),
            ["AudioVolumeMute"] = V(0xAD, true), ["AudioVolumeDown"] = V(0xAE, true), ["AudioVolumeUp"] = V(0xAF, true),
            ["VolumeMute"] = V(0xAD, true), ["VolumeDown"] = V(0xAE, true), ["VolumeUp"] = V(0xAF, true),
            ["MediaTrackNext"] = V(0xB0, true), ["MediaTrackPrevious"] = V(0xB1, true), ["MediaStop"] = V(0xB2, true),
            ["MediaPlayPause"] = V(0xB3, true), ["LaunchMail"] = V(0xB4, true), ["MediaSelect"] = V(0xB5, true),
            ["LaunchMediaPlayer"] = V(0xB5, true), ["LaunchApp1"] = V(0xB6, true), ["LaunchApp2"] = V(0xB7, true),
            ["BrowserBack"] = V(0xA6, true), ["BrowserForward"] = V(0xA7, true), ["BrowserRefresh"] = V(0xA8, true),
            ["BrowserStop"] = V(0xA9, true), ["BrowserSearch"] = V(0xAA, true), ["BrowserFavorites"] = V(0xAB, true),
            ["BrowserHome"] = V(0xAC, true),
        };
        return m;
    }

    public static bool IsModifier(string code) => code is "ShiftLeft" or "ShiftRight" or "ControlLeft" or "ControlRight"
        or "AltLeft" or "AltRight" or "MetaLeft" or "MetaRight" or "OSLeft" or "OSRight";
}
