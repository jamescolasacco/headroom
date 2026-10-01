using System.Runtime.InteropServices;
using Headroom.Host.Util;

namespace Headroom.Host.Services;

/// <summary>
/// Text clipboard sync. A message-only window on its own thread listens for WM_CLIPBOARDUPDATE
/// (AddClipboardFormatListener) and raises <see cref="Changed"/>; writes are marshalled onto the same
/// thread. Our own writes are recognised by clipboard sequence number so they don't echo back.
/// </summary>
public sealed unsafe class ClipboardService
{
    public static ClipboardService Instance { get; } = new();

    public event Action<string>? Changed;

    private const uint WM_CLIPBOARDUPDATE = 0x031D;
    private const uint WM_APP_SET = 0x8001;
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;
    private static readonly nint HWND_MESSAGE = -3;

    private readonly Thread _thread;
    private nint _hwnd;
    private readonly ManualResetEventSlim _ready = new();
    private readonly Queue<string> _toSet = new();
    private uint _ownSequence;
    private string? _lastText;
    private WndProc? _proc; // keep delegate alive

    private delegate nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam);

    private ClipboardService()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "clipboard" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        _ready.Wait(3000);
    }

    private void Run()
    {
        try
        {
            _proc = WindowProc;
            var className = "HeadroomClipboard_" + Environment.ProcessId;
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)Marshal.SizeOf<WNDCLASSEXW>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_proc),
                hInstance = GetModuleHandleW(null),
                lpszClassName = className,
            };
            if (RegisterClassExW(ref wc) == 0) throw new InvalidOperationException($"RegisterClassEx failed {Marshal.GetLastWin32Error()}");
            _hwnd = CreateWindowExW(0, className, "Headroom clipboard", 0, 0, 0, 0, 0, HWND_MESSAGE, 0, wc.hInstance, 0);
            if (_hwnd == 0) throw new InvalidOperationException($"CreateWindowEx failed {Marshal.GetLastWin32Error()}");
            if (!AddClipboardFormatListener(_hwnd)) Log.Warn("clipboard", $"AddClipboardFormatListener failed {Marshal.GetLastWin32Error()}");
            _lastText = ReadText();
        }
        catch (Exception ex)
        {
            Log.Error("clipboard", "clipboard monitor failed to start", ex);
            _ready.Set();
            return;
        }
        _ready.Set();
        while (GetMessageW(out var msg, 0, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
    }

    private nint WindowProc(nint hwnd, uint msg, nint wParam, nint lParam)
    {
        if (msg == WM_CLIPBOARDUPDATE)
        {
            if (GetClipboardSequenceNumber() == _ownSequence) return 0;
            var text = ReadText();
            if (text != null && text != _lastText)
            {
                _lastText = text;
                try { Changed?.Invoke(text); } catch (Exception ex) { Log.Error("clipboard", "listener failed", ex); }
            }
            return 0;
        }
        if (msg == WM_APP_SET)
        {
            string? text = null;
            lock (_toSet) while (_toSet.Count > 0) text = _toSet.Dequeue();
            if (text != null) WriteText(text);
            return 0;
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    public void SetText(string text)
    {
        if (_hwnd == 0) return;
        lock (_toSet) _toSet.Enqueue(text);
        PostMessageW(_hwnd, WM_APP_SET, 0, 0);
    }

    /// <summary>Current clipboard text (thread-safe snapshot of the last value seen).</summary>
    public string? GetText() => _lastText;

    private static bool OpenWithRetry(nint hwnd)
    {
        // Other apps (and clipboard managers) briefly hold the clipboard open; retry for ~250 ms.
        for (int i = 0; i < 25; i++)
        {
            if (OpenClipboard(hwnd)) return true;
            Thread.Sleep(10);
        }
        return false;
    }

    private string? ReadText()
    {
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
        if (!OpenWithRetry(_hwnd)) return null;
        try
        {
            var h = GetClipboardData(CF_UNICODETEXT);
            if (h == 0) return null;
            var p = GlobalLock(h);
            if (p == 0) return null;
            try { return Marshal.PtrToStringUni(p); }
            finally { GlobalUnlock(h); }
        }
        finally { CloseClipboard(); }
    }

    private void WriteText(string text)
    {
        if (!OpenWithRetry(_hwnd)) { Log.Warn("clipboard", "could not open clipboard to write"); return; }
        try
        {
            EmptyClipboard();
            int bytes = (text.Length + 1) * 2;
            var h = GlobalAlloc(GMEM_MOVEABLE, (nuint)bytes);
            if (h == 0) return;
            var p = GlobalLock(h);
            fixed (char* src = text)
            {
                Buffer.MemoryCopy(src, (void*)p, bytes, text.Length * 2);
            }
            ((char*)p)[text.Length] = '\0';
            GlobalUnlock(h);
            if (SetClipboardData(CF_UNICODETEXT, h) == 0) GlobalFree(h);
            _lastText = text;
        }
        finally
        {
            CloseClipboard();
            _ownSequence = GetClipboardSequenceNumber();
        }
    }

    // -------------------------------------------------------------------- interop
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEXW
    {
        public uint cbSize, style;
        public nint lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public nint hInstance, hIcon, hCursor, hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public nint hwnd; public uint message; public nint wParam, lParam; public uint time; public int x, y; }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern ushort RegisterClassExW(ref WNDCLASSEXW wc);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern nint CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, nint parent, nint menu, nint inst, nint param);
    [DllImport("user32.dll")] private static extern nint DefWindowProcW(nint hwnd, uint msg, nint w, nint l);
    [DllImport("user32.dll")] private static extern int GetMessageW(out MSG msg, nint hwnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern nint DispatchMessageW(ref MSG msg);
    [DllImport("user32.dll")] private static extern bool PostMessageW(nint hwnd, uint msg, nint w, nint l);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandleW(string? name);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool AddClipboardFormatListener(nint hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(nint hwnd);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint fmt);
    [DllImport("user32.dll")] private static extern nint GetClipboardData(uint fmt);
    [DllImport("user32.dll")] private static extern nint SetClipboardData(uint fmt, nint mem);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("kernel32.dll")] private static extern nint GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll")] private static extern nint GlobalLock(nint h);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(nint h);
    [DllImport("kernel32.dll")] private static extern nint GlobalFree(nint h);
}
