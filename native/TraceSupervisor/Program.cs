using System.Text.Json;

namespace TraceSupervisor;

// Source-owned native supervisor for TRACE Computer Use. Public Win32 APIs only; no network listener
// and no arbitrary executable launcher. Diagnostics carry codes, not screen contents or private paths.
internal static class Program
{
    public const int Version = 1;

    private static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new TraceError("unsupported_platform", "Windows is required.");
            Stdio.MakePrivate();
            switch (args.FirstOrDefault())
            {
                case "info" when args.Length == 1:
                    Json.Write(new { version = Version, lease = Lease.PipeName(), modes = new[] { "info", "identity", "input-access", "keystate", "display", "provider", "probe", "session", "status", "recover", "selftest" } });
                    return 0;
                case "keystate" when args.Length == 2:
                    InputState.EnsureObservable();
                    if (args[1] == "all") Json.Write(new { down = InputState.Down().ToArray() });
                    else Json.Write(new { keys = Keys.Parse(args[1]).ToDictionary(vk => vk.ToString(), InputState.IsDown) });
                    return 0;
                case "display" when args.Length == 1:
                    Json.Write(Display.Read());
                    return 0;
                case "input-access" when args.Length == 1:
                    Json.Write(InputState.AccessDiagnostic());
                    return 0;
                case "identity" when args.Length == 2 && int.TryParse(args[1], out var identityPid):
                    using (var process = System.Diagnostics.Process.GetProcessById(identityPid))
                    {
                        var identity = ProcessIdentity.Read(process);
                        Json.Write(new { pid = identity.Pid, processCreationTime = identity.Created.ToString(), user = identity.User, session = identity.Session });
                    }
                    return 0;
                case "provider": return ControlledProvider.Run(args[1..]);
                case "probe": return Probe.Run(args[1..]);
                case "session" when args.Length == 3 && int.TryParse(args[1], out var parent) && long.TryParse(args[2], out var created):
                    return SupervisorSession.Run(parent, created).GetAwaiter().GetResult();
                case "status" when args.Length == 1:
                    Json.Write(RecoveryStore.Check()); return 0;
                case "recover" when args.Length == 2 && args[1] is "--check" or "--apply":
                    try { Json.Write(args[1] == "--check" ? RecoveryStore.Check() : RecoveryStore.Recover()); return 0; }
                    catch (TraceError error)
                    {
                        Json.Write(new { recovered = false, recoveryRequired = true, ready = false, code = error.Code, win32Error = error.Win32Error });
                        return 1;
                    }
                case "selftest" when args.Length == 1:
                    Json.Write(SupervisorSelfTest.Run()); return 0;
                default: throw new TraceError("invalid_arguments", "Usage: TraceSupervisor info | keystate <all|vk,...> | display | provider ... | probe ...");
            }
        }
        catch (TraceError error)
        {
            Json.Error(error.Code, error.Message, error.Win32Error);
            return 1;
        }
        catch (Exception error)
        {
            Json.Error("supervisor_failed", error.GetType().Name);
            return 1;
        }
    }
}

internal static class Json
{
    private static readonly object Gate = new();
    public static void Write(object value)
    {
        lock (Gate)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(value));
            Console.Out.Flush();
        }
    }
    public static void Error(string code, string message, int? win32Error = null) => Console.Error.WriteLine(JsonSerializer.Serialize(new { error = new { code, message, win32Error } }));
}

internal static class Stdio
{
    // Children get their own redirected pipes; they must not inherit the protocol handles to Node.
    public static void MakePrivate()
    {
        foreach (var id in new[] { -10, -11, -12 })
        {
            var handle = Native.GetStdHandle(id);
            if (handle != 0 && handle != -1) Native.SetHandleInformation(handle, 1 /* HANDLE_FLAG_INHERIT */, 0);
        }
    }
}
