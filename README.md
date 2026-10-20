# TRACE Workbench

## Advanced capabilities for AI agents

Shared tools that give agents abilities beyond written instructions.

**Version:** `0.1.0-alpha.3.3` · **Status:** Windows preview, milestone acceptance incomplete

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

- **172 tests run, 171 passed; 1 Windows file-symlink privilege test skipped.**
- Observation reads the accessibility tree 8 levels deep by default and up to 32 on request; the action reuses that depth. Live: a control 14 levels deep was invoked exactly once.
- Rejected actions report `not_dispatched` when input provably never started, and `unknown` when it may have. Live: moved, blocked, unsupported-scroll and changed-focus cases left the fixture unchanged.
- A focused modal workflow passed: the blocked parent rejected input, and the exact dialog was confirmed and closed through TRACE.
- The session glow now stays above activated windows (focused regression). A minimized target is restored and settles before capture (focused regression).
- The analysis connection exposes **207 tools**. Four client registrations and three skill copies match the current instructions.

[Verification and limits](docs/VERIFICATION.md) · [Observed computer workflow](docs/OBSERVED-WORKFLOW.md)

## Remaining

- **Failed cases:** A31-GLOW and A3-WINDOW each failed twice, so their retry budgets are exhausted; replacement cases need owner approval.
- **Blocked:** alpha.3.2 native supervision (recovery, durable quarantine, physical Escape stop) is blocked by its failed feasibility probe.
- **Not started:** Codex/Claude host tasks, the REPLAY workflow, clean-machine setup and release gates.
- **Hosted CI:** cannot run because of account billing.
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
