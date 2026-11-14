# agentic-phone

The phone link under TRACE Phone: everything that talks to an Android phone over adb and makes it
fast. It has no TRACE imports, so it can move to its own repo later with `git filter-repo`.

| File | What it does |
|---|---|
| `adb.cjs` | Talks to the adb server socket directly: devices, connect, pair, mdns, `exec:`, sync push, `localabstract:` streams. |
| `agent.cjs` | Frames requests to the on-device agent. |
| `controller.cjs` | Starts the agent, checks its version, reconnects once for reads and accessibility release, saves frames, maps coordinates, acts then settles. |
| `build.cjs` | Compiles `native/` into `.runtime/phone/build/classes.dex` (run through `node scripts/build-phone-agent.cjs`). |
| `native/` | The on-device Java agent (`trace.phone`), the Wi-Fi trust watcher (`trace.phone.WifiTrust`) and `bench.cjs`, a read-only benchmark. |

The rebuilt agent asks Android's compositor for full-screen captures at the requested
image size. Crops use native-sized capture before resizing. If the device cannot supply
scaled frames, the agent tries the native-sized compositor path. If the compositor fails,
it uses `screencap` for the rest of that agent process. `captureBackend` identifies the
path and `hashBasis` identifies the geometry used for pixel comparison. A change in basis
restarts the comparison. Rebuild the dex and restart the Phone session to use the new
capture path.

Use `phone_wait({ image: false })` for the wait outcome, frame count, final hash and device
dimensions without encoding, transferring or saving a screenshot. The latest observed hash
becomes the baseline for subsequent waits. If the wait fails or the final frame differs
from the last image, call `phone_screen` to get fresh image coordinates.

Each action sends input at most once. If delivery is unknown or the agent acknowledges input and
the settle fails, take a fresh observation and verify the phone state before taking another action.

## Boundary

- Node built-ins and files inside this folder only. `tests/agentic-phone-boundary.test.cjs` fails otherwise.
- TRACE owns everything Claude-facing: the MCP server (`src/phone/server.cjs`, served by
  `trace-workbench phone mcp`), `skills/trace-phone/`, the phone install, permission and hook
  scripts, and the policy and handoff docs.
- Speed and link fixes go here; tool schemas, skill text and approvals go in TRACE.

## Get the first frame in one call

Set `TRACE_PHONE_SERIAL` in the MCP server's launch environment to an exact, already-ready
ADB serial. For Claude Code on this phone, the serial is `127.0.0.1:5555`. The first
`phone_screen` checks that exact target, starts the agent if needed, and returns the frame.
Later calls reuse that session. Pairing and switching devices require a server without this setting.

In a pinned session, UI reads and actions share one queue through action settle. If a UI
operation is pending, an overlapping `phone_act` returns before dispatch. Wait, observe,
then submit the next input. Independent work can run while the queue is active. Use one
MCP session for the phone's UI.

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
