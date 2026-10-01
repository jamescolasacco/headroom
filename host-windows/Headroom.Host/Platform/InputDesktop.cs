using Headroom.Host.Util;

namespace Headroom.Host.Platform;

/// <summary>
/// Keeps the calling thread attached to whichever desktop currently receives input
/// ("Default" normally, "Winlogon" for UAC prompts / lock screen / Ctrl+Alt+Del, "Screen-saver"...).
/// Only works when running as SYSTEM (service mode); a normal user process cannot open Winlogon.
/// A thread can only switch desktops if it owns no windows or hooks, so call this only from
/// dedicated capture/input threads.
/// </summary>
public sealed class InputDesktopFollower
{
    private nint _current;
    private string? _currentName;
    private long _lastCheck;

    public string? CurrentName => _currentName;

    /// <summary>True when the input desktop is a secure desktop we failed to attach to.</summary>
    public bool Blocked { get; private set; }

    /// <summary>
    /// Re-attaches to the input desktop if it changed. Returns true if the thread desktop changed.
    /// Cheap enough to call every frame but throttled to every <paramref name="minIntervalMs"/>.
    /// </summary>
    public bool Sync(int minIntervalMs = 0)
    {
        long now = Environment.TickCount64;
        if (minIntervalMs > 0 && now - _lastCheck < minIntervalMs) return false;
        _lastCheck = now;

        nint input = Native.OpenInputDesktop(0, false, Native.GENERIC_ALL);
        if (input == 0)
        {
            // Typically ERROR_ACCESS_DENIED when the secure desktop is active and we are not SYSTEM.
            if (!Blocked) Log.Debug("desktop", $"OpenInputDesktop failed ({System.Runtime.InteropServices.Marshal.GetLastWin32Error()})");
            Blocked = true;
            return false;
        }
        Blocked = false;
        var name = Native.GetDesktopName(input);
        if (name != null && name == _currentName)
        {
            Native.CloseDesktop(input);
            return false;
        }
        if (!Native.SetThreadDesktop(input))
        {
            Log.Warn("desktop", $"SetThreadDesktop({name}) failed ({System.Runtime.InteropServices.Marshal.GetLastWin32Error()})");
            Native.CloseDesktop(input);
            return false;
        }
        if (_current != 0) Native.CloseDesktop(_current);
        _current = input;
        var old = _currentName;
        _currentName = name;
        if (old != null) Log.Info("desktop", $"thread {Environment.CurrentManagedThreadId} switched desktop {old} -> {name}");
        return old != null;
    }

    /// <summary>Name of the desktop currently receiving input, or null if it can't be opened (secure desktop, not SYSTEM).</summary>
    public static string? QueryInputDesktopName()
    {
        nint input = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
        if (input == 0) return null;
        try { return Native.GetDesktopName(input); }
        finally { Native.CloseDesktop(input); }
    }
}
