# Native pointer input

The source-owned bridge has bounded internal click and wheel commands. This
foundation alone adds no public actions. Item 11 integration adds optional click
`button: 'left' | 'right' | 'middle'` and `count: 1 | 2` for point/element targets.
Omitted fields preserve the legacy single-left paths; count 2 is left-only. Other
combinations reject before observation consumption. Right/middle/double require
the native supervisor, without an unsupervised fallback. A single observation
authorizes the entire sequence, not two separate actions. Element variants use
the freshly revalidated element center inside the observed image crop.
Discover connected schemas and optional `support.actions.click.variants`; older
servers reject the fields, and adapters must not invent them for legacy servers.
Public point/horizontal wheel remains a separate item 12 integration. Existing default binaries need rebuilding
after helper source changes; source presence alone does not update installed tools.

The new internal path uses exact physical screen coordinates, HWND/PID, foreground,
enabled/restored state and a fresh native hit-window check. Cursor positioning is
checked before one `SendInput` insertion. Clicks permit left/right/middle single
clicks and left double-click as one four-event operation. Wheel uses bounded
120-unit X/Y deltas, positive right/down; combined input sends Y then X. A partial
sequence remains uncertain, without replay. Human activity is not isolated.

Supervisor admission validates target/gesture arguments, persists the selected
button (VK 1/2/4), and retains the existing suspended-child Job Object and recovery
lifecycle. Only confirmed child exit precedes balancing declared input; failed
release keeps quarantine. New integrations must require this supervised route;
the legacy left-only emergency fallback is not a right/middle recovery path.
The existing private controlled provider can hold the explicitly selected button
for bounded cancellation/exit/release acceptance; it remains outside public tools.

Compiled selftests check event flags/order/units, invalid plans, exact button
declarations and injected release success/failure with no OS input. Actual menu,
middle/double-click and two-pane wheel effects plus interruption acceptance remain
separate live checks. Unchanged historical acceptance is retained at its scope.

API semantics follow Microsoft's [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
and [MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput).

## Scoped live checkpoint — 31 October 2026

After preserving two zero-input discovery blocks, direct owner approval preceded
a corrected visible-fixture attempt at cumulative source
`c61da3aeaecb996857de983e32b0d1b9fe2ed83e` (including item 12). Right-menu,
middle and left double-click point effects passed with independent app state;
the double-click produced two downs/ups and one double event. Controlled held
right/middle cancellation retained unknown delivery, with confirmed child exit,
declared release, independent all-up checks and a distinct fresh followup each.
Session, owner, marker and fixture cleanup passed; desktop ownership is released.

Menu visibility is independently recorded by the app; the root PNG omits its popup.
Element variants remain at focused synthetic scope. This is not all failure cells
or interrupted-double acceptance. The final cumulative source and detailed wheel/
cleanup evidence are in [item 12 PR 70](https://github.com/mogesjohnson/trace-workbench/pull/70).
The saved private success receipt SHA-256 is
`8c2cfeaafe9993ef0cc9e90d93755da1db3371d54881cb19610980fa09d237e3`.
