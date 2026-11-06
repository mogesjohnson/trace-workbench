using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Globalization;
using System.Windows.Automation;

// Public Win32/DWM and managed UIA calls. This bridge reads exact geometry and activates one pinned
// HWND/PID. Pointer operations require explicit coordinates, foreground and unobscured target.
// The controller admits them only through its job-owning supervisor and declared-input recovery.
internal static partial class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new BridgeException("unsupported_platform", "Windows is required.");
            if (args.Length == 1 && args[0] == "info")
            {
                Write(new { version = 1, runtime = "net10.0-windows", capabilities = new[] { "identities", "identity", "bounds", "activate", "release-left", "click", "wheel", "document", "capture", "related", "hit", "apps", "process", "packaged", "packaged-identities", "activate-package", "selftest" } });
                return 0;
            }
            if (args.Length == 1 && args[0] == "selftest") { PointerSelfTest(); DocumentSelfTest(); CaptureSelfTest(); RelatedSelfTest(); ApplicationSelfTest(); PackageSelfTest(); Write(new { passed = true, inputSent = false }); return 0; }
            if (args.Length == 1 && args[0] == "apps") { InstalledApplications(); return 0; }
            if (args.Length > 0 && args[0] == "process") { ReadProcess(args); return 0; }
            if (args.Length > 0 && args[0] == "packaged") { ResolvePackage(args); return 0; }
            if (args.Length is >= 2 and <= 101 && args[0] == "packaged-identities") { PackagedIdentities(args); return 0; }
            if (args.Length > 0 && args[0] == "activate-package") { ActivatePackage(args); return 0; }
            if (args.Length > 0 && args[0] == "capture") { CaptureWindow(args); return 0; }
            if (args.Length > 0 && args[0] == "related") { RelatedWindows(args); return 0; }
            if (args.Length > 0 && args[0] == "hit") { HitTest(args); return 0; }
            if (args.Length > 0 && args[0] == "document") { ReadDocument(args); return 0; }
            if (args.Length > 0 && args[0] is "click" or "wheel") { Pointer(args); return 0; }
            if (args.Length == 1 && args[0] == "release-left")
            {
                // Release is intentionally independent of HWND lifetime/foreground. A drag can outlive
                // its window; activating or requiring that window here could leave the global button down.
                var wasDown = (GetAsyncKeyState(1 /* VK_LBUTTON */) & 0x8000) != 0;
                if (wasDown)
                {
                    var inputs = new[] { new Input { Type = 0 /* INPUT_MOUSE */, Mouse = new MouseInput { Flags = 0x0004 /* MOUSEEVENTF_LEFTUP */ } } };
                    if (SendInput(1, inputs, Marshal.SizeOf<Input>()) != 1)
                        throw new BridgeException("input_recovery_failed", "Windows did not accept the left-button release.");
                }
                if ((GetAsyncKeyState(1) & 0x8000) != 0)
                    throw new BridgeException("input_recovery_failed", "The left button remains down after recovery.");
                Write(new { released = true, button = "left", alreadyReleased = !wasDown, method = "public-win32-sendinput" });
                return 0;
            }
            if (args.Length is >= 2 and <= 101 && args[0] == "identities")
            {
                var identities = new List<object>();
                foreach (var argument in args[1..])
                {
                    var pair = argument.Split(':');
                    if (pair.Length != 2 || !long.TryParse(pair[0], out var handle) || handle <= 0 || !uint.TryParse(pair[1], out var processId) || processId == 0)
                        throw new BridgeException("invalid_arguments", "Batch identities require exact HWND:PID pairs.");
                    try { identities.Add(ReadIdentity(new nint(handle), processId)); }
                    catch (Exception error)
                    {
                        identities.Add(new { hwnd = handle.ToString(), pid = processId,
                            identityError = new { code = error is BridgeException bridge ? bridge.Code : "window_bridge_failed" } });
                    }
                }
                Write(new { windows = identities });
                return 0;
            }
            if (args.Length != 3 || (args[0] != "identity" && args[0] != "bounds" && args[0] != "activate") ||
                !long.TryParse(args[1], out var raw) || raw <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0)
                throw new BridgeException("invalid_arguments", "Usage: TraceWindowBridge info|release-left OR bounds|activate <HWND> <PID>");
            var hwnd = new nint(raw);
            SetProcessDpiAwarenessContext(new nint(-4)); // PER_MONITOR_AWARE_V2; physical pixel geometry.
            Guard(hwnd, pid);
            using var process = Process.GetProcessById((int)pid);
            var creationTime = process.StartTime.ToFileTimeUtc().ToString();
            var sessionId = process.SessionId;
            var owner = GetWindow(hwnd, 4 /* GW_OWNER */);
            if (args[0] == "identity")
            {
                // The title is read between the two guards, so it belongs to the guarded window.
                var title = Title(hwnd);
                Guard(hwnd, pid);
                Write(new { hwnd = raw.ToString(), pid, processCreationTime = creationTime, sessionId,
                    ownerWindowId = owner == 0 ? null : owner.ToInt64().ToString(), title, method = "public-win32-identity" });
                return 0;
            }
            if (args[0] == "activate") Activate(hwnd, pid);
            Guard(hwnd, pid);
            if (!GetWindowRect(hwnd, out var outer)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var hr = DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var frame, Marshal.SizeOf<Rect>());
            if (hr != 0) throw new BridgeException("frame_bounds_unavailable", "DWM extended frame bounds are unavailable.");
            Guard(hwnd, pid);
            Guard(hwnd, pid);
            Write(new { hwnd = raw.ToString(), pid, processCreationTime = creationTime, sessionId,
                ownerWindowId = owner == 0 ? null : owner.ToInt64().ToString(),
                windowBounds = outer.ToBounds(), frameBounds = frame.ToBounds(), dpi = GetDpiForWindow(hwnd), dpiAwareness = DpiAwareness(hwnd), foreground = GetForegroundWindow() == hwnd, minimized = IsIconic(hwnd), enabled = IsWindowEnabled(hwnd), method = "public-win32-dwm" });
            return 0;
        }
        catch (Exception error)
        {
            var code = error is BridgeException bridge ? bridge.Code : "window_bridge_failed";
            Console.Error.WriteLine(JsonSerializer.Serialize(new { error = new { code, message = error.Message } }));
            return 1;
        }
    }

    private static void Guard(nint hwnd, uint expectedPid)
    {
        if (!IsWindow(hwnd)) throw new BridgeException("window_closed", "The selected window no longer exists.");
        GetWindowThreadProcessId(hwnd, out var actualPid);
        if (actualPid != expectedPid) throw new BridgeException("window_identity_changed", "The window no longer belongs to the selected process.");
    }

    // GetDpiForWindow returns 96 for an unaware window and the system DPI for a system-aware one, so
    // its value is the monitor scale only when the window is per-monitor aware.
    private static string? DpiAwareness(nint hwnd) =>
        GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd)) switch { 0 => "unaware", 1 => "system", 2 => "per-monitor", _ => null };

    // For another process's window GetWindowText reads the stored caption and sends no message, so a
    // hung target cannot block it. A longer caption is cut at 32,767 characters.
    private static string Title(nint hwnd)
    {
        var text = new char[32768];
        return new string(text, 0, Math.Clamp(GetWindowText(hwnd, text, text.Length), 0, text.Length - 1));
    }

    private static object ReadIdentity(nint hwnd, uint pid)
    {
        Guard(hwnd, pid);
        using var process = Process.GetProcessById((int)pid);
        var created = process.StartTime.ToFileTimeUtc().ToString();
        var session = process.SessionId;
        var owner = GetWindow(hwnd, 4 /* GW_OWNER */);
        string? executable = null; try { executable = process.MainModule?.FileName; } catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException) { }
        Guard(hwnd, pid);
        return new { hwnd = hwnd.ToInt64().ToString(), pid, processCreationTime = created, sessionId = session,
            ownerWindowId = owner == 0 ? null : owner.ToInt64().ToString(), executable, method = "public-win32-identity" };
    }

    private static void Activate(nint hwnd, uint pid)
    {
        GuardEnabled(hwnd, pid);
        // A minimized window can remain the foreground window; it still needs SW_RESTORE.
        if (GetForegroundWindow() == hwnd && !IsIconic(hwnd)) return;
        var current = GetCurrentThreadId();
        var target = GetWindowThreadProcessId(hwnd, out _);
        var foreground = GetWindowThreadProcessId(GetForegroundWindow(), out _);
        // AttachThreadInput needs a message queue on each attached thread; PeekMessage creates ours.
        PeekMessage(out _, nint.Zero, 0, 0, 0);
        var attachedForeground = false;
        var attachedTarget = false;
        try
        {
            if (foreground != 0 && foreground != current) attachedForeground = AttachThreadInput(current, foreground, true);
            if (target != 0 && target != current && target != foreground) attachedTarget = AttachThreadInput(current, target, true);
            GuardEnabled(hwnd, pid);
            if (IsIconic(hwnd)) ShowWindow(hwnd, 9 /* SW_RESTORE */);
            GuardEnabled(hwnd, pid);
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            SetActiveWindow(hwnd);
            Guard(hwnd, pid);
        }
        finally
        {
            if (attachedTarget) AttachThreadInput(current, target, false);
            if (attachedForeground) AttachThreadInput(current, foreground, false);
        }
        // SetForegroundWindow is subject to Windows foreground policy; failure never becomes success.
        if (GetForegroundWindow() != hwnd) throw new BridgeException("foreground_not_target", "Windows refused activation of the selected window.");
    }

    private static void GuardEnabled(nint hwnd, uint pid)
    {
        Guard(hwnd, pid);
        if (!IsWindowEnabled(hwnd)) throw new BridgeException("window_blocked", "The selected window is disabled, for example by an owned modal dialog. Select the enabled dialog explicitly.");
    }

    private static Input[] PointerInputs(string verb, string first, string second)
    {
        Input Event(uint flags, int data = 0) => new() { Type = 0, Mouse = new MouseInput { Flags = flags, MouseData = unchecked((uint)data) } };
        if (verb == "click" && int.TryParse(second, out var count) && count is 1 or 2
            && first is "left" or "right" or "middle" && (count == 1 || first == "left"))
        {
            var down = first == "left" ? 0x0002u : first == "right" ? 0x0008u : 0x0020u;
            return Enumerable.Range(0, count).SelectMany(_ => new[] { Event(down), Event(down << 1) }).ToArray();
        }
        if (verb == "wheel" && int.TryParse(first, out var dx) && int.TryParse(second, out var dy)
            && dx is >= -2400 and <= 2400 && dy is >= -2400 and <= 2400 && dx % 120 == 0 && dy % 120 == 0 && (dx != 0 || dy != 0))
        {
            var events = new List<Input>();
            if (dy != 0) events.Add(Event(0x0800, -dy)); // Public positive Y means down.
            if (dx != 0) events.Add(Event(0x1000, dx)); // Public positive X means right.
            return events.ToArray();
        }
        throw new BridgeException("invalid_arguments", "Unsupported pointer button/count or wheel units.");
    }
    private static void Pointer(string[] args)
    {
        if (args.Length != 7 || !long.TryParse(args[1], out var raw) || raw <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0
            || !int.TryParse(args[3], out var x) || !int.TryParse(args[4], out var y))
            throw new BridgeException("invalid_arguments", "Pointer operation requires HWND PID physicalX physicalY and two bounded gesture arguments.");
        var inputs = PointerInputs(args[0], args[5], args[6]);
        var hwnd = new nint(raw);
        SetProcessDpiAwarenessContext(new nint(-4));
        void Ready()
        {
            GuardEnabled(hwnd, pid);
            if (IsIconic(hwnd) || GetForegroundWindow() != hwnd) throw new BridgeException("foreground_not_target", "Pointer target must be foreground and restored.");
            if (!GetWindowRect(hwnd, out var rect) || x < rect.Left || x >= rect.Right || y < rect.Top || y >= rect.Bottom)
                throw new BridgeException("invalid_coordinates", "Pointer must remain inside the exact target window.");
            var hit = WindowFromPoint(new Point { X = x, Y = y });
            if (hit == 0 || GetAncestor(hit, 2 /* GA_ROOT */) != hwnd) throw new BridgeException("target_occluded", "Another window covers the requested point.");
        }
        Ready();
        if (!SetCursorPos(x, y) || !GetCursorPos(out var cursor) || cursor.X != x || cursor.Y != y)
            throw new BridgeException("pointer_not_positioned", "Windows did not position the cursor at the requested physical point.");
        Ready();
        // One insertion batches both axes or the complete native down/up double-click sequence.
        // Partial insertion is uncertain; the supervising owner balances the declared button after exit.
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length)
            throw new BridgeException("input_rejected", "Windows accepted only part or none of the pointer sequence.");
        Write(new { hwnd = raw.ToString(), pid, performed = true, operation = args[0], inputEvents = inputs.Length, method = "public-win32-sendinput" });
    }
    private static void PointerSelfTest()
    {
        void Require(bool value) { if (!value) throw new BridgeException("selftest_failed", "Pointer contract check failed without input."); }
        Require(Marshal.SizeOf<Input>() == 40);
        foreach (var pair in new[] { ("left", 2u), ("right", 8u), ("middle", 32u) })
        {
            var events = PointerInputs("click", pair.Item1, "1");
            Require(events.Length == 2 && events[0].Mouse.Flags == pair.Item2 && events[1].Mouse.Flags == pair.Item2 * 2);
        }
        Require(PointerInputs("click", "left", "2").Select(e => e.Mouse.Flags).SequenceEqual(new uint[] { 2, 4, 2, 4 }));
        var wheel = PointerInputs("wheel", "-120", "240");
        Require(wheel.Length == 2 && wheel[0].Mouse.Flags == 0x0800 && unchecked((int)wheel[0].Mouse.MouseData) == -240
            && wheel[1].Mouse.Flags == 0x1000 && unchecked((int)wheel[1].Mouse.MouseData) == -120);
        foreach (var invalid in new[] { ("click", "middle", "2"), ("click", "left", "3"), ("wheel", "1", "0"), ("wheel", "0", "0"), ("wheel", "2520", "0") })
        {
            var rejected = false;
            try { PointerInputs(invalid.Item1, invalid.Item2, invalid.Item3); } catch (BridgeException) { rejected = true; }
            Require(rejected);
        }
    }

    private static (string text, bool truncated) BoundedText(Func<int, string> read, int limit)
    {
        var value = read(limit + 1) ?? throw new BridgeException("invalid_native_response", "TextPattern returned no string.");
        var length = Math.Min(value.Length, limit);
        if (length > 0 && length < value.Length && char.IsHighSurrogate(value[length - 1])) length--;
        return (value[..length], value.Length > length);
    }
    private static void DocumentSelfTest()
    {
        var requested = 0;
        var value = BoundedText(n => { requested = n; return "12345"; }, 4);
        if (requested != 5 || value.text != "1234" || !value.truncated
            || BoundedText(_ => "", 4).truncated || BoundedText(_ => "ab😀", 3).text != "ab")
            throw new BridgeException("selftest_failed", "Bounded text planning failed without UIA calls.");
    }
    private static void ReadDocument(string[] args)
    {
        if (args.Length != 10 || !long.TryParse(args[1], out var raw) || raw <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0
            || args[3].Length is < 1 or > 512 || args[4].Length > 64 || args[5].Length > 512)
            throw new BridgeException("invalid_arguments", "Document read requires an exact window and observed automation identity/bounds.");
        var numbers = args[6..].Select(value => double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture)).ToArray();
        if (numbers.Any(value => !double.IsFinite(value)) || numbers[2] <= 0 || numbers[3] <= 0)
            throw new BridgeException("invalid_arguments", "Invalid document bounds.");
        var hwnd = new nint(raw); Guard(hwnd, pid); SetProcessDpiAwarenessContext(new nint(-4));
        var root = AutomationElement.FromHandle(hwnd);
        if (root.Current.ProcessId != pid) throw new BridgeException("window_identity_changed", "UIA root belongs to another process.");
        bool Matches(AutomationElement element)
        {
            var current = element.Current; var rect = current.BoundingRectangle;
            return current.ProcessId == pid && current.AutomationId == args[3] && current.ControlType.ProgrammaticName == "ControlType." + args[4]
                && current.ClassName == args[5] && rect.X == numbers[0] && rect.Y == numbers[1] && rect.Width == numbers[2] && rect.Height == numbers[3];
        }
        var pending = new Stack<(AutomationElement element, int depth)>(); pending.Push((root, 0));
        AutomationElement? found = null; var count = 0; var walker = TreeWalker.ControlViewWalker;
        while (pending.Count > 0)
        {
            var item = pending.Pop();
            if (++count > 10000 || item.depth > 32) throw new BridgeException("native_output_limit", "Document identity search exceeded its bounded tree.");
            if (Matches(item.element))
            {
                if (found is not null) throw new BridgeException("ambiguous_element", "Observed document identity is not unique.");
                found = item.element;
            }
            for (var child = walker.GetFirstChild(item.element); child is not null; child = walker.GetNextSibling(child))
            {
                if (pending.Count + count >= 10000) throw new BridgeException("native_output_limit", "Document identity search exceeded its node budget.");
                pending.Push((child, item.depth + 1));
            }
        }
        if (found is null) throw new BridgeException("stale_element", "Document identity was not found in the current window.");
        var runtime = found.GetRuntimeId();
        object unavailable(string reason) => new { available = false, reason };
        object document, selection;
        if (found.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, true) is not false)
            document = selection = unavailable("password_or_unknown");
        else if (!found.TryGetCurrentPattern(TextPattern.Pattern, out var pattern))
            document = selection = unavailable("text_pattern_unavailable");
        else
        {
            var text = (TextPattern)pattern;
            var content = BoundedText(text.DocumentRange.GetText, 4096);
            document = new { available = true, text = content.text, truncated = content.truncated };
            if (text.SupportedTextSelection == SupportedTextSelection.None) selection = unavailable("selection_unavailable");
            else
            {
                var ranges = text.GetSelection();
                selection = new { available = true, ranges = ranges.Take(4).Select(range => {
                    var bounded = BoundedText(range.GetText, 1024); return new { text = bounded.text, truncated = bounded.truncated };
                }).ToArray(), truncated = ranges.Length > 4 };
            }
        }
        Guard(hwnd, pid);
        if (!Matches(found) || !found.GetRuntimeId().SequenceEqual(runtime)) throw new BridgeException("stale_element", "Document changed while reading.");
        Write(new { hwnd = raw.ToString(), pid, method = "managed-uia-textpattern", document, selection });
    }

    private static void Write(object value) => Console.WriteLine(JsonSerializer.Serialize(value));
    private sealed class BridgeException(string code, string message) : Exception(message) { public string Code { get; } = code; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect
    {
        public int Left, Top, Right, Bottom;
        public object ToBounds()
        {
            if (Right <= Left || Bottom <= Top) throw new BridgeException("invalid_bounds", "The selected window has no positive visible bounds.");
            return new { x = Left, y = Top, width = Right - Left, height = Bottom - Top };
        }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X, Y; public uint MouseData, Flags, Time; public nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public nint Hwnd; public uint Id; public nuint WParam; public nint LParam; public uint Time; public Point Point; public uint Private; }
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowEnabled(nint hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint hwnd, [Out] char[] text, int count);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, out Rect value, int size);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool BringWindowToTop(nint hwnd);
    [DllImport("user32.dll")] private static extern nint SetActiveWindow(nint hwnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AttachThreadInput(uint from, uint to, [MarshalAs(UnmanagedType.Bool)] bool attach);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PeekMessage(out Message message, nint hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetProcessDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetWindowDpiAwarenessContext(nint hwnd);
    [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint hwnd, uint flags);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, [In] Input[] inputs, int size);
}
