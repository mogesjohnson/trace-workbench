using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace TraceSupervisor;

internal sealed record ProviderSpec(string Path, string Sha256)
{
    public void Verify()
    {
        if (!System.IO.Path.IsPathFullyQualified(Path) || !File.Exists(Path)
            || (File.GetAttributes(Path) & FileAttributes.ReparsePoint) != 0
            || Sha256.Length != 64 || !Sha256.All(Uri.IsHexDigit))
            throw new TraceError("provider_invalid", "A provider needs an absolute ordinary executable path and SHA-256 identity.");
        using var file = File.OpenRead(Path);
        if (!Convert.ToHexString(SHA256.HashData(file)).Equals(Sha256, StringComparison.OrdinalIgnoreCase))
            throw new TraceError("provider_integrity", "Configured provider content changed.");
    }
}

internal sealed record InputDeclaration(int[] Keys, int[] Unicode)
{
    public static InputDeclaration For(string provider, string[] args, int[] extra, bool mutating)
    {
        if (extra.Length > 254 || extra.Any(key => key is < 1 or > 254 || key is 5 or 6))
            throw new TraceError("invalid_arguments", "Declared virtual keys must be supported codes from 1 through 254.");
        var keys = new SortedSet<int>(extra);
        var unicode = new SortedSet<int>();
        if (provider == "winapp")
        {
            if (args.Length < 3 || args[0] != "ui" || args[2] != "--json") throw new TraceError("invalid_arguments", "Only the pinned engine UI protocol is supported.");
            var verb = args[1];
            var read = new[] { "list-windows", "status", "inspect", "get-focused", "screenshot" }.Contains(verb);
            var write = new[] { "click", "drag", "send-keys", "scroll", "invoke", "set-value" }.Contains(verb);
            if ((!read && !write) || write != mutating) throw new TraceError("invalid_arguments", "Provider verb and mutation declaration disagree.");
            if (verb is "click" or "drag") keys.Add(1);
            if (verb == "send-keys")
            {
                // The engine may synthesize layout keys or Unicode packets. A conservative declaration
                // blocks pre-existing keyboard activity and balances any interrupted declared keyboard.
                foreach (var key in Enumerable.Range(8, 247)) keys.Add(key);
                if (args.Contains("--verbatim")) foreach (var c in args.LastOrDefault() ?? "") unicode.Add(c);
            }
        }
        else if (provider == "bridge")
        {
            if (args.Length == 0 || !new[] { "info", "identity", "identities", "bounds", "activate" }.Contains(args[0])
                || mutating != (args[0] == "activate")) throw new TraceError("invalid_arguments", "Only source-owned bridge observation/activation is supported.");
        }
        else if (provider == "controlled")
        {
            if (!mutating || args.Length < 2 || args[0] != "provider") throw new TraceError("invalid_arguments", "Controlled input must be declared as mutating.");
            switch (args[1])
            {
                case "hold-mouse" when args.Length == 4: keys.Add(1); break;
                case "hold-keys" when args.Length == 3: keys.UnionWith(TraceSupervisor.Keys.Parse(args[2])); break;
                case "type-hold" when args.Length == 3:
                    foreach (var key in Enumerable.Range(8, 247)) keys.Add(key);
                    foreach (var c in args[2]) unicode.Add(c);
                    break;
                default: throw new TraceError("invalid_arguments", "Unknown controlled input mode.");
            }
        }
        else throw new TraceError("provider_invalid", "Only explicitly configured TRACE providers are supported.");
        return new(InputState.Expand(keys).ToArray(), unicode.ToArray());
    }
}

// The supervisor remains outside this kill-on-close job. A child is suspended, assigned, durably
// identified, and only then resumed. No mutating instruction can race ahead of job ownership.
internal sealed class OperationProcess : IDisposable
{
    public nint Job { get; private set; }
    public nint Handle { get; private set; }
    private nint thread;
    public ProcessIdentity Identity { get; private set; } = null!;
    private StreamReader? output, errors;
    public Task<string> Output { get; private set; } = Task.FromResult("");
    public Task<string> Errors { get; private set; } = Task.FromResult("");
    public bool Started { get; private set; }
    public bool Exited => Handle != 0 && Native.WaitForSingleObject(Handle, 0) == 0;

    public static string Quote(string value)
    {
        if (value.Length > 0 && !value.Any(c => char.IsWhiteSpace(c) || c == '"')) return value;
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static OperationProcess Create(ProviderSpec provider, string[] args)
    {
        provider.Verify();
        var owned = new OperationProcess();
        nint outRead = 0, outWrite = 0, errRead = 0, errWrite = 0, inRead = 0, inWrite = 0;
        try
        {
            owned.Job = Native.CreateJobObject(0, null);
            if (owned.Job == 0) throw new TraceError("job_unavailable", "The operation job could not be created.");
            var limits = new Native.JobExtendedLimits { Basic = new Native.JobBasicLimits { LimitFlags = Native.JobKillOnClose | Native.JobDieOnUnhandledException } };
            if (!Native.SetInformationJobObject(owned.Job, 9, ref limits, Marshal.SizeOf<Native.JobExtendedLimits>()))
                throw new TraceError("job_unavailable", "The operation job could not be configured.");
            var attributes = new Native.SecurityAttributes { Length = Marshal.SizeOf<Native.SecurityAttributes>(), Inherit = true };
            if (!Native.CreatePipe(out outRead, out outWrite, ref attributes, 0)
                || !Native.CreatePipe(out errRead, out errWrite, ref attributes, 0)
                || !Native.CreatePipe(out inRead, out inWrite, ref attributes, 0))
                throw new TraceError("pipe_unavailable", "Private operation pipes could not be created.");
            foreach (var handle in new[] { outRead, errRead, inWrite })
                if (!Native.SetHandleInformation(handle, 1, 0)) throw new TraceError("pipe_unavailable", "Private operation handles could not be protected.");
            var startup = new Native.StartupInfo { Size = Marshal.SizeOf<Native.StartupInfo>(), Flags = 0x100 /* STARTF_USESTDHANDLES */,
                StdInput = inRead, StdOutput = outWrite, StdError = errWrite };
            var command = new StringBuilder(string.Join(" ", new[] { provider.Path }.Concat(args).Select(Quote)));
            if (!Native.CreateProcess(provider.Path, command, 0, 0, true, Native.CreateSuspended | Native.CreateNoWindow, 0,
                Path.GetDirectoryName(provider.Path), ref startup, out var created)) throw new TraceError("child_start_failed", "The configured operation provider could not start.");
            owned.Handle = created.Process; owned.thread = created.Thread;
            if (!Native.AssignProcessToJobObject(owned.Job, owned.Handle)) throw new TraceError("job_assignment_failed", "The suspended input process could not enter its operation job.");
            using (var process = Process.GetProcessById((int)created.ProcessId)) owned.Identity = ProcessIdentity.Read(process);
            owned.output = new StreamReader(new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read, 4096, false), Encoding.UTF8); outRead = 0;
            owned.errors = new StreamReader(new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read, 4096, false), Encoding.UTF8); errRead = 0;
            return owned;
        }
        catch { owned.Dispose(); throw; }
        finally { foreach (var handle in new[] { outRead, outWrite, errRead, errWrite, inRead, inWrite }) if (handle != 0) Native.CloseHandle(handle); }
    }

    private static async Task<string> ReadBounded(StreamReader reader)
    {
        var text = new StringBuilder(); var buffer = new char[4096];
        while (true)
        {
            var count = await reader.ReadAsync(buffer);
            if (count == 0) return text.ToString();
            if (text.Length + count > 4 * 1024 * 1024) throw new TraceError("output_limit", "Operation output exceeded its bound.");
            text.Append(buffer, 0, count);
        }
    }

    public void Resume()
    {
        Output = ReadBounded(output!); Errors = ReadBounded(errors!);
        if (Native.ResumeThread(thread) == uint.MaxValue) throw new TraceError("child_resume_failed", "The owned operation could not resume.");
        Started = true;
        Native.CloseHandle(thread); thread = 0;
    }

    public bool Drained()
    {
        return Exited && Native.QueryInformationJobObject(Job, 1 /* JobObjectBasicAccountingInformation */, out var info,
            Marshal.SizeOf<Native.JobAccounting>(), out _) && info.ActiveProcesses == 0;
    }
    public bool KillAndConfirm(int milliseconds = 3000)
    {
        Native.TerminateJobObject(Job, 1);
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < milliseconds) { if (Drained()) return true; Thread.Sleep(10); }
        return Drained();
    }
    public int ExitCode()
    {
        if (!Native.GetExitCodeProcess(Handle, out var code) || code == 259) throw new TraceError("process_exit_unconfirmed", "Operation exit could not be confirmed.");
        return unchecked((int)code);
    }
    public void Dispose()
    {
        if (Handle != 0 && !Exited) Native.TerminateProcess(Handle, 1);
        if (Job != 0) Native.CloseHandle(Job);
        if (thread != 0) Native.CloseHandle(thread);
        if (Handle != 0) Native.CloseHandle(Handle);
        output?.Dispose(); errors?.Dispose();
        Handle = Job = thread = 0;
    }
}
