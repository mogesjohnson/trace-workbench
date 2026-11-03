# Native pointer foundation

The source-owned bridge has bounded internal click and wheel commands. This
foundation does not yet add public MCP action fields or new live acceptance.
The public wrapper still uses the existing pinned engine paths until the separate
item 11/12 integrations are present. Existing default binaries need rebuilding
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
