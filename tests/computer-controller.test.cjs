'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createComputerController } = require('../src/computer/controller.cjs');
const { DesktopLease } = require('../src/computer/lease.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=', 'base64');
const window = { id: '101', pid: 123, processName: 'owned-fixture', title: 'Test', bounds: { x: 10, y: 20, width: 1, height: 1 } };
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-controller-test-'));
  const dispatched = [];
  const backend = {
    async doctor() { return { ready: true }; },
    async listWindows() { return [{ ...window }]; },
    async observe({ screenshotPath }) {
      await fs.writeFile(screenshotPath, png);
      return { window: { ...window }, bounds: { ...window.bounds }, elements: [{ id: 'input', enabled: true }], screenshot: { path: screenshotPath } };
    },
    async act(request) { dispatched.push(request.action); return { performed: true }; },
    ...overrides,
  };
  const leaseDirectory = path.join(directory, 'test-lease');
  const controller = createComputerController({ backend, runtimeDirectory: directory, lease: new DesktopLease(leaseDirectory) });
  t.after(async () => {
    await controller.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('trace-controller-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { controller, backend, directory, leaseDirectory, dispatched };
}
async function open(controller) {
  await controller.listWindows();
  return controller.openSession({ windowId: window.id });
}

test('session requires a discovered unchanged window and returns bounded screenshot evidence', async t => {
  const { controller, backend } = await fixture(t);
  await assert.rejects(controller.openSession({ windowId: window.id }), { code: 'unknown_window' });
  await controller.listWindows();
  backend.listWindows = async () => [{ ...window, pid: 999 }];
  await assert.rejects(controller.openSession({ windowId: window.id }), { code: 'window_changed' });
  backend.listWindows = async () => [{ ...window }];
  const session = await open(controller);
  const observation = await controller.observe(session);
  assert.equal(observation.screenshot.mimeType, 'image/png');
  assert.equal(Buffer.from(observation.screenshot.data, 'base64').length, png.length);
  assert.equal(observation.screenshot.width, 1);
  assert.match(observation.screenshot.sha256, /^[a-f0-9]{64}$/);
});

test('one action consumes observation and returns a new observation; stale IDs never dispatch', async t => {
  const { controller, dispatched } = await fixture(t);
  const session = await open(controller);
  const observation = await controller.observe(session);
  const request = { ...session, observationId: observation.observationId, action: { type: 'click', x: 0, y: 0 } };
  const result = await controller.act(request);
  assert.equal(result.outcome, 'completed');
  assert.notEqual(result.observation.observationId, observation.observationId);
  await assert.rejects(controller.act(request), { code: 'stale_observation' });
  assert.equal(dispatched.length, 1);
});

test('invalid coordinates, unknown elements, extra fields and Windows key never dispatch', async t => {
  const { controller, dispatched } = await fixture(t);
  const session = await open(controller);
  const observation = await controller.observe(session);
  for (const action of [{ type: 'click', x: 1, y: 0 }, { type: 'invoke', elementId: 'missing' }, { type: 'activate', command: 'anything' }, { type: 'press_key', key: 'WIN+R' }]) {
    await assert.rejects(controller.act({ ...session, observationId: observation.observationId, action }));
  }
  assert.equal(dispatched.length, 0);
});

test('expired observation cannot dispatch', async t => {
  const { backend, directory, controller: owner, dispatched } = await fixture(t);
  await owner.close();
  let now = 0;
  const controller = createComputerController({ backend, runtimeDirectory: directory, lease: new DesktopLease(path.join(directory, 'test-lease')), now: () => now, observationTtlMs: 100 });
  t.after(() => controller.close());
  const session = await open(controller);
  const observation = await controller.observe(session);
  now = 101;
  await assert.rejects(controller.act({ ...session, observationId: observation.observationId, action: { type: 'activate' } }), { code: 'stale_observation' });
  assert.equal(dispatched.length, 0);
});

test('timeout after input reports unknown and requires explicit observation before retry', async t => {
  const { controller, backend, dispatched } = await fixture(t);
  const session = await open(controller);
  const observation = await controller.observe(session);
  backend.act = async () => { dispatched.push('attempt'); throw Object.assign(new Error('timeout'), { code: 'native_timeout' }); };
  const request = { ...session, observationId: observation.observationId, action: { type: 'activate' } };
  const result = await controller.act(request);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.error.code, 'native_timeout');
  await assert.rejects(controller.act(request), { code: 'stale_observation' });
  const fresh = await controller.observe(session);
  assert.notEqual(fresh.observationId, observation.observationId);
  assert.equal(dispatched.length, 1);
});

test('post-input capture failure stays unknown; journal excludes typed text and pixels', async t => {
  const { controller, backend, directory } = await fixture(t);
  const session = await open(controller);
  const observation = await controller.observe(session);
  backend.observe = async () => { throw new Error('capture unavailable'); };
  const secret = 'sample-sensitive-text';
  const result = await controller.act({ ...session, observationId: observation.observationId, action: { type: 'type_text', text: secret } });
  assert.equal(result.outcome, 'unknown');
  const journal = await fs.readFile(path.join(directory, 'sessions', session.sessionId, 'events.jsonl'), 'utf8');
  assert.ok(!journal.includes(secret));
  assert.ok(!journal.includes(png.toString('base64')));
});

test('failed gesture recovery exposes a quarantine result without private native details', async t => {
  const { controller, backend } = await fixture(t);
  const session = await open(controller);
  const observation = await controller.observe(session);
  backend.act = async () => { throw Object.assign(new Error('native timeout'), { code: 'native_timeout', details: {
    pid: 123456, native: { privateValue: 'not-for-output' }, outcome: 'unknown',
    recovery: { attempted: true, released: false, code: 'input_recovery_failed', privatePath: 'not-for-output' },
  } }); };
  const result = await controller.act({ ...session, observationId: observation.observationId, action: { type: 'activate' } });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.error.inputRecoveryRequired, true);
  assert.deepEqual(result.error.recovery, { attempted: true, released: false, code: 'input_recovery_failed' });
  assert.match(result.nextStep, /quarantined/);
  assert.ok(!JSON.stringify(result).includes('not-for-output'));
  assert.ok(!JSON.stringify(result).includes('123456'));
});

test('wrong capture path, dimensions and replaced target are rejected before input', async t => {
  const { controller, backend, dispatched } = await fixture(t);
  const session = await open(controller);
  const original = backend.observe;
  backend.observe = async request => ({ ...await original(request), screenshot: { path: path.join(os.tmpdir(), 'unrelated.png') } });
  await assert.rejects(controller.observe(session), { code: 'invalid_capture' });
  backend.observe = async request => ({ ...await original(request), bounds: { x: 10, y: 20, width: 2, height: 1 } });
  await assert.rejects(controller.observe(session), { code: 'capture_mismatch' });
  backend.observe = original;
  const observation = await controller.observe(session);
  backend.listWindows = async () => [{ ...window, processName: 'replacement' }];
  await assert.rejects(controller.act({ ...session, observationId: observation.observationId, action: { type: 'activate' } }), { code: 'window_changed' });
  assert.equal(dispatched.length, 0);
});

test('competing controllers cannot own the same desktop and close releases ownership', async t => {
  const { controller, backend, directory } = await fixture(t);
  const competitor = createComputerController({ backend, runtimeDirectory: directory, lease: new DesktopLease(path.join(directory, 'test-lease')) });
  t.after(() => competitor.close());
  const session = await open(controller);
  await competitor.listWindows();
  await assert.rejects(competitor.openSession({ windowId: window.id }), { code: 'desktop_busy' });
  await controller.closeSession(session);
  const other = await competitor.openSession({ windowId: window.id });
  assert.ok(other.sessionId);
});

test('already-cancelled operation never reaches backend', async t => {
  const { controller, backend } = await fixture(t);
  backend.listWindows = async () => assert.fail('must not call backend');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(controller.listWindows({ signal: abort.signal }), { name: 'AbortError' });
});

test('concurrent requests cannot reuse one observation for two inputs', async t => {
  const { controller, dispatched } = await fixture(t);
  const session = await open(controller);
  const observation = await controller.observe(session);
  const request = { ...session, observationId: observation.observationId, action: { type: 'activate' } };
  const results = await Promise.allSettled([controller.act(request), controller.act(request)]);
  assert.equal(results[0].value.outcome, 'completed');
  assert.equal(results[1].reason.code, 'stale_observation');
  assert.equal(dispatched.length, 1);
});

test('shutdown cancels in-flight dispatch, reports uncertainty and releases the desktop', async t => {
  const { controller, backend, directory } = await fixture(t);
  const session = await open(controller);
  const observation = await controller.observe(session);
  let started;
  const running = new Promise(resolve => { started = resolve; });
  backend.act = async ({ signal }) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }));
  };
  const action = controller.act({ ...session, observationId: observation.observationId, action: { type: 'activate' } });
  await running;
  const closing = controller.close();
  assert.equal((await action).outcome, 'unknown');
  await closing;
  const lease = new DesktopLease(path.join(directory, 'test-lease'));
  await lease.acquire('next');
  await lease.release('next');
});

test('different artifact runtimes still contend for the same production desktop lease', async t => {
  const { controller: unused, backend, directory } = await fixture(t);
  await unused.close();
  const first = createComputerController({ backend, runtimeDirectory: path.join(directory, 'a') });
  const second = createComputerController({ backend, runtimeDirectory: path.join(directory, 'b') });
  t.after(async () => { await first.close(); await second.close(); });
  const session = await open(first);
  await second.listWindows();
  await assert.rejects(second.openSession({ windowId: window.id }), { code: 'desktop_busy' });
  await first.closeSession(session);
  await second.openSession({ windowId: window.id });
});

test('cancellation during lease acquisition releases ownership without publishing a session', async t => {
  const { controller: unused, backend, directory } = await fixture(t);
  await unused.close();
  const cancellation = new AbortController();
  let released = false;
  const controller = createComputerController({ backend, runtimeDirectory: directory, lease: {
    async acquire() { cancellation.abort(); },
    async release() { released = true; },
  } });
  t.after(() => controller.close());
  await controller.listWindows();
  await assert.rejects(controller.openSession({ windowId: window.id }, { signal: cancellation.signal }), { name: 'AbortError' });
  assert.equal(released, true);
});

test('Windows OS lease excludes another process and releases after a crash', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const directory = path.join(os.tmpdir(), `trace-os-lease-${require('node:crypto').randomUUID()}`);
  const script = `const {DesktopLease}=require(${JSON.stringify(require.resolve('../src/computer/lease.cjs'))}); (async()=>{const lease=new DesktopLease(process.argv[1]); await lease.acquire('child'); process.send('ready');})().catch(e=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', script, directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, 'message');
  const lease = new DesktopLease(directory);
  await assert.rejects(lease.acquire('parent'), { code: 'desktop_busy' });
  const exited = once(child, 'exit'); child.kill(); await exited;
  await lease.acquire('parent');
  await lease.assert('parent');
  await lease.release('parent');
});
