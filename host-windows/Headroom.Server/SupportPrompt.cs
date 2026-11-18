namespace Headroom.Server;

/// <summary>"Someone wants to connect" with Accept / View only / Decline, always on top. Closing the window declines.</summary>
public sealed class SupportPrompt : Form
{
    private bool _answered;

    public SupportPrompt(SupportRequest r, Func<bool, bool, Task> answer)
    {
        Text = "Headroom — connection request";
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

        var layout = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
        layout.Controls.Add(new Label
        {
            Text = $"{r.Name} wants to connect to this PC",
            Font = new Font("Segoe UI Semibold", 12f),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 8),
        });
        layout.Controls.Add(new Label
        {
            Text = $"They entered this PC's Headroom ID and your support code{(r.Address.Length > 0 ? $" (from {r.Address})" : "")}.\n" +
                   "Accept to let them see and control your screen. You can disconnect them any time from the tray icon.",
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            Margin = new Padding(0, 0, 0, 14),
        });
        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        Button Make(string text, bool accept, bool viewOnly)
        {
            var b = new Button { Text = text, AutoSize = true, Padding = new Padding(10, 4, 10, 4), Margin = new Padding(8, 0, 0, 0) };
            b.Click += async (_, _) =>
            {
                _answered = true;
                Close();
                await answer(accept, viewOnly);
            };
            return b;
        }
        var accept = Make("Accept", true, false);
        buttons.Controls.Add(accept);
        buttons.Controls.Add(Make("View only", true, true));
        buttons.Controls.Add(Make("Decline", false, false));
        layout.Controls.Add(buttons);
        Controls.Add(layout);
        AcceptButton = accept;
        FormClosed += (_, _) => { if (!_answered) _ = answer(false, false); };
    }

    /// <summary>The request went away (answered in the settings window, or timed out): close without answering.</summary>
    public void Dismiss()
    {
        _answered = true;
        Close();
    }
}
