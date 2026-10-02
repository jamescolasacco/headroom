using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Headroom.Viewer;

/// <summary>
/// Captures the shortcuts Windows (not the page) would otherwise act on — Win (and anything pressed with it),
/// Alt+Tab, Alt+Esc, Alt+F4, Alt+Space, Ctrl+Esc, Ctrl+Shift+Esc, PrtScn — while a viewer window with an active
/// session is in the foreground, and forwards them to the remote computer instead.
/// Everything else is left to the normal browser keyboard path. Only installed while a session is active.
/// </summary>
public sealed class KeyboardHook : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
    private const uint LLKHF_EXTENDED = 0x01, LLKHF_INJECTED = 0x10, LLKHF_ALTDOWN = 0x20;
    private const uint VK_TAB = 0x09, VK_ESCAPE = 0x1B, VK_SPACE = 0x20, VK_SNAPSHOT = 0x2C, VK_LWIN = 0x5B, VK_RWIN = 0x5C,
        VK_F4 = 0x73, VK_CONTROL = 0x11;

    private delegate nint HookProc(int nCode, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public nint dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetWindowsHookExW(int idHook, HookProc fn, nint hMod, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(nint hhk);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hhk, int nCode, nint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vk);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandleW(string? name);

    private readonly HookProc _proc;
    private readonly Func<nint, ViewerWindow?> _sessionWindowFor;
    private nint _hook;
    private readonly Dictionary<uint, ViewerWindow> _captured = new(); // vk -> window that got its keydown
    private ViewerWindow? _winHeldBy;

    /// <param name="sessionWindowFor">Maps the foreground HWND to a viewer window with an active session, or null.</param>
    public KeyboardHook(Func<nint, ViewerWindow?> sessionWindowFor)
    {
        _sessionWindowFor = sessionWindowFor;
        _proc = Proc; // keep the delegate alive while hooked
    }

    public bool Installed => _hook != 0;

    public void Install()
    {
        if (_hook != 0) return;
        _hook = SetWindowsHookExW(WH_KEYBOARD_LL, _proc, GetModuleHandleW(null), 0);
        if (_hook == 0) Debug.WriteLine($"SetWindowsHookEx failed: {Marshal.GetLastWin32Error()}");
    }

    public void Uninstall()
    {
        if (_hook == 0) return;
        // Release anything still held remotely so nothing sticks.
        foreach (var (vk, w) in _captured.ToList()) Forward(w, vk, 0, false, false);
        _captured.Clear();
        _winHeldBy = null;
        UnhookWindowsHookEx(_hook);
        _hook = 0;
    }

    private nint Proc(int nCode, nint wParam, nint lParam)
    {
        if (nCode < 0) return CallNextHookEx(_hook, nCode, wParam, lParam);
        var kb = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        if ((kb.flags & LLKHF_INJECTED) != 0) return CallNextHookEx(_hook, nCode, wParam, lParam);
        int msg = (int)wParam;
        bool down = msg is WM_KEYDOWN or WM_SYSKEYDOWN;
        bool up = msg is WM_KEYUP or WM_SYSKEYUP;
        if (!down && !up) return CallNextHookEx(_hook, nCode, wParam, lParam);
        uint vk = kb.vkCode;
        bool extended = (kb.flags & LLKHF_EXTENDED) != 0;

        if (up)
        {
            // Releases of keys we captured go to the same window even if focus moved meanwhile.
            if (_captured.Remove(vk, out var owner))
            {
                if (vk is VK_LWIN or VK_RWIN) _winHeldBy = null;
                Forward(owner, vk, kb.scanCode, extended, false);
                return 1;
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        var window = _sessionWindowFor(GetForegroundWindow());
        if (window == null) return CallNextHookEx(_hook, nCode, wParam, lParam);

        bool alt = (kb.flags & LLKHF_ALTDOWN) != 0;
        bool ctrl = (GetAsyncKeyState((int)VK_CONTROL) & 0x8000) != 0;
        bool capture =
            vk is VK_LWIN or VK_RWIN ||
            _winHeldBy != null ||                                   // Win+anything
            (alt && vk is VK_TAB or VK_ESCAPE or VK_F4 or VK_SPACE) || // task switching, window menu, close
            (ctrl && vk == VK_ESCAPE) ||                            // Start menu / Task Manager
            vk == VK_SNAPSHOT;                                      // screenshots
        if (!capture) return CallNextHookEx(_hook, nCode, wParam, lParam);

        if (vk is VK_LWIN or VK_RWIN) _winHeldBy = window;
        _captured[vk] = window;
        Forward(window, vk, kb.scanCode, extended, true);
        return 1; // swallow: Windows never sees it
    }

    private static void Forward(ViewerWindow window, uint vk, uint scan, bool extended, bool down)
    {
        var code = KeyCodes.ToCode(scan, extended, vk);
        if (code != null) window.PostJson(new { type = "nativeKey", code, down });
    }

    public void Dispose() => Uninstall();
}

/// <summary>Scancode (+E0) / virtual key -> W3C KeyboardEvent.code. Mirror of the host's KeyMap.</summary>
public static class KeyCodes
{
    private static readonly string?[] Normal = BuildNormal();
    private static readonly Dictionary<uint, string> Extended = new()
    {
        [0x1C] = "NumpadEnter", [0x1D] = "ControlRight", [0x35] = "NumpadDivide", [0x37] = "PrintScreen", [0x38] = "AltRight",
        [0x47] = "Home", [0x48] = "ArrowUp", [0x49] = "PageUp", [0x4B] = "ArrowLeft", [0x4D] = "ArrowRight", [0x4F] = "End",
        [0x50] = "ArrowDown", [0x51] = "PageDown", [0x52] = "Insert", [0x53] = "Delete", [0x5B] = "MetaLeft", [0x5C] = "MetaRight",
        [0x5D] = "ContextMenu",
    };
    private static readonly Dictionary<uint, string> ByVk = new()
    {
        [0x2C] = "PrintScreen", [0x5B] = "MetaLeft", [0x5C] = "MetaRight", [0x13] = "Pause", [0x90] = "NumLock",
        [0xAD] = "AudioVolumeMute", [0xAE] = "AudioVolumeDown", [0xAF] = "AudioVolumeUp", [0xB0] = "MediaTrackNext",
        [0xB1] = "MediaTrackPrevious", [0xB2] = "MediaStop", [0xB3] = "MediaPlayPause",
    };

    public static string? ToCode(uint scan, bool extended, uint vk)
    {
        if (ByVk.TryGetValue(vk, out var byVk)) return byVk;
        if (extended) return Extended.TryGetValue(scan, out var e) ? e : null;
        return scan < Normal.Length ? Normal[scan] : null;
    }

    private static string?[] BuildNormal()
    {
        var a = new string?[0x80];
        void Set(uint s, string c) => a[s] = c;
        Set(0x01, "Escape");
        for (uint i = 0; i < 9; i++) Set(0x02 + i, $"Digit{i + 1}");
        Set(0x0B, "Digit0"); Set(0x0C, "Minus"); Set(0x0D, "Equal"); Set(0x0E, "Backspace"); Set(0x0F, "Tab");
        var row1 = "QWERTYUIOP"; for (int i = 0; i < row1.Length; i++) Set(0x10 + (uint)i, $"Key{row1[i]}");
        Set(0x1A, "BracketLeft"); Set(0x1B, "BracketRight"); Set(0x1C, "Enter"); Set(0x1D, "ControlLeft");
        var row2 = "ASDFGHJKL"; for (int i = 0; i < row2.Length; i++) Set(0x1E + (uint)i, $"Key{row2[i]}");
        Set(0x27, "Semicolon"); Set(0x28, "Quote"); Set(0x29, "Backquote"); Set(0x2A, "ShiftLeft"); Set(0x2B, "Backslash");
        var row3 = "ZXCVBNM"; for (int i = 0; i < row3.Length; i++) Set(0x2C + (uint)i, $"Key{row3[i]}");
        Set(0x33, "Comma"); Set(0x34, "Period"); Set(0x35, "Slash"); Set(0x36, "ShiftRight"); Set(0x37, "NumpadMultiply");
        Set(0x38, "AltLeft"); Set(0x39, "Space"); Set(0x3A, "CapsLock");
        for (uint i = 0; i < 10; i++) Set(0x3B + i, $"F{i + 1}");
        Set(0x46, "ScrollLock"); Set(0x47, "Numpad7"); Set(0x48, "Numpad8"); Set(0x49, "Numpad9"); Set(0x4A, "NumpadSubtract");
        Set(0x4B, "Numpad4"); Set(0x4C, "Numpad5"); Set(0x4D, "Numpad6"); Set(0x4E, "NumpadAdd"); Set(0x4F, "Numpad1");
        Set(0x50, "Numpad2"); Set(0x51, "Numpad3"); Set(0x52, "Numpad0"); Set(0x53, "NumpadDecimal"); Set(0x56, "IntlBackslash");
        Set(0x57, "F11"); Set(0x58, "F12"); Set(0x59, "NumpadEqual");
        for (uint i = 0; i < 6; i++) Set(0x64 + i, $"F{13 + i}");
        for (uint i = 0; i < 5; i++) Set(0x6A + i, $"F{19 + i}");
        Set(0x76, "F24");
        return a;
    }
}
