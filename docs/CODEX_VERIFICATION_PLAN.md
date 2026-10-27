# Codex host verification plan

Prepared 22 October 2026 for `CODEX-TRACE-SKILL-NATIVE` under contract `codex-utf8-host-v1`. This plan is bounded and prospective. **Both approved supplemental attempts are consumed** ([diagnosis](../evidence/live-acceptance-continuation/codex/attempt-2/diagnosis.json)), so nothing here authorizes a live run.

## What changed since the blocked attempt

Attempt 2 proved exact Unicode delivery of `TRACE Codex verified café 日本語` and public plus independent focus. It then stopped because the deliberately stale counter invocation returned `stale_observation` without the required top-level `not_dispatched`.

The product correction is in [the controller](../src/computer/controller.cjs) and [the MCP server](../src/computer/server.cjs). Both stale-observation guards now attach `details.outcome: 'not_dispatched'`. The server keeps it only when the controller rejected; a failure after a successful return stays `unknown`. On 22 October 2026 Claude reviewed this path, including the native backend's `progress.primary` boundary and the method adapter's mapping of both result shapes, and found no defect. 41 controller and MCP tests pass, including actual SDK transport tests for the consumed and expired cases. This is protocol evidence, not a host pass.

## Preconditions before any claim

1. **Owner budget decision.** A new direct owner decision must name this case and a finite budget. The current continuation book accepts only continuation 1 or 2 (`lifetimeAttemptOrdinal` 3 or 4), and the frozen contract proposes no fifth lifetime attempt. So the decision must explicitly amend that, and the book must then be extended with tests before a claim. A new case ID, renamed folder or new agent cannot substitute for this.
2. **Loaded-source proof.** The Codex MCP process connected during attempt 2 still has the pre-fix modules cached. Restart Codex so its `trace-computer` server starts after the corrected files are in place. Retain:
   - hashes of `server.cjs` and `controller.cjs` at the tested commit;
   - the MCP server's configured entry from `.codex/config.toml`, as a sanitized reference with no private paths in shareable evidence;
   - the new server process's creation time, which must be later than both files' last write.

   A reconnected host with an older start time fails this precondition.
3. **Shared preparation** from [the frozen contract](LIVE_ACCEPTANCE_CONTINUATION.md): pinned display, an all-up `keystate`, clear recovery, no active TRACE owner, and verified fixture and runtime manifests.

## Run, if authorized

Follow the contract's Codex section unchanged. The one point that attempt 2 could not reach is the stale step: the consumed pre-typing observation must return `not_dispatched` with `stale_observation`. The independent count must stay 0 and the text must be unchanged. Then come one fresh observation, one counter invocation, count 1 and stable exact text, followed by verified close and exits. Any mojibake, `unknown` outcome or missing metadata stops the run with no retype or replay.

## What a pass would and would not establish

A pass would establish actual Codex host delivery, stale rejection and recovery for this fixture. It would not establish Claude, REPLAY, installation or release acceptance, and it would not change the preserved attempt 1 and 2 receipts.
