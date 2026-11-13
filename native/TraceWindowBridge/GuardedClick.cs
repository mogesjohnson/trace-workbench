using System.Text.Json;
using System.Windows.Automation;

internal static partial class Program
{
    private sealed record ClickTarget(string Id, string Name, string Type, string ClassName, int X, int Y, int Width, int Height, int[]? RuntimeId);
    private sealed record ClickPlan(string Created, int Session, int[] Geometry, int X, int Y, ClickTarget? Target);

    private static int ClickWorker()
    {
        if (!SetProcessDpiAwarenessContext(new nint(-4)))
            throw new BridgeException("coordinate_space", "Guarded input requires physical pixel geometry.");
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        using var cache = new UiaCache(observation: false);
        // Exercise the native cache transport before accepting a click. The desktop root is
        // used only to initialize COM and is never returned or treated as a click target.
        using (cache.Root(GetDesktopWindow())) { }
        Console.WriteLine("{}");
        using var input = new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false, true));
        var line = input.ReadLine();
        if (line is null) return 0;
        if (line.Length > 8192) return 1;
        GuardedClick(JsonSerializer.Deserialize<string[]>(line) ?? [], cache);
        return 0;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern nint GetDesktopWindow();

    private static void GuardedClick(string[] args, UiaCache? warmed = null)
    {
        if (args.Length != 4 || !long.TryParse(args[1], out var handle) || handle <= 0
            || !uint.TryParse(args[2], out var pid) || pid == 0 || args[3].Length > 4096)
            throw new BridgeException("invalid_arguments", "Invalid guarded click target.");
        var plan = JsonSerializer.Deserialize<ClickPlan>(args[3], WorkerJson)
            ?? throw new BridgeException("invalid_arguments", "Missing guarded click target.");
        if (plan.Geometry is not { Length: 12 } || string.IsNullOrEmpty(plan.Created)
            || plan.Geometry[2] <= 0 || plan.Geometry[3] <= 0 || plan.Geometry[6] <= 0 || plan.Geometry[7] <= 0)
            throw new BridgeException("invalid_arguments", "Missing guarded click geometry.");
        var hwnd = new nint(handle);
        if (warmed is null && !SetProcessDpiAwarenessContext(new nint(-4)))
            throw new BridgeException("coordinate_space", "Guarded input requires physical pixel geometry.");
        var pressed = false;
        var activated = false;
        using var owned = warmed is null ? new UiaCache(observation: false) : null;
        var cache = warmed ?? owned!;
        try
        {
            CheckGeometry(requireForeground: false, checkRoot: false);
            Activate(hwnd, pid);
            activated = true;
            CheckHit();
            if (!SetCursorPos(plan.X, plan.Y) || !GetCursorPos(out var cursor) || cursor.X != plan.X || cursor.Y != plan.Y)
                throw new BridgeException("pointer_not_positioned", "Windows did not position the cursor at the requested physical point.");
            CheckPoint();
            pressed = true;
            var events = PointerInputs("click", "left", "1");
            if (SendInput((uint)events.Length, events, System.Runtime.InteropServices.Marshal.SizeOf<Input>()) != events.Length)
                throw new BridgeException("input_rejected", "Windows accepted only part or none of the pointer sequence.");
            Write(new { hwnd = args[1], pid, performed = true, operation = "click", inputEvents = events.Length, activated, method = "public-win32-sendinput" });
        }
        catch (Exception error) when (!pressed && error is BridgeException or System.Runtime.InteropServices.COMException
            or ElementNotAvailableException or ArgumentException or InvalidOperationException)
        {
            var code = error is BridgeException bridge ? bridge.Code : "stale_element";
            var message = error is BridgeException ? error.Message : "The observed target could not be revalidated.";
            Write(new { hwnd = args[1], pid, performed = false, refusedBeforeSend = true, activated, code, message });
        }

        void CheckGeometry(bool requireForeground, bool checkRoot)
        {
            GuardEnabled(hwnd, pid);
            if (IsIconic(hwnd)) throw new BridgeException("window_moved", "The window was minimized.");
            if (requireForeground && GetForegroundWindow() != hwnd)
                throw new BridgeException("foreground_not_target", "The window lost foreground before input.");
            using var process = System.Diagnostics.Process.GetProcessById((int)pid);
            if (process.StartTime.ToFileTimeUtc().ToString() != plan.Created || process.SessionId != plan.Session || process.HasExited)
                throw new BridgeException("window_identity_changed", "The target process lifetime changed.");
            var (outer, frame) = Geometry(hwnd);
            int[] actual = [outer.Left, outer.Top, outer.Right - outer.Left, outer.Bottom - outer.Top,
                frame.Left, frame.Top, frame.Right - frame.Left, frame.Bottom - frame.Top];
            if (!actual.SequenceEqual(plan.Geometry.Take(8)))
                throw new BridgeException("window_moved", "The selected window geometry changed.");
            if (plan.X < frame.Left || plan.X >= frame.Right || plan.Y < frame.Top || plan.Y >= frame.Bottom)
                throw new BridgeException("invalid_coordinates", "Click point is outside the observed frame.");
            if (!checkRoot) return;
            using var root = cache.Root(hwnd);
            var rect = root.Bounds();
            if (root.Number(AutomationElement.ProcessIdProperty) != pid || rect.Left != plan.Geometry[8] || rect.Top != plan.Geometry[9]
                || rect.Right - rect.Left != plan.Geometry[10] || rect.Bottom - rect.Top != plan.Geometry[11])
                throw new BridgeException("window_moved", "The selected UIA root geometry changed.");
            if (plan.X < Math.Max(frame.Left, rect.Left) || plan.X >= Math.Min(frame.Right, rect.Right)
                || plan.Y < Math.Max(frame.Top, rect.Top) || plan.Y >= Math.Min(frame.Bottom, rect.Bottom))
                throw new BridgeException("invalid_coordinates", "Click point is outside the observed frame.");
        }

        void CheckPoint()
        {
            CheckGeometry(requireForeground: true, checkRoot: true);
            if (plan.Target is { } expected)
            {
                if (expected.RuntimeId is not { Length: > 0 }) throw new BridgeException("stale_element", "Missing exact control identity.");
                using var item = cache.At(plan.X, plan.Y);
                var rect = item.Bounds();
                if (item.Number(AutomationElement.ProcessIdProperty) != pid || !item.Flag(AutomationElement.IsEnabledProperty)
                    || item.Flag(AutomationElement.IsOffscreenProperty) || item.Text(AutomationElement.AutomationIdProperty) != expected.Id
                    || item.Text(AutomationElement.NameProperty) != expected.Name
                    || UiaControlName(item.Number(AutomationElement.ControlTypeProperty)) != expected.Type
                    || item.Text(AutomationElement.ClassNameProperty) != expected.ClassName || rect.Left != expected.X || rect.Top != expected.Y
                    || rect.Right - rect.Left != expected.Width || rect.Bottom - rect.Top != expected.Height
                    || !item.RuntimeId().SequenceEqual(expected.RuntimeId))
                    throw new BridgeException("stale_element", "The point no longer resolves to the observed control.");
            }
            CheckHit();
        }

        void CheckHit()
        {
            GuardEnabled(hwnd, pid);
            var hit = WindowFromPoint(new Point { X = plan.X, Y = plan.Y });
            if (GetForegroundWindow() != hwnd || hit == 0 || GetAncestor(hit, 2) != hwnd)
                throw new BridgeException("target_occluded", "The observed point is covered.");
        }
    }
}
