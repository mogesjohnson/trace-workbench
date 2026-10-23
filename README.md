# TRACE Workbench

## Advanced capabilities for AI agents

Shared tools that give agents abilities beyond written instructions.

**Version:** `0.1.0-alpha.3.3` · **Status:** Windows preview, milestone acceptance incomplete

**23 October checkpoint (UTC):** typing quarantine recovery passed; 13 of 22 declared checkpoints are verified (59%, not an effort estimate). Compatible passing checks are reused. Follow the [progress plan](docs/GAP_CLOSURE_PLAN.md), [visual dashboard](docs/GAP_CLOSURE_PROGRESS.html) and [current evidence](docs/GAP_CLOSURE_STATUS.md). Full live and release acceptance remain incomplete.

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

- The prior local suite recorded **520 tests, 514 passed, six skipped, zero failed**, with source checks for 95 JavaScript files. Those results are reused at their actual scope. This continuation ran one focused MCP regression for the changed Claude forwarding boundary; it did not rerun the full suite. Test counts describe cases and edge conditions, not features.
- Method coordination, routing, checkpoints and artifact identity are implemented; actual headless browser and eight child-process application cases have scoped passing evidence.
- Native supervision, durable quarantine, physical-stop handling and strict UTF-8 transport are implemented. Recovery coverage links 15 failure/input pairs at their recorded source scopes; full acceptance remains incomplete.
- Actual Codex typing preserved `TRACE Codex verified café 日本語` exactly. Its complete host workflow still needs proof through a connected server loaded from corrected source. An extra bounded budget is approved but unclaimed.
- Typing quarantine acknowledgement passed with exact `abc`, independent release, persistent recovery across restart and one exact pinned-engine follow-up. Owned native work, fixture and readiness anchor exited.
- Observation reads the accessibility tree 8 levels deep by default and up to 32 on request; the action reuses that depth. Live: a control 14 levels deep was invoked exactly once.
- Rejected actions report `not_dispatched` when input provably never started, and `unknown` when it may have. Live: moved, blocked, unsupported-scroll and changed-focus cases left the fixture unchanged.
- A focused modal workflow passed: the blocked parent rejected input, and the exact dialog was confirmed and closed through TRACE.
- The session glow now stays above activated windows (focused regression). A minimized target is restored and settles before capture (focused regression).
- The analysis connection exposes **207 tools**. Four client registrations and three skill copies match the current instructions.

[Verification and limits](docs/VERIFICATION.md) · [Observed computer workflow](docs/OBSERVED-WORKFLOW.md)

## Remaining

- **Live gates:** complete glow lifecycle, clipboard paste/restoration, Claude workflow/settings and current-source physical-stop proof. Typing quarantine, window targeting and cancellation replacements have passed at their recorded scopes.
- **Glow and Codex:** [amendment 2 is approved](evidence/live-acceptance-continuation/owner-amendment-2.json). Both amended glow attempts are consumed; no new glow run is authorized. Codex's amended attempts remain unclaimed.
- **Clipboard:** the first supplement stopped before paste. Native cleanup is reconciled; guarded restoration refused changed clipboard contents and retained protected recovery.
- **REPLAY:** two-instance recording feasibility passed. The production adapter, durable recovery and a source-segment content review gate are implemented and checked offline. Actual controls, editing/audio and both final exports remain unproved.
- **Distribution:** existing-host exact-archive setup/configuration/rollback preparation passed. [The archive verifier](docs/ARCHIVE_INSTALL.md), fresh Windows CI and the final release archive still need end-to-end acceptance.
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
