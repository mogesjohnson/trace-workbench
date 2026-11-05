using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

internal static partial class Program
{
    private static Int32Rect CaptureCrop(Rect outer, Rect frame)
    {
        var width = (long)outer.Right - outer.Left; var height = (long)outer.Bottom - outer.Top;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 16000000
            || frame.Left < outer.Left || frame.Top < outer.Top || frame.Right > outer.Right || frame.Bottom > outer.Bottom
            || frame.Right <= frame.Left || frame.Bottom <= frame.Top)
            throw new BridgeException("invalid_bounds", "Capture requires a bounded DWM frame inside the native window.");
        return new Int32Rect(frame.Left - outer.Left, frame.Top - outer.Top, frame.Right - frame.Left, frame.Bottom - frame.Top);
    }
    private static void CaptureSelfTest()
    {
        var outer = new Rect { Left = -10, Top = 20, Right = 110, Bottom = 120 };
        var crop = CaptureCrop(outer, new Rect { Left = 0, Top = 25, Right = 100, Bottom = 115 });
        if (crop != new Int32Rect(10, 5, 100, 90)) throw new BridgeException("selftest_failed", "Physical crop failed.");
        foreach (var bad in new[] { new Rect(), new Rect { Left = -11, Top = 25, Right = 100, Bottom = 115 } })
        {
            var rejected = false; try { CaptureCrop(outer, bad); } catch (BridgeException) { rejected = true; }
            if (!rejected) throw new BridgeException("selftest_failed", "Invalid crop accepted.");
        }
    }
    private static void CaptureWindow(string[] args)
    {
        if (args.Length != 4 || !long.TryParse(args[1], out var raw) || raw <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0
            || !Path.IsPathFullyQualified(args[3]) || !args[3].EndsWith(".png", StringComparison.OrdinalIgnoreCase))
            throw new BridgeException("invalid_arguments", "Capture requires HWND PID and an absolute new PNG path.");
        var hwnd = new nint(raw); SetProcessDpiAwarenessContext(new nint(-4)); Guard(hwnd, pid);
        var (crop, frame) = CapturePng(hwnd, pid, args[3]);
        Write(new { hwnd = raw.ToString(), pid, filePath = args[3], width = crop.Width, height = crop.Height,
            bounds = frame.ToBounds(), method = "public-win32-printwindow-dwm", uiaRequired = false });
    }

    // PrintWindow pixels of one guarded HWND, cropped to its DWM frame and written to a new PNG.
    // Geometry is re-read afterwards, so a window that moved or closed yields no file.
    private static (Int32Rect Crop, Rect Frame) CapturePng(nint hwnd, uint pid, string path)
    {
        if (IsIconic(hwnd)) throw new BridgeException("window_minimized", "Restore before capture.");
        if (!GetWindowRect(hwnd, out var outer) || DwmGetWindowAttribute(hwnd, 9, out var frame, Marshal.SizeOf<Rect>()) != 0)
            throw new BridgeException("frame_bounds_unavailable", "Exact capture geometry is unavailable.");
        var crop = CaptureCrop(outer, frame); var width = outer.Right - outer.Left; var height = outer.Bottom - outer.Top;
        var dc = GetWindowDC(hwnd); var memory = nint.Zero; var bitmap = nint.Zero; var previous = nint.Zero;
        try
        {
            if (dc == 0 || (memory = CreateCompatibleDC(dc)) == 0) throw new BridgeException("capture_failed", "Capture DC unavailable.");
            var info = new BitmapInfo { Size = 40, Width = width, Height = -height, Planes = 1, BitCount = 32 };
            bitmap = CreateDIBSection(dc, ref info, 0, out var bits, 0, 0);
            if (bitmap == 0 || bits == 0) throw new BridgeException("capture_failed", "Capture bitmap unavailable.");
            previous = SelectObject(memory, bitmap);
            if (previous == 0 || previous == new nint(-1) || !PrintWindow(hwnd, memory, 2) || !GdiFlush())
                throw new BridgeException("capture_failed", "Window did not supply pixels.");
            var pixels = new byte[checked(width * height * 4)]; Marshal.Copy(bits, pixels, 0, pixels.Length);
            var varied = false;
            for (var i = 0; i < pixels.Length; i += 4)
            {
                if (pixels[i] != pixels[0] || pixels[i + 1] != pixels[1] || pixels[i + 2] != pixels[2]) varied = true;
                pixels[i + 3] = 255;
            }
            if (!varied) throw new BridgeException("capture_blank", "Uniform capture cannot establish rendered content.");
            var source = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgra32, null, pixels, width * 4);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(new CroppedBitmap(source, crop)));
            using var encoded = new MemoryStream(); encoder.Save(encoded);
            if (encoded.Length > 6 * 1024 * 1024) throw new BridgeException("capture_too_large", "PNG exceeds the image limit.");
            Guard(hwnd, pid);
            if (IsIconic(hwnd) || !GetWindowRect(hwnd, out var after) || !outer.Equals(after)
                || DwmGetWindowAttribute(hwnd, 9, out var afterFrame, Marshal.SizeOf<Rect>()) != 0 || !frame.Equals(afterFrame))
                throw new BridgeException("window_moved", "Window geometry changed during capture.");
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { encoded.Position = 0; encoded.CopyTo(output); }
            return (crop, frame);
        }
        finally
        {
            if (previous != 0 && previous != new nint(-1)) SelectObject(memory, previous);
            if (bitmap != 0) DeleteObject(bitmap);
            if (memory != 0) DeleteDC(memory);
            if (dc != 0) ReleaseDC(hwnd, dc);
        }
    }
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo
    {
        public uint Size; public int Width, Height; public ushort Planes, BitCount;
        public uint Compression, SizeImage; public int XPels, YPels; public uint ColorsUsed, ColorsImportant, Color;
    }
    [DllImport("user32.dll")] private static extern nint GetWindowDC(nint hwnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(nint hwnd, nint dc);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PrintWindow(nint hwnd, nint dc, uint flags);
    [DllImport("gdi32.dll")] private static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] private static extern nint CreateDIBSection(nint dc, ref BitmapInfo info, uint usage, out nint bits, nint section, uint offset);
    [DllImport("gdi32.dll")] private static extern nint SelectObject(nint dc, nint value);
    [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeleteObject(nint value);
    [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeleteDC(nint dc);
    [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GdiFlush();
}
