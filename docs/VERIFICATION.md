# Verification

## Alpha.3 review corrections

Reviewed 19 October 2026. [Checks and remaining case status](../evidence/0.1.0-alpha.3/review-checks.json): 126 tests passed, one privilege skip; syntax/JSON/links/pins pass for 23 JavaScript files; shared skill validation passed. The pinned engine was reused and the changed native bridge rebuilt.

- Exact chord/selection/released modifiers, 96-pixel down/zero up scroll and exact drag/drop assertions passed in both review runs. The fixture now reports current viewport state and uses a genuinely modal child.
- [Attempt one](../evidence/0.1.0-alpha.3/review-attempt-1/computer-live.json) stopped on an incorrect UIA-enabled assumption. [Attempt two](../evidence/0.1.0-alpha.3/review-run/computer-live.json) exposed accepted input requests to a natively disabled parent. Both failed results, frames, source hashes and verified cleanup remain intact; no full-case third retry was run.
- The fix checks native window-enabled state before activation/input, including late activation and UIA value dispatch. A separate [focused guard check](../evidence/0.1.0-alpha.3/modal-guard/receipt.json) verified native activation and MCP click/invoke/value rejection with `window_blocked`, unchanged fixture state and zero input dispatch. It records source hashes and independent process-exit proof.
- The runner preserves plans, expected/actual results, failed cases and artifacts. Checkpoints say `running`; finalization follows cleanup. The source base plus working-tree hashes identify the tested code without claiming the uncommitted changes were already a published commit.

Full modal confirmation/recovery, complete MCP failure-mode coverage, display transitions and milestone acceptance remain pending. The original move/minimize evidence below is preserved. The focused guard pass does not promote the failed whole runs to passing.

## Original alpha.3 run and review

Observed 19 October 2026. Package `0.1.0-alpha.3`; Windows x64; Node.js v26.2.0; winapp `0.7.1`; .NET 9 window bridge. The host display was one 2880×1800 monitor at 144 DPI.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Unit tests | 109 passed, 0 failed, 1 file-symlink privilege skip | [Checks](../evidence/0.1.0-alpha.3/checks.json) |
| Source/build | Syntax, JSON, links, and pins passed for 21 JavaScript files | Checks |
| Computer MCP | Six tools over stdio; provider ready; no desktop input | Checks |
| Analysis MCP | 207 tools; owned static fixture unchanged; no paid calls | Checks |
| Live fixture | 16 actions and 22 fresh PNGs support a key chord, downward scroll, drag movement, child-window confirmation, moved/minimized targeting and the earlier action checks. The original scroll/drag assertions were lower bounds; its child window was modeless. | [Live receipt](../evidence/0.1.0-alpha.3/computer-live.json), [final frame](../evidence/0.1.0-alpha.3/frames/frame-022.png) |
| Interrupted hold | A directly started native drag was cancelled; the release bridge reported a previously held button and the next click reached the fixture. This bypassed MCP action cancellation. | Live receipt `interruption` |
| Frame check | All 22 committed PNG hashes and byte sizes match the receipt. Fixture frames are 564×717; the two dialog frames are 364×187. Frames 010, 011, 012, 017, and 022 were inspected: chord text, rows 4–7 after scroll, the moved drag target, the confirmed dialog, and count 5 | Live receipt and `frames/` |

The fixture applied move and minimize through its own command file so those geometry changes were not themselves TRACE actions. The following action on the old observation returned `window_moved`. A fresh observation then hit the counter. Minimized observation restored the window before the next successful click.

An [independent review](../evidence/0.1.0-alpha.3/grok-review.json) inspected all 22 images and verified their hashes, dimensions and original fixture source hashes against PR head `0929e08`. The original run predates its commits and records no tested source commit; retain it as historical evidence. The review found a cumulative/fallback scroll oracle, no reverse-wheel/exact-endpoint assertion, a modeless dialog and incomplete recovery coverage. Its aggregate `passed` result is not full alpha.3 acceptance.

This host had one display, so DPI/monitor transitions remain blocked. Live MCP cancellation, timeout, disconnect, server-crash input cleanup and failed-cleanup quarantine remain untested. Secure/elevated desktops and live model-host sessions were outside this run. Hosted CI remains billing-blocked; no alpha.3 release is published.

## Computer Use alpha.2

Reviewed 19 October 2026. Package `0.1.0-alpha.2`; Windows x64; Node.js 26; winapp `0.7.1`; .NET 9 window bridge.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Unit tests | 109 passed, 0 failed, 1 file-symlink privilege skip | [Checks](../evidence/0.1.0-alpha.2/checks.json) |
| Source/build | Syntax, JSON, links and pins passed; native bridge rebuilt and doctor ready | Checks |
| Computer MCP | Six tools over real stdio; provider ready; no desktop input in this check | [Receipt](../evidence/0.1.0-alpha.2/computer-mcp.json) |
| Live Windows fixture | Seven actions and eight refreshed PNGs; typing, values, coordinate clicks, invocation, checkbox and lease behavior verified on 18 October | [Live receipt](../evidence/0.1.0-alpha.2/computer-live.json), [final frame](../evidence/0.1.0-alpha.2/frames/frame-008.png) |
| Independent evidence review | Eight frames/hashes and action chain verified; visible state changes match fixture receipt | [Review](../evidence/0.1.0-alpha.2/independent-review.json) |
| Computer client setup | Four registrations preserve unrelated settings and exact backups; three skill copies match | [Installation](../evidence/0.1.0-alpha.2/installation.json) |
| Analysis regression | Existing wrapper still discovers 207 tools and passes static fixture analysis | [Receipt](../evidence/0.1.0-alpha.2/analysis-mcp.json) |
| Codex connection | Connected Computer Use MCP diagnostics called successfully in this chat on 19 October | Checks; full agent task acceptance remains pending |

The pointer cancellation correction followed the retained live fixture run. Its drain, forced-exit cleanup and quarantine paths have unit coverage and a successful native bridge build. Physical interrupted-gesture behavior, live key/scroll/drag coverage, broader Windows apps and full model-host workflows remain unverified. Quarantine is per server process; restarting does not establish that a failed recovery is resolved.

Hosted CI and merge/release status belong to the implementation PR. No alpha.2 release or universal host/app compatibility is claimed. [SPEC.md](../SPEC.md) lists remaining acceptance.

## Analysis foundation

Observed on Windows x64 with Node.js 26.2.0 on 18 October 2026. TRACE version: **0.1.0-alpha.1**. REA: **6.7.0**; skill: **42**.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit checks | 38 passed, 0 failed | [Receipt](../evidence/0.1.0-alpha.1/checks.json) |
| Source checks | Syntax, JSON, local links, and dependency pins passed | `npm run check` |
| Client registration | Four configured; unrelated settings preserved; three existing-file backups verified | [Installation](../evidence/0.1.0-alpha.1/installation.json) |
| Skill placement | Seven upstream files match canonical, Claude, and Grok discovery locations | Installation receipt |
| Direct MCP | TRACE wrapper → REA; 207 tools; protocol 2025-11-25; owned processes exited | [MCP receipt](../evidence/0.1.0-alpha.1/mcp-smoke.json) |
| Static fixture | Three exact export observations and two callable nodes; target unchanged | MCP receipt |
| Packaged REPLAY | Two selected modules parsed; package hash matches retained build | [REA receipt](../evidence/0.1.0-alpha.1/replay-analysis.json) |
| Computer Use | Calculator result 36 verified by root and independent observer | [Workflow](OBSERVED-WORKFLOW.md) |
| Source review | Two findings corrected; no remaining material findings reported | Scope and discovery regressions covered by unit tests |

### Evidence limits

REA's aggregate static analysis is `derived`; exact AST observations do not establish runtime execution. The synthetic fixture retains 15 semantic unknowns. The packaged REPLAY analysis deliberately selects two files and reports partial graph coverage; 3,707 inventoried files remain outside that analysis scope.

The alpha.1 desktop demonstration used the reference Computer Use executor. It does not prove TRACE's later executor or Claude/Grok/Gemini compatibility. No full live model-host acceptance or native analysis provider was tested in that phase. No paid inference or narration requests were made.

Personal configuration, original application packages, and complete raw analysis stay local in ignored storage. Committed receipts omit private paths and configuration values. Alpha.1 retained six verified Calculator frames; alpha.2 retains eight owned-fixture frames; alpha.3 retains 22 owned-fixture frames.

## Reproduce

```powershell
npm ci
npm test
npm run check
npm run test:mcp
npm run test:computer:mcp
```

These commands do not change personal client configuration or dispatch desktop input. The opt-in live fixture is described in [Computer Use setup](COMPUTER_USE.md). CI runs the noninteractive checks on Windows; its actual result is tracked on the pull request.
