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
  for (const failClose of [true, false, 'receipt']) {
    const drain = deferred(); let clipboardCalls = 0;
    const f = fixture({ timeoutMs: 15, controller: { ...fixture().raw, close: async () => {
      if (failClose === 'receipt') return { cleanup: 'unknown' };
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
test('admitted calls cancelled before the provider microtask never dispatch', async () => {
  const f = fixture(), work = f.controller.act({});
  const stopped = f.interrupt(scope);
  await assert.rejects(work, { code: 'host_stopped', details: { outcome: 'not_dispatched', cleanup: 'unknown', inputRecoveryRequired: true } });
  assert.equal((await stopped).cleanup, 'confirmed');
  assert.deepEqual(f.calls.map(([name]) => name), ['close']);
});
test('MCP plus real controller drains cancellation and retains independent action uncertainty', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
  const { createComputerController } = require('../src/computer/controller.cjs');
  const { createComputerServer } = require('../src/computer/server.cjs');
  for (const failedRelease of [false, true]) await t.test(`native cleanup failure: ${failedRelease}`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-host-lifecycle-'));
    const entered = deferred(), cancelled = deferred(), drain = deferred(), order = [];
    const window = { id: '101', pid: 42, processName: 'synthetic', title: 'Synthetic target' };
    const backend = {
      doctor: async () => ({ ready: true }), listWindows: async () => [window],
      observe: async ({ screenshotPath }) => {
        await fs.writeFile(screenshotPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
        return { window, bounds: { x: 0, y: 0, width: 1, height: 1 }, elements: [], screenshot: { path: screenshotPath } };
      },
      act: async ({ signal }) => {
        entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        cancelled.resolve(); await drain.promise; order.push('drained'); throw signal.reason;
      },
      close: async () => { assert.ok(order.includes('drained')); order.push('native-close'); }
    };
    const controller = createComputerController({ backend, runtimeDirectory: directory,
      lease: { acquire: async () => {}, assert: async () => {}, release: async () => {
        order.push('release'); if (failedRelease) throw new Error('Synthetic release failed');
      } },
      indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} }
    });
    const lifecycle = createClaudeLifecycle({ controller, scope, timeoutMs: 5000, settleClipboard: async () => {
      assert.deepEqual(order, ['drained', 'native-close', 'release']); order.push('clipboard'); return { cleanup: 'confirmed' };
    } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createComputerServer({ controller: lifecycle.controller }); await server.connect(serverTransport);
    const client = new Client({ name: 'trace-lifecycle-test', version: '1.0.0' }); await client.connect(clientTransport);
    t.after(async () => {
      drain.resolve(); await client.close();
      if (failedRelease) await assert.rejects(server.close(), { code: 'host_cleanup_unknown' }); else await server.close();
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      assert.ok(path.basename(directory).startsWith('trace-host-lifecycle-'));
      await fs.rm(directory, { recursive: true, force: true });
    });
    const call = (name, args = {}) => client.callTool({ name: `trace_computer_${name}`, arguments: args });
    assert.equal((await client.listTools()).tools.length, 6);
    await call('list_windows');
    const { sessionId } = (await call('open_session', { windowId: window.id })).structuredContent;
    const { observationId } = (await call('observe', { sessionId })).structuredContent;
    const action = call('act', { sessionId, observationId, action: { type: 'activate' } }); await entered.promise;
    const stop = lifecycle.hook({ session_id: scope.sessionId, hook_event_name: 'Stop' }); await cancelled.promise;
    assert.equal(lifecycle.status().cleanup, 'pending'); drain.resolve();
    assert.equal((await action).structuredContent.outcome, 'unknown');
    const output = await stop;
    assert.equal(lifecycle.status().cleanup, failedRelease ? 'unknown' : 'confirmed');
    assert.equal(order.includes('clipboard'), !failedRelease);
    assert.equal(!!output.systemMessage, failedRelease);
    const rejected = await call('act', { sessionId, observationId, action: { type: 'activate' } });
    assert.equal(rejected.structuredContent.error.code, 'host_stopped');
    assert.equal(rejected.structuredContent.outcome, 'not_dispatched');
  });
});
