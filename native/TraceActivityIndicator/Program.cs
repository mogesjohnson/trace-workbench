using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

// Local, parent-owned activity marker. It accepts no commands and injects no input.
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 2 || args[0] != "--parent-pid" || !int.TryParse(args[1], out int pid) || pid <= 0) return 2;
        try
        {
            using Process parent = Process.GetProcessById(pid);
            if (parent.HasExited) return 3;
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            using var context = new IndicatorContext(parent);
            Application.Run(context);
            return context.Failed ? 1 : 0;
        }
        catch (Exception error)
        {
            // Diagnostics contain a code, not screen contents, titles, or private paths.
            Console.Error.WriteLine(JsonSerializer.Serialize(new { code = "indicator_failed", kind = error.GetType().Name }));
            return 1;
        }
    }
}

internal sealed class IndicatorContext : ApplicationContext
{
    private readonly List<EdgeWindow> windows = [];
    private readonly Process parent;
    private readonly System.Windows.Forms.Timer lifetime = new() { Interval = 250 };
    private readonly Control dispatcher = new();
    private bool closing;
    public bool Failed { get; private set; }

    public IndicatorContext(Process parent)
    {
        this.parent = parent;
        dispatcher.CreateControl();
        // A control handle is required before stdin EOF can post onto the UI thread.
        _ = dispatcher.Handle;
        Rebuild();
        SystemEvents.DisplaySettingsChanged += DisplayChanged;
        lifetime.Tick += (_, _) => { try { if (parent.HasExited) Stop(); } catch { Stop(); } };
        lifetime.Start();
        // The only protocol message is emitted after every screen's native window is visible.
        Console.Out.WriteLine(JsonSerializer.Serialize(new { version = 1, ready = true, pid = Environment.ProcessId, monitors = windows.Count }));
        Console.Out.Flush();
        _ = Task.Run(async () =>
        {
            try { while (await Console.In.ReadAsync(new char[128], 0, 128) != 0) { } }
            catch { }
            Post(Stop);
        });
    }

    private void Post(Action work)
    {
        try { if (!closing && !dispatcher.IsDisposed) dispatcher.BeginInvoke(work); }
        catch (InvalidOperationException) { }
    }
    private void DisplayChanged(object? sender, EventArgs args) => Post(() =>
    {
        try { Rebuild(); } catch { Failed = true; Stop(); }
    });
    private void Rebuild()
    {
        var replacements = new List<EdgeWindow>();
        try
        {
            foreach (Screen screen in Screen.AllScreens)
            {
                var marker = new EdgeWindow(screen.Bounds);
                replacements.Add(marker);
                marker.Show();
                marker.Render();
                if (!marker.NativeVisible) throw new InvalidOperationException("Indicator did not become visible.");
            }
            if (replacements.Count == 0) throw new InvalidOperationException("No interactive screen.");
        }
        catch { foreach (var marker in replacements) marker.Dispose(); throw; }
        // Publish replacement coverage before removing old windows after a topology change.
        foreach (var marker in windows) marker.Dispose();
        windows.Clear();
        windows.AddRange(replacements);
    }
    private void Stop()
    {
        if (closing) return;
        closing = true;
        lifetime.Stop();
        SystemEvents.DisplaySettingsChanged -= DisplayChanged;
        foreach (var marker in windows) marker.Dispose();
        windows.Clear();
        ExitThread();
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { Stop(); lifetime.Dispose(); dispatcher.Dispose(); }
        base.Dispose(disposing);
    }
}

internal sealed class EdgeWindow : Form
{
    private const int ExLayered = 0x80000, ExTransparent = 0x20, ExToolWindow = 0x80, ExNoActivate = 0x8000000;
    private readonly Rectangle screenBounds;
    public EdgeWindow(Rectangle bounds)
    {
        screenBounds = bounds;
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        AccessibleName = "TRACE computer session active";
        Text = "TRACE activity indicator";
    }
    protected override bool ShowWithoutActivation => true;
    public bool NativeVisible => IsWindowVisible(Handle);
    protected override CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.ExStyle |= ExLayered | ExTransparent | ExToolWindow | ExNoActivate; return value; }
    }
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; } // HTTRANSPARENT
        if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
        base.WndProc(ref message);
    }
    public void Render()
    {
        // Pin physical monitor bounds after WinForms has processed per-monitor DPI startup.
        if (!SetWindowPos(Handle, new IntPtr(-1), screenBounds.X, screenBounds.Y, screenBounds.Width, screenBounds.Height, 0x10 | 0x40)) throw new System.ComponentModel.Win32Exception();
        using var bitmap = new Bitmap(Width, Height, PixelFormat.Format32bppPArgb);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.Clear(Color.Transparent);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int spread = Math.Min(14, Math.Min(Width, Height) / 4);
            for (int inset = spread; inset >= 0; inset--)
            {
                int alpha = 20 + (spread - inset) * 8;
                using var brush = new LinearGradientBrush(new Rectangle(0, 0, Width, Height), Color.FromArgb(alpha, 76, 220, 255), Color.FromArgb(alpha, 160, 112, 255), 40f);
                using var pen = new Pen(brush, 2);
                graphics.DrawRectangle(pen, inset + 1, inset + 1, Width - inset * 2 - 3, Height - inset * 2 - 3);
            }
        }
        IntPtr screen = GetDC(IntPtr.Zero), memory = IntPtr.Zero, image = IntPtr.Zero, previous = IntPtr.Zero;
        try
        {
            memory = CreateCompatibleDC(screen);
            image = bitmap.GetHbitmap(Color.FromArgb(0));
            previous = SelectObject(memory, image);
            var point = new NativePoint(Left, Top); var origin = new NativePoint(0, 0); var size = new NativeSize(Width, Height);
            var blend = new BlendFunction { SourceConstantAlpha = 255, AlphaFormat = 1 };
            if (!UpdateLayeredWindow(Handle, screen, ref point, ref size, memory, ref origin, 0, ref blend, 2)) throw new System.ComponentModel.Win32Exception();
            // Stay above normal app windows without activation, focus, sizing, or keyboard ownership.
            if (!SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x1 | 0x2 | 0x10)) throw new System.ComponentModel.Win32Exception();
        }
        finally
        {
            if (previous != IntPtr.Zero && memory != IntPtr.Zero) SelectObject(memory, previous);
            if (image != IntPtr.Zero) DeleteObject(image);
            if (memory != IntPtr.Zero) DeleteDC(memory);
            if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen);
        }
    }
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint(int x, int y) { public int X = x, Y = y; }
    [StructLayout(LayoutKind.Sequential)] private struct NativeSize(int width, int height) { public int Width = width, Height = height; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] private struct BlendFunction { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr destinationDc, ref NativePoint destination, ref NativeSize size, IntPtr sourceDc, ref NativePoint source, uint colorKey, ref BlendFunction blend, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
