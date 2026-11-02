# TRACE Phone: handoff 1 (1 November 2026)

Goal (owner, 1 Nov 2026): add a **trace-phone** skill to TRACE Workbench that controls an Android
phone over adb faster and more precisely than plain adb, REA's `capture_adb_screen`, or
uiautomator. Optimize for three links, in this order of importance:

1. **Wi-Fi adb** (the owner's normal setup: PC ↔ phone over wireless debugging).
2. **On-phone agent**: Claude Code running on the phone in Termux → proot Debian, driving the
   same phone through adb on localhost.
3. USB (used now for development only).

State: **host side complete in session 3 (see the end); PR open, not merged.** The on-device agent source is in
`native/TracePhoneAgent/`. It was measured over USB, then hardened (see "Security"). The hardened
build has **not been run yet** because the session's permission check blocked restarting it.
Nothing was left running on the phone: the agent process, its dex, its log and the adb forward
were removed and checked.

## Code layout (2 November 2026)

The adb client, agent client, controller, on-device agent and dex build moved to
[`src/agentic-phone/`](../src/agentic-phone/README.md) (owner decision: one repo, separate folder,
split later only if a second project needs it). The MCP server stays at `src/phone/server.cjs`;
`node scripts/build-phone-agent.cjs` still works. Paths in the session notes below are historical.

## Measured baseline (S23 Ultra SM-S918U, Android 17 / SDK 37, 1440×3088, USB)

| Operation | Time | Bytes on the link |
| --- | --- | --- |
| `adb exec-out screencap -p` | 1460–1570 ms | 3.2 MB |
| of which on-device PNG encode | 1290 ms | — |
| `adb exec-out screencap` (raw) | 1270–1370 ms | 17.8 MB |
| of which on-device raw capture | 160 ms | — |
| `screencap \| gzip -1` | 883 ms | 6.2 MB |
| `uiautomator dump` | 2724 ms | 47 KB |
| `adb shell input keyevent` | 117–193 ms | — |
| `adb shell true` (round trip) | 87 ms | — |

Diagnosis: the "5–7 s per screenshot" is on-device PNG encoding of a 4.4-megapixel frame plus
moving megabytes over the link, plus process start per call. Over Wi-Fi, a raw 17.8 MB frame
would cost several seconds, so **pixels must be reduced on the phone**.

## Prototype design and results (USB, before hardening)

A persistent agent runs as the shell user via
`CLASSPATH=/data/local/tmp/trace-phone.dex app_process / trace.phone.Main trace-phone` and serves
an abstract local socket; the host reaches it with `adb forward tcp:<port> localabstract:trace-phone`.
One socket stays open; frames are length-prefixed JSON header + binary payload.

| Agent operation | Time (host round trip) | Payload |
| --- | --- | --- |
| `screen` JPEG q75, long side 1280 (597×1280) | 240–290 ms | 98 KB |
| `screen` with `ifChangedFrom` = same hash | 217 ms | 0 B |
| `screen` JPEG q60, long side 960 | 227 ms | 53 KB |
| `screen` WebP q70 1280 | 335 ms | 58 KB |
| `screen` PNG 1280 | 573 ms | 854 KB |
| `screen` region 1440×400 | 231 ms | 35 KB |
| `wait` until stable 300 ms | 643 ms (3 frames) | 0 B |
| `key` (direct injection) | 12 ms | — |

The image was checked visually: correct colours and orientation.
Capture (~200 ms: `screencap` spawn + CRC32 over the frame) now dominates. Encode is 17–50 ms.

Features in the source:

- `screen`: on-device crop → scale → JPEG/WebP/PNG; CRC32 frame hash that skips the status
  bar (clock changes) so "unchanged" costs 0 bytes.
- `wait`: polls on the phone until the screen changes or settles; no link traffic while waiting.
  Replaces fixed sleeps after taps.
- `tap`/`swipe`/`key`/`text` via `InputManager(Global).injectInputEvent` (hidden API, reflection).
- `ui`/`find`/`node` (**unmeasured**): a persistent `UiAutomation` connection
  (`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`) returning a compact element list (text, desc, id,
  bounds, centre, flags), selector search, and accessibility actions (click on the clickable
  ancestor, long_click, set_text, scroll). Expected to replace the 2.7 s `uiautomator dump`; the
  constructor is found by reflection (`Looper` or `Context` + `IUiAutomationConnection`) and
  may need `Looper.prepareMainLooper()` on SDK 37. TODO(verify).

## Hardened agent run (session 2, 1 Nov 2026, USB, owner-approved)

Review fixes: `wait until:"change"` without `from` now uses the first frame as the baseline;
`bench.cjs` writes to `.runtime/phone/` (Git-ignored); new `release` op drops the UiAutomation
connection. **While the agent holds UiAutomation, `uiautomator dump` fails** (one connection per
device); after `release` it worked (checked). The next `ui`/`find`/`node` reconnects.

UiAutomation works on SDK 37 through the `(int displayId, Looper, IUiAutomationConnection)`
constructor; `ActivityThread.systemMain()` is gone (a `(Context, …)` fallback uses a
looper-only `ContextWrapper`). The first read after connect returned 36 of 69 nodes (flags apply
asynchronously; `clearCache` made it worse), so connect now warms up until two traversals visit
the same number of nodes.

| Operation (settled screen) | Time (host round trip) | Payload |
| --- | --- | --- |
| `screen` JPEG q75 1280 | 195–217 ms | 56 KB |
| `screen` unchanged (`ifChangedFrom`) | 143 ms | 0 B |
| `screen` JPEG q60 960 / WebP q70 1280 | 202 / 265 ms | 32 / 29 KB |
| `wait stable 300 ms` | 538 ms (3 frames) | 0 B |
| `ui` first call (connect + warm-up) | 1470–1483 ms | 13 KB, 92 nodes |
| `ui` warm | 32–45 ms | 13 KB |
| `find text=…` warm | 18–40 ms | 0.1 KB |
| `release` | 13–36 ms | — |
| `key` 0 | 35–63 ms | — |

An animating page (Samsung battery-protection illustration) changed the hash on every frame, so
`wait stable` timed out there; on settled screens it met in 3 frames. TODO: a host-side
`ignoreRegion` or a changed-rectangle in replies would let callers mask such animations.
Agent stopped, dex/log and forward removed after the run (checked).

## Node host (session 2)

`src/phone/adb.cjs` talks to the adb server socket directly (no adb.exe per call): devices,
connect, pair, mdns, `exec:` (28 ms vs 87 ms for `adb shell true`), sync push, and
**`localabstract:` streams, so no `adb forward` is needed** (opened in 3 ms on USB).
`src/phone/agent.cjs` frames requests; `src/phone/controller.cjs` starts the agent when absent
(push + spawn), checks the version, retries once on a dropped link, saves every frame to
`.runtime/phone/frames/`, maps image coordinates with the last `scale`/region, and does
act-then-settle in one call. `stop()` kills the agent by the `pid` from `hello` and removes the dex
(closing the exec stream alone left the process alive for at least 0.5 s). Tests:
`node --test tests/phone.test.cjs` (fake adb + fake agent socket), 9 pass.
Live-checked on the S23 over USB: push, spawn, open, hello, screen (245–300 ms, 59 KB).
The `pid` field is added in source but **not yet run on the device** (rebuild first).
`npm test` as a whole fails here with MODULE_NOT_FOUND in `src/computer/configuration.cjs`
(no `node_modules` in this worktree; run `npm ci` first). Not caused by the phone code.

Still to do: `scripts/build-phone-agent.cjs` (javac + d8 into `.runtime/phone/build/`, JBR
not the PATH java 8), MCP server `trace-workbench phone mcp` (tools from step 3, on the
controller), `skills/trace-phone/` + `SKILLS.md`, Wi-Fi bench, PR.

## Security (why the run was blocked, and the fix)

Abstract sockets are reachable by **every app on the phone**, and the agent holds shell rights.
The first prototype also had an `exec` operation: that was a local privilege escalation for any
installed app. Fixed in the source:

- `exec` removed. The host already has `adb shell` for commands.
- Connections are accepted only from uid 2000 (shell: adbd, which carries both USB and Wi-Fi
  forwards) or 0, plus **one uid the owner names** as the second argument (for Termux).

Before running again, the owner should approve running this agent on the phone (it injects input
and reads the screen while it runs) and, if needed, add a permission rule.

## Next steps

1. Owner approves the agent run. Build: `javac --release 11 -cp <sdk>/platforms/android-36/android.jar`
   then `java -cp <sdk>/build-tools/37.0.0/lib/d8.jar com.android.tools.r8.D8 --release
   --min-api 26 --lib <android.jar>`. Push, start, forward, run `bench.cjs` (read-only ops).
   Measure `ui`/`find`; fix the UiAutomation constructor/looper if it fails.
2. **Wi-Fi numbers**: the owner unplugs USB after development; rerun the bench over
   `adb connect <phone-ip>:<port>`. Expect `screen` ≈ capture + 98 KB / link rate.
   If the link is slow, default to long side 960 / q60 (53 KB) and lean on `ifChangedFrom`.
3. Host side in TRACE (Node, no new dependencies): `src/phone/` with a direct adb-server socket
   client (127.0.0.1:5037, no process spawn per call), agent install/start/version check,
   reconnect on Wi-Fi drop, and an MCP server `trace-workbench phone mcp` with tools:
   `phone_connect` (pair/connect/mdns), `phone_screen` (saves every frame locally, returns the
   image only when changed), `phone_ui`, `phone_act` (tap by selector or coordinate, then wait
   for stable and return the new frame in **one** call), `phone_wait`, `phone_logcat`.
   Coordinates: accept image space from the last frame and convert with the returned `scale`.
4. **On-phone Claude (Termux → proot Debian)**: no Wi-Fi hop at all. Debian's `adb` pairs to the
   phone's own wireless debugging on 127.0.0.1, then the same forward works. Faster option:
   start the agent with Termux's uid as the second argument and connect to the abstract socket
   directly from Debian (same network namespace), skipping adbd. Needs the owner's explicit OK,
   because it lets Termux apps drive the phone. TODO(verify) that proot can reach abstract sockets.
5. Faster capture (optional): `SurfaceControl`/`ScreenCapture` hidden APIs (as scrcpy does) to
   skip the `screencap` process and the 17.8 MB copy; target < 80 ms. Fragile across versions;
   keep `screencap` as the fallback.
6. Skill: `skills/trace-phone/SKILL.md` + manifest (writing-for-agents), linked from `SKILLS.md`;
   tests with a fake agent socket; PR per VERSION_CONTROL.md (2–3 commits).

Build output (`.dex`, classes) stays out of Git; build it at setup into `.runtime/`.

## Session 3 (1 November 2026, no device run)

Done, host side only: `scripts/build-phone-agent.cjs` (javac `--release 11` + d8 into
`.runtime/phone/build/classes.dex`; JBR, newest platform and build-tools; built 22,568 bytes,
4 classes); `src/phone/server.cjs`, served by `trace-workbench phone mcp`, with `phone_connect`,
`phone_screen`, `phone_ui`, `phone_act`, `phone_wait`, `phone_logcat` on the controller
(closing the server kills the agent and removes the dex); `skills/trace-phone/` + manifest;
`SKILLS.md` row; tests in `tests/phone.test.cjs` and `tests/phone-mcp.test.cjs` (fake adb + fake
agent socket, shared in `tests/fixtures/phone-fakes.cjs`).

Not run in session 3: the agent on the phone (no owner approval in that session). Read-only
checks only: `adb devices` shows the S23, SDK 37; no `trace-phone.dex` in `/data/local/tmp`,
no agent process. The `pid` in `hello`, `stop()` by pid, and the MCP server against a real
phone remain TODO(verify).

Next steps (replace 1, 3 and 6 above):

1. Owner approves an on-device run. Then: `node scripts/build-phone-agent.cjs`, register
   `trace-workbench phone mcp` as a local stdio MCP server, call `phone_connect`, `phone_screen`,
   `phone_ui`, one `phone_act` with a `key` (e.g. `home`), and close the server; check with
   `adb shell ls /data/local/tmp/trace-phone.dex` and `pidof app_process` that nothing remains.
2. Wi-Fi bench (step 2 above), then the on-phone Termux/Debian install (step 4 above) after this
   PR merges.

## Session 4 (1 November 2026, device run, owner-approved)

The owner approved one on-device run on the S23 (SM-S918U, SDK 37) over USB. A stdio MCP client
started `node bin/trace.cjs phone mcp` (the same command a registered server runs) on the PR #81
head `6278bd5`, just before it merged unchanged. The dex was rebuilt with
`node scripts/build-phone-agent.cjs` (22,568 bytes, 4 classes).

| Step | Result | Time (host) | Notes |
|---|---|---|---|
| `tools/list` | pass | | 6 tools: connect, screen, ui, act, wait, logcat |
| `phone_connect` | pass | 2002 ms | one USB device picked; agent `pid` returned (verifies `hello` pid) |
| `phone_screen` (`force`) | pass | 383 ms | 597×1280 JPEG, 62,709 bytes, capture 329 ms, encode 42 ms; home screen |
| `phone_ui` (`maxNodes` 25) | pass | 1517 ms | launcher package, 25 of 55 nodes; UiAutomation constructor `(int, Looper, IUiAutomationConnection)` works |
| `phone_act` key `home` | pass | 669 ms | `met:true` after 4 frames; frame unchanged (already on home, expected) |
| close server | pass | | `ls /data/local/tmp/trace-phone.dex`: no such file; `pidof app_process`: none |

This verifies `stop()` by pid and the MCP server against a real phone over USB (the
session 3 TODO(verify) items). Not run: Wi-Fi bench, `phone_wait`, `phone_logcat`, selector taps.
Frames stay local in `.runtime/phone/frames/`.

Next steps:

1. On-phone Claude (Termux → proot Debian): node at `/opt/node22`, a user-level MCP server
   `trace-phone`, a copy of `skills/trace-phone/`, as REA was set up. Wireless debugging port
   5555 closes on reboot; reopen it with `adb tcpip 5555`. TODO(verify) proot reach to the
   abstract socket (step 4 above).
2. Wi-Fi bench (step 2 above).

## Task A2 permission profile (1 November 2026, device run, owner-approved)

The profile was applied to a scratch `--claude-dir`. A scripted session ran with
`claude -p --settings <scratch>/settings.json --strict-mcp-config` against
`node bin/trace.cjs phone mcp` on the S23 over USB. Non-interactive mode denies anything that
would prompt, so a denial stands for a prompt here.

| Mode | connect | screen | ui | act `home` | act `text` |
|---|---|---|---|---|---|
| with an `ask` rule for `phone_act` (first design) | pass | pass | pass | denied (fail) | denied |
| `default`, hook only | pass | pass | pass | allowed, no prompt | denied by hook `ask` |
| `auto`, hook only | pass | pass | pass | allowed, no prompt | denied by hook `ask` |

After each run, `/data/local/tmp` held no trace-phone dex and no agent process was left. In the
`default` run the screen changed from home to the launcher search between `phone_screen` and
`phone_ui`, with no `phone_act` in between. Cause not found; TODO(verify).

Not done: applying the profile to the PC's and the phone's real `~/.claude/settings.json`. The
session's auto-mode classifier blocked that write as self-modification, so the owner runs
`node scripts/configure-phone-permissions.cjs --apply`: on the PC from the repo, and on the phone
in Debian from a TRACE checkout at or after this PR.

Update, 1 November 2026: applied on the PC (`--apply`, then a dry run listed no changes).
Phone: not_run. Its `/opt/trace` predates the script, so both scripts were copied to
`/sdcard/Download/trace-a2/`; the owner runs `node configure-phone-permissions.cjs --apply`
from there in Debian (A6 will make this part of the install).

Update, 1 November 2026 (A6 session): applied on the phone. The session typed the command into
Termux over adb; dry run listed 11 changes, `--apply` wrote them, a second dry run listed none.

## Task A6 one-command install (1 November 2026, device run, owner-approved)

`node scripts/install-phone-claude.cjs [--ref <ref>] [--serial <id>]` installs or updates TRACE
in the phone's Debian. On the PC it runs `git archive` on the ref, builds the dex from that tree,
and pushes the archive, dex and an install script to `/sdcard/Download/trace-install`. adb cannot
write Termux's home, so staging uses shared storage. adb shell also lacks Termux's
`RUN_COMMAND` permission, so the script types `bash /sdcard/Download/trace-install/run.sh`
into the Termux terminal and reads `install.log` back until `TRACE-INSTALL-END <code>`.
In Debian: `npm ci --omit=dev` into `/opt/trace.new`, then the swap with `/opt/trace`.
`.runtime/phone/frames` is kept. Then it copies `skills/trace-phone`, registers the user-level
`trace-phone` MCP, applies the A2 profile, deletes the staged archive and dex, and prints the ref
and `claude mcp list`. `--check` prints only those two. `--print` stages the files and prints the
command for the owner to type.

Precondition: the phone is unlocked and Termux is at a shell prompt. If Termux is running a
program, the typed command goes to that program.

| Run | Result | Notes |
|---|---|---|
| install `e227f4a` (`/opt/trace` had no ref) | pass | npm ci 175 packages in 18 s; `trace-phone ✔ Connected` |
| rerun on this PR's docs commit (new ref) | pass | ref updated; `--check` shows the new ref and `✔ Connected`; staged archive and dex removed |

## Task A3 phone Claude smoke test (1 November 2026, device run, owner-approved)

In Debian on the S23, with port 5555 open (`adb tcpip 5555` from the PC earlier): `adb connect
127.0.0.1:5555`. The A6 install was at the PR #87 docs commit, and the A2 profile was applied.

Direct controller timings (`createPhoneController`, the server's code path) over 127.0.0.1 versus
session 4's USB numbers:

| Call | 127.0.0.1:5555 | USB (session 4) |
|---|---|---|
| connect (agent start) | 320 ms | 2002 ms |
| forced screen (5 runs) | 212-242 ms, capture ~207 ms | 383 ms, capture 329 ms |
| ui, 25 nodes | 348 ms | 1517 ms |
| key home (settle included) | 2030 ms | 669 ms (screen already home) |

The phone's Claude (`claude -p`, Claude Code 2.1.316) called `phone_connect` with
`address: "127.0.0.1:5555"`, then `phone_screen` (force) and `phone_act` key `home`. All three
passed: capture 184 ms, `met:true` after 11 frames, back on the home screen. The run had zero
permission denials, so the A2 allow rules and the `phone_act` hook worked on the phone.
Afterwards there was no `trace-phone.dex` and no `app_process`.

Findings:
- **`emulator-5554` is the same phone.** adb auto-detects the 5554/5555 emulator port pair, and
  it shows as `device` with the S23's model and transport 1 (the TODO(verify) from session 4).
  `phone_connect` needs `address` or `serial`, or it stops with "several devices".
- **No adb server, no tools.** proot ends Debian's adb daemon when a login exits, and
  `phone_connect` does not start one. The first run failed with `adb server unreachable at
  127.0.0.1:5037`. Run `adb start-server` and `adb connect 127.0.0.1:5555` before starting
  Claude (A4/A5 put this in the boot script).

## Task A4 reboot test (2 November 2026, device run, owner-approved)

S23 on eduroam, USB unplugged, A4 branch `e96b609` installed. The PC rebooted the phone over Wi-Fi
adb (`adb -s <phone-ip>:5555 reboot`) at 12:31:45 local time. **Result: pass.**

| Time (local) | Event |
|---|---|
| 12:31:45 | reboot; port 5555 closed |
| ~12:33 | phone booted; Shizuku server up (Wireless debugging on, port 42809) |
| 12:38:46 | owner unlocked; Termux:Boot started `trace-adb` (boot log: `adb server running`) |
| 12:39:42 | first scan of 127.0.0.1:30000-65535 (56 s): 1 open port, not adbd |
| 12:40:34 | second scan found Wireless debugging at 127.0.0.1:42809; `adb tcpip 5555` |
| 12:40:46 | `127.0.0.1:5555 device`; script exited 0 at 12:40:54 |

From the PC, `adb connect <phone-ip>:5555` worked again from 12:40:34. On the phone, Debian's adb
server held an established connection to 127.0.0.1:5555. The log was read by copying
`~/.trace-boot.log` to shared storage (typed into Termux, owner-approved) and deleted afterwards.

Findings:
- **Nothing runs before the first unlock.** Termux:Boot starts only after the owner unlocks the
  phone (Termux's data is credential-encrypted), so the phone is unreachable over 5555 from boot
  to unlock plus about 2 minutes. Shizuku started earlier, but it does not open 5555.
- **One wasted round after `tcpip`.** The first round logged `not reachable after tcpip` 1.5 s
  after the restart, not after the 10 s wait; the next round (10 s later) found 5555 open. Cause
  not found; TODO(verify). It costs about 10 s and needs no fix for A4.
- The first scan saw one open port that was not adbd. Whether Wireless debugging was on yet is
  unknown; TODO(verify).
- A port scan from the PC (500 probes in parallel, 800 ms timeout) missed port 42809, which a single
  probe found open. Over Wi-Fi, use mDNS or a slower scan. eduroam showed no `_adb-tls` mDNS
  services to the PC.
