# TRACE Workbench 1.1.0 candidate

Prepared 31 October 2026. This candidate is not published. Final-source Windows CI, exact archive installation/rollback, asset verification and owner integration/publication approval remain release gates. Published [v1.0.0](RELEASE_1.0.0.md) and its immutable source/assets remain available.

## Changes

- Observation accepts optional `mode`: omitted/`full` retains existing behavior; `accessibility` omits PNG capture/read work; `screenshot` omits public UIA output while still performing internal UIA checks. Selective results are evidence only and revoke input authority; input still needs a fresh full observation. Discover the connected schema before using optional modes with older servers.
- Adjacent same-observation bounds receipts remove two redundant identity requests on the normal pinned backend path, from 13 to 11 synthetic provider attempts. Controller/discovery/session work is separate. The independent final identity, status, geometry, UIA, focus and recovery guards remain.
- Backend PNG validation reads at most 33 regular-file header bytes. The controller independently reads, validates dimensions/limits, hashes and encodes the full PNG. This is not full image decoding or an atomic two-reader guarantee.
- The offline [numeric profile tool](OBSERVATION_METRICS.md#summarize-existing-numeric-samples) reports first/later sample counts and minimum/median/maximum without connecting to the desktop or retaining arbitrary tool contents.
- Opt-in [capture retention](CAPTURE_RETENTION.md) bounds registered, successfully validated current-session captures. Unset/0 preserves captures; 1–100 keeps the configured count plus a protected actionable frame. Each pass attempts at most 32 deletions. Storage warnings remain separate from input cleanup, including explicit-close reporting.

## Compatibility and limits

This is an additive 1.x release under the [compatibility boundary](COMPUTER_USE.md#v1-compatibility-boundary). Six public tool names, accepted existing inputs, action units, authority, outcomes and cleanup meanings remain stable. `support.contractVersion` stays 1. Dependency pins, native helper sources and installed skill/settings are unchanged; source integration does not reload an existing MCP process or enable retention automatically.

Windows x64, an unlocked normal interactive desktop, supported Node.js, .NET 9, readable UIA root and valid capture geometry remain required. Selective screenshot mode does not add support for unreadable UIA targets. Evidence/export pin APIs, failed/historical/crash-file sweeps, a global disk cap, background GUI isolation, broader display transitions and new gestures are outside this release. Keep retention disabled when original capture files must remain available.

## Verification scope

Merged V2 focused/hosted checks cover selective authority, adjacent identity rejection, bounded PNG reads, numeric report validation and retention ownership/deletion boundaries. [The controlled profile](../evidence/v2-observation-profile/completed-2026-10-31.json) collected four full depth-8 observations at source `593e309`: first caller 2939.721 ms, later minimum/median/maximum 3061.396/3206.032/3457.710 ms. Each had 13 supervised attempts (11 backend plus the controller identity/status pair), one capture and 33 backend PNG bytes. Exact owned cleanup was confirmed. Both initial blocked preconditions remain recorded. Remaining independent guards are retained.

These timings are diagnostic, with no baseline, isolated startup/status, cold/warm, comparative speedup or model-latency claim. Inclusive stages overlap. Compatible [v0.1.0 acceptance](RELEASE_0.1.0.md) and V1 evidence retain their stated scopes; historical failures, mixed recovery sources, three legacy owner-exit metadata limits and sampled media-review limits remain explicit. No accepted mouse, Escape, clipboard, host, glow or REPLAY workflow is repeated for this candidate.

## Install and distribution

Use the [README setup flow](../README.md#computer-use-setup) and [archive verifier](ARCHIVE_INSTALL.md), preserving configuration backups and unrelated settings. Reconnect hosts after updating a checkout referenced by an absolute registration path. Source/archive checks use scratch homes and do not change personal installations.

The reviewed draft must contain the exact source/setup ZIP, acceptance manifest, sanitized distribution receipt, these notes and SHA-256 checksums. Bind the candidate commit, matching required CI and exact ZIP hash/bytes; an older CI run cannot certify later archive bytes. Reproduce Git archive bytes in UTC and compare hashes. Version/tag must agree on `1.1.0`/`v1.1.0`; npm publication stays outside scope (`private: true`). Review and merge the bounded PRs before publication under explicit owner approval.
