# Upstream provenance

TRACE Workbench's first selected analysis capability uses **Reverse Engineer Anything (REA)**. The integration installs the upstream server, maintains shared skill discovery, and configures local clients. TRACE is the product; REA supplies its upstream analysis engine.

| Component | Source | Version / pin |
| --- | --- | --- |
| Analysis server | [`rea-agents` on npm](https://www.npmjs.com/package/rea-agents), [`morluto/rea`](https://github.com/morluto/rea) | `6.7.0` |
| Agent workflow skill | Skill shipped with the pinned REA package | Skill version `42` |
| Earlier method reference | [`fabwebdev/reverse-engineering-anything`](https://github.com/fabwebdev/reverse-engineering-anything) | Earlier skill version `23`; reference history only |

The upstream package declares the MIT license. Retain its distributed notices and see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the attribution boundary.

## Integrity

The pinned npm distribution integrity for `rea-agents@6.7.0` is:

```text
sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==
```

The lockfile is the installation source of truth. When updating upstream, inspect the new package and license, update the integrity and skill provenance, then rerun configuration-preservation and direct MCP tests. Record a changed tool count as a compatibility change rather than silently carrying forward the previous count.

## Boundaries of the first version

The pinned server exposes 207 MCP tools. Tool discovery does not establish that all native analysis providers are available. Built-in JavaScript and ZIP analysis can run without the optional native engines; other capabilities depend on the local provider installations reported by diagnostics.

The repository's direct MCP smoke test uses a synthetic fixture. A separate local CLI check inspected two selected modules from REPLAY's packaged ASAR, retaining its original hash and partial-coverage limits. Neither test proves a Claude, Codex, Grok, or Gemini model session or reproduces a computer-control runtime. REPLAY remains a separate application with its own recording and editing interface. See [verification](VERIFICATION.md).

## Computer Use foundation

The Windows engine is Microsoft winapp CLI `0.7.1`. Its official release archive SHA-256 and native-file hashes are recorded in [the engine pin](../src/computer/winapp-pin.json). The source-owned [window bridge](../native/TraceWindowBridge/Program.cs) uses public Win32/DWM APIs for geometry, activation and interrupted-input cleanup. Setup verifies its source/build manifest locally.

MCP server/client `2.3.1`, Zod `4.6.7` and smol-toml `1.9.0` are pinned in the lockfile. Retained license texts are linked from [third-party notices](../THIRD_PARTY_NOTICES.md). The reference Codex executor's private helper is not copied or included.

The source-owned [activity indicator](../native/TraceActivityIndicator/Program.cs) uses public Win32 layered-window APIs and .NET 9 Windows Forms. Setup builds it locally against an empty package feed and verifies source/output hashes. It adds no provider, downloaded binary or listening port.
