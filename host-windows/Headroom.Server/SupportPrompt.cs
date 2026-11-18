using System.Globalization;

namespace Headroom.Server;

/// <summary>
/// Someone entered your guest code: Decline, View only or Accept, always on top, and what else they may do (files
/// and clipboard start unticked). Esc or closing the window declines; Accept is never the default button.
/// </summary>
public sealed class SupportPrompt : Form
{
    private bool _answered;

    /// <param name="answer">(accept, viewOnly, files, clipboard)</param>
    public SupportPrompt(SupportRequest r, Func<bool, bool, bool, bool, Task> answer)
    {
        Text = "Headroom — someone wants to connect";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        TopMost = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(18);
        Font = new Font("Segoe UI", 10f);

        var from = new List<string>();
        if (r.Country != null) from.Add($"{CountryName(r.Country)} (approximate)");
        if (r.Address.Length > 0) from.Add(r.Address);

        var layout = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
        Label Line(string text, Padding margin, Font? font = null, Color? color = null) => new()
        {
            Text = text,
            AutoSize = true,
            MaximumSize = new Size(440, 0),
            Margin = margin,
            UseMnemonic = false, // names are typed by the guest: "&" is just a character
            Font = font ?? Font,
            ForeColor = color ?? SystemColors.ControlText,
        };
        layout.Controls.Add(Line($"“{r.Name}” wants to connect to this PC", new Padding(0, 0, 0, 8), new Font("Segoe UI Semibold", 12f)));
        layout.Controls.Add(Line("They entered your code. The name is what they typed — it isn't verified" +
                                 (from.Count > 0 ? $". From {string.Join(" · ", from)}." : "."), new Padding(0, 0, 0, 10)));
        layout.Controls.Add(Line("Only accept if you know this person and asked for their help. Scammers call pretending to be support and ask for codes.",
            new Padding(0, 0, 0, 10), new Font("Segoe UI Semibold", 10f), Color.FromArgb(138, 82, 0)));
        layout.Controls.Add(Line("Accept lets them see and control your screen; View only lets them watch. Stop any time from the bar at the top of the screen. No answer in 2 minutes declines.", new Padding(0, 0, 0, 10)));
        var files = new CheckBox { Text = "Let them transfer files", AutoSize = true, Checked = false, Margin = new Padding(0, 0, 0, 4) };
        var clipboard = new CheckBox { Text = "Share clipboard", AutoSize = true, Checked = false, Margin = new Padding(0, 0, 0, 14) };
        layout.Controls.Add(files);
        layout.Controls.Add(clipboard);

        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        Button Make(string text, bool accept, bool viewOnly)
        {
            var b = new Button { Text = text, AutoSize = true, Padding = new Padding(10, 4, 10, 4), Margin = new Padding(8, 0, 0, 0), UseMnemonic = false };
            b.Click += async (_, _) =>
            {
                _answered = true;
                bool f = accept && files.Checked, c = accept && clipboard.Checked;
                Close();
                await answer(accept, viewOnly, f, c);
            };
            return b;
        }
        // Right to left, so on screen it reads Accept | View only | Decline: the same order as the Mac prompt and
        // the Server window, with the safe answer last.
        var decline = Make("Decline", false, false);
        buttons.Controls.Add(decline);
        buttons.Controls.Add(Make("View only", true, true));
        buttons.Controls.Add(Make("Accept", true, false));
        layout.Controls.Add(buttons);
        Controls.Add(layout);
        // The safe answer is the strong one: Enter and Esc both decline, and focus starts on Decline.
        AcceptButton = decline;
        CancelButton = decline;
        Load += (_, _) => ActiveControl = decline;
        FormClosed += (_, _) => { if (!_answered) _ = answer(false, false, false, false); };
    }

    /// <summary>The request went away (answered in the settings window, or timed out): close without answering.</summary>
    public void Dismiss()
    {
        _answered = true;
        Close();
    }

    private static string CountryName(string code)
    {
        try { return new RegionInfo(code).DisplayName; }
        catch (ArgumentException) { return code; }
    }
}
