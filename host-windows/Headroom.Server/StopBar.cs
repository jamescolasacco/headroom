using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace Headroom.Server;

/// <summary>
/// A small bar at the top of the screen for as long as anyone is connected: who it is, and Stop. It stays above other
/// windows and never takes the focus, so the person here always sees that a session is on and can end it with one
/// click. It can be dragged aside, never closed while the session lasts.
/// </summary>
public sealed class StopBar : Form
{
    private const int WS_EX_TOPMOST = 0x00000008;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_NOACTIVATE = 0x08000000;

    private readonly Label _label;
    private Button? _stop;
    private Action _onStop = () => { };
    private Action _onOpen = () => { };
    private bool _dragging;
    private Point _dragFrom;
    private Point _dragOrigin;

    public StopBar()
    {
        Text = "Headroom";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        // Topmost through WS_EX_TOPMOST (CreateParams), not the TopMost property: that one activates the window.
        StartPosition = FormStartPosition.Manual;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        BackColor = Color.FromArgb(32, 34, 40);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10f);
        Padding = new Padding(14, 6, 8, 6);

        var row = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 4,
            RowCount = 1,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            BackColor = BackColor,
        };
        for (int i = 0; i < 4; i++) row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var dot = new Dot { Anchor = AnchorStyles.Left, Margin = new Padding(0, 0, 10, 0) };
        _label = new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 0, 16, 0),
            UseMnemonic = false, // names are typed by people: "&" is just a character
            ForeColor = Color.White,
            BackColor = BackColor,
        };
        var details = MakeButton("Details", Color.FromArgb(60, 63, 72), () => _onOpen());
        var stop = MakeButton("Stop", Color.FromArgb(196, 43, 28), () => _onStop());
        _stop = stop;
        details.Margin = new Padding(0, 0, 6, 0);
        row.Controls.Add(dot, 0, 0);
        row.Controls.Add(_label, 1, 0);
        row.Controls.Add(details, 2, 0);
        row.Controls.Add(stop, 3, 0);
        Controls.Add(row);
        foreach (var c in new Control[] { this, row, dot, _label }) Draggable(c);
        CreateHandle(); // so the size is known before it's first shown
    }

    /// <summary>Shows the bar for these people, or hides it when the list is empty.</summary>
    public void SetViewers(IReadOnlyList<ViewerInfo> viewers, string host, Action onStop, Action onOpen)
    {
        _onStop = onStop;
        _onOpen = onOpen;
        if (viewers.Count == 0)
        {
            if (Visible) Hide();
            return;
        }
        var first = viewers[0];
        var name = first.Device.Length > 40 ? first.Device[..40] + "…" : first.Device;
        var who = first.Guest ? $"“{name}” (guest)" : name;
        var text = viewers.Count == 1
            ? $"{who} is connected to {host}"
            : $"{who} and {viewers.Count - 1} other{(viewers.Count > 2 ? "s" : "")} are connected";
        if (_label.Text != text) _label.Text = text;
        var stopText = viewers.Count == 1 ? "Stop" : "Stop all"; // says what it ends
        if (_stop != null && _stop.Text != stopText) _stop.Text = stopText;
        PerformLayout();
        if (!Visible)
        {
            // Top center of the main screen, each time it appears.
            var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
            Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + 8);
            Show();
        }
    }

    private Button MakeButton(string text, Color back, Action click)
    {
        var b = new Button
        {
            Text = text,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Anchor = AnchorStyles.Left,
            FlatStyle = FlatStyle.Flat,
            BackColor = back,
            ForeColor = Color.White,
            Padding = new Padding(8, 1, 8, 1),
            TabStop = false,
            UseMnemonic = false,
            Cursor = Cursors.Hand,
        };
        b.FlatAppearance.BorderSize = 0;
        b.FlatAppearance.MouseOverBackColor = ControlPaint.Light(back, 0.25f);
        b.Click += (_, _) => click();
        return b;
    }

    private void Draggable(Control c)
    {
        c.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            _dragging = true;
            _dragFrom = Cursor.Position;
            _dragOrigin = Location;
        };
        c.MouseMove += (_, _) =>
        {
            if (!_dragging) return;
            var p = Cursor.Position;
            Location = new Point(_dragOrigin.X + p.X - _dragFrom.X, _dragOrigin.Y + p.Y - _dragFrom.Y);
        };
        c.MouseUp += (_, _) => _dragging = false;
    }

    /// <summary>Never takes the focus from what the person here is doing.</summary>
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = 2; // DWMWCP_ROUND (Windows 11; ignored elsewhere)
        _ = DwmSetWindowAttribute(Handle, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref round, sizeof(int));
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Only goes away when nobody is connected (or the app exits).
        if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; return; }
        base.OnFormClosing(e);
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);

    /// <summary>The amber on-air lamp (the same as the Server window and the website): someone is connected.</summary>
    private sealed class Dot : Control
    {
        public Dot()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Size = new Size(10, 10);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var brush = new SolidBrush(Color.FromArgb(250, 171, 63));
            int d = Math.Min(Width, Height) - 1;
            e.Graphics.FillEllipse(brush, (Width - d) / 2f, (Height - d) / 2f, d, d);
        }
    }
}
