# Project rules

TRACE Workbench gives agents shared executable capabilities. The selected first skills are Reverse Engineer Anything and Computer Use. The alpha.3 preview adds scoped owned-fixture action and window checks to the Windows executor and MCP server. Full milestone and release acceptance remain governed by [SPEC.md](SPEC.md). Keep implementation, observed verification, and release readiness distinct.

## Implementation

- Keep one canonical skill installation and keep client discovery copies aligned with that version. Preserve an existing installation before replacing it.
- Compute a configuration plan before writing client settings. Apply changes only to the TRACE-owned entry, preserve unrelated settings, and retain a recoverable backup.
- Keep REA pinned and lock dependencies. Explain upstream version or integrity changes in the PR and update provenance together.
- Use local stdio for the analysis server. Start native providers only when their requirements are installed; report missing providers without presenting them as working.
- Keep personal client settings, credentials, caches, application binaries, and private analysis artifacts outside Git. Commit only synthetic fixtures and sanitized verification receipts.

## Evidence

- Verify the changed behavior and configuration preservation before claiming setup is complete. A successful direct MCP test proves the server works; a configured client is not evidence of a successful model-host session.
- Report each result at its actual scope: unit checks, direct MCP integration, client configuration, or live host acceptance. Record a blocked CI run as blocked rather than passing.
- Keep product descriptions focused on TRACE's computer-control goal and implemented capabilities. Preserve analysis-tool attribution in technical documentation and third-party notices.
- Update documentation to match the completed implementation. The initial README is written last, after setup and verification results are known.
