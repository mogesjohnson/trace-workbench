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

## Select a local ADB server for MCP

TRACE Phone uses `127.0.0.1:5037` by default. To use an existing private loopback ADB
server, set `TRACE_PHONE_ADB_PORT` in the MCP server's launch environment. For example,
with an ADB server already listening on port 15037, run this in PowerShell.

```powershell
$env:TRACE_PHONE_ADB_PORT = '15037'
node bin/trace.cjs phone mcp
```

The port must be a decimal integer from 1 through 65535. Invalid values fail startup.
TRACE Phone uses the selected port for every ADB request in the MCP session. If the
selected server is unreachable, device discovery reports the connection error.
