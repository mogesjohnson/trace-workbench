# TRACE Workbench

Shared local REA analysis setup for **Codex, Claude Code, Grok Build, and Gemini CLI**.

**Version:** `0.1.0-alpha.1` · **REA:** `6.7.0` · **Skill:** `42`

## Setup

Requires a supported Node.js version; verified on Windows x64 with Node.js 26.

```powershell
npm ci
node bin/trace.cjs plan
node bin/trace.cjs apply
node scripts/link-grok-skill.cjs --plan
node scripts/link-grok-skill.cjs --apply
node bin/trace.cjs doctor
```

Review the plan before applying it. Setup preserves unrelated settings and backs up existing configuration. New agent connections launch the pinned analysis server over stdio. No listening network port or model API key is required.

For selected clients and recovery, see [setup](docs/SETUP.md). REA provides the analysis engine; TRACE provides the integration workflow. [Upstream attribution](docs/PROVENANCE.md).

## Verified

- **38 unit tests passed.**
- **207 MCP tools** discovered through TRACE; static fixture analysis passed and owned processes exited.
- Two selected modules from packaged REPLAY were analyzed without changing its package.
- Calculator **12 × 3 = 36** was demonstrated by one driver and reviewed by two observers.

[Verification and limits](docs/VERIFICATION.md) · [Observed computer workflow](docs/OBSERVED-WORKFLOW.md)

## Scope

The skill and analysis connection are installed. Native decompilation engines and live Claude/Grok/Gemini model sessions were not tested. A shared desktop-control replacement is future work.

```powershell
npm test
npm run check
npm run test:mcp
```

Personal configuration, credentials, raw private analysis, and application binaries stay outside Git. PRs target **2–3 commits**, with a **maximum of 4**. See [repository rules](RULES.md) and [version control](VERSION_CONTROL.md).
