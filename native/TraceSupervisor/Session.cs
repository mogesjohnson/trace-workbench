using System.Diagnostics;
using System.Text.Json;

namespace TraceSupervisor;

// Private inherited-stdio protocol. Only the connecting owner configures verified fixed provider
// identities; per-operation messages select a provider, never an arbitrary executable or shell.
internal sealed class SupervisorSession : IDisposable
{
    private readonly Process parent;
    private readonly ProcessIdentity identity = ProcessIdentity.Self();
    private readonly string sessionKey = Guid.NewGuid().ToString("N");
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, ProviderSpec> providers = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly AsyncCleanup cleanup = new();
    private nint lease;
    private bool configured, closing, allowControlled;
    private string? stopCode;
    private EscapeHook? escape;
    private Process? indicator;
    private Task? operation;
    private bool operationBusy;
    private CancellationTokenSource? operationCancellation;
    private string? operationId;
    private RecoveryFaultSpec? recoveryFault;
    private bool recoveryFaultConsumed;
    private TaskCompletionSource<bool>? recoveryProof;
    private string? recoveryProofOperation;
    private int monitors;
    private long dispatchCount;
    private long physicalStopAtTicks;

    private SupervisorSession(Process parent) { this.parent = parent; }

    public static async Task<int> Run(int parentPid, long created)
    {
        using var parent = Process.GetProcessById(parentPid);
        var actual = ProcessIdentity.Read(parent);
        var self = ProcessIdentity.Self();
        if (actual.Created != created || actual.User != self.User || actual.Session != self.Session)
            throw new TraceError("parent_identity_mismatch", "The connecting process identity does not match the supervisor owner.");
        using var session = new SupervisorSession(parent);
        Json.Write(new { @event = "hello", version = 1, pid = Environment.ProcessId });
        var reader = session.ReadLoop();
        var exited = parent.WaitForExitAsync();
        var ended = await Task.WhenAny(reader, exited);
        if (ended == exited) session.Stop("parent_exited");
        await session.Close();
        return 0;
    }

    private void Stop(string code, long? physicalTimestamp = null)
    {
        if (Interlocked.CompareExchange(ref stopCode, code, null) is not null) return;
        if (code == "physical_escape" && physicalTimestamp.HasValue) Interlocked.Exchange(ref physicalStopAtTicks, physicalTimestamp.Value);
        // The hook's callback only updates state and signals cancellation. Protocol writes run elsewhere.
        lifetime.Cancel();
        try { operationCancellation?.Cancel(); } catch (ObjectDisposedException) { }
        _ = Task.Run(() =>
        {
            try
            {
                long count;
                double? latency;
                // Synchronize behind a dispatch already entering Resume. The callback itself never
                // waits on this gate. After this snapshot no queued dispatch can pass its final check.
                lock (gate)
                {
                    count = dispatchCount;
                    latency = physicalTimestamp.HasValue ? Math.Round(Stopwatch.GetElapsedTime(physicalTimestamp.Value).TotalMilliseconds, 3) : null;
                }
                Json.Write(new { @event = "stopped", code, physical = code == "physical_escape" && physicalTimestamp.HasValue,
                    stopLatencyMs = latency, dispatchCount = count });
            }
            catch { }
        });
    }

    private static string Text(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(value.GetString())
            ? value.GetString()! : throw new TraceError("invalid_request", $"Missing protocol field {name}.");

    private static string RequestId(JsonElement root)
    {
        var id = Text(root, "id");
        if (id.Length > 128 || id.Any(char.IsControl)) throw new TraceError("invalid_request", "Invalid protocol request identity.");
        return id;
    }
    private static void Reply(string id, object result) => Json.Write(new { id, result });
    private static object ErrorEnvelope(string id, string code, string message, object? recovery = null, string outcome = "not_dispatched", int? win32Error = null)
        => new { id, error = new { code, message, outcome, recovery, win32Error } };
    private static void Reject(string id, string code, string message, object? recovery = null, string outcome = "not_dispatched", int? win32Error = null)
        => Json.Write(ErrorEnvelope(id, code, message, recovery, outcome, win32Error));

    private async Task ReadLoop()
    {
        try
        {
            while (!closing)
            {
                var line = await Console.In.ReadLineAsync();
                if (line is null) { Stop("stdin_eof"); return; }
                string id = "invalid";
                try
                {
                    if (line.Length > 1024 * 1024) throw new TraceError("request_limit", "The private request exceeds its size limit.");
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    id = RequestId(root);
                    switch (Text(root, "method"))
                    {
                        case "configure": await Configure(id, root); break;
                        case "run": StartOperation(id, root); break;
                        case "cancel":
                            var target = Text(root, "targetId");
                            lock (gate) { if (target == operationId) operationCancellation?.Cancel(); }
                            Reply(id, new { cancelled = target == operationId });
                            break;
                        case "test_cleanup_ack":
                            lock (gate)
                            {
                                if (!allowControlled || recoveryFault is null || recoveryProof is null
                                    || !RecoveryFaultSpec.Accept(recoveryProofOperation, Text(root, "targetId"), recoveryFault.Token, Text(root, "token"),
                                        root.TryGetProperty("independentReleaseVerified", out var proof) && proof.ValueKind == JsonValueKind.True))
                                    throw new TraceError("invalid_test_ack", "No matching private release-verification checkpoint is pending.");
                                recoveryProof.TrySetResult(true);
                            }
                            Reply(id, new { accepted = true, scope = "private-controlled-test" });
                            break;
                        case "close":
                            await Close();
                            Reply(id, new { closed = true, cleanup = RecoveryStore.Read() is null ? "confirmed" : "unknown" });
                            return;
                        default: throw new TraceError("invalid_request", "Unknown private supervisor operation.");
                    }
                }
                catch (TraceError error) { Reject(id, error.Code, error.Message, win32Error: error.Win32Error); }
                catch { Reject(id, "invalid_request", "The private supervisor request could not be processed."); }
            }
        }
        catch { Stop("stdin_failed"); }
    }

    private async Task Configure(string id, JsonElement root)
    {
        if (configured || lease != 0) throw new TraceError("already_configured", "A supervisor session is configured once.");
        if (stopCode is not null) throw new TraceError("session_stopped", "The native session is stopped.");
        if (!root.TryGetProperty("providers", out var entries) || entries.ValueKind != JsonValueKind.Object)
            throw new TraceError("provider_invalid", "Verified provider identities are required.");
        foreach (var name in new[] { "winapp", "bridge", "indicator" })
        {
            if (!entries.TryGetProperty(name, out var spec)) throw new TraceError("provider_invalid", "The fixed provider set is incomplete.");
            var provider = new ProviderSpec(Text(spec, "path"), Text(spec, "sha256"));
            var expected = name switch { "winapp" => "winapp.exe", "bridge" => "TraceWindowBridge.exe", _ => "TraceActivityIndicator.exe" };
            if (!Path.GetFileName(provider.Path).Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new TraceError("provider_invalid", "Only the pinned engine and source-owned helpers may be configured.");
            provider.Verify();
            providers[name] = provider;
        }
        allowControlled = root.TryGetProperty("allowControlled", out var controlled) && controlled.ValueKind == JsonValueKind.True;
        recoveryFault = RecoveryFaultSpec.Parse(root, allowControlled);
        if (allowControlled)
        {
            var path = Environment.ProcessPath ?? throw new TraceError("self_unknown", "The controlled provider path is unavailable.");
            providers["controlled"] = new ProviderSpec(path, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path))));
        }
        lease = Lease.TryAcquire(Lease.PipeName());
        if (lease == 0) throw new TraceError("desktop_busy", "Another TRACE controller owns the desktop.");
        if (RecoveryStore.Read() is not null) throw new TraceError("input_recovery_required", "Durable recovery state blocks this session; inspect recovery before continuing.");
        InputState.EnsureObservable();
        escape = new EscapeHook(value => { if (value.Down && !value.Injected) Stop("physical_escape", value.Timestamp); }) { ConsumePhysical = true };
        escape.Start();
        try
        {
            await StartIndicator();
            if (stopCode is not null) throw new TraceError("session_stopped", "The session stopped before readiness.");
            configured = true;
            Reply(id, new { ready = true, version = 1, pid = Environment.ProcessId, monitors, physicalStop = "installed", lease = "native-owned" });
        }
        catch { Stop("startup_failed"); await Close(); throw; }
    }

    private async Task StartIndicator()
    {
        providers["indicator"].Verify();
        var start = new ProcessStartInfo(providers["indicator"].Path) { UseShellExecute = false,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = false };
        start.ArgumentList.Add("--parent-pid"); start.ArgumentList.Add(Environment.ProcessId.ToString());
        indicator = Process.Start(start) ?? throw new TraceError("indicator_spawn_failed", "The activity marker could not start.");
        _ = indicator.StandardError.ReadToEndAsync();
        var line = await indicator.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5), lifetime.Token);
        if (line is null || line.Length > 8192) throw new TraceError("indicator_protocol", "The activity marker returned invalid readiness.");
        using var document = JsonDocument.Parse(line);
        var value = document.RootElement;
        if (value.GetProperty("version").GetInt32() != 1 || value.GetProperty("ready").ValueKind != JsonValueKind.True
            || value.GetProperty("pid").GetInt32() != indicator.Id || (monitors = value.GetProperty("monitors").GetInt32()) is < 1 or > 64)
            throw new TraceError("indicator_protocol", "The activity marker returned invalid readiness.");
        _ = Task.Run(async () => { try { await indicator.WaitForExitAsync(); if (!closing) Stop("indicator_exited"); } catch { if (!closing) Stop("indicator_exited"); } });
    }

    private void StartOperation(string id, JsonElement root)
    {
        if (!configured || stopCode is not null || closing) throw new TraceError("session_stopped", "A ready unstopped native session is required.");
        var provider = Text(root, "provider");
        if (!providers.ContainsKey(provider) || provider == "indicator" || (provider == "controlled" && !allowControlled))
            throw new TraceError("provider_invalid", "This operation provider is not configured.");
        if (!root.TryGetProperty("args", out var arguments) || arguments.ValueKind != JsonValueKind.Array || arguments.GetArrayLength() > 128)
            throw new TraceError("invalid_arguments", "A bounded argument array is required.");
        var args = arguments.EnumerateArray().Select(value => value.ValueKind == JsonValueKind.String && value.GetString() is { } text
            && text.Length <= 32768 && !text.Contains('\0') ? text : throw new TraceError("invalid_arguments", "Provider arguments must be bounded strings without NUL.")).ToArray();
        var mutating = root.TryGetProperty("mutating", out var mutation) && mutation.ValueKind == JsonValueKind.True;
        var extra = root.TryGetProperty("declaredKeys", out var declaration) ? declaration.EnumerateArray().Select(value => value.GetInt32()).ToArray() : [];
        var input = InputDeclaration.For(provider, args, extra, mutating);
        var timeout = root.TryGetProperty("timeoutMs", out var limit) ? limit.GetInt32() : 15000;
        if (timeout is < 1 or > 15000) throw new TraceError("invalid_arguments", "The native operation deadline is 1 through 15000 milliseconds.");
        lock (gate)
        {
            if (operationBusy) throw new TraceError("operation_busy", "Only one native operation may be active.");
            if (RecoveryStore.Read() is not null) throw new TraceError("input_recovery_required", "Durable recovery state blocks dispatch.");
            operationCancellation?.Dispose();
            operationCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            operationId = id;
            operationBusy = true;
            var token = operationCancellation.Token;
            operation = Task.Run(async () =>
            {
                // RunOperation disposes every native handle before returning its envelope. Reopen the
                // dispatch gate before publishing completion, so the next request needs no timing gap.
                var envelope = await RunOperation(id, provider, args, input, mutating, timeout, token);
                lock (gate) { operationBusy = false; if (operationId == id) operationId = null; }
                try { Json.Write(envelope); } catch { Stop("stdout_failed"); }
            });
        }
    }

    private async Task<object> RunOperation(string id, string provider, string[] args, InputDeclaration input, bool mutating, int timeout, CancellationToken cancellation)
    {
        OperationProcess? child = null;
        RecoveryRecord? record = null;
        var started = false;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            if (mutating)
            {
                InputState.EnsureObservable();
                if (input.Keys.Any(InputState.IsDown)) throw new TraceError("input_busy", "Declared input was already held before dispatch; no input was sent.");
                record = new(1, sessionKey, identity, null, input.Keys, input.Unicode, "intent", "operation_pending");
                RecoveryStore.Write(record);
            }
            child = OperationProcess.Create(providers[provider], args);
            if (record is not null) RecoveryStore.Write(record = record with { Child = child.Identity, Phase = "owned_suspended" });
            DispatchGuard.Enter(gate, cancellation, () => stopCode is not null || closing, () =>
            {
                // This final native admission check closes the observation/dispatch-event/Resume
                // cancellation gap. An already admitted operation is stopped as in-flight work.
                dispatchCount++;
                child.Resume(); started = true;
            });
            Json.Write(new { @event = "dispatch", id, pid = child.Identity.Pid, processCreationTime = child.Identity.Created.ToString(), inJob = true, dispatchCount });
            var clock = Stopwatch.StartNew();
            string? interrupted = null;
            while (!child.Drained())
            {
                if (cancellation.IsCancellationRequested) { interrupted = stopCode ?? "cancelled"; break; }
                if (clock.ElapsedMilliseconds >= timeout) { interrupted = "native_timeout"; break; }
                if (child.Output.IsFaulted || child.Errors.IsFaulted) { interrupted = "output_limit"; break; }
                await Task.Delay(10);
            }
            if (interrupted is not null)
            {
                // Briefly drain a gesture already finishing; then terminate the complete owned job.
                var drain = Stopwatch.StartNew();
                while (!child.Drained() && drain.ElapsedMilliseconds < 150) await Task.Delay(10);
                var exited = child.Drained() || child.KillAndConfirm();
                var cleanup = await FinishInput(record, exited, interrupted, id, provider);
                return ErrorEnvelope(id, interrupted, "The owned operation was interrupted; verify its application effect before continuing.", cleanup, started ? "unknown" : "not_dispatched");
            }
            var recovery = await FinishInput(record, true, "normal_exit", id, provider);
            if (record is not null && RecoveryStore.Read() is not null)
            {
                Stop("input_recovery_required");
                return ErrorEnvelope(id, "input_recovery_required", "Input release could not be verified; durable quarantine was retained.", recovery, "unknown");
            }
            var stdout = await child.Output.WaitAsync(TimeSpan.FromSeconds(1));
            var stderr = await child.Errors.WaitAsync(TimeSpan.FromSeconds(1));
            return new { id, result = new { stdout, stderr, exitCode = child.ExitCode(), recovery } };
        }
        catch (Exception error)
        {
            var exited = child is null || child.KillAndConfirm();
            var recovery = await FinishInput(record, exited, "operation_failed", id, provider);
            var code = error is TraceError trace ? trace.Code : error is OperationCanceledException ? stopCode ?? "cancelled" : "supervised_operation_failed";
            return ErrorEnvelope(id, code, "The supervised operation failed; inspect delivery and cleanup before another action.", recovery, started ? "unknown" : "not_dispatched", (error as TraceError)?.Win32Error);
        }
        finally { try { child?.Dispose(); } catch { Stop("native_disposal_failed"); } }
    }

    private async Task<object?> FinishInput(RecoveryRecord? record, bool exited, string reason, string id, string provider)
    {
        if (record is null) return null;
        try
        {
            if (!exited)
            {
                RecoveryStore.Write(record with { Phase = "quarantined", Reason = "process_exit_unconfirmed" });
                Stop("input_recovery_required");
                return new { attempted = false, released = false, processExitConfirmed = false, reason = "process_exit_unconfirmed",
                    childPid = record.Child?.Pid, childCreated = record.Child?.Created.ToString(), declaredKeysDown = Array.Empty<int>() };
            }
            var released = InputState.ReleaseDeclared(record.Keys, record.Unicode);
            if (released.Released)
            {
                if (allowControlled && provider == "controlled" && recoveryFault is not null && !recoveryFaultConsumed
                    && record.Child is not null && reason != "normal_exit" && stopCode is null)
                    return await FailReleaseAcknowledgement(record, id, released);
                RecoveryStore.Clear(sessionKey);
                return new { attempted = true, released = true, processExitConfirmed = true, method = "declared-sendinput", reason,
                    childPid = record.Child?.Pid, childCreated = record.Child?.Created.ToString(), declaredKeysDown = released.RemainingDown,
                    stopCleanupMs = physicalStopAtTicks > 0 ? (double?)Math.Round(Stopwatch.GetElapsedTime(physicalStopAtTicks).TotalMilliseconds, 3) : null };
            }
            RecoveryStore.Write(record with { Phase = "quarantined", Reason = "input_release_unconfirmed" });
            Stop("input_recovery_required");
            return new { attempted = true, released = false, processExitConfirmed = true, reason = "input_release_unconfirmed", code = "input_recovery_failed",
                childPid = record.Child?.Pid, childCreated = record.Child?.Created.ToString(), declaredKeysDown = released.RemainingDown };
        }
        catch (Exception error)
        {
            // Any pending intent remains durable; an IO/release failure cannot silently clear it.
            try { RecoveryStore.Write(record with { Phase = "quarantined", Reason = (error as TraceError)?.Code ?? "input_recovery_failed" }); } catch { }
            Stop("input_recovery_required");
            return new { attempted = true, released = false, code = (error as TraceError)?.Code ?? "input_recovery_failed", win32Error = (error as TraceError)?.Win32Error };
        }
    }

    private async Task<object> FailReleaseAcknowledgement(RecoveryRecord record, string id, ReleaseResult release)
    {
        recoveryFaultConsumed = true;
        RecoveryStore.Write(record with { Phase = "awaiting_external_release_check", Reason = "private_test_checkpoint" });
        var proof = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate) { recoveryProofOperation = id; recoveryProof = proof; }
        // This message is emitted only AFTER real process exit, SendInput balancing and the native
        // state check. The external harness must independently observe exit and key state before ACK.
        Json.Write(new { @event = "test-release-ready", id, token = recoveryFault!.Token,
            childPid = record.Child!.Pid, processCreationTime = record.Child.Created.ToString(),
            processExitConfirmed = true, physicalReleaseObserved = true, declaredKeys = record.Keys, remainingDown = release.RemainingDown });
        var confirmed = false;
        try { confirmed = await proof.Task.WaitAsync(TimeSpan.FromSeconds(3)); }
        catch (TimeoutException) { }
        finally { lock (gate) { recoveryProof = null; recoveryProofOperation = null; } }
        InputState.EnsureObservable();
        var down = InputState.Expand(record.Keys).Where(InputState.IsDown).ToArray();
        if (down.Length != 0) throw new TraceError("input_recovery_failed", "Input changed during the private release-verification checkpoint.");
        var cause = confirmed ? "test_release_ack_failed" : "test_release_ack_missing";
        RecoveryStore.Write(record with { Phase = "quarantined", Reason = cause });
        Stop("input_recovery_required");
        return new { attempted = true, released = false, processExitConfirmed = true, physicalReleaseObserved = true,
            failureInjected = confirmed, independentReleaseVerified = confirmed, reason = cause, code = "input_recovery_failed",
            childPid = record.Child.Pid, childCreated = record.Child.Created.ToString(), declaredKeysDown = down };
    }

    // Publish cleanup completion before starting it. Parent exit, a close command and Dispose must
    // all join the same work; a caller seeing only `closing` must never let the process exit early.
    private Task Close() => cleanup.Run(CloseCore);

    private async Task CloseCore()
    {
        closing = true;
        lifetime.Cancel();
        Task? active;
        lock (gate) { operationCancellation?.Cancel(); active = operation; }
        try { if (active is not null) await active; }
        catch { /* A fault cannot skip glow teardown. Any persisted input intent remains quarantine. */ }
        try
        {
            if (indicator is not null)
            {
                try { indicator.StandardInput.Close(); } catch { }
                try { await indicator.WaitForExitAsync().WaitAsync(TimeSpan.FromMilliseconds(1500)); }
                catch { try { indicator.Kill(); await indicator.WaitForExitAsync().WaitAsync(TimeSpan.FromMilliseconds(1500)); } catch { } }
                if (!indicator.HasExited) throw new TraceError("indicator_stop_unconfirmed", "The activity marker exit could not be confirmed.");
                indicator.Dispose(); indicator = null;
            }
        }
        finally
        {
            escape?.Dispose(); escape = null;
            if (lease != 0) { Native.CloseHandle(lease); lease = 0; }
        }
    }

    public void Dispose()
    {
        Close().GetAwaiter().GetResult();
        operationCancellation?.Dispose(); lifetime.Dispose();
    }
}

internal sealed class AsyncCleanup
{
    private readonly object gate = new();
    private Task? completion;

    public Task Run(Func<Task> work)
    {
        TaskCompletionSource owner;
        lock (gate)
        {
            if (completion is not null) return completion;
            owner = new(TaskCreationOptions.RunContinuationsAsynchronously);
            completion = owner.Task;
        }
        _ = Complete(work, owner);
        return owner.Task;
    }

    private static async Task Complete(Func<Task> work, TaskCompletionSource completion)
    {
        try { await work(); completion.TrySetResult(); }
        catch (Exception error) { completion.TrySetException(error); }
    }
}

internal static class DispatchGuard
{
    public static void Enter(object gate, CancellationToken cancellation, Func<bool> stopped, Action admitted)
    {
        lock (gate)
        {
            cancellation.ThrowIfCancellationRequested();
            if (stopped()) throw new TraceError("session_stopped", "The native session stopped before dispatch admission.");
            admitted();
        }
    }
}

// Not an authorization boundary: only the private inherited-stdio test host can opt into this
// source-owned controlled-provider seam. No public tool, action, environment flag or launcher adds it.
internal sealed record RecoveryFaultSpec(string Token)
{
    public static RecoveryFaultSpec? Parse(JsonElement root, bool allowControlled)
    {
        if (!root.TryGetProperty("testRecovery", out var value)) return null;
        if (!allowControlled || value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty("mode", out var mode) || mode.GetString() != "fail-release-ack"
            || !value.TryGetProperty("token", out var token) || token.ValueKind != JsonValueKind.String
            || token.GetString() is not { Length: 32 } text || !text.All(Uri.IsHexDigit))
            throw new TraceError("invalid_test_configuration", "Private cleanup fault injection requires an explicitly configured controlled test provider and checkpoint token.");
        return new(token.GetString()!);
    }
    public static bool Accept(string? expectedId, string providedId, string expectedToken, string providedToken, bool verified)
        => verified && expectedId is not null && expectedId == providedId && expectedToken == providedToken;
}

internal static class SupervisorSelfTest
{
    public static object Run()
    {
        static void Require(bool condition) { if (!condition) throw new TraceError("selftest_failed", "A non-input supervisor contract check failed."); }
        var self = ProcessIdentity.Self();
        using var same = self.OpenExact(); Require(same is not null);
        Require(OperationProcess.Quote("") == "\"\"");
        Require(OperationProcess.Quote("plain") == "plain");
        Require(OperationProcess.Quote("two words\\") == "\"two words\\\\\"");
        Require(InputDeclaration.For("winapp", ["ui", "drag", "--json"], [], true).Keys.Contains(1));
        Require(InputDeclaration.For("winapp", ["ui", "send-keys", "--json", "--verbatim", "--", "a漢"], [], true).Unicode.SequenceEqual(new[] { 97, 28450 }));
        Require(InputDeclaration.For("bridge", ["bounds", "1", "2"], [], false).Keys.Length == 0);
        Require(InputDeclaration.For("bridge", ["identity", "1", "2"], [], false).Keys.Length == 0);
        Require(InputDeclaration.For("bridge", ["identities"], [], false).Keys.Length == 0);
        var rejected = false;
        try { InputDeclaration.For("winapp", ["ui", "send-keys", "--json"], [], false); } catch (TraceError) { rejected = true; }
        Require(rejected);
        rejected = false;
        try { (self with { Created = self.Created + 1 }).OpenExact(); } catch (TraceError error) { rejected = error.Code == "process_identity_mismatch"; }
        Require(rejected);
        var down = new HashSet<int> { 1, 0xA2, 0xA1 };
        var sent = new List<int>();
        var balanced = InputState.ReleaseCore([1, 0x11, 0x10], down.Contains, key => { sent.Add(key); down.Remove(key); }, _ => { });
        Require(balanced.Released && sent.Order().SequenceEqual(new[] { 1, 0xA1, 0xA2 }));
        var rounds = 0;
        var failed = InputState.ReleaseCore([1], _ => true, _ => rounds++, _ => { });
        Require(!failed.Released && rounds == 2 && failed.RemainingDown.SequenceEqual(new[] { 1 }));
        var noRelease = InputState.ReleaseCore([1], _ => false, _ => throw new InvalidOperationException(), _ => { });
        Require(noRelease.Released && noRelease.Attempted.Length == 0);
        var serialized = JsonSerializer.Serialize(new RecoveryRecord(1, "test", self, self, [1, 0xA2], [97], "intent", "test"));
        var restored = JsonSerializer.Deserialize<RecoveryRecord>(serialized)!;
        Require(restored.Supervisor == self && restored.Child == self && restored.Keys.SequenceEqual(new[] { 1, 0xA2 }) && restored.Unicode.SequenceEqual(new[] { 97 }));
        var privateBytes = System.Text.Encoding.UTF8.GetBytes(serialized);
        var protectedBytes = UserProtection.Protect(privateBytes);
        Require(!protectedBytes.SequenceEqual(privateBytes) && UserProtection.Unprotect(protectedBytes).SequenceEqual(privateBytes));
        using var faultConfig = JsonDocument.Parse("{\"testRecovery\":{\"mode\":\"fail-release-ack\",\"token\":\"0123456789abcdef0123456789abcdef\"}}");
        Require(RecoveryFaultSpec.Parse(faultConfig.RootElement, true)?.Token == "0123456789abcdef0123456789abcdef");
        rejected = false;
        try { RecoveryFaultSpec.Parse(faultConfig.RootElement, false); } catch (TraceError error) { rejected = error.Code == "invalid_test_configuration"; }
        Require(rejected);
        Require(RecoveryFaultSpec.Accept("operation", "operation", "token", "token", true)
            && !RecoveryFaultSpec.Accept("operation", "other", "token", "token", true)
            && !RecoveryFaultSpec.Accept("operation", "operation", "token", "other", true)
            && !RecoveryFaultSpec.Accept("operation", "operation", "token", "token", false));
        var admissions = 0; var admissionGate = new object();
        DispatchGuard.Enter(admissionGate, CancellationToken.None, () => false, () => admissions++);
        Require(admissions == 1);
        rejected = false;
        try { DispatchGuard.Enter(admissionGate, CancellationToken.None, () => true, () => admissions++); }
        catch (TraceError error) { rejected = error.Code == "session_stopped"; }
        Require(rejected && admissions == 1);
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        rejected = false;
        try { DispatchGuard.Enter(admissionGate, cancelled.Token, () => false, () => admissions++); }
        catch (OperationCanceledException) { rejected = true; }
        Require(rejected && admissions == 1);
        var closeOnce = new AsyncCleanup();
        var releaseCleanup = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupCalls = 0; var cleanupCompletions = 0;
        var firstClose = closeOnce.Run(async () => { Interlocked.Increment(ref cleanupCalls); await releaseCleanup.Task; Interlocked.Increment(ref cleanupCompletions); });
        var joiners = Task.WhenAll(Enumerable.Range(0, 6).Select(_ => Task.Factory.StartNew(
            () => closeOnce.Run(() => throw new InvalidOperationException("Cleanup must run once.")),
            CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default))).GetAwaiter().GetResult();
        Require(cleanupCalls == 1 && cleanupCompletions == 0 && !firstClose.IsCompleted
            && joiners.All(value => ReferenceEquals(value, firstClose) && !value.IsCompleted));
        releaseCleanup.SetResult();
        Require(Task.WhenAll(joiners).Wait(TimeSpan.FromSeconds(2)) && firstClose.IsCompletedSuccessfully
            && cleanupCalls == 1 && cleanupCompletions == 1
            && ReferenceEquals(firstClose, closeOnce.Run(() => throw new InvalidOperationException("Completed cleanup must not repeat."))));
        var failedCleanup = new AsyncCleanup();
        var cleanupError = new TraceError("test_cleanup_failure", "Injected non-input cleanup failure.");
        var failedClose = failedCleanup.Run(() => throw cleanupError);
        Require(failedClose.IsFaulted && ReferenceEquals(failedClose, failedCleanup.Run(() => Task.CompletedTask))
            && ReferenceEquals(failedClose.Exception?.InnerException, cleanupError));
        return new { passed = true, checks = 24, desktopInput = 0, scope = "identity/PID reuse, declarations, DPAPI, bounded release, fault ACK binding, final dispatch admission and joined once-only cleanup; injected primitives only" };
    }
}
