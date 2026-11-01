'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeLifecycle } = require('../src/method/index.cjs');
const scope = { sessionId: 'host-session', agentId: 'main', turnId: 'turn-1', generation: 'generation-1' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const calls = [];
  const controller = Object.fromEntries(['doctor', 'listWindows', 'openSession', 'observe', 'act', 'closeSession', 'close']
    .map(method => [method, async (...args) => { calls.push([method, ...args]); }]));
  const lifecycle = createClaudeLifecycle({ controller, scope, ...options });
  return { ...lifecycle, calls, raw: controller };
}
test('host binding rejects incomplete scopes and forwards both signal signatures', async () => {
  assert.throws(() => fixture({ scope: { ...scope, generation: '' } }), TypeError);
  const f = fixture(), abort = new AbortController();
  await f.controller.doctor({ signal: abort.signal });
  await f.controller.act({ sessionId: 'native' }, { signal: abort.signal });
  assert.equal(f.calls[0][1].signal.aborted, false);
  abort.abort(); assert.equal(f.calls[1][2].signal.aborted, true);
  await f.controller.close();
});
test('unrelated hooks and stale scope cannot stop a current generation', async () => {
  const f = fixture();
  for (const input of [
    { session_id: 'other', hook_event_name: 'Stop' },
    { session_id: scope.sessionId, hook_event_name: 'Stop', agent_id: 'child' },
    { session_id: scope.sessionId, hook_event_name: 'SubagentStop', agent_id: 'main' },
    { session_id: scope.sessionId, hook_event_name: 'SessionEnd' }
  ]) assert.deepEqual(await f.hook(input), {});
  for (const key of Object.keys(scope)) assert.deepEqual(await f.interrupt({ ...scope, [key]: 'old' }), { matched: false });
  assert.equal(f.status().stopped, false); assert.equal(f.calls.length, 0);
  await f.controller.close();
});
test('duplicates join cleanup; admission stops synchronously and pending work drains', async () => {
  const drain = deferred(), began = deferred(); let closes = 0;
  const f = fixture({ controller: {
    ...fixture().raw,
    act: (_, { signal }) => { began.resolve(); return new Promise(resolve => signal.addEventListener('abort', () => drain.promise.then(resolve), { once: true })); },
    close: async () => { closes++; }
  } });
  const work = f.controller.act({}); await began.promise;
  const first = f.interrupt(scope); assert.equal(first, f.interrupt(scope));
  await assert.rejects(f.controller.observe({}), { code: 'host_stopped' });
  let finished = false; first.then(() => { finished = true; });
  await new Promise(setImmediate); assert.equal(finished, false);
  drain.resolve(); await work;
  assert.equal((await first).cleanup, 'confirmed'); assert.equal(closes, 1);
});
test('stop filters exact child and old callback closures never stop new controllers', async () => {
  const child = fixture({ scope: { ...scope, agentId: 'child' } }), next = fixture({ scope: { ...scope, generation: 'next' } });
  await child.hooks.SubagentStop[0].hooks[0]({ session_id: scope.sessionId, agent_id: 'child', hook_event_name: 'SubagentStop' });
  assert.equal(child.status().cleanup, 'confirmed'); assert.equal(next.status().stopped, false);
  assert.deepEqual(await next.hooks.Stop[0].hooks[0]({ session_id: scope.sessionId, hook_event_name: 'Stop' }), {});
  assert.equal(next.status().cleanup, 'confirmed');
});
test('failure and timeout stay unknown; no late clipboard finalization or error leakage', async () => {
  for (const failClose of [true, false]) {
    const drain = deferred(); let clipboardCalls = 0;
    const f = fixture({ timeoutMs: 15, controller: { ...fixture().raw, close: async () => {
      if (failClose) throw new Error('PRIVATE'); await drain.promise;
    } }, settleClipboard: async () => { clipboardCalls++; return { cleanup: 'confirmed' }; } });
    const output = await f.hook({ session_id: scope.sessionId, hook_event_name: 'Stop' });
    assert.match(output.systemMessage, /unknown/); assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
    drain.resolve(); await new Promise(setImmediate);
    assert.equal((await f.interrupt(scope)).cleanup, 'unknown'); assert.equal(clipboardCalls, 0);
    await assert.rejects(f.controller.close(), { code: 'host_cleanup_unknown' });
  }
});
test('clipboard cleanup waits for drain and requires explicit confirmation', async () => {
  for (const cleanup of ['confirmed', 'unknown', undefined]) {
    const order = [], f = fixture({ controller: { ...fixture().raw, close: async () => { order.push('drained'); } },
      settleClipboard: async () => { order.push('clipboard'); return { cleanup }; } });
    assert.equal((await f.interrupt(scope)).cleanup, cleanup === 'confirmed' ? 'confirmed' : 'unknown');
    assert.deepEqual(order, ['drained', 'clipboard']);
  }
});
test('reentrant cancellation listeners share one completion and one close', async () => {
  let nested;
  const f = fixture({ controller: { ...fixture().raw, act: async (_, { signal }) => {
    signal.addEventListener('abort', () => { nested = f.interrupt(scope); }, { once: true });
  } } });
  await f.controller.act({});
  const stopped = f.interrupt(scope);
  assert.equal(nested, stopped); assert.equal((await stopped).cleanup, 'confirmed');
});
