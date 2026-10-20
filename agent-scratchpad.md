# Agent handoff

Reviewed 20 October 2026. Start with the [owner-approved plan and review refinements](docs/V0.1-PLAN.md), [acceptance specification](SPEC.md), and [observed verification](docs/VERIFICATION.md). Use [the Claude prompt](docs/CLAUDE-HANDOFF.md) when the owner resumes implementation. Historical receipts retain their original scope and outcomes.

## Owner direction

- On 20 October 2026 the owner resumed implementation through `0.1.0-alpha.3.3` with [the Claude prompt](docs/CLAUDE-HANDOFF.md), including bounded owned-fixture tests. Alpha.4 host/REPLAY work and releases remain out of scope.
- A31-GLOW failed for the second time on 20 October (glow hidden under an activated target; marker never topmost) and its retry budget is exhausted. A31-SKILL passed. See `evidence/0.1.0-alpha.3.1/case-status.json`.
- Claude is the primary implementer after resumption. Later, Codex will perform the Computer Use demonstration with Claude observing and reviewing evidence.
- Use the owner's normal, visible Windows 11 Home account. Preflight and pin the actual single-monitor mode per run; historical 2880×1800 and 1920×1080 receipts both report 144 DPI and their difference is unexplained. Broader display transitions remain deferred beyond v0.1.
- The REPLAY demonstration uses synthetic content and owned profiles. Windows upgrades and background desktop work are outside this plan; no paid TTS is needed.

## Repository starting points

- PR [#7](https://github.com/mogesjohnson/trace-workbench/pull/7) merged as `e20568b`; that is the base of this documentation branch, `docs/v0.1-normal-desktop-plan`.
- Existing glow work is committed and pushed on `feat/desktop-activity-glow` at `a29e373` (two commits), in draft PR [#9](https://github.com/mogesjohnson/trace-workbench/pull/9). Live acceptance is unfinished. This documentation branch contains the plan, not the implementation.
- Merge the plan documentation first, then reconcile its `SPEC.md` changes with the glow branch without dropping the plan or historical evidence.
- Latest noninteractive checkpoint suite: 158 tests, 157 passed, zero failed, one file-symlink privilege skip. Source checks passed for 28 JavaScript files. These checks do not establish live desktop acceptance.
- Earlier 153-pass/one-skip results and four parser-test passes were separate runs; the latest full suite above is a subsequent observation.

## Accepted delivery order

1. `0.1.0-alpha.3.1`: finish visible activity glow and its scoped lifecycle acceptance.
2. `0.1.0-alpha.3.2`: native supervisor, owned-process recovery, and durable quarantine.
3. `0.1.0-alpha.3.3`: exact targeting, real modal workflow, and window-state acceptance.
4. `0.1.0-alpha.4`: separate host acceptance and synthetic native REPLAY workflow.
5. `0.1.0-rc.1`: clean installation, configuration preservation, and rollback.
6. `0.1.0`: requirement-to-receipt review, required CI, verified artifacts, and release.

Use the plan's case definitions and release gates before selecting implementation work.

## Evidence to preserve

- Original Grok alpha.3 evidence contains 22 frames. Its scroll/drag assertions had limitations and its child was modeless; its aggregate pass is historical, scoped evidence.
- Both subsequent full modal review attempts failed and remain retained. There was no third full-harness run.
- The focused guard receipt, `evidence/0.1.0-alpha.3/modal-guard/receipt.json`, passed native and MCP `window_blocked` rejection with unchanged target state and zero input dispatch. It does not complete modal confirmation/recovery.
- Glow attempt one failed: unexpected fixture activations reached five before planned input; planned clicks dispatched were zero. The cause is unresolved and no human attribution was proved.
- Glow attempt two was blocked by the reference executor's reported physical Escape stop before planned input; zero planned clicks were dispatched and owned cleanup completed. It does not verify a TRACE-owned stop. Keep this separate from the first attempt's product/test failure.
- Visible glow, focus preservation on start, and ordinary EOF/close removal were observed. Physical edge click-through and owned-parent-death acceptance remain pending.
- Preserve `evidence/0.1.0-alpha.3.1/glow-attempt-1/receipt.json`, `evidence/0.1.0-alpha.3.1/glow-retry-plan.json`, and `evidence/0.1.0-alpha.3.1/glow-interrupted.json` with their original outcomes.

## Implementation boundaries

- Current desktop ownership is a Node-held lease in `src/computer/lease.cjs`. A Node crash can release that lease while a native input child survives; existing cleanup/unit checks do not prove safe crash handoff.
- The native supervisor and durable quarantine are proposed work, not implemented capabilities. Prove native child exit, balanced input, ownership, and recovery before claiming crash safety.
- Claude's review `988853b2` was checked against `a29e373`: enforced recovery/quarantine covers mouse gestures, not `send-keys`; deep action reinspection is fixed at 8; caught backend rejections return top-level `unknown`; TRACE has no verified physical Escape stop. `A32-*` and `A33-*` now define the fixes. No product fixes were made during the documentation review.
- The shared canonical, Claude, and Grok skill copies were backed up and synchronized to SHA-256 prefix `88063b17`; see `evidence/0.1.0-alpha.3.1/skill-sync.json` for exact hashes. Later repository focus/TTL instruction changes have not been synchronized to those installed copies.
- Resume from a declared case plan with exact target, expected state, bounded retry, independent result checks, and owned cleanup. Preserve failures; a focused regression cannot promote a failed whole workflow.

## REPLAY and release limits

- REPLAY starting point: clean commit `221502e`, version `0.2.0-alpha.5`, with an isolated native smoke profile. Inspect current state before using it.
- Browser preview is not native REPLAY capture/export evidence. Two isolated native instances for the walkthrough still need a feasibility check before the demonstration is promised.
- Keep capture, requested privacy effects, editing, playback, export, and independent artifact inspection in the final workflow; synthetic content keeps the demonstration reviewable.
- PR #10 run [39359739100](https://github.com/mogesjohnson/trace-workbench/actions/runs/39359739100) had zero steps because account payments/spending limits prevented startup; PR #9 run [39359569449](https://github.com/mogesjohnson/trace-workbench/actions/runs/39359569449) has the same block reported by Claude. Inspect current runs before merging; required CI remains a release gate. Account billing needs owner action, not source-code workarounds.
- No TRACE versioned release has been published. Merged code, local checks, host configuration, live acceptance, and a release are distinct states.

## Working contract

- Read `VERSION_CONTROL.md` before branching or committing. Target two or three commits per PR; four is the maximum. Plan reviewable boundaries first and update the README last.
- Commit sanitized source, receipts, and owned synthetic artifacts. Keep personal configuration, raw histories, and executables local; use repository-relative source paths and commands in documentation.
- End each work session with completed case IDs, unresolved IDs, evidence pointers, and the next required action. Keep the owner's implementation hold explicit until it is lifted.
