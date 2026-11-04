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
| update `5613c91` to main `803fdc2` (3 Nov 2026, after the src/agentic-phone move) | pass | 41 s; npm ci 175 packages in 21 s; dex 25124 bytes; A2 profile no changes; `--check` shows `803fdc2` and `✔ Connected` |

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

## Task A5 headless Remote Control (2 November 2026, device run, owner-approved)

Phone Claude 2.1.316 runs `claude remote-control --name s23-trace` in `/root/phone-work`, started
from Termux with `nohup` and a wake lock, as the proot login's own command. **Result: pass.**

- Remote Control refuses an untrusted folder ("Workspace not trusted"). The installer now creates
  `/root/phone-work` and sets `hasTrustDialogAccepted` for it in `~/.claude.json`.
- The phone was signed into a different claude.ai account than the PC. The owner ran
  `claude auth login` in Debian; after that the PC's claude.ai/code showed the `s23-trace` environment.
- Run (13:23-13:26 EST, screen off and dozing throughout): the owner sent a task from claude.ai/code
  on the PC. The phone session ran `node --test tests/phone-boot-adb.test.cjs` (2 pass, 0 fail) and
  its `Write` of `~/phone-work/a5-result.txt` waited 2 min 2 s for a permission prompt that the owner
  approved from the PC. The transcript shows both tool results `ok`.
- The Termux:Boot script now starts Remote Control after `phone-boot-adb.cjs`, in a login that
  first runs `adb start-server` and `adb connect 127.0.0.1:5555` (A3: no adb server, no tools).
  Log: `~/.trace-rc.log` in Termux.
- Install and reboot test (13:43-13:48 EST, S23 on USB, eduroam): `install-phone-claude.cjs --ref
  efc2588` ended `TRACE-INSTALL-END 0` with the trust entry in place. After `adb reboot` and an
  unlock, Termux:Boot reopened 5555 at 13:47:33, then started `claude remote-control --name
  s23-trace`, and `~/.trace-rc.log` showed `Connected · phone-work`. **Result: pass**, no hand
  steps besides the unlock. Remote Control starts only after `phone-boot-adb.cjs` ends (about
  50 s after unlock), because the boot script runs them in sequence.
- Not covered: push notifications for ask-tier actions (Remote Control shows the prompt in
  claude.ai/code and the Claude app; whether the app notifies is TODO(verify)).

## Task A7 trial run (2 November 2026, device run, owner-approved)

The PC sent the trial task (`/sdcard/Download/trace-install/a7/TASK.md`, allowed tier only) from
the Claude app on the S23 over adb: Code, new session, environment `localhost · phone-work`.
The phone session followed `AUTONOMOUS_SESSION.md` and posted this notification:
"A7 trial: pass 5 (C1 C2 C3 C5 C6), blocked 1 (C4 frame delete denied by permission check; 0 of
22 frames were older than 7d), not_run 1 (C7). No PR (no repo)." The handoff was written to
`/root/phone-work/a7-handoff.md`.

- C2 to C3: `phone_connect` reused the running agent, `phone_ui` after `home` reported
  `com.sec.android.app.launcher`, and `phone_screen` saved a 21547-byte frame.
- C4 blocked: the auto-mode permission check denied `find ... -mtime +7 -delete` as an
  irreversible delete. Nothing needed deleting (0 of 22 frames were old). Fix: an allow rule in the
  A2 profile.
- C7: after the last message, the session process, its `trace-phone` MCP server and
  `app_process` were all still running, and `trace-phone.dex` was still in `/data/local/tmp`.
  A Remote Control session stays alive until it is archived. Ending its process from adb was
  denied by the PC's permission check.
- C7 pass (2 November 2026): the session was archived in the Claude app over adb (session menu >
  Archive > Archive). About 20 seconds later `pidof app_process` printed nothing and
  `/data/local/tmp/trace-phone.dex` was gone. Only the A5 boot Remote Control host was still running.
- C4 fix (PR 96, 2 November 2026): auto mode denied the prune as an agent Bash command three times.
  The A7 trial had no rule. Re-run 1 used PR 95's relative rule with `cd /opt/trace && find ...`.
  Re-run 2 used the exact absolute command, and `~/.claude/settings.json` allowed exactly that
  string. The denial each time: "auto mode classifier … [Irreversible Local Destruction]"
  (Claude Code 2.1.316, Remote Control-spawned session). So trace-phone now prunes its own frames
  older than 7 days when its MCP server starts, and the profile has no `find`/delete rule.
- C4 pass (2 November 2026, 17:35 EST, `c7a058a` installed): a dummy frame was added, dated 10
  days back (23 frames, 1 old). A new phone-work session started trace-phone. Its read-only counts
  showed 0 old frames, 22 total, and the dummy frame gone. Notification:
  `pass old=0 total=22 planted=gone`.

## Task A8 last step: phone Claude calls phone_transcribe (4 November 2026, owner-approved)

Same route as A7: the PC pushed `/sdcard/Download/trace-install/a8/TASK.md`, then over adb opened the
Claude app, Code, new session, environment `localhost · phone-work`, and sent "Read ... TASK.md and
follow it". The session called the `phone_transcribe` MCP tool (not Bash) on
`/opt/whisper.cpp/samples/jfk.wav`. **Result: pass**, T1 to T4: exact words, base.en, 20.7 s for 11 s
of audio, notification `a8transcribe` posted (exit 0), handoff at `/root/phone-work/a8-handoff.md`.
No microphone recording. After archiving the session, `pidof app_process` was empty and
`trace-phone.dex` was gone. The time is 5× the 3 Nov figure. An SSH re-run took 15.3 s with RAM
nearly full and 6.4 GB swapped, which first suggested memory pressure; the follow-up below points to CPU placement instead.
[Evidence](../evidence/research/a8-phone-claude-transcribe-2026-11-04.json).

Follow-up, 4 November 2026: SSH runs still took 14.9 to 15.4 s with 4 threads, 13.6 to 15.5 s with 3
and about 17.3 s with 2, on a cool phone (thermal status 0, no frequency cap) with 2.7 GB available.
Termux processes, sshd included, sat in cpuset `/moderate` and cpu cgroup `/background`, which allow
only cores 0-2, the slow cores. `top-app` allows 0-7. This is the likely cause of the slowdown,
but no run in `top-app` was timed and the 3 Nov placement was not recorded.
[Evidence](../evidence/research/phone-transcribe-slowdown-2026-11-04.json).

Placement test, 4 November 2026: **pass**. With Termux on screen, its processes moved to `/top-app`
(cores 0-7), SSH sessions included, and `jfk.wav` took 4.05 to 4.36 s in six runs. After Home, the
first run took 4.17 s in `/foreground-boost`; the next two took 14.66 and 14.50 s, and the cpuset was
`/moderate` when the loop ended. Termux's placement explains the 4 s and 15 s figures. No fix applied.
[Evidence](../evidence/research/phone-transcribe-topapp-2026-11-04.json).

## Wi-Fi trust watcher (2 November 2026; SDK 37 fix 3 November 2026)

Owner decision, 2 November 2026: every Wi-Fi network the phone joins is trusted for Wireless
debugging ([policy exception](PHONE_AUTONOMY_POLICY.md)). `trace.phone.WifiTrust`, in the agent
dex, is the watcher. `scripts/phone-boot-adb.cjs` starts it once `127.0.0.1:5555` is up: it pushes
the dex to `/data/local/tmp/trace-wifi.dex` and runs it under `app_process` as the shell user,
named `tracewifitrust` and logging to `/data/local/tmp/trace-wifi.log`. Every 5 s the watcher reads
`dumpsys adb` and `cmd wifi status`. It acts when the current BSSID (from `cmd wifi status`, else
`network_bssid`) is not in the trusted list of the `dumpsys adb` keystore dump, or when
`is_trusted_network=false`. It then calls `IAdbManager.allowWirelessDebugging(true, bssid, ssid)`,
the SDK 37 signature, with the SSID quoted as Android stores it (`"MogesAIGirlfriend5"`), or
`allowWirelessDebugging(true, bssid)` (AOSP) when the 3-argument one is missing. A message that
repeats every round, such as an error, is logged once. It never turns Wireless debugging off,
removes networks or pairs devices. Host checks: `tests/phone-wifi-trust.test.cjs` compiles the
watcher with `tests/fixtures/WifiTrustTest.java` (skips without a JDK and Android SDK).

| Check (S23, USB) | Result |
|---|---|
| eduroam: `dumpsys adb` prints `is_trusted_network=true` and `network_bssid`; `cmd wifi status` prints `BSSID: <mac>` | pass |
| eduroam: watcher starts, logs `trust watcher started, every 5 s` | pass |
| eduroam: starting it again leaves one process (`pgrep -f '^tracewifitrust$'`) | pass |
| 3 Nov, `5613c91`: joining MogesAIGirlfriend5 (5 GHz, `12:36:aa:0d:52:a6`) does not restart the watcher or adbd (same pid, adbd STIME unchanged) | pass |
| 3 Nov, `5613c91`: joining MogesAIGirlfriend5 → network trusted, no dialog tap | **fail** (two causes below; the owner tapped Allow once) |
| 3 Nov 00:52, `948dfac` watcher started by the owner: first round logs `allowed 12:36:aa:0d:52:a6 "MogesAIGirlfriend5" (3-arg)`; the keystore lists `12:36:aa:0d:52:a6` / `"MogesAIGirlfriend5"`; `is_trusted_network=true`; adbd not restarted (STIME 23:30:01) | pass |
| fixed watcher: switching to 2.4 GHz and back to 5 GHz shows no dialog | **dropped** (owner, 4 Nov): the 4 Nov new-network check already covers it. A band the phone has not trusted yet shows the pop-up once and the watcher trusts it with no tap. |
| 3 Nov 12:59, eduroam `74:9e:75:2f:b8:a3` (not listed, but `is_trusted_network=true` by SSID): restarted watcher logs `allowed 74:9e:75:2f:b8:a3 "eduroam" (3-arg)` on its first round; the keystore lists it | pass |
| 4 Nov 09:28, main `60825a7`, joining eduroam `74:9e:75:2f:f6:23` (a BSSID not trusted before): after the adbd restart at 09:28:31 the restarted watcher logs `allowed 74:9e:75:2f:f6:23 "eduroam" (3-arg)` at 09:28:51; `dumpsys adb` shows `is_trusted_network=true`; logcat has no `WifiDebuggingActivity` (no dialog); at 09:38 the PC, also on eduroam, connects with `adb connect 10.104.39.123:5555` (the phone's new address; the home address 10.0.0.151 no longer answers) | pass |
| 3 Nov 23:11, `8d386a9` after reinstall and reboot: `adb tcpip 5555` restarts adbd and kills the watcher; the keep-alive starts it again 28 s later under the new adbd | pass |
| 4 Nov 09:28, main `60825a7` after reinstall and reboot on eduroam: Termux:Boot starts the watcher, one process; first round logs `allowed 74:9e:75:2f:f6:23 "eduroam" (3-arg)` (a BSSID not seen before) | pass |
| 4 Nov 10:53, main `60825a7`, joining `"healthnutnutrition"` (`06:01:21:32:bc:52`, 5 GHz, never joined before, neither SSID nor BSSID trusted): the system logs `Displaying auth prompt` at 10:53:33; the watcher logs `allowed 06:01:21:32:bc:52 "healthnutnutrition" (3-arg)` at 10:53:36 with no tap; wireless adb starts; `is_trusted_network=true`; one watcher process | pass |
| 4 Nov 10:53, same join: no pop-up | **fail**: `WifiDebuggingActivity` opens on join, before the watcher's next round, and stays on screen after the network is trusted (still `mCurrentFocus` at 10:55). On networks already trusted by SSID (eduroam) it never opens |
| 4 Nov, same network: PC connects over Wi-Fi | **not_run**: the network isolates clients (ping from the PC is `Destination host unreachable`; `adb connect` times out) |

Findings:
- On a network trusted by neither SSID nor BSSID, the watcher trusts it within one round, but the system pop-up it raced stays open. Closing it without denying needs an owner decision: Back or Cancel may call `denyWirelessDebugging`. On that network `settings get global adb_wifi_enabled` returned `0` while wireless adb was running; cause unknown, TODO(verify).
- What closing the pop-up does (4 Nov, read from the S23's own `SystemUI.apk` and `services.jar` with `dexdump`, not tested on the device): `WifiDebuggingActivity.onDestroy` calls `denyWirelessDebugging()` whenever no button was clicked (`mClicked` false). So Back, `finish`, or the pop-up closing itself (its receiver finishes it when Wi-Fi turns off, disconnects or changes BSSID) all send deny. Home only stops it (`onStop`), which does not deny, but it stays in the background and denies later when it is destroyed. On this build deny is message 19 in `AdbDebuggingHandler`. It only broadcasts `com.android.server.adb.WIRELESS_DEBUG_STATUS` with status 5 and port -1, then logs a metric. It does not remove the keystore entry, does not stop the TLS server, and does not write `adb_wifi_enabled`, so deny is not what set that setting to 0. Port 5555 (`adb tcpip`) does not go through this path. TODO(verify) on the device: close the pop-up after the watcher has allowed, then check the keystore, `is_trusted_network`, the TLS port and 5555. The Settings Wireless debugging screen may act on the status-5 broadcast if it is open.
- `pkill -f trace.phone.WifiTrust` also matches the `sh -c` running it, so it kills itself before
  starting the watcher. `pkill -x` does not work either: the process's kernel name is `main`.
  The script matches the whole command line instead, `^tracewifitrust$`.
- Hotspot cause 1: while the "Allow wireless debugging?" dialog (systemui
  `WifiDebuggingActivity`) is up, `dumpsys adb` shows a stale `is_trusted_network=true` and an
  empty `network_bssid`, so a trigger on `is_trusted_network=false` never fires. After Allow once
  it shows `network_bssid=12:36:aa:0d:52:a6`, `network_ssid="MogesAIGirlfriend5"`,
  `is_trusted_network=false`. Fix: the trusted-list check.
- Hotspot cause 2: `allowWirelessDebugging(boolean, String)` throws `NoSuchMethodException` on SDK
  37; reflection lists `allowWirelessDebugging(boolean, String, String)`. AOSP `main` still has
  the 2-argument AIDL (`alwaysAllow, bssid`), so the third argument is a Samsung/SDK 37 addition.
  The order `(alwaysAllow, bssid, ssid)` is confirmed by the device run: the new keystore entry
  holds the BSSID and the quoted SSID in the right fields. The old watcher logged this error every
  5 s.
- The trusted list is in the keystore dump (binary ABX) before `adb_wifi={`: the `wifiAP` section
  lists `bssid` then `ssid` per network, the SSID in quotes (`"eduroam"`, `"Thomas and Caden"`).
  Base64 adb keys contain no colons, so every MAC before `adb_wifi={` is a trusted BSSID. Each band
  of a dual-band router has its own BSSID and counts as a separate network.
- On eduroam the trusted list holds BSSID `…34:d3` but the phone is trusted on `…90:53`, so SDK 37
  seems to match on SSID too. TODO(verify). With the list check the watcher adds `…90:53` once
  there, which only adds trust.
- adbd restart: the watcher runs in adbd's cgroup (`/proc/<pid>/cgroup` shows
  `/system/uid_0/pid_<adbd>`), and Android kills that cgroup when adbd restarts, so neither `nohup`
  nor `setsid` keeps it alive. On 3 November adbd restarted at 12:35:24 without a reboot (uptime
  23 h; cause unknown), and the watcher was gone with no log line. Fix: the boot script also starts
  `phone-boot-adb.cjs --keep-alive` in the background, after Remote Control. Every 30 s it checks
  that `127.0.0.1:5555` is a device (reconnecting the way boot does, including `adb tcpip 5555`)
  and that the watcher runs, and starts it again if not. It logs only changes to
  `~/.trace-keepalive.log` in Termux, and a pid file (`/tmp/trace-keepalive.pid` in Debian) keeps
  one copy. Device check passed on 3 November at `8d386a9` (PR 105 comment 6622329235): after a
  reinstall and reboot, Termux:Boot started the watcher, Remote Control and the keep-alive;
  `adb tcpip 5555` restarted adbd (pid 10105, 23:11:02) and killed the watcher; at 23:11:30 the
  keep-alive started it again (pid 10674, cgroup `/system/uid_0/pid_10105`, `is_trusted_network=true`).
  Toggling Wireless debugging over USB does not restart adbd, so use `adb tcpip 5555` for this
  check. `~/.trace-keepalive.log` is in Termux's home folder and cannot be read over adb. Limit: if Wireless debugging is off after the restart (for example,
  on an untrusted network) it can only wait.
- adbd restarts without a reboot happen often, at irregular times. On 4 November logcat (history
  from 08:22) showed adbd starts at 08:50:59 and 08:52:49, then none until 09:21:07, 09:21:57,
  09:22:28 and 09:28:31, the last four around the phone's move from home Wi-Fi to eduroam (joined
  09:19). Unplugging and replugging USB did not restart adbd. Each restart used to wipe `trace-wifi.log`, because the watcher's
  output was redirected with `>`. The watcher now appends with `>>`, so events from before a
  restart survive. When the log passes 64 KiB at a restart, it moves to `trace-wifi.log.1`. To see
  when adbd started, run `logcat -d -b all -v time | grep 'wifi_init: Expecting'`, which prints one
  line per adbd start.
- Limit: nothing runs before adb is up, so a reboot straight onto a never-joined network still
  shows the system dialog once.
