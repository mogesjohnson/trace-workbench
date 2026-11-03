# Token cost fixes: review and merge handoff (2 November 2026)

This is for the owner, or the agent the owner asks to review and merge the fixes for
[the token cost incident](https://github.com/mogesjohnson/trace-workbench/pull/97). Work state and
design notes are in the [fix handoff](TOKEN_COST_FIX_HANDOFF.md).

Merging is not a release. 2.0.0 is published only through the
[release procedure](RELEASE_PROCEDURE.md), with explicit owner approval.

## What is waiting

All work is done. Every PR is open, and the code stack merges cleanly into current `main`
(checked with `git merge-tree` against `d501d19`).

| PR | Branch → base | Scope | Commits | CI |
| --- | --- | --- | --- | --- |
| [#97](https://github.com/mogesjohnson/trace-workbench/pull/97) | `docs/trace-token-cost-incident` → `main` | Incident record and fix bars (docs only) | 1 | pass |
| [#98](https://github.com/mogesjohnson/trace-workbench/pull/98) | `fix/observation-token-cost` → `feat/v8-claude-lifecycle` | P0-1 tree serialized once, P0-2 offscreen omitted, P0-5 focus path | 4 | pass |
| [#99](https://github.com/mogesjohnson/trace-workbench/pull/99) | `fix/compact-act-result` → #98 | P0-3 compact act result, P0-4 optional image, version 2.0.0 | 4 | pass |
| [#100](https://github.com/mogesjohnson/trace-workbench/pull/100) | `fix/p1-scoping` → #99 | P1-1…P1-5 scoped observe, trimmed listing, filters, closed target, response size | 4 | pass |
| [#101](https://github.com/mogesjohnson/trace-workbench/pull/101) | `fix/p2-followups` → #100 | P2-1 compact doctor and opt-in metrics, P2-2 Notepad readback, P2-3 launch, P2-4 modal follow | 4 | **fail** (fixed in #102) |
| [#102](https://github.com/mogesjohnson/trace-workbench/pull/102) | `fix/p2-docs` → #101 | Tool-count fixes for CI, P2 docs pass, these handoffs | 4 | see the PR |

#98 is ready for review; #99 to #102 are drafts. #97 is independent and can merge any time.

## Prerequisite: the Road V1 chain

#98 is based on `feat/v8-claude-lifecycle` (#80), not `main`. #80 sits on twelve more unmerged
PRs. From the bottom: #68 (ready, based on `main`), then drafts #69, #70 … #79, #80. They are Road V1 items 11
to 18; each passed its own CI.
The token cost fixes cannot reach `main` without them. The owner decides whether to merge that
chain first. Item 19 has not been started and is not part of it.

## Review focus

- **#98.** The accessibility tree is now one `elements[]` list with `treeNodeId`/`parentNodeId`.
  `accessibility.hierarchy` keeps only selectorless nodes, and offscreen nodes are omitted unless
  `includeOffscreen` is set. Check that dispatch re-inspection uses the same filter as the
  observation. Focus-path controls are re-inspected only for keyboard input.
- **#99.** This is the major change: `trace_computer_act` returns `summary` by default.
  `src/computer/act-compat.cjs` requests `full` only when doctor advertises it, so 1.x servers
  keep working. Check every caller that reads `result.observation` (the list is in the fix
  handoff).
- **#100.** winapp 0.7.1 can answer an unresolved selector with the window root, so a
  subtree is accepted only when its top node is the requested element.
  `target_closed_after_dispatch` is reported only after native completion and a bridge proof
  that the window is gone.
- **#101.** Four points to check:
  - Compact doctor: a compact `support` is compatible only when its `sha256` matches the local
    descriptor.
  - The supervisor allow-list gained `ui get-value` and `ui get-property`
    (`native/TraceSupervisor/SessionProcess.cs`). It was not compiled locally; the
    `verify:archive` CI step builds it.
  - `trace_computer_launch` holds the desktop lease and refuses URIs and paths.
  - `followModal` retargets the session only to a window owned by the session window, with the
    same process lifetime.
- **#102.** Two scripts still expected six tools: `smoke-computer-mcp` failed #101's CI, and
  `verify-archive-install` failed #102's first run. Both now expect seven. The method library
  still composes the six 1.x tools, so docs that say "six tools" there are correct.

## Merge procedure

The repository merges with merge commits and does not delete branches after merging, so
stacked PRs are not retargeted automatically.

1. Merge #102 into `fix/p2-followups` first. #101's CI then runs with the fixes and should pass.
2. Merge the Road V1 chain bottom-up, if the owner approves it (#68 first, #80 last).
3. Merge the token cost stack bottom-up: #98, #99, #100, #101. For each PR:
   1. `gh pr edit <n> --base main` once the PR below it is merged.
   2. `gh pr ready <n>` (drafts cannot merge).
   3. Wait for CI on the new base, then merge with a merge commit.
4. Merge #97 whenever convenient.

Before each merge, check that the diff against `main` shows only that PR's commits. If a later
change on `main` conflicts, rebase only the affected branch and push with `--force-with-lease`.
Ask the owner first, because the auto-mode classifier refused a force-push in session 5.

## Verification already done

- The full suite ran on #102 (`node --test --test-timeout=300000 tests/*.test.cjs`, Node 26.2.0):
  702 tests, 697 passed, 0 failed, 5 skipped. The skips are METHOD-BROWSER cases, which need
  `TRACE_PLAYWRIGHT_MODULE` and `TRACE_BROWSER_EXECUTABLE`. `tests/verify-archive-install.test.cjs`
  passed 8/8 after the count fix.
- `accept-replay-workflow` fails in any checkout whose path contains "token" (it checks that output
  does not match `/token/i`, and the output includes the path). That is a test artifact.
- Every incident bar has a synthetic MCP test: act 689 chars (bar 1,500), scoped Save dialog 2,267
  (bar 3,000), listing 1,131 (bar 2,500), doctor 2,431 (bar 2,500), and exact Notepad-shaped readback.

## Not verified

- No live desktop check of any 2.0 change. Three are proposed, each needing owner approval:
  1. Notepad readback on a real document.
  2. A launch of Notepad or Firefox. It is not known whether a direct spawn of a packaged
     WindowsApps EXE activates the app.
  3. A Save As follow in Notepad.
- The 16-task head-to-head has not been rerun. The goal is TRACE's share under 100k tokens.

## After merging

1. Rerun `computer setup`; doctor reports `supervisor_stale` until it is.
2. Make 2.0 the installed `trace-computer` server, then sync the skill copies:
   `node scripts/sync-computer-skill.cjs --apply`.
3. Run the approved live checks and the head-to-head, then prepare the 2.0.0 release.
4. Remove the merged worktrees under `trace-workbench-worktrees/` with the owner's agreement
   (`token-cost-fixes`, `token-cost-incident`, `compact-act`, `p1-scoping`, `p2-followups`,
   `p2-docs`).
