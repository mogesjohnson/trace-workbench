namespace TraceSupervisor;

// Global asynchronous key/button state and balancing releases for TRACE-declared input.
internal static class InputState
{
    private const int Shift = 0x10, Control = 0x11, Menu = 0x12;
    // Extended scan codes are required for right-side modifiers, navigation keys and Windows keys.
    private static readonly HashSet<int> Extended = [0xA3, 0xA5, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x6F, 0x90];

    public static bool IsDown(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;
    public static bool IsMouse(int vk) => vk is 0x01 or 0x02 or 0x04 or 0x05 or 0x06;

    public static SortedSet<int> Down()
    {
        var down = new SortedSet<int>();
        for (var vk = 1; vk < 255; vk++) if (IsDown(vk)) down.Add(vk);
        return down;
    }

    // Generic modifier codes mirror their left/right keys; balancing releases the specific side.
    public static SortedSet<int> Expand(IEnumerable<int> keys)
    {
        var expanded = new SortedSet<int>();
        foreach (var vk in keys)
        {
            if (vk == Shift) { expanded.Add(0xA0); expanded.Add(0xA1); }
            else if (vk == Control) { expanded.Add(0xA2); expanded.Add(0xA3); }
            else if (vk == Menu) { expanded.Add(0xA4); expanded.Add(0xA5); }
            else expanded.Add(vk);
        }
        return expanded;
    }

    public static Native.Input Key(int vk, bool up)
    {
        var scan = Native.MapVirtualKey((uint)vk, 4 /* MAPVK_VK_TO_VSC_EX */);
        var flags = (up ? Native.KeyUp : 0) | ((scan & 0xFF00) == 0xE000 || Extended.Contains(vk) ? Native.KeyExtended : 0);
        return new Native.Input { Type = Native.InputKeyboard, Data = new Native.InputUnion { Keyboard = new Native.KeyboardInput { Vk = (ushort)vk, Scan = (ushort)(scan & 0xFF), Flags = flags } } };
    }

    public static Native.Input Mouse(uint flags) => new() { Type = Native.InputMouse, Data = new Native.InputUnion { Mouse = new Native.MouseInput { Flags = flags } } };

    public static void Send(params Native.Input[] inputs)
    {
        if (Native.SendInput((uint)inputs.Length, inputs, Native.InputSize) != inputs.Length)
            throw new TraceError("input_rejected", "Windows did not accept the input.");
    }

    private static Native.Input Up(int vk) => vk switch
    {
        0x01 => Mouse(Native.MouseLeftUp),
        0x02 => Mouse(Native.MouseRightUp),
        0x04 => Mouse(Native.MouseMiddleUp),
        _ => Key(vk, true),
    };

    // Sends an up event only for listed keys/buttons that are down, then re-reads global state.
    public static ReleaseResult Release(IEnumerable<int> candidates)
    {
        var targets = Expand(candidates);
        var attempted = new SortedSet<int>();
        for (var round = 0; round < 2; round++)
        {
            var down = targets.Where(IsDown).ToList();
            if (down.Count == 0) break;
            foreach (var vk in down) { attempted.Add(vk); Send(Up(vk)); }
            Thread.Sleep(40);
        }
        var remaining = targets.Where(IsDown).ToArray();
        return new ReleaseResult(attempted.ToArray(), remaining);
    }
}

internal sealed record ReleaseResult(int[] Attempted, int[] RemainingDown)
{
    public bool Released => RemainingDown.Length == 0;
}

internal sealed class TraceError(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
