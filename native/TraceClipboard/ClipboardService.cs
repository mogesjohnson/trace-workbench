using System.Security.Cryptography;
using System.Text;

internal sealed class ClipboardFailure(string code) : Exception(code)
{
    public string Code { get; } = code;
}

internal sealed record FormatBytes(uint Id, byte[] Bytes);
internal sealed class ClipboardState
{
    public string Token { get; set; } = Guid.NewGuid().ToString("D");
    public string Phase { get; set; } = "snapshotted";
    public uint OriginalSequence { get; set; }
    public string OriginalOwner { get; set; } = "0";
    public List<FormatBytes> Formats { get; set; } = [];
    public uint WrittenSequence { get; set; }
    public string WrittenOwner { get; set; } = "0";
    public string TextSha256 { get; set; } = "";
    public bool RequiresInputQuiescence { get; set; }
}

internal interface IClipboardBackend : IDisposable
{
    IDisposable Open();
    uint Sequence { get; }
    string Owner { get; }
    uint MarkerFormat { get; }
    IReadOnlyList<uint> Formats();
    byte[] Read(uint format);
    void Replace(IReadOnlyList<FormatBytes> formats);
    bool CanRestoreOwner(string writtenOwner);
}

internal interface IClipboardStore
{
    bool Exists { get; }
    void Save(ClipboardState state);
    ClipboardState Load();
    void Delete();
    void Archive(string token);
}

// Identifier-only diagnostics. No arbitrary registered name, data bytes, sequence, owner or
// transaction identity is collected. A pending recovery is observed, never loaded or cleared.
internal static class ClipboardFormatInspection
{
    internal const int MaximumFormats = 64;
    internal static object Inspect(Func<IDisposable> open, Func<IReadOnlyList<uint>> enumerate, Func<bool> recoveryExists)
    {
        using var held = open();
        var formats = enumerate();
        if (formats.Count > MaximumFormats || formats.Distinct().Count() != formats.Count || formats.Any(id => id is 0 or > 65535))
            throw new ClipboardFailure("clipboard_format_inspection_invalid");
        var supported = formats.Where(ClipboardService.Supported.Contains).Order().ToArray();
        var unsupported = formats.Where(id => !ClipboardService.Supported.Contains(id)).ToArray();
        var categories = unsupported.GroupBy(Category).OrderBy(group => group.Key, StringComparer.Ordinal)
            .Select(group => new { category = group.Key, count = group.Count() }).ToArray();
        bool pending = recoveryExists();
        return new { mode = "text-only", inspection = "format-identifiers-only", supported = unsupported.Length == 0,
            supportedFormatIds = supported, formatCount = formats.Count, unsupportedCount = unsupported.Length, categories,
            recoveryPending = pending, ready = unsupported.Length == 0 && !pending,
            code = pending ? "clipboard_recovery_required" : unsupported.Length > 0 ? "clipboard_unsupported_formats" : (string?)null,
            contentsRead = false, contentsChanged = false, recoveryWritten = false };
    }
    private static string Category(uint id) => id switch {
        2 or 3 or 8 or 9 or 14 or 17 => "image", 15 => "file-list",
        >= 0xC000 => "registered", >= 0x0300 and <= 0x03FF => "graphics-object",
        >= 0x0200 and <= 0x02FF => "private", <= 0x01FF => "standard-other", _ => "other"
    };
}

// The service never returns snapshot plaintext. Only opaque identity, byte counts and hashes
// leave this process. Unsupported formats are rejected before any EmptyClipboard call.
internal sealed class ClipboardService(IClipboardBackend backend, IClipboardStore store) : IDisposable
{
    internal static readonly HashSet<uint> Supported = [1, 7, 13, 16];
    private ClipboardState? state;
    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static readonly Encoding Unicode = new UnicodeEncoding(false, false, true);
    private static void Require(bool condition, string code) { if (!condition) throw new ClipboardFailure(code); }

    internal object Snapshot()
    {
        Require(state is null && !store.Exists, "clipboard_recovery_required");
        using var held = backend.Open();
        var formats = ReadSupported();
        state = new ClipboardState { Formats = formats, OriginalSequence = backend.Sequence, OriginalOwner = backend.Owner };
        Require(state.OriginalSequence != 0, "clipboard_access_unavailable");
        return new { token = state.Token, sequence = state.OriginalSequence, owner = state.OriginalOwner, mode = "text-only",
            formats = formats.Select(f => new { id = f.Id, bytes = f.Bytes.Length, sha256 = Sha(f.Bytes) }).ToArray(), snapshotContentReturned = false };
    }

    private List<FormatBytes> ReadSupported()
    {
        var result = new List<FormatBytes>();
        for (var pass = 0; pass < 8; pass++)
        {
            var formats = backend.Formats();
            Require(formats.Count <= 4 && formats.All(Supported.Contains), "clipboard_unsupported_formats");
            foreach (var format in formats.Where(id => result.All(f => f.Id != id))) result.Add(new FormatBytes(format, backend.Read(format)));
            Require(result.Sum(f => (long)f.Bytes.Length) <= 8 * 1024 * 1024, "clipboard_snapshot_too_large");
            if (backend.Formats().All(id => result.Any(f => f.Id == id))) return result;
        }
        throw new ClipboardFailure("clipboard_unstable_formats");
    }

    private ClipboardState Active(string token)
    {
        if (state is null && store.Exists) state = store.Load();
        Require(state is not null && Guid.TryParseExact(token, "D", out _) && state.Token == token, "clipboard_transaction_mismatch");
        return state!;
    }

    internal object WriteText(string token, string text)
    {
        var current = Active(token);
        Require(current.Phase == "snapshotted", "clipboard_write_already_attempted");
        Require(text.Length <= 65536 && !text.Contains('\0'), "clipboard_invalid_text");
        var content = Unicode.GetBytes(text);
        current.TextSha256 = Sha(content);
        using (backend.Open())
        {
            Require(backend.Sequence == current.OriginalSequence && backend.Owner == current.OriginalOwner, "clipboard_changed");
            current.Phase = "prepared";
            store.Save(current); // DPAPI-protected durable intent exists before mutation.
            try
            {
                backend.Replace([new FormatBytes(backend.MarkerFormat, Encoding.UTF8.GetBytes(current.Token + "\0")),
                    new FormatBytes(13, Unicode.GetBytes(text + "\0"))]);
                Require(MarkerMatches(current) && Sha(TextBytes()) == current.TextSha256, "clipboard_readback_mismatch");
            }
            catch
            {
                // The clipboard is still exclusively open: no human/new owner can have written.
                try { backend.Replace(current.Formats); VerifyOriginal(current); store.Delete(); Clear(); }
                catch { throw new ClipboardFailure("clipboard_recovery_required"); }
                throw new ClipboardFailure("clipboard_write_failed_restored");
            }
        }
        // Closing can materialize Windows text formats. Bind the final sequence only after close.
        using (backend.Open())
        {
            Require(MarkerMatches(current) && Sha(TextBytes()) == current.TextSha256, "clipboard_changed");
            current.WrittenSequence = backend.Sequence;
            current.WrittenOwner = backend.Owner;
            Require(current.WrittenSequence != 0, "clipboard_access_unavailable");
            current.Phase = "written";
            store.Save(current);
        }
        return new { token = current.Token, written = true, verified = true, sequence = current.WrittenSequence,
            sha256 = current.TextSha256, bytes = content.Length, mode = "text-only", recoveryProtected = "dpapi-current-user" };
    }

    private byte[] TextBytes()
    {
        var bytes = backend.Read(13);
        Require(bytes.Length >= 2 && bytes.Length % 2 == 0, "clipboard_invalid_unicode");
        var end = 0;
        while (end + 1 < bytes.Length && (bytes[end] != 0 || bytes[end + 1] != 0)) end += 2;
        Require(end + 1 < bytes.Length, "clipboard_invalid_unicode");
        _ = Unicode.GetString(bytes, 0, end); // Reject malformed UTF-16.
        return bytes[..end];
    }

    private bool MarkerMatches(ClipboardState current)
    {
        var formats = backend.Formats();
        if (!formats.Contains(backend.MarkerFormat) || formats.Any(id => id != backend.MarkerFormat && !Supported.Contains(id))) return false;
        var bytes = backend.Read(backend.MarkerFormat);
        var end = Array.IndexOf(bytes, (byte)0);
        return end >= 0 && Encoding.UTF8.GetString(bytes, 0, end) == current.Token;
    }

    private void GuardWritten(ClipboardState current)
    {
        Require(current.Phase == "written", "clipboard_recovery_uncertain");
        Require(backend.Sequence == current.WrittenSequence && backend.CanRestoreOwner(current.WrittenOwner)
            && MarkerMatches(current) && Sha(TextBytes()) == current.TextSha256, "clipboard_changed");
    }

    internal object Readback(string token)
    {
        var current = Active(token);
        using var held = backend.Open();
        GuardWritten(current);
        return new { token = current.Token, verified = true, matches = true, sequence = backend.Sequence,
            sha256 = current.TextSha256, contentReturned = false };
    }

    private void VerifyOriginal(ClipboardState current)
    {
        var actual = ReadSupported();
        Require(actual.Count == current.Formats.Count && current.Formats.All(expected => actual.Any(f => f.Id == expected.Id
            && f.Bytes.AsSpan().SequenceEqual(expected.Bytes))), "clipboard_restore_mismatch");
    }

    internal object DeferAutomaticRestore(string token)
    {
        var current = Active(token);
        using var held = backend.Open();
        GuardWritten(current);
        current.RequiresInputQuiescence = true;
        store.Save(current); // Durable acknowledgement must precede any native paste request.
        return new { token = current.Token, automaticRestoreDeferred = true, requiresInputQuiescence = true };
    }

    internal object Restore(string token, bool inputQuiescent = false)
    {
        var current = Active(token);
        Require(!current.RequiresInputQuiescence || inputQuiescent, "clipboard_input_quiescence_required");
        if (current.Phase == "snapshotted") { Clear(); return new { restored = true, changed = false, mode = "text-only" }; }
        using (backend.Open())
        {
            GuardWritten(current); // Compare-and-restore while holding the same Win32 lock.
            backend.Replace(current.Formats);
            VerifyOriginal(current);
            store.Delete();
        }
        Clear();
        return new { restored = true, verified = true, mode = "text-only", exactSupportedBytes = true };
    }

    internal object Recover(bool inputQuiescent = false)
    {
        Require(store.Exists, "clipboard_no_recovery");
        state ??= store.Load();
        return Restore(state.Token, inputQuiescent);
    }

    internal object RecoveryInfo()
    {
        Require(store.Exists, "clipboard_no_recovery");
        state ??= store.Load();
        return new { token = state.Token, phase = state.Phase, sequence = state.WrittenSequence,
            sha256 = state.TextSha256, recoveryPending = true, requiresInputQuiescence = state.RequiresInputQuiescence,
            mode = "text-only", contentReturned = false };
    }

    internal object Abandon(string token)
    {
        var current = Active(token);
        var archived = store.Exists;
        if (archived) store.Archive(current.Token);
        Clear();
        return new { restored = false, currentClipboardPreserved = true, recoveryArchived = archived };
    }

    private void Clear()
    {
        if (state is not null) foreach (var format in state.Formats) CryptographicOperations.ZeroMemory(format.Bytes);
        state = null;
    }

    internal object Close()
    {
        if (state is null) return store.Exists
            ? new { cleanup = "unknown", code = "clipboard_recovery_required", recoveryRetained = true }
            : (object)new { cleanup = "confirmed" };
        if (state.RequiresInputQuiescence) return new { cleanup = "unknown", code = "clipboard_input_quiescence_required", recoveryRetained = store.Exists };
        try { Restore(state.Token); return new { cleanup = "confirmed" }; }
        catch (ClipboardFailure error) { return new { cleanup = "unknown", code = error.Code, recoveryRetained = store.Exists }; }
    }

    public void Dispose() { _ = Close(); Clear(); backend.Dispose(); }
}
