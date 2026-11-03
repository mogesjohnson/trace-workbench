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
- **Discovery.** `trace_computer_doctor` reports `actResult` and
  `observationModes.screenshotModes`.
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
4. Not-dispatched and unknown act results, cleanup results, the six tool names, action
   forms, units and `support.contractVersion: 1` are unchanged.

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
- No live desktop measurement and no 16-task head-to-head rerun has been made for
  this candidate.
- Live acceptance from 1.x is reused at its stated scope. The full-result path that
  acceptance scripts request is unchanged.
