'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createTraceClient } = require('../src/method/index.cjs');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
async function fixture(t, options = {}) {
  const windows = ['parent', 'dialog'].map(id => ({ id, pid: 7, processName: 'fixture',
    processCreationTime: '100', sessionId: 1, ownerWindowId: id === 'dialog' ? 'parent' : null }));
  const calls = [], control = { cleanup: 'confirmed', outcome: 'completed', failObserve: false };
  let session = null, count = 0, time = 0;
  const controller = {
    async doctor() { return { ready: true }; },
    async listWindows() { return { windows: structuredClone(windows) }; },
    async openSession({ windowId }) {
      assert.equal(session, null); calls.push(['open', windowId]);
      session = { sessionId: `s${++count}`, window: windows.find(w => w.id === windowId) }; return session;
    },
    async observe() {
      calls.push(['observe']); time += control.captureMs || 0;
      if (control.failObserve) throw new Error('capture failed');
      return { ...session, observationId: `o${++count}`, bounds: { x: 0, y: 0, width: 1, height: 1 },
        elements: [], targetState: { ownerWindowId: session.window.ownerWindowId },
        screenshot: { data: PNG, mimeType: 'image/png', width: 1, height: 1,
          sha256: createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex') } };
    },
    async act() { calls.push(['act']); return { outcome: control.outcome }; },
    async closeSession() {
      calls.push(['close']);
      if (control.cleanup === 'confirmed') session = null;
      return { closed: control.cleanup === 'confirmed', cleanup: control.cleanup };
    },
    async close() { session = null; }
  };
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller });
  await server.connect(b);
  const client = new Client({ name: 'trace-client-test', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const api = createTraceClient({ client, clock: () => time, ...options });
  return { api, client, calls, windows, control, tick: value => { time = value; } };
}
const is = code => error => error.code === code;

test('client binds returned selections, validates images and consumes each action observation', async t => {
  const f = await fixture(t), [window] = await f.api.windows();
  await assert.rejects(f.api.bind({ app: 'fixture', window: { ...window } }), is('undiscovered-target'));
  const target = await f.api.bind({ app: 'fixture', window });
  const observation = await target.observe();
  assert.equal(observation.evidence.images[0].data, PNG);
  assert.equal((await target.act({ type: 'activate' })).delivery, 'delivered');
  await assert.rejects(target.act({ type: 'activate' }), is('stale-observation'));
  assert.deepEqual(await f.api.close(), { cleanup: 'confirmed', applicationClosed: false });
  await assert.rejects(target.observe(), is('client-closed'));
});

test('owned-dialog transition confirms parent release and invalidates the old handle', async t => {
  const f = await fixture(t), [parent, dialog] = await f.api.windows();
  const before = await f.api.bind({ app: 'fixture', window: parent }); await before.observe();
  const after = await f.api.bind({ app: 'fixture', window: dialog, ownedDialog: true });
  await assert.rejects(before.observe(), is('stale-target')); await after.observe();
  assert.deepEqual(f.calls.filter(c => c[0] !== 'observe'), [['open', 'parent'], ['close'], ['open', 'dialog']]);
  await f.api.close();
});

test('uncertain close blocks transition, rebinding and new observations without another open', async t => {
  const f = await fixture(t), [parent, dialog] = await f.api.windows();
  const before = await f.api.bind({ app: 'fixture', window: parent }); await before.observe();
  f.control.cleanup = 'unknown';
  await assert.rejects(f.api.bind({ app: 'fixture', window: dialog }), is('transition-cleanup-unknown'));
  await assert.rejects(f.api.rebind(before), is('input_recovery_required'));
  await assert.rejects(before.observe(), is('stale-target'));
  assert.equal(f.calls.filter(c => c[0] === 'open').length, 1);
  assert.equal((await f.api.close()).cleanup, 'unknown');
});

test('binding recovery and serialized restore require fresh exact lifetime and owner', async t => {
  const f = await fixture(t), [window] = await f.api.windows();
  const before = await f.api.bind({ app: 'fixture', window }); await before.observe();
  const after = await f.api.rebind(before);
  await assert.rejects(before.act({ type: 'activate' }), is('stale-target'));
  await assert.rejects(after.act({ type: 'activate' }), is('stale-observation'));
  await f.api.close();
  const restored = createTraceClient({ client: f.client });
  const handle = await restored.restore({ app: 'fixture', window: JSON.parse(JSON.stringify(window)) });
  await handle.observe(); await restored.close();
  f.windows[0].processCreationTime = '101';
  const replaced = createTraceClient({ client: f.client });
  await assert.rejects(replaced.restore({ app: 'fixture', window }), is('target-changed'));
  await replaced.close();
});

test('wrong owner or replaced parent blocks a dialog transition before releasing the old session', async t => {
  const f = await fixture(t), [parent, dialog] = await f.api.windows();
  const before = await f.api.bind({ app: 'fixture', window: parent }); await before.observe();
  f.windows[0].processCreationTime = '101';
  await assert.rejects(f.api.bind({ app: 'fixture', window: dialog, ownedDialog: true }), is('ownership-unverified'));
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 0);
  await f.api.close();
});

test('capture time counts toward local expiry; failed refresh and invalid actions never replay', async t => {
  const f = await fixture(t, { ttlMs: 100 }), [window] = await f.api.windows();
  const handle = await f.api.bind({ app: 'fixture', window });
  f.control.captureMs = 101; await handle.observe();
  await assert.rejects(handle.act({ type: 'activate' }), is('stale-observation'));
  f.control.captureMs = 0; await handle.observe();
  await assert.rejects(handle.act({ type: 'activate', extra: true }), is('invalid_action'));
  f.control.outcome = 'unknown'; assert.equal((await handle.act({ type: 'activate' })).delivery, 'unknown');
  await assert.rejects(handle.act({ type: 'activate' }), is('stale-observation'));
  await handle.observe(); f.control.failObserve = true;
  await assert.rejects(handle.observe());
  await assert.rejects(handle.act({ type: 'activate' }), is('stale-observation'));
  assert.equal(f.calls.filter(c => c[0] === 'act').length, 1); await f.api.close();
});

test('unreadable post-dispatch response preserves uncertainty and blocks a new action', async t => {
  const f = await fixture(t);
  const api = createTraceClient({ listTools: f.client.listTools.bind(f.client), callTool: async request => {
    const result = await f.client.callTool(request);
    return request.name === 'trace_computer_act' ? {} : result;
  } });
  const [window] = await api.windows(), handle = await api.bind({ app: 'fixture', window });
  await handle.observe(); const receipt = await handle.act({ type: 'activate' });
  assert.equal(receipt.delivery, 'unknown'); assert.equal(receipt.cleanup, 'unknown');
  await assert.rejects(handle.observe(), is('stale-target')); await api.close();
  assert.equal(f.calls.filter(c => c[0] === 'act').length, 1);
});

test('concurrent calls are rejected instead of queued for later execution', async t => {
  const f = await fixture(t);
  let unblock;
  const api = createTraceClient({ callTool: async request => {
    await new Promise(resolve => { unblock = resolve; }); return f.client.callTool(request);
  } });
  const pending = api.windows();
  await assert.rejects(api.windows(), is('busy')); unblock(); await pending; await api.close();
});
