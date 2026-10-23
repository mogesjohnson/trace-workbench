# TRACE gap-closure plan and progress

Updated 2026-10-23. **Goal active. 18/22 checkpoints verified (82% of this checklist).**

[Open the visual dashboard](GAP_CLOSURE_PROGRESS.html) · [Detailed status](GAP_CLOSURE_STATUS.md) · [Acceptance specification](../SPEC.md)

Each row is one declared checkpoint. Counts measure completed checkpoints, not time, effort, feature parity or release readiness. A scoped pass covers only the behavior named in that row. This percentage is not a completion claim for the full goal.

**Current work:** Background-only work resumed. 18/22 checkpoints remain verified (82%). Target-hit assertion and pinned offline review are prepared; original glow failure and missing lifecycle stay explicit. REPLAY now rejects automatic end as pause proof. No desktop tests or completed host/stop checks are being repeated.

| Verified at stated scope | In progress | To do | Blocked |
| --- | --- | --- | --- |
| 18 | 2 | 1 | 1 |

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
| 10. Production owner exclusion and handoff | Prove | Verified at stated scope | Approved production exclusion/handoff subcase passed. Current-source physical-stop proof is separately verified in checkpoint 15. | [Open](../evidence/replacement-acceptance/r32-production-owner/attempt-2/receipt.json) |
| 11. Mouse and chord quarantine acknowledgements | Prove | Verified at stated scope | Separate scoped live passes; neither substitutes for typing quarantine. | [Open](../evidence/0.1.0-alpha.3.2/quarantine-ack-chord/receipt.json) |
| 12. REPLAY two-window recording setup | Demonstrate | Verified at stated scope | Actual 3.795-second recording, correct owned editor, decoded frame review, exact app exits and revoked grants. Full demo still pending. | [Open](../evidence/computer-use-method/replay-feasibility/verification.json) |
| 13. Glow clicks and complete lifecycle | Prove | Blocked | Pinned offline review passes the owner-selected target-hit subproof and preserves the original lifetime 8 failure. Ordinary-close/parent-loss stages remain missing; older pre-supervisor evidence cannot transfer. No new live budget granted. | [Open](../evidence/live-acceptance-continuation/glow-target-hit-verification.json) |
| 14. Typing quarantine acknowledgement | Prove | Verified at stated scope | Supplemental attempt 1 passed: exact abc, independent release, persistent quarantine/restart blocking, verified recovery and exactly one pinned-engine follow-up. Both fixtures closed. | [Open](../evidence/live-acceptance-continuation/typing-supplemental-1/verification.json) |
| 15. Current-source physical-stop relevance | Prove | Verified at stated scope | Mouse lifetime 3 and keyboard lifetime 3 passed actual physical Escape with independent release/exit, no later input admission and exactly one follow-up. Injected Escape lifetime 2 passed without being misclassified as physical. Native source hashes match; no repeat needed. | [Open](../evidence/live-acceptance-continuation/finish-stop-verification.json) |
| 16. Complete real Codex workflow | Demonstrate | Verified at stated scope | Approved lifetime 5 passed through the actual reconnected Codex MCP: installed skill discovery, exact Unicode once, consumed-observation not_dispatched with count 0, one fresh counter action to 1, stable text, exact helper/fixture exits and persistent host preserved. No corrective retry needed. | [Open](../evidence/live-acceptance-continuation/codex-amendment-2-attempt-1/receipt.json) |
| 17. Complete real Claude workflow | Demonstrate | Verified at stated scope | Corrective lifetime 4 passed on Claude 2.1.309 with explicitly isolated state: both Skills, five received PNGs, exact text/count 1, stale not_dispatched, fresh recovery, all real-settings intervals preserved, installed bundles/source unchanged and exact cleanup. Temporary sign-in removed. Guarded isolated-host scope; no semantic-image or REA-analysis claim. | [Open](../evidence/live-acceptance-continuation/claude-supplemental-2/receipt.json) |
| 18. Unicode clipboard paste and restoration | Demonstrate | Verified at stated scope | Approved corrective supplement passed: public/independent fresh focus, one completed Unicode paste, exact target text and unchanged count, guarded restoration plus fresh supported-byte comparison, exact native/fixture exits and private-artifact cleanup. Ordinary anchor explicitly closed. | [Open](../evidence/live-acceptance-continuation/clipboard-supplemental-2/receipt.json) |
| 19. Full REPLAY editing and two exports | Demonstrate | In progress | Approved lifetime 4 completed all 17 runtime stages, two exports, independent media checks, sampled output review and exact cleanup. Audit stays partial: playback ended before the second native toggle click, so user-caused pause is unproved. Review this narrow disposition; do not repeat the full workflow. | [Open](../evidence/live-acceptance-continuation/replay-finish-2/verification.json) |
| 20. Clean archive installation and rollback | Deliver | In progress | Fresh hosted Windows runner passed exact archive 08d6984: locked setup, provider/MCP checks, four client configurations, exact backups, preservation, idempotence, conflicts and rollback. Final release archive and checksum publication remain open; a different archive does not inherit this pass. | [Open](ARCHIVE_INSTALL.md) |
| 21. Final documentation and reviewable commits | Deliver | To do | Reconcile requirement-to-evidence checklist and packaging; README last; planned verification and documentation commits. | [Open](../VERSION_CONTROL.md) |
| 22. Draft PR and required hosted CI | Deliver | Verified at stated scope | PR 24 head 04407b7 passed required hosted CI run 40012731237, including archive checks. New background preparation needs its own final-head CI. No merge or release claim. | [Open](../evidence/computer-use-method/public-ci-parallel-fixes.json) |

## Next

1. Finish the background preparation and independent Claude source review; see [the background finish plan](BACKGROUND_FINISH_PLAN.md).
2. Upload a focused draft PR depending on PR 24; run its required hosted CI and exact-archive checks. No broad local rerun.
3. Keep desktop control stopped. A later direct bounded decision is needed only for missing glow lifecycle and REPLAY pause proof; reuse compatible passes.
4. Reconcile the full requirement-to-evidence checklist and final artifact scope. No merge or release is authorized by background-only resume.

Public hosted CI and clean-runner archive verification passed at the recorded checkpoint; final-source and final-archive gates remain explicit. Approval is separate from desktop readiness and does not change earlier evidence.

This view is generated from [gap-progress.json](gap-progress.json). It is an inspected checkpoint, not a live test monitor. Refresh it after a verified milestone with `node scripts/render-gap-progress.cjs`.
