# TRACE Workbench

## Advanced capabilities for AI agents

Shared tools that give agents abilities beyond written instructions.

**Version:** `0.1.0-alpha.1` · **Status:** development foundation

The goal is one interface for **Codex, Claude Code, Grok Build, and Gemini CLI** to observe and operate Windows. The shared desktop executor is not implemented yet. This version contains engineering setup and recorded workflow evidence.

Start with computer and browser control. Explore the proposed [capabilities and priorities](docs/CAPABILITIES.md).

## Developer setup

Requires a supported Node.js version; verified on Windows x64 with Node.js 26.

```powershell
npm ci
node bin/trace.cjs plan
node bin/trace.cjs apply
node scripts/link-grok-skill.cjs --plan
node scripts/link-grok-skill.cjs --apply
node bin/trace.cjs doctor
```

These commands configure development analysis tools. Review the plan before applying it; setup preserves unrelated settings and backs up existing configuration.

See [setup and recovery](docs/SETUP.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Verified

- **38 unit tests passed.**
- **207 analysis tools** discovered through the development MCP connection; static fixture analysis passed and owned processes exited.
- Two selected modules from packaged REPLAY were analyzed without changing its package.
- The existing Computer Use executor demonstrated Calculator **12 × 3 = 36**, reviewed by two observers.

[Verification and limits](docs/VERIFICATION.md) · [Observed computer workflow](docs/OBSERVED-WORKFLOW.md)

## Scope

The development skill and analysis connection are installed. Native decompilation engines and live Claude/Grok/Gemini model sessions were not tested. The Calculator demonstration records the workflow TRACE aims to support; it does not establish a working TRACE executor.

```powershell
npm test
npm run check
npm run test:mcp
```

Personal configuration, credentials, raw private analysis, and application binaries stay outside Git. PRs target **2–3 commits**, with a **maximum of 4**. See [repository rules](RULES.md) and [version control](VERSION_CONTROL.md).
