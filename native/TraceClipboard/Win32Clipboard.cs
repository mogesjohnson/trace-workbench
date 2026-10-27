using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

internal sealed class Win32Clipboard : IClipboardBackend
{
    private readonly nint window;
    private readonly Mutex ownership;
    private readonly Thread windowThread;
    private uint windowThreadId;
    private bool disposed;
    public uint MarkerFormat { get; }
    public uint Sequence => GetClipboardSequenceNumber();
    public string Owner => GetClipboardOwner().ToInt64().ToString();

    internal Win32Clipboard()
    {
        var user = WindowsIdentity.GetCurrent().User?.Value ?? throw new ClipboardFailure("clipboard_user_unavailable");
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(user))).ToLowerInvariant();
        ownership = new Mutex(false, @"Local\TRACE.Clipboard." + key);
        try { if (!ownership.WaitOne(0)) { ownership.Dispose(); throw new ClipboardFailure("clipboard_transaction_busy"); } }
        catch (AbandonedMutexException) { /* Protected recovery state still gates the next transaction. */ }
        // Clipboard owners receive synchronous window messages. Pump a dedicated, invisible
        // message-only window so waiting on private stdio never blocks another app's copy.
        nint created = 0;
        using var started = new ManualResetEventSlim();
        windowThread = new Thread(() => {
            windowThreadId = GetCurrentThreadId();
            PeekMessageW(out _, 0, 0, 0, 0);
            created = CreateWindowExW(0, "STATIC", "TRACE Clipboard", 0, 0, 0, 0, 0, new nint(-3), 0, 0, 0);
            started.Set();
            try { while (created != 0 && GetMessageW(out var message, 0, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessageW(ref message); } }
            finally { if (created != 0) DestroyWindow(created); }
        }) { IsBackground = true, Name = "TRACE clipboard owner messages" };
        windowThread.Start();
        if (!started.Wait(2000) || created == 0) { ownership.ReleaseMutex(); ownership.Dispose(); throw new ClipboardFailure("clipboard_window_unavailable"); }
        window = created;
        MarkerFormat = RegisterClipboardFormatW("TRACE.TextClipboard.Transaction.v1");
        if (MarkerFormat == 0) { Dispose(); throw new ClipboardFailure("clipboard_format_unavailable"); }
    }

    public IDisposable Open()
        => OpenBounded(window);

    // No Win32Clipboard instance: inspection creates no owner window, mutex or registered marker.
    internal static object InspectFormats() => ClipboardFormatInspection.Inspect(
        () => OpenBounded(0), EnumerateFormats, () => File.Exists(ProtectedClipboardStore.StatePath));

    private static IDisposable OpenBounded(nint owner)
    {
        var clock = Stopwatch.StartNew();
        while (!OpenClipboard(owner))
        {
            if (clock.ElapsedMilliseconds >= 800) throw new ClipboardFailure("clipboard_busy");
            Thread.Sleep(15);
        }
        return new OpenScope();
    }

    public IReadOnlyList<uint> Formats()
        => EnumerateFormats();

    private static IReadOnlyList<uint> EnumerateFormats()
    {
        var result = new List<uint>();
        uint format = 0;
        while (true)
        {
            Marshal.SetLastPInvokeError(0);
            format = EnumClipboardFormats(format);
            if (format == 0)
            {
                if (Marshal.GetLastPInvokeError() != 0) throw new ClipboardFailure("clipboard_enumeration_failed");
                return result;
            }
            result.Add(format);
            if (result.Count > ClipboardFormatInspection.MaximumFormats) throw new ClipboardFailure("clipboard_unsupported_formats");
        }
    }

    public byte[] Read(uint format)
    {
        var handle = GetClipboardData(format);
        if (handle == 0) throw new ClipboardFailure("clipboard_data_unavailable");
        var length = GlobalSize(handle).ToUInt64();
        if (length == 0 || length > 4 * 1024 * 1024) throw new ClipboardFailure("clipboard_snapshot_too_large");
        var pointer = GlobalLock(handle);
        if (pointer == 0) throw new ClipboardFailure("clipboard_data_unavailable");
        try { var bytes = new byte[(int)length]; Marshal.Copy(pointer, bytes, 0, bytes.Length); return bytes; }
        finally { GlobalUnlock(handle); }
    }

    public void Replace(IReadOnlyList<FormatBytes> formats)
    {
        var allocated = new List<(uint format, nint handle)>();
        try
        {
            foreach (var format in formats)
            {
                if (format.Bytes.Length < 1 || format.Bytes.Length > 4 * 1024 * 1024) throw new ClipboardFailure("clipboard_snapshot_too_large");
                var handle = GlobalAlloc(0x0042 /* GMEM_MOVEABLE | GMEM_ZEROINIT */, (nuint)format.Bytes.Length);
                if (handle == 0) throw new ClipboardFailure("clipboard_allocation_failed");
                allocated.Add((format.Id, handle));
                var pointer = GlobalLock(handle);
                if (pointer == 0) throw new ClipboardFailure("clipboard_allocation_failed");
                try { Marshal.Copy(format.Bytes, 0, pointer, format.Bytes.Length); }
                finally { GlobalUnlock(handle); }
            }
            if (!EmptyClipboard()) throw new ClipboardFailure("clipboard_write_failed");
            for (var index = 0; index < allocated.Count; index++)
            {
                var item = allocated[index];
                if (SetClipboardData(item.format, item.handle) == 0) throw new ClipboardFailure("clipboard_write_failed");
                allocated[index] = (item.format, 0); // Windows now owns the allocation.
            }
        }
        finally { foreach (var item in allocated) if (item.handle != 0) GlobalFree(item.handle); }
    }

    public bool CanRestoreOwner(string writtenOwner)
    {
        if (Owner == writtenOwner) return true;
        return Owner == "0" && long.TryParse(writtenOwner, out var raw) && raw != 0 && !IsWindow(new nint(raw));
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (window != 0) { PostThreadMessageW(windowThreadId, 0x0012 /* WM_QUIT */, 0, 0); windowThread.Join(1000); }
        ownership.ReleaseMutex(); ownership.Dispose();
    }
    private sealed class OpenScope : IDisposable { public void Dispose() { if (!CloseClipboard()) throw new ClipboardFailure("clipboard_close_failed"); } }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(nint window);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetClipboardData(uint format, nint handle);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] private static extern nint GetClipboardOwner();
    [DllImport("user32.dll")] private static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint window);
    [StructLayout(LayoutKind.Sequential)] private struct Message { public nint Window; public uint Id; public nuint WParam; public nint LParam; public uint Time; public int X, Y; public uint Private; }
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool PeekMessageW(out Message message, nint window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern int GetMessageW(out Message message, nint window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessageW(uint thread, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint RegisterClipboardFormatW(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateWindowExW(uint extended, string className, string name, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalLock(nint memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(nint memory);
    [DllImport("kernel32.dll")] private static extern nuint GlobalSize(nint memory);
    [DllImport("kernel32.dll")] private static extern nint GlobalFree(nint memory);
}

internal sealed class ProtectedClipboardStore : IClipboardStore
{
    internal static string StatePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TRACE", "clipboard", "session-" + Process.GetCurrentProcess().SessionId, "recovery.dpapi");
    public bool Exists => File.Exists(StatePath);
    private sealed record Envelope(int Version, string UserSid, int SessionId, ClipboardState State);
    private static string UserSid => WindowsIdentity.GetCurrent().User?.Value ?? throw new ClipboardFailure("clipboard_user_unavailable");
    private static void CheckOrdinary(string path)
    {
        for (string? current = Path.GetDirectoryName(path); current is not null; current = Path.GetDirectoryName(current))
            if (Directory.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ClipboardFailure("clipboard_unsafe_recovery_path");
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new ClipboardFailure("clipboard_unsafe_recovery_path");
    }
    public void Save(ClipboardState state)
    {
        CheckOrdinary(StatePath);
        Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
        var plain = JsonSerializer.SerializeToUtf8Bytes(new Envelope(1, UserSid, Process.GetCurrentProcess().SessionId, state));
        byte[] encrypted;
        try { encrypted = Protect(plain, false); } finally { CryptographicOperations.ZeroMemory(plain); }
        var temporary = StatePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { stream.Write(encrypted); stream.Flush(true); }
            CheckOrdinary(StatePath);
            File.Move(temporary, StatePath, true);
        }
        finally { CryptographicOperations.ZeroMemory(encrypted); if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public ClipboardState Load()
    {
        CheckOrdinary(StatePath);
        if (new FileInfo(StatePath).Length > 20 * 1024 * 1024) throw new ClipboardFailure("clipboard_invalid_recovery");
        var plain = Protect(File.ReadAllBytes(StatePath), true);
        try
        {
            var value = JsonSerializer.Deserialize<Envelope>(plain);
            if (value?.Version != 1 || value.UserSid != UserSid || value.SessionId != Process.GetCurrentProcess().SessionId
                || !Guid.TryParseExact(value.State.Token, "D", out _) || !new[] { "prepared", "written" }.Contains(value.State.Phase)
                || value.State.Formats.Count > 4 || value.State.Formats.Select(f => f.Id).Distinct().Count() != value.State.Formats.Count
                || value.State.Formats.Any(f => !ClipboardService.Supported.Contains(f.Id) || f.Bytes.Length > 4 * 1024 * 1024)
                || value.State.Formats.Sum(f => (long)f.Bytes.Length) > 8 * 1024 * 1024) throw new ClipboardFailure("clipboard_invalid_recovery");
            return value.State;
        }
        catch (JsonException) { throw new ClipboardFailure("clipboard_invalid_recovery"); }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }
    public void Delete() { CheckOrdinary(StatePath); File.Delete(StatePath); }
    public void Archive(string token)
    {
        if (!Guid.TryParseExact(token, "D", out _)) throw new ClipboardFailure("clipboard_transaction_mismatch");
        CheckOrdinary(StatePath);
        File.Move(StatePath, Path.Combine(Path.GetDirectoryName(StatePath)!, "retained-" + token + ".dpapi"), false);
    }
    private static byte[] Protect(byte[] bytes, bool decrypt)
    {
        var input = new Blob { Length = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
        try
        {
            Marshal.Copy(bytes, 0, input.Data, bytes.Length);
            Blob output;
            var ok = decrypt ? CryptUnprotectData(ref input, 0, 0, 0, 0, 1, out output)
                : CryptProtectData(ref input, "TRACE text clipboard recovery", 0, 0, 0, 1, out output);
            if (!ok) throw new ClipboardFailure("clipboard_dpapi_failed");
            try { var result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result; }
            finally { LocalFree(output.Data); }
        }
        finally { for (var i = 0; i < input.Length; i++) Marshal.WriteByte(input.Data, i, 0); Marshal.FreeHGlobal(input.Data); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Length; public nint Data; }
    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CryptProtectData(ref Blob input, string description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref Blob input, nint description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern nint LocalFree(nint memory);
}
