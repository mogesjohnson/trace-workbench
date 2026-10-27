# TRACE gap-closure plan and progress

Updated 2026-10-22. **Goal active. 12/22 checkpoints verified (55% of this checklist).**

[Open the visual dashboard](GAP_CLOSURE_PROGRESS.html) · [Detailed status](GAP_CLOSURE_STATUS.md) · [Acceptance specification](../SPEC.md)

Each row is one declared checkpoint. Counts measure completed checkpoints, not time, effort, feature parity or release readiness. A scoped pass covers only the behavior named in that row. This percentage is not a completion claim for the full goal.

**Current work:** Codex resumed and reviewed Claude PR 15. Claude settings and REPLAY recovery corrections pass local checks (501 tests: 495 passed, 6 skipped). Glow final supplement failed the 60-second underlying sample freshness check after one actual Sky click; cleanup verified, both supplements consumed. Fresh-capture correction is checked offline; the proposed extra glow/Codex budget waits for the owner. Unconsumed typing/Claude/clipboard cases need their exact preconditions; full REPLAY live demo remains. GitHub CI is billing/spending blocked.

| Verified at stated scope | In progress | To do | Blocked |
| --- | --- | --- | --- |
| 12 | 5 | 2 | 3 |

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
| 13. Glow clicks and complete lifecycle | Prove | Blocked | Both approved supplements consumed. Final run failed underlying glow sample age (62.686s) after one actual Sky click; no TRACE click. Cleanup verified. New safe-frame correction tested; extra budget proposal pending. | [Open](../evidence/live-acceptance-continuation/glow-supplemental-2/diagnosis.json) |
| 14. Typing quarantine acknowledgement | Prove | In progress | Supplement approved; exact owned foreground anchor and fresh direct owner idle readiness required before claim. | [Open](LIVE_ACCEPTANCE_CONTINUATION.md) |
| 15. Current-source physical-stop relevance | Prove | In progress | Historical physical Escape passes ran an earlier Session.cs that is absent from every Git object (checked 22 Oct). Needs an owner-present current-source physical stop run. | [Open](../evidence/computer-use-method/production-owner-map.json) |
| 16. Complete real Codex workflow | Demonstrate | Blocked | Exact Unicode now passed live. Stale error lacked outcome metadata; product correction is tested. Both supplements consumed: a reconnected host and a new owner budget decision are needed for another live run. | [Open](../evidence/live-acceptance-continuation/codex/attempt-2/diagnosis.json) |
| 17. Complete real Claude workflow | Demonstrate | In progress | Reviewed interval/writer gates now block contaminated comparisons and reverted changes; managed settings included. 61 focused checks pass. Live test waits for every background Claude Desktop/Code process to exit. | [Open](CLAUDE_SETTINGS_ATTRIBUTION_PLAN.md) |
| 18. Unicode clipboard paste and restoration | Demonstrate | In progress | Text-only adapter and identifier preflight implemented. Unsupported formats preserved; supported live paste and exact-byte restoration unproved. | [Open](../evidence/computer-use-method/clipboard/format-support-preflight.json) |
| 19. Full REPLAY editing and two exports | Demonstrate | In progress | Reviewed runtime preserves unknown outcomes as blocked, immutable private recovery context and request-bound reconciliation. 35 focused checks pass. Actual TRACE controls and both edited/audio exports still need live proof. | [Open](../scripts/replay-workflow-runtime.cjs) |
| 20. Clean archive installation and rollback | Deliver | To do | Verify the exact final archive on Windows, preserve client settings and prove rollback. | [Open](../SPEC.md) |
| 21. Final documentation and reviewable commits | Deliver | To do | Reconcile requirement-to-evidence checklist and packaging; README last; planned verification and documentation commits. | [Open](../VERSION_CONTROL.md) |
| 22. Draft PR and required hosted CI | Deliver | Blocked | PR 14 and Claude PR 15 are uploaded drafts; Codex follow-up remains. Actual PR 15 check annotation confirms zero steps started due to account billing/spending limit. | [Open](../evidence/computer-use-method/ci-pr15-current.json) |

## Next

1. Use the [owned anchor preparation](ACCEPTANCE_ANCHOR.md) for fresh typing/clipboard readiness; fully quit background Claude processes before the host test.
2. Run unconsumed approved cases after preflight. Glow and Codex have exhausted their current supplements; the [second bounded amendment](LIVE_ACCEPTANCE_AMENDMENT_2.md) is a proposal awaiting an actual owner decision. Preserve every failure and finite ledger.
3. Resolve current-source physical-stop proof and complete both REPLAY exports.
4. Verify clean installation/rollback, finish documentation and commits, then open the draft PR and require hosted CI.

The original five supplemental budgets were [approved](../evidence/live-acceptance-continuation/owner-decision.json); glow and Codex have now consumed both attempts. Approval is separate from typing/clipboard idle readiness. Completed compatible live work is reused.

This view is generated from [gap-progress.json](gap-progress.json). It is an inspected checkpoint, not a live test monitor. Refresh it after a verified milestone with `node scripts/render-gap-progress.cjs`.
