'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LIMITS, KEY_PATTERN, normalizeKey, parseAction, validateAction } = require('../src/computer/action-contract.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');

const observation = { bounds: { width: 10, height: 10 }, elements: [{ id: 'enabled', enabled: true }, { id: 'disabled', enabled: false }] };
const reject = action => assert.throws(() => parseAction(action), error => error.details?.outcome === 'not_dispatched');

test('static contract enforces bounded text, identifiers, keys and wheel increments', () => {
  assert.deepEqual(LIMITS, { text: 8192, elementId: 512, key: 100, wheel: 2400, wheelStep: 120 });
  assert.equal(typeof KEY_PATTERN, 'string');
  for (const text of ['x', 'x'.repeat(8192)]) assert.deepEqual(parseAction({ type: 'type_text', text }), { type: 'type_text', text });
  for (const text of ['', 'x'.repeat(8193), 'a\0b']) reject({ type: 'type_text', text });
  for (const value of ['', 'x'.repeat(8192)]) assert.equal(parseAction({ type: 'set_value', elementId: 'a', value }).value, value);
  for (const value of ['x'.repeat(8193), '\0']) reject({ type: 'set_value', elementId: 'a', value });
  assert.equal(parseAction({ type: 'invoke', elementId: 'a'.repeat(512) }).elementId.length, 512);
  for (const elementId of ['', 'a'.repeat(513), '\0']) reject({ type: 'invoke', elementId });
  for (const key of ['CONTROL+RETURN', 'eSc', 'shift+F12']) assert.equal(parseAction({ type: 'press_key', key }).key, key);
  assert.equal(normalizeKey('CONTROL+RETURN'), 'ctrl+enter');
  assert.equal(normalizeKey('ESC'), 'esc');
  for (const key of ['INSERT', 'WIN+R', 'ctrl+a enter', 'a'.repeat(101)]) reject({ type: 'press_key', key });
  for (const deltaY of [-2400, -120, 120, 2400]) parseAction({ type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY });
  for (const [deltaX, deltaY] of [[1, 120], [0, 1], [0, 0], [0, 2520]]) reject({ type: 'scroll', x: 0, y: 0, deltaX, deltaY });
  for (const action of [{ type: 'click', x: -1, y: 0 }, { type: 'click', x: 0.5, y: 0 }, { type: 'activate', extra: true }, { type: 'launch_shell' }]) reject(action);
});

test('observation validation adds image bounds and enabled membership', () => {
  assert.deepEqual(validateAction({ type: 'click', x: 9, y: 9 }, observation), { type: 'click', x: 9, y: 9 });
  assert.doesNotThrow(() => parseAction({ type: 'click', x: 10, y: 0 }));
  assert.throws(() => validateAction({ type: 'click', x: 10, y: 0 }, observation), { code: 'invalid_coordinates' });
  assert.doesNotThrow(() => parseAction({ type: 'invoke', elementId: 'missing' }));
  for (const elementId of ['missing', 'disabled']) assert.throws(() => validateAction({ type: 'invoke', elementId }, observation), { code: 'unknown_element' });
  assert.doesNotThrow(() => validateAction({ type: 'invoke', elementId: 'enabled' }, observation));
});

test('unsupported wheel does not consume the controller observation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-contract-test-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=', 'base64');
  const window = { id: '101', pid: 123, processName: 'fixture', title: 'Test', bounds: { x: 0, y: 0, width: 1, height: 1 } };
  let dispatched = 0;
  const backend = { async listWindows() { return [window]; }, async observe({ screenshotPath }) { await fs.writeFile(screenshotPath, png); return { window, bounds: window.bounds, elements: [], screenshot: { path: screenshotPath } }; }, async act() { dispatched++; return { performed: true }; } };
  const indicator = { signal: new AbortController().signal, async start() { return { active: true, monitors: 1, protocol: 1 }; }, assertActive() {}, async stop() {} };
  const lease = { async acquire() {}, async assert() {}, async release() {} };
  const controller = createComputerController({ backend, indicator, lease, runtimeDirectory: directory });
  t.after(async () => { await controller.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await controller.listWindows();
  const session = await controller.openSession({ windowId: window.id });
  const frame = await controller.observe(session);
  const request = { ...session, observationId: frame.observationId };
  await assert.rejects(controller.act({ ...request, action: { type: 'scroll', x: 0, y: 0, deltaX: 1, deltaY: 120 } }), error => error.details?.outcome === 'not_dispatched');
  assert.equal(dispatched, 0);
  assert.equal((await controller.act({ ...request, action: { type: 'activate' } })).outcome, 'completed');
  assert.equal(dispatched, 1);
});

test('direct backend rejects unsupported wheel before provider calls', async () => {
  let calls = 0;
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', run: async () => { calls++; throw new Error('unexpected provider'); } });
  backend.identity = async () => { calls++; throw new Error('unexpected identity'); };
  backend.inspect = async () => { calls++; throw new Error('unexpected inspection'); };
  const window = { id: '101', pid: 123, processName: 'fixture', bounds: { x: 0, y: 0, ...observation.bounds } };
  await assert.rejects(backend.act({ window, observation: { ...observation, bounds: window.bounds, window }, action: { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 1 } }), error => error.code === 'unsupported_action' && error.details?.outcome === 'not_dispatched');
  assert.equal(calls, 0);
});
