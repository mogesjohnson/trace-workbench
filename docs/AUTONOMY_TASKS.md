# Autonomous Claude sessions: task specs (awaiting owner approval)

Status: **proposed, 1 November 2026.** Nothing here is approved. The owner ticks each task's
**Approve** box (or says "approve A3") before work starts; each task becomes one branch and one PR.

Goal: a Claude session (on the PC or the phone's Termux → Debian Claude) runs a whole task, such as
"run the bench, record it, open the PR", without a human at the keyboard. It stops only at the
approval gates the owner chose ahead of time, and it reports back without being asked.

## What blocks that today (seen in session 4)

| Blocker | Evidence |
|---|---|
| Every device run needs a fresh owner OK in the chat | session 3 stopped for it; session 4 ran only after an OK |
| Port 5555 and Wireless debugging close on reboot; only USB `adb tcpip 5555` reopens them | second-brain note 4bb2663e (30 Oct 2026) |
| `proot-distro login` kills detached children when its command ends | second-brain note 058f2b8c (31 Oct 2026) |
| The phone install was a hand-run copy (git archive → Termux home → `/opt/trace`, dex built on the PC) | session 4 install |
| Phone Claude has not driven `trace-phone` itself yet (registered, `✔ Connected`, no `phone_connect`) | session 4 install |
| No standing rule for which phone actions are safe without asking | `skills/trace-phone/SKILL.md` "Consent" |

## Tasks

Order matters: A1 sets the rules the others rely on.

### A1. Standing approval policy for phone actions

- [x] **Approve** (owner, 1 Nov 2026; merged in PR 84)

Write `docs/PHONE_AUTONOMY_POLICY.md`: three tiers that a session reads before acting.
- **Allowed without asking:** start/stop the agent on the owner's S23, `phone_screen`, `phone_ui`,
  `phone_wait`, `phone_logcat`, keys `home`/`back`, opening an app the task names.
- **Ask first (push notification, then wait):** typing text, taps inside messaging, email, banking,
  shopping or settings apps, installing or removing apps, anything that sends data off the phone.
- **Never:** payments, passwords, 2FA codes, deleting user data, changing security settings.

Update the skill's "Consent" step to point at the policy. Done when the policy is merged and the
skill text cites it. Owner decision needed: the tier lists themselves.

### A2. Permission profile that matches A1

- [x] **Approve** (owner, 1 Nov 2026) (changes Claude settings on the PC and the phone, so it needs an explicit OK)

PC and phone `~/.claude/settings.json`: allow `mcp__trace-phone__phone_screen`, `phone_ui`,
`phone_wait`, `phone_logcat`, `phone_connect`; keep `phone_act` on **ask**, plus a PreToolUse hook
that auto-allows `phone_act` only for A1's "allowed" keys. Add read-only `adb` commands (`devices`,
`shell getprop`, `shell pidof`, `shell ls /data/local/tmp`) to the allow list. Done when a scripted
session runs connect → screen → ui → home → close with zero prompts, and a `text` action still prompts.

### A3. Phone Claude drives trace-phone on its own (smoke test)

- [ ] **Approve** (runs the agent from Termux; the faster path in PHONE_HANDOFF step 4 also lets Termux apps drive the phone)

In Debian: `adb connect 127.0.0.1:5555`, then the phone's Claude calls `phone_connect` with
`address: "127.0.0.1:5555"`, takes a screenshot, presses Home and closes. Measure frame time against
the USB numbers. Check the dex and process are gone. TODO(verify) whether the adb auto-detected
`emulator-5554 offline` entry confuses device selection (seen in session 4). Done when results are recorded in
PHONE_HANDOFF.md.

### A4. Survive a reboot without USB

- [ ] **Approve** (keeps wireless debugging reachable from the phone itself)

Termux:Boot script: acquire a wake lock, start Debian's adb, reconnect. Since `adb tcpip 5555` needs an
existing adb link, research the on-phone route: Debian `adb pair` against the phone's own Wireless
debugging (pair once, then connect to the mDNS-advertised port each boot). TODO(verify) that
Wireless debugging can be turned back on without a PC (`adb_wifi_enabled` stays 0 after reboot).
Done when, after a reboot with USB unplugged, the phone's Claude reaches `device` state with no hand steps,
or the doc records why it can't.

### A5. Headless, long-running phone Claude with remote approvals

- [ ] **Approve**

Run the phone's Claude as the login's own command (per 058f2b8c), backgrounded from Termux with a wake
lock, started by Termux:Boot, with Remote Control on so the owner sees and approves from the PC or
claude.ai. Ask-tier actions (A1) send a push notification and wait; the session keeps doing other
work meanwhile. Done when a task started from the PC finishes on the phone with the screen off, and
one approval was answered remotely.

### A6. One-command install and update of TRACE on the phone

- [ ] **Approve**

`scripts/install-phone-claude.cjs` (PC side, no new dependencies): `git archive` of a given ref,
build the dex, stage through Termux home, `npm ci --omit=dev` into `/opt/trace.new`, swap,
copy `skills/trace-phone`, register the user-level MCP, clean staging. `--check` prints the
installed ref. Session 4's hand steps become this script. Done when a rerun on a new ref updates the phone
and `claude mcp list` there shows `trace-phone ✔ Connected`.

### A7. Session self-reporting and stop rules

- [ ] **Approve**

A short `docs/AUTONOMOUS_SESSION.md` that an autonomous session follows: work from one task spec, report
each check as pass/fail/blocked/not_run, push a notification on finish or block, write the handoff
and the second-brain capture, close every phone agent and server, delete frames older than 7 days.
Stop at: an unapproved tier, a failing check it cannot explain, or 125k context. Done when one A3/A5 run
ends with that report and nothing left running.

### A8. Voice input and transcription

- [ ] **Approve** (owner asked for this on 1 Nov 2026; scope below is a proposal)

The owner can speak a task to the phone and get a transcript, and the session can read back
transcripts of recordings. First step is research, recorded in a short doc: which speech-to-text
runs on the S23 (Android's on-device recognizer, Termux:API `termux-speech-to-text`, or a local
model in Debian such as whisper.cpp), its latency and accuracy on a few owner-recorded samples, and
whether audio leaves the phone. TODO(verify) each option on the device. Then, if the owner picks one:
a `phone_transcribe` tool or a script that turns a recording or a live utterance into text for the
session. A1 tiers apply: recording the microphone and sending audio off the phone are **ask first**
until the owner moves them. Done when the research doc names a recommended route with measured
numbers, or the follow-up tool returns a transcript of a spoken test phrase.

### A9. Termux:API notifications with an Approve/Deny wait

- [x] **Approve** (owner approved on 2 Nov 2026)

A `phone_notify` tool or script that posts a notification through Termux:API, plus an ask-and-wait
helper: `termux-notification --button1 Approve --button2 Deny`, where each button's action writes an
answer file the helper polls. A timeout counts as Deny. This is the push-and-wait that A5 needs for
ask-tier actions. First check whether the Claude mobile app already pushes Remote Control approval
prompts; if it does, record that and keep A9 for prompts outside Claude. TODO(verify) the `termux-*`
binaries can be called from Debian by full path (`/data/data/com.termux/files/usr/bin` is bound into
proot). Done when one ask-first action waits for, and receives, a real button press on the S23.
`termux-sms-send` stays parked until A9 works, then only to an approved-number list, ask first.

## Suggested order

A1 → A2 → A6 → A3 → A4 → A5 → A7, then A8 (voice) once A3 shows phone Claude can run tools, and A9 alongside A5. A1 and A2 can share one PR if the owner approves both together.
