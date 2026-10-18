# Verification

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

## Evidence limits

REA's aggregate static analysis is `derived`; exact AST observations do not establish runtime execution. The synthetic fixture retains 15 semantic unknowns. The packaged REPLAY analysis deliberately selects two files and reports partial graph coverage; 3,707 inventoried files remain outside that analysis scope.

The desktop demonstration uses the existing Computer Use executor. It does not prove a replacement executor, complete UIA support, or Claude/Grok/Gemini compatibility. No live model-host acceptance or native analysis provider was tested. The work made no paid inference or narration requests.

Personal configuration, original application packages, and complete raw analysis stay local in ignored storage. Committed receipts omit private paths and configuration values. Only the six verified Calculator screenshots were retained.

## Reproduce

```powershell
npm ci
npm test
npm run check
npm run test:mcp
```

These commands test the repository without changing personal client configuration. CI runs the same checks on Windows; its actual result is tracked on the pull request.
