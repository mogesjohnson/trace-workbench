# TRACE Workbench

## Advanced capabilities for AI agents

Shared tools that give agents abilities beyond written instructions.

**Version:** `0.1.0-alpha.3` · **Status:** Windows preview

TRACE provides local tools for **Codex, Claude Code, Grok Build, and Gemini CLI**. The first two skills are **Reverse Engineer Anything** and **Computer Use**. The Windows executor now exposes six MCP tools for discovering windows, observing screenshots and controls, acting, and releasing desktop ownership.

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

- **109 tests passed; 1 Windows file-symlink privilege test skipped.**
- A real stdio MCP run completed **16 actions with 22 fresh PNGs** in an owned Windows fixture at 144 DPI.
- Typing, clicks, editable values, invocation, checkbox, the `ctrl+d` chord, vertical scroll, drag, dialog confirmation, moved and minimized windows, and interrupted left-button recovery were verified.
- The analysis connection still exposes **207 tools** and passes its static fixture check. Four client registrations were verified with the alpha.2 installation receipt.

[Verification and limits](docs/VERIFICATION.md) · [Observed computer workflow](docs/OBSERVED-WORKFLOW.md)

## Remaining

Codex/Claude task acceptance, a real REPLAY workflow, clean-machine setup, and release gates remain. The 19 October live run had one 144 DPI display, so it did not include a DPI change or a second monitor. Grok/Gemini live behavior is unverified. See [SPEC.md](SPEC.md); alpha.3 is not a published release.

```powershell
npm test
npm run check
npm run test:mcp
npm run test:computer:mcp
```

Personal configuration, credentials, raw private analysis, and application binaries stay outside Git. PRs target **2–3 commits**, with a **maximum of 4**. See [repository rules](RULES.md) and [version control](VERSION_CONTROL.md).
