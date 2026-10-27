# Background finish work

Updated 23 October 2026. The owner resumed **background-only** work. No screen capture, window activation, mouse, keyboard, clipboard access or live acceptance is authorized by that instruction. The full goal remains open at 18/22 scoped checkpoints (82%).

**27 October continuation:** the owner initially offered desktop readiness, then said there was no 20-minute window before any UI launch. Desktop execution remains deferred; no new attempt or input was claimed. Background review completed the [eight-invariant reconciliation](PRODUCTION_OWNER_RECONCILIATION.md), and the README now reuses completed host, clipboard and stop results. The prior final-head CI passed; later documentation archives retain their own check scope. No merge, version bump or release is authorized.

## Changes prepared without desktop control

- Added a pure intended-target assertion for the owner's [criterion choice](../evidence/live-acceptance-continuation/owner-glow-target-hit-decision.json). It checks the actual physical event, half-open button bounds, all five exact counters, released left input and checkpoint time. The historical full driver still uses its original exact-center assertion. A future bounded supplement can reuse the new assertion without changing previous receipts.
- Added an [offline verifier](../scripts/review-glow-target-hit.cjs) that pins the decision, original receipt and sanitized diagnosis by SHA-256. Its [result](../evidence/live-acceptance-continuation/glow-target-hit-verification.json) verifies only the target-hit subproof. The original failed receipt remains byte-identical. Ordinary-close and parent-loss phases remain missing; [the compatibility review](../evidence/live-acceptance-continuation/glow-target-hit-review.json) explains why older lifecycle evidence cannot transfer.
- Fixed the REPLAY acceptance predicate to reject a paused position at or beyond the selected clip's end. This prevents the observed automatic-end false positive. It is a necessary guard, not proof that a user action caused a pause. The completed export/media/cleanup evidence remains reusable; its partial audit stays unchanged.
- Updated the progress generator to stop requesting completed Escape checks or an entire REPLAY rerun. Physical-stop, Codex, Claude, clipboard and compatible recovery passes remain verified.

## Background validation

Six selected offline checks passed: the target-hit assertion's success and rejection boundaries, the historical glow oracle, and the affected REPLAY controls/export-precondition checks. These use injected state and do not open an application. The pinned retained-evidence verifier also passed its narrow target-hit review.

[The working requirement-to-evidence checklist](REQUIREMENT_EVIDENCE_REVIEW.md) maps every product requirement and named milestone gate without promoting missing proof. The specification recognizes the already-approved production-owner replacement; the old failed feasibility probe does not require another approval or rerun. [The completed invariant reconciliation](PRODUCTION_OWNER_RECONCILIATION.md) retains eight scoped rows and their metadata limits; full glow lifecycle remains separate.

A separate Claude Code review completed using the newly signed-in isolated account, Sonnet at medium effort, no tools or MCP servers, a $0.35 invocation cap and a two-minute process limit. It reported no blocking findings in one turn and $0.042504 of model usage. This is a source review rather than another Claude desktop acceptance session. The review's timestamp limitation is explicit in the offline verifier: reference completion supplies a lower bound, not a recovered TRACE dispatch-start checkpoint. Authentication and raw model output stay local.

## Desktop work prepared for a later decision

These are proposals, not execution authorization or extensions to exhausted attempt budgets. Earlier failures, frozen approvals and canonical ledgers remain unchanged. No case is restarted under a new name to bypass its limit.

| Missing proof | Proposed narrow supplement | Existing work to reuse |
| --- | --- | --- |
| Glow ordinary close and owned-parent loss | Under a direct bounded extension, open the exact synthetic fixture and a production session; record visible glow/focus/ownership. Close normally and measure absence plus exact helper exit within five seconds. Repeat session setup for abrupt owned Node loss; independently measure absence, exact Node/supervisor/marker exit, released input, clear recovery and free lease. No click is needed. | Retained reference click and owner-selected TRACE target-hit subproof; current-source stop passes. Do not repeat the two clicks or physical Escape. |
| A causally demonstrated REPLAY pause | Under a direct bounded extension, use a dedicated synthetic preview of at least 60 seconds, with enough measured remaining time for observation and input. Confirm the same project is playing before one fresh TRACE pause action. Retain native action metadata and independent before/after preview state; require a stable paused position strictly before the end and an unchanged saved recipe. Unknown delivery ends the attempt. | The completed synthetic recording, source review, edits, two exports, playback and media/cleanup checks. Do not record or export the whole workflow again. |

For each proposal, declare the exact source/display/target, timing, allowed attempts and cleanup before any UI launch. A changed criterion alone grants no attempt. Background-only work cannot establish these visible desktop results.

## Delivery order

1. Review and upload the background preparation as a focused draft PR depending on PR 24, which already has four commits.
2. Use its hosted CI for source, protocol and exact-archive checks. Do not repeat the full suite locally or treat the CI archive as a published release.
3. When the owner resumes desktop work, obtain only the still-required bounded case decisions. Run the narrow missing proof once under those caps.
4. Reconcile the complete requirement-to-evidence checklist. Build and verify the final release artifact only when its source/version and release scope are settled.

No merge, version bump or release publication follows from this preparation.
