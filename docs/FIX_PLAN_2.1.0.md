# Plan: release 2.0.0, then close the head-to-head gaps in 2.1.0

Written 3 November 2026 from the [head-to-head results](HEAD_TO_HEAD_2026-11-03.md).
The owner's order is **release 2.0.0 first, then a new version for the fixes**.

- **2.0.0** ships what is on `main` now (`b89574b`), with the head-to-head findings as
  known limits. No code changes.
- **2.1.0** holds the fixes. It is a minor version: M3 adds a launch capability, and M1,
  M2 and M4 are compatible fixes. No 2.0 contract changes.

Every step that merges, tags, publishes or takes over the desktop needs the owner's
approval. The owner runs `gh pr merge` and `sync-computer-skill --apply` themselves.

## Milestone overview

| ID | Outcome | Gaps | Depends on | Desktop needed |
|---|---|---|---|---|
| R0 | 2.0.0 published | — | — | no |
| M1 | Session released after a confirmed recovery | G1 | R0 | yes, about 10 min |
| M2 | Keyboard close reports `target_closed_after_dispatch` | G2 | M1 | yes, about 15 min |
| M3 | Settings and other packaged apps launch; Settings navigation proven | G3, G6 | R0 | yes, about 20 min |
| M4 | Leaner interactive observations and a clear document-read error | G4, G5 | R0 | yes, about 10 min |
| M5 | TRACE rerun of the 4 tasks × 2; 2.1.0 published | all | M1–M4 | yes, about 30 min |
| M6 | Optional hygiene | — | — | no |

M1 must land before M2. Until M2 is fixed, ctrl+shift+w is the only known way to
reproduce the stuck session, and M1's live check needs it. M3 and M4 are independent of
M1 and M2 and can run in parallel worktrees.

Branch and PR rules (from [VERSION_CONTROL.md](../VERSION_CONTROL.md)):

- One PR per milestone, 2–3 commits (4 at most): implementation, verification and
  documentation.
- Worktrees go in `../trace-workbench-worktrees/<name>`. Link `.runtime` and
  `node_modules` by junction. Before `git worktree remove`, remove each junction with
  `cmd /c rmdir`; never delete recursively through it.

## R0. Publish 2.0.0

`package.json` is already `2.0.0` on `main`. [RELEASE_2.0.0.md](RELEASE_2.0.0.md) still
calls itself "a candidate on a stacked development branch". Follow the 1.1.0 pattern:
PR #64 prepared the candidate and PR #65 recorded the publication.

1. **Candidate PR** (`release/2.0.0-candidate`, 2 commits):
   - `docs/RELEASE_2.0.0.md`:
     - status: a candidate on `main`
     - replace "No … 16-task head-to-head rerun has been made" with a link to
       [the head-to-head](HEAD_TO_HEAD_2026-11-03.md)
   - Add a **Known limits** section with workarounds:
     - G1: after `computer recover --apply`, reconnect `trace-computer` (`/mcp`) before
       the next session.
     - G2: close windows with their Close button, not a keyboard shortcut.
     - G3: Settings and other packaged apps without an App Paths entry cannot be
       launched; `ms-settings:` is refused.
     - G4: prefer depth 2–3 with `rootElementId` over `interactiveOnly` at depth 6 or
       more.
   - Update the version lines in `VERSION_CONTROL.md`, `README.md` and `SPEC.md`, as
     commit `f1c1c25` did for 1.1.0.
   - Check that `package-lock.json` says `2.0.0` in both places.
2. **Owner merges.** Hosted Windows CI on the resulting `main` commit must pass. If
   `smoke-mcp` times out on `Get-CimInstance`, rerun once and record both runs.
3. **Delivery folder**, built as in [RELEASE_PROCEDURE.md](RELEASE_PROCEDURE.md) and
   matching the five assets of [the 1.1.0 receipt](../evidence/release-1.1.0/publication.json):
   - `trace-workbench-2.0.0-source.zip`: `git archive --format=zip
     --prefix=trace-workbench/` at the tested main commit, with `TZ=UTC`. Its SHA-256
     and size must match CI's verified archive.
   - `acceptance-manifest.json`
   - `distribution-receipt.json`: commit, archive hash and bytes, CI URL and verifier
     result.
   - `RELEASE_NOTES.md`: a copy of `docs/RELEASE_2.0.0.md`.
   - `SHA256SUMS.txt`
   - Run `node scripts/verify-archive-install.cjs` against the archive.
4. **Owner approval**, then tag `v2.0.0` on the tested main commit, run
   `gh release create v2.0.0` with the five assets, and download them again to verify
   their hashes.
5. **Publication PR** (`docs/2.0.0-publication`):
   - `evidence/release-2.0.0/publication.json`, in the same fields as 1.1.0
   - mark 2.0.0 published in `RELEASE_2.0.0.md`, `VERSION_CONTROL.md`, `README.md` and
     `SPEC.md`

**Done when:** the v2.0.0 release is live, its asset hashes are verified, and
`publication.json` is merged.

## M1. Release the session after a confirmed recovery

**Gap G1.** `NativeSupervisor.release` (`src/computer/supervisor.cjs`) stores a failed
release in `this.releaseErrors` (line 246) and rethrows it on every later call (line 221).
`computer recover --apply` runs in another process and clears the durable recovery
record, but the MCP server never learns of it. `close_session` keeps failing, `launch`
returns `desktop_busy`, and only an MCP restart helps.

**Change.**

1. When `release(sessionId)` finds a cached error, re-check durable state instead of
   rethrowing at once:
   - call `recovery('--check')`, which already exists in the same file
   - confirm the native owner child has exited (`this.child === null`)
2. If no recovery is required and the child is gone:
   - delete the cache entry
   - return `{ cleanup: 'confirmed', recoveredExternally: true }`
3. Otherwise rethrow the cached error unchanged. Safety must not weaken: an unapplied
   recovery still refuses.
4. Make sure the controller (`src/computer/controller.cjs`) lets go of the lease when
   that release succeeds, so `launch` and `open_session` work again.
5. Have doctor report the stale session while it is stuck, for example
   `supervision.code: 'release_pending_recovery'`, so the agent knows to run
   `recover --check` and then `--apply`.

**Tests** (a focused file such as `tests/v12-release-after-recovery.test.cjs`, with a
fake supervisor child and recovery store):

- release fails → durable record present → `close_session` still refuses
- release fails → record cleared → `close_session` confirms → `launch` is not
  `desktop_busy`
- release fails → record cleared but the child is still alive → still refuses

**Live check** (on windows TRACE launches): open Firefox and press ctrl+shift+w (this
still quarantines before M2). Run `computer recover --check`, then `--apply`. Then
`close_session` and `launch notepad` must succeed with no `/mcp` reconnect.

**Done when:** the tests pass, the live check passes once, and CI is green.

## M2. Keyboard close reports target_closed_after_dispatch

**Gap G2.** After the keys are sent, the native owner proves they are released:
`native/TraceSupervisor/Session.cs` → `FinishInput` → `InputState.ReleaseDeclared` →
`InputState.EnsureObservable`. `EnsureObservable` throws `foreground_unavailable` when
`GetForegroundWindow()` returns 0 (`native/TraceSupervisor/InputState.cs:49`). When a
keyboard shortcut closes the window, the foreground is briefly empty. Release is then
unproven and the session is quarantined, although no key is down. The controller's
closed-window path (`controller.cjs`, around line 520) only applies when the error is not
`inputRecoveryRequired`.

**Change.**

1. **Confirm the cause first.** Log the time from dispatch to a nonzero foreground for
   ctrl+shift+w in Firefox and ctrl+w in Notepad. (alt+f4 never reaches this path: winapp
   0.7.1 refuses system-reserved keys before sending; see the M2 live result on PR 114.)
2. **Wait briefly for the foreground.** In `EnsureObservable`, or only on the post-dispatch
   release path, poll `GetForegroundWindow()` every 25 ms for a bounded time (proposed
   1,000 ms) while it returns 0. Then run the existing checks unchanged:
   - same desktop
   - process access
   - integrity level
   - stable foreground
3. **Keep the failure if it persists.** If the foreground is still 0 after the wait,
   keep today's quarantine.
4. **Leave the pre-dispatch check alone.** The `input_busy` check before input stays as
   it is.
5. **Check the controller path.** The controller should then see a completed native
   action and a closed target and return `target_closed_after_dispatch`.
6. **Rebuild the supervisor.** It is native code, so rebuild with `computer setup
   --apply`. Doctor reports `supervisor_stale` until then.

**Tests:**

- Native or harness tests for the bounded wait: a foreground that returns after 200 ms
  passes, one still missing after the limit fails with the same error.
- Recheck `scripts/accept-supervisor-quarantine.cjs` and
  `scripts/accept-supervisor-recovery.cjs` at their stated scope, since this touches
  the release proof. Explain in the PR why the earlier evidence still holds or must be
  rerun.

**Live check:**

- Firefox: ctrl+shift+w.
- Notepad: ctrl+w on the last tab. (alt+f4 was planned here; winapp 0.7.1 refuses it
  before sending, so it was replaced by the Close button, and the refusal now reports
  `not_dispatched`.)
- All on windows TRACE launched. Each must return `target_closed_after_dispatch`, leave
  no recovery record (`recover --check` clean) and keep doctor ready.

**Done when:** 3 of 3 keyboard closes pass live and no quarantine regression shows.

## M3. Launch Settings and other packaged apps

**Gaps G3 and G6.**

- `trace_computer_launch` only reads App Paths (`src/method/installed-applications.cjs`;
  doctor reports `launch.catalog: "app-paths", uri: false`). Settings has no App Paths
  entry.
- agent-desktop could open Settings, but its navigation click did not navigate, so
  Settings navigation needs its own proof.

**Owner decision needed before coding.** Choose one; option A is recommended:

- **A. Packaged apps by AUMID.** Call `IApplicationActivationManager.ActivateApplication`
  from the bridge, with no shell, plus a fixed allowlist of `ms-settings:` pages
  (`ms-settings:display` first) through protocol activation. Doctor reports
  `launch.catalog: ["app-paths", "packaged"]` and `uri: "allowlist"`.
- **B. Packaged apps by AUMID only.** No URIs; the agent navigates to Display itself.

**Change (option A).**

1. **Catalog.** Resolve a friendly name (`Settings`) or an AUMID
   (`windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel`)
   through the package catalog. Never through `cmd`, `explorer` or `start`.
2. **Window identity.** Settings runs inside `ApplicationFrameHost.exe`, so its window's
   executable is not `SystemSettings.exe`. The handoff rule (`handedOff: true` only when
   the new window's executable resolves to the registered EXE) needs a packaged-app rule:
   - accept a new `ApplicationFrameWindow` whose hosted package family matches the
     activated AUMID
   - anything less stays `unknown`, as today
3. **Single instance.** If Settings is already open, return its window with
   `handedOff: true` only if it is new since the snapshot. Otherwise report
   `already_running` and do not touch it (the owner's windows are off limits).
4. **Allowlist.** Accept only exact `ms-settings:` page names. Everything else stays
   `application_unsupported`.

**Settings navigation proof.** Observe the Settings window with depth 2–3 and
`rootElementId` on the navigation list, select System (`invoke`, or
`accessibility_action` / SelectionItem), then Display, and read the Scale combobox
value. Change nothing, then close with the Close button.

**Tests:**

- catalog resolution and refusal cases
- the `ApplicationFrameHost` identity rule, with a fake window bridge
- doctor fields
- the launch result stays at about 250 characters or less

**Live check:** run head-to-head task 4 twice. Both must pass with the Scale value read
back.

**Done when:** task 4 passes 2/2 live, and the doctor and launch descriptions in
`src/computer/server.cjs` are updated.

## M4. Leaner interactive observations

**Gaps G4 and G5.**

- `interactiveOnly` (winapp `-i`, `src/computer/winapp-backend.cjs` `inspect`, around
  line 390) drops Notepad's `Document` editor (RichEditD2DPT). It keeps unnamed
  `Group`, `Separator` and `Pane` nodes.
- Measured sizes: Save As followed modal at depth 8 was 20,882 characters; the Firefox
  window at depth 6 was 18,094.
- `documentElementId` beyond the observed depth returns a generic `stale_element`.

**Change.**

1. In `interactiveOnly`, also keep text-bearing controls: `Document`, `Edit`, and `Text`
   that carries a value. Keep them as winapp returns them, under their nearest kept
   ancestor.
2. In `interactiveOnly`, prune unnamed, actionless, childless `Group`, `Separator` and
   `Pane` leaves. Do this server-side after winapp returns, keeping parent links valid.
3. For a `documentElementId` that is not in the observed tree, return an error that says
   so and names the fix: raise `accessibilityDepth`, or scope `rootElementId` to the
   control's parent. Keep the code `stale_element` for compatibility and add
   `reason: 'not_in_observed_tree'`.
4. Update the skill (`skills/trace-computer-use/SKILL.md`) and `docs/COMPUTER_USE.md`:
   - start at depth 2–3 with `rootElementId`
   - use `interactiveOnly` for finding controls, not at depth 6 or more on whole
     windows
   - sync the installed skill copies with `node scripts/sync-computer-skill.cjs --plan`,
     then the owner runs `--apply`

**Bars**, in synthetic fixtures modelled on the measured trees, then one live recheck:

- Notepad with `interactiveOnly` at depth 6 includes the `Text editor` Document.
- Save As followed modal, `interactiveOnly` at depth 8: at most 10,000 characters (was
  20,882).
- Firefox window, `interactiveOnly` at depth 6: at most 9,000 characters (was 18,094).
- The out-of-tree `documentElementId` error names the fix.

**Done when:** the bars pass in tests and live once, and CI is green.

## M5. TRACE rerun and 2.1.0 release

1. Bump to `2.1.0` (package and lockfile) and write `docs/RELEASE_2.1.0.md`: changes,
   compatibility (no 2.0 contract change), verification and limits.
2. Reconnect `trace-computer` on the merged `main`. Run doctor (expect ready), then
   `computer setup --apply` if it reports `supervisor_stale`.
3. Rerun **TRACE only**, 4 tasks × 2, in **one fresh session**. agent-desktop 1.0.2 is
   unchanged, so its 3 November results are reused; say so in the report.
   - Same rules, a new run folder `%TEMP%\trace-vs-ad\<date>\`, and the same logging.
   - Per-call CSV extracted from the session transcript, as in
     `evidence/head-to-head-2026-11-03/`.
   - Close Firefox in run 1 with ctrl+shift+w on purpose, to prove M2 in context.
   - Bars:
     - 8/8 pass
     - no MCP restart
     - TRACE's context under 60k tokens for 8 task-runs in one session
     - TRACE response text under 100,000 characters
4. Commit `evidence/head-to-head-<date>/` and `docs/HEAD_TO_HEAD_<date>.md`.
5. Release 2.1.0 exactly as in R0, steps 2–5.

**Done when:** v2.1.0 is published with its receipt, and the rerun meets every bar.

## M6. Optional hygiene (owner decides; not blocking)

- **Codex `enabled = true`.** `node scripts/sync-computer-skill.cjs` reports the Codex
  `enabled = true` entry as a conflict. It is documented as expected (PR #106). The open
  decision is whether the config comparison should ignore it in code.
- **CI timeout.** `smoke-mcp` can time out on `Get-CimInstance` on the hosted runner.
  Consider a longer timeout.

## Open owner decisions

1. Approve R0 (the 2.0.0 candidate PR, then the tag and release).
2. Choose M3 option A (AUMID plus an `ms-settings:` allowlist) or B (AUMID only).
3. Approve the M2 bounded wait (proposed 1,000 ms) as a change to the release proof.
4. M6: ignore Codex `enabled = true` in code, and lengthen the CI timeout?
