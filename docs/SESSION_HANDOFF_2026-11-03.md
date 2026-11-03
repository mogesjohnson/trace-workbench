# Session handoff, 3 November 2026: 2.0 live checks and PR 104

Paste the prompt below into a fresh Claude Code session started in the main
`trace-workbench` checkout.

---

You are continuing TRACE 2.0 work. Read `AGENTS.md`, then this file, then verify state with
`git` and `gh` before acting. Do not take over the desktop unless the owner says so. The
owner is often busy; ask first.

## State

- **Token cost stack merged.** On 2 November, PRs #68–#80 (Road V1 items 11–18), #97–#102
  (the token cost fixes) and #97 (the incident record) were merged into `main` one by one
  with merge commits. `main` was then `9bbd58c`, and its CI passed on a rerun; the first run
  hit a runner `Get-CimInstance` timeout in `smoke-mcp`.
- **Local checkout.** The main checkout is detached at `origin/main` (`9bbd58c`), because
  `main` itself is checked out in `../trace-workbench-phone`. The installed `trace-computer`
  MCP server runs from this checkout.
- **Setup done.** `computer setup --apply` was rerun and the skill copies were synced.
  Doctor reports ready with the compact 2.0 support block.
- **Live 2.0 checks on 2 November** (details in `docs/RELEASE_2.0.0.md`):
  - Notepad readback: passed.
  - Save As follow with `followModal`, nested dialogs and `returnedToOwner`: passed.
  - Found two bugs: `set_value` is ignored by the file dialog's File name box, and launch
    returned `unknown` for apps that hand off to another process.
- **[PR #104](https://github.com/mogesjohnson/trace-workbench/pull/104),
  `fix/live-check-findings`.** Open, CI green, not merged. Worktree:
  `../trace-workbench-worktrees/live-check-fixes`.
  - **File name refusal.** `set_value` on the common file dialog's File name box is refused
    as `not_dispatched`. The guard is in `src/computer/winapp-backend.cjs`
    (`fileDialogNameBox`).
  - **Launch handoff.** A window that is new since a pre-launch snapshot, from one process,
    whose executable resolves to the registered EXE, is returned with `handedOff: true`
    (`src/method/installed-applications.cjs`). The snapshot runs before the deadline, and
    the deadline is 15 s (`LAUNCH_TIMEOUT_MS` in the controller).
  - **Live recheck on 3 November** passed, driven by an MCP client against the branch. See
    the PR comment.
  - The worktree's `.runtime` is a **directory junction** to the main checkout's `.runtime`.
    Remove the junction alone (`cmd /c rmdir`); never remove recursively through it.
- **Desktop.** Notepad's active tab is `trace-saveas-check.txt`, saved in an old session
  scratchpad. It is harmless, and the owner may close it.

## Next steps (each needs owner approval)

1. Merge #104 into `main`. It is not a release.
2. Update the main checkout to the new `origin/main` (`git switch --detach origin/main`).
   Restart Claude Code so the installed server loads the fixes, then run
   `node scripts/sync-computer-skill.cjs --plan`, and `--apply` if it reports changes.
3. Run the 16-task head-to-head in a fresh session: TRACE against `agent-desktop` 1.0.2
   (installed globally); four tasks (Notepad text, Save As, Firefox navigation, read-only
   Settings display scale), each twice per tool. The goal is TRACE's share under 100k
   tokens. See `docs/OBSERVATION_TOKEN_COST_INCIDENT.md`. It takes over the desktop for 1–2
   hours and needs plenty of 5-hour limit left.
4. Then prepare 2.0.0 through `docs/RELEASE_PROCEDURE.md` with explicit owner approval.
5. With owner agreement, remove the merged worktrees under `../trace-workbench-worktrees/`:
   `token-cost-fixes`, `token-cost-incident`, `compact-act`, `p1-scoping`, `p2-followups`,
   `p2-docs`, and `live-check-fixes` after #104 merges.

## Lessons from the live runs

- Keep observations cheap. Use `screenshot: 'none'` unless you need pixels, start at
  `accessibilityDepth` 2–3, and use `rootElementId` for one control. Depth 12 on the Save
  As dialog cost about 16 KB, while depth 3 was enough.
- A Close button needs `accessibilityDepth` 2, because depth 1 is the window alone.
- `interactiveOnly` drops Notepad's `Document` editor. Read it with `documentElementId` and
  a `rootElementId` scope. This is an open minor issue.
- In Windows file dialogs, type the File name: click the box, press ctrl+a, then use
  `type_text`.
- The owner's Notepad holds many unsaved personal tabs. Never type into them.
- A small MCP client script (pattern: `scripts/smoke-computer-live.cjs`
  `createMcpController`) can drive a branch's server without restarting Claude Code. It
  keeps large observations out of the conversation context.
- Open issue: `smoke-mcp` can time out on `Get-CimInstance` in CI; consider a longer
  timeout.
