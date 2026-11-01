# TRACE Phone: handoff 1 (1 November 2026)

Goal (owner, 1 Nov 2026): add a **trace-phone** skill to TRACE Workbench that controls an Android
phone over adb faster and more precisely than plain adb, REA's `capture_adb_screen`, or
uiautomator. Optimize for three links, in this order of importance:

1. **Wi-Fi adb** (the owner's normal setup: PC ↔ phone over wireless debugging).
2. **On-phone agent**: Claude Code running on the phone in Termux → proot Debian, driving the
   same phone through adb on localhost.
3. USB (used now for development only).

State: **prototype only, not merged, no PR.** The on-device agent source is in
`native/TracePhoneAgent/`. It was measured over USB, then hardened (see "Security"). The hardened
build has **not been run yet** because the session's permission check blocked restarting it.
Nothing was left running on the phone: the agent process, its dex, its log and the adb forward
were removed and checked.

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
