# TRACE Workbench 2.2.0

**Published 4 November 2026 with direct owner approval.**
[Download v2.2.0](https://github.com/mogesjohnson/trace-workbench/releases/tag/v2.2.0).
The [publication receipt](../evidence/release-2.2.0/publication.json) binds merged source
`397d6c5`, passing final-main Windows CI, exact archive installation/rollback and five
independently downloaded and hash-verified assets. The bundled notes and companion
manifests keep their prepublication snapshot. It adds Road V1 item 10 (intended focus
and operation freshness) and item 19 (the coordinate contract and related popups) to
[2.1.0](RELEASE_2.1.0.md), with a Codex configuration fix and phone fixes. Published
2.1.0 and its assets remain available.

## Changes

- **Intended focus for typing (item 10; [PR 126](https://github.com/mogesjohnson/trace-workbench/pull/126)).**
  `type_text` accepts an optional `expectedFocusElementId`. It must name the observed,
  enabled focus target. A mismatch is rejected before the observation is used. After
  activation, the backend checks the control and the actual focus again before it sends
  text. Typing without the field and keyboard navigation behave as before. A 2.1.0
  server rejects the field, so inspect the connected act schema rather than assuming it.
- **Operation freshness in `ComputerMethod` (item 10; PR 126).** `operationPolicies`
  maps step check IDs to `maxAgeMs`. Dispatch uses the smallest of the policy,
  coordinator and native TTL, measured from capture start with a local monotonic clock.
  Invalid or backwards time blocks the step before any attempt. Read-only verification
  policies and the final fresh effect check stay separate.
- **Every pixel space is named (item 19, R22; [PR 138](https://github.com/mogesjohnson/trace-workbench/pull/138)).**
  An observation with pixel geometry adds a `coordinates` block: the action-point
  space, the element-bounds space, `windowOrigin`, `image.physicalPerImagePixel` when an
  image is returned, and `logical`. `logical` gives the DPI and
  `physicalPerLogicalPixel` only for a per-monitor-aware window. Windows reports 96 DPI
  for an unaware window on any display, so for unaware and system-aware windows
  `logical` is `available: false` and names the awareness. Input never accepts logical
  pixels. The bridge `bounds` reply adds `dpi` and `dpiAwareness`.
  [COMPUTER_USE.md](COMPUTER_USE.md) step 4 now describes the scaled-image mapping. The
  earlier text said action points are relative to the returned image, which is wrong
  for a scaled image.
- **Related popups are reported (item 19, R21; [PR 139](https://github.com/mogesjohnson/trace-workbench/pull/139)).**
  Full and screenshot observations add `relatedWindows`: the menus, tooltips and owned
  popups above the session window, which the window image omits. Each entry has a
  `relation` (`owned`, `thread-menu` or `same-thread-popup`), `kind`, `zOrder`, physical
  `bounds`, an `offset` in action-point space, `coversWindow`, DPI, `topmost`, and a
  bounded UIA type and name. `coverage` says what was searched. A failed read is
  `available: false` with a code and never fails the observation. `relatedImages: true`
  adds a PNG of each popup. Related windows are context only and get no element IDs.
- **Clicks into the window's own popups are refused (item 19; PR 139).** Left click,
  element click, drag and wheel had no occlusion check, so they could click into an open
  menu. After activation they now run a read-only bridge `hit` check, and return
  `not_dispatched` with `target_occluded` when one of the window's own popups covers the
  point. Another app's window over the point is still handled by activation, as before.
- **Codex `enabled = true` is accepted (M6; [PR 134](https://github.com/mogesjohnson/trace-workbench/pull/134)).**
  In the Codex `trace-computer` entry, `enabled = true` no longer counts as
  `different_server_entry`. `enabled = false` and other differences are still
  conflicts. `smoke-mcp` gives its process query 30 s instead of 15 s.
- **Phone.** The Wi-Fi trust watcher works on SDK 37 and a keep-alive restarts it after
  adbd restarts ([PR 105](https://github.com/mogesjohnson/trace-workbench/pull/105)).
  `phone-transcribe` runs through the phone's adb shell for about 3× faster
  transcription, with a proot fallback ([PR 130](https://github.com/mogesjohnson/trace-workbench/pull/130)).
  Closing `trace phone mcp` no longer stops an agent it never reached, `--record` no
  longer cuts the speaker off, and sshd starts at boot on loopback only
  ([PR 132](https://github.com/mogesjohnson/trace-workbench/pull/132)). A phone install
  refreshes `phone-transcribe` ([PR 133](https://github.com/mogesjohnson/trace-workbench/pull/133)).

## Compatibility

There is no change to the 2.0 contract. Tool names, action forms, outcomes,
`returnObservation` modes and `support.contractVersion: 1` are unchanged, and the
support descriptor digest is unchanged, so 2.x compact declarations still validate.
`expectedFocusElementId`, `relatedImages`, `operationPolicies`, `coordinates`,
`relatedWindows` and the bridge `dpi`/`dpiAwareness` fields are additive.

One result changes, in the safe direction: a left click, element click, drag or wheel
on a point covered by one of the window's own popups used to be sent and now returns
`not_dispatched` with `target_occluded`. Close the popup (for example with Escape) or
act on it, then observe again.

After installing 2.2.0, run `computer setup --apply`. The bridge gained the `related`
and `hit` commands and the supervisor allowlist changed, so doctor reports
`supervisor_stale` until they are rebuilt. Then reconnect `trace-computer`. The skill
changed: run `sync-computer-skill --plan`, then `--apply`. To get the phone changes,
reinstall the phone with `install-phone-claude.cjs`.

## Verification scope

- Automated tests: PR 126 added 6 focused checks, PR 138 added
  `v9-coordinate-contract` (5 cases), PR 139 added `v9-related-windows` (14 cases) and
  bridge and supervisor self-tests, PR 134 added a Codex configuration case, and PR 105
  added `phone-wifi-trust` (skipped without a JDK and Android SDK). PR 139's full run was
  827 tests, 821 passed, 0 failed. [Final-main Windows CI](https://github.com/mogesjohnson/trace-workbench/actions/runs/41963617309)
  passed on released commit `397d6c5`.
- Live checks:
  - **Coordinates (PR 138).** A read-only bridge `bounds` query on six windows (Notepad,
    Explorer, Firefox, Edge, VS Code, ApplicationFrameHost) returned 144 DPI and
    `per-monitor`. No input was sent.
  - **Related popups (PR 139;
    [evidence](../evidence/item19-related-windows-2026-11-05/README.md)).** All four
    popup kinds were reported on a WinForms test window, and a click on a menu-covered
    point was refused with no input reaching the window. In the first attempt the menu
    closed before the click, so that click reached the window beneath; it is recorded in
    `first-attempt.json`.
  - **Phone.** The SDK 37 watcher trusted new BSSIDs on a hotspot and on eduroam, and
    the keep-alive restarted it 28 s after adbd restarted (PRs 105 and 125).
    `phone-transcribe` by adb took about 5 s against about 15 s by proot, and
    `--record 15` gave words the owner confirmed (PRs 130 and 133).
- Not run: item 10 has no live desktop check (its checks use synthetic backends and
  the real in-memory MCP transport). No head-to-head rerun was done for this release.

## Known limits

All [2.1.0 known limits](RELEASE_2.1.0.md#known-limits) still apply. In addition:

- **Display scope.** Live coordinate evidence covers one display at 144 DPI. Mixed DPI,
  more than one monitor and DPI changes during a session are not supported. The
  DPI-unaware path is covered by unit tests only.
- **Related popups.** Live coverage is a WinForms test window. XAML, Chromium,
  popups of other threads or processes, and real hover were not tested. Popups of other
  threads or processes are not attributed.
- **Popup guard timing.** The check runs at dispatch, so a popup that opens after it is
  not caught. An element click is checked at the element's centre.
- **Phone.** The Wi-Fi band-switch test has not run. Starting sshd at boot has not been
  checked after a reboot, and the install-time `phone-transcribe` refresh has not run on
  the phone.
