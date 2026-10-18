# Local analysis setup

This development setup connects local Codex, Claude Code, Grok Build, and Gemini CLI installations to the pinned REA analysis server. It also installs the accompanying `reverse-engineer-anything` skill for client discovery. These tools support engineering work on TRACE; they do not provide its planned desktop executor. A running model session is a separate acceptance check.

## Install and inspect

Use Node.js 26 and npm from a Windows terminal. In the cloned repository, install the locked dependencies and inspect the proposed changes:

```powershell
npm ci
node bin/trace.cjs plan
```

The default scope includes all four CLI clients. To select a smaller scope, repeat `--client`:

```powershell
node bin/trace.cjs plan --client codex --client claude_code
```

Apply the same scope after reviewing its plan:

```powershell
node bin/trace.cjs apply --client codex --client claude_code
node bin/trace.cjs doctor --client codex --client claude_code
```

Existing unrelated client settings are preserved. Changed files and existing skill installations are backed up before replacement. The upstream installer registers a version-pinned `npx -y rea-agents@6.7.0 mcp` launch command, wrapped with `cmd.exe /d /c` on Windows. Those registrations remain independent of the cloned TRACE directory. Keep the locked dependencies installed when using TRACE's own commands.

For the default four-client scope, use unscoped `plan`, `apply`, and `doctor` consistently. Upstream REA 6.7.0 installs the shared skill and Claude's discovery copy but does not create a personal Grok skill path. After the shared skill is installed, inspect and apply TRACE's Grok discovery link:

```powershell
node scripts/link-grok-skill.cjs --plan
node scripts/link-grok-skill.cjs --apply
```

This creates a directory junction on Windows (a directory symlink on other hosts) from Grok's personal skill path to the canonical shared installation. An existing different destination is preserved and reported as a conflict.

Restart the relevant CLI or reload its MCP connection after setup. Existing long-lived sessions may retain their original tool and skill inventory until restarted.

## Shared skill and client files

The canonical installed skill is `~/.agents/skills/reverse-engineer-anything`. The upstream setup installs Claude's matching discovery copy; TRACE supplies Grok's discovery link:

| Client | MCP configuration | Skill discovery |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | Canonical shared skill |
| Claude Code | `~/.claude.json` | `~/.claude/skills/reverse-engineer-anything` |
| Grok Build | `~/.grok/config.toml` | `~/.grok/skills/reverse-engineer-anything` → shared skill |
| Gemini CLI | `~/.gemini/settings.json` | Canonical shared skill |

`plan` and `apply` also accept repeated `--skill-client` options. TRACE unions these with selected client destinations so extra skill requests do not omit the canonical skill or Claude's copy. The managed MCP entry is named `rea`; unrelated entries remain intact. Upstream names client configuration backups with a `.rea.backup` suffix. Keep those backups private.

## How the connection runs

Each configured local client starts the pinned REA command over **stdio** when it needs the server. `node bin/trace.cjs mcp` is TRACE's alternative entry point over its locked local dependency; the direct smoke test exercises that wrapper too. No listening TCP port, cloud service, or model API key is required for this connection. Diagnostics and operational messages must stay off the MCP stdout stream.

The analysis server does not supply a reasoning model, a REPLAY connection, or desktop mouse and keyboard control. Each agent host supplies its own model and tools. TRACE's first version establishes the shared analysis interface and skill.

The pinned package exposes 207 tool definitions. Native providers depend on their separately installed requirements; TRACE setup does not install native engines. Built-in JavaScript and ZIP analysis can be checked without those providers. A healthy client registration and successful tool discovery do not establish native engine availability.

## Verify the installation

```powershell
npm run check
npm test
npm run test:mcp
```

The direct MCP smoke test starts the wrapper, discovers tools, and analyzes a synthetic local fixture. It requires no paid model request or user's application binary. A pass establishes direct server behavior. Record a successful CLI-host session separately; configuration alone does not prove that Codex, Claude, Grok, or Gemini used the server.

## Recovery and updates

Inspect `plan` before reapplying or updating. Retain the backups until `doctor` and the relevant client confirm the desired configuration. To recover a changed client file, close the client, restore its matching backup, and restart the client. Restore the canonical skill and discovery copies together if rolling back the installed skill.

Update the pinned package through a reviewed PR, with the lockfile and [provenance](PROVENANCE.md) changed together. Re-run verification before applying the updated installation. Keep personal settings, backups, native engines, and private analysis artifacts outside the repository.
