# Source archive installation verification

`npm run verify:archive` verifies an exact committed source archive in a new private directory. It resolves HEAD once, creates two byte-identical Git archives, extracts one without Git metadata or dependencies, installs locked dependencies, and builds the pinned Windows engine and four helpers. The existing checkout remains available.

The verifier checks provider readiness, the six Computer Use MCP tools without desktop actions, and 207 REA tools with synthetic static analysis. It uses a scratch home for four client configurations and three managed skill destinations. It verifies exact backups, preservation of unrelated settings and files, idempotence, conflicts, and rollback. Child process homes, package caches and .NET state are scoped to the private run directory. It makes no model request, reads no clipboard contents and changes no personal client settings.

Inspect the plan without creating processes or files:

```powershell
node scripts/verify-archive-install.cjs --plan
```

For an unverified archive, select its full 40-character Git commit:

```powershell
npm run verify:archive -- --commit <full-commit-sha>
```

Omitting `--commit` selects the current HEAD, including no uncommitted changes. Windows x64, Node.js 26, .NET 9 SDK/Desktop runtime, Git, npm and network access to the pinned dependencies are required. Receipts and private logs remain under `.runtime/archive-install/verify-*`; only the sanitized receipt is suitable for sharing. Symlinks, submodules and redirected extraction/configuration paths are rejected.

The Windows CI workflow provisions .NET 9 and runs this verifier after the existing checks. A local result does not establish a fresh-runner result. CI must actually execute successfully before its release gate passes.

## Observed scope

[Existing-host preparation](../evidence/distribution-preparation/archive-42ab54d.json) verified exact archive `42ab54d7636bbfc06cd66e400f7661c4859d8c6d`, clean extraction, setup, both MCP checks, configuration preservation and rollback on the existing Windows host. It remains partial for `RC-INSTALL` because it is neither a fresh Windows runner nor the final release archive.

[Verifier preparation](../evidence/distribution-preparation/verifier-preparation.json) records review and eight focused checks included in the earlier local suite. The new public verifier's end-to-end execution remains pending; the preparation receipt does not promote it. Reuse the existing results at their demonstrated scope. Repeat installation only for a changed archive, an affected behavior, or an unmet release gate.
