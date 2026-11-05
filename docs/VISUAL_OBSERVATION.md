# UIA-independent screenshot observations — item 15

`trace_computer_observe` with `mode: "screenshot"` now uses exact native lifetime
and DWM geometry checks plus [PrintWindow capture](NATIVE_VISUAL_CAPTURE.md).
Session opening validates native identity without inspecting a UIA root. Screenshot
observations perform no UIA status, inspection, focus query, selector lookup or
provider screenshot call. No composite or screen-pixel fallback is attempted.

The returned PNG is the physical DWM frame, with `captureMethod` identifying
PrintWindow and `focused.available: false` / `code: "visual_only"`. Missing UIA
is not interpreted as an empty accessible document. Screenshot output omits
elements/accessibility and remains `actionable: false`; a valid request revokes
old input authority even on failure. Full observation is still required before
any input and retains its readable-root, geometry, focus and action checks.

Tool and mode names remain unchanged. Doctor adds
`observationModes.screenshotRequiresReadableUiaRoot: false`; the legacy support
descriptor's readable-root requirement continues to describe full input evidence.
Minimized screenshot observations can restore the exact target under supervision.
Noncooperating apps can fail or return incomplete rendered content; this does not
promise universal GPU/protected-app capture or semantic pixel correctness.

Focused native/backend/controller/MCP checks are separate from the owned live
no-UIA fixture gate. No old input, clipboard or host acceptance is repeated.
