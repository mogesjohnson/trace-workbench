# TRACE specification

Status reviewed 19 October 2026. This is the acceptance baseline for the first usable release; the package currently identifies the implementation as `0.1.0-alpha.3`. The version identifies a preview; it does not mark every milestone case complete.

Before continuing implementation or acceptance, read the [owner-approved normal-desktop v0.1 plan](docs/V0.1-PLAN.md) and [agent handoff](agent-scratchpad.md). Implementation is currently on hold. The owner selected the current account, a synthetic REPLAY demo, and the tested single-monitor configuration; broader display acceptance is deferred beyond v0.1 without changing historical evidence.

## Product and scope

TRACE gives AI agents executable capabilities through a shared local MCP interface and accompanying skill instructions. The first two selected skills are **Reverse Engineer Anything** and **Computer Use**, in that order. TRACE remains the product name.

The initial delivery targets Windows x64 and the Codex, Claude Code, Grok Build, and Gemini CLI hosts. Each host supplies its reasoning model and permission controls. TRACE supplies the operations and evidence; equivalent model behavior is not assumed.

## Agent completion contract

- **Plan:** select a milestone and requirement IDs. Before each acceptance case, declare the target, initial state, exact actions, expected result/error and cleanup. Keep separate results for each action, failure mode and environment.
- **Prove:** retain a sanitized receipt with case ID, tested source commit, runtime/display configuration, expected/actual result, status (`pass`, `fail`, `blocked`, `not_run`) and artifact paths/hashes. A live case needs MCP evidence plus independently checked target state; input delivery alone is insufficient.
- **Bound retries:** allow one corrective live-test retry after recording a changed precondition or code fix and taking a fresh observation. A second failure ends that case. Missing hardware, credentials or providers produce `blocked` with the exact prerequisite; continue independent cases.
- **Resolve uncertainty:** stop input on unknown delivery, ambiguous target/ownership or quarantine. Re-observe and verify targeting/cleanup: a proven intended result with safe input permits continuing without replay; proven non-delivery with safe input permits one bounded retry. Unresolved delivery/cleanup stays `blocked`; restarting a server does not prove recovery.
- **Finish:** every required case must be `pass` before marking its milestone complete. Preserve failures/skips and their reasons. Reuse passing evidence from the same relevant code/environment; rerun only cases affected by changes. End with completed IDs, unresolved IDs and the next required action.
- **Guard evidence:** record actual current state, not requested coordinates, a maximum-ever counter or input delivery. Keep running checkpoints distinct from completed results. A native primitive is not an end-to-end MCP recovery test; preserve failing attempts when a fix is tested.

## Acceptance requirements

| ID | Done when | Current evidence / remaining work |
| --- | --- | --- |
| ANA-01 | The pinned analysis skill and server are installed, diagnostics report available providers honestly, and a static artifact analysis returns evidence without modifying the target. | Verified for built-in static analysis in [alpha.1](docs/VERIFICATION.md#analysis-foundation). Optional native providers remain untested. |
| CFG-01 | All four CLI registrations preserve unrelated settings, retain exact backups, and discover matching instructions. Reapplying is idempotent; conflicting entries are preserved. | Four registrations and three matching Computer Use skill copies verified in the [installation receipt](evidence/0.1.0-alpha.2/installation.json). |
| CU-01 | Agents select an exact returned window, receive PNG pixels plus accessibility data, and use coordinates that match those pixels. Changed identity or ambiguous capture geometry fails before input. | Implemented; owned-fixture and regression evidence. Capture accounts for invisible Windows borders. Requires a readable UIA root today. |
| CU-02 | Each action uses the latest single-use observation, expires after 60 seconds, and returns fresh state. Failed or uncertain input is not retried automatically. | Implemented; stale observation rejection and refreshed frames verified. A delivered input is not treated as proof that the user's goal succeeded. |
| CU-03 | Activation, clicks, literal typing, key chords, vertical scrolling, dragging, invocation, and editable values work through MCP with visible outcome checks. | Exact key/selection, bidirectional scroll and drag/drop checks passed in the retained review attempts. [Review status](evidence/0.1.0-alpha.3/review-checks.json) distinguishes those passes from incomplete whole-run acceptance. |
| CU-04 | One controller owns desktop input across processes and artifact directories. Cancellation/timeout stop owned native work, balance input and report uncertainty. Disconnect/crash release desktop ownership. Uncertain actions require re-observation. | Ownership/handoff and unit cleanup checks exist. The held-drag test exercises a native cancellation/release primitive, not an MCP action cancellation. Live MCP cancellation, timeout, disconnect, crash and failed-cleanup acceptance remain pending. |
| HOST-01 | Real agents can discover both selected skills, receive images/evidence, operate an owned target and recover from a failed action. | Four client configurations exist. Codex Computer Use diagnostics were called through its connected MCP tool; a full agent workflow remains. Initial live acceptance targets Codex and Claude. Grok/Gemini live runs are optional under the owner's earlier testing preference and must be labeled unverified until performed. |
| APP-01 | A workflow in a real target app, including REPLAY, demonstrates correct targeting, editing/control and a verified result without relying on fixture-only behavior. | Pending. The earlier Calculator demonstration used the reference executor; it is not evidence of TRACE controlling REPLAY. |
| REL-01 | Source, versions, setup instructions, licenses, evidence and spec agree; local checks and required hosted CI pass; reviewed PRs are merged before a versioned release is tagged. | Local checks and scoped fixture evidence are recorded in [verification](docs/VERIFICATION.md). Hosted CI and remaining acceptance gate release; no alpha.3 release is published. |

## Delivery sequence

- `0.1.0-alpha.1`: analysis foundation and reference workflow evidence merged; unreleased.
- `0.1.0-alpha.2`: Computer Use MCP, pinned engine, setup preservation, fixture evidence and spec merged; unreleased.

### `0.1.0-alpha.3` — native input and window acceptance (pending)

The reviewed preview keeps original evidence and both failed complete-case attempts. A focused [native/MCP guard regression](evidence/0.1.0-alpha.3/modal-guard/receipt.json) passes; it does not complete the modal workflow or the milestone. Follow the [case status](evidence/0.1.0-alpha.3/review-checks.json) before rerunning work.

- **A3-INPUT / CU-03:** owned-fixture cases for a key chord, vertical wheel in both directions and dragging. Assert exact resulting text/selection, scroll position and drag endpoint/drop count against predeclared values; retain before/after frames and fixture state.
- **A3-RECOVERY / CU-04:** interrupt real native input through cancellation and timeout; exercise disconnect and server crash. Prove owned-process exit, released input and lease handoff. Failed cleanup must report uncertainty, block further input and retain recovery evidence.
- **A3-DIALOG / CU-01:** open a real modal dialog; verify native parent-disabled state and pre-input `window_blocked` rejection for parent clicks, invocation and values, even if UIA children appear enabled. Select/observe the dialog explicitly, complete or dismiss it and recover the parent session. A modeless child does not pass.
- **A3-WINDOW / CU-01, CU-02:** move, minimize and restore the target between observation and action. Stale geometry must reject input; a fresh capture must restore valid bounds and hit the intended control once.
- **A3-DISPLAY / CU-01 — deferred beyond v0.1 by the owner on 19 October 2026:** test two DPI scales and a monitor transition before claiming broader display support. Record scale/topology, PNG dimensions and physical bounds; verify coordinate hits after each transition. Historical blocked results remain intact. The v0.1 gate covers the actual single-monitor configuration named in its acceptance receipts.

### `0.1.0-alpha.4` — host and real-app acceptance (pending)

- **A4-HOST / HOST-01:** separate Codex and Claude receipts show both skills discovered, actual image/evidence inspection, an owned-target task with an exact final state, recovery from a failed action and session cleanup. Other host live runs remain optional and labeled unverified.
- **A4-REPLAY / APP-01:** define the requested target/profile, all effects and expected saved result before execution. Resolve truncated-tree targeting before retrying a miss. Record only the owned window; verify creation, requested privacy effects and playback in the final cut. Retain the trace and resulting artifact; tool delivery, decoding or HTTP success alone cannot pass.
- **A4-INSTALL / CFG-01:** from a clean Windows environment and pinned commit, use documented setup, pass diagnostics and a smoke task, verify unrelated configuration preservation, then restore backups and verify rollback. Publish missing-prerequisite and recovery steps.

### `0.1.0` — release acceptance (pending)

- **V1-ACCEPT / REL-01:** publish a requirement-to-receipt checklist for every acceptance row and required milestone case. Resolve all `fail`, `blocked` and `not_run` entries; retain explicitly optional limits. Required hosted CI must pass; account/billing blocks keep release pending.
- **V1-RELEASE / REL-01:** merge reviewed work within the [PR limits](VERSION_CONTROL.md), align package/lockfile/tag versions, and publish artifacts with SHA-256 checksums and reproducible build/install commands. Verify those artifacts before publishing the GitHub release.

## Current operating limits

- Windows x64, a supported Node.js runtime, .NET 9 SDK for building the bridge, and .NET 9 runtime for executing it.
- Physical input uses an unlocked interactive desktop. Secure/elevated desktop automation is outside the initial release scope.
- Screenshots must match exact DWM/window geometry and remain within the 6 MiB image limit. Accessibility inspection currently has a bounded tree depth.
- Vertical wheel input uses 120-unit notches at an observed element's center; horizontal wheel input is unsupported.
- The desktop lease coordinates TRACE processes for one OS user. It cannot prevent human input or unrelated automation from interfering; target/focus checks remain necessary.
- Journals record action metadata and artifact references. They do not implement durable task resume or undo external service changes.
- Local input uses the active interactive desktop; another user account or Task View desktop is not a verified background mode. An isolated VM/remote worker remains proposed and needs proof that host input/focus remain untouched.

## Future skills

Browser operation/debugging, screenshot understanding, voice/listening, recorded-demo production, document intelligence and recoverable parallel workers remain **under review** in [SKILLS.md](SKILLS.md) and [the research list](docs/CAPABILITIES.md). They are not requirements for this release.

## Source of truth

Use this file for scope and acceptance, [Computer Use setup](docs/COMPUTER_USE.md) for operation, and [verification](docs/VERIFICATION.md) for observed results. Keep future review separate from selected scope. A configured client, a direct protocol test, a live agent workflow and a published release are distinct states.
