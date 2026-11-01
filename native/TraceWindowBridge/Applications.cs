using Microsoft.Win32;
using System.Diagnostics;
using System.IO;

internal static partial class Program
{
    private static string? RegisteredExecutable(string? value)
    {
        if (value is null || value.Length > 32760 || value.Contains('\0')) return null;
        var expanded = Environment.ExpandEnvironmentVariables(value).Trim();
        if (expanded.Length >= 2 && expanded.StartsWith('"') && expanded.EndsWith('"')) expanded = expanded[1..^1];
        if (expanded.Contains('"') || expanded.Length < 4 || !char.IsAsciiLetter(expanded[0]) || expanded[1] != ':' || expanded[2] != '\\'
            || !expanded.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return null;
        try { return Path.GetFullPath(expanded); }
        catch (Exception error) when (error is ArgumentException or IOException or NotSupportedException) { return null; }
    }
    private static void ApplicationSelfTest()
    {
        if (RegisteredExecutable("\"C:\\Trace fixture\\app.exe\"") != "C:\\Trace fixture\\app.exe"
            || new[] { "app.exe", "C:\\app.exe --flag", "\\\\server\\app.exe", "C:\\app.cmd", "\0", "\"" }.Any(value => RegisteredExecutable(value) is not null))
            throw new BridgeException("selftest_failed", "Registered executable parsing failed without registry or launch.");
    }
    private static void InstalledApplications()
    {
        const string path = @"Software\Microsoft\Windows\CurrentVersion\App Paths";
        var entries = new List<object>(); var issues = new List<string>(); var scanned = 0;
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            var source = $"{hive}/{view}/App Paths";
            try
            {
                using var root = RegistryKey.OpenBaseKey(hive, view); using var apps = root.OpenSubKey(path, false);
                if (apps is null) continue;
                foreach (var name in apps.GetSubKeyNames().Order(StringComparer.OrdinalIgnoreCase))
                {
                    if (++scanned > 2000) { issues.Add("registration_limit"); break; }
                    using var key = apps.OpenSubKey(name, false);
                    var executable = RegisteredExecutable(key?.GetValue(null, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string);
                    if (executable is null || !File.Exists(executable)) continue;
                    entries.Add(new { name = Path.GetFileNameWithoutExtension(name), executable, registration = source + "/" + name });
                }
            }
            catch (Exception error) when (error is UnauthorizedAccessException or System.Security.SecurityException or IOException)
            { issues.Add(source + ":unavailable"); }
        }
        Write(new { applications = entries, partial = issues.Count > 0, issues,
            coverage = "HKCU/HKLM App Paths, 32/64-bit views; local existing EXE registrations only" });
    }
    private static void ReadProcess(string[] args)
    {
        if (args.Length != 2 || !int.TryParse(args[1], out var pid) || pid <= 0) throw new BridgeException("invalid_arguments", "Process read requires an exact PID.");
        using var process = Process.GetProcessById(pid);
        var executable = process.MainModule?.FileName ?? throw new BridgeException("process_identity_unavailable", "Executable path unavailable.");
        Write(new { pid, processCreationTime = process.StartTime.ToFileTimeUtc().ToString(), sessionId = process.SessionId, executable });
    }
}
