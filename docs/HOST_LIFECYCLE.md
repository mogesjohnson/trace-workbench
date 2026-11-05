# Claude Agent SDK lifecycle adapter (development item 18)

`createClaudeLifecycle` from `src/method/index.cjs` binds one dedicated TRACE
controller to one trusted Claude Agent SDK query/turn generation. Stop and
SubagentStop callbacks stop admission immediately, abort in-flight requests, and
await controller shutdown plus all admitted requests. Duplicate events share one
completion. Existing tool schemas and native recovery fallbacks are unchanged.

```javascript
const { createClaudeLifecycle } = require('../src/method/index.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { createComputerServer } = require('../src/computer/server.cjs');
const scope = { sessionId: verifiedClaudeSessionId, agentId: 'main',
  turnId: hostTurnId, generation: uniqueTurnGeneration };
const lifecycle = createClaudeLifecycle({
  controller: createComputerController(), scope, timeoutMs: 1000
});
const server = createComputerServer({ controller: lifecycle.controller });
// Connect this dedicated server through the host's actual MCP transport.
// Merge lifecycle.hooks into this query's SDK options, preserving other hooks:
// SDK options.hooks.Stop = [...existingStopHooks, ...lifecycle.hooks.Stop];
// SDK options.hooks.SubagentStop = [...existingChildStopHooks,
//   ...lifecycle.hooks.SubagentStop];
// On user interruption, BEFORE awaiting query shutdown:
const receipt = await lifecycle.interrupt(scope);
// Require receipt.cleanup === 'confirmed'; unknown requires recovery.
// Always close the owned server/transport in finally, including SDK errors.
await server.close();
```

This is host integration code, not an automatically installed hook or executable
example. Supply real session/turn identities and transport; import `query` from
the host's installed SDK if needed. TRACE adds no SDK dependency, model call,
personal settings change or global hook. Use `agentId` equal to the exact SDK
`agent_id` for a child; `main` identifies a main-agent binding.

The [official SDK hook contract](https://code.claude.com/docs/en/agent-sdk/hooks)
was reviewed on 1 November 2026. It provides session and agent fields but no turn
generation on Stop/SubagentStop. Register the returned callback closures only on
their original query; create a new controller/server/adapter for another turn.
Never forward untagged global events to the newest adapter. No global session
lookup or child-to-parent cancellation exists. Explicit `interrupt(scope)` checks
all four fields; stale scopes return `{matched:false}`. Stop is not treated as a
guaranteed user-interrupt event. The host must invoke interrupt from its actual
cancel/error path. SessionEnd and other events are deliberately unsupported.

Cleanup waits at most `timeoutMs` (1–10000, default 1000) while the event loop runs.
Controller failure, missing acknowledgment, pending requests or timeout retain
`cleanup:'unknown', inputRecoveryRequired:true`. Late completion never upgrades
that result. New requests remain blocked; repeated close throws a sanitized error.
The SDK hook returns an empty object on confirmed cleanup, or a fixed systemMessage
on uncertainty. It does not block Claude's stop or claim the hook will be delivered.
Do not discard unknown cleanup by constructing another adapter or replaying input.

If the host has a pending clipboard transaction, supply `settleClipboard`.
After controller/request drain, this trusted callback must independently verify
input quiescence, then attempt guarded restoration and return
`{cleanup:'confirmed'}`. Missing confirmation or exceptions retain unknown cleanup.
A timeout before callback entry prevents a later restoration attempt. A callback
already running must enforce its own bounded recovery and retain transaction state;
JavaScript cannot revoke a restoration it has started. This adapter neither sees
clipboard tokens nor invents OS release proof. Omit the callback only when this
turn has no pending clipboard transaction. Attached applications remain open.

Run `node --test tests/claude-lifecycle.test.cjs`. Injected callbacks cover routing,
reentrant/duplicate stop, stale scopes, predispatch cancellation, bounded failure
and clipboard sequencing. Actual MCP plus the production controller exercise
in-flight abort/drain, action outcome unknown despite confirmed cleanup, and failed
lease release remaining unknown. The backend is synthetic: no desktop or clipboard
input occurs. This establishes callback/controller integration, not live Claude
event delivery, paid model acceptance, general host compatibility, or new native
physical-release/crash guarantees. Compatible prior native acceptance is reused.

The abort reason deliberately carries no not-dispatched assertion: an active
backend may throw that reason after input. Only admission rejection before calling
the controller carries that proof; the production-controller integration verifies
this distinction by throwing the exact abort reason after synthetic dispatch.
