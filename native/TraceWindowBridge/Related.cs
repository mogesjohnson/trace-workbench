using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Automation;

// Related transient windows of one guarded root: menus, tooltips and owned popups that sit above it.
// Read-only: no input and no window messages. The list is context for the root's observation; it
// never names a target that input may use.
internal static partial class Program
{
    private const int RelatedLimit = 16;
    private const int RelatedUiaBudgetMs = 2000;

    // Usage: related <HWND> <PID> [<absolute PNG prefix>]. With a prefix, window i is captured to
    // "<prefix>-<i>.png" through the same exact-frame PrintWindow path as the root.
    private static void RelatedWindows(string[] args)
    {
        if (args.Length is not (3 or 4) || !long.TryParse(args[1], out var raw) || raw <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0
            || (args.Length == 4 && (!Path.IsPathFullyQualified(args[3]) || args[3].EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                || !Directory.Exists(Path.GetDirectoryName(args[3])))))
            throw new BridgeException("invalid_arguments", "Usage: related <HWND> <PID> [<absolute PNG prefix in an existing directory>]");
        var root = new nint(raw); var prefix = args.Length == 4 ? args[3] : null;
        SetProcessDpiAwarenessContext(new nint(-4));
        Guard(root, pid);
        var rootThread = GetWindowThreadProcessId(root, out _);
        // A Win32 menu (#32768) has no owner; only its thread's menu state names the window it serves.
        var gui = new GuiThreadInfo { Size = Marshal.SizeOf<GuiThreadInfo>() };
        var menuStateAvailable = GetGUIThreadInfo(rootThread, ref gui);
        var menuActive = menuStateAvailable && (gui.Flags & 0x14 /* GUI_INMENUMODE | GUI_POPUPMENUMODE */) != 0 && gui.MenuOwner == root;

        // EnumWindows walks top-level windows from the top of the z-order, so every window seen
        // before the root is above it. Windows below the root cannot cover it and are not listed.
        var above = new List<nint>(); var rootSeen = false;
        EnumWindows((hwnd, _) => { if (hwnd == root) { rootSeen = true; return false; } above.Add(hwnd); return true; }, 0);
        if (!rootSeen) throw new BridgeException("window_closed", "The selected window left the top-level z-order.");

        var windows = new List<object>(); var truncated = false; var uiaDeadline = Environment.TickCount64 + RelatedUiaBudgetMs;
        foreach (var hwnd in above)
        {
            if (!IsWindowVisible(hwnd) || (DwmGetInt(hwnd, 14 /* DWMWA_CLOAKED */, out var cloaked, 4) == 0 && cloaked != 0)) continue;
            var thread = GetWindowThreadProcessId(hwnd, out var windowPid);
            if (thread == 0) continue;
            var className = ClassName(hwnd);
            // Drop shadows are separate unowned layered windows; they only repeat a popup's outline.
            if (className == "SysShadow") continue;
            var popup = (GetWindowLongPtr(hwnd, -16 /* GWL_STYLE */) & 0x80000000L /* WS_POPUP */) != 0;
            string? relation = OwnedBy(hwnd, root) ? "owned"
                : className == "#32768" && thread == rootThread && menuActive ? "thread-menu"
                : thread == rootThread && popup ? "same-thread-popup" : null;
            if (relation is null) continue;
            if (!GetWindowRect(hwnd, out var outer)) continue;
            var framed = DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var frame, Marshal.SizeOf<Rect>()) == 0;
            var box = framed ? frame : outer;
            if (box.Right <= box.Left || box.Bottom <= box.Top) continue;
            if (windows.Count == RelatedLimit) { truncated = true; break; }
            var index = windows.Count;
            var uia = RelatedUia(hwnd, uiaDeadline);
            var title = Title(hwnd);
            object? image = null;
            if (prefix is not null)
            {
                var file = $"{prefix}-{index}.png";
                try { var (crop, _) = CapturePng(hwnd, windowPid, file); image = new { available = true, filePath = file, width = crop.Width, height = crop.Height }; }
                catch (BridgeException error) { image = new { available = false, code = error.Code }; }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception) { image = new { available = false, code = "capture_failed" }; }
            }
            windows.Add(new
            {
                hwnd = hwnd.ToInt64().ToString(), pid = windowPid, relation, kind = RelatedKind(className, uia.ControlType),
                className = Clip(className), title = title.Length == 0 ? null : Clip(title), zOrder = index,
                bounds = box.ToBounds(), boundsSource = framed ? "dwm-frame" : "window-rect",
                dpi = GetDpiForWindow(hwnd), dpiAwareness = DpiAwareness(hwnd),
                topmost = (GetWindowLongPtr(hwnd, -20 /* GWL_EXSTYLE */) & 0x8 /* WS_EX_TOPMOST */) != 0,
                uia = uia.Code is null ? (object)new { available = true, controlType = uia.ControlType, name = Clip(uia.Name ?? "") } : new { available = false, code = uia.Code },
                image,
            });
        }
        Guard(root, pid);
        Write(new
        {
            hwnd = raw.ToString(), pid, method = "public-win32-related",
            menuMode = menuStateAvailable ? (object)new { available = true, active = menuActive } : new { available = false },
            // What was searched. Unowned windows of other threads or processes (for example a shell or
            // IME popup) are never attributed to the root, so their absence proves nothing.
            coverage = new { ownerChain = true, threadMenu = menuStateAvailable, sameThreadPopups = true, otherThreadsAndProcesses = false },
            truncated, windows,
        });
    }

    // Usage: hit <HWND> <PID> <x> <y> [<x> <y>]... (1-4 physical screen points). Read-only: for each
    // point, the top-level window WindowFromPoint resolves to, and whether it is one of the root's
    // own popups (owner chain or the root's UI thread). Pointer input through winapp is refused when
    // such a popup covers its point, because the click would land in the popup.
    private static void HitTest(string[] args)
    {
        if (args.Length is < 5 or > 11 || args.Length % 2 == 0 || !long.TryParse(args[1], out var raw) || raw <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0)
            throw new BridgeException("invalid_arguments", "Usage: hit <HWND> <PID> <x> <y> [<x> <y>]... with one to four points.");
        var points = new List<(int X, int Y)>();
        for (var i = 3; i < args.Length; i += 2)
        {
            if (!int.TryParse(args[i], out var x) || !int.TryParse(args[i + 1], out var y)) throw new BridgeException("invalid_arguments", "Hit points must be integer physical screen coordinates.");
            points.Add((x, y));
        }
        var root = new nint(raw);
        SetProcessDpiAwarenessContext(new nint(-4));
        Guard(root, pid);
        var rootThread = GetWindowThreadProcessId(root, out _);
        var results = points.Select(point =>
        {
            var hit = WindowFromPoint(new Point { X = point.X, Y = point.Y });
            var top = hit == 0 ? 0 : GetAncestor(hit, 2 /* GA_ROOT */);
            if (top == root) return (object)new { x = point.X, y = point.Y, clear = true };
            if (top == 0) return new { x = point.X, y = point.Y, clear = false, coveredBy = new { windowId = (string?)null, related = false } };
            var thread = GetWindowThreadProcessId(top, out var topPid);
            return new { x = point.X, y = point.Y, clear = false, coveredBy = new { windowId = (string?)top.ToInt64().ToString(), pid = topPid,
                className = Clip(ClassName(top)), related = OwnedBy(top, root) || (thread != 0 && thread == rootThread) } };
        }).ToList();
        Guard(root, pid);
        Write(new { hwnd = raw.ToString(), pid, method = "public-win32-hit", points = results });
    }

    private static bool OwnedBy(nint hwnd, nint root)
    {
        var owner = GetWindow(hwnd, 4 /* GW_OWNER */);
        for (var depth = 0; owner != 0 && depth < 32; depth++, owner = GetWindow(owner, 4))
            if (owner == root) return true;
        return false;
    }

    // UIA reads of another process can block, so all of them share one deadline; after it the
    // remaining windows report uia unavailable and fall back to their class for kind.
    private static (string? ControlType, string? Name, string? Code) RelatedUia(nint hwnd, long deadline)
    {
        var remaining = deadline - Environment.TickCount64;
        if (remaining <= 0) return (null, null, "uia_budget_exhausted");
        var read = Task.Run(() => { var element = AutomationElement.FromHandle(hwnd); return (element.Current.ControlType.ProgrammaticName, element.Current.Name); });
        try { return read.Wait(TimeSpan.FromMilliseconds(remaining)) ? (read.Result.ProgrammaticName, read.Result.Name, null) : (null, null, "uia_timeout"); }
        catch (AggregateException) { return (null, null, "uia_unavailable"); }
    }

    private static string RelatedKind(string className, string? controlType) => controlType switch
    {
        "ControlType.Menu" => "menu",
        "ControlType.ToolTip" => "tooltip",
        _ when className == "#32768" => "menu",
        _ when className.Contains("tooltips_class32", StringComparison.OrdinalIgnoreCase) => "tooltip",
        "ControlType.Window" => "window",
        _ => "other",
    };

    private static string Clip(string value) => value.Length > 256 ? value[..256] : value;

    private static string ClassName(nint hwnd)
    {
        var text = new char[257];
        return new string(text, 0, Math.Clamp(GetClassName(hwnd, text, text.Length), 0, text.Length - 1));
    }

    private static void RelatedSelfTest()
    {
        if (RelatedKind("#32768", null) != "menu" || RelatedKind("WindowsForms10.tooltips_class32.app.0.1", "ControlType.Pane") != "tooltip"
            || RelatedKind("X", "ControlType.Menu") != "menu" || RelatedKind("X", "ControlType.Window") != "window" || RelatedKind("X", null) != "other"
            || Clip(new string('a', 300)).Length != 256)
            throw new BridgeException("selftest_failed", "Related window classification failed.");
    }

    private delegate bool EnumWindowsProc(nint hwnd, nint parameter);
    [StructLayout(LayoutKind.Sequential)] private struct GuiThreadInfo
    {
        public int Size; public uint Flags; public nint Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect;
    }
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern long GetWindowLongPtr(nint hwnd, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint hwnd, [Out] char[] text, int count);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetInt(nint hwnd, uint attribute, out int value, int size);
}
