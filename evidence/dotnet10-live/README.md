# .NET 10 live evidence, 7 November 2026

Native live checks of the .NET 10 helper build for TRACE 2.3.0. The scope matches the
.NET 9 evidence: live smoke, glow, injected stop, all 15 recovery cells, quarantine,
focused typing and clipboard.

- **Source:** main at `0a3381be42cbd577bd47208d9020e84e38f9bf11`, run from the owner's
  main checkout. The only untracked files were the evidence directories.
- **Runner:** Windows 11 Home 10.0.26200, Node v26.2.0, .NET SDK 10.0.403, Windows
  Desktop runtime 10.0.14, helpers `net10.0-windows`, doctor ready, one monitor at
  2880×1800 and 144 DPI.
- **Files:** [summary.json](summary.json) lists every case with its status, attempt and
  the sha256 of its receipt. The raw receipts, frames and screenshots (224 files, about
  2.8 MB) stay untracked in the owner's checkout, and the hashes pin them.

## Results

| Area | Result |
|---|---|
| Live smoke (`smoke-computer-live`) | Pass: 20 actions, 23 frames |
| Glow self-check | Pass |
| Glow independent and regression | START, VISIBLE, EOF and PARENT-LOSS pass. The two click subcases need `--coordinated` with the reference executor, so they are blocked or not run by design, as on .NET 9 |
| Injected stop | Pass, cleanup clean |
| Recovery, 15 cells | All 15 pass: cancel, timeout, disconnect, node death and supervisor death, each with mouse, chord and typing |
| Quarantine ACK mouse | Pass on attempt 2 |
| Quarantine ACK chord | Pass |
| Focused typing | Pass: text `abc`, focus on the observed edit, keys released |

## Not run

- **Quarantine ACK typing and clipboard Unicode paste:** both need a claim in the
  historical live-acceptance continuation ledger. That budget is closed: clipboard has
  used both claims, and typing's last claim is only for a corrective retry after a
  failure. The earlier passes were on .NET 9. Owner decision, 7 November 2026: record
  both as not run on .NET 10 and leave the ledger alone. Later that day the owner chose
  to re-prove both on .NET 10 under a new acceptance contract, drafted in its own PR
  before any live run.

## Blocked attempts and how they were resolved

- **GameInputSvc foreground lock.** A `GameInputServiceWindow` owned by `GameInputSvc`
  took the foreground whenever a cell's fixture closed. Its process denies
  `OpenProcess`, so TRACE correctly refused input with `foreground_access_denied` before
  any dispatch. CANCEL-CHORD was blocked twice (`recovery/` and
  `recovery-cancel-chord-attempt-2/`) and CANCEL-TYPING once. This was environmental,
  not a .NET 10 fault, and nothing was dispatched.
  - After the owner clicked an ordinary window, CANCEL-CHORD passed in a fresh
    directory (`recovery-cancel-chord-attempt-3/`, owner approved). Its harness attempt
    field reads 1 because a new directory starts a new declared run.
  - The remaining 13 cells ran one `--case` at a time through a private runner. It keeps
    an owned fixture window as a foreground anchor and re-activates it after each cell's
    cleanup, which is the method the .NET 9 matrix used. Every receipt records
    `foregroundPreparation.prepared: true`. CANCEL-TYPING ran as attempt 2 with
    `--prior`.
- **Quarantine harness entry order.** Run directly, `accept-supervisor-quarantine.cjs`
  starts `run()` before it sets `module.exports`. `replacement-acceptance-common.cjs`
  then receives an empty module, and cleanup fails with `shared.waitFor is not a
  function`. Mouse attempt 1 failed this way after the effect, with input released and
  recovery clear. Attempt 2, and chord, ran through a private wrapper that imports the
  unchanged harness and calls `run()`. The entry-order fix ships separately.

## After publication: physical stops, 7 November 2026

Run after 2.3.0 was published, from the main checkout detached at `f2153fc`. The native
supervisor sources hash the same as above, so these cover the published build. Results
are in `postPublication` in [summary.json](summary.json).

| Case | Result |
|---|---|
| Physical mouse stop (`stop-physical-mouse-restart/`) | Pass: physical Escape seen 0.53 ms after the hook event, held button released 239 ms later, later action rejected with `session_stopped`, new session counter +1 |
| Physical keyboard stop (`stop-physical-keyboard-restart/`) | Pass: physical Escape seen 0.74 ms after the hook event, held C released 230 ms later, text `abc` stable, later action rejected, new session counter +1 |

Both ran through a private runner, `.runtime/run-dotnet10-stop.cjs`. It calls the
unchanged `scripts/accept-supervisor-stop.cjs` `run()` with the audible cue on and writes
the root start file as soon as the harness prints `PREPARED`.

Four earlier attempts did not pass. None was a TRACE fault, and each cleaned up with no
input held and no recovery needed:

- Mouse attempt 1 was blocked with `physical_tap_late`. The owner's audio was not
  working, so the cue played but was not heard.
- Mouse attempt 2 was blocked the same way. The owner was not clearly told to press
  Escape.
- Keyboard attempt 1 failed before any input was held: the fixture lost focus after
  `PREPARED`.
- Keyboard attempt 2 was blocked. The cue told the owner to wait for growing `c` text,
  but a synthetic held key does not autorepeat, so the text stayed `abc`.

The owner then restarted both cases with a fresh budget. Before each run, the owner was
given the step-by-step instructions and asked whether they were ready.
