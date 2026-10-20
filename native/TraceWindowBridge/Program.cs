using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;

// Public Win32/DWM calls only. This bridge reads exact capture geometry and activates one pinned
// HWND/PID. Emergency recovery only releases the left button after the owned input process exits;
// it never presses a button, types, captures pixels, launches applications or targets another desktop.
internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new BridgeException("unsupported_platform", "Windows is required.");
            if (args.Length == 1 && args[0] == "info")
            {
                Write(new { version = 1, runtime = "net9.0-windows", capabilities = new[] { "bounds", "activate", "release-left" } });
                return 0;
            }
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
            if (args.Length != 3 || (args[0] != "bounds" && args[0] != "activate") ||
                !long.TryParse(args[1], out var raw) || raw <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0)
                throw new BridgeException("invalid_arguments", "Usage: TraceWindowBridge info|release-left OR bounds|activate <HWND> <PID>");
            var hwnd = new nint(raw);
            SetProcessDpiAwarenessContext(new nint(-4)); // PER_MONITOR_AWARE_V2; physical pixel geometry.
            Guard(hwnd, pid);
            if (args[0] == "activate") Activate(hwnd, pid);
            Guard(hwnd, pid);
            if (!GetWindowRect(hwnd, out var outer)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var hr = DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var frame, Marshal.SizeOf<Rect>());
            if (hr != 0) throw new BridgeException("frame_bounds_unavailable", "DWM extended frame bounds are unavailable.");
            Guard(hwnd, pid);
            Write(new { hwnd = raw.ToString(), pid, windowBounds = outer.ToBounds(), frameBounds = frame.ToBounds(), foreground = GetForegroundWindow() == hwnd, minimized = IsIconic(hwnd), enabled = IsWindowEnabled(hwnd), method = "public-win32-dwm" });
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
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, [In] Input[] inputs, int size);
}
