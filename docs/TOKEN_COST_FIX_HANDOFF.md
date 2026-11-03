# Token cost fixes — handoff (2 November 2026, session 3)

Work for [the token cost incident](https://github.com/mogesjohnson/trace-workbench/pull/97) (`docs/OBSERVATION_TOKEN_COST_INCIDENT.md` on PR #97). The
owner asked for every issue in PR #97 to be fixed. This file records how far the
work got and what comes next.

- Branch: `fix/observation-token-cost`, stacked on `feat/v8-claude-lifecycle` @
  `e762f25` (PR #80 head, the build that was measured). C1 exists only on that
  stack, so the fixes are stacked on it.
- Worktree: `trace-workbench-worktrees/token-cost-fixes`, a sibling of the main checkout
  (`npm ci` already run there).

## State at handoff (2 November 2026, session 3)

- PR #98 (`fix/observation-token-cost`, ready, 4 commits): P0-1, P0-2, P0-5.
- PR #99 (`fix/compact-act-result`, draft, stacked on #98, 4 commits): P0-3, P0-4, 2.0.0.
- PR C (`fix/p1-scoping`, draft, stacked on #99, 4 commits including this handoff):
  P1-1…P1-5. Worktree `trace-workbench-worktrees/p1-scoping` (`npm ci` already run there). Do not add
  commits; PR D starts a new branch on `fix/p1-scoping`.
  - Focused suites passed: `v10-p1-scoping` (10 cases), computer-controller,
    computer-mcp, winapp-backend, v5-hierarchy, v8-focus-path, v9-compact-act,
    v2-selective-*, method-trace-adapter, accept-claude-host, v1-capabilities,
    v1-observation-metrics, v8-accessibility-actions, v2-adjacent-identity.
    `npm run check` passed.
  - The full `npm test --test-timeout=300000` run was **incomplete**. It had 387
    passed and 0 failed when the session stopped, with one test process still
    running. Rerun it at the start of the next session.
  - Bars: the Save dialog file-name box at depth 2 is 2,267 chars (bar 3,000). A
    30-window desktop lists in 1,131 chars (bar 2,500).
- The personal skill discovery copies (`~/.claude`, `~/.agents`, `~/.grok`) were
  deliberately **not** synced. The installed `trace-computer` MCP runs from the main
  checkout (pre-2.0), so the new skill text would describe arguments it rejects. A dry
  run of `node scripts/sync-computer-skill.cjs --plan` shows all three as `replace`.
  Apply it once 2.0 is the installed server.

## Done: P1 (PR C, branch `fix/p1-scoping`)

- **P1-1.** `inspect()` takes `{ rootElementId, interactiveOnly }`.
  - A depth-1 window read supplies the root (bounds, capture selector, movement guard).
  - winapp 0.7.1 can answer an unresolved selector with the window root, or with
    `internal_error`, so a subtree counts only when its single top node is the
    requested slug. With `-i`, an extra depth-1 scoped read checks the scope root.
    Otherwise TRACE fails with `element_not_found`.
  - `-i` drops the window root, so in unscoped `interactiveOnly` TRACE re-adds it as
    the first element.
  - `mergeFocusPath` anchors at the scope root.
  - The controller retains `rootElementId`/`interactiveOnly` on the snapshot. Dispatch
    and the act refresh reuse them. If the scope root vanishes after an action, one
    unscoped refresh runs and reports `scopeLost: true`.
- **P1-2.** `listingNoise()`: windows under 8 px, shell processes, explorer helper
  classes and untitled ApplicationFrameWindow. `listedWindow()` trims fields;
  `verbose` returns everything. winapp gives no cloaked or tool-window flag; adding
  one would need a native bridge rebuild (`DWMWA_CLOAKED`).
- **P1-3.** `processName`/`title` filters. `discovered` keeps every listed window.
  `open_session` looks up an unknown ID once. `act-compat` `listArguments` adds
  `verbose` after doctor advertises `windowListing.verbose`; trace-adapter does the
  same, and the Claude host guard always sends it.
- **P1-4.** `backend.targetClosed()` (bridge `bounds` → `window_closed` /
  `window_identity_changed`) yields `target_closed_after_dispatch`, journal type
  `action_target_closed`.
- **P1-5.** `_meta["trace/response"]` on every result. The skill, manifest, docs and
  release notes are updated.

## Done: P0-1 and P0-2 (commit on this branch)

- **P0-1, serialize the tree once.** `winapp-backend.cjs` `inspect()`: every
  selector-backed node is an `elements[]` entry carrying `treeNodeId`, `parentNodeId`
  and `hasMoreChildren: true` only when truncated. `accessibility.hierarchy` now
  lists only selectorless structural nodes, and the controller omits it when it is
  empty. `nestingDepth` and the duplicated `elementId`/name/type copies are gone.
- **P0-2, omit offscreen nodes by default.** Kept descendants attach to the nearest
  kept ancestor. The root is always kept. The count is reported as
  `accessibility.offscreenOmitted`. The opt-in is `includeOffscreen: true` on
  `trace_computer_observe`. It is retained on the server snapshot, like depth, so
  the dispatch re-inspection in `act` uses the same filter.
  - winapp's own `--hide-offscreen` was not used. It filters the flat DFS list
    before nesting, which can attach a child to the wrong parent (an earlier sibling
    of the removed node). See `.runtime/winapp/UiInspectCommand.cs`, `NestElements`.
- The observe tool description now says to start at depth 2.
- Docs: `docs/ACCESSIBILITY_EVIDENCE.md` is updated.
- Tests: `tests/v5-hierarchy.test.cjs` has two new cases, including a size check.
  These focused suites ran: v5-hierarchy, v5-document, winapp-backend,
  computer-controller, computer-mcp, v2-selective-*, v8-accessibility-actions and
  v1-capabilities. Result: 117/117 passed. The full suite and `npm run check` have
  not been run. No live measurement has been made.

## Done: P0-5, focus path (commit on this branch)

- `winapp-backend.cjs` `focused(window, signal, elements, state)`: when the focus
  binding is `unresolved` and get-focused returned a selector, TRACE runs
  `ui inspect -w <hwnd> --json --ancestors -- <selector>` (`ancestors()`) and merges the
  root-first chain into the inspected state (`mergeFocusPath()`). Existing nodes (same
  selector, or AutomationId + type + bounds) are reused; added nodes carry
  `focusPath: true`. Offscreen ancestors are skipped unless `includeOffscreen`; the
  target is always kept. Binding then also accepts the chain target when its bounds
  equal the focus bounds, still only as a unique same-control match.
- Both `observe()` and `dispatch()` (before the keyboard focus check) do this. A
  failed or mismatched chain leaves focus unresolved, so keyboard input still fails
  closed with `focus_not_acquired`.
- Limit: focus-path controls are re-inspected only for keyboard input; clicking one
  needs a deeper observation (fail-closed `stale_element`).
- Tests: `tests/v8-focus-path.test.cjs` (5 cases, including a size check).

## Done: P0-3 and P0-4, 2.0.0 candidate (PR B, branch `fix/compact-act-result`)

- Worktree: `trace-workbench-worktrees/compact-act` (`npm ci` already run there).
- `controller.cjs`: `act` takes `returnObservation` (`full` | `summary` | `none`,
  default `summary`). It always re-observes server-side. For `summary`/`none` the
  refresh takes no PNG. `summary` holds the compact focus, `targetState`, a changed
  title, the element count and `changes` (an `elementDiff` capped at 15 per kind).
  `full` uses the consumed observation's `screenshotPreference`, so a summary act in
  between does not drop the image. An invalid value is `invalid_argument`
  with `not_dispatched`, checked before the observation is consumed.
- `observe` takes `screenshot` (`none` | `scaled` | `full`). Full mode with `none`
  still authorizes one action. `scaled` uses `src/computer/png-scale.cjs` (pure Node,
  8-bit RGB/RGBA, integer box factor, longest edge ≤ 1280). It reports
  `screenshot.scale`; an unsupported format falls back to the original bytes with a
  `reason`.
- Doctor reports `actResult` and `observationModes.screenshotModes`. The key must not
  be `screenshot`: `server.cjs` `toolResult` projects every object under a key
  named `screenshot` as a PNG.
- `src/computer/act-compat.cjs` adds `returnObservation: "full"` only after doctor
  advertises it. It is used by `trace-adapter.cjs`, `replacement-acceptance-common`,
  `accept-supervisor-quarantine` (and through it `accept-supervisor-stop`),
  `accept-supervisor-recovery`, `accept-clipboard`, `accept-claude-host`,
  `smoke-computer-live` `createMcpController` (and through it `accept-targeting`) and
  `accept-supervised-typing`. `accept-codex-host` is host-driven, so the model
  chooses its own arguments there.
- Version 2.0.0 in `package.json` and the lockfile. Also updated:
  `docs/RELEASE_2.0.0.md` (unpublished candidate, migration notes),
  `docs/COMPUTER_USE.md` "V2 compatibility boundary (2.0.0)" and the use steps, and
  `VERSION_CONTROL.md`.
- Tests: `tests/v9-compact-act.test.cjs` (8 cases). The default `press_key` response
  was 689 chars with no image (bar 1,500). `full` was 78,997 chars plus a 2 MB image.
  Existing tests that read `act().observation` now pass `returnObservation: 'full'`.
  Fake backends write a PNG only when given a path.

## Findings to reuse (verified read-only on this PC)

- winapp 0.7.1 `ui inspect` accepts `[<selector>]` (subtree root), `--ancestors`
  (root-first chain to the selected element), `-i/--interactive`, `--hide-disabled`
  and `--hide-offscreen`.
- Slugs carry a RuntimeId hash. A live check showed that the `--ancestors` chain
  slugs equal the slugs in a full inspect of the same window.
- Native `list-windows --json` already gives `className`, `isForeground`,
  `ownerHwnd`, `label` and size, which is enough for the P1-2 filter. One real
  listing had 26 windows, including several 1×1 or 198×56 explorer windows,
  TextInputHost, LockApp and ShellExperienceHost.

## Next, in order

1. ~~P0-5~~ done (see above).
2. ~~P0-3 and P0-4~~ done in PR B (see below).
3. ~~P1~~ done in PR C (see above).
4. **P2.**
   - P2-1: `metrics` becomes opt-in (an observe argument; tests in v1-observation-metrics,
     v2-selective-controller and v5-document read `metrics`), and `doctor` prints the
     key regex once. The doctor was measured at 5,957 chars: `support.actions.press_key`
     is 2,851 (two regexes, namedKeys, aliases) and `limitations` is 246. Dropping one
     regex is not enough for the 2,500 bar. Consider a compact default `support` plus
     `doctor` verbose detail. `compatibleSupport()` compares the whole descriptor to the
     local `actionSupport()`, so keep 1.x server compatibility in mind.
   - P2-2: RichEdit readback. Try winapp `get-value` (TextPattern) when the
     AutomationId binding is missing.
   - P2-3: launch.
   - P2-4: modal follow.
5. Then rerun the 16-task head-to-head. TRACE's share must be under 100k tokens.

PR shape (VERSION_CONTROL.md): 2–4 commits per PR. Suggested split: PR A is
P0-1, P0-2 and P0-5. PR B is P0-3 and P0-4. PR C is P1. PR D is P2. Each is
stacked and stays draft until its base merges.
