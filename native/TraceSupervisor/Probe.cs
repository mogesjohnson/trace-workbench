using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace TraceSupervisor;

// A kill-on-close job that the current process joins, so every child it starts is owned from creation.
internal sealed class OwnedJob : IDisposable
{
    private OwnedJob(nint handle) { Handle = handle; }
    public nint Handle { get; private set; }

    public static OwnedJob CreateAndJoin()
    {
        var job = Native.CreateJobObject(0, null);
        if (job == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new Native.JobExtendedLimits { Basic = new Native.JobBasicLimits { LimitFlags = Native.JobKillOnClose | Native.JobDieOnUnhandledException } };
        if (!Native.SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ref limits, Marshal.SizeOf<Native.JobExtendedLimits>()))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!Native.AssignProcessToJobObject(job, Native.GetCurrentProcess()))
            throw new TraceError("job_assignment_failed", $"The supervisor could not join its job (Win32 {Marshal.GetLastWin32Error()}).");
        var owned = new OwnedJob(job);
        if (!owned.Contains(Native.GetCurrentProcess())) throw new TraceError("job_assignment_failed", "The supervisor is not in its job.");
        return owned;
    }

    public bool Contains(nint process) => Native.IsProcessInJob(process, Handle, out var inside) && inside;

    // A child must not escape ownership: a suspended breakaway launch has to be refused.
    public bool BreakawayDenied(string executable)
    {
        var startup = new Native.StartupInfo { Size = Marshal.SizeOf<Native.StartupInfo>() };
        var command = new StringBuilder($"\"{executable}\" info");
        if (Native.CreateProcess(executable, command, 0, 0, false, Native.CreateBreakawayFromJob | Native.CreateSuspended | Native.CreateNoWindow, 0, null, ref startup, out var created))
        {
            Native.TerminateProcess(created.Process, 1);
            Native.CloseHandle(created.Thread);
            Native.CloseHandle(created.Process);
            return false;
        }
        return Marshal.GetLastWin32Error() == Native.ErrorAccessDenied;
    }

    public void Dispose()
    {
        if (Handle == 0) return;
        Native.CloseHandle(Handle);
        Handle = 0;
    }
}

// The desktop lease is an exclusive first-instance named pipe. Its name matches the Node DesktopLease.
internal static class Lease
{
    public static string PipeName()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var key = Path.GetFullPath(Path.Combine(profile, ".trace-desktop-lease")).ToLowerInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant()[..32];
        return $@"\\.\pipe\trace-computer-{hash}";
    }

    // Returns 0 when another process already owns the name. Unlimited instances match libuv, so an
    // older Node lease meeting this pipe reports desktop_busy rather than an unavailable lease.
    public static nint TryAcquire(string name)
    {
        var handle = Native.CreateNamedPipe(name, Native.PipeAccessDuplex | Native.FileFlagFirstPipeInstance, Native.PipeRejectRemoteClients, 255 /* PIPE_UNLIMITED_INSTANCES */, 0, 0, 0, 0);
        if (handle != -1) return handle;
        var error = Marshal.GetLastWin32Error();
        if (error is Native.ErrorAccessDenied or Native.ErrorPipeBusy) return 0;
        throw new TraceError("lease_unavailable", $"Desktop ownership is unavailable (Win32 {error}).");
    }
}

// Low-level keyboard hook on its own message-loop thread. The callback only timestamps and signals.
internal sealed class EscapeHook : IDisposable
{
    private readonly Native.LowLevelProc callback;
    private readonly Thread thread;
    private readonly ManualResetEventSlim ready = new();
    private nint hook;
    private uint threadId;
    private bool consumingDown;

    public EscapeHook(Action<EscapeEvent> onEscape)
    {
        OnEscape = onEscape;
        callback = Callback;
        thread = new Thread(Loop) { IsBackground = true, Name = "trace-escape-hook" };
    }

    private Action<EscapeEvent> OnEscape { get; }
    public volatile bool ConsumePhysical;

    public void Start()
    {
        thread.Start();
        if (!ready.Wait(5000) || hook == 0) throw new TraceError("stop_hook_unavailable", "The physical stop key hook could not be installed.");
    }

    private void Loop()
    {
        Native.PeekMessage(out _, 0, 0, 0, 0);
        threadId = Native.GetCurrentThreadId();
        hook = Native.SetWindowsHookEx(Native.WhKeyboardLowLevel, callback, Native.GetModuleHandle(null), 0);
        ready.Set();
        if (hook == 0) return;
        while (Native.GetMessage(out _, 0, 0, 0) > 0) { }
        Native.UnhookWindowsHookEx(hook);
    }

    private nint Callback(int code, nint wParam, nint lParam)
    {
        if (code >= 0)
        {
            var info = Marshal.PtrToStructure<Native.LowLevelKeyboard>(lParam);
            if (info.Vk == 0x1B)
            {
                var injected = (info.Flags & Native.LowLevelInjected) != 0;
                var down = wParam is Native.WmKeyDown or Native.WmSysKeyDown;
                OnEscape(new EscapeEvent(down, injected, Stopwatch.GetTimestamp()));
                // A consumed physical stop key never reaches the target, even combined with held modifiers.
                if (!injected && ConsumePhysical && (down || consumingDown)) { consumingDown = down; return 1; }
            }
        }
        return Native.CallNextHookEx(hook, code, wParam, lParam);
    }

    public void Dispose()
    {
        if (threadId != 0) Native.PostThreadMessage(threadId, Native.WmQuit, 0, 0);
        thread.Join(2000);
    }
}

internal readonly record struct EscapeEvent(bool Down, bool Injected, long Timestamp);

internal static class Display
{
    public static object Read()
    {
        var previous = Native.SetThreadDpiAwarenessContext(-4); // PER_MONITOR_AWARE_V2
        var monitors = new List<object>();
        try
        {
            Native.EnumDisplayMonitors(0, 0, (nint monitor, nint dc, ref Native.Rect rect, nint data) =>
            {
                var info = new Native.MonitorInfoEx { Size = Marshal.SizeOf<Native.MonitorInfoEx>(), Device = "" };
                Native.GetMonitorInfo(monitor, ref info);
                Native.GetDpiForMonitor(monitor, 0 /* MDT_EFFECTIVE_DPI */, out var dpi, out _);
                monitors.Add(new { device = info.Device, primary = (info.Flags & 1) != 0, dpi, bounds = new { x = info.Monitor.Left, y = info.Monitor.Top, width = info.Monitor.Right - info.Monitor.Left, height = info.Monitor.Bottom - info.Monitor.Top } });
                return true;
            }, 0);
        }
        finally { if (previous != 0) Native.SetThreadDpiAwarenessContext(previous); }
        return new { monitors = monitors.Count, displays = monitors };
    }
}

// Test-only, source-owned input provider. It starts the declared input and then holds it until killed,
// giving deterministic held-input failures on the production MCP/controller/supervisor path.
internal static class ControlledProvider
{
    public static int Run(string[] args)
    {
        if (args.Length < 2) throw new TraceError("invalid_arguments", "Usage: provider hold-mouse <x> <y> | hold-keys <vk,...> | type-hold <text>");
        Native.SetThreadDpiAwarenessContext(-4);
        var held = new SortedSet<int>();
        switch (args[0])
        {
            case "hold-mouse" when args.Length == 3 && int.TryParse(args[1], out var x) && int.TryParse(args[2], out var y):
                if (!Native.SetCursorPos(x, y)) throw new TraceError("cursor_rejected", "Windows refused the cursor position.");
                InputState.Send(InputState.Mouse(Native.MouseLeftDown));
                held.Add(0x01);
                break;
            case "hold-keys" when args.Length == 2:
                foreach (var vk in Keys.Parse(args[1])) { InputState.Send(InputState.Key(vk, false)); held.Add(vk); }
                break;
            case "type-hold" when args.Length == 2 && args[1].Length is > 0 and <= 64:
                var text = args[1];
                foreach (var character in text[..^1]) Keys.Type(character, hold: false);
                foreach (var vk in Keys.Type(text[^1], hold: true)) held.Add(vk);
                break;
            default:
                throw new TraceError("invalid_arguments", "Unknown controlled provider mode.");
        }
        Json.Write(new { provider = "controlled-test", mode = args[0], held = held.ToArray(), pid = Environment.ProcessId });
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}

internal static class Keys
{
    public static int[] Parse(string list) => list.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(item =>
    {
        var text = item.Trim();
        var value = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? Convert.ToInt32(text[2..], 16) : int.Parse(text);
        if (value is < 1 or > 254) throw new TraceError("invalid_arguments", "Virtual-key codes are 1..254.");
        return value;
    }).ToArray();

    // Types one character with virtual keys; a held character leaves its key (and Shift) down.
    public static int[] Type(char character, bool hold)
    {
        var mapped = Native.VkKeyScan(character);
        if (mapped == -1) throw new TraceError("invalid_arguments", "The controlled provider types characters available on the current layout.");
        var vk = mapped & 0xFF;
        var shift = (mapped & 0x100) != 0;
        if ((mapped & 0x600) != 0) throw new TraceError("invalid_arguments", "Ctrl/Alt layout characters are not used by the controlled provider.");
        var down = new List<int>();
        if (shift) { InputState.Send(InputState.Key(0xA0, false)); down.Add(0xA0); }
        InputState.Send(InputState.Key(vk, false));
        down.Add(vk);
        if (hold) return down.ToArray();
        InputState.Send(InputState.Key(vk, true));
        if (shift) InputState.Send(InputState.Key(0xA0, true));
        return [];
    }
}

internal static class Probe
{
    public static int Run(string[] args)
    {
        switch (args.FirstOrDefault())
        {
            case "job-host" when args.Length >= 2: return JobHost(args[1..]);
            case "pipe-hold" when args.Length == 1: return PipeHold();
            case "parent-watch" when args.Length == 3 && int.TryParse(args[1], out var parent) && Path.IsPathFullyQualified(args[2]): return ParentWatch(parent, args[2]);
            case "escape-listen" when args.Length is 2 or 3 && int.TryParse(args[1], out var seconds) && seconds is > 0 and <= 300:
                return EscapeListen(seconds, args.Length == 3 && args[2] == "inject");
            case "release" when args.Length == 2:
                var result = InputState.Release(Keys.Parse(args[1]));
                Json.Write(new { attempted = result.Attempted, remainingDown = result.RemainingDown, released = result.Released });
                return result.Released ? 0 : 2;
            default: throw new TraceError("invalid_arguments", "Usage: probe job-host <child args> | pipe-hold | parent-watch <pid> | escape-listen <seconds> [inject] | release <vk,...>");
        }
    }

    // Joins a kill-on-close job, proves breakaway is refused, then starts one child inside the job.
    private static int JobHost(string[] childArgs)
    {
        using var job = OwnedJob.CreateAndJoin();
        var self = Environment.ProcessPath ?? throw new TraceError("self_unknown", "Supervisor path is unavailable.");
        var breakawayDenied = job.BreakawayDenied(self);
        var start = new ProcessStartInfo(self) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        foreach (var argument in childArgs) start.ArgumentList.Add(argument);
        using var child = Process.Start(start) ?? throw new TraceError("child_start_failed", "The probe child did not start.");
        var report = child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
        Json.Write(new { jobAssigned = true, breakawayDenied, child = new { pid = child.Id, created = child.StartTime.ToFileTimeUtc().ToString(), inJob = job.Contains(child.Handle), report } });
        // Holding here until EOF keeps the job open; termination of this host closes it.
        Console.In.ReadToEnd();
        return 0;
    }

    private static int PipeHold()
    {
        var name = Lease.PipeName();
        var handle = Lease.TryAcquire(name);
        Json.Write(new { lease = handle == 0 ? "busy" : "held", pipe = name });
        if (handle == 0) return 3;
        Console.In.ReadToEnd();
        Native.CloseHandle(handle);
        return 0;
    }

    // Records when parent exit and stdin EOF are each observed. The result goes to a file because the
    // parent's stdout pipe dies with it.
    private static int ParentWatch(int parentPid, string output)
    {
        using var parent = Process.GetProcessById(parentPid);
        static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var exit = Task.Run(() => { parent.WaitForExit(); return Now(); });
        var eof = Task.Run(() => { Console.In.ReadToEnd(); return Now(); });
        Json.Write(new { watching = parentPid });
        Task.WaitAll([exit, eof], TimeSpan.FromSeconds(60));
        var result = new { parentExitAt = exit.IsCompleted ? exit.Result : -1, stdinEofAt = eof.IsCompleted ? eof.Result : -1 };
        File.WriteAllText(output, System.Text.Json.JsonSerializer.Serialize(result));
        return 0;
    }

    // Observes injected vs physical Escape events; a physical keydown is consumed and reported.
    private static int EscapeListen(int seconds, bool inject)
    {
        var events = new List<object>();
        var physical = new ManualResetEventSlim();
        long physicalAt = 0;
        var clock = Stopwatch.StartNew();
        using var hook = new EscapeHook(escape =>
        {
            lock (events) events.Add(new { escape.Down, escape.Injected, ms = clock.ElapsedMilliseconds });
            if (escape.Down && !escape.Injected && physicalAt == 0) { physicalAt = escape.Timestamp; physical.Set(); }
        }) { ConsumePhysical = true };
        hook.Start();
        if (inject)
        {
            InputState.Send(InputState.Key(0x1B, false), InputState.Key(0x1B, true));
            Thread.Sleep(300);
        }
        Json.Write(new { listening = true, seconds });
        var seen = physical.Wait(TimeSpan.FromSeconds(seconds));
        var handledMs = seen ? Stopwatch.GetElapsedTime(physicalAt).TotalMilliseconds : -1;
        lock (events) Json.Write(new { physicalEscape = seen, handledAfterMs = handledMs, events });
        return seen ? 0 : 4;
    }
}
