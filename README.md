# TRACE Workbench

## Advanced capabilities for AI agents

Shared tools that give agents abilities beyond written instructions.

**Version:** `0.1.0-alpha.3.3` · **Status:** Windows preview, milestone acceptance incomplete

**27 October checkpoint:** 18 of 22 declared checkpoints are verified (82%, not an effort estimate). The [owner-invariant review](docs/PRODUCTION_OWNER_RECONCILIATION.md) reconciles existing evidence without repeating tests. Follow the [progress plan](docs/GAP_CLOSURE_PLAN.md), [visual dashboard](docs/GAP_CLOSURE_PROGRESS.html) and [requirement checklist](docs/REQUIREMENT_EVIDENCE_REVIEW.md). Full live and release acceptance remain incomplete.

TRACE provides local tools for **Codex, Claude Code, Grok Build, and Gemini CLI**. The first two skills are **Reverse Engineer Anything** and **Computer Use**. The Windows executor exposes six MCP tools for discovering windows, observing screenshots and controls, acting, and releasing desktop ownership. A screen-edge glow shows when TRACE owns the desktop.

Read the [specification and remaining acceptance](SPEC.md). [Skill status](SKILLS.md) and [future skills under review](docs/CAPABILITIES.md) distinguish selected work from research.

## Computer Use setup

Requires Windows x64, a supported Node.js version, and .NET 9 SDK/runtime.

```powershell
npm ci
npm run computer:setup -- --plan
npm run computer:setup -- --apply
npm run computer:doctor
npm run computer:config -- --plan
npm run computer:config -- --apply
```

Review each plan before applying it. Setup pins the Windows engine locally; configuration preserves unrelated settings and exact backups. Reconnect agent hosts after installation or code changes.

[Computer Use operation and recovery](docs/COMPUTER_USE.md) · [Analysis setup](docs/SETUP.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Verified

- Required Windows [CI passed at source checkpoint `0d9a6a9`](https://github.com/mogesjohnson/trace-workbench/actions/runs/40040530734), including source checks, the required suite, both MCP paths and exact-archive installation/rollback. Compatible local and live passes are reused; test counts describe cases and edge conditions, not features.
- Method coordination, routing, checkpoints and artifact identity are implemented; actual headless browser and eight child-process application cases have scoped passing evidence.
- Native supervision, durable quarantine and strict UTF-8 transport are implemented. [Recovery coverage](evidence/computer-use-method/effective-recovery-map.json) links 15 failure/input pairs at their recorded source scopes, preserving three older exit-metadata limits. [Actual physical mouse/keyboard stops and ordinary injected Escape passed](evidence/live-acceptance-continuation/finish-stop-verification.json).
- Required actual [Codex](evidence/live-acceptance-continuation/codex-amendment-2-attempt-1/receipt.json) and [Claude](evidence/live-acceptance-continuation/claude-supplemental-2/receipt.json) host workflows passed at their declared scopes. [Clipboard paste and restoration passed](evidence/live-acceptance-continuation/clipboard-supplemental-2/receipt.json). No repeat is needed.
- Typing quarantine acknowledgement passed with exact `abc`, independent release, persistent recovery across restart and one exact pinned-engine follow-up. Owned native work, fixture and readiness anchor exited.
- Observation reads the accessibility tree 8 levels deep by default and up to 32 on request; the action reuses that depth. Live: a control 14 levels deep was invoked exactly once.
- Rejected actions report `not_dispatched` when input provably never started, and `unknown` when it may have. Live: moved, blocked, unsupported-scroll and changed-focus cases left the fixture unchanged.
- A focused modal workflow passed: the blocked parent rejected input, and the exact dialog was confirmed and closed through TRACE.
- The session glow now stays above activated windows (focused regression). A minimized target is restored and settles before capture (focused regression).
- The analysis connection exposes **207 tools**. Four client registrations and three skill copies match the current instructions.

[Verification and limits](docs/VERIFICATION.md) · [Observed computer workflow](docs/OBSERVED-WORKFLOW.md)

## Remaining

- **Glow lifecycle:** intended-target hit is supported under the [owner-selected criterion](evidence/live-acceptance-continuation/glow-target-hit-verification.json); ordinary-close and owner-process-loss measurements remain missing. Original failures and exhausted budgets stay unchanged. A narrow supplement needs its bounded execution plan and fresh desktop readiness.
- **REPLAY pause:** [recording, edits, offline audio, two exports and completed-file playback are retained](evidence/live-acceptance-continuation/replay-finish-2/verification.json). A user-caused pause before playback ends remains unproved. Reuse completed work; do not repeat the full workflow.
- **Final review:** finish requirement/documentation disposition after the missing live results. The [eight owner invariants](docs/PRODUCTION_OWNER_RECONCILIATION.md) now have scoped evidence; this does not complete all CU-04 or release gates.
- **Distribution:** checkpoint CI and its exact archive passed. Final versioned artifacts need their own exact-byte installation/rollback acceptance and required hosted checks after any change. Reviewed merges and release publication remain separate.
- **Unverified:** Grok/Gemini live behavior.
- **Deferred:** display transitions.

See [SPEC.md](SPEC.md). No release is published.

```powershell
npm test
npm run check
npm run test:mcp
npm run test:computer:mcp
```

Personal configuration, credentials, raw private analysis, and application binaries stay outside Git. PRs target **2–3 commits**, with a **maximum of 4**. See [repository rules](RULES.md) and [version control](VERSION_CONTROL.md).
