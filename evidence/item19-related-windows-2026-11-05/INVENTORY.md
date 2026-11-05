# Item 19 PR B: live popup inventory, 5 November 2026 (02:29 UTC)

Setup: the owner's current display at 144 DPI (per-monitor). Scratch WinForms test window
(PerMonitorV2, pid 28836, root HWND 330198) opened its own popups from a command file.
No SendInput, no messages to other processes. Probe: EnumWindows z-order (top first),
GW_OWNER, GA_ROOTOWNER, class, styles, DWM frame and cloak, GetDpiForWindow and awareness,
GetGUIThreadInfo, a 1.5 s bounded UIA FromHandle read, and PrintWindow(PW_RENDERFULLCONTENT).

| Popup | Class | GW_OWNER | Link that works | z vs root | Styles | UIA | Own PNG |
|---|---|---|---|---|---|---|---|
| WinForms ContextMenuStrip | WindowsForms10.Window.20808... | root | owner | above (topmost) | popup, topmost | Menu | yes, 200x100 |
| Its submenu | same | root (not the parent strip) | owner | above the parent strip | popup, topmost | Menu "Strip submenu" | yes |
| WinForms ToolTip | ...tooltips_class32... | none | same pid and thread only | above (topmost) | popup, topmost, toolwindow, layered | ToolTip, name = text | yes, 180x30 |
| Win32 TrackPopupMenuEx | #32768 | none | GUI thread: in-menu + popup-menu mode, menuOwner = root, capture = root | above (topmost) | popup, topmost, toolwindow | Menu "Menu" | yes, 257x76 |
| Drop shadows | SysShadow | none | same pid only | just below each popup | layered, transparent | Pane | yes (noise) |

Findings
1. The root PrintWindow PNG omits every popup (confirmed again).
2. Ownership alone misses tooltips and native menus. Discovery needs three links: GW_OWNER
   chain to the root, the GUI-thread menu owner, and same process and thread.
3. Each popup has exact physical bounds and its own PrintWindow image.
4. SysShadow windows are separate, unowned, layered and transparent; they should be dropped.
5. All popups were topmost and above the root. Foreground stayed on the root.
6. Popup DPI matched the root (144, per-monitor) on this single display.
7. After popups closed, no residue windows remained.
8. The bridge rejects a pointer point covered by a popup with target_occluded (the hit
   window's GA_ROOT is the popup), so today a visible popup never receives TRACE input.

Not covered: XAML (Notepad) or Chromium popups, cross-process popups, mixed DPI, popups
that extend past the root or the monitor, and tooltips shown by real hover.
