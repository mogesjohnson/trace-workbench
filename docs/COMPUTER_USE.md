# Computer Use

TRACE's `trace-computer` MCP server exposes six tools for a Windows agent: diagnostics, window discovery, session opening, observation, one action, and session closing. The companion [skill](../skills/trace-computer-use/SKILL.md) explains the observe/act workflow.

## Install and connect

Requires Windows x64, a Node.js version allowed by `package.json`, and .NET 9 SDK/runtime. Run from the repository:

```powershell
npm ci
npm run computer:setup -- --plan
npm run computer:setup -- --apply
npm run computer:doctor
npm run computer:config -- --plan
npm run computer:config -- --apply
```

Engine setup downloads Microsoft winapp CLI `0.7.1`, checks the pinned archive and native-file hashes, and builds TRACE's public Win32 window bridge under ignored `.runtime/` storage. It does not install global tools or change PATH. If bridge sources change, rerun setup before using them.

Configuration adds `trace-computer` to Codex, Claude Code, Grok Build and Gemini CLI. It preserves unrelated parsed settings, creates exact-byte `.trace.backup.*` files, and refuses conflicting server entries or skill content. TOML layout is preserved where possible; inline-table layouts may be normalized. Inspect reported partial progress before retrying a failed write.

Use identical repeated `--client` options with both plan and apply to narrow the scope. Client names are `codex`, `claude_code`, `grok_build`, and `gemini_cli`.

The configured command is the installed Node executable plus this checkout's absolute `bin/trace.cjs computer mcp` path. Keep the checkout and locked dependencies available. Reconnect the host's MCP connection after installation or code updates. The server runs over stdio; it does not supply a reasoning model.

## Use the tools

1. Check `trace_computer_doctor`, then discover windows with `trace_computer_list_windows`.
2. Open a session for the exact returned `windowId`.
3. Observe and inspect the returned PNG and accessibility elements.
4. Perform one action with that `sessionId` and latest `observationId`. Coordinates are integer pixels relative to the returned image; element bounds are physical screen coordinates.
5. Inspect the new observation before continuing. After an unknown outcome, observe again and determine whether input already occurred.
6. Close the session to release desktop ownership. The target application remains open.

The server supports activation, coordinate/element clicks, typing, allowed key chords, vertical wheel scrolling, dragging, accessibility invocation and editable values. Actual tested coverage and limitations are recorded in [verification](VERIFICATION.md) and [the specification](../SPEC.md).

## Storage and recovery

Frames and a metadata journal are stored locally under the OS user's TRACE computer-data directory. `TRACE_COMPUTER_RUNTIME` can select another absolute artifact directory; this does not change the global per-user desktop lease. Journals omit typed text, editable values and screenshot bytes. Frames themselves can contain private content.

A live session retains its desktop lease until closed or disconnected. Windows releases the named-pipe lease after process termination. Cancelled/failed input returns an unknown outcome when delivery cannot be established; re-observe before deciding whether to retry. Human activity or other automation can still change the desktop.

Interrupted pointer gestures get a short drain interval, then owned-process termination and left-button recovery after confirmed exit. Failed recovery blocks further input in that server and reports `input_recovery_required`. This quarantine is process-local: check the owned process and mouse state before restarting or switching servers. The alpha.3 fixture run interrupted a held drag, confirmed the left-button release, and completed a later click. A crash of the TRACE server process during input remains covered by unit tests.

To recover configuration, close the affected host, restore its matching backup, and reconnect. Restore the shared skill and discovery copies together if rolling back. Existing differing entries are reported as conflicts rather than silently replaced.

## Verify

```powershell
npm run check
npm test
npm run test:computer:mcp
```

The stdio check discovers tools and calls diagnostics without controlling an app. The opt-in `npm run test:computer:live` builds and opens an owned WinForms fixture, operates only that window, records local frames and shuts it down. It is separate from normal CI and from a live model-host acceptance test.
