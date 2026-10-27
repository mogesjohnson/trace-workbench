# TRACE gap-closure plan and progress

Updated 2026-10-27. **Goal active. 20/22 checkpoints verified (91% of this checklist).**

[Open the visual dashboard](GAP_CLOSURE_PROGRESS.html) · [Detailed status](GAP_CLOSURE_STATUS.md) · [Acceptance specification](../SPEC.md)

Each row is one declared checkpoint. Counts measure completed checkpoints, not time, effort, feature parity or release readiness. A scoped pass covers only the behavior named in that row. This percentage is not a completion claim for the full goal.

**Current work:** Both missing live effects passed on 27 October: glow ordinary-close/owner-loss cleanup and a causal REPLAY pause. Receipts and four approved proof PNGs are uploaded in PRs 32–33. Desktop work is finished. Final documentation and exact versioned distribution remain; 20/22 checkpoints verified (91%).

| Verified at stated scope | In progress | To do | Blocked |
| --- | --- | --- | --- |
| 20 | 1 | 1 | 0 |

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
| 12. REPLAY two-window recording setup | Demonstrate | Verified at stated scope | Actual two-window recording feasibility passed; the full editing/export workflow and missing pause supplement are now retained in checkpoint 19. | [Open](../evidence/computer-use-method/replay-feasibility/verification.json) |
| 13. Glow clicks and complete lifecycle | Prove | Verified at stated scope | Authorized lifetime 9 passed with zero input: measured glow absence in 748 ms after ordinary close and 1,422 ms after owner loss. Compatible retained target-hit proof completes the declared scope. Original lifetime 8 failure stays unchanged. | [Open](../evidence/live-acceptance-continuation/glow-lifecycle-9/receipt.json) |
| 14. Typing quarantine acknowledgement | Prove | Verified at stated scope | Supplemental attempt 1 passed: exact abc, independent release, persistent quarantine/restart blocking, verified recovery and exactly one pinned-engine follow-up. Both fixtures closed. | [Open](../evidence/live-acceptance-continuation/typing-supplemental-1/verification.json) |
| 15. Current-source physical-stop relevance | Prove | Verified at stated scope | Mouse lifetime 3 and keyboard lifetime 3 passed actual physical Escape with independent release/exit, no later input admission and exactly one follow-up. Injected Escape lifetime 2 passed without being misclassified as physical. Native source hashes match; no repeat needed. | [Open](../evidence/live-acceptance-continuation/finish-stop-verification.json) |
| 16. Complete real Codex workflow | Demonstrate | Verified at stated scope | Approved lifetime 5 passed through the actual reconnected Codex MCP: installed skill discovery, exact Unicode once, consumed-observation not_dispatched with count 0, one fresh counter action to 1, stable text, exact helper/fixture exits and persistent host preserved. No corrective retry needed. | [Open](../evidence/live-acceptance-continuation/codex-amendment-2-attempt-1/receipt.json) |
| 17. Complete real Claude workflow | Demonstrate | Verified at stated scope | Corrective lifetime 4 passed on Claude 2.1.309 with explicitly isolated state: both Skills, five received PNGs, exact text/count 1, stale not_dispatched, fresh recovery, all real-settings intervals preserved, installed bundles/source unchanged and exact cleanup. Temporary sign-in removed. Guarded isolated-host scope; no semantic-image or REA-analysis claim. | [Open](../evidence/live-acceptance-continuation/claude-supplemental-2/receipt.json) |
| 18. Unicode clipboard paste and restoration | Demonstrate | Verified at stated scope | Approved corrective supplement passed: public/independent fresh focus, one completed Unicode paste, exact target text and unchanged count, guarded restoration plus fresh supported-byte comparison, exact native/fixture exits and private-artifact cleanup. Ordinary anchor explicitly closed. | [Open](../evidence/live-acceptance-continuation/clipboard-supplemental-2/receipt.json) |
| 19. Full REPLAY editing and two exports | Demonstrate | Verified at stated scope | Retained recording, edits and two exports plus authorized lifetime 5 causal pause: exactly one native click, stable paused position 34.283217 of 180.066667 seconds, fresh images/journal and verified cleanup. Original partial audit stays unchanged. | [Open](../evidence/live-acceptance-continuation/replay-pause-5/receipt.json) |
| 20. Clean archive installation and rollback | Deliver | In progress | Current-source d981e06 passed Windows CI and exact-archive installation/rollback. A final versioned release archive and checksum remain separate gates. | [Open](ARCHIVE_INSTALL.md) |
| 21. Final documentation and reviewable commits | Deliver | To do | All requirements and eight owner invariants are mapped. Final documentation, reviewed integration and versioned delivery are being reconciled against the completed live results. | [Open](../VERSION_CONTROL.md) |
| 22. Draft PR and required hosted CI | Deliver | Verified at stated scope | PR 31 head d981e06 passed required CI run 40580446444, including both MCP paths and exact-archive installation/rollback. Final release source still needs its own required gate. | [Open](../evidence/computer-use-method/public-ci-parallel-fixes.json) |

## Next

1. Complete final requirement disposition and user guidance using the published glow and pause receipts. Preserve original failures and mixed-scope recovery limits.
2. Prepare the final versioned source/setup archive, acceptance manifest and checksums; verify its exact bytes through required hosted CI.
3. Present the concrete integration/release candidate for final owner approval. No merge, tag or publication is authorized yet.

Public hosted CI and clean-runner archive verification passed at the recorded checkpoint; final-source and final-archive gates remain explicit. Approval is separate from desktop readiness and does not change earlier evidence.

This view is generated from [gap-progress.json](gap-progress.json). It is an inspected checkpoint, not a live test monitor. Refresh it after a verified milestone with `node scripts/render-gap-progress.cjs`.
