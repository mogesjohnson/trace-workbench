# CODE RED: observation token cost — 2 November 2026

**Status: open. Severity: blocking for real agent use.** On ordinary Windows apps,
TRACE `trace-computer` returns responses so large that an agent fills its context
window in minutes. This file records what happened, the measurements, the causes
traced to source, and the fixes required. Every number below comes from the
session transcript; the per-call data is in
[`evidence/token-cost-2026-11-02/trace-calls.csv`](../evidence/token-cost-2026-11-02/trace-calls.csv).

## What happened

The owner asked Claude Code (Opus 5.5, medium effort) to run a head-to-head test:
TRACE against Vercel Labs `agent-desktop` 1.0.2. There were four tasks (Notepad
text, Save As dialog, Firefox navigation, read-only Settings), each run twice per
tool, for 16 task-runs in total.

The owner stopped the test after **3 of 16 task-runs**, all of them TRACE. By then
the Claude Code context meter read **420k / 1.0M tokens (42%)**, and almost all of
that came from TRACE tool results. `agent-desktop` never ran. At that rate the full
test would not fit in a 1M context.

All three TRACE task-runs passed. The problem is cost, not correctness.

| Task (TRACE run 1) | Result | TRACE calls | Wall time (approx.) |
|---|---|---|---|
| Notepad: type and read back | pass, indirect readback (see F8) | 9 | ~91 s |
| Save As via dialog, close Notepad | pass, file verified on disk (19 bytes) | 15 | ~120 s |
| Firefox: example.com, follow link, close | pass, URL `www.iana.org/help/example-domains` | 15 | ~140 s |
| Settings: read Display scale | not run (test stopped) | — | — |

## Measurements

These cover 42 TRACE calls (one call failed because of an agent mistake).

| Tool / action | Calls | JSON text chars | PNG images |
|---|---:|---:|---:|
| observe (full) | 10 | 261,477 | 9 |
| observe (accessibility) | 3 | 196,250 | 0 |
| act (all types) | 12 | 218,155 | 7 |
| list_windows | 7 | 61,421 | 0 |
| doctor | 1 | 5,548 | 0 |
| open/close session | 9 | 2,434 | 0 |
| **Total** | **42** | **745,285** | **16 (2.3 MB base64)** |

- Two accessibility observations (123,845 and 55,570 chars) went over the host's
  per-result limit and were written to files instead. The agent then had to parse
  those files with ad-hoc scripts just to find one control.
- The largest single responses:
  - full observe of Notepad at the default depth 8: 65,219 chars
  - `set_value` on the Save As dialog, whose act response embeds the dialog's full
    observation: 62,878 chars
  - Firefox `press_key enter`: 43,074 chars plus a 250 KB PNG
- The **average act response was 18,180 chars plus an image**. That is the price of
  every keypress.
- **Payload composition**, measured on two saved observations:

  | Component | Notepad / dialog (123,845 chars) | Firefox (55,570 chars) |
  |---|---:|---:|
  | `elements[]` | 69,994 (57%) | 31,666 (57%) |
  | `accessibility.hierarchy[]` (same nodes again) | 52,251 (42%) | 22,126 (40%) |
  | offscreen elements | 147 of 319 (28,455 chars) | 76 of 143 (15,319 chars) |
  | `metrics` | ~720 | ~720 |

## Root causes, traced to source

Line references are to the build that was tested: `feat/v8-claude-lifecycle` at
`e762f25`, the unmerged development stack (PRs for Road V1 items 9–18). `main`
(`84af905`) differs where noted.

**C1. Every node is serialized twice (regression in the unmerged stack).** At
`e762f25`, `winapp-backend.cjs` `inspect()` pushes each UIA node into `hierarchy`
and also into `flat` (`src/computer/winapp-backend.cjs:379-408`). Both arrays ship
in the response (`src/computer/controller.cjs:181`). The two copies repeat id, name
and controlType, which makes up about 40% of each observation. `main` emits only
`elements` (`winapp-backend.cjs:380` on `main`). **This must be fixed before the
stack merges.** Keeping the parent/child structure is fine, as long as it is
serialized only once.

**C2. Offscreen nodes are included.** Notepad with session restore exposed about 60
offscreen tab items. Firefox exposes about 30 hidden context menus. None of these can
be acted on, but every observation and every act pays for them.

**C3. Every act returns a full observation and screenshot.**
`controller.cjs:305-310` (`297-300` on `main`) runs `observeInternal` after each
action, at the retained depth, and returns it inline as `observation: fresh`. This
is present on `main` as well. There is no way to ask for a
compact result. A one-key action costs as much as a full observe.

**C4. Screenshots are always attached in full mode.** Input authority requires
`mode: full`, and full mode always sends the PNG at native resolution: 1436×1798 for
Firefox, up to 371 KB base64. The model has no way to say it doesn't need pixels for
this step.

**C5. Focus binding needs the focused control to be inside the observed depth.**
`type_text` and `press_key` at depth 1 failed with `not_dispatched` /
`focus_not_acquired` twice (Firefox URL bar, Firefox document). Failing closed was
correct, but the only remedy is a deeper, more expensive observation. The focused
element and its ancestor chain should always be included, whatever the depth.

**C6. `list_windows` is noisy.** Each call returned about 30 windows, about 9k chars,
including 1×1 shell windows, cloaked UWP hosts, the lock screen and full executable
paths. It was called 7 times, for 61k chars. It also has to be called again before
each `open_session` (`unknown_window` otherwise), which multiplies the cost.

**C7. No scoping.** You cannot observe a subtree, such as the Save dialog's file-name
box or a web document. The only control is a global depth.
`agent-desktop` offers `--root <ref>`, `--skeleton`, `-i` (interactive only) and
`--compact`. TRACE has no equivalent.

**C8. Fixed overhead in every response.** `metrics` (~720 chars), repeated
`executable` paths, `processCreationTime`, and `doctor`'s key-pattern regex printed
twice (~3k of its 5.5k chars).

## Functional defects found in the same run

These are recorded so they are not lost:

- **F1 — no launch.** TRACE cannot start an application. Every task needed a shell
  launch first. Launching `notepad` through `Start-Process` from Git Bash opened
  `OpenWith.exe` instead of Notepad.
- **F2 — modal dialogs need a new session.** The Save As dialog is a separate owned
  window (`ownerWindowId` set). From the Notepad session it showed up in the UIA tree
  but not in the screenshot, and the target reported `foreground:false, enabled:false`.
  The agent had to close the Notepad session, call `list_windows` again and open a
  session on the dialog.
- **F3 — window-closing actions report `unknown` / `internal_error`.** Three
  successful actions closed their own window: Save, Notepad Close, Firefox Close.
  Each returned `outcome: "unknown"`, `error.code: "internal_error"`,
  `"Window HWND … not found or not accessible."` Being conservative is right, but
  "the target window closed after dispatch" should be a distinct and documented
  outcome, not `internal_error`.
- **F4 — the document read failed on Notepad.** `documentElementId` on the
  `RichEditD2DPT` "Text editor" returned
  `{available:false, reason:"binding_unavailable"}`. Readback fell back to the window
  title and the "19 characters" status text.
- **F5 — `type_text` is throttled.** Every `type_text` carried the warning
  `"19 characters via send-input are auto-throttled into paced chunks…"`.
- **F6 — physical pointer use.** The Firefox link click moved the user's real cursor
  (`transport: same-point-button-down-up`). Every act changed the foreground window
  (`preparation: activation foreground`).
- **F7 — latency.** Each observation took 3–9 s of backend time (`metrics.backend`),
  and a click-and-verify step took 10–15 s.
- **F8 — no exact text readback for Notepad.** This follows from F4. Task 1 passed
  only on indirect evidence.

## Required fixes (acceptance-tested, in priority order)

Each fix needs a test that measures response size. These numbers are the bar.

| # | Fix | Acceptance |
|---|---|---|
| P0-1 | Serialize the tree once: drop `elements[]` or `hierarchy[]`, or emit a single nested compact form | Same Firefox depth-4 observation ≤ 55% of today's 41,642 chars |
| P0-2 | Exclude offscreen nodes by default; add an opt-in `includeOffscreen` | Notepad-with-60-tabs depth-8 observation lists 0 offscreen tab items |
| P0-3 | Make the act response compact by default: outcome, new `observationId`, changed focus/title, small diff. The full observation and PNG become opt-in (`returnObservation: "full" \| "summary" \| "none"`) | Default `press_key` response ≤ 1,500 chars, no image |
| P0-4 | Make the screenshot optional for an actionable observation, and add a downscale option (`screenshot: "none" \| "scaled" \| "full"`) without weakening dispatch guards | A full observation with `screenshot:"none"` still authorizes one action; PNG bytes = 0 |
| P0-5 | Always include the focused element and its ancestors, whatever the depth | Depth-1 observation of Firefox with the URL bar focused, then `type_text`, succeeds |
| P1-1 | Scoped observation: `rootElementId` (subtree) and `interactiveOnly` | Save dialog file-name box observable in ≤ 3,000 chars |
| P1-2 | `list_windows` filter: drop cloaked, 1×1 and tool windows by default; trim fields (`verbose` opt-in) | 30-window desktop ≤ 2,500 chars |
| P1-3 | `open_session` accepts a window id from a recent listing without a mandatory re-list, or `list_windows` takes a `processName`/`title` filter | Session on a just-launched window costs one small call |
| P1-4 | A distinct outcome `target_closed_after_dispatch`, replacing `internal_error` | Save/Close actions report it; the test covers it |
| P1-5 | Report response size (`responseBytes`) and add a skill rule: start at depth 2 and escalate only on need | Skill text and doctor field updated |
| P2-1 | Move `metrics` behind an opt-in flag; stop printing the key regex twice in `doctor` | `doctor` ≤ 2,500 chars; raised to 2,750 on 6 Nov 2026 after a real ready doctor measured 2,489 ([2.3.0 notes](RELEASE_2.3.0.md)) |
| P2-2 | Text readback for RichEdit/Notepad documents (F4) | Notepad text read back exactly |
| P2-3 | Optional `launch` tool, or a documented launcher contract (F1) | Notepad/Firefox/Settings launched without a shell |
| P2-4 | Modal-dialog handoff: a session follows an owned modal, or reports it explicitly (F2) | Save As completed without close/re-list/re-open |

**End-to-end acceptance:** rerun the same 16-task-run head-to-head with both tools.
TRACE's share must stay under **100k tokens** of context, about one quarter of what
3 task-runs cost today.

**Rerun result, 3 November 2026:** met. TRACE 2.0.0 used about 94k tokens (an upper
bound) for its 8 task-runs; both tools passed 6/8 and both failed Settings. See
[the head-to-head](HEAD_TO_HEAD_2026-11-03.md) and [the fix plan](FIX_PLAN_2.1.0.md).

## Evidence and logs

- Sanitized per-call measurements (committed):
  [`evidence/token-cost-2026-11-02/trace-calls.csv`](../evidence/token-cost-2026-11-02/trace-calls.csv).
  Columns: time (UTC), tool, action/mode, requested depth, JSON text chars, image
  count, image base64 bytes, error.
- Raw logs are kept **locally and not committed**, because they contain the owner's
  private window titles, document text, folder names and screenshots. They are in
  `%TEMP%\trace-vs-ad\raw\` on the test PC:
  - the full session transcript (`session-transcript.jsonl`)
  - the 16 PNG frames
  - the two over-limit observation JSON files
  - `trace-calls.csv`
  - `..\timing.log`
  - the saved test file `..\trace-1.txt`

  Do not delete them until P0 is fixed and remeasured.
- Environment: Windows 11 Home 10.0.26200, TRACE `trace-computer` 1.1.0
  (branch `feat/v8-claude-lifecycle` checkout), winapp 0.7.1, Notepad
  11.2607.14.0, Firefox 159 (MSIX).
- Incidental: the morning's project move had truncated `node_modules` (packages
  alphabetically before `r` were missing), so `trace-computer` and `rea` failed with
  `Cannot find module '@modelcontextprotocol/server'`. `npm ci` fixed it. That was
  not a TRACE code defect, but it is worth a doctor check for missing dependencies.
