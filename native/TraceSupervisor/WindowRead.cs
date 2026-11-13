using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace TraceWindows;

// Shared by the standalone bridge and the session owner. No UIA, window messages or input.
internal static class WindowRead
{
    public static object Query(string[] args, Action<nint, uint>? activate = null)
    {
        if (args.Length != 3 || args[0] is not ("identity" or "bounds")
            || !long.TryParse(args[1], out var handle) || handle <= 0 || !uint.TryParse(args[2], out var pid) || pid == 0)
            throw new WindowReadError("invalid_arguments", "Window reads require identity|bounds, HWND and PID.");

        var hwnd = new nint(handle);
        Guard(hwnd, pid);
        using var process = OpenProcess(0x101000 /* SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (process.IsInvalid || !GetProcessTimes(process, out var creation, out _, out _, out _)
            || !ProcessIdToSessionId(pid, out var session))
            throw new WindowReadError("identity_unavailable", "The selected window's process identity is unavailable.");
        var created = creation.ToString();
        var owner = GetWindow(hwnd, 4 /* GW_OWNER */);
        var ownerId = owner == 0 ? null : owner.ToInt64().ToString();
        activate?.Invoke(hwnd, pid);
        object result;
        if (args[0] == "identity")
        {
            // GetWindowText reads the stored title of an external window without sending a message.
            var text = new char[32768];
            var title = new string(text, 0, GetWindowText(hwnd, text, text.Length));
            result = new { hwnd = handle.ToString(), pid, processCreationTime = created, sessionId = session,
                ownerWindowId = ownerId, title, method = "public-win32-identity" };
        }
        else
        {
            var previous = SetThreadDpiAwarenessContext(new nint(-4) /* PER_MONITOR_AWARE_V2 */);
            if (previous == 0) throw new WindowReadError("coordinate_space", "Physical pixel window bounds are unavailable.");
            try
            {
                if (!GetWindowRect(hwnd, out var outer)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var frame, Marshal.SizeOf<Rect>()) != 0)
                    throw new WindowReadError("frame_bounds_unavailable", "DWM extended frame bounds are unavailable.");
                var dpi = GetDpiForWindow(hwnd);
                var awareness = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd)) switch
                { 0 => "unaware", 1 => "system", 2 => "per-monitor", _ => null };
                result = new { hwnd = handle.ToString(), pid, processCreationTime = created, sessionId = session, ownerWindowId = ownerId,
                    windowBounds = outer.ToBounds(), frameBounds = frame.ToBounds(), dpi, dpiAwareness = awareness,
                    foreground = GetForegroundWindow() == hwnd, minimized = IsIconic(hwnd), enabled = IsWindowEnabled(hwnd), method = "public-win32-dwm" };
            }
            finally { SetThreadDpiAwarenessContext(previous); }
        }
        Guard(hwnd, pid);
        var wait = WaitForSingleObject(process, 0);
        if (wait == 0) throw new WindowReadError("window_closed", "The selected window process exited.");
        if (wait != 0x102 /* WAIT_TIMEOUT */) throw new WindowReadError("identity_unavailable", "The selected process lifetime could not be verified.");
        return result;
    }

    private static void Guard(nint hwnd, uint pid)
    {
        if (!IsWindow(hwnd)) throw new WindowReadError("window_closed", "The selected window no longer exists.");
        if (GetWindowThreadProcessId(hwnd, out var actual) == 0 || actual != pid)
            throw new WindowReadError("window_identity_changed", "The window no longer belongs to the selected process.");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
        public object ToBounds()
        {
            if (Right <= Left || Bottom <= Top) throw new WindowReadError("invalid_bounds", "The selected window has no positive visible bounds.");
            return new { x = Left, y = Top, width = Right - Left, height = Bottom - Top };
        }
    }

    [DllImport("user32.dll")] private static extern bool IsWindow(nint hwnd);
    [DllImport("kernel32.dll")] private static extern SafeWaitHandle OpenProcess(uint access, bool inheritHandle, uint pid);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(SafeWaitHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(SafeWaitHandle process, uint timeout);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint hwnd, [Out] char[] text, int count);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, out Rect rect, int size);
    [DllImport("user32.dll")] private static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetWindowDpiAwarenessContext(nint hwnd);
    [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(nint context);
}

internal sealed class WindowReadError(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
