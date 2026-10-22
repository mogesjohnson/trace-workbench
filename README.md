# TRACE Workbench

## Advanced capabilities for AI agents

Shared tools that give agents abilities beyond written instructions.

**Version:** `0.1.0-alpha.3.3` · **Status:** Windows preview, milestone acceptance incomplete

**22 October checkpoint:** Codex resumed, reviewed Claude's work and corrected acceptance/recovery gaps. Follow the [progress plan](docs/GAP_CLOSURE_PLAN.md), [visual dashboard](docs/GAP_CLOSURE_PROGRESS.html) and [current evidence](docs/GAP_CLOSURE_STATUS.md). Live acceptance remains incomplete.

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

- **501 tests run, 495 passed, six skipped, zero failed** at the resumed review checkpoint. Source checks pass for 93 JavaScript files. Five skips need the optional browser runtime and one needs Windows symlink privilege.
- Method coordination, routing, checkpoints and artifact identity are implemented; actual headless browser and eight child-process application cases have scoped passing evidence.
- Native supervision, durable quarantine, physical-stop handling and strict UTF-8 transport are implemented. Recovery coverage links 15 failure/input pairs at their recorded source scopes; full acceptance remains incomplete.
- Actual Codex typing now preserved `TRACE Codex verified café 日本語` exactly. Its complete host workflow remains blocked at stale-error outcome verification; that protocol correction is tested but needs a reconnected host and separately authorized new live budget.
- Observation reads the accessibility tree 8 levels deep by default and up to 32 on request; the action reuses that depth. Live: a control 14 levels deep was invoked exactly once.
- Rejected actions report `not_dispatched` when input provably never started, and `unknown` when it may have. Live: moved, blocked, unsupported-scroll and changed-focus cases left the fixture unchanged.
- A focused modal workflow passed: the blocked parent rejected input, and the exact dialog was confirmed and closed through TRACE.
- The session glow now stays above activated windows (focused regression). A minimized target is restored and settles before capture (focused regression).
- The analysis connection exposes **207 tools**. Four client registrations and three skill copies match the current instructions.

[Verification and limits](docs/VERIFICATION.md) · [Observed computer workflow](docs/OBSERVED-WORKFLOW.md)

## Remaining

- **Live gates:** complete glow lifecycle, typing quarantine, clipboard paste/restoration, Claude workflow/settings and current-source physical-stop proof. Window targeting and cancellation replacements have passed at their recorded scopes.
- **Glow and Codex:** both approved supplemental attempts are consumed for each. The [second bounded amendment](docs/LIVE_ACCEPTANCE_AMENDMENT_2.md) is a proposal; another run requires an actual owner decision.
- **REPLAY:** two-instance recording feasibility passed. The production adapter, durable recovery and a source-segment content review gate are implemented and checked offline. Actual controls, editing/audio and both final exports remain unproved.
- **Distribution:** clean archive installation/rollback and final release acceptance remain.
- **Hosted CI:** the inspected [PR 15 check](evidence/computer-use-method/ci-pr15-current.json) could not start due to account billing/spending. Required hosted CI remains blocked.
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
