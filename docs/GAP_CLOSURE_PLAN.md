# TRACE gap-closure plan and progress

Updated 2026-10-23. **Goal active. 15/22 checkpoints verified (68% of this checklist).**

[Open the visual dashboard](GAP_CLOSURE_PROGRESS.html) · [Detailed status](GAP_CLOSURE_STATUS.md) · [Acceptance specification](../SPEC.md)

Each row is one declared checkpoint. Counts measure completed checkpoints, not time, effort, feature parity or release readiness. A scoped pass covers only the behavior named in that row. This percentage is not a completion claim for the full goal.

**Current work:** Resumed from the shutdown checkpoint. Codex and clipboard passes stand; no live tests repeated. GAP_CLOSURE_FINISH_PLAN.md consolidates the remaining amendments and prerequisites. Latest shutdown-head CI confirms billing/spending blocked all steps. Glow/REPLAY budgets and current-source Escape need direct decisions; Claude isolation is a candidate preservation fix, not yet verified.

| Verified at stated scope | In progress | To do | Blocked |
| --- | --- | --- | --- |
| 15 | 2 | 1 | 4 |

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
| 16. Complete real Codex workflow | Demonstrate | Verified at stated scope | Approved lifetime 5 passed through the actual reconnected Codex MCP: installed skill discovery, exact Unicode once, consumed-observation not_dispatched with count 0, one fresh counter action to 1, stable text, exact helper/fixture exits and persistent host preserved. No corrective retry needed. | [Open](../evidence/live-acceptance-continuation/codex-amendment-2-attempt-1/receipt.json) |
| 17. Complete real Claude workflow | Demonstrate | Blocked | Actual host discovered both skills and typed exact text. Forwarding dropped dispatch proof; focused fix passed. Client-state writes still block preservation; corrective run waits for a concrete resolution. | [Open](../evidence/live-acceptance-continuation/claude-supplemental-1/receipt.json) |
| 18. Unicode clipboard paste and restoration | Demonstrate | Verified at stated scope | Approved corrective supplement passed: public/independent fresh focus, one completed Unicode paste, exact target text and unchanged count, guarded restoration plus fresh supported-byte comparison, exact native/fixture exits and private-artifact cleanup. Ordinary anchor explicitly closed. | [Open](../evidence/live-acceptance-continuation/clipboard-supplemental-2/receipt.json) |
| 19. Full REPLAY editing and two exports | Demonstrate | Blocked | Both full-run attempts stopped during provision before grants, recording, fixture creation or TRACE input. Visibility wait and retained-handle cleanup corrected; second run confirms cleanup but rejects process/window identity equality. Exact mismatch cause unproved; no further run authorized. | [Open](REPLAY_LIVE_RUN.md) |
| 20. Clean archive installation and rollback | Deliver | In progress | Existing-host exact archive setup and configuration rollback passed. Portable verifier and CI wiring uploaded in draft PR 17; fresh Windows runner and final archive remain. | [Open](ARCHIVE_INSTALL.md) |
| 21. Final documentation and reviewable commits | Deliver | To do | Reconcile requirement-to-evidence checklist and packaging; README last; planned verification and documentation commits. | [Open](../VERSION_CONTROL.md) |
| 22. Draft PR and required hosted CI | Deliver | Blocked | Draft PRs through 20 uploaded. Shutdown-head run 39910599102 failed with zero steps; its exact annotation confirms account payments/spending restrictions. No retry until that condition changes. | [Open](../evidence/computer-use-method/ci-shutdown-head.json) |

## Next

1. Use the [owned anchor preparation](ACCEPTANCE_ANCHOR.md) for fresh typing/clipboard readiness; fully quit background Claude processes before the host test.
2. Run unconsumed approved cases after preflight. Glow and Codex have exhausted their current supplements; the [second bounded amendment](LIVE_ACCEPTANCE_AMENDMENT_2.md) is a proposal awaiting an actual owner decision. Preserve every failure and finite ledger.
3. Resolve current-source physical-stop proof and complete both REPLAY exports.
4. Verify clean installation/rollback, finish documentation and commits, then open the draft PR and require hosted CI.

The original five supplemental budgets were [approved](../evidence/live-acceptance-continuation/owner-decision.json); glow and Codex have now consumed both attempts. Approval is separate from typing/clipboard idle readiness. Completed compatible live work is reused.

This view is generated from [gap-progress.json](gap-progress.json). It is an inspected checkpoint, not a live test monitor. Refresh it after a verified milestone with `node scripts/render-gap-progress.cjs`.
