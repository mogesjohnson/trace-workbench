using System.Windows.Automation;
using Microsoft.Windows.SDK.BuildTools.WinApp.UIAutomation;

internal static partial class Program
{
    private static readonly AutomationProperty[] IdentityProperties =
    [
        AutomationElement.NameProperty, AutomationElement.AutomationIdProperty, AutomationElement.ClassNameProperty,
        AutomationElement.ControlTypeProperty, AutomationElement.ProcessIdProperty, AutomationElement.IsEnabledProperty,
        AutomationElement.IsOffscreenProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.RuntimeIdProperty
    ];
    private static readonly AutomationProperty[] PatternProperties =
    [
        AutomationElement.IsPasswordProperty, TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
        ValuePattern.ValueProperty, AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty
    ];

    private static UiElement[] ReadCachedTree(UiaCache cache, nint hwnd, uint pid, int depth,
        Dictionary<string, int[]> runtimeIds, out UiElement? focused)
    {
        var rows = new List<UiElement>();
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        UiElement? focus = null;
        using var root = cache.Tree(hwnd);
        int scanned = 0;
        root.Children(node => Count(node, 1));
        Walk(root, 0);
        focused = focus;
        return rows.ToArray();

        void Count(UiaNode node, int level)
        {
            if (++scanned > 10000 || level > 64) throw new BridgeException("worker_read_failed", "The UIA identity search exceeded its bound.");
            var id = node.Text(AutomationElement.AutomationIdProperty);
            if (!string.IsNullOrEmpty(id)) counts[id] = counts.GetValueOrDefault(id) + 1;
            node.Children(child => Count(child, level + 1));
        }

        void Walk(UiaNode node, int level)
        {
            if (rows.Count >= 10000 || node.Number(AutomationElement.ProcessIdProperty) != pid)
                throw new BridgeException("worker_read_failed", "The UIA tree exceeded its scope.");
            var automationId = node.Text(AutomationElement.AutomationIdProperty);
            var name = node.Text(AutomationElement.NameProperty);
            var id = automationId;
            var rect = node.Bounds();
            var type = UiaControlName(node.Number(AutomationElement.ControlTypeProperty));
            var runtime = node.RuntimeId();
            if (string.IsNullOrEmpty(id) || counts.GetValueOrDefault(id) != 1 || level == 0)
                id = WorkerSlug(type, automationId, name, runtime);
            if (!runtimeIds.TryAdd(id, runtime))
                throw new BridgeException("worker_read_failed", "The tree has duplicate control selectors.");
            var toggle = node.Number(TogglePattern.ToggleStateProperty, -1);
            var expand = node.Number(ExpandCollapsePattern.ExpandCollapseStateProperty, -1);
            var value = node.Property(AutomationElement.IsPasswordProperty) is false
                ? node.Property(ValuePattern.ValueProperty) as string : null;
            var item = new UiElement
            {
                Selector = id, AutomationId = automationId, ClassName = node.Text(AutomationElement.ClassNameProperty), Name = name,
                Type = type, IsEnabled = node.Flag(AutomationElement.IsEnabledProperty), IsOffscreen = node.Flag(AutomationElement.IsOffscreenProperty),
                X = rect.Left, Y = rect.Top, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top,
                Value = value, Depth = level, WindowHandle = hwnd,
                IsInvokable = node.Flag(AutomationElement.IsInvokePatternAvailableProperty)
                    || node.Flag(AutomationElement.IsSelectionItemPatternAvailableProperty),
                ToggleState = toggle switch { 0 => "off", 1 => "on", 2 => "indeterminate", _ => null },
                ExpandState = expand switch { 0 => "collapsed", 1 => "expanded", 2 => "expanded", _ => null }
            };
            rows.Add(item);
            if (node.Flag(AutomationElement.HasKeyboardFocusProperty)) focus = item;
            node.Children(child =>
            {
                if (level == depth) item.HasMoreChildren = true;
                else Walk(child, level + 1);
            });
        }
    }

    // Match the pinned winapp 0.7.1 SlugGenerator format for actions delegated to the CLI.
    // Format and hash derived from Microsoft winappCli (MIT), Services/SlugGenerator.cs.
    private static string WorkerSlug(string type, string automationId, string name, int[] runtimeId)
    {
        var prefix = type switch
        {
            "Button" => "btn", "Edit" or "TextBox" => "txt", "CheckBox" => "chk", "ComboBox" => "cmb",
            "ListItem" => "itm", "TabItem" => "tab", "Tab" => "tab", "Image" => "img", "Text" or "TextBlock" => "lbl",
            "Pane" => "pn", "Window" => "win", "Group" => "grp", "Hyperlink" => "lnk", "MenuItem" or "Menu" => "mnu",
            "MenuBar" => "mnb", "List" => "lst", "Tree" => "tre", "TreeItem" => "tri", "DataGrid" => "grd", "DataItem" => "dat",
            "RadioButton" => "rdo", "Slider" => "sld", "ProgressBar" => "prg", "ScrollBar" => "scr", "ToolBar" => "tlb",
            "StatusBar" => "stb", "TitleBar" => "ttl", "SplitButton" => "spl", "Separator" => "sep", "Document" => "doc",
            "Header" => "hdr", "HeaderItem" => "hdi", "ToolTip" => "tip", "Thumb" => "thm", "Table" => "tbl", _ => "elm"
        };
        static string Normalize(string value) => new(value.ToLowerInvariant().Where(char.IsAsciiLetterOrDigit).Take(15).ToArray());
        var slug = Normalize(automationId);
        if (slug.Length == 0) slug = Normalize(name);
        var hash = 17;
        foreach (var number in runtimeId) hash = unchecked(hash * 31 + number);
        return slug.Length == 0 ? $"{prefix}-{(hash & 0xffff):x4}" : $"{prefix}-{slug}-{(hash & 0xffff):x4}";
    }
}
