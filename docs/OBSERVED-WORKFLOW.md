# Observed computer workflow

Recorded 18 October 2026. One driver used the installed Computer Use skill against Windows Calculator. Root and an independent observer reviewed the returned trace and screenshots. REA performed separate static-analysis tests; it did not capture these desktop actions.

## Demonstration

The driver selected one Calculator window and entered **12 × 3 = 36** with five clicks. Six retained frames show `0 → 1 → 12 → 12× → 3 → 36`.

- [Trace](../evidence/0.1.0-alpha.1/computer-use/trace.jsonl): 22 records.
- [Summary](../evidence/0.1.0-alpha.1/computer-use/summary.json): root review and result.
- [Independent review](../evidence/0.1.0-alpha.1/computer-use/independent-review.json): all six frames, hashes, ordering, and limits.

## Requirements supported by the demonstration

1. Discover and select a specific returned window before input.
2. Verify captured pixels belong to that target. The initial capture was wrong; the driver issued no input, activated the selected window, and observed again. The unrelated image was withdrawn.
3. Bind each action to the latest verified observation. Perform one action, then refresh before deciding the next action.
4. Support screenshot-coordinate fallback explicitly. Accessibility returned `null` throughout this run; indexed UIA control was not demonstrated.
5. Scope frame IDs by session, window, and observation. The returned screenshot ID repeated across observations.
6. Preserve operation duration separately from record emission time. Measured clicks took 109–159 ms; five measured retained captures took 3,081–3,103 ms. One capture duration was unavailable. These timings do not establish the cause of capture latency.

## Remaining coverage

Typing, keyboard chords, scrolling, dragging, editable values, dialogs, competing controllers, and cross-client operation remain untested. No private helper protocol or implementation was recovered. The trace is driver-authored evidence of documented calls and visible outcomes, with independent artifact review.

This is a starting specification for a future shared Windows executor. TRACE's current version supplies the analysis setup and evidence, not that executor.
