using System.Runtime.InteropServices;
using System.Text;

namespace Headroom.Host.Platform;

internal static unsafe class Native
{
    // ------------------------------------------------------------------ input
    public const int INPUT_MOUSE = 0;
    public const int INPUT_KEYBOARD = 1;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_SCANCODE = 0x0008;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_XDOWN = 0x0080;
    public const uint MOUSEEVENTF_XUP = 0x0100;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_MOVE_NOCOALESCE = 0x2000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint XBUTTON1 = 0x0001;
    public const uint XBUTTON2 = 0x0002;

    /// <summary>Tag on every injected event so our own hooks/filters can recognise them.</summary>
    public static readonly nint InjectedTag = 0x4844524D; // "HDRM"

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT
    {
        [FieldOffset(0)] public int type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT* pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern short GetKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;
    public const int SM_SWAPBUTTON = 23;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public nint hCursor;
        public POINT ptScreenPos;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool LockWorkStation();

    // ------------------------------------------------------------------ desktops
    public const uint DESKTOP_READOBJECTS = 0x0001;
    public const uint DESKTOP_CREATEWINDOW = 0x0002;
    public const uint DESKTOP_CREATEMENU = 0x0004;
    public const uint DESKTOP_HOOKCONTROL = 0x0008;
    public const uint DESKTOP_JOURNALRECORD = 0x0010;
    public const uint DESKTOP_JOURNALPLAYBACK = 0x0020;
    public const uint DESKTOP_ENUMERATE = 0x0040;
    public const uint DESKTOP_WRITEOBJECTS = 0x0080;
    public const uint DESKTOP_SWITCHDESKTOP = 0x0100;
    public const uint GENERIC_ALL = 0x10000000;
    public const uint DESKTOP_ALL = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU | DESKTOP_HOOKCONTROL |
                                    DESKTOP_JOURNALRECORD | DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS |
                                    DESKTOP_SWITCHDESKTOP;
    public const int UOI_NAME = 2;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern nint OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(nint hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern nint GetThreadDesktop(uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(nint hDesktop);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformationW(nint hObj, int nIndex, char* pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    public static string? GetDesktopName(nint hDesk)
    {
        if (hDesk == 0) return null;
        char* buf = stackalloc char[256];
        if (!GetUserObjectInformationW(hDesk, UOI_NAME, buf, 512, out _)) return null;
        return new string(buf);
    }

    // ------------------------------------------------------------------ power / display
    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002;

    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);

    // ------------------------------------------------------------------ sessions / processes
    [DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSQueryUserToken(uint sessionId, out nint phToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(nint processHandle, uint desiredAccess, out nint tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(nint hExistingToken, uint dwDesiredAccess, nint lpTokenAttributes,
        int impersonationLevel, int tokenType, out nint phNewToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetTokenInformation(nint tokenHandle, int tokenInformationClass, ref uint tokenInformation, int tokenInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern nint GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(nint handle);

    public const uint TOKEN_ALL_ACCESS = 0xF01FF;
    public const int SecurityImpersonation = 2;
    public const int TokenPrimary = 1;
    public const int TokenSessionId = 12;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint NORMAL_PRIORITY_CLASS = 0x20;
    public const uint ABOVE_NORMAL_PRIORITY_CLASS = 0x8000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public nint lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public nint hProcess;
        public nint hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUserW(nint hToken, string? lpApplicationName, StringBuilder lpCommandLine,
        nint lpProcessAttributes, nint lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, nint lpEnvironment,
        string? lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool CreateEnvironmentBlock(out nint lpEnvironment, nint hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool DestroyEnvironmentBlock(nint lpEnvironment);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(nint handle, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(nint hProcess, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(nint hProcess, out uint exitCode);

    // ------------------------------------------------------------------ Secure Attention Sequence
    [DllImport("sas.dll", SetLastError = true)]
    public static extern void SendSAS(bool asUser);

    // ------------------------------------------------------------------ misc
    [DllImport("shell32.dll")]
    public static extern bool IsUserAnAdmin();

    [DllImport("avrt.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern nint AvSetMmThreadCharacteristicsW(string taskName, ref uint taskIndex);

    [DllImport("avrt.dll", SetLastError = true)]
    public static extern bool AvRevertMmThreadCharacteristics(nint handle);

    [DllImport("winmm.dll")]
    public static extern uint timeBeginPeriod(uint uPeriod);

    [DllImport("winmm.dll")]
    public static extern uint timeEndPeriod(uint uPeriod);
}
