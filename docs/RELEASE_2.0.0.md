# TRACE Workbench 2.0.0 (candidate, unpublished)

**Status: candidate on a stacked development branch. Not published.** The owner
approved a major version on 2 November 2026 so `trace_computer_act` can return a
compact result by default. Publication follows the [release procedure](RELEASE_PROCEDURE.md)
and needs explicit owner approval. The published release is still
[1.1.0](RELEASE_1.1.0.md).

## Why

On ordinary Windows apps, every act returned a full observation and a native-resolution
PNG. In the measured run, the average act response was 18,180 characters plus an image,
and three task-runs used 420k tokens of context
([token cost incident](https://github.com/mogesjohnson/trace-workbench/pull/97), C3, C4).

## Changes

- **Compact act result by default (P0-3).** `trace_computer_act` accepts
  `returnObservation: "full" | "summary" | "none"`, default `summary`.
  - `summary` returns the outcome, `nativeResult`, the next `observationId`, and a
    `summary` that holds:
    - the compact focus
    - the target state
    - the title, if it changed
    - the element count
    - a bounded element diff: added, removed and changed, at most 15 entries per kind,
      with counts
  - `summary` sends no image.
  - `none` returns only the outcome and `observationId`.
  - `full` returns the 1.x result.
  - TRACE always re-observes server-side after a completed action, so the returned
    `observationId` authorizes one further action in every mode.
- **Optional observation image (P0-4).** `trace_computer_observe` accepts
  `screenshot: "none" | "scaled" | "full"`, default `full`.
  - `none` skips capture. In full mode the observation still authorizes one action,
    because dispatch guards use UIA bounds and DWM geometry, not pixels.
  - `scaled` sends a box-downscaled PNG with its longest edge at most 1280 px.
    `screenshot.scale` reports `factor`, `sourceWidth` and `sourceHeight`. Multiply
    image pixels by `factor` to get window-local coordinates.
- **Scoped observation (P1-1).** `trace_computer_observe` accepts `rootElementId`
  (only that element's subtree, through winapp's selector argument) and
  `interactiveOnly` (winapp `-i`: interactive controls under their nearest kept
  ancestor; the window root stays first). Window bounds, coordinates and the image
  stay window-level. The server retains the scope with the observation: dispatch and
  the post-action refresh read the same subtree at the same depth. winapp 0.7.1 can
  answer an unresolved selector with the window root, so TRACE accepts a subtree only
  when its top node is the requested element (`element_not_found` otherwise). If the
  action removes the scope root, the refresh covers the whole window once and the act
  result says `scopeLost: true`.
- **Trimmed window listing (P1-2).** `trace_computer_list_windows` returns `id`, `pid`,
  `processName`, `title` (at most 160 characters), `width`, `height`, and
  `foreground`/`ownerWindowId` when set. Executable paths, process creation times and
  session IDs stay server-side for identity checks. Tiny windows (under 8 px), shell
  hosts (lock screen, touch keyboard, Start, Search, notification surfaces), explorer
  helper classes and untitled UWP frames are omitted and counted in `omitted`.
  `verbose: true` returns every window with every field.
- **Filters and no mandatory re-list (P1-3).** `list_windows` accepts `processName`
  (exact, `.exe` optional) and `title` (substring), both case-insensitive. An explicit
  `processName` lists that process's windows without the noise filter. Every window of
  the last listing stays selectable, including hidden ones. `open_session` with an ID
  missing from the last listing (a just-launched window, a new dialog) looks it up
  once server-side instead of failing with `unknown_window`.
- **Closed target outcome (P1-4).** An action whose input completed and whose window
  then closed (Save, Close, OK) returns `outcome: "target_closed_after_dispatch"` with
  `verification: "window_closed"`, instead of `unknown` with `internal_error`. TRACE
  reports it only after native completion, when the bridge proves the HWND is gone or
  belongs to another process. Any other refresh failure stays `unknown`.
- **Response size (P1-5).** Every result carries
  `_meta["trace/response"]`: `responseBytes` (JSON text plus base64 image bytes),
  `jsonTextBytes`, `imageBase64Bytes` and `imageCount`.
- **Compact doctor (P2-1).** `trace_computer_doctor.support` lists action names with
  `detail: "compact"` and the `sha256` of the full descriptor (sorted-key JSON). A
  ready doctor was 2,431 characters in the test (5,957 before; bar 2,500).
  `verbose: true` returns the full descriptor. Compatibility checks accept a compact
  declaration only when its digest matches, and compare full (1.x) declarations as before.
- **Opt-in metrics (P2-1).** `trace_computer_observe` returns `metrics` and
  `_meta["trace/projection"]` only with `metrics: true`. An act refresh returns them only
  if the consumed observation asked. An observation without metrics was about 700
  characters shorter in the test.
- **Notepad document readback (P2-2).** `documentElementId` now reads a `Document`/`Edit`
  control without an AutomationId through `winapp ui get-value`. `ui get-property` must
  first show the same element, `IsPassword: "False"` and at least one TextPattern
  property, so the read never falls back to a label. Text is cut at 4,096 UTF-16 units.
- **Launch (P2-3).** New tool `trace_computer_launch { app }` starts a registered App
  Paths EXE by name (`.exe` optional) with `shell: false` under the desktop lease, and
  returns its windows in the listing form for `open_session`. It fails with
  `desktop_busy` while a session is open, `unknown_application` for an unregistered name
  and `application_unsupported` for URIs and paths. After an `unknown` outcome a
  relaunch is refused with `application_already_attempted`. Single-instance apps
  (Notepad 11, a running Firefox) hand the start to another process; a window that is
  new since a pre-launch snapshot and whose executable resolves to the registered EXE
  is then returned with `handedOff: true`. Anything less stays `unknown`.
- **File dialog File name.** `set_value` on the common file dialog's File name box
  (`Edit` 1001 under `FileNameControlHost` in a `#32770` window) is refused as
  `not_dispatched`: the dialog keeps its own copy of the name and would save under the
  previous one. Type the name instead.
- **Owned-modal follow (P2-4).** When the session window is disabled, `observe` and `act`
  report `ownedModal` (a dialog owned by the window, same process lifetime).
  `observe { followModal: true }` retargets the session under the same lease. When the
  dialog closes after an action, the session returns to the owner and the result has
  `returnedToOwner: true` with a fresh `observationId`.
- **Discovery.** `trace_computer_doctor` reports `actResult` (with
  `closedTargetOutcome`), `observationModes.screenshotModes`, `observationScope`,
  `windowListing`, `responseSize`, `launch` and `ownedModal`.
- **Earlier token cost fixes in this version.** These are listed separately in their
  own PR:
  - the UIA tree is serialized once
  - offscreen nodes are omitted by default (`includeOffscreen` opt-in)
  - the focused control and its ancestors are included at any depth

## Migration

1. If you read `result.observation` after `trace_computer_act`, pass
   `returnObservation: "full"`. Do this only when `trace_computer_doctor` advertises
   `actResult.returnObservation` containing `full`, because 1.x servers reject the
   unknown field. `src/computer/act-compat.cjs` (`createActCompat`) implements the
   check for call wrappers and controller objects.
2. If you only need the next `observationId`, use the default. Observe again when the
   summary is not enough to decide the next step.
3. The method adapter and the repository's acceptance scripts already request `full`
   when it is advertised.
4. If you read `executable`, `processCreationTime`, `sessionId` or `bounds` from
   `trace_computer_list_windows`, pass `verbose: true` once doctor advertises
   `windowListing.verbose`. `createActCompat` does this for wrapped calls, the method
   adapter does it itself and the Claude host guard always asks for it.
5. Treat `target_closed_after_dispatch` like `completed` for delivery: the input was
   sent. Verify the effect in the window or artifact that remains.
6. If you read `support.actions` from `trace_computer_doctor`, pass `verbose: true`.
   If you read observation `metrics`, pass `metrics: true` to `trace_computer_observe`.
7. Rerun `computer setup` after installing 2.0. The supervisor allow-list gained
   `ui get-value` and `ui get-property`, and doctor reports `supervisor_stale` until the
   supervisor is rebuilt.
8. Not-dispatched and unknown act results, cleanup results, the six 1.x tool names,
   action forms, units and `support.contractVersion: 1` are unchanged.

See the [V2 compatibility boundary](COMPUTER_USE.md#v2-compatibility-boundary-200).

## Verification scope

- Synthetic MCP tests (`tests/v9-compact-act.test.cjs`) measure the incident's bars:
  - **Default `press_key`.** On a 300-element, 1436×1798 fixture the response was
    689 characters with no image (bar: 1,500 characters). The same act with `full`
    was 78,997 characters plus a 2 MB base64 image.
  - **`screenshot: "none"`.** A full observation returned 0 PNG bytes and authorized
    exactly one action.
  - **`scaled`.** The image was 718×899 (factor 2) and less than a third of the
    full image's bytes.
- Synthetic MCP tests (`tests/v10-p1-scoping.test.cjs`) drive the real controller and
  `WinappBackend` through a fake winapp that reproduces the selector fallback and the
  `-i` collapse:
  - **Scoped Save dialog.** The file-name box observed at depth 2 was 2,267 characters
    (bar: 3,000); the whole dialog was 52,638.
  - **Window listing.** A 30-window desktop modelled on the incident listed 9 windows in
    1,131 characters with 21 omitted (bar: 2,500). `verbose` was 10,169.
- Read-only live checks with winapp 0.7.1 confirmed that subtree slugs equal those of
  a full inspect, that `-i` drops the window root, and that an unresolved selector can
  return the window root.
- Synthetic MCP tests (`tests/v11-p2-followups.test.cjs`, 9 cases) cover the P2 bars:
  the ready doctor (2,431 characters, bar 2,500), digest compatibility, opt-in metrics,
  exact Notepad-shaped RichEdit readback (CRLF, tab, accented text, emoji) with its
  refusals, the launch result (185 characters), the owned-modal hint (158 characters)
  and a Save As follow that returns to the owner (425 characters) without re-listing.
- Live checks on 2 November 2026 (Notepad 11.2607.14.0, Firefox 159, winapp 0.7.1):
  - Notepad readback of a real document returned its 19 characters exactly; the
    editor-scoped response was about 1.3 KB.
  - A Save As follow, including a nested Confirm Save As, returned to the owner each time
    with `returnedToOwner: true`; the typed file name saved and was verified on disk.
  - `set_value` on the File name box reported `completed` and read back the new path,
    but Save used the previous name. This led to the File name refusal above.
  - Launching Notepad and Firefox started both apps but reported `unknown` (`cancelled`
    and `window_bridge_failed`) because each handed off to another process. This led
    to the handoff rule above.
- The two fixes above have synthetic tests only; their live recheck is pending.
- No live desktop measurement and no 16-task head-to-head rerun has been made for
  this candidate.
- Live acceptance from 1.x is reused at its stated scope. The full-result path that
  acceptance scripts request is unchanged.
