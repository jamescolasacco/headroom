using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Headroom.Host.Platform;
using Headroom.Host.Util;

namespace Headroom.Host.Input;

/// <summary>Per-viewer record of what's held down, so a dropped connection never leaves keys stuck.</summary>
public sealed class InputContext
{
    internal readonly HashSet<string> Keys = new();
    internal readonly HashSet<int> Buttons = new();
}

/// <summary>
/// Injects mouse/keyboard input with SendInput on one dedicated thread. That thread follows the input
/// desktop so injection keeps working on UAC prompts / the lock screen when running as SYSTEM.
/// </summary>
public sealed unsafe class InputInjector
{
    public static InputInjector Instance { get; } = new();

    private readonly BlockingCollection<Action> _queue = new(new ConcurrentQueue<Action>(), 4096);
    private readonly Thread _thread;
    private readonly InputDesktopFollower _desktop = new();
    private int _pendingMoves;
    private int _lastX = int.MinValue, _lastY = int.MinValue;

    public bool LastInjectionBlocked { get; private set; }

    private InputInjector()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "input-injector", Priority = ThreadPriority.Highest };
        _thread.Start();
    }

    private void Run()
    {
        _desktop.Sync();
        foreach (var action in _queue.GetConsumingEnumerable())
        {
            try
            {
                _desktop.Sync(100);
                action();
            }
            catch (Exception ex)
            {
                Log.Error("input", "injection failed", ex);
            }
        }
    }

    private void Post(Action a)
    {
        if (!_queue.TryAdd(a)) Log.Warn("input", "input queue full; dropping event");
    }

    private bool Send(ReadOnlySpan<Native.INPUT> inputs)
    {
        fixed (Native.INPUT* p = inputs)
        {
            uint sent = Native.SendInput((uint)inputs.Length, p, sizeof(Native.INPUT));
            if (sent == inputs.Length)
            {
                LastInjectionBlocked = false;
                return true;
            }
            // Usually the input desktop changed (or UIPI blocked us). Re-attach and retry once.
            _desktop.Sync(0);
            sent = Native.SendInput((uint)inputs.Length, p, sizeof(Native.INPUT));
            LastInjectionBlocked = sent != inputs.Length;
            if (LastInjectionBlocked) Log.Debug("input", $"SendInput blocked (err {Marshal.GetLastWin32Error()})");
            return !LastInjectionBlocked;
        }
    }

    // --------------------------------------------------------------------------------------- mouse

    /// <summary>Move to an absolute position in virtual-desktop pixels.</summary>
    public void MoveTo(int x, int y)
    {
        Interlocked.Increment(ref _pendingMoves);
        Post(() =>
        {
            // Coalesce: if newer moves are queued behind us, skip this one.
            if (Interlocked.Decrement(ref _pendingMoves) > 0) return;
            if (x == _lastX && y == _lastY) return;
            _lastX = x; _lastY = y;
            int vl = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vt = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Math.Max(1, Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN));
            int vh = Math.Max(1, Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
            // Windows maps normalized -> pixel as floor(n * size / 65536). Aim for the pixel's centre
            // so rounding can never land on the neighbour (the classic off-by-one at the far edge).
            int nx = (int)Math.Clamp((((long)(x - vl) * 2 + 1) * 65536) / (2L * vw), 0, 65535);
            int ny = (int)Math.Clamp((((long)(y - vt) * 2 + 1) * 65536) / (2L * vh), 0, 65535);
            Span<Native.INPUT> input = stackalloc Native.INPUT[1];
            input[0].type = Native.INPUT_MOUSE;
            input[0].mi = new Native.MOUSEINPUT
            {
                dx = nx, dy = ny,
                dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK,
                dwExtraInfo = Native.InjectedTag,
            };
            Send(input);
        });
    }

    /// <summary>Relative motion (pointer lock / games). Not subject to Windows pointer acceleration? It is — like a real mouse.</summary>
    public void MoveBy(int dx, int dy)
    {
        Post(() =>
        {
            _lastX = int.MinValue;
            Span<Native.INPUT> input = stackalloc Native.INPUT[1];
            input[0].type = Native.INPUT_MOUSE;
            input[0].mi = new Native.MOUSEINPUT { dx = dx, dy = dy, dwFlags = Native.MOUSEEVENTF_MOVE, dwExtraInfo = Native.InjectedTag };
            Send(input);
        });
    }

    /// <summary>0 left, 1 middle, 2 right, 3 back (X1), 4 forward (X2) — same numbering as MouseEvent.button.</summary>
    public void Button(InputContext ctx, int button, bool down)
    {
        if (button is < 0 or > 4) return;
        lock (ctx) { if (down) ctx.Buttons.Add(button); else ctx.Buttons.Remove(button); }
        Post(() => SendButton(button, down));
    }

    private void SendButton(int button, bool down)
    {
        uint flags; uint data = 0;
        switch (button)
        {
            case 0: flags = down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP; break;
            case 1: flags = down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP; break;
            case 2: flags = down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP; break;
            case 3: flags = down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP; data = Native.XBUTTON1; break;
            default: flags = down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP; data = Native.XBUTTON2; break;
        }
        Span<Native.INPUT> input = stackalloc Native.INPUT[1];
        input[0].type = Native.INPUT_MOUSE;
        input[0].mi = new Native.MOUSEINPUT { dwFlags = flags, mouseData = data, dwExtraInfo = Native.InjectedTag };
        Send(input);
    }

    /// <summary>Wheel in WHEEL_DELTA units (120 = one notch); fractions give smooth trackpad scrolling. +dy = away from user (up).</summary>
    public void Wheel(int dx, int dy)
    {
        Post(() =>
        {
            Span<Native.INPUT> input = stackalloc Native.INPUT[2];
            int n = 0;
            if (dy != 0)
            {
                input[n].type = Native.INPUT_MOUSE;
                input[n++].mi = new Native.MOUSEINPUT { dwFlags = Native.MOUSEEVENTF_WHEEL, mouseData = unchecked((uint)dy), dwExtraInfo = Native.InjectedTag };
            }
            if (dx != 0)
            {
                input[n].type = Native.INPUT_MOUSE;
                input[n++].mi = new Native.MOUSEINPUT { dwFlags = Native.MOUSEEVENTF_HWHEEL, mouseData = unchecked((uint)dx), dwExtraInfo = Native.InjectedTag };
            }
            if (n > 0) Send(input[..n]);
        });
    }

    // --------------------------------------------------------------------------------------- keyboard

    public void Key(InputContext ctx, string code, bool down)
    {
        if (!KeyMap.TryGet(code, out var key)) return;
        lock (ctx) { if (down) ctx.Keys.Add(code); else ctx.Keys.Remove(code); }
        Post(() => SendKey(key, down));
    }

    private void SendKey(KeyMap.Key key, bool down)
    {
        Span<Native.INPUT> input = stackalloc Native.INPUT[1];
        input[0].type = Native.INPUT_KEYBOARD;
        if (key.Vk != 0)
        {
            input[0].ki = new Native.KEYBDINPUT
            {
                wVk = key.Vk,
                wScan = (ushort)Native.MapVirtualKeyW(key.Vk, 0),
                dwFlags = (key.Extended ? Native.KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : Native.KEYEVENTF_KEYUP),
                dwExtraInfo = Native.InjectedTag,
            };
        }
        else
        {
            input[0].ki = new Native.KEYBDINPUT
            {
                wScan = key.Scan,
                dwFlags = Native.KEYEVENTF_SCANCODE | (key.Extended ? Native.KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : Native.KEYEVENTF_KEYUP),
                dwExtraInfo = Native.InjectedTag,
            };
        }
        Send(input);
    }

    /// <summary>Types text independent of the host keyboard layout (soft keyboards, dictation, IME, paste-as-keys).</summary>
    public void Text(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        Post(() =>
        {
            Span<Native.INPUT> input = stackalloc Native.INPUT[2];
            foreach (var ch in text.Replace("\r\n", "\n"))
            {
                if (ch == '\n' || ch == '\r') { TapKey("Enter"); continue; }
                if (ch == '\t') { TapKey("Tab"); continue; }
                if (ch == '\b') { TapKey("Backspace"); continue; }
                input[0].type = Native.INPUT_KEYBOARD;
                input[0].ki = new Native.KEYBDINPUT { wScan = ch, dwFlags = Native.KEYEVENTF_UNICODE, dwExtraInfo = Native.InjectedTag };
                input[1].type = Native.INPUT_KEYBOARD;
                input[1].ki = new Native.KEYBDINPUT { wScan = ch, dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP, dwExtraInfo = Native.InjectedTag };
                Send(input);
            }
        });
    }

    private void TapKey(string code)
    {
        if (!KeyMap.TryGet(code, out var key)) return;
        SendKey(key, true);
        SendKey(key, false);
    }

    /// <summary>Press a chord (e.g. Ctrl+Shift+Esc) and release in reverse order.</summary>
    public void Chord(params string[] codes)
    {
        Post(() =>
        {
            foreach (var c in codes) if (KeyMap.TryGet(c, out var k)) SendKey(k, true);
            for (int i = codes.Length - 1; i >= 0; i--) if (KeyMap.TryGet(codes[i], out var k)) SendKey(k, false);
        });
    }

    /// <summary>Make the host's Caps/Num/Scroll Lock match the viewer's so typed text has the right case.</summary>
    public void SyncLocks(bool caps, bool num, bool? scroll)
    {
        Post(() =>
        {
            if (((Native.GetKeyState(0x14) & 1) != 0) != caps) TapKey("CapsLock");
            if (((Native.GetKeyState(0x90) & 1) != 0) != num) TapKey("NumLock");
            if (scroll is bool s && ((Native.GetKeyState(0x91) & 1) != 0) != s) TapKey("ScrollLock");
        });
    }

    /// <summary>Releases everything this viewer still holds (disconnect, focus loss, tab switch).</summary>
    public void ReleaseAll(InputContext ctx)
    {
        string[] keys;
        int[] buttons;
        lock (ctx)
        {
            keys = ctx.Keys.ToArray();
            buttons = ctx.Buttons.ToArray();
            ctx.Keys.Clear();
            ctx.Buttons.Clear();
        }
        if (keys.Length == 0 && buttons.Length == 0) return;
        Post(() =>
        {
            foreach (var code in keys) if (KeyMap.TryGet(code, out var k)) SendKey(k, false);
            foreach (var b in buttons) SendButton(b, false);
        });
    }

    // --------------------------------------------------------------------------------------- system

    public static bool IsSystem
    {
        get
        {
            using var id = System.Security.Principal.WindowsIdentity.GetCurrent();
            return id.IsSystem;
        }
    }

    /// <summary>Ctrl+Alt+Del. Real SAS needs SYSTEM (service mode); returns false if unavailable.</summary>
    public bool SecureAttention()
    {
        if (!IsSystem) return false;
        try
        {
            Native.SendSAS(false);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("input", $"SendSAS failed: {ex.Message}");
            return false;
        }
    }

    public void LockWorkstation() => Post(() => Native.LockWorkStation());
}
