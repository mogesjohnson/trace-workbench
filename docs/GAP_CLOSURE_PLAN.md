# TRACE gap-closure plan and progress

Updated 2026-10-23. **Goal active. 17/22 checkpoints verified (77% of this checklist).**

[Open the visual dashboard](GAP_CLOSURE_PROGRESS.html) · [Detailed status](GAP_CLOSURE_STATUS.md) · [Acceptance specification](../SPEC.md)

Each row is one declared checkpoint. Counts measure completed checkpoints, not time, effort, feature parity or release readiness. A scoped pass covers only the behavior named in that row. This percentage is not a completion claim for the full goal.

**Current work:** Resumed 23 October. Public Windows CI passed for implementation head 701a35c (PR merge 08d6984): 516 checks passed, five skipped, zero failed, both MCP paths and exact-archive install/rollback passed. Progress is 17/22 scoped checkpoints (77%); five remain. Glow, current-source Escape and REPLAY amendments await direct owner decisions. Final-archive verification and final review remain open. No desktop test is running.

| Verified at stated scope | In progress | To do | Blocked |
| --- | --- | --- | --- |
| 17 | 1 | 1 | 3 |

## Plan

| Checkpoint | Stage | Status | What / remaining proof | Evidence |
| --- | --- | --- | --- | --- |
| 01. Research and integration design | Build | Verified at stated scope | Computer-use-method research, connections and integration design are recorded. | [Open](COMPUTER_USE_METHOD_INTEGRATION.md) |
| 02. Method coordinator and evidence contracts | Build | Verified at stated scope | Effects, steps, routing, checkpoints and artifact identity are implemented and contract-tested. | [Open](../src/method/README.md) |
| 03. Structured browser adapter | Build | Verified at stated scope | Real headless browser checks cover routing, lost replies and navigation races. | [Open](../evidence/computer-use-method/browser/freshness-check.json) |
| 04. Known-app lifecycle adapter | Build | Verified at stated scope | Eight actual child-process/IPC cases; arbitrary GUI editing needs separate proof. | [Open](../evidence/computer-use-method/application/receipt.json) |
| 05. Installed guidance and matching bundles | Build | Verified at stated scope | Three managed bundles match; four server entries preserved. Actual host workflows remain separate. | [Open](../evidence/computer-use-method/skill-sync-clipboard.json) |
| 06. Native supervision implementation | Build | Verified at stated scope | Built supervisor, quarantine, input balancing and UTF-8 transport; 25 pure native checks. Live acceptance remains separate. | [Open](../evidence/computer-use-method/native-pure-utf8.json) |
| 07. Observation depth, outcomes and modal targeting | Prove | Verified at stated scope | Scoped depth, non-dispatch and real modal continuation cases passed. | [Open](../evidence/0.1.0-alpha.3.3/case-status.json) |
| 08. Moved and minimized window targeting | Prove | Verified at stated scope | Approved replacement rejects stale geometry and reaches exact fresh coordinates. | [Open](../evidence/replacement-acceptance/r3-window-coordinates/attempt-1/receipt.json) |
| 09. Recovery matrix: 15 failure/input pairs | Prove | Verified at stated scope | 13 compatible original passes plus two approved cancellation replacements. Mixed source scopes and three legacy exit-metadata limits remain explicit. | [Open](../evidence/computer-use-method/effective-recovery-map.json) |
| 10. Production owner exclusion and handoff | Prove | Verified at stated scope | Approved exclusion/handoff subcase passed; broader owner invariants still include a current-source stop gap. | [Open](../evidence/replacement-acceptance/r32-production-owner/attempt-2/receipt.json) |
| 11. Mouse and chord quarantine acknowledgements | Prove | Verified at stated scope | Separate scoped live passes; neither substitutes for typing quarantine. | [Open](../evidence/0.1.0-alpha.3.2/quarantine-ack-chord/receipt.json) |
| 12. REPLAY two-window recording setup | Demonstrate | Verified at stated scope | Actual 3.795-second recording, correct owned editor, decoded frame review, exact app exits and revoked grants. Full demo still pending. | [Open](../evidence/computer-use-method/replay-feasibility/verification.json) |
| 13. Glow clicks and complete lifecycle | Prove | Blocked | Reference click reached the physical edge once, all five counters 1. Full lifetime-6 case failed the strict event window; no TRACE click or full lifecycle pass. Cleanup passed; amended budget exhausted. | [Open](../evidence/live-acceptance-continuation/glow-amendment-2-attempt-2/diagnosis.json) |
| 14. Typing quarantine acknowledgement | Prove | Verified at stated scope | Supplemental attempt 1 passed: exact abc, independent release, persistent quarantine/restart blocking, verified recovery and exactly one pinned-engine follow-up. Both fixtures closed. | [Open](../evidence/live-acceptance-continuation/typing-supplemental-1/verification.json) |
| 15. Current-source physical-stop relevance | Prove | Blocked | Historical physical Escape passes ran an earlier Session.cs that is absent from every Git object (checked 22 Oct). Needs an owner-present current-source physical stop run. | [Open](../evidence/computer-use-method/production-owner-map.json) |
| 16. Complete real Codex workflow | Demonstrate | Verified at stated scope | Approved lifetime 5 passed through the actual reconnected Codex MCP: installed skill discovery, exact Unicode once, consumed-observation not_dispatched with count 0, one fresh counter action to 1, stable text, exact helper/fixture exits and persistent host preserved. No corrective retry needed. | [Open](../evidence/live-acceptance-continuation/codex-amendment-2-attempt-1/receipt.json) |
| 17. Complete real Claude workflow | Demonstrate | Verified at stated scope | Corrective lifetime 4 passed on Claude 2.1.309 with explicitly isolated state: both Skills, five received PNGs, exact text/count 1, stale not_dispatched, fresh recovery, all real-settings intervals preserved, installed bundles/source unchanged and exact cleanup. Temporary sign-in removed. Guarded isolated-host scope; no semantic-image or REA-analysis claim. | [Open](../evidence/live-acceptance-continuation/claude-supplemental-2/receipt.json) |
| 18. Unicode clipboard paste and restoration | Demonstrate | Verified at stated scope | Approved corrective supplement passed: public/independent fresh focus, one completed Unicode paste, exact target text and unchanged count, guarded restoration plus fresh supported-byte comparison, exact native/fixture exits and private-artifact cleanup. Ordinary anchor explicitly closed. | [Open](../evidence/live-acceptance-continuation/clipboard-supplemental-2/receipt.json) |
| 19. Full REPLAY editing and two exports | Demonstrate | Blocked | Both full-run attempts remain blocked during provision. Adapter now checkpoints the rejected window candidate and public mismatch field names before equality; one affected injected case passed without a live run. Earlier mismatch cause remains unknown. Strict identity/cleanup preserved; further run awaits direct cap extension. | [Open](REPLAY_LIVE_RUN.md) |
| 20. Clean archive installation and rollback | Deliver | In progress | Fresh hosted Windows runner passed exact archive 08d6984: locked setup, provider/MCP checks, four client configurations, exact backups, preservation, idempotence, conflicts and rollback. Final release archive and checksum publication remain open; a different archive does not inherit this pass. | [Open](ARCHIVE_INSTALL.md) |
| 21. Final documentation and reviewable commits | Deliver | To do | Reconcile requirement-to-evidence checklist and packaging; README last; planned verification and documentation commits. | [Open](../VERSION_CONTROL.md) |
| 22. Draft PR and required hosted CI | Deliver | Verified at stated scope | Draft PR 23 implementation head 701a35c passed required Windows CI run 39999545940 on PR merge 08d6984: 516 passed, five skipped, zero failed; both MCP paths and archive install passed. Public runner executes. Final source needs its own required CI; no merge or release claim. | [Open](../evidence/computer-use-method/public-ci-parallel-fixes.json) |

## Next

1. Obtain the three direct bounded decisions in the [finish plan](GAP_CLOSURE_FINISH_PLAN.md): glow timing/budget, current-source Escape and full REPLAY. Earlier results remain unchanged.
2. After approval, prepare only the affected work, then request fresh desktop readiness. Physical stop requires two owner Escape taps.
3. Complete glow, current-source stop and both REPLAY exports. Reuse the completed Codex, Claude, clipboard and other compatible passing checks.
4. Reconcile documentation and final packaging, verify the exact final archive on a fresh Windows runner, and require CI on the final source.

Public hosted CI and clean-runner archive verification passed at the recorded checkpoint; final-source and final-archive gates remain explicit. Approval is separate from desktop readiness and does not change earlier evidence.

This view is generated from [gap-progress.json](gap-progress.json). It is an inspected checkpoint, not a live test monitor. Refresh it after a verified milestone with `node scripts/render-gap-progress.cjs`.
