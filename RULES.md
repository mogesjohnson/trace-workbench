# Project rules

TRACE Workbench installs a shared Reverse Engineer Anything skill and connects local agent CLIs to the pinned REA analysis server. The current scope is setup, configuration preservation, diagnostics, and a reproducible MCP smoke test. A desktop-control executor is a separate future project.

## Implementation

- Keep one canonical skill installation and keep client discovery copies aligned with that version. Preserve an existing installation before replacing it.
- Compute a configuration plan before writing client settings. Apply changes only to the TRACE-owned entry, preserve unrelated settings, and retain a recoverable backup.
- Keep REA pinned and lock dependencies. Explain upstream version or integrity changes in the PR and update provenance together.
- Use local stdio for the analysis server. Start native providers only when their requirements are installed; report missing providers without presenting them as working.
- Keep personal client settings, credentials, caches, application binaries, and private analysis artifacts outside Git. Commit only synthetic fixtures and sanitized verification receipts.

## Evidence

- Verify the changed behavior and configuration preservation before claiming setup is complete. A successful direct MCP test proves the server works; a configured client is not evidence of a successful model-host session.
- Report each result at its actual scope: unit checks, direct MCP integration, client configuration, or live host acceptance. Record a blocked CI run as blocked rather than passing.
- Preserve upstream attribution. TRACE owns the integration workflow; REA supplies the analysis engine and tools.
- Update documentation to match the completed implementation. The initial README is written last, after setup and verification results are known.
