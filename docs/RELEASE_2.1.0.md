# TRACE Workbench 2.1.0

**Published 3 November 2026 with direct owner approval.**
[Download v2.1.0](https://github.com/mogesjohnson/trace-workbench/releases/tag/v2.1.0).
The [publication receipt](../evidence/release-2.1.0/publication.json) binds merged source
`acca833`, passing final-main Windows CI, exact archive installation/rollback and five
independently downloaded and hash-verified assets. The bundled notes and companion
manifests keep their prepublication snapshot. It fixes known limits G1–G5 of
[2.0.0](RELEASE_2.0.0.md), following the [2.1.0 fix plan](FIX_PLAN_2.1.0.md). Published
2.0.0 and its assets remain available. The first TRACE-only rerun of the head-to-head
(plan M5, step 3) passed 8/8 task-runs but missed its context and response-size bars. After
the M7 fixes, the second rerun met every bar; see [Verification scope](#verification-scope).

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
- **Typed text is checked, and `interactiveOnly` envelopes are leaner (M7; [PR 121](https://github.com/mogesjohnson/trace-workbench/pull/121)).**
  winapp 0.7.1 sends text longer than 16 characters in 16-character chunks, and in the
  first rerun Notepad dropped a chunk while the act returned `completed`. `type_text` now
  reads the focused control before input and for up to 1,500 ms after it. Only the
  changed span counts. A shortfall returns `unknown` with `text_not_delivered` and
  `textDelivery.prefixFound`, plus the refreshed observation. A completed result carries
  `nativeResult.textDelivery`: `verified`, or `not_checked` with a reason (Enter or Tab in
  the text, an unreadable control, or unchanged text). `interactiveOnly` observations also
  drop an `automationId` equal to the element ID and return a lean envelope: window naming
  fields, compact focus, and no target-state provenance.

## Compatibility

There is no change to the 2.0 contract. The tool names, action forms, outcomes,
`returnObservation` modes and `support.contractVersion: 1` are unchanged. New fields
(`recoveredExternally`, `reason`, `nativeResult.textDelivery`, doctor `launch.catalog`,
`launch.uri` and `supervision.code`) are additive, and launch accepts more `app` forms
than before.

Three results change in the direction the 2.0 notes described as limits:

- A keyboard close that used to return `unknown` / `input_recovery_required` now
  returns `target_closed_after_dispatch`.
- A winapp system-key refusal that used to return `unknown` now returns
  `not_dispatched`.
- A `type_text` whose text does not arrive in full, which used to return `completed`,
  now returns `unknown` with `text_not_delivered`.

Only `interactiveOnly` observations use the lean element format and envelope. Full, accessibility
and screenshot observations without `interactiveOnly` keep the 2.0 element fields.

After installing 2.1.0, run `computer setup --apply`. The supervisor and bridge
changed, and doctor reports `supervisor_stale` until they are rebuilt. Then reconnect
`trace-computer`. The skill text changed: run `sync-computer-skill --plan`, then
`--apply`.

## Verification scope

- Automated tests: each fix PR added focused suites (`v12-release-after-recovery`,
  `m3-packaged-launch`, `m4-lean-observations`, the system-key case in
  `v10-p1-scoping`, the rewritten `v2-adjacent-identity`, and PR 121's typed-text and
  lean-envelope cases) and the native selftests.
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
- **First TRACE-only head-to-head rerun (M5;
  [report](HEAD_TO_HEAD_2026-11-03-RERUN.md)).** It ran 4 tasks × 2 in one fresh
  session on main `b938941`. agent-desktop 1.0.2 is unchanged, so its 3 November
  results are reused.
  - 8/8 task-runs passed, including Settings 2/2. Run 1 task 1 needed a corrective
    type (see Known limits).
  - There was no MCP restart. The deliberate ctrl+shift+w close returned
    `target_closed_after_dispatch`.
  - **Two bars were missed.** Context was about 74k tokens (bar 60k). Response text was
    107,192 characters (bar 100,000); on 3 November it was 151,697.
  - The first observe on the fresh server took 1,232 ms with no `native_timeout`.
  - It found two defects: partial typed text reported `completed` (D1) and a
    `native_timeout` on a URL-bar `type_text` (D2). The owner chose to fix and rerun (M7).
- **Second TRACE-only rerun, after M7 (M7;
  [report](HEAD_TO_HEAD_2026-11-03-RERUN2.md)).** Same rules and
  bars, 4 tasks × 2 in one session, on merged main `2b5d0da` (M1–M4, PRs 117, 118 and 121). agent-desktop's
  3 November results are again reused. **Every bar was met.**
  - 8/8 task-runs passed with no corrective retyping, including Settings 2/2. Saved files
    were exactly 19 bytes, and the 75-character path `type_text` returned
    `textDelivery.status: "verified"`.
  - There was no MCP restart. Every close, including the deliberate ctrl+shift+w in run 1,
    returned `target_closed_after_dispatch`.
  - Context rose about 53k tokens across the 8 task-runs (bar 60k; first rerun about 74k).
    The meter also counts the driver's reasoning and status messages, so this is an upper
    bound. The session was not new: it had earlier merged PR 121 and synced the skill, and
    those turns are not counted.
  - Response text was 68,760 characters (bar 100,000; first rerun 107,192). Observations
    were 69% of it, against 85% in the first rerun.
  - D1 and D2 did not recur: both Notepad texts read back exactly on the first try, and
    `type_text "https://example.com"` then `press_key enter` navigated Firefox in both
    runs.
  - No product defect was found. Three one-step corrections are listed under Known limits.

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
  launch failed two depth-2 observes with `native_timeout`, and in the first rerun one
  `type_text` with a trailing newline into the Firefox URL bar returned `native_timeout`
  with nothing typed (D2). Neither reproduced later, including in the second rerun. In
  winapp's source, send-keys resolves the window and waits for a desktop lock before any
  key is sent; either stalling fits. TRACE reports `unknown`; observe before retrying.
- **Typed text is not always checked.** Text with Enter or Tab, a password field, a
  control without TextPattern, or text over 4,096 characters returns
  `textDelivery.status: "not_checked"`. Read the text back with `documentElementId` where
  it matters.
- **A launched window may not be foreground.** In the second rerun, `launch notepad`
  returned a window without `foreground: true`, and the first click returned
  `not_dispatched` ("Windows refused activation of the selected window"). An `activate`
  act fixed it.
- **Shallow observes can miss the focused control.** At depth 2, the Save As File name
  edit sits below its `ComboBox`, so focus reports `binding: "unresolved"` and keys return
  `not_dispatched`. Scope the observe with `rootElementId: "FileNameControlHost"`.
- **`interactiveOnly` toolbar reads omit text values.** Read the Firefox URL with
  `documentElementId: "urlbar-input"`, not through a `nav-bar` read.
