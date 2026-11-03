# TRACE Workbench 2.1.0

**Status: a candidate on `main`, not published.** It fixes known limits G1–G5 of
[2.0.0](RELEASE_2.0.0.md), following the [2.1.0 fix plan](FIX_PLAN_2.1.0.md). Published
2.0.0 and its assets remain available. The TRACE-only rerun of the head-to-head (plan M5,
step 3) has not been run yet; its result will be added under
[Verification scope](#verification-scope) before publication.

## Why

In the [3 November head-to-head](HEAD_TO_HEAD_2026-11-03.md), TRACE passed 6/8 task-runs
and used about 94k context tokens. Settings failed every run (G3), a keyboard close
quarantined the session (G2), recovery needed an MCP restart (G1), and `interactiveOnly`
observations were large and dropped the editor (G4, G5).

## Changes

- **Session released after a confirmed recovery (M1, G1; [PR 112](https://github.com/mogesjohnson/trace-workbench/pull/112)).**
  After `computer recover --apply`, `close_session` re-checks a cached release failure.
  If the native child has exited and `recover --check` reports
  `recoveryRequired: false, ready: true`, the lease is freed and the result says
  `recoveredExternally: true`. `launch` and `open_session` then work without a `/mcp`
  reconnect. In every other case the original error is returned unchanged. Doctor
  reports `supervision.code: "release_pending_recovery"` while such a close is pending.
- **Keyboard close reports `target_closed_after_dispatch` (M2, G2; [PR 114](https://github.com/mogesjohnson/trace-workbench/pull/114)).**
  The post-dispatch release proof waits for a foreground window for up to 1,000 ms
  (25 ms polls) before its checks, which are otherwise unchanged. A ctrl+shift+w or
  ctrl+w that closes the window now returns `target_closed_after_dispatch` instead of
  quarantining the session. Pre-dispatch checks, session start and recovery do not wait.
- **winapp's system-key refusal is `not_dispatched` ([PR 117](https://github.com/mogesjohnson/trace-workbench/pull/117)).**
  winapp 0.7.1 refuses system-reserved keys (alt+f4, win+key, ctrl+alt+del) before
  sending anything. TRACE now reports that refusal as `not_dispatched` instead of
  `unknown`, and the session stays usable. TRACE does not pass `--allow-system-keys`.
- **Settings and packaged apps launch (M3, G3; [PR 115](https://github.com/mogesjohnson/trace-workbench/pull/115)).**
  `trace_computer_launch { app }` also accepts `settings`, an exact packaged AUMID
  (`PackageFamilyName!AppId`), and 11 allowlisted Settings pages (`ms-settings:display`,
  `sound`, `notifications`, `power`, `storage`, `about`, `bluetooth`, `network-status`,
  `personalization`, `dateandtime`, `windowsupdate`). The bridge activates them through
  `IApplicationActivationManager`, with no shell. A window is accepted only if it is new
  and reports the activated AUMID; one hosted by `ApplicationFrameHost` returns
  `handedOff: true`. An app that already has a window returns `not_dispatched` with
  `code: "already_running"` and is not touched. Other URIs and paths stay
  `application_unsupported`. The `app` limit is 128 characters. Doctor reports
  `launch.catalog: ["app-paths", "packaged"]` and `uri: "allowlist"`.
- **Leaner `interactiveOnly` observations (M4, G4/G5; [PR 116](https://github.com/mogesjohnson/trace-workbench/pull/116)).**
  TRACE no longer uses winapp `-i`. It reads the normal tree and keeps interactive
  controls, `Document` controls and `Text` with a value. It drops separators, scroll
  bars and empty unnamed containers, but never the window root or the scope root. The
  owner chose a lean element format for this mode: no `className`, and `enabled`,
  `offscreen` and `secondaryActions` appear only when they are not `true`, `false` and
  `[]`. A `documentElementId` outside the observed tree keeps `stale_element` and adds
  `reason: "not_in_observed_tree"` with the fix in the message.
- **Faster observe and act ([PR 118](https://github.com/mogesjohnson/trace-workbench/pull/118)).**
  The supervisor hashes each provider once per session through a deny-write handle and
  checks the pinned file's identity before each launch. Back-to-back identity checks
  that a bounds receipt already proves are dropped. A bridge guard read replaces winapp
  `status`. The identity check just before activation and input stays. A no-image
  observe makes 8 provider launches instead of 12.

## Compatibility

There is no change to the 2.0 contract. The tool names, action forms, outcomes,
`returnObservation` modes and `support.contractVersion: 1` are unchanged. New fields
(`recoveredExternally`, `reason`, doctor `launch.catalog`, `launch.uri` and
`supervision.code`) are additive,
and launch accepts more `app` forms than before.

Two results change in the direction the 2.0 notes described as limits:

- A keyboard close that used to return `unknown` / `input_recovery_required` now
  returns `target_closed_after_dispatch`.
- A winapp system-key refusal that used to return `unknown` now returns
  `not_dispatched`.

Only `interactiveOnly` observations use the lean element format. Full, accessibility
and screenshot observations without `interactiveOnly` keep the 2.0 element fields.

After installing 2.1.0, run `computer setup --apply`. The supervisor and bridge
changed, and doctor reports `supervisor_stale` until they are rebuilt. Then reconnect
`trace-computer`. The skill text changed: run `sync-computer-skill --plan`, then
`--apply`.

## Verification scope

- Automated tests: each fix PR added focused suites (`v12-release-after-recovery`,
  `m3-packaged-launch`, `m4-lean-observations`, the system-key case in
  `v10-p1-scoping`, the rewritten `v2-adjacent-identity`) and the native selftests.
  Hosted Windows CI must pass on the `main` commit that is released.
- Live checks on 3 November 2026, on windows TRACE launched:
  - **M1** ([result](https://github.com/mogesjohnson/trace-workbench/pull/112#issuecomment-6611833379)):
    after a reproduced quarantine and `recover --apply`, `close_session` freed the
    lease and `launch` worked with no `/mcp` reconnect.
  - **M2** ([result](https://github.com/mogesjohnson/trace-workbench/pull/114#issuecomment-6612577528)):
    Firefox ctrl+shift+w after a page load, 3 of 3, and Notepad ctrl+w returned
    `target_closed_after_dispatch` with recovery clean and doctor ready. alt+f4 was
    refused by winapp before sending, which led to PR 117.
  - **M3** ([result](https://github.com/mogesjohnson/trace-workbench/pull/115#issuecomment-6612667813)):
    head-to-head task 4 passed 2 of 2. `ms-settings:display` launched, Scale read 300%
    without input, and the Close button returned `target_closed_after_dispatch`. A
    second launch while Settings was open returned `already_running`.
  - **M4** ([recheck](https://github.com/mogesjohnson/trace-workbench/pull/116#issuecomment-6613982167),
    [Save As](https://github.com/mogesjohnson/trace-workbench/pull/116#issuecomment-6614843242)):
    Notepad at depth 6 kept its `Text editor` document. Firefox (example.com) at
    depth 6 was 7,781 characters (bar 9,000; it was 18,094).
  - **Speed** ([after-metrics](https://github.com/mogesjohnson/trace-workbench/pull/118#issuecomment-6615832191)):
    Notepad depth 2 median 1,700 ms (was 2,916). Save As depth 3 `interactiveOnly`
    median 2,248 ms (was 2,758). 8 provider calls.
- **TRACE-only head-to-head rerun (M5): not run yet.** It covers 4 tasks × 2 in one
  fresh session. Its bars are 8/8 pass, no MCP restart, context under 60k tokens and
  response text under 100,000 characters. agent-desktop 1.0.2 is unchanged, so its
  3 November results are reused.

## Known limits

- **alt+f4 and other system keys** are refused by winapp 0.7.1 and return
  `not_dispatched`. Close windows with their Close button, or with ctrl+w or
  ctrl+shift+w where the app supports them.
- **Keyboard close wait.** The foreground wait is capped at 1,000 ms. A close that
  leaves no foreground window for longer still quarantines the session.
  `recover --apply` frees it without a reconnect (M1).
- **Bridge sidecar.** The provider pin covers each provider's executable. The bridge's
  `TraceWindowBridge.dll` is still checked only by setup and doctor.
- **Unexplained `native_timeout`.** On 3 November, the first MCP session after a
  launch failed two depth-2 observes with `native_timeout`. Three later
  launch–observe–close rounds in one server process did not reproduce it, so the cause
  is unknown. A cold server process was not retested.
