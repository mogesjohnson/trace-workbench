using System.Text.Json;

namespace TraceSupervisor;

internal sealed partial class SupervisorSession
{
    private readonly object clickGate = new();
    private Task<OperationProcess?>? pendingClick;

    private void PrimeClick()
    {
        lock (clickGate)
        {
            if (allowControlled || lifetime.IsCancellationRequested) return;
            pendingClick ??= Task.Run(WarmClick);
        }
    }

    private async Task<OperationProcess?> WarmClick()
    {
        OperationProcess? child = null;
        try
        {
            lifetime.Token.ThrowIfCancellationRequested();
            child = OperationProcess.Create(providers["bridge"], ["click-worker"], keepInput: true);
            DispatchGuard.Enter(gate, lifetime.Token, () => stopCode is not null || closing, child.Resume);
            var ready = await child.ReadReply().WaitAsync(TimeSpan.FromSeconds(5), lifetime.Token);
            if (ready != "{}") throw new TraceError("worker_protocol", "The click worker did not report readiness.");
            return child;
        }
        catch
        {
            if (child is not null) DestroyClick(child);
            return null;
        }
    }

    private Task<OperationProcess?>? TakePrimedClick()
    {
        lock (clickGate)
        {
            var prime = pendingClick;
            pendingClick = null;
            return prime;
        }
    }

    private async Task<object> RunPrimedClick(string id, string[] args, InputDeclaration input, int timeout, CancellationToken cancellation)
    {
        var prime = TakePrimedClick();
        var child = prime is null ? null : await prime;
        if (child is null)
            return await RunOperation(id, "bridge", args, input, true, timeout, cancellation);
        RecoveryRecord? record = null;
        var admitted = false;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            InputState.EnsureObservable();
            if (input.Keys.Any(InputState.IsDown)) throw new TraceError("input_busy", "The left button was already held.");
            // The idle child can read UIA only until its private command arrives. Commit its
            // exact identity and declared button before allowing that command onto the pipe.
            var intent = new RecoveryRecord(1, sessionKey, identity, child.Identity, input.Keys, input.Unicode, "intent", "operation_pending");
            RecoveryStore.Write(intent);
            record = intent;
            var request = JsonSerializer.Serialize(args);
            Task<string>? exchange = null;
            DispatchGuard.Enter(gate, cancellation, () => stopCode is not null || closing, () =>
            {
                dispatchCount++;
                admitted = true;
                exchange = Task.Run(() => child.Exchange(request));
            });
            Json.Write(new { @event = "dispatch", id, pid = child.Identity.Pid, processCreationTime = child.Identity.Created.ToString(), inJob = true, dispatchCount });
            _ = exchange!.ContinueWith(failed => _ = failed.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            var reply = await exchange.WaitAsync(TimeSpan.FromMilliseconds(timeout), cancellation);
            // The one-shot process exits after its receipt. Require the entire job to drain
            // before acknowledging input or releasing the button.
            if (!child.Drained() && !child.WaitForExit(1000))
                throw new TraceError("process_exit_unconfirmed", "The one-shot click job did not drain.");
            if (!child.Drained()) throw new TraceError("process_exit_unconfirmed", "The one-shot click job still contains a child.");
            var recovery = await FinishInput(record, true, "normal_exit", id, "bridge");
            if (RecoveryStore.Read() is not null)
                return ErrorEnvelope(id, "input_recovery_required", "Input release could not be verified.", recovery, "unknown");
            return new { id, result = new { stdout = reply, stderr = "", exitCode = child.ExitCode(), recovery } };
        }
        catch (Exception error)
        {
            var exited = child.Drained() || child.KillAndConfirm();
            var recovery = await FinishInput(record, exited, "operation_failed", id, "bridge");
            if (!exited && record is null)
            {
                clickExitUnconfirmed = true;
                Stop("worker_exit_unconfirmed");
            }
            var code = error is TraceError trace ? trace.Code : error is OperationCanceledException ? stopCode ?? "cancelled"
                : error is TimeoutException ? "native_timeout" : "worker_protocol";
            return ErrorEnvelope(id, code, "The guarded click did not confirm completion.", recovery, admitted ? "unknown" : "not_dispatched");
        }
        finally { child.Dispose(); }
    }

    private Task? clickCleanup;

    private Task ClosePrimedClick()
    {
        lock (clickGate) return clickCleanup ??= Close();

        async Task Close()
        {
            var prime = TakePrimedClick();
            if (prime is not null && await prime is { } child) DestroyClick(child);
        }
    }

    private void DestroyClick(OperationProcess child)
    {
        try
        {
            if (!child.Drained() && !child.KillAndConfirm())
            {
                clickExitUnconfirmed = true;
                Stop("worker_exit_unconfirmed");
            }
        }
        finally { child.Dispose(); }
    }

    private volatile bool clickExitUnconfirmed;
}
