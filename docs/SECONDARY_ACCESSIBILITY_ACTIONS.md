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
If its state changed since capture, toggle rejects before dispatch rather than
reversing an externally changed value.

Selection and ScrollItem are not inferred from generic invocation hints. Directional
UIA scrolling is intentionally absent: the pinned ScrollContainer implementation
can walk to an ancestor, which does not meet this exact-control contract. Existing
wheel/point scrolling remains available under its separate contract.

Provider behavior was checked in the pinned [invoke command](https://github.com/microsoft/winappCli/blob/v0.7.1/src/winapp-CLI/WinApp.Cli/Commands/UiInvokeCommand.cs)
and [UIA service](https://github.com/microsoft/winappCli/blob/v0.7.1/src/winapp-CLI/WinApp.UIAutomation/Services/UiAutomationService.cs).
Focused checks are separate from new owned-fixture live acceptance.

## Scoped live acceptance — 1 November 2026

Fresh owner readiness preceded this first bounded attempt. Root reviewed the
initial and three post-action PNGs. Independent fixture counters and returned
pattern state confirmed each effect; the duplicate-label decoy stayed unchanged.
No failures/retries or new native binary/input primitive were needed.

```json
{
  "source": "a25e7334c5d969043a8fa5d3d752eee3c8553106",
  "status": "pass",
  "startedAt": "2026-11-01T15:34:53.193Z",
  "finishedAt": "2026-11-01T15:35:56.034Z",
  "privateReceiptSha256": "7ff6936642259abd1ef95f0ea7e65e79413954dad93d1b5def7ca61097689743",
  "privateDriverSha256": "8866b23f0fb4c4fd3b33e8f43df30787aa8ec634962ce4d75f5bbf770f8b856b",
  "fixtureSourceSha256": "c93b96e35e31c7389b4ff85d2ca43ed9de076e476e2961df580f525d9c96bd72",
  "display": {
    "monitors": 1,
    "width": 2880,
    "height": 1800,
    "dpi": 144
  },
  "unobservedCollapse": "not_dispatched; valid authority retained",
  "expand": "collapsed -> expanded; ExpandCollapsePattern",
  "collapse": "expanded -> collapsed; ExpandCollapsePattern",
  "toggle": "off -> on; TogglePattern; decoy remained off",
  "rootReviewedFrames": 4,
  "sourceHelperFixtureHashesMatched": 54,
  "cleanup": {
    "session": "confirmed",
    "connection": "closed",
    "exactOwnerExited": true,
    "exactMarkerExited": true,
    "fixtureExitCode": 0,
    "driverExitCode": 0,
    "inputAllUp": true,
    "recoveryClear": true
  }
}
```

Scope is one owned WPF fixture at the recorded display, not arbitrary UIA providers,
three-state live cycling, scrolling, selection or an interruption matrix. Existing
compatible host/clipboard/mouse/keyboard evidence is reused at its original scope.
Desktop released. No merge/release/default settings or installed skill changes;
item 18 remains outside the owner's selected work.
