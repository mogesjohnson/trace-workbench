using System.Text;
using System.Text.Json;

// Pure in-memory fixtures. This mode never instantiates Win32Clipboard or ProtectedClipboardStore.
internal static class SelfTests
{
    private sealed class Scope : IDisposable { public void Dispose() { } }
    private sealed class FakeClipboard : IClipboardBackend
    {
        internal List<FormatBytes> Values = [];
        public uint Sequence { get; set; } = 1;
        public string Owner { get; set; } = "fixture-original";
        public uint MarkerFormat => 50000;
        internal int Writes;
        internal bool FailNext, Busy, PadMarker;
        public IDisposable Open() => Busy ? throw new ClipboardFailure("clipboard_busy") : new Scope();
        public IReadOnlyList<uint> Formats() => Values.Select(f => f.Id).ToArray();
        public byte[] Read(uint format) => Values.Single(f => f.Id == format).Bytes.ToArray();
        public void Replace(IReadOnlyList<FormatBytes> formats)
        {
            Values = formats.Select(f => new FormatBytes(f.Id, f.Bytes.ToArray())).ToList(); Sequence++; Owner = "fixture-helper"; Writes++;
            if (PadMarker) Values = Values.Select(f => f.Id == MarkerFormat ? new FormatBytes(f.Id, [.. f.Bytes, 65, 66, 67]) : f).ToList();
            if (FailNext) { FailNext = false; throw new ClipboardFailure("fixture_write_failed"); }
        }
        public bool CanRestoreOwner(string owner) => Owner == owner || Owner == "0";
        public void Dispose() { }
    }
    private sealed class MemoryStore : IClipboardStore
    {
        internal string? Encoded;
        public bool Exists => Encoded is not null;
        public void Save(ClipboardState state) => Encoded = JsonSerializer.Serialize(state);
        public ClipboardState Load() => JsonSerializer.Deserialize<ClipboardState>(Encoded!)!;
        public void Delete() => Encoded = null;
        public void Archive(string token) => Delete();
    }
    private static void Check(bool condition) { if (!condition) throw new Exception("fixture_assertion"); }
    private static string Token(object value) => JsonSerializer.SerializeToElement(value).GetProperty("token").GetString()!;
    private static void Error(Action action, string code)
    {
        try { action(); throw new Exception("expected_failure"); } catch (ClipboardFailure failure) { Check(failure.Code == code); }
    }
    internal static int Run()
    {
        var passed = 0;
        void Test(Action run) { run(); passed++; }
        try
        {
            Test(() => {
                var backend = new FakeClipboard { Values = [new(13, Encoding.Unicode.GetBytes("PRIVATE_FIXTURE\0")), new(1, [65, 0, 0, 0]), new(7, [66, 0]), new(16, [9, 4, 0, 0])] };
                var before = JsonSerializer.Serialize(backend.Values); var store = new MemoryStore(); using var service = new ClipboardService(backend, store);
                var snapshot = service.Snapshot(); Check(!JsonSerializer.Serialize(snapshot).Contains("PRIVATE_FIXTURE"));
                var token = Token(snapshot); _ = service.WriteText(token, "temporary 日本語"); _ = service.Readback(token); _ = service.Restore(token);
                Check(JsonSerializer.Serialize(backend.Values) == before && !store.Exists);
            });
            Test(() => { var b = new FakeClipboard { Values = [new(50001, [1, 2, 3])] }; using var s = new ClipboardService(b, new MemoryStore()); Error(() => s.Snapshot(), "clipboard_unsupported_formats"); Check(b.Writes == 0); });
            Test(() => { var b = new FakeClipboard(); using var s = new ClipboardService(b, new MemoryStore()); var t = Token(s.Snapshot()); b.Sequence++; Error(() => s.WriteText(t, "x"), "clipboard_changed"); Check(b.Writes == 0); });
            Test(() => { var b = new FakeClipboard(); var store = new MemoryStore(); using var s = new ClipboardService(b, store); var t = Token(s.Snapshot()); _ = s.WriteText(t, "x"); b.Sequence++; b.Owner = "human"; Error(() => s.Restore(t), "clipboard_changed"); Check(b.Writes == 1 && store.Exists); _ = s.Abandon(t); Check(b.Writes == 1); });
            Test(() => { var b = new FakeClipboard(); using var s = new ClipboardService(b, new MemoryStore()); var t = Token(s.Snapshot()); Error(() => s.WriteText(Guid.NewGuid().ToString("D"), "x"), "clipboard_transaction_mismatch"); Check(b.Writes == 0); _ = s.WriteText(t, "x"); _ = s.Restore(t); Check(b.Values.Count == 0); });
            Test(() => { var b = new FakeClipboard { Values = [new(13, Encoding.Unicode.GetBytes("original\0"))] }; var prior = JsonSerializer.Serialize(b.Values); var store = new MemoryStore(); using var s = new ClipboardService(b, store); var t = Token(s.Snapshot()); b.FailNext = true; Error(() => s.WriteText(t, "x"), "clipboard_write_failed_restored"); Check(JsonSerializer.Serialize(b.Values) == prior && !store.Exists); });
            Test(() => { var b = new FakeClipboard(); var store = new MemoryStore(); var crashed = new ClipboardService(b, store); var t = Token(crashed.Snapshot()); _ = crashed.WriteText(t, "x"); b.Owner = "0"; using var recovery = new ClipboardService(b, store); _ = recovery.Recover(); Check(b.Values.Count == 0 && !store.Exists); });
            Test(() => { var b = new FakeClipboard(); var store = new MemoryStore(); store.Save(new ClipboardState { Phase = "prepared" }); using var s = new ClipboardService(b, store); Error(() => s.Recover(), "clipboard_recovery_uncertain"); Check(b.Writes == 0 && store.Exists); });
            Test(() => { var b = new FakeClipboard { Busy = true }; using var s = new ClipboardService(b, new MemoryStore()); Error(() => s.Snapshot(), "clipboard_busy"); Check(b.Writes == 0); });
            Test(() => { var b = new FakeClipboard(); var store = new MemoryStore(); store.Save(new ClipboardState { Phase = "prepared" }); using var s = new ClipboardService(b, store); var result = JsonSerializer.SerializeToElement(s.Close()); Check(result.GetProperty("cleanup").GetString() == "unknown" && store.Exists && b.Writes == 0); });
            Test(() => { var b = new FakeClipboard { PadMarker = true }; using var s = new ClipboardService(b, new MemoryStore()); var t = Token(s.Snapshot()); _ = s.WriteText(t, "x"); _ = s.Readback(t); _ = s.Restore(t); Check(b.Values.Count == 0); });
            Test(() => {
                var b = new FakeClipboard { Values = [new(13, Encoding.Unicode.GetBytes("original\0"))] };
                var store = new MemoryStore(); var s = new ClipboardService(b, store); var t = Token(s.Snapshot()); _ = s.WriteText(t, "synthetic");
                _ = s.DeferAutomaticRestore(t); Check(store.Load().RequiresInputQuiescence);
                Error(() => s.Restore(t), "clipboard_input_quiescence_required");
                var closed = JsonSerializer.SerializeToElement(s.Close()); Check(closed.GetProperty("cleanup").GetString() == "unknown");
                s.Dispose(); Check(b.Writes == 1 && store.Exists && Encoding.Unicode.GetString(b.Read(13)).StartsWith("synthetic"));
                b.Owner = "0"; using var restarted = new ClipboardService(b, store);
                Check(JsonSerializer.SerializeToElement(restarted.RecoveryInfo()).GetProperty("requiresInputQuiescence").GetBoolean());
                Error(() => restarted.Recover(), "clipboard_input_quiescence_required"); Check(b.Writes == 1 && store.Exists);
                _ = restarted.Recover(true); Check(b.Writes == 2 && !store.Exists && Encoding.Unicode.GetString(b.Read(13)).StartsWith("original"));
            });
            Test(() => {
                var b = new FakeClipboard(); var store = new MemoryStore(); using var s = new ClipboardService(b, store);
                var t = Token(s.Snapshot()); _ = s.WriteText(t, "synthetic"); _ = s.DeferAutomaticRestore(t);
                b.Sequence++; b.Owner = "human"; Error(() => s.Restore(t, true), "clipboard_changed");
                Check(b.Writes == 1 && store.Exists && store.Load().RequiresInputQuiescence);
            });
            Console.WriteLine(JsonSerializer.Serialize(new { mode = "pure-fake-clipboard", passed, failed = 0, clipboardApiCalls = 0, clipboardWrites = 0 }));
            return 0;
        }
        catch { Console.WriteLine(JsonSerializer.Serialize(new { mode = "pure-fake-clipboard", passed, failed = 1, clipboardApiCalls = 0 })); return 1; }
    }
}
