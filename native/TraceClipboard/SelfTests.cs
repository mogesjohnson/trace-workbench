using System.Text;
using System.Text.Json;

// Pure in-memory fixtures. This mode never instantiates Win32Clipboard or ProtectedClipboardStore.
internal static class SelfTests
{
    private sealed class SplitBytes(byte[] bytes) : MemoryStream(bytes)
    {
        public override int Read(byte[] buffer, int offset, int count) => base.Read(buffer, offset, Math.Min(count, 1));
        public override int Read(Span<byte> buffer) => base.Read(buffer[..Math.Min(buffer.Length, 1)]);
    }
    private sealed class Scope : IDisposable { public void Dispose() { } }
    private sealed class FakeClipboard : IClipboardBackend
    {
        internal List<FormatBytes> Values = [];
        private uint sequence = 1;
        private string owner = "fixture-original";
        public uint Sequence { get { SequenceReads++; return sequence; } set { sequence = value; } }
        public string Owner { get { OwnerReads++; return owner; } set { owner = value; } }
        public uint MarkerFormat => 50000;
        internal int Writes, Reads, SequenceReads, OwnerReads;
        internal bool FailNext, Busy, PadMarker;
        public IDisposable Open() => Busy ? throw new ClipboardFailure("clipboard_busy") : new Scope();
        public IReadOnlyList<uint> Formats() => Values.Select(f => f.Id).ToArray();
        public byte[] Read(uint format) { Reads++; return Values.Single(f => f.Id == format).Bytes.ToArray(); }
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
        internal int Saves, Loads, Deletes;
        public bool Exists => Encoded is not null;
        public void Save(ClipboardState state) { Saves++; Encoded = JsonSerializer.Serialize(state); }
        public ClipboardState Load() { Loads++; return JsonSerializer.Deserialize<ClipboardState>(Encoded!)!; }
        public void Delete() { Deletes++; Encoded = null; }
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
                var b = new FakeClipboard { Values = [new(13, Encoding.Unicode.GetBytes("PRIVATE_FORMAT_ONLY\0")),
                    new(1, [65]), new(7, [66]), new(16, [9])] };
                var store = new MemoryStore();
                var result = JsonSerializer.SerializeToElement(ClipboardFormatInspection.Inspect(b.Open, b.Formats, () => store.Exists));
                Check(result.GetProperty("supported").GetBoolean() && result.GetProperty("ready").GetBoolean());
                Check(result.GetProperty("supportedFormatIds").GetArrayLength() == 4 && result.GetProperty("unsupportedCount").GetInt32() == 0);
                Check(b.Reads == 0 && b.Writes == 0 && b.SequenceReads == 0 && b.OwnerReads == 0 && store.Saves == 0 && store.Loads == 0 && store.Deletes == 0);
                Check(!result.GetRawText().Contains("PRIVATE_FORMAT_ONLY") && !result.TryGetProperty("token", out _) && !result.TryGetProperty("sequence", out _));
            });
            Test(() => {
                var b = new FakeClipboard { Values = [new(13, [0, 0]), new(2, [1]), new(15, [2]), new(50001, [3]), new(0x0201, [4]), new(0x0301, [5]), new(4, [6]), new(0x1000, [7])] };
                var store = new MemoryStore { Encoded = "must-not-load-private-recovery" };
                var result = JsonSerializer.SerializeToElement(ClipboardFormatInspection.Inspect(b.Open, b.Formats, () => store.Exists));
                Check(!result.GetProperty("supported").GetBoolean() && !result.GetProperty("ready").GetBoolean() && result.GetProperty("recoveryPending").GetBoolean());
                Check(result.GetProperty("unsupportedCount").GetInt32() == 7 && result.GetProperty("categories").GetArrayLength() == 7);
                Check(result.GetProperty("code").GetString() == "clipboard_recovery_required");
                Check(!result.GetProperty("contentsRead").GetBoolean() && !result.GetProperty("contentsChanged").GetBoolean() && !result.GetProperty("recoveryWritten").GetBoolean());
                Check(b.Reads == 0 && b.Writes == 0 && b.SequenceReads == 0 && b.OwnerReads == 0 && store.Saves == 0 && store.Loads == 0 && store.Deletes == 0 && store.Exists);
            });
            Test(() => {
                var b = new FakeClipboard(); var result = JsonSerializer.SerializeToElement(ClipboardFormatInspection.Inspect(b.Open, b.Formats, () => false));
                Check(result.GetProperty("supported").GetBoolean() && result.GetProperty("formatCount").GetInt32() == 0 && b.Reads == 0 && b.Writes == 0);
                b.Busy = true; Error(() => ClipboardFormatInspection.Inspect(b.Open, b.Formats, () => false), "clipboard_busy"); Check(b.Reads == 0 && b.Writes == 0);
            });
            Test(() => {
                var b = new FakeClipboard();
                Error(() => ClipboardFormatInspection.Inspect(b.Open, () => Enumerable.Range(1, 65).Select(i => (uint)i).ToArray(), () => false), "clipboard_format_inspection_invalid");
                Error(() => ClipboardFormatInspection.Inspect(b.Open, () => new uint[] { 0 }, () => false), "clipboard_format_inspection_invalid");
                Error(() => ClipboardFormatInspection.Inspect(b.Open, () => new uint[] { 13, 13 }, () => false), "clipboard_format_inspection_invalid"); Check(b.Reads == 0 && b.Writes == 0);
            });
            Test(() => {
                const string literal = "café 日本語 \U0001F680";
                using var reader = Program.OpenInput(new SplitBytes(Encoding.UTF8.GetBytes("{\"id\":\"" + literal + "\"}\n")));
                using var request = JsonDocument.Parse(Program.ReadBoundedLine(reader)!);
                Check(request.RootElement.GetProperty("id").GetString() == literal);
                Check(Program.ReadBoundedLine(reader) is null);
            });
            Test(() => {
                foreach (var invalid in new byte[][] { [0xC3, 0x28], [0xC0, 0xAF], [0xED, 0xA0, 0x80], [0xF0, 0x9F] })
                {
                    var handled = false; var rejected = false;
                    using var reader = Program.OpenInput(new SplitBytes([.. Encoding.UTF8.GetBytes("{\"id\":\""), .. invalid]));
                    try
                    {
                        using var request = JsonDocument.Parse(Program.ReadBoundedLine(reader)!);
                        handled = true;
                    }
                    catch (DecoderFallbackException) { rejected = true; }
                    Check(rejected && !handled);
                }
            });
            Test(() => {
                using var empty = Program.OpenInput(new MemoryStream()); Check(Program.ReadBoundedLine(empty) is null);
                using var bounded = Program.OpenInput(new SplitBytes(Encoding.UTF8.GetBytes(new string('a', 300001))));
                Error(() => Program.ReadBoundedLine(bounded), "request_too_large");
            });
            Test(() => {
                var backend = new FakeClipboard { Values = [new(13, Encoding.Unicode.GetBytes("PRIVATE_FIXTURE\0")), new(1, [65, 0, 0, 0]), new(7, [66, 0]), new(16, [9, 4, 0, 0])] };
                var before = JsonSerializer.Serialize(backend.Values); var store = new MemoryStore(); using var service = new ClipboardService(backend, store);
                var snapshot = service.Snapshot(); Check(!JsonSerializer.Serialize(snapshot).Contains("PRIVATE_FIXTURE"));
                var token = Token(snapshot); _ = service.WriteText(token, "temporary 日本語"); _ = service.Readback(token); _ = service.Restore(token);
                Check(JsonSerializer.Serialize(backend.Values) == before && !store.Exists);
            });
            Test(() => { var b = new FakeClipboard { Values = [new(50001, [1, 2, 3])] }; var store = new MemoryStore(); using var s = new ClipboardService(b, store); Error(() => s.Snapshot(), "clipboard_unsupported_formats"); Check(b.Reads == 0 && b.Writes == 0 && store.Saves == 0 && store.Loads == 0 && store.Deletes == 0); });
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
