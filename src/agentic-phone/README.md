# agentic-phone

The phone link under TRACE Phone: everything that talks to an Android phone over adb and makes it
fast. It has no TRACE imports, so it can move to its own repo later with `git filter-repo`.

| File | What it does |
|---|---|
| `adb.cjs` | Talks to the adb server socket directly: devices, connect, pair, mdns, `exec:`, sync push, `localabstract:` streams. |
| `agent.cjs` | Frames requests to the on-device agent. |
| `controller.cjs` | Starts the agent, checks its version, reconnects once, saves frames, maps coordinates, acts then settles. |
| `build.cjs` | Compiles `native/` into `.runtime/phone/build/classes.dex` (run through `node scripts/build-phone-agent.cjs`). |
| `native/` | The on-device Java agent (`trace.phone`), the Wi-Fi trust watcher (`trace.phone.WifiTrust`) and `bench.cjs`, a read-only benchmark. |

## Boundary

- Node built-ins and files inside this folder only. `tests/agentic-phone-boundary.test.cjs` fails otherwise.
- TRACE owns everything Claude-facing: the MCP server (`src/phone/server.cjs`, served by
  `trace-workbench phone mcp`), `skills/trace-phone/`, the phone install, permission and hook
  scripts, and the policy and handoff docs.
- Speed and link fixes go here; tool schemas, skill text and approvals go in TRACE.
