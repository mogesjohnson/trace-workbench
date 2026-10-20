using System.Runtime.InteropServices;
using System.Text;

namespace TraceSupervisor;

// Public Win32 APIs only. Input injection is limited to TRACE-owned providers and declared releases.
internal static class Native
{
    public const uint InputMouse = 0, InputKeyboard = 1;
    public const uint MouseLeftDown = 0x0002, MouseLeftUp = 0x0004, MouseRightUp = 0x0010, MouseMiddleUp = 0x0040;
    public const uint KeyExtended = 0x0001, KeyUp = 0x0002, KeyUnicode = 0x0004, KeyScanCode = 0x0008;
    public const int WhKeyboardLowLevel = 13;
    public const int WmKeyDown = 0x0100, WmKeyUp = 0x0101, WmSysKeyDown = 0x0104, WmSysKeyUp = 0x0105, WmQuit = 0x0012, WmUser = 0x0400;
    public const uint LowLevelInjected = 0x10;
    public const uint JobKillOnClose = 0x2000, JobDieOnUnhandledException = 0x400;
    public const uint CreateBreakawayFromJob = 0x01000000, CreateSuspended = 0x4, CreateNoWindow = 0x08000000;
    public const uint PipeAccessDuplex = 0x3, FileFlagFirstPipeInstance = 0x00080000, PipeRejectRemoteClients = 0x8;
    public const int ErrorAccessDenied = 5, ErrorPipeBusy = 231;

    [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int X, Y; public uint MouseData, Flags, Time; public nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort Vk, Scan; public uint Flags, Time; public nuint ExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Sequential)] public struct LowLevelKeyboard { public uint Vk, Scan, Flags, Time; public nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Message { public nint Hwnd; public uint Id; public nuint WParam; public nint LParam; public uint Time; public Point Pt; public uint Private; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MonitorInfoEx { public int Size; public Rect Monitor, Work; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device; }
    [StructLayout(LayoutKind.Sequential)] public struct JobBasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public nuint MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public nuint Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] public struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadTransfer, WriteTransfer, OtherTransfer; }
    [StructLayout(LayoutKind.Sequential)] public struct JobExtendedLimits { public JobBasicLimits Basic; public IoCounters Io; public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] public struct StartupInfo { public int Size; public nint Reserved, Desktop, Title; public int X, Y, Width, Height, XChars, YChars, Fill, Flags; public short Show, Reserved2; public nint Reserved3, StdInput, StdOutput, StdError; }
    [StructLayout(LayoutKind.Sequential)] public struct ProcessInformation { public nint Process, Thread; public uint ProcessId, ThreadId; }

    public delegate nint LowLevelProc(int code, nint wParam, nint lParam);
    public delegate bool MonitorProc(nint monitor, nint dc, ref Rect rect, nint data);

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char character);
    [DllImport("kernel32.dll")] public static extern nint GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(nint handle, uint mask, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll", SetLastError = true)] public static extern nint SetWindowsHookEx(int id, LowLevelProc proc, nint module, uint thread);
    [DllImport("user32.dll")] public static extern nint CallNextHookEx(nint hook, int code, nint wParam, nint lParam);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] public static extern int GetMessage(out Message message, nint hwnd, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool PeekMessage(out Message message, nint hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostThreadMessage(uint thread, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(nint dc, nint clip, MonitorProc proc, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(nint monitor, ref MonitorInfoEx info);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(nint monitor, int type, out uint x, out uint y);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern nint GetModuleHandle(string? name);
    [DllImport("kernel32.dll")] public static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern nint CreateJobObject(nint attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(nint job, int infoClass, ref JobExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(nint job, nint process);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(nint process, nint job, out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CreateProcess(string? application, StringBuilder commandLine, nint processAttributes, nint threadAttributes, bool inheritHandles, uint flags, nint environment, string? directory, ref StartupInfo startup, out ProcessInformation information);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(nint process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern nint CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, nint attributes);
    [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();

    public static readonly int InputSize = Marshal.SizeOf<Input>();
}
