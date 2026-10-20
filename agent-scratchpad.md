# Agent handoff

Reviewed 20 October 2026. Start with the [owner-approved plan and review refinements](docs/V0.1-PLAN.md), [acceptance specification](SPEC.md), and [observed verification](docs/VERIFICATION.md). Use [the Claude prompt](docs/CLAUDE-HANDOFF.md) when the owner resumes implementation. Historical receipts retain their original scope and outcomes.

## Owner direction

- On 20 October 2026 the owner resumed implementation through `0.1.0-alpha.3.3` with [the Claude prompt](docs/CLAUDE-HANDOFF.md), including bounded owned-fixture tests. Alpha.4 host/REPLAY work and releases remain out of scope.
- Implementation through alpha.3.3 ran on 20 October; see **Session result** below. Further implementation needs the owner decisions listed there.
- Claude is the primary implementer after resumption. Later, Codex will perform the Computer Use demonstration with Claude observing and reviewing evidence.
- Use the owner's normal, visible Windows 11 Home account. Preflight and pin the actual single-monitor mode per run; historical 2880×1800 and 1920×1080 receipts both report 144 DPI and their difference is unexplained. Broader display transitions remain deferred beyond v0.1.
- The REPLAY demonstration uses synthetic content and owned profiles. Windows upgrades and background desktop work are outside this plan; no paid TTS is needed.

## Session result (20 October 2026)

Stacked draft PRs (hosted CI cannot start because of account billing; nothing was merged):
[#10](https://github.com/mogesjohnson/trace-workbench/pull/10) plan ← [#9](https://github.com/mogesjohnson/trace-workbench/pull/9) alpha.3.1 ← [#11](https://github.com/mogesjohnson/trace-workbench/pull/11) glow topmost fix ← [#12](https://github.com/mogesjohnson/trace-workbench/pull/12) alpha.3.2 probe (blocked). The alpha.3.3 PR stacks on #12 (the probe adds no runtime code).

| Case | Status | Evidence |
| --- | --- | --- |
| A31-GLOW | fail ×2, budget exhausted; topmost fix verified by a focused regression | `evidence/0.1.0-alpha.3.1/case-status.json` |
| A31-SKILL | pass | `evidence/0.1.0-alpha.3.1/skill-sync-2.json` |
| A32-PROBE | fail ×2: phase blocked; A32-OWNER/RECOVERY/QUARANTINE/STOP not implemented | `evidence/0.1.0-alpha.3.2/probe-status.json` |
| A33-DEPTH, A33-OUTCOME | pass | `evidence/0.1.0-alpha.3.3/case-status.json` |
| A3-DIALOG | pass (focused continuation) | same |
| A3-WINDOW | fail ×2, budget exhausted; bridge restore fix verified by a focused regression | same |

Fixed and verified:
- The glow is now topmost (`TopMost=true`).
- Bridge activation restores a foreground minimized window.
- Observation waits for restored geometry to settle.
- Depth is retained server-side and reused for the action.
- `not_dispatched` is reported for proven pre-dispatch rejection.
- Installed skill copies are synchronized to `e7d12ba7` with backups.

Latest checks: `npm test` ran 172 tests, 171 passed with one privilege skip; `npm run check` passed.

Next required actions (owner):
- Decide replacement cases for A31-GLOW and A3-WINDOW.
- Accept the probe evidence, or authorize a focused typing-delivery probe, to unblock alpha.3.2. That probe must check text-box focus first. Spawn the supervisor detached and give its lease pipe unlimited instances.
- Schedule the Codex reference-click run.
- Fix hosted CI billing.

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
- Claude's review `988853b2` findings: alpha.3.3 fixed depth reinspection and pre-dispatch outcomes. Keyboard balancing, durable quarantine and the TRACE-owned physical Escape stop remain unimplemented while alpha.3.2 is blocked.
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
