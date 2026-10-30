'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createTraceProvider, TOOL_NAMES } = require('../src/method/index.cjs');

async function connect(t, controller) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller });
  await server.connect(b);
  const client = new Client({ name: 'cleanup-test', version: '1' });
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close().catch(() => {}); });
  return client;
}

const window = { id: 'window', pid: 7, processName: 'fixture', processCreationTime: '100', bounds: { x: 0, y: 0, width: 1, height: 1 } };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function adapterController(closeSession) {
  return {
    async doctor() { return { ready: true }; },
    async listWindows() { return { windows: [window] }; },
    async openSession() { return { sessionId: 'session', window }; },
    async observe() { return { sessionId: 'session', window, observationId: 'capture', bounds: window.bounds, elements: [], screenshot: { data: png, mimeType: 'image/png', width: 1, height: 1, sha256: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex') } }; },
    async act() { return { outcome: 'completed' }; },
    closeSession,
    async close() {},
  };
}
async function openedProvider(t, closeSession, wrap) {
  const client = await connect(t, adapterController(closeSession));
  const p = createTraceProvider({ client, ...(wrap ? { callTool: wrap(client.callTool.bind(client)) } : {}), app: 'fixture', windowId: window.id });
  await p.doctor();
  const [target] = await p.discover({ environment: 'local', app: 'fixture' });
  await p.observe({ target });
  return { p, target };
}

test('adapter confirms only explicit close acknowledgement and never upgrades uncertainty', async t => {
  for (const ack of [{ closed: true, cleanup: 'confirmed' }, { closed: true }, { closed: true, cleanup: 'unknown', recovery: { attempted: true, released: false } }]) {
    let calls = 0;
    const { p, target } = await openedProvider(t, async () => { calls++; return calls === 1 ? ack : { closed: true, cleanup: 'confirmed' }; });
    const expected = ack.cleanup === 'confirmed' ? 'confirmed' : 'unknown';
    const receipt = await p.close({ target });
    assert.equal(receipt.cleanup, expected);
    assert.equal(receipt.applicationClosed, false);
    if (ack.recovery) assert.deepEqual(receipt.recovery, ack.recovery);
    assert.equal((await p.close({ target })).cleanup, expected);
  }
  const cyclic = { closed: true, cleanup: 'confirmed' }; cyclic.self = cyclic;
  const projected = await openedProvider(t, async () => cyclic);
  assert.equal((await projected.p.close({ target: projected.target })).cleanup, 'unknown');
  const thrown = await openedProvider(t, async () => {
    throw Object.assign(new Error('recovery needed'), { code: 'lease_failed', details: { cleanup: 'unknown',
      inputRecoveryRequired: true, recovery: { attempted: true, released: false } } });
  });
  const failed = await thrown.p.close({ target: thrown.target });
  assert.equal(failed.cleanup, 'unknown');
  assert.equal(failed.recovery.released, false);
  const { p, target } = await openedProvider(t, async () => ({ closed: true, cleanup: 'confirmed' }), call => request => {
    if (request.name === TOOL_NAMES[5]) throw new Error('transport failure');
    return call(request);
  });
  assert.equal((await p.close({ target })).cleanup, 'unknown');
  assert.equal((await p.close({ target })).cleanup, 'unknown');
});


test('failed open with uncertain cleanup cannot become a confirmed close', async t => {
  const controller = adapterController(async () => ({ closed: true, cleanup: 'confirmed' }));
  controller.openSession = async () => { throw Object.assign(new Error('open failed'), { code: 'open_failed',
    details: { cleanup: 'unknown', inputRecoveryRequired: true, recovery: { attempted: true, released: false } } }); };
  const client = await connect(t, controller);
  const p = createTraceProvider({ client, app: 'fixture', windowId: window.id });
  await p.doctor();
  const [target] = await p.discover({ environment: 'local', app: 'fixture' });
  await assert.rejects(p.observe({ target }));
  const receipt = await p.close({ target });
  assert.equal(receipt.cleanup, 'unknown');
  assert.equal(receipt.applicationClosed, false);

  const transport = createTraceProvider({ client, app: 'fixture', windowId: window.id,
    callTool: request => { if (request.name === TOOL_NAMES[2]) throw new Error('open transport failed'); return client.callTool(request); } });
  await transport.doctor();
  const [otherTarget] = await transport.discover({ environment: 'local', app: 'fixture' });
  await assert.rejects(transport.observe({ target: otherTarget }));
  assert.equal((await transport.close({ target: otherTarget })).cleanup, 'unknown');

  controller.openSession = async () => ({});
  const malformed = createTraceProvider({ client, app: 'fixture', windowId: window.id });
  await malformed.doctor();
  const [malformedTarget] = await malformed.discover({ environment: 'local', app: 'fixture' });
  await assert.rejects(malformed.observe({ target: malformedTarget }));
  assert.equal((await malformed.close({ target: malformedTarget })).cleanup, 'unknown');
});
