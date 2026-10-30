'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { actionSupport, parseAction, LIMITS, KEY_PATTERN } = require('../src/computer/action-contract.cjs');
const { createTraceProvider, ComputerMethod } = require('../src/method/index.cjs');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const window = { id: 'parent', pid: 7, processName: 'fixture', processCreationTime: '100', ownerWindowId: null };

async function fixture(t) {
  let doctor = { ready: true, support: actionSupport() }, calls = 0, captures = 0;
  const controller = {
    async doctor() { return doctor; }, async listWindows() { return { windows: [window] }; },
    async openSession() { return { sessionId: 's', window }; },
    async observe() { return { sessionId: 's', window, observationId: `capture-${++captures}`,
      bounds: { x: 0, y: 0, width: 1, height: 1 }, elements: [],
      screenshot: { data: PNG, mimeType: 'image/png', width: 1, height: 1, sha256: createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex') } }; },
    async act() { calls++; return { outcome: 'completed' }; },
    async closeSession() { return { closed: true, cleanup: 'confirmed' }; }, async close() {},
  };
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller });
  await server.connect(b);
  const client = new Client({ name: 'v1-capabilities-test', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, setDoctor(value) { doctor = value; }, get calls() { return calls; } };
}

test('controller describes declared support independently of native and target readiness', async () => {
  const controller = createComputerController({ backend: { doctor: async () => ({ ready: false, code: 'engine_missing', reason: 'missing' }) }, observationTtlMs: 12345 });
  const result = await controller.doctor();
  assert.deepEqual(result.support, actionSupport(12345));
  assert.deepEqual(result.readiness.native, { ready: false, code: 'engine_missing', reason: 'missing' });
  assert.equal(result.readiness.target.ready, null); assert.equal(typeof result.readiness.target.reason, 'string');
  assert.deepEqual(result.support.engine, { name: 'winapp', version: '0.7.1' });
  assert.equal(result.support.scope, 'trace-wrapper-contract');
  assert.equal(result.support.contractVersion, 1); assert.deepEqual(result.support.limits, LIMITS);
  assert.equal(result.support.stringUnits, 'utf-16-code-units');
  assert.equal(result.support.coordinateSpace, 'window-local-physical-pixels');
  assert.deepEqual(result.support.actions.click.targets, ['point', 'elementId']);
  assert.equal(result.support.actions.click.button, 'left'); assert.equal(result.support.actions.click.count, 1);
  const { deltaX, minDeltaY, maxDeltaY, step, positive, placement } = result.support.actions.scroll;
  assert.deepEqual({ deltaX, minDeltaY, maxDeltaY, step, positive, placement }, { deltaX: 0, minDeltaY: -2400, maxDeltaY: 2400, step: 120, positive: 'down', placement: 'element-center' });
  const { pattern, caseSensitive, normalization } = result.support.actions.press_key;
  assert.deepEqual({ pattern, caseSensitive, normalization }, { pattern: KEY_PATTERN, caseSensitive: false, normalization: { CONTROL: 'ctrl', RETURN: 'enter' } });
  const { defaultDepth, minDepth, maxDepth, ttlMs, requiresReadableUiaRoot } = result.support.observation;
  assert.deepEqual({ defaultDepth, minDepth, maxDepth, ttlMs, requiresReadableUiaRoot }, { defaultDepth: 8, minDepth: 1, maxDepth: 32, ttlMs: 12345, requiresReadableUiaRoot: true });
  await controller.close();
});

test('actual MCP action schema rejects unsupported payloads before controller dispatch', async t => {
  const f = await fixture(t), base = { sessionId: 's', observationId: 'o' };
  const tool = (await f.client.listTools()).tools.find(item => item.name === 'trace_computer_act');
  const keySchema = tool.inputSchema.properties.action.anyOf.find(item => item.properties.type.const === 'press_key').properties.key;
  const pattern = new RegExp(keySchema.pattern);
  for (const key of ['a', 'CONTROL+RETURN', 'eSc']) assert.match(key, pattern);
  for (const key of ['ENTER\n', 'a\r']) {
    assert.doesNotMatch(key, pattern);
    assert.throws(() => parseAction({ type: 'press_key', key }), { code: 'invalid_key' });
  }
  const textSchema = tool.inputSchema.properties.action.anyOf.find(item => item.properties.type.const === 'type_text').properties.text;
  assert.match(textSchema.description, /UTF-16/);
  for (const action of [{ type: 'press_key', key: 'CONTROL+RETURN' }, { type: 'press_key', key: 'eSc' },
    { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: -2400 }, { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 120 },
    { type: 'type_text', text: 'x'.repeat(8192) }, { type: 'type_text', text: '😀'.repeat(4096) }, { type: 'set_value', elementId: 'x', value: '' }]) {
    const result = await f.client.callTool({ name: 'trace_computer_act', arguments: { ...base, action } });
    assert.notEqual(result.isError, true, JSON.stringify(action));
  }
  const before = f.calls;
  for (const action of [{ type: 'press_key', key: 'ENTER\n' }, { type: 'press_key', key: 'a\r' }, { type: 'press_key', key: 'INSERT' }, { type: 'press_key', key: 'WIN+R' },
    { type: 'scroll', x: 0, y: 0, deltaX: 1, deltaY: 120 }, { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 1 },
    { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 0 }, { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 2520 },
    { type: 'click', x: -1, y: 0 }, { type: 'type_text', text: '😀'.repeat(4097) }, { type: 'type_text', text: 'x'.repeat(8193) }]) {
    const result = await f.client.callTool({ name: 'trace_computer_act', arguments: { ...base, action } });
    assert.equal(result.isError, true, JSON.stringify(action));
  }
  assert.equal(f.calls, before);
});

test('adapter reports support, legacy unknown and unsupported contracts separately', async t => {
  const f = await fixture(t);
  const provider = () => createTraceProvider({ client: f.client, app: 'fixture', windowId: 'parent' });
  let p = provider(), result = await p.doctor();
  assert.equal(result.ready, true); assert.deepEqual(result.support, actionSupport());
  assert.deepEqual(p.constraints.nativeSupport, actionSupport());
  assert.equal(result.readiness.configured.ready, true); assert.equal(result.readiness.target.ready, null);
  f.setDoctor({ ready: true, support: actionSupport(12345) }); p = provider(); result = await p.doctor();
  assert.equal(result.support.observation.ttlMs, 12345); assert.equal(p.constraints.observationTtlMs, 12345);
  f.setDoctor({ ready: false, code: 'engine_missing', reason: 'missing', support: actionSupport() });
  p = provider(); result = await p.doctor();
  assert.equal(result.readiness.configured.ready, true); assert.equal(result.readiness.native.ready, false);
  assert.equal(result.readiness.target.ready, null); assert.equal(p.available, false);
  f.setDoctor({ ready: true }); p = provider(); result = await p.doctor();
  assert.equal(result.ready, true); assert.equal(p.available, true);
  assert.deepEqual(p.constraints.nativeSupport, { status: 'unknown', code: 'support-unavailable' });
  for (const support of [{ ...actionSupport(), contractVersion: 2 }, { ...actionSupport(), engine: { name: 'other', version: '1' } },
    { contractVersion: 1, engine: actionSupport().engine },
    { ...actionSupport(), limits: { ...LIMITS, text: 100 } },
    { ...actionSupport(), actions: { ...actionSupport().actions, scroll: { ...actionSupport().actions.scroll, step: 1 } } },
    { ...actionSupport(), observation: { ...actionSupport().observation, ttlMs: -1 } }]) {
    f.setDoctor({ ready: true, support }); p = provider(); result = await p.doctor();
    assert.equal(result.code, 'support-unsupported'); assert.equal(result.ready, false); assert.equal(p.available, false);
  }
  f.setDoctor({ ready: true, support: { ...actionSupport(), extra: true } });
  let failListing = false;
  p = createTraceProvider({ client: f.client, app: 'fixture', windowId: 'parent',
    listTools: async () => { if (failListing) throw new Error('unavailable'); return f.client.listTools(); } });
  assert.equal((await p.doctor()).ready, true);
  failListing = true; result = await p.doctor();
  assert.equal(result.code, 'diagnostics-unavailable'); assert.equal(p.available, false);
  assert.deepEqual(p.constraints.nativeSupport, { status: 'unknown', code: 'support-unavailable' });
});

test('method rejects unsupported wheel before consuming an attempt or capture', async t => {
  const f = await fixture(t), p = createTraceProvider({ client: f.client, app: 'fixture', windowId: 'parent' });
  await p.doctor();
  const m = new ComputerMethod({ providers: [p], verifyStep: async () => 'confirmed', verifyEffect: async () => 'confirmed' });
  m.start({ goalId: 'validation', effects: [{ id: 'effect', checkId: 'saved', steps: [{ id: 'input', checkId: 'input', capability: 'native-action',
    target: { environment: 'local', app: 'fixture', kind: 'app', windowId: 'parent' } }] }] });
  await m.discover('effect', 'input'); await m.observe('effect', 'input');
  await assert.rejects(m.execute('effect', 'input', { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 1 }), { code: 'unsupported_action' });
  assert.equal(m.status().effects[0].steps[0].attempts, 0); assert.equal(f.calls, 0);
  await m.execute('effect', 'input', { type: 'activate' });
  assert.equal(m.status().effects[0].steps[0].attempts, 1); assert.equal(f.calls, 1);
  await m.close();
});
