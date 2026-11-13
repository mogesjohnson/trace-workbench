using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Windows.SDK.BuildTools.WinApp.UIAutomation;
using TraceWindows;

internal static partial class Program
{
    private static readonly JsonSerializerOptions WorkerJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static int ReadWorker()
    {
        if (!SetProcessDpiAwarenessContext(new nint(-4)))
            throw new BridgeException("coordinate_space", "The read worker requires physical pixel geometry.");
        using var services = new ServiceCollection()
            .AddSingleton<ILoggerFactory>(NullLoggerFactory.Instance)
            .AddSingleton(typeof(ILogger<>), typeof(NullLogger<>))
            .AddWinAppUiAutomation().BuildServiceProvider();
        Console.OutputEncoding = new UTF8Encoding(false);
        using var cache = new UiaCache(observation: true);
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
        while (input.ReadLine() is { } line)
        {
            if (line.Length > 1024 * 1024) return 1;
            try
            {
                var args = JsonSerializer.Deserialize<string[]>(line);
                var result = args?.FirstOrDefault() switch
                {
                    "observe" => ReadObservation(services.GetRequiredService<IUiAutomation>(),
                        services.GetRequiredService<IWindowCapture>(), cache, args).GetAwaiter().GetResult(),
                    "hit" => HitTest(args),
                    _ => throw new BridgeException("invalid_arguments", "Unknown read worker request.")
                };
                Console.WriteLine(JsonSerializer.Serialize(result, WorkerJson));
            }
            catch (Exception error)
            {
                var code = error switch
                {
                    BridgeException bridge => bridge.Code,
                    WindowReadError read => read.Code,
                    _ => "worker_read_failed"
                };
                Write(new { error = new { code, message = error is BridgeException or WindowReadError ? error.Message : "UIA worker read failed." } });
            }
        }
        return 0;
    }

    private static async Task<object> ReadObservation(IUiAutomation ui, IWindowCapture windows, UiaCache cache, string[] args)
    {
        if (args.Length != 8 || !long.TryParse(args[1], out var handle) || handle <= 0
            || !uint.TryParse(args[2], out var pid) || pid == 0
            || !int.TryParse(args[3], out var depth) || depth is < 1 or > 32
            || args[6] is not ("related" or "none")
            || (args[7].Length != 0 && (!Path.IsPathFullyQualified(args[7])
                || !args[7].EndsWith(".png", StringComparison.OrdinalIgnoreCase))))
            throw new BridgeException("invalid_arguments", "Invalid worker observation arguments.");

        var hwnd = new nint(handle);
        var identityArgs = new[] { "identity", args[1], args[2] };
        var identity = JsonSerializer.SerializeToElement(WindowRead.Query(identityArgs));
        if (identity.GetProperty("processCreationTime").GetString() != args[4]
            || identity.GetProperty("sessionId").GetInt32().ToString(CultureInfo.InvariantCulture) != args[5])
            throw new BridgeException("window_identity_changed", "The selected process lifetime changed.");
        if (IsIconic(hwnd)) throw new BridgeException("window_minimized", "Restore before reading the window.");
        var target = new UiTarget { ProcessId = (int)pid, WindowHandle = handle, IsExplicitWindow = true };
        var before = Geometry(hwnd);
        var runtimeIds = new Dictionary<string, int[]>(StringComparer.Ordinal);
        // Capture and UIA have independent native providers. Both start inside the same geometry
        // bracket and must complete before its final read. The worker's job bounds both operations.
        var capture = args[7].Length == 0 ? null : Task.Run(() => FreshFrame(windows, hwnd));
        UiElement[] elements;
        UiElement? focus;
        try { elements = ReadCachedTree(cache, hwnd, pid, depth, runtimeIds, out focus); }
        catch
        {
            if (capture is not null) try { await capture; } catch { }
            throw;
        }
        // Keep cached COM access on the worker's request thread.
        var pixels = capture is null ? ((byte[] Pixels, int Width, int Height)?)null : capture.GetAwaiter().GetResult();
        var root = elements[0];
        var frame = before.Frame;
        var left = Math.Max(frame.Left, root.X); var top = Math.Max(frame.Top, root.Y);
        var width = Math.Min(frame.Right, root.X + root.Width) - left;
        var height = Math.Min(frame.Bottom, root.Y + root.Height) - top;
        if (width <= 0 || height <= 0 || left != Math.Truncate(left) || top != Math.Truncate(top)
            || width != Math.Truncate(width) || height != Math.Truncate(height))
            throw new BridgeException("coordinate_space", "UIA root has no exact physical pixel intersection.");
        object? screenshot = null;
        if (pixels is { } framePixels)
        {
            if (framePixels.Width != frame.Right - frame.Left || framePixels.Height != frame.Bottom - frame.Top
                || width * height > 16000000)
                throw new BridgeException("coordinate_space", "Capture does not match the exact DWM frame.");
            var crop = new System.Windows.Int32Rect((int)(left - frame.Left), (int)(top - frame.Top), (int)width, (int)height);
            SaveWorkerPng(framePixels, crop, args[7]);
            screenshot = new { width = crop.Width, height = crop.Height, filePath = args[7] };
        }
        object? related = null;
        if (args[6] == "related")
            try { related = RelatedWindows(["related", args[1], args[2]]); }
            catch (BridgeException) { }
        using var check = cache.Root(hwnd);
        var rect = check.Bounds();
        if (check.Number(System.Windows.Automation.AutomationElement.ProcessIdProperty) != pid
            || rect.Left != root.X || rect.Top != root.Y || rect.Right - rect.Left != root.Width || rect.Bottom - rect.Top != root.Height)
            throw new BridgeException("window_moved", "UIA root changed during capture.");
        var focusAvailable = true;
        try { focus ??= await ui.GetFocusedElementAsync(target, default); }
        catch (COMException) { focusAvailable = false; }
        var after = Geometry(hwnd);
        if (!before.Equals(after) || IsIconic(hwnd)) throw new BridgeException("window_moved", "Window geometry changed during capture.");
        Guard(hwnd, pid);
        var bounds = WindowRead.Query(["bounds", args[1], args[2]]);
        if (!after.Equals(Geometry(hwnd))) throw new BridgeException("window_moved", "The final window receipt changed.");
        return new { hwnd = args[1], pid, identity, bounds, elements = Nest(elements),
            focused = focusAvailable ? new { hasFocus = focus is not null, element = focus } : null,
            screenshot, related, runtimeIds };
    }

    private static async Task<(byte[] Pixels, int Width, int Height)> FreshFrame(IWindowCapture windows, nint hwnd)
    {
        // A capture session created for this request cannot return a previous observation's frame.
        // The frame source is HWND-only and never falls back to foregrounding the target.
        using var grabber = windows.StartFrameGrabber(hwnd);
        if (!await grabber.WaitForFirstFrameAsync(TimeSpan.FromMilliseconds(450), default)
            || grabber.TryGetLatest() is not { } frame)
            throw new BridgeException("worker_read_failed", "No fresh window frame arrived.");
        if (frame.Width <= 0 || frame.Height <= 0 || (long)frame.Width * frame.Height > 16000000
            || frame.Pixels.LongLength != (long)frame.Width * frame.Height * 4)
            throw new BridgeException("worker_read_failed", "Window frame exceeds capture bounds.");
        return (frame.Pixels, frame.Width, frame.Height);
    }

    private static (Rect Outer, Rect Frame) Geometry(nint hwnd)
    {
        if (!GetWindowRect(hwnd, out var outer) || DwmGetWindowAttribute(hwnd, 9, out var frame, Marshal.SizeOf<Rect>()) != 0)
            throw new BridgeException("frame_bounds_unavailable", "Exact capture geometry is unavailable.");
        return (outer, frame);
    }

    private static UiElement[] Nest(UiElement[] elements)
    {
        var parents = new UiElement[33];
        var children = new Dictionary<UiElement, List<UiElement>>();
        for (int i = 0; i < elements.Length; i++)
        {
            var element = elements[i];
            if (element.Depth is not int depth || depth < 0 || depth >= parents.Length || (i == 0) != (depth == 0)
                || (depth > 0 && (parents[depth - 1] is null || elements[i - 1].Depth + 1 < depth)))
                throw new BridgeException("invalid_native_response", "Invalid UIA tree depth.");
            if (depth > 0)
            {
                var parent = parents[depth - 1];
                if (!children.TryGetValue(parent, out var group)) children[parent] = group = [];
                group.Add(element);
            }
            parents[depth] = element;
        }
        foreach (var (parent, group) in children) parent.Children = group.ToArray();
        return [elements[0]];
    }

    private static void SaveWorkerPng((byte[] Pixels, int Width, int Height) pixels, System.Windows.Int32Rect crop, string file)
    {
        var encoder = new PngBitmapEncoder();
        var source = BitmapSource.Create(pixels.Width, pixels.Height, 96, 96, PixelFormats.Bgra32, null, pixels.Pixels, pixels.Width * 4);
        encoder.Frames.Add(BitmapFrame.Create(new CroppedBitmap(source, crop)));
        using var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        encoder.Save(output);
    }
}
