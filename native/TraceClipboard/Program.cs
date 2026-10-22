using System.Text;
using System.Text.Json;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--self-test" })) return SelfTests.Run();
        if (!OperatingSystem.IsWindows()) { Write(new { error = new { code = "unsupported_platform" } }); return 1; }
        if (args.SequenceEqual(new[] { "info" })) { Write(Info()); return 0; }
        if (!args.SequenceEqual(new[] { "--stdio" })) { Write(new { error = new { code = "invalid_arguments" } }); return 1; }
        ClipboardService? service = null;
        try
        {
            using var input = OpenInput(Console.OpenStandardInput());
            string? line;
            while ((line = ReadBoundedLine(input)) is not null)
            {
                string? id = null;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var request = document.RootElement;
                    id = request.GetProperty("id").GetString();
                    if (string.IsNullOrEmpty(id) || id.Length > 100) throw new ClipboardFailure("invalid_request");
                    var command = request.GetProperty("command").GetString();
                    var allowed = command switch { "write_text" => new[] { "id", "command", "token", "text" },
                        "readback" or "defer_restore" or "abandon" => ["id", "command", "token"],
                        "restore" => ["id", "command", "token", "inputQuiescent"],
                        "recover" => ["id", "command", "inputQuiescent"],
                        "info" or "inspect_formats" or "snapshot" or "recovery_info" or "close" => ["id", "command"], _ => [] };
                    if (allowed.Length == 0 || request.EnumerateObject().Any(p => !allowed.Contains(p.Name))) throw new ClipboardFailure("invalid_request");
                    object result;
                    if (command == "info") result = Info();
                    else if (command == "inspect_formats") result = Win32Clipboard.InspectFormats();
                    else if (command == "close") result = service?.Close() ?? (File.Exists(ProtectedClipboardStore.StatePath)
                        ? new { cleanup = "unknown", code = "clipboard_recovery_required", recoveryRetained = true }
                        : (object)new { cleanup = "confirmed" });
                    else
                    {
                        service ??= new ClipboardService(new Win32Clipboard(), new ProtectedClipboardStore());
                        var token = request.TryGetProperty("token", out var value) ? value.GetString() ?? "" : "";
                        var inputQuiescent = request.TryGetProperty("inputQuiescent", out var quiet) && quiet.GetBoolean();
                        result = command switch {
                            "snapshot" => service.Snapshot(),
                            "write_text" => service.WriteText(token, request.GetProperty("text").GetString() ?? throw new ClipboardFailure("clipboard_invalid_text")),
                            "readback" => service.Readback(token), "defer_restore" => service.DeferAutomaticRestore(token),
                            "restore" => service.Restore(token, inputQuiescent), "recover" => service.Recover(inputQuiescent),
                            "recovery_info" => service.RecoveryInfo(), "abandon" => service.Abandon(token),
                            _ => throw new ClipboardFailure("invalid_request") };
                    }
                    Write(new { id, result });
                    if (command == "close") break;
                }
                catch (Exception error) { Write(new { id, error = new { code = error is ClipboardFailure known ? known.Code : "clipboard_operation_failed" } }); }
            }
            return 0;
        }
        catch { return 1; }
        finally { service?.Dispose(); }
    }

    private static object Info() => new { version = 1, ready = !File.Exists(ProtectedClipboardStore.StatePath),
        recoveryPending = File.Exists(ProtectedClipboardStore.StatePath), mode = "text-only",
        supportedFormats = new uint[] { 1, 7, 13, 16 }, recoveryProtection = "dpapi-current-user",
        transport = "private-inherited-stdio", desktopInput = false };
    private static void Write(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
    // This inherited pipe carries Node UTF-8, independent of the current console code page.
    // Invalid bytes fail outside the request handler before any clipboard service is created.
    internal static StreamReader OpenInput(Stream stream) => new(stream,
        new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false);
    internal static string? ReadBoundedLine(TextReader input)
    {
        var builder = new StringBuilder();
        while (true)
        {
            var value = input.Read();
            if (value == -1) return builder.Length == 0 ? null : builder.ToString();
            if (value == '\n') return builder.ToString();
            if (builder.Length >= 300000) throw new ClipboardFailure("request_too_large");
            builder.Append((char)value);
        }
    }
}
