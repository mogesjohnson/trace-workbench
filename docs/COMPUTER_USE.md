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

Engine setup downloads Microsoft winapp CLI `0.7.1`, checks the pinned archive and native-file hashes, and builds TRACE's public Win32 window bridge and screen-edge activity marker under ignored `.runtime/` storage. The marker builds against an empty local package feed. Setup does not install global tools or change PATH. After helper source changes, rerun setup before using them; diagnostics verify source/output hashes without opening UI.

Configuration adds `trace-computer` to Codex, Claude Code, Grok Build and Gemini CLI. It preserves unrelated parsed settings, creates exact-byte `.trace.backup.*` files, and refuses conflicting server entries or skill content. TOML layout is preserved where possible; inline-table layouts may be normalized. Inspect reported partial progress before retrying a failed write.

Use identical repeated `--client` options with both plan and apply to narrow the scope. Client names are `codex`, `claude_code`, `grok_build`, and `gemini_cli`.

The configured command is the installed Node executable plus this checkout's absolute `bin/trace.cjs computer mcp` path. Keep the checkout and locked dependencies available. Reconnect the host's MCP connection after installation or code updates. The server runs over stdio; it does not supply a reasoning model.

## Use the tools

1. Check `trace_computer_doctor`, then discover windows with `trace_computer_list_windows`.
2. Open a session for the exact returned `windowId`. A cyan-to-violet screen-edge glow indicates TRACE owns a desktop session. It stays above activated windows until session cleanup.
3. Observe and inspect the returned PNG and accessibility elements. `accessibilityDepth` (1–32, default 8) reads deeper trees; the response reports the effective depth and truncation, and the action reuses that depth.
4. Perform one action with that `sessionId` and latest `observationId`. Coordinates are integer pixels relative to the returned image; element bounds are physical screen coordinates.
5. Inspect the new observation before continuing. `not_dispatched` means the requested input was never sent (any preparatory activation is listed separately); `unknown` means it may have been. After either, observe again before deciding; never replay automatically.
6. Close the session to release desktop ownership. The target application remains open.

The server supports activation, coordinate/element clicks, typing, allowed key chords, vertical wheel scrolling, dragging, accessibility invocation and editable values. Actual tested coverage and limitations are recorded in [verification](VERIFICATION.md) and [the specification](../SPEC.md).

## Storage and recovery

Frames and a metadata journal are stored locally under the OS user's TRACE computer-data directory. `TRACE_COMPUTER_RUNTIME` can select another absolute artifact directory; this does not change the global per-user desktop lease. Journals omit typed text, editable values and screenshot bytes. Frames themselves can contain private content.

A live session retains its desktop lease until closed or disconnected. Windows releases the named-pipe lease after process termination. Cancelled/failed input returns an unknown outcome when delivery cannot be established; re-observe before deciding whether to retry. Human activity or other automation can still change the desktop.

The marker does not activate a window or intercept clicks. If it cannot start, the session is rejected. If it exits unexpectedly, TRACE stops further input and cancels in-flight work. Verify the action outcome and cleanup, then close the failed session before reopening. The glow shows desktop ownership; it does not isolate the user from input. [Background worker research](BACKGROUND_WORKER.md) records the separate VM/PC proposal and acceptance requirements.

Interrupted pointer gestures get a short drain interval, then owned-process termination and left-button recovery after confirmed exit. Failed recovery blocks further input in that server and reports `input_recovery_required`. This quarantine is process-local: check the owned process and mouse state before restarting or switching servers. The alpha.3 held-drag test verifies a native cancellation/release primitive followed by a click. It bypasses MCP action cancellation; full live cancellation, timeout, disconnect, server-crash and failed-cleanup acceptance remain pending. Lease-release unit tests do not prove physical input cleanup after a server crash.

To recover configuration, close the affected host, restore its matching backup, and reconnect. Restore the shared skill and discovery copies together if rolling back. Existing differing entries are reported as conflicts rather than silently replaced.

## Verify

```powershell
npm run check
npm test
npm run test:computer:mcp
```

The stdio check discovers tools and calls diagnostics without controlling an app. The opt-in `npm run test:computer:live` builds and opens an owned WinForms fixture, operates only that window, records local frames and shuts it down. Each run gets a fresh evidence directory; explicit report paths also require a new directory so failed attempts remain intact. It is separate from normal CI and from a live model-host acceptance test.
