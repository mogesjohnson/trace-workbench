# Finish gate review

Updated 23 October 2026. **18 of 22 checkpoints verified (82%).** This is the concrete remaining work, not a new retry authorization. Previous failures and frozen approvals remain unchanged.

**Background-only resume:** [The current finish plan](BACKGROUND_FINISH_PLAN.md) records six focused offline checks and a completed tool-free Claude source review. [Pinned target-hit verification](../evidence/live-acceptance-continuation/glow-target-hit-verification.json) passes that subproof while preserving the original failed receipt. The prospective assertion does not change the frozen live driver or its budgets. REPLAY now rejects automatic end-of-media as a pause result; causal pause proof is still missing. No desktop control ran.

**Owner decision recorded:** The owner chose option 1: accept the correct intended-target hit rather than exact requested-center pixel placement. [The exact reply](../evidence/live-acceptance-continuation/owner-glow-target-hit-decision.json) preserves the original failed result. This settles the criterion preference; it grants no additional live attempts and does not establish missing lifecycle or REPLAY pause evidence.

## Delivered now

- Current-source physical Escape during held mouse and keyboard input, plus ordinary injected Escape: [audited live passes](../evidence/live-acceptance-continuation/finish-stop-verification.json). No further human keystrokes or repeated tests are needed for these cases.
- REPLAY launcher ownership fixed: Playwright on Windows retains `cmd.exe`. Electron main is now bound through the launch-owned connection, independent executable/parent/generation/session checks and native HWND equality. Cleanup confirms both generations exit. Four affected injected checks passed, including separate shell/main cleanup.
- Approved REPLAY lifetime 4 completed all 17 runtime stages. Both artifacts are available: [six-second edited fixture](../evidence/live-acceptance-continuation/replay-finish-2/artifacts/fixture-demo.mp4), [189.9-second editor walkthrough](../evidence/live-acceptance-continuation/replay-finish-2/artifacts/editor-walkthrough.mp4). Independent decode verified source preservation, timed callout/blur and the one-second offline tone. No paid provider requests. [Full scoped audit](../evidence/live-acceptance-continuation/replay-finish-2/verification.json).
- Exact app, grant, transport, fixture, anchor and reference-helper cleanup completed. No desktop-control helper remains running.

## Two acceptance dispositions remain

| Case | Actual evidence | Remaining issue | Next work |
| --- | --- | --- | --- |
| Glow | Reference click passed; TRACE completed; all five counters reached 2; exact cleanup passed. Owner chose correct target hit. | Original exact-center failure stays preserved; ordinary-close/parent-loss stages were not reached. Approved lifetime 8 is exhausted. | Apply the chosen target-hit criterion prospectively; audit compatibility of existing lifecycle evidence before proposing only the still-missing live work. |
| REPLAY | Exact targeting, captured source review, edits, two exports, actual native editor clicks and completed-file playback passed. | Playback reached its end before the second toggle click. The runtime correctly found a paused position, but that does not prove a user-caused pause. Lifetime 4 is consumed. | Decide whether the stated APP-01 real-app result accepts this scoped demonstration, or require a bounded pause-specific supplement with a timing plan that accommodates observation latency. Do not repeat the full workflow. |

The public REPLAY receipt remains `awaiting_runtime_evidence_audit`; its audit is `partial`. Full APP-01 and full glow acceptance are not promoted by this document.

## Coordinate lead, not a binary fix

The inspected [winappCli v0.7.1 MouseInput source](https://github.com/microsoft/winappCli/blob/v0.7.1/src/winapp-CLI/WinApp.UIAutomation/Input/MouseInput.cs) normalizes absolute drag coordinates using `round(x * 65535 / (width - 1))`. TRACE uses a same-point drag for coordinate clicks. At width 2880, requested X 7 normalizes to 159; mapping that absolute bucket back with `floor(159 * 2880 / 65536)` gives 6. This is consistent with the retained event, not proof of binary/source equivalence or an exercised fix. The source's selector click path uses `SetCursorPos`, while its CLI click requires a selector; replacing the coordinate route blindly is not supported.

## Final delivery order

1. Preserve the current results and finish the focused draft PR; inspect its required hosted CI. Existing green CI stays valid at its recorded head.
2. Resolve only the two dispositions above. Existing Codex, Claude, clipboard, typing recovery, window targeting and physical-stop passes stay verified at compatible scope.
3. Build and verify the final exact archive once the implementation is final; publish its checksum and complete the requirement-to-evidence review. The earlier archive does not transfer its pass to a different artifact.

No new Claude model session, broad local test suite or extra desktop attempt is required just to review this checkpoint. Any further exhausted-case execution needs an explicit bounded owner decision under SPEC.md.
