# Head-to-head rerun 2, 3 November 2026: TRACE only, after the M7 fixes

This is the second attempt at step 3 of
[fix plan M5](FIX_PLAN_2.1.0.md#m5-trace-rerun-and-210-release), as
[M7](FIX_PLAN_2.1.0.md#m7-rerun-fixes-then-the-m5-step-3-rerun) asks. It reruns TRACE on the
four tasks of [the 3 November head-to-head](HEAD_TO_HEAD_2026-11-03.md), twice each, in one
Claude Code session. It measures merged `main` `2b5d0da` (M1–M4 and M7, PRs 117, 118 and 121).
`agent-desktop` 1.0.2 is unchanged, so its 3 November results are reused and were not rerun.
The first rerun (`b938941`) is reported on PR 120 as `docs/HEAD_TO_HEAD_2026-11-03-RERUN.md`.

**Result.** All 8 task-runs reached the required end state, and every bar was met:

| Bar | Result | First rerun |
|---|---|---|
| 8/8 pass | met, with no corrective retyping | met, with one corrective type (D1) |
| No MCP restart | met | met |
| Context under 60k tokens | met: about 53k (74k → 127k) | not met: about 74k |
| Response text under 100,000 characters | met: 68,760 | not met: 107,192 |

## Protocol

- The same rules, tasks and logging as on 3 November:
  - touch only windows TRACE launched; the owner's own Notepad and Firefox windows were
    not touched
  - write only in the run folder
  - no shell or screenshot rescue
- Run folder: `%TEMP%\trace-vs-ad\2026-11-03-rerun2\`. The suffix is there because the
  `2026-11-03` and `2026-11-03-rerun` folders already exist.
- Order: TRACE run 1, then TRACE run 2.
- Run 1 closed Firefox with ctrl+shift+w on purpose, to prove M2 in context. Run 2 used
  the Close button.
- Every observe passed `interactiveOnly`, as the synced skill now recommends.
- Driver: Claude Code, Opus 5.5, medium effort, Windows 11 Home 10.0.26200. Notepad
  11.2607.14.0, Firefox 159 (MSIX).
- Before the run:
  - `node scripts/sync-computer-skill.cjs --apply` updated all three skill copies to
    main's `SKILL.md` (`fe991402…`)
  - `trace-computer` was reconnected once so it loaded merged `main`; there was no
    restart during the 8 task-runs
  - doctor reported `ready: true` and `supervision.code: null`, so
    `computer setup --apply` was not needed
- **Session.** The session was not new: it had earlier checked PR 121, merged it and
  synced the skill. The context bar is measured as the rise across the 8 task-runs, as in
  the first rerun, so the prior turns do not count against it.

## Results by task

Time and calls are means of the two runs. Calls come from the per-call CSV and include
errors and recovery calls. Times are slower than in the first rerun because the driver
also wrote status messages to the owner between calls; time is not a bar.

| Task | Pass | Time | Calls | First rerun | 3 Nov TRACE | 3 Nov AD (reused) |
|---|---|---|---|---|---|---|
| 1 Notepad text | 2/2 | 81 s | 7.5 | 2/2, 41 s, 7 | 2/2, 58 s, 7.5 | 2/2, 44 s, 5.5 |
| 2 Save As | 2/2 | 110 s | 10.5 | 2/2, 75 s, 13 | 2/2, 86 s, 11 | 2/2, 51 s, 14.5 |
| 3 Firefox | 2/2 | 151 s | 11.5 | 2/2, 93 s, 14 | 2/2, 99 s, 11.5 | 2/2, 79 s, 14.5 |
| 4 Settings | 2/2 | 57 s | 6 | 2/2, 28 s, 6 | 0/2 | 0/2 |
| **All** | **8/8** | | | 8/8 | 6/8 | 6/8 |

| Run | Task 1 | Task 2 | Task 3 | Task 4 |
|---|---|---|---|---|
| TRACE 1 | pass, 78 s, 6 calls | pass, 123 s, 12 calls | pass, 150 s, 12 calls | pass, 59 s, 6 calls |
| TRACE 2 | pass, 84 s, 9 calls | pass, 97 s, 9 calls | pass, 151 s, 11 calls | pass, 54 s, 6 calls |

What each run read back and how it closed:

- **Notepad text.** Both runs read the text back exactly through TextPattern on the first
  try. D1 did not recur.
- **Saved files.** `trace-1.txt` and `trace-2.txt` were each exactly 19 bytes on disk.
  The 75-character path `type_text` in run 1 returned `textDelivery.status: "verified"`.
- **Firefox.** `type_text "https://example.com"` then `press_key enter` navigated in both
  runs, with no `native_timeout` (D2 did not recur). The URL read
  `www.iana.org/help/example-domains` in both runs, through `documentElementId` on
  `urlbar-input`.
- **Settings.** `ms-settings:display` launched and Scale read 300% (its combo box is
  disabled because custom scaling is on).
- **Closing.** Every close returned `target_closed_after_dispatch`, including the
  deliberate ctrl+shift+w in run 1 (M2).

## Context and response size

| Measure | This rerun | First rerun | 3 Nov TRACE | 3 Nov AD |
|---|---:|---:|---:|---:|
| Context, from the meter | ~53k | ~74k | ~94k (2 sessions) | ~59k |
| Response text | 68,760 characters | 107,192 | 151,697 | 82,686 |
| Calls | 72 | 81 | 68 | 98 |
| Images | 0 | 0 | 1 | 0 |

- **By run.** Doctor 2,450 characters. Run 1: 42,873. Run 2: 23,437.
- **By tool.** Observations were 47,137 characters (69%), against 91,216 (85%) in the first
  rerun. Acts were 14,421 across 28 calls.
- **Largest responses.**
  - Settings in run 1, whole window at depth 8 with `interactiveOnly` and
    `includeOffscreen`: 7,691 characters (8,740 in the first rerun). Run 2 scoped the same
    read to the Scale combo box by its automation ID: 992 characters.
  - The Save As dialog at depth 2 in run 1: 3,497 characters. Run 2 scoped the
    `followModal` observe straight to the File name box: 1,077 characters.
- **Context.** The meter rose from 74k to 106k after run 1 and to 127k after run 2. This
  also counts the driver's reasoning, the timing-log writes and status messages, so it
  is an upper bound.

## Findings, with exact errors

No product defect was found. Two refusals and one missing read were seen, each handled in
one step:

1. **`foreground_not_target` on a launched window (run 2, task 1).** `launch notepad`
   returned the new window without `foreground: true`. The first `click` on the editor
   returned `not_dispatched`: "Windows refused activation of the selected window." An
   `activate` act then completed, and the click after it worked. The refusal was correct;
   the cost was 2 extra calls.
2. **`focus_not_acquired` in Save As (run 1, task 2).** The depth-2 dialog observe
   reported the focused control as the File name `Edit` with `binding: "unresolved"`,
   because the edit sits below the depth-2 `ComboBox`. `press_key ctrl+a` returned
   `not_dispatched`: "Keyboard focus could not be bound to an observed control inside the
   exact selected window." Observing with `rootElementId: "FileNameControlHost"` listed the
   edit, and `ctrl+a` then completed. Run 2 scoped the dialog observe this way from the
   start.
3. **No URL value in a toolbar read (run 1, task 3).** An `interactiveOnly` read of
   `nav-bar` listed `urlbar-input` without its text. `documentElementId: "urlbar-input"`
   read it. Run 2 used the document read directly.

## Evidence

- [`evidence/head-to-head-2026-11-03-rerun2/trace-calls.csv`](../evidence/head-to-head-2026-11-03-rerun2/trace-calls.csv):
  one row per call, extracted from this session's Claude Code transcript, in the same
  columns as before. Each row is assigned to a task by its result time against the
  timing log. `options` adds `io` (`interactiveOnly`), `offscreen` and `modal`; for acts
  it is `returnObservation`.
- [`evidence/head-to-head-2026-11-03-rerun2/results.json`](../evidence/head-to-head-2026-11-03-rerun2/results.json):
  the per-run results, context readings, bars and findings above.
- Raw logs stay local because they hold private paths: `timing.log`, `trace-1.txt` and
  `trace-2.txt` in the run folder.
