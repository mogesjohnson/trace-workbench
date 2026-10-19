# Verification

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

Personal configuration, original application packages, and complete raw analysis stay local in ignored storage. Committed receipts omit private paths and configuration values. Alpha.1 retained six verified Calculator frames; alpha.2 separately retains eight owned-fixture frames.

## Reproduce

```powershell
npm ci
npm test
npm run check
npm run test:mcp
npm run test:computer:mcp
```

These commands do not change personal client configuration or dispatch desktop input. The opt-in live fixture is described in [Computer Use setup](COMPUTER_USE.md). CI runs the noninteractive checks on Windows; its actual result is tracked on the pull request.
