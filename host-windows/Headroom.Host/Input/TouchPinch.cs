using System.Runtime.InteropServices;

namespace Headroom.Host.Input;

/// <summary>A single viewer's two-finger gesture. All methods run on the input thread.</summary>
internal sealed unsafe class TouchPinch
{
    private const uint Touch = 2, Down = 0x10000, Update = 0x20000, Up = 0x40000, Cancelled = 0x8000;
    private const uint Contact = 0x2 | 0x4; // INRANGE | INCONTACT
    private nint _device;
    internal bool Active => _device != 0;
    private (int X1, int X2, int Y) _last;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PointerInfo
    {
        public uint Type, Id, Frame, Flags;
        public nint Source, Target;
        public Point Pixel, Himetric, RawPixel, RawHimetric;
        public uint Time, History;
        public int Data;
        public uint Keys;
        public ulong Counter;
        public uint ButtonChange;
    }

    // POINTER_TYPE_INFO: the largest member of the native union is POINTER_TOUCH_INFO.
    [StructLayout(LayoutKind.Sequential)]
    private struct ContactInfo
    {
        public uint Type;
        public PointerInfo Pointer;
        public uint Flags, Mask;
        public Rect Area, RawArea;
        public uint Orientation, Pressure;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint CreateSyntheticPointerDevice(uint type, uint count, uint feedback);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool InjectSyntheticPointerInput(nint device, ContactInfo* contacts, uint count);
    [DllImport("user32.dll")]
    private static extern void DestroySyntheticPointerDevice(nint device);

    internal static (int X1, int X2, int Y) Positions(int left, int top, int width, int height,
        double nx, double ny, double dpiScale, double scale)
    {
        int radius = Math.Clamp((int)Math.Round(64 * dpiScale * scale), 1, Math.Max(1, (width - 1) / 2));
        int x = Math.Clamp((int)(nx * width), radius, width - 1 - radius);
        int y = Math.Clamp((int)(ny * height), 0, height - 1);
        return (left + x - radius, left + x + radius, top + y);
    }

    internal bool Frame(bool begin, (int X1, int X2, int Y) points)
    {
        if (begin)
        {
            End(cancel: true);
            _device = CreateSyntheticPointerDevice(Touch, 2, 3); // POINTER_FEEDBACK_NONE
        }
        if (_device == 0) return false;
        if (!Send(points, (begin ? Down : Update) | Contact))
        {
            End(cancel: true);
            return false;
        }
        _last = points;
        return true;
    }

    internal void End(bool cancel)
    {
        if (_device == 0) return;
        if (_last.X1 != _last.X2) Send(_last, cancel ? Up | Cancelled : Up);
        DestroySyntheticPointerDevice(_device);
        _device = 0;
        _last = default;
    }

    private bool Send((int X1, int X2, int Y) points, uint flags)
    {
        ContactInfo* contacts = stackalloc ContactInfo[2];
        for (int i = 0; i < 2; i++)
        {
            contacts[i] = new ContactInfo
            {
                Type = Touch,
                Pointer = new PointerInfo { Type = Touch, Id = (uint)i + 1, Flags = flags,
                    Pixel = new Point { X = i == 0 ? points.X1 : points.X2, Y = points.Y } },
            };
        }
        // Win32 can request a later sample when network delivery batches two frames together.
        for (int attempt = 0; attempt < 3; attempt++)
        {
            if (InjectSyntheticPointerInput(_device, contacts, 2)) return true;
            if (Marshal.GetLastWin32Error() != 21) break; // ERROR_NOT_READY
            Thread.Sleep(1);
        }
        return false;
    }
}
