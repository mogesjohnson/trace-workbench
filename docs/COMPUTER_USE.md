# Computer Use

TRACE's `trace-computer` MCP server exposes six tools for a Windows agent: diagnostics, window discovery, session opening, observation, one action, and session closing. The companion [skill](../skills/trace-computer-use/SKILL.md) explains the observe/act workflow.

## Install and connect

Requires Windows x64, a Node.js version allowed by `package.json`, .NET 9 SDK with Windows Desktop reference pack, and .NET 9 Desktop runtime. Run from the repository:

```powershell
npm ci
npm run computer:setup -- --plan
npm run computer:setup -- --apply
npm run computer:doctor
npm run computer:config -- --plan
npm run computer:config -- --apply
```

Engine setup downloads Microsoft winapp CLI `0.7.1`, checks the pinned archive and native-file hashes, and builds TRACE's public Win32 window bridge, screen-edge activity marker, native input supervisor and text-only clipboard helper under ignored `.runtime/` storage. Helpers build against an empty local package feed. Setup does not install global tools or change PATH. After helper source changes, rerun setup before using them; diagnostics verify source/output hashes without opening UI or reading clipboard contents.

Configuration adds `trace-computer` to Codex, Claude Code, Grok Build and Gemini CLI. It preserves unrelated parsed settings and refuses conflicting server entries or skill content. Client settings retain exact-byte `.trace.backup.*` files. Complete skill bundles use per-file ownership hashes and exact backups under the private `.trace/skill-backups` directory outside skill discovery. TOML layout is preserved where possible; inline-table layouts may be normalized. Inspect reported partial progress before retrying a failed write.

Use identical repeated `--client` options with both plan and apply to narrow the scope. Client names are `codex`, `claude_code`, `grok_build`, and `gemini_cli`.

The configured command is the installed Node executable plus this checkout's absolute `bin/trace.cjs computer mcp` path. Keep the checkout and locked dependencies available. Reconnect the host's MCP connection after installation or code updates. The server runs over stdio; it does not supply a reasoning model.

## Use the tools

1. Check `trace_computer_doctor`, then discover windows with `trace_computer_list_windows`.
2. Open a session for the exact returned `windowId`. A cyan-to-violet screen-edge glow indicates TRACE owns a desktop session. It stays above activated windows until session cleanup.
3. Observe and inspect the returned PNG and accessibility elements. `accessibilityDepth` (1–32, default 8) reads deeper trees; the response reports the effective depth and truncation, and the action reuses that depth.
4. Perform one action with that `sessionId` and latest `observationId`. Coordinates are integer pixels relative to the returned image; element bounds are physical screen coordinates.
5. Inspect the new observation before continuing. `not_dispatched` means the requested input was never sent (any preparatory activation is listed separately); `unknown` means it may have been. After either, observe again before deciding; never replay automatically.
6. Close the session to release desktop ownership. The target application remains open.

### Cleanup result contract (V1)

A successful close returns `{ sessionId, closed: true, cleanup: 'confirmed' }`. Native confirmation and normal owner exit are both required. Process exit alone, a missing acknowledgment, or a transport/projection failure cannot confirm cleanup. Uncertain cleanup returns a tool error with `cleanup: 'unknown'`, `inputRecoveryRequired: true` and available bounded recovery details. Recovery codes and boolean fields are allowlisted; private native payloads are omitted.

The method adapter requires explicit confirmation, including when connected to an older server. It retains uncertain close results across repeated calls and blocks further observations through that provider. Independently resolve recovery, then discard the failed provider and reconnect its server before starting a new session. Reconnection alone does not resolve recovery. Whole-controller shutdown also retains its original failed result across repeated calls.

Cleanup confirmation concerns the owned session and input lifecycle. It does not prove the intended application effect or settle a deferred clipboard transaction. Existing observation freshness, input quarantine and clipboard obligations still apply. The six tools and supported Windows/display scope remain unchanged; the [V1 release notes](RELEASE_1.0.0.md) distinguish candidate readiness from publication.

The server supports activation, coordinate/element clicks, typing, allowed key chords, wheel scrolling, dragging, accessibility invocation and editable values. Development extensions for supervised buttons/double-click and opt-in point/horizontal wheel are described below; they are not new published 1.1.0 acceptance. Actual tested coverage and limitations are recorded in [verification](VERIFICATION.md) and [the specification](../SPEC.md).

### Effective action limits (V1)

Literal text accepts 1–8192 UTF-16 code units; editable values accept 0–8192. Neither accepts NUL. Element IDs accept 1–512 units. Keys accept case-insensitive Ctrl/Control, Alt and Shift chords with letters, digits, F1–F12 and the existing navigation/edit keys; Return maps to Enter. INSERT, Windows-key chords and multi-command key scripts are unsupported. The shared validator applies the same limits to the method adapter, controller and native backend before native helper work.

Omitting wheel `placement` preserves legacy input: `deltaX: 0`, nonzero `deltaY` in 120-unit steps from -2400 to 2400, positive down. Its requested point selects the smallest enabled onscreen observed element; input occurs at the element center. This default is unchanged.

Development item 12 adds `placement: 'point'` with both deltas in bounded 120-unit steps,
allowing zero on one axis but not both. Positive X is right and positive Y is down.
One action inserts Y then X at the requested image point, converted to physical screen
coordinates without replacing it with a UIA element center. A matching element is not
required, but observation still requires a readable UIA root. This mode requires the
native supervisor and rebuilt source-matched helpers, with no unsupervised fallback.
Discover the connected schema and optional `support.actions.scroll.point`; older servers
reject the field and cannot acquire invented support through the adapter.

Development item 11 adds optional click `button: 'left' | 'right' | 'middle'` and
`count: 1 | 2`, with count 2 left-only. Omitted/default single-left forms retain old
paths. New variants require supervision and use one complete native event sequence
per observation; element targets use their revalidated physical center. See the
[pointer foundation](POINTER_INPUT.md) for admission, selected-button recovery and limits.

Unsupported static requests reject before consuming observations/attempts. Identity,
geometry, modal, activation and target-hit guards remain; partial insertion or lost
receipts remain unknown, without automatic replay. New source/synthetic checks do not
establish live menu, middle/double-click, two-pane wheel or interruption acceptance.

### Scoped V4 live checkpoint — 31 October 2026

An owner-approved corrected visible-fixture attempt tested cumulative source
`c61da3aeaecb996857de983e32b0d1b9fe2ed83e`, including items 11/12. Node 26.2.0,
Windows x64, verified winapp 0.7.1 and one 1920×1080 display at 144 DPI were used.
Source/runtime hashes matched before/after; root reviewed initial pixels and retained
before/after frames plus independently published app state.

| Case | Independently checked result | Status |
|---|---|---|
| right-menu | Left-pane right count 0→1; actual context menu visible | pass |
| middle | Left-pane middle count 0→1 | pass |
| left-double | Double count 0→1; two native downs and ups | pass |
| left-y-down | Left Y 500→620; other pane unchanged | pass |
| right-y-up | Right Y 500→380; other pane unchanged | pass |
| left-x-right / left-x-left | Left X 500→620→500; other pane unchanged | pass |
| right-xy | Right X 500→620 and Y 380→500 | pass |
| held-right / held-middle cancellation | Unknown delivery retained; owned child exit and declared release confirmed; independently all-up | pass |
| distinct fresh right/middle followups | Right-pane selected count 0→1 for each, after cleanup and fresh observation | pass |

Session close, native owner/marker/fixture exits, fixture exit 0, all-up input and clear
recovery were confirmed. One preparatory fixture activation occurred. No compatible
old workflow was repeated. Successful private receipt SHA-256:
`8c2cfeaafe9993ef0cc9e90d93755da1db3371d54881cb19610980fa09d237e3`.

The original and corrective preflights both stopped before session/input because the
hidden fixture was absent from discovery; both remain blocked. Direct owner approval
preceded the new visible-fixture attempt. Its private launcher adds a native-visibility
gate; product code was unchanged between the blocked and successful runs.

Scope limits: live click variants used points; element variants have synthetic routing
checks. Menu visibility is app-state evidence: the retained root-window PNG omits the
popup. The element-center contrast is a geometry inference, not an old-wheel rerun.
Cancellation uses a private held-input replacement through production MCP/controller/
supervision; this is not every failure cell or interrupted-double acceptance. The driver
was explicitly interrupted after its saved receipt and confirmed native cleanup because
terminal stdin stayed open; no natural driver exit is claimed. Publication remains separate.

`trace_computer_doctor.support` declares version 1 of TRACE's wrapper contract for pinned winapp 0.7.1: action forms, limits, key syntax, coordinate origin and observation requirements. It describes intended support, not installed provider identity or successful target control. The diagnostic's existing engine/version and `readiness.native` report the actual backend check; `readiness.target.ready: null` means the target has not been checked.

The method adapter separately reports configured transport/schema compatibility, native runtime readiness and unchecked target readiness. Missing providers retain an unavailable reason. An older server without a support descriptor remains usable under local conservative validation, with support explicitly unknown. Incomplete, contradictory or unsupported descriptors disable the adapter; compatible descriptors expose only the known local contract. This does not install browser, application or artifact providers. JSON Schema string lengths count Unicode code points, so field descriptions declare UTF-16 units and the MCP handler enforces the shared runtime limit before reaching the controller.

The adapter reports the accepted server's observation TTL; the native server enforces it. The method coordinator retains its separate freshness guard. Capability discovery does not certify that an individual capture is still fresh at dispatch.

## V1 compatibility boundary

For the development branch's opt-in current-session capture policy, see
[capture retention](CAPTURE_RETENTION.md). The published V1 archive is unchanged.

The V1 stable wrapper contract covers these six public tool names and their advertised strict input schemas: `trace_computer_doctor`, `trace_computer_list_windows`, `trace_computer_open_session`, `trace_computer_observe`, `trace_computer_act` and `trace_computer_close_session`. Inspect the connected server's schemas; unsupported fields are rejected. The supported action forms, units and limits above are part of that contract.

Results carry matching JSON text and `structuredContent`. Screenshot metadata indexes a PNG block in the original complete MCP `content` array; filtering consumers must explicitly remap that index. The method adapter validates image metadata/hash, observation/session and process lifetime before exposing its remapped image array. This checks association, not producer authenticity, full PNG decoding or semantic image understanding. No formal MCP output JSON schemas are advertised.

`completed` reports action delivery; `not_dispatched` requires proof that primary input never began; `unknown` preserves possible delivery. Preparation, cleanup and independently verified application effects remain separate. Errors may include bounded recovery fields; missing cleanup confirmation or an unreadable response must not become proof of safe cleanup. Unknown outcomes never authorize automatic replay.

Native observations authorize one action within the server TTL (default 60 seconds), with target/geometry/focus checks at dispatch. Opt-in immediate read-only method verification can use validated post-action evidence within its stricter age/field/lifecycle policy; it cannot authorize future input. Settled checks, uncertain results and final effect verification require fresh observations. See [the method API](../src/method/README.md) for callback and checkpoint obligations.

Package `1.x` preserves these documented forms and meanings. Additive optional diagnostic/result fields are compatible; clients should tolerate unknown result metadata while requiring known authority and cleanup proof. Removing accepted inputs/tools or changing units, authority, outcome or cleanup meanings requires a new major package version and migration notes. Reject unsupported action/support versions rather than guessing. Schema string lengths count code points; shared runtime UTF-16 validation remains authoritative.

`support.contractVersion: 1` identifies the declared TRACE action-support descriptor, separately from the package version, MCP protocol version and pinned engine version. Unknown legacy support remains explicitly unknown; contradictory descriptors disable the method route. Internal helpers, transient evidence tokens and native implementation files are not a serialized compatibility surface. Skill guidance is shipped as a manifest-owned bundle; source changes alone do not prove personal installed copies were updated.

## Selective observations (V2 development)

`trace_computer_observe` accepts optional `mode: 'full' | 'accessibility' | 'screenshot'`. Omission or `full` preserves the existing combined PNG/controls response and single-use input authority. Both selective modes return a fresh evidence ID with `mode` and `actionable: false`; they revoke the prior full observation and cannot authorize any action, including activation, keys or element actions. Request and inspect a fresh full observation before input. Failed selective capture also leaves prior authority revoked; invalid mode/depth rejected before observation does not consume it.

`accessibility` returns controls/depth, focus, target state and physical bounds without screenshot, capture-method or pixel-coordinate provenance. The backend skips the screenshot command; no PNG file, stat/read, hash/base64 or MCP image is produced. `screenshot` returns PNG evidence plus window/focus/target metadata, omitting public `elements` and `accessibility`. Its internal UIA inspection still uses `accessibilityDepth` (default 8, range 1–32); it saves output payload, not UIA work.

All modes retain readable UIA root, identity, ownership, geometry and focus checks. Observation can restore/focus the target; evidence-only does not mean free of desktop side effects. This does not support apps without readable UIA roots, which remains a separate roadmap item. Action refresh stays full at the retained depth; the existing method adapter continues requesting full and keeps strict image validation. Discover the live `mode` schema and additive `doctor.observationModes` metadata before using selective modes; older servers reject the new input. The V1 action-support descriptor and published v1.0.0 archive are unchanged.

Synthetic tests verify omitted native capture/PNG work, authority invalidation, retained guards and MCP image projection. No live latency improvement, new native acceptance or V2 release is claimed.

## Storage and recovery

Frames and a metadata journal are stored locally under the OS user's TRACE computer-data directory. `TRACE_COMPUTER_RUNTIME` can select another absolute artifact directory; this does not change the global per-user desktop lease. Journals omit typed text, editable values and screenshot bytes. Frames themselves can contain private content.

The current implementation starts a detached native supervisor per desktop session. It owns the global per-user lease and marker and assigns each operation child to a kill-on-close job while suspended. Mutating input has a durable encrypted recovery record before execution. Session readiness and operation completion are published only after their corresponding native lifecycle gates. Cancelled/failed input returns an unknown outcome when delivery cannot be established; re-observe before deciding whether to retry. Human activity or other automation can still change the desktop.

The marker does not activate a window or intercept clicks. If it cannot start, the session is rejected. If it exits unexpectedly, TRACE stops further input and cancels in-flight work. Verify the action outcome and cleanup, then close the failed session before reopening. The glow shows desktop ownership; it does not isolate the user from input. [Background worker research](BACKGROUND_WORKER.md) records the separate VM/PC proposal and acceptance requirements.

Interrupted operations get a bounded drain interval, job termination and exit verification before declared keyboard/buttons are balanced. Failed or unconfirmed cleanup retains per-user recovery state across controllers and artifact directories. Restarting a server does not clear it. Inspect and apply recovery with:

```powershell
node bin/trace.cjs computer recover --check
node bin/trace.cjs computer recover --apply
```

Inspection does not clear state. Apply validates recorded process creation/user/session identity, confirms owned-process exit and verifies input release before clearing. Unavailable foreground/desktop input access remains unresolved. Physical Escape during held mouse and keyboard input has passed scoped acceptance; a separate injected Escape case remained an ordinary action. [The gap-closure checkpoint](GAP_CLOSURE_STATUS.md) distinguishes source, ordinary operation and recovery receipts. Controlled held-mouse timeout, chord cancellation and failed-acknowledgement mouse quarantine also have passing MCP evidence with independent release and exact follow-up; other recovery cells remain incomplete. The historical alpha.3 primitive is not substituted for those cases.

The [method library](../src/method/README.md) composes these six tools with ready structured-browser, application-recipe and artifact providers. Its canonical guidance is installed as one manifest-owned skill bundle. A supplied Playwright Page and host-specific application ownership inspector remain explicit runtime dependencies; installing instructions alone cannot provide them. Clipboard transactions are explicitly text-only and reject unsupported formats before mutation. Before any native paste, durably defer automatic restoration; acknowledge input quiescence only after owned native cleanup is independently confirmed. Helper EOF or close then preserves recovery instead of exposing private original bytes to an uncertain late paste. Actual paste/restoration acceptance is separate from native input acceptance.

To recover configuration, close the affected host, restore its matching backup, and reconnect. Restore the shared skill and discovery copies together if rolling back. Existing differing entries are reported as conflicts rather than silently replaced.

## Verify

[Observation metrics and the fixed measurement recipe](OBSERVATION_METRICS.md) describe numeric cost diagnostics. Preparing instrumentation does not establish a latency improvement or start a desktop benchmark.

```powershell
npm run check
npm test
npm run test:computer:mcp
```

The stdio check discovers tools and calls diagnostics without controlling an app. The opt-in `npm run test:computer:live` builds and opens an owned WinForms fixture, operates only that window, records local frames and shuts it down. Each run gets a fresh evidence directory; explicit report paths also require a new directory so failed attempts remain intact. It is separate from normal CI and from a live model-host acceptance test.
