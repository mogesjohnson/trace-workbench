using System.Diagnostics;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace TraceSupervisor;

internal sealed record ProcessIdentity(int Pid, long Created, string User, int Session)
{
    public static ProcessIdentity Read(Process process)
    {
        if (!Native.OpenProcessToken(process.Handle, 0x0008 /* TOKEN_QUERY */, out var token))
            throw new TraceError("identity_unavailable", "Process ownership could not be established.");
        try
        {
            using var identity = new WindowsIdentity(token);
            return new(process.Id, process.StartTime.ToFileTimeUtc(), identity.User?.Value ?? "", process.SessionId);
        }
        finally { Native.CloseHandle(token); }
    }

    public static ProcessIdentity Self() { using var self = Process.GetCurrentProcess(); return Read(self); }

    // Hold the opened process handle while checking identity and terminating. Never kill by a reused PID.
    public Process? OpenExact()
    {
        Process process;
        try { process = Process.GetProcessById(Pid); }
        catch (ArgumentException) { return null; }
        try
        {
            if (process.HasExited) { process.Dispose(); return null; }
            if (Read(process) != this) throw new TraceError("process_identity_mismatch", "A recorded process identity no longer matches; no process was touched.");
            return process;
        }
        catch { process.Dispose(); throw; }
    }
}

internal sealed record RecoveryRecord(int Version, string SessionKey, ProcessIdentity Supervisor, ProcessIdentity? Child,
    int[] Keys, int[] Unicode, string Phase, string Reason);

internal static class RecoveryStore
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };
    internal static string DirectoryPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TRACE", "computer-recovery");
    private static string RecordPath => Path.Combine(DirectoryPath, "pending.json");

    public static RecoveryRecord? Read()
    {
        if (!File.Exists(RecordPath)) return null;
        try
        {
            if (new FileInfo(RecordPath).Length > 131072 || (File.GetAttributes(RecordPath) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException();
            var text = File.ReadAllText(RecordPath);
            using var document = JsonDocument.Parse(text);
            // Older probe-era records remain recoverable; new records protect the whole obligation
            // (including unordered Unicode release units) with current-user DPAPI, never plaintext.
            if (document.RootElement.TryGetProperty("ProtectedData", out var protectedData))
                text = System.Text.Encoding.UTF8.GetString(UserProtection.Unprotect(Convert.FromBase64String(protectedData.GetString()!)));
            var record = JsonSerializer.Deserialize<RecoveryRecord>(text, Options);
            if (record is null || record.Version != 1 || string.IsNullOrWhiteSpace(record.SessionKey)
                || record.Supervisor.User != ProcessIdentity.Self().User || record.Keys is null || record.Unicode is null
                || record.Keys.Any(key => key is < 1 or > 254 || key is 5 or 6)
                || record.Unicode.Any(value => value is < 0 or > 65535)) throw new InvalidDataException();
            return record;
        }
        catch (TraceError) { throw; }
        catch { throw new TraceError("recovery_record_invalid", "Recovery state is unreadable or invalid; input remains quarantined."); }
    }

    // Atomic replacement after flush-to-disk. The per-user desktop lease serializes every writer.
    public static void Write(RecoveryRecord record)
    {
        Directory.CreateDirectory(DirectoryPath);
        if ((File.GetAttributes(DirectoryPath) & FileAttributes.ReparsePoint) != 0)
            throw new TraceError("recovery_path_invalid", "Recovery storage must be an ordinary per-user directory.");
        var temporary = Path.Combine(DirectoryPath, $"pending-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                var ciphertext = UserProtection.Protect(JsonSerializer.SerializeToUtf8Bytes(record));
                JsonSerializer.Serialize(file, new { Version = 1, Protection = "dpapi-current-user", ProtectedData = Convert.ToBase64String(ciphertext) });
                file.Flush(flushToDisk: true);
            }
            File.Move(temporary, RecordPath, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static void Clear(string sessionKey)
    {
        var existing = Read();
        if (existing is not null && existing.SessionKey != sessionKey)
            throw new TraceError("recovery_record_changed", "Recovery ownership changed; quarantine was retained.");
        if (existing is not null) File.Delete(RecordPath);
    }

    public static object Check()
    {
        try
        {
            var record = Read();
            if (record is null) return new { recoveryRequired = false, ready = true, code = (string?)null };
            InputState.EnsureObservable();
            using var supervisor = record.Supervisor.OpenExact();
            using var child = record.Child?.OpenExact();
            return new { recoveryRequired = true, ready = false, code = "input_recovery_required", phase = record.Phase,
                supervisorAlive = supervisor is not null, childAlive = child is not null,
                sameSession = record.Supervisor.Session == ProcessIdentity.Self().Session,
                declaredKeysDown = InputState.Expand(record.Keys).Where(InputState.IsDown).ToArray() };
        }
        catch (TraceError error) { return new { recoveryRequired = true, ready = false, code = error.Code, win32Error = error.Win32Error }; }
    }

    public static object Recover()
    {
        var lease = Lease.TryAcquire(Lease.PipeName());
        if (lease == 0) throw new TraceError("desktop_busy", "Close the owning desktop session before applying recovery.");
        try
        {
            var record = Read();
            if (record is null) return new { recovered = true, recoveryRequired = false, alreadyClear = true };
            if (record.Supervisor.Session != ProcessIdentity.Self().Session)
                throw new TraceError("recovery_session_mismatch", "Recovery belongs to another Windows session; input remains quarantined.");
            using var supervisor = record.Supervisor.OpenExact();
            if (supervisor is not null) throw new TraceError("supervisor_alive", "The recorded supervisor still exists; close it before recovery.");
            using var child = record.Child?.OpenExact();
            if (child is not null)
            {
                if (!Native.TerminateProcess(child.Handle, 1) || !child.WaitForExit(3000))
                    throw new TraceError("process_exit_unconfirmed", "The exact owned input process did not confirm exit.");
            }
            var release = InputState.ReleaseDeclared(record.Keys, record.Unicode);
            if (!release.Released) throw new TraceError("input_recovery_failed", "Declared input remains down; quarantine was retained.");
            Clear(record.SessionKey);
            return new { recovered = true, recoveryRequired = false, processExitConfirmed = true,
                released = true, attempted = release.Attempted, remainingDown = release.RemainingDown };
        }
        finally { Native.CloseHandle(lease); }
    }
}

internal static class UserProtection
{
    public static byte[] Protect(byte[] value) => Convert(value, protect: true);
    public static byte[] Unprotect(byte[] value) => Convert(value, protect: false);
    private static byte[] Convert(byte[] value, bool protect)
    {
        var input = new Native.DataBlob { Length = value.Length, Data = Marshal.AllocHGlobal(value.Length) };
        Native.DataBlob output = default;
        try
        {
            Marshal.Copy(value, 0, input.Data, value.Length);
            var accepted = protect
                ? Native.CryptProtectData(ref input, "TRACE input recovery", 0, 0, 0, 1 /* CRYPTPROTECT_UI_FORBIDDEN */, out output)
                : Native.CryptUnprotectData(ref input, 0, 0, 0, 0, 1, out output);
            if (!accepted) throw new TraceError("recovery_protection_failed", "Per-user recovery protection is unavailable; quarantine remains in force.");
            var result = new byte[output.Length];
            Marshal.Copy(output.Data, result, 0, result.Length);
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(input.Data);
            if (output.Data != 0) Native.LocalFree(output.Data);
        }
    }
}
