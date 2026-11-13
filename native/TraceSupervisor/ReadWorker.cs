using System.Text.Json;

namespace TraceSupervisor;

internal sealed partial class SupervisorSession
{
    private OperationProcess? worker;
    private readonly object workerGate = new();
    private bool workerExitUnconfirmed;

    private bool UseWorker(string provider, string[] args, bool mutating) =>
        !allowControlled && !mutating && provider == "bridge" && args[0] is ("observe" or "hit");

    private async Task<object> RunWorker(string id, string[] args, int timeout, CancellationToken cancellation)
    {
        try
        {
            DispatchGuard.Enter(gate, cancellation, () => stopCode is not null || closing, () => { });
            if (worker?.Exited == true) StopWorker();
            if (worker is null)
            {
                worker = OperationProcess.Create(providers["bridge"], ["read-worker"], keepInput: true);
                DispatchGuard.Enter(gate, cancellation, () => stopCode is not null || closing, worker.Resume);
            }
            var exchange = worker.Exchange(JsonSerializer.Serialize(args));
            _ = exchange.ContinueWith(failed => _ = failed.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            var reply = await exchange.WaitAsync(TimeSpan.FromMilliseconds(timeout), cancellation);
            cancellation.ThrowIfCancellationRequested();
            return new { id, result = new { stdout = reply, stderr = "", exitCode = 0 } };
        }
        catch (Exception error)
        {
            var code = error switch
            {
                TraceError trace => trace.Code,
                TimeoutException => "native_timeout",
                OperationCanceledException => stopCode ?? "cancelled",
                _ => "worker_protocol"
            };
            try { StopWorker(); }
            catch (TraceError cleanup) { return ErrorEnvelope(id, cleanup.Code, cleanup.Message); }
            return ErrorEnvelope(id, code, "The read worker could not complete the operation.");
        }
    }

    private void StopWorker()
    {
        lock (workerGate) StopWorkerLocked();
    }

    private void StopWorkerLocked()
    {
        var child = worker;
        if (child is null && !workerExitUnconfirmed) return;
        if (child is null) throw new TraceError("worker_exit_unconfirmed", "The read worker did not confirm exit.");
        worker = null;
        try
        {
            if (!child.Drained() && !child.KillAndConfirm())
            {
                workerExitUnconfirmed = true;
                Stop("worker_exit_unconfirmed");
                throw new TraceError("worker_exit_unconfirmed", "The read worker did not confirm exit.");
            }
        }
        finally { child.Dispose(); }
    }

    private async Task DrainIdleWorker()
    {
        Task? active;
        lock (gate) active = operation;
        try { if (active is not null) await active; } catch { }
        try { StopWorker(); } catch (TraceError) { }
    }
}
