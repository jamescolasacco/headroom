using System.Runtime.InteropServices;
using Headroom.Host.Input;

// Run on the disposable Windows runner. Only interact with this test's foreground window.
internal sealed class DesktopInputTest : Form
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Touch
    {
        public int X, Y;
        public nint Source;
        public uint Id, Flags, Mask, Time;
        public nuint Extra;
        public uint Width, Height;
    }

    [DllImport("user32.dll")] private static extern bool RegisterTouchWindow(nint window, uint flags);
    [DllImport("user32.dll")] private static extern bool GetTouchInputInfo(nint handle, int count, [Out] Touch[] contacts, int size);
    [DllImport("user32.dll")] private static extern bool CloseTouchInputHandle(nint handle);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();

    private readonly Dictionary<uint, int> _start = new(), _last = new();
    private readonly HashSet<uint> _up = new();
    private Point? _downAt, _upAt, _wheelAt;
    private bool _wheelWithCtrl;

    internal static Task Run()
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
                using var form = new DesktopInputTest { Text = "Headroom input test", TopMost = true,
                    StartPosition = FormStartPosition.CenterScreen, ClientSize = new Size(420, 300) };
                form.Shown += async (_, _) =>
                {
                    try { await form.Check(); done.TrySetResult(); }
                    catch (Exception ex) { done.TrySetException(ex); }
                    finally { form.Close(); }
                };
                Application.Run(form);
            }
            catch (Exception ex) { done.TrySetException(ex); }
        }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return done.Task.WaitAsync(TimeSpan.FromSeconds(20));
    }

    private async Task Check()
    {
        Activate();
        await Task.Delay(200);
        if (GetForegroundWindow() != Handle) throw new Exception("Test window did not receive focus");
        if (!RegisterTouchWindow(Handle, 0)) throw new Exception("Touch registration failed");
        var a = PointToScreen(new Point(130, 130));
        var b = PointToScreen(new Point(240, 160));
        var input = InputInjector.Instance;
        var ctx = new InputContext();
        try
        {
            input.MoveTo(a.X, a.Y);
            input.Button(ctx, 0, true);
            input.MoveTo(b.X, b.Y);
            input.Button(ctx, 0, false);
            input.MoveTo(a.X, a.Y);
            input.Key(ctx, "ControlLeft", true);
            input.Wheel(0, 120);
            input.Key(ctx, "ControlLeft", false);
            for (int i = 0; i < 100 && _wheelAt == null; i++) await Task.Delay(20);
            if (_downAt != a || _upAt != b || _wheelAt != a || !_wheelWithCtrl)
                throw new Exception($"Mouse arrival: down {_downAt}, up {_upAt}, wheel {_wheelAt} ctrl {_wheelWithCtrl}; expected {a}, {b}, {a}");
        }
        finally { input.ReleaseAll(ctx); }

        var pinch = new TouchPinch();
        try
        {
            if (!pinch.Frame(true, (a.X - 20, a.X + 20, a.Y))) throw new Exception("Windows rejected touch down");
            for (int r = 24; r <= 60; r += 4)
            {
                await Task.Delay(16);
                if (!pinch.Frame(false, (a.X - r, a.X + r, a.Y))) throw new Exception("Windows rejected touch move");
            }
            await Task.Delay(20);
            pinch.End(false);
            for (int i = 0; i < 50 && _up.Count < 2; i++) await Task.Delay(20);
            if (_start.Count != 2 || _up.Count != 2 || !_start.All(p => Math.Abs(_last[p.Key] - p.Value) >= 35))
                throw new Exception($"Touch arrival: {_start.Count} down, {_last.Count} moved, {_up.Count} up");
            Console.WriteLine("Windows app received drag endpoints, Ctrl+wheel at cursor, and two spreading and released touch contacts");
        }
        finally { pinch.End(true); }
    }

    protected override void WndProc(ref Message msg)
    {
        int x = (short)((long)msg.LParam & 0xffff), y = (short)(((long)msg.LParam >> 16) & 0xffff);
        switch (msg.Msg)
        {
            case 0x201: _downAt = PointToScreen(new Point(x, y)); break;
            case 0x202: _upAt = PointToScreen(new Point(x, y)); break;
            case 0x20a: _wheelAt = new Point(x, y); _wheelWithCtrl = ((long)msg.WParam & 8) != 0; break;
            case 0x240: // WM_TOUCH
                int n = (int)((long)msg.WParam & 0xffff);
                var contacts = new Touch[n];
                if (GetTouchInputInfo(msg.LParam, n, contacts, Marshal.SizeOf<Touch>()))
                {
                    foreach (var c in contacts)
                    {
                        if ((c.Flags & 2) != 0) _start[c.Id] = c.X / 100;
                        _last[c.Id] = c.X / 100;
                        if ((c.Flags & 4) != 0) _up.Add(c.Id);
                    }
                }
                CloseTouchInputHandle(msg.LParam);
                msg.Result = 0;
                return;
        }
        base.WndProc(ref msg);
    }
}
