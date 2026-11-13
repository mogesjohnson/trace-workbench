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

    private static UiElement[] ReadCachedTree(nint hwnd, uint pid, int depth, Dictionary<string, int[]> runtimeIds)
    {
        var request = new CacheRequest { TreeScope = TreeScope.Element | TreeScope.Descendants, TreeFilter = Automation.ControlViewCondition,
            AutomationElementMode = AutomationElementMode.None };
        foreach (var property in IdentityProperties.Concat(PatternProperties)) request.Add(property);
        var rows = new List<UiElement>();
        Dictionary<string, int> counts = new(StringComparer.Ordinal);
        AutomationElement root;
        using (request.Activate())
            root = AutomationElement.FromHandle(hwnd);
        var pending = new Stack<AutomationElement>();
        foreach (AutomationElement child in root.CachedChildren) pending.Push(child);
        int scanned = 0;
        while (pending.TryPop(out var node))
        {
            if (++scanned > 10000) throw new BridgeException("worker_read_failed", "The UIA identity search exceeded its bound.");
            var id = node.Cached.AutomationId;
            if (!string.IsNullOrEmpty(id)) counts[id] = counts.GetValueOrDefault(id) + 1;
            foreach (AutomationElement child in node.CachedChildren) pending.Push(child);
        }
        Walk(root, 0);
        return rows.ToArray();

        void Walk(AutomationElement node, int level)
        {
            if (rows.Count >= 10000 || node.Cached.ProcessId != pid)
                throw new BridgeException("worker_read_failed", "The UIA tree exceeded its scope.");
            var cached = node.Cached;
            var id = cached.AutomationId;
            var rect = cached.BoundingRectangle;
            var type = cached.ControlType.ProgrammaticName;
            type = type.StartsWith("ControlType.", StringComparison.Ordinal) ? type[12..] : type;
            var runtime = (int[])node.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty);
            if (string.IsNullOrEmpty(id) || counts.GetValueOrDefault(id) != 1 || level == 0)
                id = WorkerSlug(type, cached.AutomationId, cached.Name, runtime);
            if (!runtimeIds.TryAdd(id, runtime))
                throw new BridgeException("worker_read_failed", "The tree has duplicate control selectors.");
            var toggle = node.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true);
            var expand = node.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty, true);
            var value = node.GetCachedPropertyValue(AutomationElement.IsPasswordProperty, true) is false
                ? node.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string : null;
            var item = new UiElement
            {
                Selector = id, AutomationId = cached.AutomationId, ClassName = cached.ClassName, Name = cached.Name,
                Type = type, IsEnabled = cached.IsEnabled, IsOffscreen = cached.IsOffscreen,
                X = rect.IsEmpty ? 0 : rect.X, Y = rect.IsEmpty ? 0 : rect.Y, Width = rect.IsEmpty ? 0 : rect.Width, Height = rect.IsEmpty ? 0 : rect.Height,
                Value = value, Depth = level, WindowHandle = hwnd,
                IsInvokable = node.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty, true) is true
                    || node.GetCachedPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty, true) is true,
                ToggleState = toggle is ToggleState state ? state.ToString().ToLowerInvariant() : null,
                ExpandState = expand is ExpandCollapseState.Collapsed ? "collapsed" : expand is ExpandCollapseState.Expanded ? "expanded" : null
            };
            rows.Add(item);
            var children = node.CachedChildren;
            if (level == depth) { item.HasMoreChildren = children.Count > 0; return; }
            foreach (AutomationElement child in children) Walk(child, level + 1);
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
