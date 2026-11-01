# Observed secondary accessibility actions — item 17

Full/accessibility observations add each control's `secondaryActions` array.
An enabled directly observed ExpandCollapse state offers `expand` while collapsed
or `collapse` while expanded. A directly observed Toggle state offers `toggle`.
Disabled, unknown, leaf or unreported patterns offer no action. Labels and the
provider's generic `isInvokable` flag never establish a specific pattern.
Recognized `expandState`/`toggleState` values are returned for effect verification;
an available action list alone does not prove the requested state changed.

Use `trace_computer_act` with the latest full observation and
`{type: "accessibility_action", elementId: "<observed ID>", action: "expand"}`.
The strict vocabulary is `expand`, `collapse`, `toggle`. The action must appear
on exactly one enabled captured control and remain available on fresh inspection.
Automation ID/class, existing type/name/bounds, window lifetime/geometry/modal and
native ownership guards remain. Each action consumes the observation and returns
fresh state. Accessibility-only evidence still cannot authorize input.

Execution uses pinned `invoke --action <name>` on that exact selector, without
pattern/ancestor, mouse or keyboard fallback. A race after admission remains an
unknown result; delivery alone does not verify the requested app effect.
Reinspection is not an atomic application snapshot. Native supervision is required;
the existing invoke mutation declaration covers this UIA operation without a new
native input primitive or helper rebuild. Existing `invoke`/`set_value` stay intact.

Discover optional `support.actions.accessibility_action`. Legacy descriptors remain
compatible and never gain invented support in the method adapter. Unknown schemas,
extra fields and unobserved actions reject. A toggle can cycle a three-state control;
inspect the new state rather than assuming a boolean result.

Selection and ScrollItem are not inferred from generic invocation hints. Directional
UIA scrolling is intentionally absent: the pinned ScrollContainer implementation
can walk to an ancestor, which does not meet this exact-control contract. Existing
wheel/point scrolling remains available under its separate contract.

Provider behavior was checked in the pinned [invoke command](https://github.com/microsoft/winappCli/blob/v0.7.1/src/winapp-CLI/WinApp.Cli/Commands/UiInvokeCommand.cs)
and [UIA service](https://github.com/microsoft/winappCli/blob/v0.7.1/src/winapp-CLI/WinApp.UIAutomation/Services/UiAutomationService.cs).
Focused checks are separate from new owned-fixture live acceptance.
