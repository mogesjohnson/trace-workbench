using System.Text.Json;
using System.Text.RegularExpressions;

namespace TraceComputerFixture;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 4 || args[0] != "--run-id" || args[2] != "--receipt" ||
            !Regex.IsMatch(args[1], "^[a-zA-Z0-9-]{1,80}$") || !Path.IsPathFullyQualified(args[3]))
        {
            throw new ArgumentException("Expected --run-id <letters/digits/hyphens> --receipt <absolute JSON path>.");
        }

        var receiptPath = Path.GetFullPath(args[3]);
        if (!Directory.Exists(Path.GetDirectoryName(receiptPath)))
            throw new ArgumentException("The receipt directory must already exist.");

        ApplicationConfiguration.Initialize();
        Application.Run(new FixtureWindow(args[1], receiptPath));
    }
}

internal sealed class FixtureWindow : Form
{
    private readonly string runId;
    private readonly string receiptPath;
    private readonly TextBox textInput;
    private readonly CheckBox option;
    private readonly Label counter;
    private readonly Panel scrolling;
    private readonly Panel dragArea;
    private readonly Label dragTarget;
    private int count;
    private int revision;
    private Point? dragOffset;

    internal FixtureWindow(string runId, string receiptPath)
    {
        this.runId = runId;
        this.receiptPath = receiptPath;
        Name = "traceFixtureWindow";
        Text = $"TRACE Computer Fixture — {runId}";
        AccessibleName = Text;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 650);
        MinimumSize = Size;
        MaximumSize = Size;
        MaximizeBox = false;
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
            Location = new Point(24, 159), Size = new Size(175, 36), TabIndex = 1
        };
        Controls.Add(increment);
        counter = new Label
        {
            Name = "traceCounter", AccessibleName = "Counter value", Text = "Count: 0",
            Location = new Point(220, 167), AutoSize = true
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
        scrolling = new Panel
        {
            Name = "traceScrollPanel", AccessibleName = "Scrollable fixture panel",
            Location = new Point(24, 281), Size = new Size(500, 150), AutoScroll = true,
            BorderStyle = BorderStyle.FixedSingle, TabIndex = 3
        };
        for (var index = 1; index <= 14; index++)
        {
            scrolling.Controls.Add(new Label
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
        dragTarget.MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) { dragOffset = e.Location; dragTarget.Capture = true; } };
        dragTarget.MouseMove += (_, e) =>
        {
            if (dragOffset is not Point offset) return;
            var pointer = dragArea.PointToClient(dragTarget.PointToScreen(e.Location));
            dragTarget.Location = new Point(
                Math.Clamp(pointer.X - offset.X, 0, dragArea.ClientSize.Width - dragTarget.Width),
                Math.Clamp(pointer.Y - offset.Y, 0, dragArea.ClientSize.Height - dragTarget.Height));
        };
        dragTarget.MouseUp += (_, _) => { dragOffset = null; dragTarget.Capture = false; WriteReceipt(); };
        dragArea.Controls.Add(dragTarget);
        Controls.Add(dragArea);

        textInput.TextChanged += (_, _) => WriteReceipt();
        option.CheckedChanged += (_, _) => WriteReceipt();
        scrolling.Scroll += (_, _) => WriteReceipt();
        Shown += (_, _) => { textInput.Focus(); WriteReceipt(); };
        FormClosed += (_, _) => WriteReceipt();
    }

    private void WriteReceipt()
    {
        var receipt = new
        {
            schemaVersion = 1, runId, title = Text, text = textInput.Text,
            count, optionChecked = option.Checked, scrollY = -scrolling.AutoScrollPosition.Y,
            dragX = dragTarget.Left, dragY = dragTarget.Top, revision = ++revision,
            recordedAt = DateTimeOffset.UtcNow.ToString("O")
        };
        var temporary = receiptPath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, receiptPath, true);
    }
}
