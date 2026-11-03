# Head-to-head, 3 November 2026: TRACE 2.0.0 against agent-desktop 1.0.2

This is the end-to-end acceptance run named in the
[token cost incident](OBSERVATION_TOKEN_COST_INCIDENT.md): the same four tasks, each run
twice per tool, 16 task-runs in all. It measures TRACE 2.0.0 (main `b89574b`) after the
token cost fixes against Vercel Labs `agent-desktop` 1.0.2.

**Result.** Each tool passed 6 of 8 task-runs. Both failed the Settings task in both runs.
TRACE's context share was about **94k tokens** (an upper bound), under the 100k goal. On
2 November, 3 TRACE task-runs had used 420k. `agent-desktop` used about 59k. Two TRACE
defects and four smaller gaps were found; [the fix plan](FIX_PLAN_2.1.0.md) turns them
into milestones.

## Protocol

- Driver: Claude Code, Opus 5.5, medium effort, on Windows 11 Home 10.0.26200.
- Order: TRACE run 1, agent-desktop run 1, agent-desktop run 2, TRACE run 2.
- Apps: Notepad 11.2607.14.0, Firefox 159 (MSIX), Windows Settings.
- Rules set by the owner:
  - Touch only windows the driver launched. The owner's own Notepad window and draw.io
    Firefox window stayed open and were not touched.
  - Write files only in the run folder.
  - No shell or screenshot rescue: a tool that cannot do a step fails it.
  - Record each failure with its exact error.
- Tasks:
  1. **Notepad.** Launch, type `trace-vs-ad <tool> <run>`, read the text back.
  2. **Save As.** Save that text to `<tool>-<run>.txt` in the run folder, verify the file
     on disk, close Notepad.
  3. **Firefox.** Open `https://example.com`, follow "Learn more", verify the URL, close
     the window.
  4. **Settings.** Open System > Display, read the Scale value, change nothing, close.
- `agent-desktop` ran headless (its default). Its rules forbid headed recovery.
- Context was read from the Claude Code context meter before and after each block.

## Results by task

Pass is out of 2. Time and calls are medians, so with two runs they are the mean of the
two. Wall time includes model thinking between calls, so it measures the agent and tool
together, not the tool alone. Calls and characters come from the per-call logs; see
[Evidence](#evidence).

| Task | TRACE pass | TRACE time | TRACE calls | AD pass | AD time | AD calls |
|---|---|---|---|---|---|---|
| 1 Notepad text | 2/2 | 58 s | 7.5 | 2/2 | 44 s | 5.5 |
| 2 Save As | 2/2 | 86 s | 11 | 2/2 | 51 s | 14.5 |
| 3 Firefox | 2/2 | 99 s | 11.5 | 2/2 | 79 s | 14.5 |
| 4 Settings | 0/2 | — | 1–3 | 0/2 | — | 6 and 23 |
| **All** | **6/8** | | | **6/8** | | |

Per run:

| Run | Task 1 | Task 2 | Task 3 | Task 4 |
|---|---|---|---|---|
| TRACE 1 | pass, 37 s, 6 calls | pass, 62 s, 9 calls | pass, 99 s, 12 calls (close quarantined) | fail |
| AD 1 | pass, 51 s, 6 calls | pass, 73 s, 16 calls | pass, 96 s, 15 calls | fail, 79 s, 6 calls |
| AD 2 | pass, 36 s, 5 calls | pass, 29 s, 13 calls | pass, 61 s, 14 calls | fail, 84 s, 23 calls |
| TRACE 2 | pass, 78 s, 9 calls | pass, 109 s, 13 calls | pass, 98 s, 11 calls | fail |

Readbacks:

- Notepad text, both TRACE runs: read exactly through TextPattern (`documentElementId`).
- Saved files: `trace-1.txt` and `trace-2.txt` were each 19 bytes, exact on disk.
- Firefox URL: `www.iana.org/help/example-domains` in all four runs. TRACE read it
  through TextPattern on the address bar.
- Neither tool found an accessible "Example Domains" heading; the page title came from
  the document name.

## Context and response size

| Measure | TRACE | agent-desktop |
|---|---:|---:|
| Context, from the meter | ~94k tokens | ~59k tokens |
| Tool response text, all calls | 151,697 characters | 82,686 characters |
| Calls | 68 (including 4 doctor calls and 8 failed or recovery calls) | 98 |
| Images | 1 (a scaled 953×537 PNG) | 0 |

- **TRACE context.**
  - Run 1, tasks 1–3 and the recovery: 86k → 122k, about 36k (first session).
  - Doctor, run 1 task 4 and all of run 2: 77k → 135k, about 58k (second session, after
    an MCP reconnect and `/clear`).
  - Both readings also hold the driver's reasoning, log writes and tool schema loading.
    The total is an upper bound.
- **Comparison with 2 November.** That run used 745,285 characters and 16 images for 3
  task-runs, about 248k characters per task-run. This run averaged about 19k per
  task-run, roughly 13 times less.
- **TRACE acts are now small.** The 24 act calls averaged about 490 characters. Most
  returned `returnObservation: "none"` (163 characters).
- **Observations are now most of the cost.** They were 89% of run 2's response text.
  The largest were:
  - Save As dialog, followed modal, `interactiveOnly` at depth 8: 20,882 characters.
  - Firefox window, `interactiveOnly` at depth 6: 18,094 characters.
  - Notepad, scaled image at depth 4: 11,744 characters plus the image.
  - Notepad, `interactiveOnly` at depth 6 and at depth 10 scoped to the window root:
    about 7,000 characters each, and neither held the text editor.
- **Strategy mattered more than the tool.** Run 1 kept depth at 1–3 and used 52,306
  characters across 32 calls. Run 2 used `interactiveOnly` at depths 5–8 and used 99,398
  characters across 36 calls. `interactiveOnly` saves less than expected: winapp's `-i`
  keeps unnamed groups and separators, and many Firefox and dialog nodes count as
  interactive.
- **agent-desktop spikes.** One unscoped `find --role link` in Firefox returned 24,176
  characters of offscreen new-tab links. Run 2's Settings attempt used 28,608 characters
  across 23 calls.

## Failures, with exact errors

### TRACE

1. **Settings cannot be launched (run 1 and run 2, task 4).**
   - `trace_computer_launch { app: "SystemSettings" }` and `"SystemSettings.exe"` both
     returned `unknown_application`: "No App Paths registration has this name."
   - Doctor reports `launch: { catalog: "app-paths", shell: false, uri: false }`.
     Settings is a packaged app with no App Paths entry, and `ms-settings:` URIs are
     refused by design.
   - Under the no-shell rule there is no other way in, so the task failed at its first
     call.
2. **A keyboard shortcut that closes the window quarantines input (run 1, task 3).**
   - After the URL was verified, `press_key ctrl+shift+w` closed Firefox. The act
     returned `outcome: "unknown"` with `input_recovery_required`, and the native cause
     was `foreground_unavailable`: "No foreground input window is available for
     verification."
   - Cause: after dispatch the native owner proves the declared keys are released
     (`native/TraceSupervisor/Session.cs`, `FinishInput` → `InputState.ReleaseDeclared`),
     which first calls `InputState.EnsureObservable`
     (`native/TraceSupervisor/InputState.cs:49`). While Windows moves the foreground
     after a window closes, `GetForegroundWindow()` briefly returns 0. TRACE then treats
     key release as unproven, quarantines the session and writes a durable recovery
     record.
   - `computer recover --check` showed no keys down, and `computer recover --apply`
     returned `recovered: true, released: true`.
   - Closing through a button does not have this problem. Save, the Close buttons and
     one `enter` that closed Save As returned `target_closed_after_dispatch` five times.
     In each of those cases another window (the owner, or the next window) took the
     foreground at once. The likely trigger is a close that leaves no immediate
     foreground window; M2 must confirm it.
3. **The session stays stuck after a successful recovery (run 1, task 4 blocked).**
   - After `recover --apply`, `close_session` kept returning the same
     `input_recovery_required`, and `launch` returned `desktop_busy`.
   - Cause: `NativeSupervisor.release` caches the failure in `releaseErrors`
     (`src/computer/supervisor.cjs`, set at line 246) and rethrows it on every later
     call (line 221). Nothing clears it when durable recovery succeeds, so the lease
     cannot be released until the MCP server restarts.
   - The owner reconnected `trace-computer` with `/mcp`. Doctor then reported ready, and
     task 4 was run in the second session.

### agent-desktop

1. **Settings, run 1.** `launch C:\Windows\ImmersiveControlPanel\SystemSettings.exe`
   returned ok (it attached a pid), but no Settings window appeared, also with
   `--activate`.
2. **Settings, run 2.**
   - `--headed open-system-surface start-menu` opened Settings.
   - Clicking the System navigation item (`LegacyIAccessible.DoDefaultAction`) returned
     `delivered_unverified` twice, and the page did not change.
   - The headless rule forbids headed recovery, so the task stopped.
3. **Minor.**
   - `launch firefox` failed by name; the absolute MSIX path worked.
   - One 30-second `wait --menu` timed out in Save As, and one surface error occurred.
   - Two calls failed on the driver's own argument mistakes.

### Driver mistakes (not tool defects)

- TRACE run 2: `documentElementId` with `accessibilityDepth: 1` returned `stale_element`
  ("Document target must be a unique currently observed control"), because depth 1 holds
  only the window. Depth 2 worked.
- TRACE run 2: `set_value` on the Save As File name box was refused as `not_dispatched`
  with `unsupported_action`. This is the intended 2.0 guard: the dialog would have saved
  under its old name. Click, ctrl+a and `type_text` then worked.

## What each tool did better

**TRACE**

- Launched Notepad and Firefox by name. Both handed off to an existing process, and TRACE
  returned the new window with `handedOff: true`. The new Notepad window was a separate
  window from the owner's own Notepad window, which was never touched.
- Exact readback on screen: TextPattern returned the Notepad text and the Firefox URL
  verbatim.
- Save As in one session: `ownedModal` → `followModal` → Save, then
  `target_closed_after_dispatch` with `returnedToOwner: true` and no re-listing.
- Window-closing actions (Save, the Close buttons) were reported as
  `target_closed_after_dispatch`, not as errors.
- Safety: the file-dialog guard refused a silent wrong save, and the quarantine refused
  to trust unproven key release. That guard was too strict here, but it is
  conservative.

**agent-desktop**

- Faster on every task, with fewer calls on Notepad.
- About 37% less context overall and no images.
- Never got stuck; every failure was local to one call.
- Its `find` with a role and name filter hit the right control in one call.

**Neither** could complete Settings: TRACE could not open it, and agent-desktop could open
it but not navigate it.

## Verdict

- **Correctness:** a tie at 6/8.
- **Cost and speed:** `agent-desktop` was cheaper and faster.
- **Verification:** TRACE gave stronger proof that each step worked (exact readback,
  modal follow, closed-window outcomes) and refused unsafe input.
- **Reliability:** TRACE's stuck session after recovery is a real gap; one keyboard
  close cost a server restart.
- **Incident acceptance:**
  - **Met:** TRACE's share stayed under 100k tokens.
  - **Caveats:**
    - The run spanned two sessions and an MCP reconnect.
    - The context reading is an upper bound.
    - Task 4 failed for reasons outside token cost.

## Gaps found

| ID | Gap | Severity | Milestone |
|---|---|---|---|
| G1 | Cached `releaseErrors` keeps the session stuck after `recover --apply` | High: needs a server restart | [M1](FIX_PLAN_2.1.0.md#m1-release-the-session-after-a-confirmed-recovery) |
| G2 | A keyboard close (ctrl+shift+w, ctrl+w, alt+f4) quarantines input on a transient missing foreground | High: triggers G1 | [M2](FIX_PLAN_2.1.0.md#m2-keyboard-close-reports-target_closed_after_dispatch) |
| G3 | Settings (packaged apps, `ms-settings:`) cannot be launched | Medium: task 4 fails | [M3](FIX_PLAN_2.1.0.md#m3-launch-settings-and-other-packaged-apps) |
| G4 | `interactiveOnly` drops Notepad's `Document`, yet keeps empty groups and separators; dialog and browser observations reach 18–21k characters | Medium: cost | [M4](FIX_PLAN_2.1.0.md#m4-leaner-interactive-observations) |
| G5 | `documentElementId` outside the observed depth returns a generic `stale_element` | Low | [M4](FIX_PLAN_2.1.0.md#m4-leaner-interactive-observations) |
| G6 | Settings navigation is unproven for TRACE (agent-desktop's nav click did not navigate) | Medium | [M3](FIX_PLAN_2.1.0.md#m3-launch-settings-and-other-packaged-apps) |

## Evidence

- Sanitized per-call logs (committed):
  - [`evidence/head-to-head-2026-11-03/trace-calls.csv`](../evidence/head-to-head-2026-11-03/trace-calls.csv):
    time, run, task, tool, action, options (mode, screenshot, depth, `io` for
    `interactiveOnly`, `root`, `doc`, `modal`, returnObservation), text characters,
    images and error or outcome. It was extracted from the two Claude Code session
    transcripts. Task labels near a task boundary are approximate within one call.
  - [`evidence/head-to-head-2026-11-03/agent-desktop-calls.csv`](../evidence/head-to-head-2026-11-03/agent-desktop-calls.csv):
    time, run, task, command verb and output characters, from the logging wrapper.
    Arguments are dropped because they hold local paths.
  - [`evidence/head-to-head-2026-11-03/results.json`](../evidence/head-to-head-2026-11-03/results.json):
    the per-run results, times, context readings and failures above.
- Raw logs stay local, because they hold private window titles and paths:
  `%TEMP%\trace-vs-ad\2026-11-03\` (`timing.log`, `ad-calls.tsv`, `ad.sh`, `trace-1.txt`,
  `trace-2.txt`, `ad-1.txt`, `ad-2.txt`).
- Environment: TRACE 2.0.0 at `b89574b` (installed `trace-computer` from the main
  checkout), winapp 0.7.1, `agent-desktop` 1.0.2 (global npm), Claude Code Opus 5.5 at
  medium effort.
