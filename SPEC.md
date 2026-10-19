# TRACE specification

Status reviewed 19 October 2026. This is the acceptance baseline for the first usable release; the package currently identifies the implementation as `0.1.0-alpha.3`.

## Product and scope

TRACE gives AI agents executable capabilities through a shared local MCP interface and accompanying skill instructions. The first two selected skills are **Reverse Engineer Anything** and **Computer Use**, in that order. TRACE remains the product name.

The initial delivery targets Windows x64 and the Codex, Claude Code, Grok Build, and Gemini CLI hosts. Each host supplies its reasoning model and permission controls. TRACE supplies the operations and evidence; equivalent model behavior is not assumed.

## Acceptance requirements

| ID | Done when | Current evidence / remaining work |
| --- | --- | --- |
| ANA-01 | The pinned analysis skill and server are installed, diagnostics report available providers honestly, and a static artifact analysis returns evidence without modifying the target. | Verified for built-in static analysis in [alpha.1](docs/VERIFICATION.md#analysis-foundation). Optional native providers remain untested. |
| CFG-01 | All four CLI registrations preserve unrelated settings, retain exact backups, and discover matching instructions. Reapplying is idempotent; conflicting entries are preserved. | Four registrations and three matching Computer Use skill copies verified in the [installation receipt](evidence/0.1.0-alpha.2/installation.json). |
| CU-01 | Agents select an exact returned window, receive PNG pixels plus accessibility data, and use coordinates that match those pixels. Changed identity or ambiguous capture geometry fails before input. | Implemented; owned-fixture and regression evidence. Capture accounts for invisible Windows borders. Requires a readable UIA root today. |
| CU-02 | Each action uses the latest single-use observation, expires after 60 seconds, and returns fresh state. Failed or uncertain input is not retried automatically. | Implemented; stale observation rejection and refreshed frames verified. A delivered input is not treated as proof that the user's goal succeeded. |
| CU-03 | Activation, clicks, literal typing, key chords, vertical scrolling, dragging, invocation, and editable values work through MCP with visible outcome checks. | The [alpha.3 live receipt](evidence/0.1.0-alpha.3/computer-live.json) records `ctrl+d`, a 96-pixel vertical scroll, a drag, typing, clicks, activation, checkbox, invocation, and values on the owned fixture. |
| CU-04 | One controller owns desktop input across processes and artifact directories. Cancellation/timeout stop owned native work, balance input and report uncertainty. Disconnect/crash release desktop ownership. Uncertain actions require re-observation. | Desktop ownership and handoff remain verified. A live held drag was interrupted, the window bridge released the left button, and the next click reached the fixture. TRACE process-crash behavior during input remains the unit-tested path. |
| HOST-01 | Real agents can discover both selected skills, receive images/evidence, operate an owned target and recover from a failed action. | Four client configurations exist. Codex Computer Use diagnostics were called through its connected MCP tool; a full agent workflow remains. Initial live acceptance targets Codex and Claude. Grok/Gemini live runs are optional under the owner's earlier testing preference and must be labeled unverified until performed. |
| APP-01 | A workflow in a real target app, including REPLAY, demonstrates correct targeting, editing/control and a verified result without relying on fixture-only behavior. | Pending. The earlier Calculator demonstration used the reference executor; it is not evidence of TRACE controlling REPLAY. |
| REL-01 | Source, versions, setup instructions, licenses, evidence and spec agree; local checks and required hosted CI pass; reviewed PRs are merged before a versioned release is tagged. | Local checks and the alpha.3 fixture run are recorded in [verification](docs/VERIFICATION.md). Publication, hosted CI, and release gates remain. No alpha.3 release is published. |

## Delivery sequence

| Milestone | Required outcome | Status |
| --- | --- | --- |
| `0.1.0-alpha.1` | Shared analysis foundation and reference workflow evidence. | Implemented in prerequisite PRs. |
| `0.1.0-alpha.2` | Computer Use MCP, pinned Windows engine, setup preservation, owned-fixture proof and current specification. | Merged to main. |
| `0.1.0-alpha.3` | Live key/scroll/drag and interrupted-input tests; dialogs, moved/minimized windows, and the host display's DPI and monitor geometry. | Verified on 19 October 2026 at 144 DPI on one 2880×1800 display. A DPI change and a second-monitor relocation were not available on that host. |
| `0.1.0-alpha.4` | Codex and Claude task acceptance, real-app/REPLAY walkthrough, recovery guidance and clean-machine installation proof. | Pending; other hosts remain configuration-verified unless separately exercised. |
| `0.1.0` | Satisfy every acceptance row at its declared scope, clear hosted CI, merge reviewed work and publish reproducible release artifacts. | Pending. |

## Current operating limits

- Windows x64, a supported Node.js runtime, .NET 9 SDK for building the bridge, and .NET 9 runtime for executing it.
- Physical input uses an unlocked interactive desktop. Secure/elevated desktop automation is outside the initial release scope.
- Screenshots must match exact DWM/window geometry and remain within the 6 MiB image limit. Accessibility inspection currently has a bounded tree depth.
- Vertical wheel input uses 120-unit notches at an observed element's center; horizontal wheel input is unsupported.
- The 19 October 2026 acceptance host had one display at 144 DPI. That run did not change DPI or move the window onto another monitor.
- The desktop lease coordinates TRACE processes for one OS user. It cannot prevent human input or unrelated automation from interfering; target/focus checks remain necessary.
- Journals record action metadata and artifact references. They do not implement durable task resume or undo external service changes.

## Future skills

Browser operation/debugging, screenshot understanding, voice/listening, recorded-demo production, document intelligence and recoverable parallel workers remain **under review** in [SKILLS.md](SKILLS.md) and [the research list](docs/CAPABILITIES.md). They are not requirements for this release.

## Source of truth

Use this file for scope and acceptance, [Computer Use setup](docs/COMPUTER_USE.md) for operation, and [verification](docs/VERIFICATION.md) for observed results. Keep future review separate from selected scope. A configured client, a direct protocol test, a live agent workflow and a published release are distinct states.
