# Compatibility and support contract

This is the single source for what TRACE promises: what is covered, what each version bump means, how long identifiers live, how things are retired, and what is supported.

**Applies from the next release.** Published `2.2.0` and earlier archives are unchanged and keep the promises they shipped with. Items marked "next release" are not in `2.2.0`. Live discovery governs: this file describes the contract, and the connected schema and doctor describe the actual server.

[Computer Use](COMPUTER_USE.md) has the operating details. The [2.0.0 boundary](COMPUTER_USE.md#v2-compatibility-boundary-200) lists what changed in that release.

## What is covered

| Tier | Covers | Promise |
|---|---|---|
| **Stable** | The seven `trace-computer` MCP tools (below), `npm run computer:setup`, `npm run computer:config`, `computer doctor`, `computer recover`, durable recovery state, and the skill bundle format | The version rules below apply |
| **Supported** | The method API exports listed in the [method README](../src/method/README.md): `ComputerMethod`, `ProviderRegistry`, `createTraceProvider`, `createBrowserProvider`, `createApplicationProvider`, `createClipboardProvider`, `createLocalArtifactProvider`, `verifyArtifactHandoff`, `mapPoint` | Documented behavior follows the package version. The API has no version identity of its own |
| **Experimental** | `trace-phone` and its `phone_*` tools | May change in any release. Tested on one owner phone only |
| **Upstream** | REA analysis (`rea-agents`) | Governed by its pin and by upstream. TRACE versions are independent of it |

The seven tools are `trace_computer_doctor`, `trace_computer_list_windows`, `trace_computer_launch`, `trace_computer_open_session`, `trace_computer_observe`, `trace_computer_act` and `trace_computer_close_session`.

The Stable tier includes the action forms, units and limits in [Computer Use](COMPUTER_USE.md). Unsupported fields are rejected.

Not covered: other method index exports such as `state`, `computer apps`, native helper files and their wire formats, transient evidence tokens, frames and journals, and the wording of skill guidance. The bundle format (`trace.skill-bundle/1`) and its ownership hashes are covered; the instructions inside may change in any release. Source changes alone do not prove personal installed copies were updated.

## What each version bump means

| Change | Bump | Notes |
|---|---|---|
| Docs, or an internal refactor with no behavior change | Patch | |
| Bug fix that keeps documented behavior | Patch | |
| New optional input, tool, doctor field or result field | Minor | Discoverable from the schema or doctor |
| New diagnostic error code | Minor | |
| Compact form loses a non-authority field | Minor | See [result fields](#result-fields) |
| Strictly safer reclassification, or a new refusal | Minor | See [reclassifying results](#reclassifying-results). Needs a release-notes entry |
| Helper rebuild required (`computer:setup -- --apply`) | Minor | Stated in the release notes |
| Engine pin bump that keeps behavior | Minor | Affected live checks rerun. See [version identities](#version-identities) for the adapter limit |
| Runtime floor change (Node, .NET, Windows) | Minor with notice | Major if a supported platform is dropped without notice |
| Announce a deprecation | Minor | See [deprecation](#deprecation) |
| Remove or rename a tool, input, documented default-form field or [cataloged code](#error-codes) | Major | Needs an earlier deprecation and migration notes |
| Change units, authority, outcome meaning or cleanup meaning | Major | Migration notes required |
| New top-level `outcome` value | Major | |
| `support.contractVersion` change | Major | |
| Recovery record format change | Any | Must still read every older format, or block the upgrade until recovery is clear |

## Result fields

Results carry matching JSON text and `structuredContent`. No formal MCP output schemas are advertised.

- **Default form:** every field documented in [Computer Use](COMPUTER_USE.md) is stable.
- **`full` and `verbose` forms:** stable in the same way.
- **Compact forms:** the act `summary` details, the `interactiveOnly` lean format and `returnObservation: "none"` keep only their authority fields stable, and may shrink in a minor.
- **Authority fields:** `outcome`, `verification`, `observationId`, cleanup and recovery fields, and `error.code`.

Screenshot metadata indexes a PNG block in the original complete MCP `content` array, so a filtering consumer must remap that index. The method adapter validates image metadata and hash, observation and session, and process lifetime before exposing its remapped image array. This checks association, not producer authenticity, full PNG decoding or image meaning.

## Outcomes and reclassifying results

Act results use these `outcome` values. `trace_computer_launch` also uses `launched`.

| `outcome` | Meaning |
|---|---|
| `completed` | Reports action delivery. It does not prove the application effect |
| `not_dispatched` | Requires proof that primary input never began. Preparatory activation is listed separately |
| `unknown` | Delivery is possible. Never authorizes automatic replay |
| `target_closed_after_dispatch` | Input completed before its window closed |

Preparation, cleanup and independently verified application effects stay separate from `outcome`. Errors may include bounded recovery fields. Missing cleanup confirmation or an unreadable response is never proof of safe cleanup.

### Reclassifying results

A minor release may reclassify a result when the change is strictly safer: a claim becomes less certain (`completed` to `unknown`), or a case now refuses input that could land in the wrong place. Each one gets a release-notes entry. A change toward more certainty needs proof, as `not_dispatched` already does.

A new top-level `outcome` value needs a major. Clients must still treat an outcome they do not recognize as `unknown`.

## Client obligations

- Read the connected schema and doctor before using a feature. Older servers reject new inputs under their strict schemas.
- Tolerate unknown result fields and metadata, while still requiring known authority and cleanup proof.
- Reject an unsupported `support.contractVersion` rather than guess.
- Treat every identifier as opaque.
- After `unknown`, observe again before deciding. Never replay automatically.
- Schema string lengths count code points. The shared runtime UTF-16 limits are authoritative.

## Version identities

| Identity | Current value | How a client reads it |
|---|---|---|
| Package and release | `2.2.0`, tag `v2.2.0`. Private, so no npm package | MCP `serverInfo.version`. Next release: doctor `versions`, `node bin/trace.cjs --version` |
| MCP protocol | Negotiated by the pinned SDK | MCP handshake. TRACE promises no specific protocol version |
| Tool input schemas | Seven strict schemas, no version | `tools/list` |
| Action support descriptor | `support.contractVersion: 1` plus `sha256` of the full descriptor | Doctor `support` |
| Doctor feature flags | `actResult`, `windowListing`, `observationModes`, `observationScope`, `launch`, `ownedModal`, `responseSize` | Doctor |
| Skill bundle | `trace.skill-bundle/1`, file hashes, no content version | `manifest.json` |
| Native helpers | Wire and manifest `version: 1`, source hashes | Failure codes. Next release: doctor `versions`. Not a compatibility surface |
| Engine | winapp `0.7.1`, x64, pinned file hashes | Doctor `version` and `support.engine` |

`support.contractVersion` identifies the action-support descriptor, separately from the package, protocol and engine versions. It changes only on a semantic break. Unknown legacy support stays explicitly unknown; contradictory descriptors disable the method route. Feature additions are declared outside the descriptor when possible.

A compact descriptor must match the local descriptor's digest exactly, and the digest includes the engine version. Next release: on a mismatch the adapter re-reads doctor with `verbose: true` and uses the tolerant full-descriptor match, which accepts added fields. That match still needs the same engine name and version, so an adapter and server on different engine pins stay refused. Adapters from 2.0 to 2.2 stay strict. Run the adapter and server from the same checkout.

## Identifier lifetimes

All identifiers are opaque. Clients never parse them, even where the format is visible. No identifier survives a server restart except a durable recovery record.

| Identifier | Valid for | Ends when |
|---|---|---|
| Application name, AUMID, `ms-settings:` page | One launch request | Not an identity |
| `windowId` | One window. Windows can reuse the value | The window closes. Identity is bound at open |
| `relatedWindows[].windowId` | Context only (`authority: "context-only"`) | The next observation |
| `sessionId` | One server process and one lease. Names a lease, not a window, because `followModal` retargets it | Close, failure or server exit. Not resumable |
| `observationId` | The latest observation, one action, 60 seconds by default | Used, replaced or expired. Selective-mode IDs never authorize input and revoke the prior one |
| `actionId` | Correlation only | Never reused. No idempotency meaning |
| `elementId` | The observation that returned it | The next observation. `stale_element` when bindings change |
| `treeNodeId`, `parentNodeId` | One observation | The next observation |
| Method capture ID, `evidenceKey` | One fresh read | Refresh or expiry |
| `postActionEvidence` token | One use, read-only. Never grants input | Lifecycle change or checkpoint |
| Checkpoint | The same descriptors and process lifetimes. No cross-version promise | Providers or processes are replaced |
| Clipboard token | One transaction | Close or recovery |
| Recovery record | Survives restarts and upgrades | `computer recover --apply` after proof |

A native observation authorizes one action within the server TTL, with target, geometry and focus checks at dispatch. Opt-in immediate read-only method verification can use validated post-action evidence within its stricter policy, but it cannot authorize future input. Settled checks, uncertain results and final effect verification need fresh observations. See the [method API](../src/method/README.md) for callback and checkpoint obligations.

## Error codes

These codes are stable: clients may branch on `error.code` for them, and renaming one needs a major. Any other code is diagnostic and may change. New codes are additive. A code never overrides `outcome`, so read both.

| Group | Code | Meaning | Next step |
|---|---|---|---|
| Session | `desktop_busy` | A session holds the desktop lease | Close it, or wait |
| | `unknown_session` | The `sessionId` is not open | Open a session |
| | `unknown_window` | No current window has this ID | List windows |
| | `window_changed` | The window closed, or its process identity changed | Open a new session |
| | `window_identity_changed` | A native check saw a different window or process | Open a new session |
| | `session_stopped` | The native owner stopped the session | Verify cleanup, then close |
| | `no_owned_modal` | `followModal` found no owned dialog | Observe normally |
| Observation | `stale_observation` | The ID is not the latest, is used, or has expired | Observe again |
| | `stale_element` | The element is not in the current tree, or its binding changed | Observe again, or raise depth |
| | `unknown_element` | The element is not an enabled one from this observation | Choose from this observation |
| | `element_not_found` | The scope root is gone | Observe without `rootElementId` |
| | `ambiguous_element` | The target matches more than one control | Choose a unique control |
| Target | `window_moved` | The window moved or did not settle | Observe again |
| | `window_minimized` | The window is minimized | Restore it, then observe |
| | `window_blocked` | The window is disabled, usually by its dialog | Select the enabled dialog |
| | `focus_changed` | Focus differs from the expected control | Observe again |
| | `foreground_not_target` | Windows did not activate the window | Observe again |
| | `target_occluded` | A menu, tooltip or popup covers the point | Close it, or use the keyboard |
| Input | `unsupported_action` | The action form is not supported | Check `support` |
| | `invalid_arguments` | Arguments were refused, including system-reserved keys | Fix the request |
| | `supervision_required` | This input form needs a ready native owner | Check doctor |
| | `text_not_delivered` | Typed text was not found in the control. `outcome` is `unknown` | Read the control before typing again |
| | `input_busy` | Declared input was already held. No input was sent | Release it, then retry |
| | `native_timeout` | A native command timed out. An act's `outcome` is `unknown` | Observe again. Open a new session if it repeats |
| Recovery | `input_recovery_required` | Input cleanup is unconfirmed | Run `computer recover --check` |
| | `input_recovery_failed` | Input release was not confirmed | Run `computer recover --check` |
| | `release_pending_recovery` | Doctor `supervision.code`: a failed release waits for close | Run `computer recover --check`, then close the session |
| | `recovery_record_invalid` | Durable recovery state is unreadable. Input stays quarantined | Stop input and tell the owner |
| Launch | `application_unsupported` | The URI, path or Settings page is not allowed | Use a supported form |
| | `unknown_application` | No registered app has this name | Check the name |
| | `ambiguous_application` | Several registered EXEs have this name | Use a more exact target |
| | `application_already_attempted` | The last launch outcome was unknown | List windows. Do not relaunch |
| | `already_running` | The app already has a window. Nothing was touched | List windows |
| Setup | `engine_unavailable` | The pinned engine could not start | Run setup |
| | `engine_integrity` | A pinned engine file failed its hash | Run setup |
| | `bridge_unavailable` | The window bridge is not built | Run setup |
| | `bridge_stale` | Bridge source changed since the build | Run setup |
| | `supervisor_unavailable` | The native supervisor is not built or did not start | Run setup |
| | `supervisor_stale` | Supervisor source changed since the build | Run setup |
| | `indicator_runtime` | The required .NET Desktop runtime is missing | Install it |

Method API failures use their own hyphenated codes, such as `support-unsupported`. They are not part of this catalog.

## Deprecation

To retire something covered by the Stable tier:

1. Announce it in a minor: in the release notes, in the list below and, from the next release, in the doctor `deprecations` list.
2. Keep it working through that major.
3. Remove it no earlier than the next major, with migration notes.

**Currently deprecated:** nothing.

## Older releases

Only the latest published release gets fixes. Older release assets stay available.

Package `1.x` kept its documented forms and meanings. `2.x` keeps them except for the act result, which the [2.0.0 boundary](COMPUTER_USE.md#v2-compatibility-boundary-200) describes with its migration notes.

Client code such as `act-compat.cjs` supports the current and previous major, so 1.x support can be removed at `3.0.0`.

### Upgrading

1. Resolve `computer recover --check` first. The recovery record is the only state that crosses versions.
2. Install the new version and run `npm run computer:setup -- --apply` when the release notes say helpers changed.
3. Reconnect the host's MCP connection.

## Support matrix

Tested means tested: each row lists actual evidence with its date and scope. A later host, OS or runtime version is not promised.

| Area | Supported | Evidence |
|---|---|---|
| OS | Windows 11 x64. Windows 10 is not claimed | Last verified on build 10.0.26200, plus CI `windows-latest`. Release receipts should record the runner image |
| Node | `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0` | CI runs Node 26. Node 22 and 24 are allowed but not yet tested |
| .NET | .NET 9 SDK and Desktop runtime | CI 9.0.x. See the [known limit](#known-limit-net-9) |
| Engine | winapp `0.7.1`, exact | Live and CI |
| Display | One display at 144 DPI. Wider DPI and monitor support is not claimed | 1920×1080 and 2880×1800 receipts. Nothing refuses other setups at runtime |
| Desktop | Unlocked interactive desktop. No secure or elevated targets | Live |
| Phone | Experimental: one owner phone | Samsung S23 Ultra, SDK 37 |

### Hosts

| Host | Status | Last verified | Scope |
|---|---|---|---|
| Claude Code | Verified | 23 October 2026, host 2.1.309, before 2.0 | HOST-01 workflow with isolated configuration. Drove the 3 November head-to-head on TRACE 2.0.0, which is task evidence and not HOST-01 acceptance |
| Codex | Verified | 23 October 2026, before 2.0. Host version not recorded | HOST-01 workflow |
| Grok Build | Configured, unverified | None | Configuration only |
| Gemini CLI | Configured, unverified | None | Configuration only |

Browser, application, clipboard and artifact providers are optional and supplied by the host. The [method README](../src/method/README.md) states their tested scope.

### Known limit: .NET 9

Microsoft lists .NET 9 end of support as 10 November 2026. TRACE's four native helpers target `net9.0-windows`, and doctor requires a .NET 9 Desktop runtime, so a machine with only .NET 10 fails doctor. TRACE keeps working after that date, but .NET 9 stops getting patches. Moving to .NET 10 is planned as its own change before the next release.
