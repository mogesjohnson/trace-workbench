# Token cost fixes — handoff (2 November 2026)

Work for [the token cost incident](https://github.com/mogesjohnson/trace-workbench/pull/97) (`docs/OBSERVATION_TOKEN_COST_INCIDENT.md` on PR #97). The
owner asked for every issue in PR #97 to be fixed. This file records how far the
work got and what comes next.

- Branch: `fix/observation-token-cost`, stacked on `feat/v8-claude-lifecycle` @
  `e762f25` (PR #80 head, the build that was measured). C1 exists only on that
  stack, so the fixes are stacked on it.
- Worktree: `trace-workbench-worktrees/token-cost-fixes`, a sibling of the main checkout
  (`npm ci` already run there).

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
2. **P0-3 and P0-4, compact act and optional screenshot.**
   - `act` gets `returnObservation: 'full' | 'summary' | 'none'`, default
     `'summary'`. Summary means `observationId`, focus, title, `targetState` and a
     small element diff, with no PNG. Even with `'none'`, act still re-observes
     server-side so the next action has authority.
   - `observe` gets `screenshot: 'none' | 'scaled' | 'full'`. The `'none'` choice
     with `mode: 'full'` must still authorize one action: dispatch guards use UIA
     bounds and DWM geometry, not pixels. `'scaled'` needs a downscale step in the
     bridge, or can be deferred and documented.
   - **Compatibility decision:** compact-by-default changes the documented act
     result. That is a 1.x contract change per `docs/COMPUTER_USE.md` (V1
     compatibility boundary), so it needs a major version and migration notes.
     `src/method/trace-adapter.cjs` and `scripts/accept-*.cjs` read
     `value.observation`. They must request `returnObservation: 'full'` when
     `doctor` advertises support; older servers reject unknown fields. **Owner decision, 2 November 2026: go ahead
     with the major version bump (2.0.0)**; include migration notes.
   - Acceptance: default `press_key` response is at most 1,500 chars with no image.
3. **P1.**
   - P1-1: `rootElementId` uses the inspect selector argument, and
     `interactiveOnly` uses `-i`. The dispatch re-inspection must reuse the same
     scope.
   - P1-2: `list_windows` filters 1×1, zero-size, LockApp, TextInputHost and
     cloaked/tool windows by default, with `verbose` as the opt-in. Drop
     `executable` and `processCreationTime` from the default output but keep them
     server-side for identity.
   - P1-3: `processName`/`title` filter, and `open_session` accepts an id from the
     last listing.
   - P1-4: `target_closed_after_dispatch` outcome when the window is gone after
     native completion in `act`. At present this is `internal_error`.
   - P1-5: `responseBytes` in `_meta`, plus a skill rule in
     `skills/trace-computer-use/SKILL.md` (keep the discovery copies in sync;
     `tests/skill-sync.test.cjs`).
4. **P2.**
   - P2-1: `metrics` becomes opt-in, and `doctor` prints the key regex once.
   - P2-2: RichEdit readback. Try winapp `get-value` (TextPattern) when the
     AutomationId binding is missing.
   - P2-3: launch.
   - P2-4: modal follow.
5. Then rerun the 16-task head-to-head. TRACE's share must be under 100k tokens.

PR shape (VERSION_CONTROL.md): 2–4 commits per PR. Suggested split: PR A is
P0-1, P0-2 and P0-5. PR B is P0-3 and P0-4. PR C is P1. PR D is P2. Each is
stacked and stays draft until its base merges.
