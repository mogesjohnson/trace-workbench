using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 6 || args[0] != "--directory" || !Path.IsPathFullyQualified(args[1]) || args[2] != "--parent-pid" || !int.TryParse(args[3], out int parentPid) || parentPid <= 0 || args[4] != "--lifetime-ms" || !int.TryParse(args[5], out int lifetime) || lifetime < 10000 || lifetime > 300000) return 2;
        try
        {
            using var parent = Process.GetProcessById(parentPid);
            if (parent.HasExited || !Directory.Exists(args[1])) return 3;
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.Run(new DiagnosticWindow(Path.GetFullPath(args[1]), parent, lifetime));
            return 0;
        }
        catch { return 1; }
    }
}

internal sealed class DiagnosticWindow : Form
{
    private static readonly Color Background = Color.FromArgb(24, 28, 40);
    private readonly string directory;
    private readonly Process parent;
    private readonly int lifetime;
    private readonly Stopwatch elapsed = Stopwatch.StartNew();
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 50 };
    private readonly Rectangle monitor;
    private readonly Button edge;
    private int count;
    private int activationCount;
    private int mouseDownCount;
    private int mouseUpCount;
    private int mouseClickCount;
    private object? lastMouseDown;
    private object? lastMouseUp;
    private object? lastMouseClick;
    private object? lastActivation;
    private bool ready;
    private string lastId = "none";
    private object lastCommand = new { id = "none", type = "none", status = "not_run" };

    public DiagnosticWindow(string directory, Process parent, int lifetime)
    {
        this.directory = directory; this.parent = parent; this.lifetime = lifetime;
        monitor = Screen.PrimaryScreen?.Bounds ?? throw new InvalidOperationException();
        Text = "TRACE owned glow acceptance fixture";
        Name = "traceGlowFixture"; AccessibleName = Text;
        // Keep the owned background below the topmost activity glow, even when activated.
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = true; TopMost = false;
        AutoScaleMode = AutoScaleMode.None; StartPosition = FormStartPosition.Manual;
        Bounds = monitor; BackColor = Background;
        // Its center is seven physical pixels from the screen edge, inside the glow.
        edge = new Button {
            Name = "traceGlowEdgeButton", AccessibleName = "TRACE edge click counter",
            Text = "", Location = new Point(1, monitor.Height / 2 - 44), Size = new Size(12, 88),
            FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(40, 90, 120), UseVisualStyleBackColor = false,
            TabStop = false,
        };
        edge.FlatAppearance.BorderSize = 0;
        // Click also fires for keyboard/UIA activation, so it is diagnostic only.
        // The click-through oracle counts left-button MouseClick events separately.
        edge.Click += (_, _) => {
            activationCount++;
            lastActivation = new { atUtc = DateTimeOffset.UtcNow, elapsedMs = elapsed.ElapsedMilliseconds, input = InputSnapshot(), focus = FocusSnapshot() };
            WriteStatus();
        };
        edge.MouseDown += (_, args) => { mouseDownCount++; lastMouseDown = MouseSnapshot(args); WriteStatus(); };
        edge.MouseUp += (_, args) => { mouseUpCount++; lastMouseUp = MouseSnapshot(args); WriteStatus(); };
        edge.MouseClick += (_, args) => {
            mouseClickCount++;
            if (args.Button == MouseButtons.Left) count++;
            lastMouseClick = MouseSnapshot(args);
            WriteStatus();
        };
        Controls.Add(edge);
        Shown += (_, _) => {
            SetWindowPos(Handle, IntPtr.Zero, monitor.X, monitor.Y, monitor.Width, monitor.Height, 0x40);
            ActiveControl = null; ready = true; WriteStatus(); timer.Start();
        };
        FormClosed += (_, _) => { ready = false; timer.Stop(); WriteStatus(); };
        timer.Tick += (_, _) => Tick();
    }

    private object FocusSnapshot()
    {
        IntPtr foreground = GetForegroundWindow();
        GetWindowThreadProcessId(foreground, out uint foregroundPid);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        bool queried = GetGUIThreadInfo(0, ref info);
        return new { foregroundWindowId = foreground.ToInt64().ToString(), foregroundPid, focusedWindowId = queried ? info.Focus.ToInt64().ToString() : null, fixtureForeground = foreground == Handle };
    }

    private static object InputSnapshot() => new {
        leftButtonDown = (GetAsyncKeyState(0x01) & 0x8000) != 0,
        rightButtonDown = (GetAsyncKeyState(0x02) & 0x8000) != 0,
        middleButtonDown = (GetAsyncKeyState(0x04) & 0x8000) != 0,
        controlDown = (GetAsyncKeyState(0x11) & 0x8000) != 0,
        spaceDown = (GetAsyncKeyState(0x20) & 0x8000) != 0,
        shiftDown = (GetAsyncKeyState(0x10) & 0x8000) != 0,
        altDown = (GetAsyncKeyState(0x12) & 0x8000) != 0,
    };

    private object MouseSnapshot(MouseEventArgs args)
    {
        var point = edge.PointToScreen(args.Location);
        return new {
            button = args.Button.ToString(), clicks = args.Clicks,
            controlX = args.X, controlY = args.Y, screenX = point.X, screenY = point.Y,
            atUtc = DateTimeOffset.UtcNow, elapsedMs = elapsed.ElapsedMilliseconds,
            input = InputSnapshot(),
        };
    }

    private void Tick()
    {
        try { if (parent.HasExited || elapsed.ElapsedMilliseconds >= lifetime) { Close(); return; } }
        catch { Close(); return; }
        string commands = Path.Combine(directory, "commands.json");
        if (!File.Exists(commands)) return;
        try
        {
            if (new FileInfo(commands).Length > 8192) return;
            using var document = JsonDocument.Parse(File.ReadAllText(commands));
            JsonElement command = document.RootElement;
            string id = command.GetProperty("id").GetString() ?? "";
            string type = command.GetProperty("type").GetString() ?? "";
            if (!Regex.IsMatch(id, "^[a-zA-Z0-9-]{1,80}$") || id == lastId) return;
            lastId = id;
            var before = FocusSnapshot();
            try
            {
                object? capture = null;
                if (type == "capture-desktop")
                {
                    string file = command.GetProperty("file").GetString() ?? "";
                    int indicatorPid = command.TryGetProperty("indicatorPid", out var pid) ? pid.GetInt32() : 0;
                    capture = CaptureDesktop(file, indicatorPid);
                }
                else if (type != "focus" && type != "close") throw new InvalidOperationException("unsupported_command");
                lastCommand = new { id, type, status = "pass", before, after = FocusSnapshot(), capture };
                WriteStatus();
                if (type == "close") Close();
            }
            catch (Exception error)
            {
                string code = Regex.IsMatch(error.Message, "^[a-z_]{1,64}$") ? error.Message : "fixture_command_failed";
                lastCommand = new { id, type, status = "fail", code, before, after = FocusSnapshot() };
                WriteStatus();
            }
        }
        catch (IOException) { }
        catch (JsonException) { }
        catch (KeyNotFoundException) { }
    }

    private void AssertSafeScreen(int indicatorPid)
    {
        if (!ready || GetForegroundWindow() != Handle || !IsWindowVisible(Handle) || IsIconic(Handle)) throw new InvalidOperationException("fixture_not_foreground");
        if (Screen.PrimaryScreen?.Bounds != monitor || !GetWindowRect(Handle, out var own) || own.Left != monitor.Left || own.Top != monitor.Top || own.Right != monitor.Right || own.Bottom != monitor.Bottom) throw new InvalidOperationException("fixture_geometry_changed");
        bool found = false, foreign = false;
        EnumWindows((window, _) => {
            if (window == Handle) { found = true; return false; }
            if (!IsWindowVisible(window) || !GetWindowRect(window, out var rectangle)) return true;
            if (DwmGetWindowAttribute(window, 14, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            if (!Rectangle.FromLTRB(rectangle.Left, rectangle.Top, rectangle.Right, rectangle.Bottom).IntersectsWith(monitor)) return true;
            GetWindowThreadProcessId(window, out uint pid);
            bool allowed = pid == indicatorPid && indicatorPid > 0;
            if (allowed) { try { using var marker = Process.GetProcessById(indicatorPid); allowed = marker.ProcessName == "TraceActivityIndicator"; } catch { allowed = false; } }
            if (!allowed) foreign = true;
            return true;
        }, IntPtr.Zero);
        if (!found || foreign) throw new InvalidOperationException("foreign_overlay_above_fixture");
    }

    private object CaptureDesktop(string file, int indicatorPid)
    {
        if (!Regex.IsMatch(file, "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}\\.png$")) throw new InvalidOperationException("invalid_capture_filename");
        AssertSafeScreen(indicatorPid);
        using var image = new Bitmap(monitor.Width, monitor.Height, PixelFormat.Format32bppRgb);
        using (Graphics graphics = Graphics.FromImage(image))
        {
            IntPtr screen = GetDC(IntPtr.Zero), destinationDc = IntPtr.Zero;
            try
            {
                destinationDc = graphics.GetHdc();
                // CAPTUREBLT explicitly includes layered windows such as TRACE's glow.
                // Direct public BitBlt avoids CopyPixelOperation enum-validation differences.
                if (!BitBlt(destinationDc, 0, 0, monitor.Width, monitor.Height, screen, monitor.X, monitor.Y, 0x00CC0020 | 0x40000000)) throw new InvalidOperationException("capture_blt_failed");
            }
            finally { if (destinationDc != IntPtr.Zero) graphics.ReleaseHdc(destinationDc); if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen); }
        }
        AssertSafeScreen(indicatorPid);
        // Outside the 24-pixel edge band the fixture is exactly one known RGB color.
        // Refuse to save a desktop image if an unexpected window/notification was captured.
        var pixels = image.LockBits(new Rectangle(Point.Empty, image.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try
        {
            if (pixels.Stride <= 0) throw new InvalidOperationException("unsupported_capture_stride");
            byte[] bytes = new byte[Math.Abs(pixels.Stride) * image.Height];
            Marshal.Copy(pixels.Scan0, bytes, 0, bytes.Length);
            for (int y = 24; y < image.Height - 24; y++) for (int x = 24; x < image.Width - 24; x++)
            {
                int offset = y * pixels.Stride + x * 4;
                if (bytes[offset] != Background.B || bytes[offset + 1] != Background.G || bytes[offset + 2] != Background.R) throw new InvalidOperationException("unexpected_interior_pixels");
            }
        }
        finally { image.UnlockBits(pixels); }
        string destination = Path.Combine(directory, file);
        if (File.Exists(destination)) throw new InvalidOperationException("capture_exists");
        image.Save(destination, ImageFormat.Png);
        string digest = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(destination))).ToLowerInvariant();
        return new { file, sha256 = digest, width = image.Width, height = image.Height, method = "public-win32-bitblt-captureblt", layeredWindows = true, sanitizedInteriorRgb = new[] { Background.R, Background.G, Background.B } };
    }

    private void WriteStatus()
    {
        var button = edge.RectangleToScreen(edge.ClientRectangle);
        var receipt = new {
            version = 1, ready, pid = Environment.ProcessId, windowId = Handle.ToInt64().ToString(),
            monitor = new { x = monitor.X, y = monitor.Y, width = monitor.Width, height = monitor.Height },
            dpi = DeviceDpi, count, countOracle = "left-button-mouseclick-events",
            activationCount, mouseDownCount, mouseUpCount, mouseClickCount,
            lastMouseDown, lastMouseUp, lastMouseClick, lastActivation,
            button = new { x = button.X, y = button.Y, width = button.Width, height = button.Height },
            input = InputSnapshot(), focus = FocusSnapshot(), lastCommand,
        };
        try
        {
            string temporary = Path.Combine(directory, "status.tmp");
            File.WriteAllText(temporary, JsonSerializer.Serialize(receipt));
            File.Move(temporary, Path.Combine(directory, "status.json"), true);
        }
        catch (IOException) { }
    }

    protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }
    private delegate bool WindowVisitor(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct GuiThreadInfo { public uint Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public NativeRect CaretRect; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rectangle);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowVisitor visitor, IntPtr parameter);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
