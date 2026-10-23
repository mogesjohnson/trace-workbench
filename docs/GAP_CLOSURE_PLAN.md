# TRACE gap-closure plan and progress

Updated 2026-10-23. **Goal active. 13/22 checkpoints verified (59% of this checklist).**

[Open the visual dashboard](GAP_CLOSURE_PROGRESS.html) · [Detailed status](GAP_CLOSURE_STATUS.md) · [Acceptance specification](../SPEC.md)

Each row is one declared checkpoint. Counts measure completed checkpoints, not time, effort, feature parity or release readiness. A scoped pass covers only the behavior named in that row. This percentage is not a completion claim for the full goal.

**Current work:** Typing quarantine acknowledgement passed with exact text, durable recovery and one follow-up; its ordinary anchor is closed. Passed checks are reused. Glow amended budget is exhausted after a reference click timing-proof failure; no TRACE click/lifecycle pass. Claude discovered both skills and typed correctly; forwarding fix is checked, client-state preservation remains unresolved. Clipboard failed before paste; native cleanup reconciled, changed contents preserved and protected recovery pending. Archive verifier is uploaded as draft PR 17. Full goal remains active.

| Verified at stated scope | In progress | To do | Blocked |
| --- | --- | --- | --- |
| 13 | 4 | 1 | 4 |

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
| 15. Current-source physical-stop relevance | Prove | In progress | Historical physical Escape passes ran an earlier Session.cs that is absent from every Git object (checked 22 Oct). Needs an owner-present current-source physical stop run. | [Open](../evidence/computer-use-method/production-owner-map.json) |
| 16. Complete real Codex workflow | Demonstrate | In progress | Exact Unicode already passed live. Stale-outcome correction is checked; amendment 2 is approved. Complete workflow still needs proof through the actual connected server loaded from corrected source. | [Open](../evidence/live-acceptance-continuation/owner-amendment-2.json) |
| 17. Complete real Claude workflow | Demonstrate | Blocked | Actual host discovered both skills and typed exact text. Forwarding dropped dispatch proof; focused fix passed. Client-state writes still block preservation; corrective run waits for a concrete resolution. | [Open](../evidence/live-acceptance-continuation/claude-supplemental-1/receipt.json) |
| 18. Unicode clipboard paste and restoration | Demonstrate | Blocked | Supported snapshot and synthetic write verified; focus mismatch stopped before paste. Native cleanup reconciled; guarded restoration refused changed clipboard contents. Protected recovery awaits owner archive/retain choice. | [Open](../evidence/live-acceptance-continuation/clipboard-supplemental-1/recovery.json) |
| 19. Full REPLAY editing and two exports | Demonstrate | In progress | Reviewed runtime preserves unknown outcomes as blocked, immutable private recovery context and request-bound reconciliation. 35 focused checks pass. Actual TRACE controls and both edited/audio exports still need live proof. | [Open](../scripts/replay-workflow-runtime.cjs) |
| 20. Clean archive installation and rollback | Deliver | In progress | Existing-host exact archive setup and configuration rollback passed. Portable verifier and CI wiring uploaded in draft PR 17; fresh Windows runner and final archive remain. | [Open](ARCHIVE_INSTALL.md) |
| 21. Final documentation and reviewable commits | Deliver | To do | Reconcile requirement-to-evidence checklist and packaging; README last; planned verification and documentation commits. | [Open](../VERSION_CONTROL.md) |
| 22. Draft PR and required hosted CI | Deliver | Blocked | Draft PRs 14–17 uploaded; next live-results draft is being prepared. Retained CI annotation reports account billing/spending restrictions before job startup. | [Open](../evidence/computer-use-method/ci-pr15-current.json) |

## Next

1. Use the [owned anchor preparation](ACCEPTANCE_ANCHOR.md) for fresh typing/clipboard readiness; fully quit background Claude processes before the host test.
2. Run unconsumed approved cases after preflight. Glow and Codex have exhausted their current supplements; the [second bounded amendment](LIVE_ACCEPTANCE_AMENDMENT_2.md) is a proposal awaiting an actual owner decision. Preserve every failure and finite ledger.
3. Resolve current-source physical-stop proof and complete both REPLAY exports.
4. Verify clean installation/rollback, finish documentation and commits, then open the draft PR and require hosted CI.

The original five supplemental budgets were [approved](../evidence/live-acceptance-continuation/owner-decision.json); glow and Codex have now consumed both attempts. Approval is separate from typing/clipboard idle readiness. Completed compatible live work is reused.

This view is generated from [gap-progress.json](gap-progress.json). It is an inspected checkpoint, not a live test monitor. Refresh it after a verified milestone with `node scripts/render-gap-progress.cjs`.
