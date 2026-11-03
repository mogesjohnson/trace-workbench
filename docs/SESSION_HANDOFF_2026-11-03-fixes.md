# Session handoff, 3 November 2026: head-to-head done; release 2.0.0, then 2.1.0 fixes

Paste the prompt below into a fresh Claude Code session started in the main
`trace-workbench` checkout.

---

Continue TRACE. Read `AGENTS.md`, then retrieve the second-brain handoff for subject
`observation-token-cost-fixes` (handoff 12 or later; handoff 11 is `bb5e774a`). Then read
`docs/HEAD_TO_HEAD_2026-11-03.md` and `docs/FIX_PLAN_2.1.0.md`. Verify state with `git`
and `gh` before acting. Ask before taking over the desktop.

## State on 3 November 2026

- `main` is `b89574b`, CI green, published release is 1.1.0, and `package.json` on main
  already says `2.0.0` (unpublished). The main checkout is detached at `origin/main`;
  `main` itself is checked out in `../trace-workbench-phone`.
- Docs PR from branch `docs/head-to-head-and-fix-plan`
  (worktree `../trace-workbench-worktrees/head-to-head-docs`, `node_modules` junction)
  records the head-to-head and this plan. Check it is merged; if not, the owner merges it
  first.
- Head-to-head result, TRACE 2.0.0 against agent-desktop 1.0.2, 4 tasks × 2 runs each:
  - Both tools passed 6/8: Notepad text, Save As and Firefox passed in every run; Settings
    failed in every run.
  - TRACE context ~94k tokens (upper bound; goal under 100k: met), 68 calls, 151,697
    response characters. agent-desktop ~59k, 98 calls, 82,686 characters. On 2 November,
    3 TRACE task-runs had cost 420k tokens.
  - Medians (TRACE vs AD): Notepad 58 s / 7.5 calls vs 44 s / 5.5; Save As 86 s / 11 vs
    51 s / 14.5; Firefox 99 s / 11.5 vs 79 s / 14.5.
  - Observations are now 89% of TRACE's response text. Acts average about 490
    characters. Shallow depth (1–3) with `rootElementId` was far cheaper than
    `interactiveOnly` at depth 5–8 (run 1 52k characters, run 2 99k).
- Gaps (details, code lines and exact errors in the two docs):
  - **G1** cached `releaseErrors` in `src/computer/supervisor.cjs` (set line 246, rethrown
    line 221) keeps the session stuck after `computer recover --apply`; `close_session`
    fails and `launch` returns `desktop_busy` until an MCP restart.
  - **G2** a keyboard close (ctrl+shift+w) returns `unknown` / `input_recovery_required`
    with native `foreground_unavailable` from `native/TraceSupervisor/InputState.cs:49`
    (`EnsureObservable`, via `Session.cs` `FinishInput` → `ReleaseDeclared`). Close
    buttons and Save return `target_closed_after_dispatch` correctly.
  - **G3** `launch SystemSettings` / `SystemSettings.exe` → `unknown_application: No App
    Paths registration has this name.` (`launch.uri: false`).
  - **G4** `interactiveOnly` drops Notepad's `Document` editor yet keeps empty groups and
    separators; Save As followModal depth 8 was 20,882 characters, Firefox depth 6 was
    18,094.
  - **G5** `documentElementId` beyond the observed depth gives a generic `stale_element`.
  - **G6** Settings navigation is unproven (agent-desktop's System click did not
    navigate).

## Plan (owner's order: 2.0.0 first, then 2.1.0 with the fixes)

Follow `docs/FIX_PLAN_2.1.0.md`. Each milestone is one PR of 2–3 commits (4 max) in its
own worktree under `../trace-workbench-worktrees/`.

1. **R0, publish 2.0.0, no code changes.** Candidate PR `release/2.0.0-candidate`:
   `docs/RELEASE_2.0.0.md` status to "candidate on main", link the head-to-head, add
   Known limits G1–G4 with workarounds; version lines in `VERSION_CONTROL.md`,
   `README.md`, `SPEC.md` (pattern: 1.1.0 PRs #64 and #65). After the owner merges:
   green main CI, delivery folder with the five 1.1.0-style assets (source zip from
   `git archive` with `TZ=UTC` matching CI, acceptance manifest, distribution receipt,
   release notes, `SHA256SUMS.txt`), `verify-archive-install.cjs`. Tag `v2.0.0` and
   `gh release create` **only with explicit owner approval**; then the publication PR with
   `evidence/release-2.0.0/publication.json`.
2. **M1 (G1)** release after a confirmed recovery: on a cached release error, re-check
   `recovery('--check')` and `this.child === null`; clear and confirm only then. Must land
   before M2, because ctrl+shift+w is the live reproduction.
3. **M2 (G2)** bounded foreground wait (proposed 25 ms polls up to 1,000 ms, needs owner
   approval) before post-dispatch release verification; rebuild the supervisor; live:
   Firefox ctrl+shift+w, Notepad ctrl+w on the last tab, alt+f4.
4. **M3 (G3, G6)** packaged-app launch by AUMID via `IApplicationActivationManager`, no
   shell, plus an `ms-settings:` allowlist (option A, recommended) or AUMID only
   (option B): **owner chooses first**. Handle `ApplicationFrameHost.exe` window identity.
   Live: task 4 twice, Scale read back.
5. **M4 (G4, G5)** keep `Document`/`Edit`/valued `Text` in `interactiveOnly`, prune empty
   unnamed leaves, clearer out-of-tree document error, skill rule update. Bars: Save As
   ≤ 10,000 characters, Firefox ≤ 9,000.
6. **M5** bump 2.1.0, write `docs/RELEASE_2.1.0.md`, rerun TRACE only (4 tasks × 2, one
   fresh session, AD results reused). Bars: 8/8, no MCP restart, under 60k tokens, under
   100,000 characters. Then release 2.1.0 as in R0.
7. **M6 optional:** ignore Codex `enabled = true` in the config comparison; longer CI
   `Get-CimInstance` timeout.

## Live-test rules (from the owner)

- Only touch windows you launch. The owner's "clean ups" Notepad window and draw.io
  Firefox window are off limits. Notepad launch hands off to the owner's process; check
  the new window ID differs before acting.
- Files only in the run folder. No shell or screenshot rescue. Record failures with exact
  errors.
- Close windows with their Close button until M2 is merged.
- Keep observations cheap: `screenshot: "none"`, depth 2–3, `rootElementId`; a document
  read needs depth 2 or more. In file dialogs, type the File name (click, ctrl+a,
  `type_text`).
- Log every time, call count and cockpit context reading in the run folder `timing.log`.

## Notes

- The owner runs `gh pr merge` and `sync-computer-skill --apply` with `!`.
- Worktrees link `.runtime` and `node_modules` by junction; remove each with
  `cmd /c rmdir` before `git worktree remove`.
- Raw run logs stay local: `%TEMP%\trace-vs-ad\2026-11-03\`.
- Update the second-brain handoff (same subject, `--supersedes` the previous ID) at each
  milestone and before ending.
