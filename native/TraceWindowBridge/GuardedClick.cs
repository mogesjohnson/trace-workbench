using System.Text.Json;
using System.Windows.Automation;

internal static partial class Program
{
    private sealed record ClickTarget(string Id, string Name, string Type, string ClassName, int X, int Y, int Width, int Height, int[]? RuntimeId);
    private sealed record ClickPlan(string Created, int Session, int[] Geometry, int X, int Y, ClickTarget? Target);

    private static void GuardedClick(string[] args)
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
        if (!SetProcessDpiAwarenessContext(new nint(-4)))
            throw new BridgeException("coordinate_space", "Guarded input requires physical pixel geometry.");
        var pressed = false;
        var activated = false;
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
            var root = AutomationElement.FromHandle(hwnd);
            var rect = root.Current.BoundingRectangle;
            if (root.Current.ProcessId != pid || rect.X != plan.Geometry[8] || rect.Y != plan.Geometry[9]
                || rect.Width != plan.Geometry[10] || rect.Height != plan.Geometry[11])
                throw new BridgeException("window_moved", "The selected UIA root geometry changed.");
            if (plan.X < Math.Max(frame.Left, rect.X) || plan.X >= Math.Min(frame.Right, rect.Right)
                || plan.Y < Math.Max(frame.Top, rect.Y) || plan.Y >= Math.Min(frame.Bottom, rect.Bottom))
                throw new BridgeException("invalid_coordinates", "Click point is outside the observed frame.");
        }

        void CheckPoint()
        {
            CheckGeometry(requireForeground: true, checkRoot: true);
            if (plan.Target is { } expected)
            {
                if (expected.RuntimeId is not { Length: > 0 }) throw new BridgeException("stale_element", "Missing exact control identity.");
                var cache = new CacheRequest { AutomationElementMode = AutomationElementMode.None };
                foreach (var property in IdentityProperties) cache.Add(property);
                AutomationElement item;
                using (cache.Activate()) item = AutomationElement.FromPoint(new System.Windows.Point(plan.X, plan.Y));
                if (item is null) throw new BridgeException("stale_element", "The observed control is absent.");
                var element = item.Cached;
                var rect = element.BoundingRectangle;
                if (element.ProcessId != pid || !element.IsEnabled || element.IsOffscreen || element.AutomationId != expected.Id
                    || element.Name != expected.Name || element.ControlType.ProgrammaticName != "ControlType." + expected.Type
                    || element.ClassName != expected.ClassName || rect.X != expected.X || rect.Y != expected.Y
                    || rect.Width != expected.Width || rect.Height != expected.Height
                    || !((int[])item.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty)).SequenceEqual(expected.RuntimeId))
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
