# Head-to-head rerun, 3 November 2026: TRACE only, after the 2.1.0 fixes

This is step 3 of [fix plan M5](FIX_PLAN_2.1.0.md#m5-trace-rerun-and-210-release). It
reruns TRACE on the four tasks of [the 3 November head-to-head](HEAD_TO_HEAD_2026-11-03.md),
twice each, in one fresh Claude Code session. It measures merged `main` `b938941` (M1–M4,
PRs 117 and 118). `agent-desktop` 1.0.2 is unchanged, so its 3 November results are
reused and were not rerun.

**Result.** All 8 task-runs reached the required end state, with no MCP restart, but two
of the four bars were missed:

| Bar | Result |
|---|---|
| 8/8 pass | met. Run 1 task 1 needed a corrective type (defect D1). |
| No MCP restart | met |
| Context under 60k tokens | **not met**: about 74k (59k → 133k) |
| Response text under 100,000 characters | **not met**: 107,192 |

So the 2.1.0 candidate is not marked ready.

## Protocol

- The same rules, tasks and logging as on 3 November:
  - touch only windows TRACE launched
  - write only in the run folder
  - no shell or screenshot rescue
- Run folder: `%TEMP%\trace-vs-ad\2026-11-03-rerun\`. It has a suffix because the
  3 November folder already exists.
- Order: TRACE run 1, then TRACE run 2.
- Run 1 closed Firefox with ctrl+shift+w on purpose, to prove M2 in context. Run 2 used
  the Close button.
- Driver: Claude Code, Opus 5.5, medium effort, Windows 11 Home 10.0.26200. Notepad
  11.2607.14.0, Firefox 159 (MSIX).
- Before the run, doctor reported `ready: true` and `supervision.code: null`, so
  `computer setup --apply` was not needed.

## Results by task

Time and calls are means of the two runs. Calls come from the per-call CSV and include
errors and recovery calls.

| Task | Pass | Time | Calls | 3 Nov TRACE | 3 Nov AD (reused) |
|---|---|---|---|---|---|
| 1 Notepad text | 2/2 | 41 s | 7 | 2/2, 58 s, 7.5 | 2/2, 44 s, 5.5 |
| 2 Save As | 2/2 | 75 s | 13 | 2/2, 86 s, 11 | 2/2, 51 s, 14.5 |
| 3 Firefox | 2/2 | 93 s | 14 | 2/2, 99 s, 11.5 | 2/2, 79 s, 14.5 |
| 4 Settings | 2/2 | 28 s | 6 | 0/2 | 0/2 |
| **All** | **8/8** | | | 6/8 | 6/8 |

| Run | Task 1 | Task 2 | Task 3 | Task 4 |
|---|---|---|---|---|
| TRACE 1 | pass, 53 s, 9 calls (D1) | pass, 94 s, 16 calls | pass, 124 s, 17 calls (D2) | pass, 36 s, 7 calls |
| TRACE 2 | pass, 29 s, 5 calls | pass, 57 s, 10 calls | pass, 63 s, 11 calls | pass, 20 s, 5 calls |

What each run read back and how it closed:

- **Notepad text.** Both runs read the text exactly through TextPattern.
- **Saved files.** `trace-1.txt` and `trace-2.txt` were each exactly 19 bytes on disk.
- **Firefox.** The URL read `www.iana.org/help/example-domains` in both runs.
- **Settings.** `ms-settings:display` launched, and Scale read 300% (its combo box is
  disabled because custom scaling is on).
- **Closing.** Every close returned `target_closed_after_dispatch`, including the
  deliberate ctrl+shift+w in run 1 (M2).
- **Cold server.** The first observe in this fresh server took 1,232 ms with 8 provider
  calls and no `native_timeout`. A `native_timeout` occurred later on an act (D2).

## Context and response size

| Measure | Rerun | 3 Nov TRACE | 3 Nov AD |
|---|---:|---:|---:|
| Context, from the meter | ~74k (1 session) | ~94k (2 sessions) | ~59k |
| Response text | 107,192 characters | 151,697 | 82,686 |
| Calls | 81 | 68 | 98 |
| Images | 0 | 1 | 0 |

- **By run.**
  - Run 1: 64,700 characters, including its errors and recovery calls.
  - Run 2: 40,042 characters.
  - Doctor: 2,450 characters.
  - Run 2 alone extrapolates to about 80,000 characters for 8 task-runs.
- **By tool.** Observations were 91,216 characters (85%). Acts were 8,788 across 28
  calls; most used `returnObservation: "none"`.
- **Largest responses.**
  - Settings at depth 8 with `interactiveOnly` and `includeOffscreen`, needed to reach
    the offscreen Scale control: about 8,740 characters, once per run.
  - Firefox at depth 2 with `interactiveOnly`, needed to bind the focused URL bar:
    about 7,340 characters, once per run.
- **Context.** The meter rose from 59k to 105k after run 1 and to 133k after run 2. This
  also counts the driver's reasoning, the timing-log writes and status messages, so it
  is an upper bound.

## Defects, with exact errors

1. **D1: `type_text` reported `completed` for partial input (run 1, task 1).**
   - `type_text "trace-vs-ad trace 1"` returned `outcome: "completed"` with
     `verification: "fresh_observation"`.
   - Two TextPattern reads 6 s apart both returned `trace-vs-ad trac`, so the last 3
     characters never arrived.
   - Typing `e 1` completed the text. The same call in run 2 was exact.
   - The act's verification does not compare typed text, so silent input loss is
     reported as success.
2. **D2: `native_timeout` on `type_text` (run 1, task 3).**
   - `type_text "https://example.com\n"` into the Firefox URL bar returned
     `native_timeout`: "The owned operation was interrupted; verify its application
     effect before continuing." The outcome was `unknown`.
   - The URL bar stayed empty. A retry of `type_text` without the newline, then
     `press_key enter`, completed it.
   - The session was not quarantined, and later calls worked.
3. **Smaller gaps.** These are driver errors or correct refusals:
   - **Element bounds are not window-local.** They are in screen coordinates while the
     observation says `coordinateSpace: "window-local-physical-pixels"`. One click
     using them returned `invalid_coordinates`.
   - **Refused `press_key` under a narrow scope.** A scope that excluded the focused
     document made `press_key` return `focus_not_acquired`. This is correct, but it
     costs an extra observe.
   - **Two driver mistakes.** One observe used a guessed session ID
     (`unknown_session`). One invoke of `Close` was out of the depth-1 scope
     (`unknown_element`).

## Evidence

- [`evidence/head-to-head-2026-11-03-rerun/trace-calls.csv`](../evidence/head-to-head-2026-11-03-rerun/trace-calls.csv):
  one row per call, extracted from this session's Claude Code transcript, in the same
  columns as on 3 November. `options` adds `offscreen` and `metrics`.
- [`evidence/head-to-head-2026-11-03-rerun/results.json`](../evidence/head-to-head-2026-11-03-rerun/results.json):
  the per-run results, context readings, bars and defects above.
- Raw logs stay local because they hold private paths: `timing.log`, `trace-1.txt` and
  `trace-2.txt` in the run folder.
