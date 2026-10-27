# Proposed second bounded acceptance amendment

Prepared 22 October 2026. **Proposal only; no approval or live attempt is created by this file.** This extends only the two named cases if the owner directly approves it. [SPEC.md](../SPEC.md) says “A second failure ends that case,” so the previous finite decisions cannot authorize another attempt.

| Existing case | Preserved history | Proposed extra budget | Change to test |
| --- | --- | --- | --- |
| `R31-GLOW-NATIVE` | Original attempts 1–2 and both supplemental attempts, lifetime 3–4, remain unchanged. Lifetime 4 failed the underlying sample freshness check after one actual Sky click; cleanup passed. | One new attempt, then at most one corrective retry: lifetime 5–6. | Publish exact target before the external handshake; obtain genuinely new safe glow pixels after the Sky observation, then immediately validate the checkpoint and make one actual Sky accessibility click. |
| `CODEX-TRACE-SKILL-NATIVE` | Original attempts 1–2 and supplemental lifetime 3–4 remain unchanged. Lifetime 4 proved Unicode and stopped at the stale-result metadata defect. | One new attempt, then at most one corrective retry: lifetime 5–6. | Prove the connected server loaded the corrected controller/server before using the original Unicode, stale rejection and recovery contract. |

## Unchanged result and safety contracts

Keep the same case IDs and the [approved continuation's](LIVE_ACCEPTANCE_CONTINUATION.md) oracles. Glow still requires five counters 0 → 1 → 2, actual physical reference events inside the measured glow and button, exactly one Sky accessibility click and one fresh TRACE coordinate click, unchanged focus, normal close and owned-parent-loss lifecycle checks. Every underlying sample must be at most 60 seconds old at the actual reference click. A new capture must use real new pixels; timestamps cannot refresh an old frame. Safe capture privacy refusal and the maximum three capture-only attempts per planned frame remain. The prospective extra frame is named `glow-reference-fresh`.

Codex still requires the exact original Unicode text once, public and independent focus, consumed-observation rejection with top-level `not_dispatched`, count remaining 0, one fresh counter action to count 1, stable text and exact owned cleanup. No retyping after unknown delivery. Before any claim, pin current source hashes and verify the actual connected MCP process was created after the corrected files were written. Reconnect is required only if that proof fails.

## Ledger and retry conditions

Before running either case, extend and test the canonical per-case bookkeeper to retain the first four claims/results and append lifetime 5 or 6 under the actual new owner decision. Changing directories, decision IDs or agents cannot reset history. Save the exact new decision, this plan's SHA-256, all four prior receipt references/hashes and the tested source/runtime hashes. A proposal or agent-created approval is invalid.

A launched blocked or failed case consumes its attempt. Lifetime 6 requires lifetime 5's exact terminal blocked/failed receipt and a concrete changed precondition or source correction, followed by fresh observations. No automatic replay. A pass ends the case. A second new failure ends the case again. Preserve original outcomes and cleanup separately.

No other budget or oracle changes. Typing quarantine, Claude and clipboard retain their already approved unconsumed supplements and their own readiness conditions. Current-source physical Escape acceptance requires a separate concrete plan and decision; it is not included here. This amendment does not waive GitHub CI or complete a milestone.

## Proposed direct owner decision

> Approve the second bounded amendment for `R31-GLOW-NATIVE` and `CODEX-TRACE-SKILL-NATIVE`: one additional attempt plus at most one corrective retry each, lifetime ordinals 5–6, with the exact preserved history, unchanged oracles and prospective preparation changes above. No other case budgets change.

## Preparation verified so far

The glow driver now persists its target before the external observation request and captures a new measured reference frame afterward. Seventeen focused glow/region checks pass, including selection of the new frame, ordering after the external observation, original-frame hash binding and unchanged rejection of stale samples. This is injected/pure evidence, not another live glow attempt. The Codex product correction retains its existing controller/MCP tests; its full live host workflow remains blocked until the budget and loaded-source requirements are satisfied.
