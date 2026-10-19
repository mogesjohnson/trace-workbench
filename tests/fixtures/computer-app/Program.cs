using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;

namespace TraceComputerFixture;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 6 || args[0] != "--run-id" || args[2] != "--receipt" || args[4] != "--commands" ||
            !Regex.IsMatch(args[1], "^[a-zA-Z0-9-]{1,80}$") ||
            !Path.IsPathFullyQualified(args[3]) || !Path.IsPathFullyQualified(args[5]))
        {
            throw new ArgumentException("Expected --run-id <id> --receipt <absolute JSON path> --commands <absolute JSON path>.");
        }

        var receiptPath = Path.GetFullPath(args[3]);
        var commandsPath = Path.GetFullPath(args[5]);
        if (!Directory.Exists(Path.GetDirectoryName(receiptPath)) || !Directory.Exists(Path.GetDirectoryName(commandsPath)))
            throw new ArgumentException("The receipt and command directories must already exist.");

        // The SDK initializer selects PerMonitorV2, so recorded DeviceDpi is the monitor's physical DPI.
        ApplicationConfiguration.Initialize();
        Application.Run(new FixtureWindow(args[1], receiptPath, commandsPath));
    }
}

internal sealed class FixtureWindow : Form
{
    private static readonly JsonSerializerOptions CommandJson = new() { PropertyNameCaseInsensitive = true };
    private readonly string runId;
    private readonly string receiptPath;
    private readonly string commandsPath;
    private readonly TextBox textInput;
    private readonly CheckBox option;
    private readonly Label counter;
    private readonly Label chordLabel;
    private readonly ScrollFixturePanel scrolling;
    private readonly Panel dragArea;
    private readonly Label dragTarget;
    private readonly System.Windows.Forms.Timer commands;
    private readonly PanelWheelFilter wheelFilter;
    private Form? dialog;
    private int count;
    private int revision;
    private int appliedCommandId;
    private string chord = "none";
    private string lastCommand = "none";
    private bool dialogOpen;
    private bool dialogConfirmed;
    private int scrollBaseline = 8;
    private int dragStarts;
    private int dragDrops;
    private Point dragStart;
    private Point? dragOffset;

    internal FixtureWindow(string runId, string receiptPath, string commandsPath)
    {
        this.runId = runId;
        this.receiptPath = receiptPath;
        this.commandsPath = commandsPath;
        Name = "traceFixtureWindow";
        Text = $"TRACE Computer Fixture — {runId}";
        AccessibleName = Text;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        ClientSize = new Size(560, 670);
        MaximizeBox = false;
        KeyPreview = true;
        Font = new Font("Segoe UI", 10);

        Controls.Add(new Label { Text = "TRACE desktop acceptance fixture", Location = new Point(24, 18), AutoSize = true });
        Controls.Add(new Label { Text = "Owned synthetic controls. No external application access.", Location = new Point(24, 48), AutoSize = true });
        Controls.Add(new Label { Text = "Text input", Location = new Point(24, 88), AutoSize = true });
        textInput = new TextBox
        {
            Name = "traceTextInput", AccessibleName = "TRACE text input",
            AccessibleDescription = "Editable synthetic acceptance text",
            Location = new Point(24, 114), Width = 500, TabIndex = 0
        };
        Controls.Add(textInput);

        var increment = new Button
        {
            Name = "traceIncrement", AccessibleName = "Increment counter", Text = "Increment counter",
            Location = new Point(24, 159), Size = new Size(280, 36), TabIndex = 1
        };
        Controls.Add(increment);
        counter = new Label
        {
            Name = "traceCounter", AccessibleName = "Counter value", Text = "Count: 0",
            Location = new Point(320, 167), AutoSize = true
        };
        Controls.Add(counter);
        increment.Click += (_, _) => { count++; counter.Text = $"Count: {count}"; WriteReceipt(); };
        option = new CheckBox
        {
            Name = "traceOption", AccessibleName = "Enable option", Text = "Enable option",
            Location = new Point(24, 214), AutoSize = true, TabIndex = 2
        };
        Controls.Add(option);

        Controls.Add(new Label { Text = "Scrollable controls", Location = new Point(24, 254), AutoSize = true });
        scrolling = new ScrollFixturePanel
        {
            Name = "traceScrollPanel", AccessibleName = "Scrollable fixture panel",
            Location = new Point(24, 281), Size = new Size(500, 150), TabIndex = 3
        };
        for (var index = 1; index <= 14; index++)
        {
            scrolling.Controls.Add(new WheelRow
            {
                Name = $"traceScrollRow{index}", AccessibleName = $"Fixture row {index}",
                Text = $"Fixture row {index}", Location = new Point(12, (index - 1) * 34 + 8), AutoSize = true
            });
        }
        Controls.Add(scrolling);

        Controls.Add(new Label { Text = "Drag the blue target within the outlined area", Location = new Point(24, 450), AutoSize = true });
        dragArea = new Panel
        {
            Name = "traceDragArea", AccessibleName = "Drag area", BorderStyle = BorderStyle.FixedSingle,
            Location = new Point(24, 478), Size = new Size(500, 125)
        };
        dragTarget = new Label
        {
            Name = "traceDragTarget", AccessibleName = "Draggable target", Text = "Drag target",
            TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White, BackColor = Color.RoyalBlue,
            Location = new Point(10, 30), Size = new Size(120, 50)
        };
        dragTarget.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left || dragOffset is not null) return;
            dragOffset = e.Location;
            dragStart = dragTarget.Location;
            dragStarts++;
            dragTarget.Capture = true;
            WriteReceipt();
        };
        dragTarget.MouseMove += (_, e) =>
        {
            if (dragOffset is not Point offset) return;
            var pointer = dragArea.PointToClient(dragTarget.PointToScreen(e.Location));
            dragTarget.Location = new Point(
                Math.Clamp(pointer.X - offset.X, 0, dragArea.ClientSize.Width - dragTarget.Width),
                Math.Clamp(pointer.Y - offset.Y, 0, dragArea.ClientSize.Height - dragTarget.Height));
        };
        dragTarget.MouseUp += (_, e) =>
        {
            if (e.Button != MouseButtons.Left || dragOffset is null) return;
            dragOffset = null;
            dragDrops++;
            dragTarget.Capture = false;
            WriteReceipt();
        };
        dragTarget.MouseCaptureChanged += (_, _) =>
        {
            if (dragTarget.Capture || dragOffset is null) return;
            dragOffset = null;
            WriteReceipt();
        };
        dragArea.Controls.Add(dragTarget);
        Controls.Add(dragArea);

        var openDialog = new Button
        {
            Name = "traceOpenDialog", AccessibleName = "Open dialog", Text = "Open dialog",
            Location = new Point(24, 618), Size = new Size(150, 36), TabIndex = 4
        };
        openDialog.Click += (_, _) => ShowOwnedDialog();
        Controls.Add(openDialog);
        chordLabel = new Label
        {
            Name = "traceChord", AccessibleName = "Last chord", Text = "Last chord: none",
            Location = new Point(190, 626), AutoSize = true
        };
        Controls.Add(chordLabel);

        textInput.TextChanged += (_, _) => WriteReceipt();
        option.CheckedChanged += (_, _) => WriteReceipt();
        scrolling.Scroll += (_, _) => WriteReceipt();
        scrolling.ScrolledByWheel += _ => WriteReceipt();
        KeyDown += (_, e) =>
        {
            if (!e.Control || e.KeyCode != Keys.D) return;
            chord = "ctrl+d";
            chordLabel.Text = "Last chord: ctrl+d";
            textInput.Select(0, Math.Min(5, textInput.TextLength));
            e.Handled = true;
            e.SuppressKeyPress = true;
            WriteReceipt();
        };
        KeyUp += (_, _) => WriteReceipt();
        LocationChanged += (_, _) => WriteReceipt();
        Resize += (_, _) => WriteReceipt();
        DpiChanged += (_, _) => WriteReceipt();
        Shown += (_, _) =>
        {
            MinimumSize = Size;
            MaximumSize = Size;
            scrollBaseline = scrolling.Controls[0].Top;
            textInput.Focus();
            WriteReceipt();
        };
        FormClosed += (_, _) => WriteReceipt();
        commands = new System.Windows.Forms.Timer { Interval = 50 };
        commands.Tick += (_, _) => ApplyCommand();
        commands.Start();
        wheelFilter = new PanelWheelFilter(scrolling);
        Application.AddMessageFilter(wheelFilter);
    }

    private void ShowOwnedDialog()
    {
        if (dialog is { IsDisposed: false }) return;
        using var owned = new Form
        {
            Name = "traceDialog",
            Text = $"TRACE dialog — {runId}",
            AccessibleName = $"TRACE dialog — {runId}",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(360, 140),
            MinimizeBox = false,
            MaximizeBox = false,
            ShowInTaskbar = true,
            Owner = this
        };
        var confirm = new Button
        {
            Name = "traceConfirmDialog", AccessibleName = "Confirm dialog", Text = "Confirm dialog",
            Location = new Point(24, 52), Size = new Size(170, 36)
        };
        confirm.Click += (_, _) => { dialogConfirmed = true; confirm.Text = "Dialog confirmed"; WriteReceipt(); };
        owned.Controls.Add(new Label { Text = "Owned synthetic dialog", Location = new Point(24, 18), AutoSize = true });
        owned.Controls.Add(confirm);
        owned.Shown += (_, _) => { dialogOpen = true; WriteReceipt(); };
        owned.FormClosed += (_, _) => { dialogOpen = false; WriteReceipt(); };
        dialog = owned;
        dialogConfirmed = false;
        try { owned.ShowDialog(this); }
        finally
        {
            dialogOpen = false;
            dialog = null;
            // ShowDialog has restored the owner's native enabled state before this receipt.
            WriteReceipt();
        }
    }

    private void ApplyCommand()
    {
        try
        {
            if (!File.Exists(commandsPath)) return;
            var command = JsonSerializer.Deserialize<FixtureCommand>(File.ReadAllText(commandsPath), CommandJson);
            if (command is null || command.Id <= appliedCommandId || command.Op is not ("move" or "minimize" or "restore" or "move-monitor" or "close-dialog" or "open-dialog")) return;
            appliedCommandId = command.Id;
            lastCommand = command.Op;
            switch (command.Op)
            {
                case "move": MoveWithinMonitor(); break;
                case "minimize": WindowState = FormWindowState.Minimized; break;
                case "restore": WindowState = FormWindowState.Normal; break;
                case "move-monitor": MoveToOtherMonitor(); break;
                case "close-dialog": dialog?.Close(); break;
                case "open-dialog": ShowOwnedDialog(); break;
            }
            WriteReceipt();
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
    }

    private void MoveWithinMonitor()
    {
        var working = Screen.FromControl(this).WorkingArea;
        var next = new Point(Left + 160, Top + 80);
        if (next.X < working.Left || next.Y < working.Top || next.X + Width > working.Right || next.Y + Height > working.Bottom)
            next = new Point(working.Left + 24, working.Top + 24);
        Location = next;
    }

    private void MoveToOtherMonitor()
    {
        var current = Screen.FromControl(this);
        var next = Screen.AllScreens.FirstOrDefault(screen => !string.Equals(screen.DeviceName, current.DeviceName, StringComparison.OrdinalIgnoreCase));
        if (next is null) return;
        Location = new Point(next.WorkingArea.Left + 24, next.WorkingArea.Top + 24);
    }

    private void WriteReceipt()
    {
        var screen = Screen.FromControl(this);
        var receipt = new
        {
            schemaVersion = 1, runId, title = Text, text = textInput.Text,
            count, optionChecked = option.Checked, chord,
            selectionStart = textInput.SelectionStart, selectionLength = textInput.SelectionLength,
            selectedText = textInput.SelectedText,
            modifiers = ModifierKeys.ToString(),
            controlPressed = (ModifierKeys & Keys.Control) != Keys.None,
            shiftPressed = (ModifierKeys & Keys.Shift) != Keys.None,
            altPressed = (ModifierKeys & Keys.Alt) != Keys.None,
            scrollY = Math.Max(0, -scrolling.AutoScrollPosition.Y),
            scrollRowOffset = scrollBaseline - scrolling.Controls[0].Top,
            scrollMaximum = Math.Max(0, scrolling.DisplayRectangle.Height - scrolling.ClientSize.Height),
            dragX = dragTarget.Left, dragY = dragTarget.Top,
            dragStartX = dragStart.X, dragStartY = dragStart.Y, dragStarts, dragDrops,
            dragPressed = dragOffset is not null,
            dragAreaWidth = dragArea.ClientSize.Width, dragAreaHeight = dragArea.ClientSize.Height,
            dragTargetWidth = dragTarget.Width, dragTargetHeight = dragTarget.Height,
            leftButtonDown = (MouseButtons & MouseButtons.Left) != MouseButtons.None,
            dialogOpen, dialogConfirmed, parentEnabled = NativeWindowState.IsEnabled(this),
            windowX = Left, windowY = Top, windowWidth = Width, windowHeight = Height,
            minimized = WindowState == FormWindowState.Minimized,
            dpiX = DeviceDpi, dpiY = DeviceDpi,
            monitorCount = Screen.AllScreens.Length,
            monitorName = screen.DeviceName,
            monitorX = screen.Bounds.X, monitorY = screen.Bounds.Y,
            monitorWidth = screen.Bounds.Width, monitorHeight = screen.Bounds.Height,
            appliedCommandId, lastCommand,
            revision = ++revision,
            recordedAt = DateTimeOffset.UtcNow.ToString("O")
        };
        var temporary = receiptPath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, receiptPath, true);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            commands.Stop();
            commands.Dispose();
            Application.RemoveMessageFilter(wheelFilter);
        }
        base.Dispose(disposing);
    }

    private sealed class FixtureCommand
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("op")] public string? Op { get; set; }
    }
}

internal sealed class ScrollFixturePanel : Panel
{
    internal ScrollFixturePanel()
    {
        AutoScroll = true;
        BorderStyle = BorderStyle.FixedSingle;
        TabStop = true;
    }

    internal event Action<int>? ScrolledByWheel;

    internal void ScrollNotches(int notches)
    {
        if (notches == 0) return;
        var maximum = Math.Max(0, DisplayRectangle.Height - ClientSize.Height);
        var next = Math.Clamp(Math.Max(0, -AutoScrollPosition.Y) + notches * 48, 0, maximum);
        AutoScrollPosition = new Point(0, next);
        ScrolledByWheel?.Invoke(Math.Max(0, -AutoScrollPosition.Y));
    }
}

internal sealed class WheelRow : Label
{
    protected override void OnMouseWheel(MouseEventArgs e)
    {
        if (Parent is ScrollFixturePanel panel) panel.ScrollNotches(-e.Delta / 120);
    }
}

/// <summary>Routes a wheel whose cursor is over the fixture panel, including when another control has focus.</summary>
internal sealed class PanelWheelFilter(ScrollFixturePanel panel) : IMessageFilter
{
    public bool PreFilterMessage(ref Message message)
    {
        if (message.Msg != 0x020A || panel.IsDisposed || !panel.Enabled || panel.FindForm() is not Form owner ||
            !NativeWindowState.IsEnabled(owner) || Control.FromChildHandle(message.HWnd)?.FindForm() != owner) return false;
        var packed = message.LParam.ToInt64();
        var cursor = new Point((short)(packed & 0xFFFF), (short)((packed >> 16) & 0xFFFF));
        if (!panel.RectangleToScreen(panel.ClientRectangle).Contains(cursor)) return false;
        var delta = (short)((message.WParam.ToInt64() >> 16) & 0xFFFF);
        panel.ScrollNotches(-delta / 120);
        return true;
    }
}

internal static class NativeWindowState
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr window);

    internal static bool IsEnabled(Control control) => control.IsHandleCreated && IsWindowEnabled(control.Handle);
}
