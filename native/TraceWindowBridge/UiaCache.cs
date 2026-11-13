using System.Runtime.InteropServices;
using System.Windows.Automation;

internal static partial class Program
{
    // Public Windows SDK UIAutomationClient.idl. The first three slots on each interface are IUnknown.
    // This worker owns these pointers on its synchronous MTA request thread.
    private static string UiaControlName(int id)
    {
        // Load the managed identifiers once before asking LookupById to resolve the SDK IDs.
        _ = ControlType.Button;
        var name = ControlType.LookupById(id)?.ProgrammaticName;
        return name is not null && name.StartsWith("ControlType.", StringComparison.Ordinal) ? name[12..] : "Unknown";
    }

    private sealed unsafe class UiaCache : IDisposable
    {
        private nint automation;
        private nint tree;
        private nint point;
        private nint root;

        public UiaCache(bool observation)
        {
            var clsid = new Guid("e22ad333-b25f-460c-83d0-0581107395c9");
            var iid = new Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee");
            Check(CoCreateInstance(in clsid, 0, 1, in iid, out automation));
            try
            {
                root = NewRequest([AutomationElement.ProcessIdProperty, AutomationElement.BoundingRectangleProperty], false);
                if (observation)
                    tree = NewRequest(IdentityProperties.Concat(PatternProperties).Append(AutomationElement.HasKeyboardFocusProperty), true);
                else point = NewRequest(IdentityProperties, false);
            }
            catch { Dispose(); throw; }
        }

        private nint NewRequest(IEnumerable<AutomationProperty> properties, bool descendants)
        {
            nint request = 0, filter = 0;
            try
            {
                Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Slot(automation, 20))(automation, &request)); // CreateCacheRequest
                if (descendants)
                {
                    Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Slot(automation, 18))(automation, &filter)); // ControlView
                    Check(((delegate* unmanaged[Stdcall]<nint, nint, int>)Slot(request, 9))(request, filter)); // TreeFilter
                    Check(((delegate* unmanaged[Stdcall]<nint, int, int>)Slot(request, 7))(request, 5)); // Element | Descendants
                }
                Check(((delegate* unmanaged[Stdcall]<nint, int, int>)Slot(request, 11))(request, 0)); // AutomationElementMode_None
                foreach (var property in properties)
                    Check(((delegate* unmanaged[Stdcall]<nint, int, int>)Slot(request, 3))(request, property.Id)); // AddProperty
                return request;
            }
            catch { Release(request); throw; }
            finally { Release(filter); }
        }

        public UiaNode Tree(nint hwnd) => FromHandle(hwnd, tree);
        public UiaNode Root(nint hwnd) => FromHandle(hwnd, root);

        private UiaNode FromHandle(nint hwnd, nint request)
        {
            nint result = 0;
            Check(((delegate* unmanaged[Stdcall]<nint, nint, nint, nint*, int>)Slot(automation, 10))(automation, hwnd, request, &result));
            return new UiaNode(result);
        }

        public UiaNode At(int x, int y)
        {
            nint result = 0;
            Check(((delegate* unmanaged[Stdcall]<nint, Point, nint, nint*, int>)Slot(automation, 11))(automation, new Point { X = x, Y = y }, point, &result));
            return new UiaNode(result);
        }

        public void Dispose()
        {
            Release(root); Release(point); Release(tree); Release(automation);
            root = point = tree = automation = 0;
        }
    }

    private sealed unsafe class UiaNode(nint pointer) : IDisposable
    {
        private nint value = pointer != 0 ? pointer : throw new COMException("UI Automation returned no element.");

        public Rect Bounds()
        {
            var result = new Rect();
            Check(((delegate* unmanaged[Stdcall]<nint, Rect*, int>)Slot(value, 75))(value, &result)); // CachedBoundingRectangle
            return result;
        }

        public int Number(AutomationProperty property, int fallback = 0) =>
            Property(property) is int result ? result : fallback;

        public bool Flag(AutomationProperty property) => Property(property) is true;
        public string Text(AutomationProperty property) => Property(property) as string ?? "";
        public int[] RuntimeId() => Property(AutomationElement.RuntimeIdProperty) as int[]
            ?? throw new COMException("UI Automation returned no runtime ID.");

        public object? Property(AutomationProperty property)
        {
            Variant data = default;
            try
            {
                Check(((delegate* unmanaged[Stdcall]<nint, int, int, Variant*, int>)Slot(value, 13))(value, property.Id, 1, &data));
                return data.Type switch
                {
                    3 => unchecked((int)data.Data),
                    8 => data.Data == 0 ? "" : Marshal.PtrToStringBSTR(data.Data),
                    11 => unchecked((short)data.Data) != 0,
                    0x2003 => Integers(data.Data),
                    _ => null
                };
            }
            finally { VariantClear(&data); }
        }

        public void Children(Action<UiaNode> visit)
        {
            nint array = 0;
            Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Slot(value, 19))(value, &array));
            if (array == 0) return;
            try
            {
                int count = 0;
                Check(((delegate* unmanaged[Stdcall]<nint, int*, int>)Slot(array, 3))(array, &count));
                for (int i = 0; i < count; i++)
                {
                    nint child = 0;
                    Check(((delegate* unmanaged[Stdcall]<nint, int, nint*, int>)Slot(array, 4))(array, i, &child));
                    using var node = new UiaNode(child);
                    visit(node);
                }
            }
            finally { Release(array); }
        }

        public void Dispose() { Release(value); value = 0; }
    }

    private static unsafe int[] Integers(nint array)
    {
        if (array == 0 || SafeArrayGetDim(array) != 1) throw new COMException("Invalid UIA runtime ID.");
        Check(SafeArrayGetLBound(array, 1, out var low));
        Check(SafeArrayGetUBound(array, 1, out var high));
        var count = (long)high - low + 1;
        if (count is < 1 or > 256) throw new COMException("Invalid UIA runtime ID length.");
        Check(SafeArrayAccessData(array, out var data));
        try { var result = new int[(int)count]; Marshal.Copy(data, result, 0, result.Length); return result; }
        finally { SafeArrayUnaccessData(array); }
    }

    private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    private static unsafe nint Slot(nint instance, int index) => (*(nint**)instance)[index];
    private static unsafe void Release(nint instance)
    {
        if (instance != 0) ((delegate* unmanaged[Stdcall]<nint, uint>)Slot(instance, 2))(instance);
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct Variant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public nint Data;
    }

    [DllImport("ole32.dll")] private static extern int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out nint result);
    [DllImport("oleaut32.dll")] private static extern unsafe int VariantClear(Variant* data);
    [DllImport("oleaut32.dll")] private static extern uint SafeArrayGetDim(nint array);
    [DllImport("oleaut32.dll")] private static extern int SafeArrayGetLBound(nint array, uint dimension, out int bound);
    [DllImport("oleaut32.dll")] private static extern int SafeArrayGetUBound(nint array, uint dimension, out int bound);
    [DllImport("oleaut32.dll")] private static extern int SafeArrayAccessData(nint array, out nint data);
    [DllImport("oleaut32.dll")] private static extern int SafeArrayUnaccessData(nint array);
}
