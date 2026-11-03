using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

// Packaged apps start by AUMID through IApplicationActivationManager, with no shell process.
// Protocol activation is limited to ms-settings: pages on the Settings AUMID; the controller
// holds the exact page allowlist. Window identity reads the AUMID of a window's own process
// and of any CoreWindow it hosts (ApplicationFrameHost frames host UWP apps such as Settings).
internal static partial class Program
{
    private const string SettingsAumid = "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";
    private static readonly Regex AumidPattern = new(@"^[A-Za-z0-9.\-]{3,50}_[a-z0-9]{13}![A-Za-z][A-Za-z0-9.\-]{0,63}$", RegexOptions.CultureInvariant);
    private static readonly Regex SettingsUriPattern = new(@"^ms-settings:[a-z][a-z0-9-]{0,63}$", RegexOptions.CultureInvariant);

    private static string RequireAumid(string value)
    {
        if (!AumidPattern.IsMatch(value)) throw new BridgeException("invalid_arguments", "Expected an exact packaged AUMID (PackageFamilyName!AppId).");
        return value;
    }
    private static string? RequireProtocol(string aumid, string? uri)
    {
        if (uri is null) return null;
        if (!SettingsUriPattern.IsMatch(uri) || !string.Equals(aumid, SettingsAumid, StringComparison.OrdinalIgnoreCase))
            throw new BridgeException("application_unsupported", "Protocol activation accepts only an ms-settings: page on the Settings AUMID.");
        return uri;
    }

    // Returns the installed AUMID with its catalog spelling, or null when no package of the family
    // registered for this user declares that application ID.
    private static string? InstalledAumid(string aumid)
    {
        var family = aumid[..aumid.IndexOf('!')];
        uint count = 0, length = 0;
        var rc = GetPackagesByPackageFamily(family, ref count, null, ref length, null);
        if (rc == 0 && count == 0) return null;
        if (rc != 122 /* ERROR_INSUFFICIENT_BUFFER */) throw new BridgeException("package_catalog_unavailable", $"Package lookup failed ({rc}).");
        var names = new nint[count]; var buffer = new char[length];
        var handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try
        {
            rc = GetPackagesByPackageFamily(family, ref count, names, ref length, buffer);
            if (rc != 0) throw new BridgeException("package_catalog_unavailable", $"Package lookup failed ({rc}).");
            foreach (var name in names.Take((int)count))
            {
                var fullName = Marshal.PtrToStringUni(name) ?? throw new BridgeException("package_catalog_unavailable", "Package name unavailable.");
                foreach (var id in ApplicationIds(fullName))
                    if (string.Equals(id, aumid, StringComparison.OrdinalIgnoreCase)) return id;
            }
            return null;
        }
        finally { handle.Free(); }
    }
    private static List<string> ApplicationIds(string fullName)
    {
        var ids = new List<string>();
        if (OpenPackageInfoByFullName(fullName, 0, out var info) != 0) return ids;
        try
        {
            uint length = 0;
            if (GetPackageApplicationIds(info, ref length, null, out var count) != 122 || length == 0 || length > 1 << 20) return ids;
            var buffer = new byte[length];
            if (GetPackageApplicationIds(info, ref length, buffer, out count) != 0) return ids;
            var pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
            try
            {
                for (var i = 0; i < count && i < 64; i++)
                    if (Marshal.PtrToStringUni(Marshal.ReadIntPtr(pinned.AddrOfPinnedObject(), i * nint.Size)) is { } id) ids.Add(id);
            }
            finally { pinned.Free(); }
        }
        finally { ClosePackageInfo(info); }
        return ids;
    }
    private static void ResolvePackage(string[] args)
    {
        if (args.Length != 2) throw new BridgeException("invalid_arguments", "Usage: packaged <AUMID>");
        var installed = InstalledAumid(RequireAumid(args[1])) ?? throw new BridgeException("unknown_application", "No installed package for this user declares this AUMID.");
        Write(new { aumid = installed, family = installed[..installed.IndexOf('!')], method = "appmodel-package-catalog" });
    }

    private static string? ProcessAumid(uint pid)
    {
        var process = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (process == 0) return null;
        try
        {
            uint length = 130; var buffer = new char[length];
            return GetApplicationUserModelId(process, ref length, buffer) == 0 && length > 1 ? new string(buffer, 0, (int)length - 1) : null;
        }
        finally { CloseHandle(process); }
    }
    private static object PackagedIdentity(nint hwnd, uint pid)
    {
        Guard(hwnd, pid);
        var hosted = new List<object>();
        nint child = 0;
        for (var i = 0; i < 16 && (child = FindWindowEx(hwnd, child, "Windows.UI.Core.CoreWindow", null)) != 0; i++)
        {
            GetWindowThreadProcessId(child, out var hostedPid);
            if (hostedPid != 0 && hostedPid != pid) hosted.Add(new { pid = hostedPid, aumid = ProcessAumid(hostedPid) });
        }
        var aumid = ProcessAumid(pid);
        Guard(hwnd, pid);
        return new { hwnd = hwnd.ToInt64().ToString(), pid, aumid, hosted, method = "appmodel-process-aumid" };
    }
    private static void PackagedIdentities(string[] args)
    {
        var windows = new List<object>();
        foreach (var argument in args[1..])
        {
            var pair = argument.Split(':');
            if (pair.Length != 2 || !long.TryParse(pair[0], out var handle) || handle <= 0 || !uint.TryParse(pair[1], out var processId) || processId == 0)
                throw new BridgeException("invalid_arguments", "Packaged identities require exact HWND:PID pairs.");
            try { windows.Add(PackagedIdentity(new nint(handle), processId)); }
            catch (Exception error)
            {
                windows.Add(new { hwnd = handle.ToString(), pid = processId,
                    identityError = new { code = error is BridgeException bridge ? bridge.Code : "window_bridge_failed" } });
            }
        }
        Write(new { windows });
    }

    private static void ActivatePackage(string[] args)
    {
        if (args.Length is not (2 or 3)) throw new BridgeException("invalid_arguments", "Usage: activate-package <AUMID> [ms-settings:<page>]");
        var requested = RequireAumid(args[1]); var uri = RequireProtocol(requested, args.Length == 3 ? args[2] : null);
        var aumid = InstalledAumid(requested) ?? throw new BridgeException("unknown_application", "No installed package for this user declares this AUMID.");
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint processId; int hr;
        if (uri is null) hr = manager.ActivateApplication(aumid, null, 0x2 /* AO_NOERRORUI */, out processId);
        else
        {
            var itemId = typeof(IShellItem).GUID; var arrayId = typeof(IShellItemArray).GUID;
            hr = SHCreateItemFromParsingName(uri, 0, ref itemId, out var item);
            if (hr != 0 || item is null) throw new BridgeException("application_unsupported", "The ms-settings: page could not be parsed; nothing was started.");
            hr = SHCreateShellItemArrayFromShellItem(item, ref arrayId, out var items);
            if (hr != 0 || items is null) throw new BridgeException("application_unsupported", "The ms-settings: page could not be prepared; nothing was started.");
            hr = manager.ActivateForProtocol(aumid, items, out processId);
        }
        if (hr != 0) throw new BridgeException("activation_failed", $"Packaged activation returned 0x{hr:X8}.");
        Write(new { aumid, pid = processId, protocol = uri is not null, method = "iapplicationactivationmanager" });
    }

    private static void PackageSelfTest()
    {
        var aumids = new[] { SettingsAumid, "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" };
        var invalid = new[] { "settings", "a_b!c", "Microsoft.WindowsNotepad_8wekyb3d8bbwe", "x y_8wekyb3d8bbwe!App", "Pkg_8WEKYB3D8BBWE!App", "Pkg_8wekyb3d8bbwe!App&x" };
        var pages = new[] { "ms-settings:display", "ms-settings:network-status" };
        var refused = new[] { "ms-settings:", "ms-settings:Display", "ms-settings:display?x=1", "ms-settings://display", "http://example.com", "ms-settingsx:display" };
        bool Rejects(Action action) { try { action(); return false; } catch (BridgeException) { return true; } }
        if (!aumids.All(AumidPattern.IsMatch) || invalid.Any(AumidPattern.IsMatch)
            || pages.Any(page => RequireProtocol(SettingsAumid, page) != page)
            || !refused.All(page => Rejects(() => RequireProtocol(SettingsAumid, page)))
            || !Rejects(() => RequireProtocol(aumids[1], "ms-settings:display")))
            throw new BridgeException("selftest_failed", "Packaged AUMID or protocol validation failed without activation.");
    }

    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string? arguments, int options, out uint processId);
        [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IShellItemArray items, [MarshalAs(UnmanagedType.LPWStr)] string? verb, out uint processId);
        [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IShellItemArray items, out uint processId);
    }
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] private class ApplicationActivationManager { }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IShellItem { }
    [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface IShellItemArray { }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetPackagesByPackageFamily(string family, ref uint count, [Out] nint[]? names, ref uint length, [Out] char[]? buffer);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int OpenPackageInfoByFullName(string fullName, uint reserved, out nint info);
    [DllImport("kernel32.dll")] private static extern int GetPackageApplicationIds(nint info, ref uint length, [Out] byte[]? buffer, out uint count);
    [DllImport("kernel32.dll")] private static extern int ClosePackageInfo(nint info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetApplicationUserModelId(nint process, ref uint length, [Out] char[] buffer);
    [DllImport("kernel32.dll")] private static extern nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint FindWindowEx(nint parent, nint after, string? className, string? title);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SHCreateItemFromParsingName(string path, nint context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem? item);
    [DllImport("shell32.dll")] private static extern int SHCreateShellItemArrayFromShellItem([MarshalAs(UnmanagedType.Interface)] IShellItem item, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItemArray? items);
}
