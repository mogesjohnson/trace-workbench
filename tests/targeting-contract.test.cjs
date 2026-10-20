'use strict';
// A33-DEPTH and A33-OUTCOME: observation depth is retained server-side and reused for action
// reinspection; rejections before the primary mutation are reported as not_dispatched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WinappBackend, BackendError } = require('../src/computer/winapp-backend.cjs');
const { createComputerController, validateDepth } = require('../src/computer/controller.cjs');
const { DesktopLease } = require('../src/computer/lease.cjs');

const rect = { x: 100, y: 200, width: 300, height: 400 };
const window = { id: '1234', pid: 456, processName: 'TraceFixture', title: 'TRACE fixture', bounds: rect };
const deep = { selector: 'deep-button', name: 'Deep counter', type: 'Button', isEnabled: true, isOffscreen: false, x: 140, y: 260, width: 80, height: 30 };
const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });

// The deep control appears only when inspection depth reaches 12.
function inspect(depth, { includeDeep = true } = {}) {
  const children = depth >= 12 && includeDeep ? [{ ...deep }] : [];
  return { windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [{ selector: 'win-root', name: 'TRACE fixture', type: 'Window', isEnabled: true, ...rect, hasMoreChildren: depth < 12, children }] }] };
}
function backendWith(handler) {
  const calls = [];
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', verify: async () => {}, verifyBridge: async () => {}, verifyIndicator: async () => ({ available: true }), run: async (executable, args) => {
    calls.push(args);
    const override = handler?.(args, calls);
    if (override instanceof Error) throw override;
    if (override !== undefined) return json(override);
    if (args[0] === 'bounds' || args[0] === 'activate') return json({ hwnd: '1234', pid: 456, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: true });
    if (args[1] === 'status') return json({ hwnd: 1234, processId: 456, processName: 'TraceFixture', windowTitle: 'TRACE fixture', coordinateSpace: 'physical-screen-pixels' });
    if (args[1] === 'inspect') return json(inspect(Number(args[args.indexOf('--depth') + 1])));
    if (args[1] === 'get-focused') return json({ hasFocus: true, element: { selector: 'deep-button' } });
    return json({ hwnd: 1234 });
  } });
  return { backend, calls };
}
const observation = depth => ({
  window: { ...window, bounds: { ...rect } }, bounds: { ...rect }, uiaBounds: { ...rect }, frameBounds: { ...rect }, nativeWindowBounds: { ...rect }, depth,
  elements: [{ id: 'deep-button', name: 'Deep counter', controlType: 'Button', enabled: true, bounds: { x: 140, y: 260, width: 80, height: 30 } }],
});
const inspectDepths = calls => calls.filter(args => args[1] === 'inspect').map(args => Number(args[args.indexOf('--depth') + 1]));

test('accessibility depth defaults to 8 and accepts only integers from 1 to 32', () => {
  assert.equal(validateDepth(undefined), 8);
  assert.equal(validateDepth(1), 1);
  assert.equal(validateDepth(32), 32);
  for (const bad of [0, 33, 8.5, '8', null, -1]) assert.throws(() => validateDepth(bad), { code: 'invalid_depth' });
});

test('a control beyond depth 8 dispatches once when reinspected at the observed depth', async () => {
  const { backend, calls } = backendWith();
  const result = await backend.act({ window, observation: observation(12), action: { type: 'invoke', elementId: 'deep-button' } });
  assert.equal(result.performed, true);
  assert.deepEqual(inspectDepths(calls), [12]);
  assert.equal(calls.filter(args => args[1] === 'invoke').length, 1);
});

test('the same deep control is rejected before dispatch at the default depth', async () => {
  const { backend, calls } = backendWith();
  await assert.rejects(backend.act({ window, observation: observation(8), action: { type: 'invoke', elementId: 'deep-button' } }),
    error => error.code === 'stale_element' && error.details.outcome === 'not_dispatched');
  assert.equal(calls.filter(args => args[1] === 'invoke').length, 0);
});

test('removed, moved or disabled deep controls reject primary input as not dispatched', async () => {
  const variants = {
    removed: args => args[1] === 'inspect' ? inspect(12, { includeDeep: false }) : undefined,
    moved: args => args[1] === 'inspect' ? { windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [{ selector: 'win-root', name: 'TRACE fixture', type: 'Window', isEnabled: true, ...rect, children: [{ ...deep, x: 150 }] }] }] } : undefined,
    disabled: args => args[1] === 'inspect' ? { windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [{ selector: 'win-root', name: 'TRACE fixture', type: 'Window', isEnabled: true, ...rect, children: [{ ...deep, isEnabled: false }] }] }] } : undefined,
  };
  for (const [name, handler] of Object.entries(variants)) {
    const { backend, calls } = backendWith(handler);
    await assert.rejects(backend.act({ window, observation: observation(12), action: { type: 'invoke', elementId: 'deep-button' } }),
      error => error.code === 'stale_element' && error.details.outcome === 'not_dispatched', name);
    assert.equal(calls.filter(args => args[1] === 'invoke').length, 0, name);
  }
});

test('moved window, blocked window, unsupported scroll and focus failures are not dispatched', async () => {
  const cases = [
    ['window_moved', args => args[0] === 'bounds' ? { hwnd: '1234', pid: 456, frameBounds: { ...rect, x: 120 }, windowBounds: { ...rect, x: 120 }, foreground: true, minimized: false, enabled: true } : undefined, { type: 'invoke', elementId: 'deep-button' }],
    ['window_blocked', args => args[0] === 'bounds' ? { hwnd: '1234', pid: 456, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: false } : undefined, { type: 'invoke', elementId: 'deep-button' }],
    ['unsupported_action', undefined, { type: 'scroll', x: 50, y: 70, deltaX: 120, deltaY: 0 }],
    ['focus_not_acquired', args => args[1] === 'get-focused' ? { hasFocus: false } : undefined, { type: 'type_text', text: 'x' }],
  ];
  for (const [code, handler, action] of cases) {
    const { backend, calls } = backendWith(handler);
    await assert.rejects(backend.act({ window, observation: observation(12), action }), error => error.code === code && error.details.outcome === 'not_dispatched', code);
    assert.equal(calls.filter(args => ['invoke', 'send-keys', 'scroll', 'drag', 'click', 'set-value'].includes(args[1])).length, 0, code);
  }
});

test('preparatory activation is recorded separately from a not-dispatched focus rejection', async () => {
  const { backend } = backendWith(args => args[1] === 'get-focused' ? { hasFocus: false } : undefined);
  await assert.rejects(backend.act({ window, observation: observation(12), action: { type: 'press_key', key: 'tab' } }),
    error => error.details.outcome === 'not_dispatched' && error.details.preparation.length === 1 && error.details.preparation[0].step === 'activation' && error.details.preparation[0].status === 'foreground');
});

test('failures after the primary mutation may have begun stay unknown', async () => {
  const native = Object.assign(new BackendError('native_error', 'Native command exited unsuccessfully.', { exitCode: 1 }));
  const { backend } = backendWith(args => args[1] === 'invoke' ? native : undefined);
  await assert.rejects(backend.act({ window, observation: observation(12), action: { type: 'invoke', elementId: 'deep-button' } }), error => error.details.outcome === 'unknown');
  const mismatch = backendWith(args => args[1] === 'invoke' ? { hwnd: 999 } : undefined).backend;
  await assert.rejects(mismatch.act({ window, observation: observation(12), action: { type: 'invoke', elementId: 'deep-button' } }), error => error.code === 'window_identity_changed' && error.details.outcome === 'unknown');
  const activation = backendWith(args => args[0] === 'activate' ? { hwnd: '1234', pid: 456, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: false, minimized: false, enabled: true } : undefined).backend;
  await assert.rejects(activation.act({ window, observation: observation(12), action: { type: 'activate' } }), error => error.code === 'foreground_not_target' && error.details.outcome === 'unknown');
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=', 'base64');
async function controllerFixture(t, act) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-targeting-test-'));
  const seen = { observeDepths: [], actDepths: [] };
  const win = { id: '101', pid: 123, processName: 'owned', title: 'Test', bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const backend = {
    async doctor() { return { ready: true }; },
    async listWindows() { return [{ ...win }]; },
    async observe({ screenshotPath, depth }) {
      seen.observeDepths.push(depth);
      await fs.writeFile(screenshotPath, png);
      return { window: { ...win }, bounds: { ...win.bounds }, elements: [{ id: 'deep', enabled: true }], screenshot: { path: screenshotPath }, depth, truncated: depth < 12 };
    },
    async act(request) { seen.actDepths.push(request.observation.depth); return act(request); },
  };
  const failed = new AbortController();
  const indicator = { signal: failed.signal, active: false, async start() { this.active = true; return { active: true, monitors: 1, protocol: 1 }; }, assertActive() {}, async stop() {} };
  const controller = createComputerController({ backend, indicator, runtimeDirectory: directory, lease: new DesktopLease(path.join(directory, 'lease')) });
  t.after(async () => { await controller.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await controller.listWindows();
  const session = await controller.openSession({ windowId: win.id });
  return { controller, session, seen, directory };
}

test('controller keeps observation depth server-side, reuses it for action and the fresh observation', async t => {
  const { controller, session, seen } = await controllerFixture(t, async () => ({ performed: true }));
  const observed = await controller.observe({ ...session, accessibilityDepth: 12 });
  assert.deepEqual(observed.accessibility, { truncated: false, depth: 12 });
  const result = await controller.act({ ...session, observationId: observed.observationId, action: { type: 'invoke', elementId: 'deep' } });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(seen.actDepths, [12]);
  assert.deepEqual(seen.observeDepths, [12, 12]);
  assert.equal(result.observation.accessibility.depth, 12);
  await assert.rejects(controller.observe({ ...session, accessibilityDepth: 33 }), { code: 'invalid_depth' });
  const fresh = await controller.observe(session);
  assert.equal(fresh.accessibility.depth, 8);
  await assert.rejects(controller.act({ ...session, observationId: fresh.observationId, action: { type: 'invoke', elementId: 'deep', accessibilityDepth: 32 } }), { code: 'invalid_action' });
});

test('controller reports not_dispatched with preparation and journals it without retrying', async t => {
  let calls = 0;
  const { controller, session, directory } = await controllerFixture(t, async () => {
    calls++;
    throw new BackendError('focus_not_acquired', 'No focus.', { outcome: 'not_dispatched', preparation: [{ step: 'activation', status: 'foreground', privateDetail: 'x' }] });
  });
  const observed = await controller.observe(session);
  const result = await controller.act({ ...session, observationId: observed.observationId, action: { type: 'type_text', text: 'x' } });
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.error.outcome, 'not_dispatched');
  assert.deepEqual(result.error.preparation, [{ step: 'activation', status: 'foreground' }]);
  assert.match(result.nextStep, /not sent/);
  assert.equal(calls, 1);
  const journal = await fs.readFile(path.join(directory, 'sessions', session.sessionId, 'events.jsonl'), 'utf8');
  assert.match(journal, /action_not_dispatched/);
  await assert.rejects(controller.act({ ...session, observationId: observed.observationId, action: { type: 'type_text', text: 'x' } }), { code: 'stale_observation' });
});


test('observation of a minimized window captures only after restored geometry settles', async () => {
  const frames = [{ minimized: true }, { minimized: false, x: 90 }, { minimized: false, x: 100 }, { minimized: false, x: 100 }];
  let reads = 0;
  const { backend, calls } = backendWith(args => {
    if (args[0] !== 'bounds') return undefined;
    const frame = frames[Math.min(reads++, frames.length - 1)];
    const box = { ...rect, x: frame.x ?? rect.x };
    return { hwnd: '1234', pid: 456, frameBounds: box, windowBounds: box, foreground: true, minimized: frame.minimized, enabled: true };
  });
  await assert.rejects(backend.observe({ window, screenshotPath: path.join(os.tmpdir(), 'trace-settle-test.png'), signal: undefined, depth: 8 }), () => true);
  const order = calls.map(args => args[0] === 'bounds' || args[0] === 'activate' ? args[0] : args[1]);
  assert.equal(order[0], 'status');
  assert.deepEqual(order.slice(1, 6), ['bounds', 'activate', 'bounds', 'bounds', 'bounds']);
  assert.equal(order[6], 'inspect');
});

test('a restored window that never settles is rejected before capture', async () => {
  let x = 0;
  const { backend, calls } = backendWith(args => args[0] === 'bounds' ? { hwnd: '1234', pid: 456, frameBounds: { ...rect, x: x++ }, windowBounds: { ...rect }, foreground: true, minimized: x === 1, enabled: true } : undefined);
  const original = backend.settledBounds.bind(backend);
  backend.settledBounds = (w, s) => original(w, s, { attempts: 3, intervalMs: 1 });
  await assert.rejects(backend.observe({ window, screenshotPath: path.join(os.tmpdir(), 'trace-settle-test.png'), depth: 8 }), { code: 'window_moved' });
  assert.equal(calls.filter(args => args[1] === 'screenshot').length, 0);
});
