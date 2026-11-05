# Item 19 PR B live check: related windows (5 November 2026)

Source `0ebc32ffd5a3747927fee3f66251a9370b28f2b1` on `feat/v9-related-windows`, on the owner's
current display (144 DPI, per-monitor). The owner gave the desktop slot and approved this setup:

- winapp 0.7.1 from the main checkout's `.runtime`, verified against the pin;
- the PR B window bridge built from this source in a scratch folder (SHA-256 in `receipt.json`);
- no native supervisor and no activity indicator.

The target was a scratch WinForms test window (per-monitor V2) that opens its own menus and tooltip
from a command file and logs any pointer input that reaches it. TRACE ran in process through the
real controller and MCP server. No other window was targeted.

## Result (`receipt.json`)

| Step | Related windows reported | Popup PNGs |
|---|---|---|
| Base | none | — |
| WinForms menu open | `owned` `menu`, covers the window | yes |
| Submenu open | submenu at z-order 0, menu at 1, both `owned` | yes, 2 |
| Tooltip, screenshot mode | `same-thread-popup` `tooltip`, UIA name is its text | yes |
| Win32 `#32768` menu | `thread-menu` `menu`, `menuMode.active: true` | yes |
| All closed | none | — |

A left click at the menu-covered point (152, 183) was refused with `target_occluded` and
`not_dispatched` after TRACE's activation. `bridgeTrace` shows the `hit` reply naming the menu window
with `related: true`. The test window logged no input, and the next observation still showed the menu.

`strip-root-window.png` is the window image taken while the menu was open. It omits the menu, which
`strip-menu.png` shows. `tooltip.png` and `win32-menu.png` are the other popup images.

## First attempt (`first-attempt.json`)

The first run, from the same source, opened the WinForms menu right after closing the Win32 menu. By
the time of the click the menu had closed, so the click went to the window beneath, which the
observation had also authorized. The next observation showed no popups. That run did not record the
guard's reply, so it doesn't say exactly when the menu closed. After that, a run with no input showed
that each act preparation step leaves the menu open and that the guard refuses. The test window then
logged its menu close reasons, and the click step was moved first.

## Limits

- The test window is WinForms. XAML (for example Notepad), Chromium, other-process popups,
  mixed DPI and real hover tooltips were not checked.
- The guard checks at dispatch time. A popup that closes before then no longer blocks the point.
  One that opens after the check, before winapp sends input, is not caught.
- An element click is checked at the element centre; winapp may press another point inside it.
- Only popups of the window's own thread or owner chain are refused. Another application's window
  over the point is left to activation, as before this change.

`INVENTORY.md` is the read-only popup inventory taken before the design.
