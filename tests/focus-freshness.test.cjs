'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { validateAction, parseAction } = require('../src/computer/action-contract.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { ComputerMethod } = require('../src/method/index.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const action = { type: 'type_text', text: 'hello', expectedFocusElementId: 'editor' };
const rect = { x: 0, y: 0, width: 100, height: 100 };
const element = id => ({ id, enabled: true, name: id, controlType: 'Edit', bounds: rect });
const snapshot = () => ({ window: { id: '123', pid: 7, bounds: rect }, bounds: rect,
  uiaBounds: rect, frameBounds: rect, nativeWindowBounds: rect,
  focused: { available: true, hasFocus: true, elementId: 'editor' }, elements: [element('editor'), element('other')] });
const is = code => error => error.code === code;

test('intended typing focus must identify one enabled currently focused observed control', () => {
  assert.deepEqual(validateAction(action, snapshot()), action);
  for (const focused of [{ available: false }, { available: true, hasFocus: false },
    { available: true, hasFocus: true, elementId: 'other' }]) {
    assert.throws(() => validateAction(action, { ...snapshot(), focused }), is('focus_changed'));
  }
  assert.throws(() => validateAction(action, { ...snapshot(), elements: [] }), is('focus_changed'));
  assert.throws(() => parseAction({ ...action, expectedFocusElementId: '\0' }), is('invalid_action'));
  assert.throws(() => parseAction({ type: 'press_key', key: 'TAB', expectedFocusElementId: 'editor' }), is('invalid_action'));
  assert.deepEqual(parseAction({ type: 'press_key', key: 'TAB' }), { type: 'press_key', key: 'TAB' });
});

test('live MCP schema accepts optional typing focus and preserves legacy typing', async t => {
  const seen = [], controller = Object.fromEntries(['doctor', 'listWindows', 'openSession', 'observe', 'closeSession', 'close']
    .map(name => [name, async () => ({})]));
  controller.act = async request => { seen.push(request.action); return { outcome: 'not_dispatched' }; };
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller }); await server.connect(b);
  const client = new Client({ name: 'focus-schema-test', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools({})).tools;
  assert.equal(tools.length, 6);
  assert.match(JSON.stringify(tools.find(tool => tool.name === 'trace_computer_act').inputSchema), /expectedFocusElementId/);
  for (const payload of [action, { type: 'type_text', text: 'legacy' }]) {
    const result = await client.callTool({ name: 'trace_computer_act', arguments: { sessionId: 's', observationId: 'o', action: payload } });
    assert.notEqual(result.isError, true);
  }
  assert.deepEqual(seen, [action, { type: 'type_text', text: 'legacy' }]);
});

test('backend rechecks intended focus after activation and never types on changed focus', async () => {
  const backend = new WinappBackend({ supervisor: null, platform: 'win32', run: async () => { throw new Error('No native execution'); } });
  const calls = [], before = snapshot(); let focus = 'editor';
  backend.identity = async () => before.window;
  backend.inspect = async () => ({ ...before, elements: before.elements.map(item => ({ ...item })) });
  backend.bridge = async verb => { calls.push(verb); return { enabled: true, foreground: true, frameBounds: rect, windowBounds: rect }; };
  backend.focused = async () => ({ available: true, hasFocus: true, elementId: focus });
  backend.command = async verb => { calls.push(verb); return { hwnd: 123 }; };
  const dispatch = () => backend.dispatch({ window: before.window, observation: before, action }, { primary: false, preparation: [] });
  assert.equal((await dispatch()).performed, true); assert.equal(calls.filter(c => c === 'send-keys').length, 1);
  calls.length = 0; focus = 'other'; await assert.rejects(dispatch(), is('focus_changed'));
  assert.ok(calls.includes('activate')); assert.ok(!calls.includes('send-keys'));
  calls.length = 0; before.focused = { available: false }; await assert.rejects(dispatch(), is('focus_changed'));
  assert.ok(!calls.includes('activate')); assert.ok(!calls.includes('send-keys'));
});

test('controller rejects mismatched intended focus without consuming the current observation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-focus-policy-'));
  const window = { id: '123', pid: 7, processName: 'fixture', bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const dispatched = [], backend = {
    listWindows: async () => [window],
    async observe({ screenshotPath }) {
      if (screenshotPath) await fs.writeFile(screenshotPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
      return { window, bounds: window.bounds, elements: [element('editor')], focused: snapshot().focused, screenshot: { path: screenshotPath } };
    },
    act: async request => { dispatched.push(request.action); return { performed: true }; }
  };
  const controller = createComputerController({ backend, runtimeDirectory: directory, captureKeepLast: 0,
    lease: { acquire: async () => {}, assert: async () => {}, release: async () => {} },
    indicator: { signal: new AbortController().signal, start: async () => ({}), stop: async () => {}, assertActive() {} } });
  t.after(async () => {
    await controller.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('trace-focus-policy-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await controller.listWindows(); const session = await controller.openSession({ windowId: window.id });
  const before = await controller.observe(session), request = { sessionId: session.sessionId, observationId: before.observationId };
  await assert.rejects(controller.act({ ...request, action: { ...action, expectedFocusElementId: 'other' } }), is('focus_changed'));
  assert.equal(dispatched.length, 0);
  assert.equal((await controller.act({ ...request, action })).outcome, 'completed');
  assert.equal(dispatched.length, 1);
  await assert.rejects(controller.act({ ...request, action }), is('stale_observation'));
});

function methodFixture({ policy = 100, nativeTtl = 1000, captureMs = 0, validationMs = 0, nativeTtlAfterValidation } = {}) {
  let time = 0, actions = 0, captures = 0;
  const target = { environment: 'local', app: 'fixture', kind: 'app', windowId: '123' };
  const provider = { id: 'p', channel: 'desktop', available: true, apps: ['fixture'], environments: ['local'],
    capabilities: ['native-action'], constraints: { observationTtlMs: nativeTtl },
    discover: async () => [target],
    observe: async () => { time += captureMs; return { id: `o${++captures}`, target, evidenceKey: `e${captures}`, evidence: {} }; },
    validateAction: async ({ payload }) => {
      time += validationMs;
      if (nativeTtlAfterValidation !== undefined) provider.constraints.observationTtlMs = nativeTtlAfterValidation;
      return payload;
    },
    act: async () => { actions++; return { delivery: 'delivered' }; }, close: async () => ({ cleanup: 'confirmed' }) };
  const options = { providers: [provider], clock: () => time, ttlMs: 500,
    verifyStep: async () => 'confirmed', verifyEffect: async () => 'confirmed', operationPolicies: { input: { maxAgeMs: policy } } };
  const method = new ComputerMethod(options);
  method.start({ goalId: 'g', effects: [{ id: 'e', checkId: 'effect', steps: [{ id: 's', checkId: 'input',
    capability: 'native-action', target }] }] });
  return { method, options, tick: n => { time = n; }, get actions() { return actions; } };
}
const ready = async f => { await f.method.discover('e', 's'); await f.method.observe('e', 's'); };
test('operation expiry counts capture and asynchronous validation before consuming an attempt', async () => {
  for (const scenario of [{ captureMs: 101 }, { validationMs: 101 }, { nativeTtl: 50, captureMs: 51 },
    { validationMs: 51, nativeTtlAfterValidation: 50 }]) {
    const f = methodFixture(scenario); await ready(f);
    await assert.rejects(f.method.execute('e', 's', { type: 'activate' }), is('stale-observation'));
    assert.equal(f.actions, 0); assert.equal(f.method.status().effects[0].steps[0].attempts, 0); await f.method.close();
  }
});
test('operation policies cannot extend coordinator/native bounds or accept invalid clocks', async () => {
  for (const time of [501, -1, NaN]) {
    const f = methodFixture({ policy: 5000 }); await ready(f); f.tick(time);
    await assert.rejects(f.method.execute('e', 's', { type: 'activate' }), is('stale-observation')); await f.method.close();
  }
  const f = methodFixture({ policy: 100 }); await ready(f); f.tick(100);
  await f.method.execute('e', 's', { type: 'activate' }); assert.equal(f.actions, 1);
  f.tick(200); assert.equal((await f.method.verifyStep('e', 's')).status, 'verified'); await f.method.close();
  for (const operationPolicies of [null, [], { input: { maxAgeMs: 0 } }, { input: { maxAgeMs: 10, extra: true } }]) {
    assert.throws(() => new ComputerMethod({ ...f.options, operationPolicies }), is('invalid-config'));
  }
});
