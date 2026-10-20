# TRACE specification

Status reviewed 20 October 2026. This is the acceptance baseline for the first usable release; the package identifies the implementation as `0.1.0-alpha.3.1`, an unfinished glow checkpoint. Versions do not mark milestone cases complete.

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
- **Pin display:** before coordinate cases, write one run manifest with the current physical monitor bounds, DPI, topology and capture dimensions. Pin that observed single-monitor mode for the run; a mismatch blocks affected cases until a recorded replan/preflight. Historical 2880×1800 and 1920×1080 receipts both report 144 DPI; their unexplained difference is not display-transition acceptance. Retain mode labels and reuse compatible evidence only.

## Acceptance requirements

| ID | Done when | Current evidence / remaining work |
| --- | --- | --- |
| ANA-01 | The pinned analysis skill and server are installed, diagnostics report available providers honestly, and a static artifact analysis returns evidence without modifying the target. | Verified for built-in static analysis in [alpha.1](docs/VERIFICATION.md#analysis-foundation). Optional native providers remain untested. |
| CFG-01 | All four CLI registrations preserve unrelated settings, retain exact backups, and discover matching instructions. Reapplying is idempotent; conflicting entries are preserved. | Four registrations and three matching Computer Use skill copies verified in the [installation receipt](evidence/0.1.0-alpha.2/installation.json). |
| CU-01 | Agents select an exact returned window, receive PNG pixels plus accessibility data, and use coordinates that match those pixels. Changed identity or ambiguous capture geometry fails before input. | Implemented; owned-fixture and regression evidence. Capture accounts for invisible Windows borders. Requires a readable UIA root today. |
| CU-02 | Each action uses the latest single-use observation, expires after 60 seconds, and returns fresh state. Failed or uncertain input is not retried automatically. | Implemented; stale observation rejection and refreshed frames verified. A delivered input is not treated as proof that the user's goal succeeded. |
| CU-03 | Activation, clicks, literal typing, key chords, vertical scrolling, dragging, invocation, and editable values work through MCP with visible outcome checks. | Exact key/selection, bidirectional scroll and drag/drop checks passed in the retained review attempts. [Review status](evidence/0.1.0-alpha.3/review-checks.json) distinguishes those passes from incomplete whole-run acceptance. |
| CU-04 | One controller owns desktop input across processes and artifact directories. Cancellation, timeout, disconnect, crash and physical stop terminate owned native work, balance declared mouse/keyboard input and retain quarantine until verified recovery. Uncertain delivery requires re-observation. | Current recovery/quarantine is mouse-only and in memory; the bridge exposes left-button release. A keyboard error may report uncertainty without enforcing quarantine. No verified TRACE-owned physical Escape stop exists. Native drag cleanup is not end-to-end MCP recovery; `A32-*` remains pending. |
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

### `0.1.0-alpha.3.1` — visible desktop ownership and glow completion (pending)

- **GLOW-LIFECYCLE / CU-04:** acquire the desktop lease before starting the marker; publish a session only after native readiness. Show a nonactivating, click-through glow on every attached monitor until input/recovery and session cleanup finish. Marker startup failure rejects the session; marker loss stops further input and cancels in-flight work.
- **GLOW-LIVE / CU-01, CU-04:** declare an owned synthetic target, expected edge click count and exact cleanup. Verify visible edges on available monitors, unchanged native foreground/focus on marker start, physical clicks through the edge, and process/overlay removal after EOF and owned parent termination. Retain source hashes, independent target state and sanitized screen evidence. Missing topology changes remain blocked.
- **GLOW-DIAGNOSTICS / CFG-01:** diagnostics verify helper source/output hashes and the .NET 9 Desktop runtime without showing UI; discovery excludes the helper. Existing acceptance remains at its recorded scope.
- **A31-GLOW / CU-04:** preserve both existing attempts. Under the recorded continuation plan, require count 0 initially, 1 after one reference edge click and 2 after one TRACE edge click. Prove visible click-through glow, unchanged focus, ordinary close/EOF cleanup and abrupt owned-parent-loss cleanup, with helper exit verified separately. If the separate Codex/reference executor is unavailable, prepare the continuation and retain that subcase as blocked; a second TRACE click or synthetic substitute cannot pass it.
- **A31-SKILL / CFG-01:** back up existing installations, synchronize the repository Computer Use instructions to the canonical and selected client copies, and retain matching hashes plus discovery checks. Preserve earlier synchronization receipts; later repository edits are not already installed.

### `0.1.0-alpha.3.2` — native supervision and interruption (pending)

- **A32-OWNER / CU-04:** first pass the bounded native feasibility probe in [the plan](docs/V0.1-PLAN.md#input-supervision-and-recovery). A native supervisor owns lease, input children and glow; mutating children enter a Windows Job Object before execution. Verify exclusion across two TRACE processes with different artifact directories, including after Node death. Keep the 15-second operation deadline. An unconfirmed child exit keeps mutation blocked.
- **A32-RECOVERY / CU-04:** declare a separate matrix cell for each of cancellation, timeout, disconnect, Node death and supervisor death against held mouse input, a held modifier chord and interrupted literal typing. Confirm child exit before balancing all declared keys/buttons, independently inspect released state, then permit exactly one clean follow-up action. Exercise the production MCP/controller/supervisor path with a labeled source-owned controlled input provider; retain a separate pinned-engine dispatch check.
- **A32-QUARANTINE / CU-04:** persist recovery intent before input in one per-OS-user scope independent of artifact roots. Failed exit/release acknowledgement must block every subsequent mutation across sessions, competing controllers and restarts. Independently release real input before failure injection. `computer recover --check` inspects without clearing; `--apply` clears only after verified process exit and input release. Match PID, creation time and user/session identity; mismatched/reused PIDs remain blocked without touching unrelated processes.
- **A32-STOP / CU-04:** implement a TRACE-owned physical Escape stop during an active session, independent of the model and Node event loop. Block new/queued dispatch within one second, stop owned active input and verify cleanup within the operation deadline. Keep the session stopped until closed; no automatic resume/replay. Uncertain cleanup enters durable quarantine. Test physical Escape during held mouse and keyboard input; separately verify TRACE-injected Escape remains an ordinary key action. Record stop source, latency, dispatch count and cleanup. Synthetic stop tests alone do not prove physical-key acceptance.

### `0.1.0-alpha.3.3` — observation and result contracts (pending)

- **A33-DEPTH / CU-01, CU-02:** add observation-only integer `accessibilityDepth` in 1–32, default 8; reject other values. Return effective depth and truncation with fresh PNG/elements. Retain depth server-side and reuse it when validating the action. A control beyond depth 8 must execute exactly once when observed deeply enough; removing, moving or disabling it must reject primary input. Preserve TTL/single-use checks and reject forged depth/action fields.
- **A33-OUTCOME / CU-02:** return top-level `not_dispatched` only when the requested primary mutation provably never began. Align nested errors, journals and next-step guidance; record any preparatory activation/restoration separately. Activation is primary for `activate`. Cover moved-window, stale-element, blocked-window, unsupported-scroll and focus rejections with zero primary dispatch and unchanged independent target state. Potential dispatch, native failure, receipt mismatch or post-action capture failure stays `unknown`, even when an error code also occurs before dispatch. Update affected harness assertions without rewriting historical receipts or adding automatic retry.
- Complete **A3-DIALOG** and **A3-WINDOW** under their retained case IDs and failure budgets. Add focused continuations; the two exhausted full-modal attempts remain failed.

### `0.1.0-alpha.4` — host and real-app acceptance (pending)

- **A4-HOST / HOST-01:** separate Codex and Claude receipts show both skills discovered, actual image/evidence inspection, an owned-target task with an exact final state, recovery from a failed action and session cleanup. Other host live runs remain optional and labeled unverified.
- **A4-REPLAY / APP-01:** define the requested target/profile, all effects and expected saved result before execution. Resolve truncated-tree targeting before retrying a miss. Record only the owned window; verify creation, requested privacy effects and playback in the final cut. Retain the trace and resulting artifact; tool delivery, decoding or HTTP success alone cannot pass.
- Clean installation moves to **RC-INSTALL**; retain **A4-INSTALL** as its historical alias.

### `0.1.0-rc.1` — installation and artifact readiness (pending)

- **RC-INSTALL / CFG-01 (A4-INSTALL):** from a clean Windows runner and pinned source/setup archive, pass documented setup, diagnostics and smoke task; verify exact backups, idempotence and conflicting/unrelated-setting preservation, then restore and independently verify rollback. Separate noninteractive installation from live desktop coverage. Publish missing-prerequisite/recovery steps and the tested archive's SHA-256; a rebuild does not inherit the previous archive's acceptance.
- **RC-CI / REL-01:** required hosted checks must run and pass on the final source. Account billing failures with zero executed steps remain external blockers; local passes do not substitute for CI.

### `0.1.0` — release acceptance (pending)

- **V1-ACCEPT / REL-01:** publish a requirement-to-receipt checklist for every acceptance row and required milestone case. Resolve all `fail`, `blocked` and `not_run` entries; retain explicitly optional limits. Required hosted CI must pass; account/billing blocks keep release pending.
- **V1-RELEASE / REL-01:** merge reviewed work within the [PR limits](VERSION_CONTROL.md), align package/lockfile/tag versions, and publish artifacts with SHA-256 checksums and reproducible build/install commands. Verify those artifacts before publishing the GitHub release.

## Current operating limits

- Windows x64, a supported Node.js runtime, .NET 9 SDK with Windows Desktop reference pack for local helpers, and .NET 9 Desktop runtime for the activity marker.
- Physical input uses an unlocked interactive desktop. Secure/elevated desktop automation is outside the initial release scope.
- Screenshots must match exact DWM/window geometry and remain within the 6 MiB image limit. Accessibility inspection currently has a bounded tree depth.
- Vertical wheel input uses 120-unit notches at an observed element's center; horizontal wheel input is unsupported.
- The desktop lease coordinates TRACE processes for one OS user. It cannot prevent human input or unrelated automation from interfering; target/focus checks remain necessary.
- Current code has no verified physical Escape stop. The historical Escape-interrupted glow case stopped the reference executor; `A32-STOP` defines the future TRACE guarantee.
- Journals record action metadata and artifact references. They do not implement durable task resume or undo external service changes.
- Local input uses the active interactive desktop; another account alone or Task View does not establish background Computer Use. [Restricted-account, hidden-desktop, Child Session and VM/remote worker research](docs/BACKGROUND_WORKER.md) separates command containment from independent GUI operation; no background backend is verified.

## Future skills

Browser operation/debugging, screenshot understanding, voice/listening, recorded-demo production, document intelligence and recoverable parallel workers remain **under review** in [SKILLS.md](SKILLS.md) and [the research list](docs/CAPABILITIES.md). They are not requirements for this release.

## Source of truth

Use this file for scope and acceptance, [Computer Use setup](docs/COMPUTER_USE.md) for operation, and [verification](docs/VERIFICATION.md) for observed results. Keep future review separate from selected scope. A configured client, a direct protocol test, a live agent workflow and a published release are distinct states.
