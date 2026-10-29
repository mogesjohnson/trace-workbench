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

### Cleanup result contract (V1 development)

A successful close returns `{ sessionId, closed: true, cleanup: 'confirmed' }`. Native confirmation and normal owner exit are both required. Process exit alone, a missing acknowledgment, or a transport/projection failure cannot confirm cleanup. Uncertain cleanup returns a tool error with `cleanup: 'unknown'`, `inputRecoveryRequired: true` and available bounded recovery details. Recovery codes and boolean fields are allowlisted; private native payloads are omitted.

The method adapter requires explicit confirmation, including when connected to an older server. It retains uncertain close results across repeated calls and blocks further observations through that provider. Independently resolve recovery, then discard the failed provider and reconnect its server before starting a new session. Reconnection alone does not resolve recovery. Whole-controller shutdown also retains its original failed result across repeated calls.

Cleanup confirmation concerns the owned session and input lifecycle. It does not prove the intended application effect or settle a deferred clipboard transaction. Existing observation freshness, input quarantine and clipboard obligations still apply. The six tools and supported Windows/display scope remain unchanged; these development changes do not publish a new release.

The server supports activation, coordinate/element clicks, typing, allowed key chords, vertical wheel scrolling, dragging, accessibility invocation and editable values. Actual tested coverage and limitations are recorded in [verification](VERIFICATION.md) and [the specification](../SPEC.md).

### Effective action limits (V1 development)

Literal text accepts 1–8192 UTF-16 code units; editable values accept 0–8192. Neither accepts NUL. Element IDs accept 1–512 units. Keys accept case-insensitive Ctrl/Control, Alt and Shift chords with letters, digits, F1–F12 and the existing navigation/edit keys; Return maps to Enter. INSERT, Windows-key chords and multi-command key scripts are unsupported. The shared validator applies the same limits to the method adapter, controller and native backend before native helper work.

Wheel input requires `deltaX: 0` and a nonzero `deltaY` in 120-unit steps from -2400 to 2400; positive means down. The requested point selects the smallest enabled onscreen observed element containing it, and the wheel executes at that element's center. This is not exact point scrolling. Unsupported static requests fail before consuming the native observation or method attempt. Current geometry, element, modal and focus checks still run before dispatch; validation does not guarantee target readiness or application effect.

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

```powershell
npm run check
npm test
npm run test:computer:mcp
```

The stdio check discovers tools and calls diagnostics without controlling an app. The opt-in `npm run test:computer:live` builds and opens an owned WinForms fixture, operates only that window, records local frames and shuts it down. Each run gets a fresh evidence directory; explicit report paths also require a new directory so failed attempts remain intact. It is separate from normal CI and from a live model-host acceptance test.
