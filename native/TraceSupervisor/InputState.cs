using System.Runtime.InteropServices;
using System.Text;

namespace TraceSupervisor;

// Global asynchronous key/button state and balancing releases for TRACE-declared input.
internal static class InputState
{
    private const int Shift = 0x10, Control = 0x11, Menu = 0x12;
    // Extended scan codes are required for right-side modifiers, navigation keys and Windows keys.
    private static readonly HashSet<int> Extended = [0xA3, 0xA5, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x6F, 0x90];

    public static bool IsDown(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
    public static bool IsMouse(int vk) => vk is 0x01 or 0x02 or 0x04 or 0x05 or 0x06;

    public static SortedSet<int> Down()
    {
        EnsureObservable();
        var down = new SortedSet<int>();
        for (var vk = 1; vk < 255; vk++) if (IsDown(vk)) down.Add(vk);
        return down;
    }

    // GetAsyncKeyState returns zero both for released input and inaccessible/inactive desktops:
    // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getasynckeystate
    // Prove the calling thread shares the ordinary active desktop, and that UIPI does not hide the
    // foreground process, before using an all-zero observation as cleanup evidence.
    public static void EnsureObservable()
    {
        static string DesktopName(nint handle)
        {
            var name = new StringBuilder(256);
            if (handle == 0 || !Native.GetUserObjectInformation(handle, 2 /* UOI_NAME */, name, 512, out _))
                throw new TraceError("input_desktop_unavailable", "Input state cannot be inspected on the active desktop.", Marshal.GetLastWin32Error());
            return name.ToString();
        }
        // DESKTOP_HOOKCONTROL is required for reliable foreground-thread async state access.
        var input = Native.OpenInputDesktop(0, false, 0x0001 | 0x0008 /* READOBJECTS | HOOKCONTROL */);
        if (input == 0) throw new TraceError("input_desktop_unavailable", "Input state cannot be inspected on the active desktop.", Marshal.GetLastWin32Error());
        try
        {
            var thread = DesktopName(Native.GetThreadDesktop(Native.GetCurrentThreadId()));
            var active = DesktopName(input);
            if (!active.Equals("Default", StringComparison.OrdinalIgnoreCase) || !active.Equals(thread, StringComparison.OrdinalIgnoreCase))
                throw new TraceError("input_desktop_unavailable", "TRACE requires its ordinary interactive desktop; cleanup remains unverified.");
        }
        finally { Native.CloseDesktop(input); }
        var foreground = Native.GetForegroundWindow();
        if (foreground == 0) throw new TraceError("foreground_unavailable", "No foreground input window is available for verification.");
        if (Native.GetWindowThreadProcessId(foreground, out var pid) == 0 || pid == 0)
            throw new TraceError("foreground_changed", "The foreground input window changed during verification.", Marshal.GetLastWin32Error());
        var process = Native.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (process == 0)
        {
            var error = Marshal.GetLastWin32Error();
            var code = error == 5 ? "foreground_access_denied" : error is 87 or 1168 ? "foreground_exited" : "foreground_query_failed";
            throw new TraceError(code, "Foreground input access cannot be established; no release state is inferred.", error);
        }
        try
        {
            if (Integrity(process) > Integrity(Native.GetCurrentProcess()))
                throw new TraceError("foreground_elevated", "Elevated foreground input is unsupported; cleanup remains unverified.");
            if (Native.GetForegroundWindow() != foreground)
                throw new TraceError("foreground_changed", "The foreground input window changed during verification.");
        }
        finally { Native.CloseHandle(process); }
    }

    private static int Integrity(nint process)
    {
        if (!Native.OpenProcessToken(process, 0x0008, out var token))
            throw new TraceError("foreground_token_unavailable", "Foreground input privilege cannot be inspected.", Marshal.GetLastWin32Error());
        nint buffer = 0;
        try
        {
            Native.GetTokenInformation(token, 25 /* TokenIntegrityLevel */, 0, 0, out var needed);
            if (needed is < 1 or > 65536) throw new TraceError("input_state_unavailable", "Foreground input privilege cannot be inspected.");
            buffer = Marshal.AllocHGlobal(needed);
            if (!Native.GetTokenInformation(token, 25, buffer, needed, out _))
                throw new TraceError("foreground_token_unavailable", "Foreground input privilege cannot be inspected.", Marshal.GetLastWin32Error());
            var sid = Marshal.ReadIntPtr(buffer);
            var count = Marshal.ReadByte(Native.GetSidSubAuthorityCount(sid));
            if (count == 0) throw new TraceError("input_state_unavailable", "Foreground input privilege cannot be inspected.");
            return Marshal.ReadInt32(Native.GetSidSubAuthority(sid, (uint)count - 1));
        }
        finally { if (buffer != 0) Marshal.FreeHGlobal(buffer); Native.CloseHandle(token); }
    }

    public static object AccessDiagnostic()
    {
        var foreground = Native.GetForegroundWindow();
        Native.GetWindowThreadProcessId(foreground, out var pid);
        using var self = System.Diagnostics.Process.GetCurrentProcess();
        int? ownIntegrity = null, foregroundIntegrity = null;
        try { ownIntegrity = Integrity(Native.GetCurrentProcess()); } catch { }
        var handle = pid == 0 ? 0 : Native.OpenProcess(0x1000, false, pid);
        if (handle != 0)
        {
            try { foregroundIntegrity = Integrity(handle); } catch { }
            finally { Native.CloseHandle(handle); }
        }
        string? code = null;
        int? win32Error = null;
        try { EnsureObservable(); }
        catch (TraceError error) { code = error.Code; win32Error = error.Win32Error; }
        return new { observable = code is null, code, win32Error, foregroundPresent = foreground != 0,
            foregroundPid = pid, currentPid = Environment.ProcessId, currentSessionId = self.SessionId,
            requestedDesktopAccess = 0x0009, requestedProcessAccess = 0x1000, requestedTokenAccess = 0x0008,
            currentIntegrityRid = ownIntegrity, foregroundIntegrityRid = foregroundIntegrity,
            scope = "read-only access diagnostics; no key/button state inferred when inaccessible" };
    }

    // Generic modifier codes mirror their left/right keys; balancing releases the specific side.
    public static SortedSet<int> Expand(IEnumerable<int> keys)
    {
        var expanded = new SortedSet<int>();
        foreach (var vk in keys)
        {
            if (vk == Shift) { expanded.Add(0xA0); expanded.Add(0xA1); }
            else if (vk == Control) { expanded.Add(0xA2); expanded.Add(0xA3); }
            else if (vk == Menu) { expanded.Add(0xA4); expanded.Add(0xA5); }
            else expanded.Add(vk);
        }
        return expanded;
    }

    public static Native.Input Key(int vk, bool up)
    {
        var scan = Native.MapVirtualKey((uint)vk, 4 /* MAPVK_VK_TO_VSC_EX */);
        var flags = (up ? Native.KeyUp : 0) | ((scan & 0xFF00) == 0xE000 || Extended.Contains(vk) ? Native.KeyExtended : 0);
        return new Native.Input { Type = Native.InputKeyboard, Data = new Native.InputUnion { Keyboard = new Native.KeyboardInput { Vk = (ushort)vk, Scan = (ushort)(scan & 0xFF), Flags = flags } } };
    }

    public static Native.Input Mouse(uint flags) => new() { Type = Native.InputMouse, Data = new Native.InputUnion { Mouse = new Native.MouseInput { Flags = flags } } };

    public static void Send(params Native.Input[] inputs)
    {
        if (Native.SendInput((uint)inputs.Length, inputs, Native.InputSize) != inputs.Length)
            throw new TraceError("input_rejected", "Windows did not accept the input.");
    }

    private static Native.Input Up(int vk) => vk switch
    {
        0x01 => Mouse(Native.MouseLeftUp),
        0x02 => Mouse(Native.MouseRightUp),
        0x04 => Mouse(Native.MouseMiddleUp),
        _ => Key(vk, true),
    };

    // Sends an up event only for listed keys/buttons that are down, then re-reads global state.
    public static ReleaseResult Release(IEnumerable<int> candidates)
    {
        EnsureObservable();
        return ReleaseCore(candidates, IsDown, vk => Send(Up(vk)), _ => { Thread.Sleep(40); EnsureObservable(); });
    }

    // Injectable state/release primitives allow bounded recovery and failure tests with zero OS input.
    internal static ReleaseResult ReleaseCore(IEnumerable<int> candidates, Func<int, bool> isDown, Action<int> sendUp, Action<int> wait)
    {
        var targets = Expand(candidates);
        var attempted = new SortedSet<int>();
        for (var round = 0; round < 2; round++)
        {
            var down = targets.Where(isDown).ToList();
            if (down.Count == 0) break;
            foreach (var vk in down) { attempted.Add(vk); sendUp(vk); }
            wait(40);
        }
        var remaining = targets.Where(isDown).ToArray();
        return new ReleaseResult(attempted.ToArray(), remaining);
    }

    public static ReleaseResult ReleaseDeclared(IEnumerable<int> candidates, IEnumerable<int> unicode)
    {
        EnsureObservable();
        // Unicode packet downs have no distinct async VK state per UTF-16 unit. Balance each declared
        // unit after process exit, then independently inspect all declared keyboard/button state.
        foreach (var value in unicode.Distinct()) Send(new Native.Input { Type = Native.InputKeyboard,
            Data = new Native.InputUnion { Keyboard = new Native.KeyboardInput { Scan = (ushort)value, Flags = Native.KeyUnicode | Native.KeyUp } } });
        return Release(candidates);
    }
}

internal sealed record ReleaseResult(int[] Attempted, int[] RemainingDown)
{
    public bool Released => RemainingDown.Length == 0;
}

internal sealed class TraceError(string code, string message, int? win32Error = null) : Exception(message)
{
    public string Code { get; } = code;
    public int? Win32Error { get; } = win32Error;
}
