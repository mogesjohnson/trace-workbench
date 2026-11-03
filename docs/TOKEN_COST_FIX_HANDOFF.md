# Token cost fixes — handoff (2 November 2026, session 6)

Work for [the token cost incident](https://github.com/mogesjohnson/trace-workbench/pull/97) (`docs/OBSERVATION_TOKEN_COST_INCIDENT.md` on PR #97). The
owner asked for every issue in PR #97 to be fixed. This file records how far the
work got and what comes next.

- Stack: `feat/v8-claude-lifecycle` @ `e762f25` (PR #80 head, the build that was
  measured) → PR #98 → PR #99 → PR #100 → PR D. C1 exists only on that stack.
- Worktrees (siblings of the main checkout, `npm ci` run in each):
  `trace-workbench-worktrees/token-cost-fixes` (#98), `compact-act` (#99),
  `p1-scoping` (#100), `p2-followups` (PR D), `p2-docs` (PR E).

## State at handoff (2 November 2026, session 6)

- The owner said "go ahead" without choosing amend or stacked PR, so session 6 took the
  option that needs no force-push: **PR E** (`fix/p2-docs`, draft, stacked on
  `fix/p2-followups`, worktree `p2-docs`). PR #101 is unchanged at `94fe068`.
- PR #101's CI failed at `94fe068`: `scripts/smoke-computer-mcp.cjs` still listed 6 tools.
  PR E adds `trace_computer_launch` to it; `npm run test:computer:mcp` passed locally.
  #101's own CI stays red until E is merged into it or the stack merges together.
- PR E also holds the docs pass: the skill (and its manifest hash), `docs/COMPUTER_USE.md`,
  `docs/OBSERVATION_METRICS.md`, `docs/RELEASE_2.0.0.md` (P2 changes, migration steps for
  `verbose`/`metrics`, the `computer setup` rerun), and one clause each in the observe
  (`ownedModal`/`followModal`) and act (`returnedToOwner`) tool descriptions.
- Full suite on PR E: `node --test --test-timeout=300000 tests/*.test.cjs` (Node 26.2.0): **702 tests, 697 passed, 0 failed, 5 skipped** (METHOD-BROWSER env). `npm run check` passed (151 files).
- #102's first CI run failed in `verify:archive`: `scripts/verify-archive-install.cjs` expected 6 tools.
  Commit 4 of #102 sets it (and its test fixture) to 7.
- **Review and merge: see [the review and merge handoff](TOKEN_COST_REVIEW_AND_MERGE.md).**
- Next: owner review of the stack #98 → #99 → #100 → #101 → E; the three live checks below
  need owner approval; skill sync after 2.0 is installed; then the 16-task head-to-head.

## State at handoff (2 November 2026, session 4)

- PR #98 (`fix/observation-token-cost`, ready, 4 commits): P0-1, P0-2, P0-5.
- PR #99 (`fix/compact-act-result`, draft, 4 commits): P0-3, P0-4, 2.0.0.
- PR #100 (`fix/p1-scoping`, draft, 4 commits): P1-1…P1-5. Do not add commits.
  - Full suite at `85b2219` (`node --test --test-timeout=300000 tests/*.test.cjs`,
    Node 26.2.0): **693 tests, 688 passed, 0 failed, 5 skipped** (METHOD-BROWSER,
    which needs `TRACE_PLAYWRIGHT_MODULE`/`TRACE_BROWSER_EXECUTABLE`). Recorded in
    the PR body.
  - `accept-replay-workflow` checks that its output does not match `/token/i`. Its
    output includes the checkout path, so it fails in any worktree whose path
    contains "token" (`token-cost-fixes`). That is a test artifact.
- PR #101 (`fix/p2-followups`, draft, stacked on #100, **4 of 4 commits used**):
  P2-1…P2-4 are implemented and tested. Commit 4 holds this handoff and the source-guard
  count fix (`tests/native-supervisor-contract.test.cjs` now expects 7 `register` calls).
  The docs pass (skill, `docs/COMPUTER_USE.md`, `docs/OBSERVATION_METRICS.md`,
  `docs/RELEASE_2.0.0.md`) has no commit left. Session 5's force-push amend was refused by
  the auto-mode classifier, so **ask the owner**: approve amending commit 4 with
  `--force-with-lease`, or put the docs in a stacked PR E. Do not add a fifth commit.
  - The full-suite result for `e79caee` goes in the #101 body. See "Full suite" below.
  - The body must also say that 2.0 needs `computer setup` rerun (the supervisor allow-list changed).

## Done: P2-3 and P2-4 (PR #101, commit `e79caee`, session 5)

- **P2-3, launch.** `trace_computer_launch { app }` (registered only when the controller has
  `launch`, so fake controllers in older tests still list 6 tools). `controller.launch`:
  - takes an App Paths name, case-insensitive with `.exe` optional. A `:` or a path separator
    gives `application_unsupported`, so `ms-settings:` (Settings) is reported as unsupported.
  - Lease: the launcher acquires the same lease as a session (the supervisor: one native owner
    per controller). It refuses a launch with `desktop_busy` before discovery if a session is open.
  - `discover({ match })` (new option in `installed-applications.cjs`) verifies only the named
    registration. No match: `unknown_application`. If the registration exists but its EXE was
    skipped (realpath/stat failed), the message names WindowsApps.
  - Result: `{ outcome, app, pid, windows: [listedWindow…], cleanup }` (185 chars in the test).
    The windows go into `discovered`, so `open_session` takes them with no new listing.
  - An `unknown` outcome adds the name to `uncertainLaunches`, which refuses a relaunch with
    `application_already_attempted`. After a verified launch or `not_dispatched`, a deliberate
    relaunch is allowed. A fresh launcher is created for each call.
  - Not known live: whether a direct spawn of a packaged WindowsApps EXE (Notepad, Firefox)
    activates the app, and whether `fs.realpath` can read that path. Firefox may also hand off
    to an existing instance and exit, which gives `unknown`/`application_timeout`.
- **P2-4, modal follow.** `ownedModals()` lists windows once and keeps those whose
  `ownerWindowId` is the session window, with the same pid and process creation time, excluding noise.
  - `observe` and `act` add `ownedModal: { windowId, title, width, height, hint }` (158 chars)
    when `targetState.enabled === false`.
  - `observe { followModal: true }` retargets `session.window` under the same lease, pushes the
    owner onto `session.owners` (so a nested confirm works) and records `modal_followed`.
    With no modal it fails with `no_owned_modal`.
  - When an act's target closes and an owner is stacked, the session pops back to the owner and
    observes it. The result is `target_closed_after_dispatch` with `returnedToOwner: true`, a
    fresh `observationId` and a compact summary (425 chars).
  - Doctor adds `launch` and `ownedModal` fields: 2,431 chars (bar 2,500, about 70 chars left).
- Tests: 4 new cases in `tests/v11-p2-followups.test.cjs` (9 in total), all passed. `npm run check`
  passed. These focused suites passed: computer-mcp, claude-lifecycle, computer-controller,
  v7-installed-applications, v9-compact-act, v1-capabilities, v2-selective-mcp and v10-p1-scoping.
- Not yet updated: the server act/observe descriptions mention neither `ownedModal` nor
  `returnedToOwner`. Add a short clause in the docs pass (watch tool-description size).
- Live checks to propose to the owner (none run): Notepad readback on a real document, a launch of
  Notepad/Firefox, and a Save As follow in Notepad.

## Full suite

- At `e79caee` (`node --test --test-timeout=300000 tests/*.test.cjs`, Node 26.2.0): 702 tests,
  696 passed, 1 failed, 5 skipped (METHOD-BROWSER env). The failure was the production-source
  guard counting 6 tools. Commit 4 updates it to 7, and that file then passed 19/19. The suite
  has not been rerun after the fix; only that one file changed.
- The personal skill discovery copies (`~/.claude`, `~/.agents`, `~/.grok`) were
  deliberately **not** synced. The installed `trace-computer` MCP runs from the main
  checkout (pre-2.0), so the new skill text would describe arguments it rejects. A dry
  run of `node scripts/sync-computer-skill.cjs --plan` shows all three as `replace`.
  Apply it once 2.0 is the installed server.

## Done: P2-1 and P2-2 (PR D, commit `c38010e`)

- **P2-1, compact doctor.** `action-contract.cjs` `compactSupport(ttl)` returns the
  descriptor without `actions` rules: action names, `detail: 'compact'` and
  `sha256` (sorted-key JSON of the full `actionSupport(ttl)`). `doctor` takes
  `verbose: true` for the full descriptor (server schema and controller).
  `effectiveSupport(support)` returns the local full descriptor or null. A compact
  declaration must match by digest. A full (1.x or verbose) declaration is matched
  as before, with the four optional features removed when absent.
  `compatibleSupport()` wraps it. `trace-adapter.cjs` uses it in place of its four
  `delete` lines.
  - Bar: a ready doctor (real `WinappBackend.doctor`, fake processes) is **2,313
    chars** (bar 2,500). Verbose is 6,059. A live read-only doctor against the main
    checkout's runtime measured the same 2,313 before the supervisor source change.
  - Headroom is about 190 chars. P2-3/P2-4 doctor fields must stay short.
- **P2-1, opt-in metrics.** `observe` takes `metrics: true`. The flag is kept on the
  snapshot, so an act refresh returns metrics only if the consumed observation
  asked for them. `_meta["trace/projection"]` follows (`server.cjs` emits it only
  when metrics are present). An observation without metrics is about 700 chars
  shorter (1,526 vs 2,230 in the test).
- **P2-2, Notepad readback.** `winapp-backend.cjs` `readDocument`: a `Document`/`Edit`
  control without an AutomationId goes to `readDocumentValue()`:
  1. `ui get-property -w <hwnd> -- <slug>` must return the same selector, type and
     bounds as the observed element (else `stale_element`).
  2. `IsPassword` must be `"False"` (else `password_or_unknown`).
  3. At least one TextPattern formatting property (`FontName`, `FontWeight`, …) must
     not be `"Unavailable"` (else `text_pattern_unavailable`). This matters because
     get-value falls back to ValuePattern, SelectionPattern and then the Name.
  4. `ui get-value -w <hwnd> -- <slug>` returns `{ elementId, text }`. The text is
     cut at 4,096 UTF-16 units without splitting a surrogate pair. Provenance is
     `winapp-textpattern-value`, and the selection is `selection_unavailable`.
  - Both verbs are read-only in `command()`. The supervisor allow-list
    (`native/TraceSupervisor/SessionProcess.cs`) gained them too. The supervisor
    verifies its build against source hashes, so **2.0 needs `computer setup`
    rerun** (otherwise doctor reports `supervisor_stale`). Not compiled locally; CI
    or setup builds it.
  - Read-only probes on this PC (winapp 0.7.1): get-value JSON is `{elementId, text}`
    (`text` absent when there is no value). get-property `--json` returns
    `{elementId, element, properties}`, and the formatting values are `"Unavailable"`
    without TextPattern. No Notepad window was open, so the RichEdit path has not
    been seen live.
- Tests: `tests/v11-p2-followups.test.cjs` has 5 cases (doctor bar, digest
  compatibility, metrics opt-in, Notepad exact readback, refusals/bounds). Updated
  for the intended changes: v1-capabilities (verbose doctor), v1-observation-metrics,
  v2-selective-controller and v5-document (request metrics; the binding-unavailable
  case uses a `Text` control). `npm run check` and 14 focused suites passed (211
  tests). The full suite has not been run on PR D.

## Next: P2-3 and P2-4 (design notes, not started)

- **P2-3, launch.** `src/method/installed-applications.cjs` already has a typed
  launcher. It reads the App Paths catalog through bridge `apps`, spawns the exact
  registered EXE with `shell: false`, binds the process with bridge `process` and
  waits for its window. It needs the supervisor lease (`acquire/release/assert`).
  It is not an MCP tool yet.
  - A read-only `apps` call on this PC listed 140 registrations, including
    `notepad` and `firefox`, both under `C:\Program Files\WindowsApps\…`
    (packaged). Settings is not in App Paths (`ms-settings:` URI).
  - Unknown: whether a direct spawn of a WindowsApps EXE starts a packaged app
    correctly, and whether `fs.realpath` can read that path. Both need a live
    launch, which needs owner approval.
  - Suggested shape: `trace_computer_launch { app }`. `app` is a catalog name such
    as `notepad`. The result lists the new window(s) in the default listing form and
    adds them to `discovered`, so `open_session` follows directly. Settings is
    reported unsupported unless a URI launcher is added (that would need a bridge
    rebuild). Check how the lease interacts with an open session first.
- **P2-4, modal follow.** The incident's Save As was an owned window: from the
  Notepad session, the target showed `enabled: false`. Suggested approach: when
  `targetState.enabled === false` after observe/act, list windows once and report
  `ownedModal: { windowId, … }` for windows whose `ownerWindowId` is the session
  window (same pid and creation time). Then let the session follow it, for example
  with `observe { followModal: true }`, which retargets `session.window` under the
  same lease. When the modal closes (`target_closed_after_dispatch`), return to
  the owner. Bar: Save As completed without close/re-list/re-open.
- Each needs a size or behavior test in `tests/v11-p2-followups.test.cjs`.
- Live checks to ask the owner for (none run): the Notepad readback on a real
  document, a launch of Notepad/Firefox, and a Save As follow.

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
3. ~~P1~~ done in PR #100 (see above).
4. ~~P2~~ done in PR #101; docs and the smoke-test fix in PR E (session 6).
5. Then rerun the 16-task head-to-head. TRACE's share must be under 100k tokens.

PR shape (VERSION_CONTROL.md): 2–4 commits per PR. Suggested split: PR A is
P0-1, P0-2 and P0-5. PR B is P0-3 and P0-4. PR C is P1. PR D is P2. Each is
stacked and stays draft until its base merges.
