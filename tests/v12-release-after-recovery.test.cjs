'use strict';
// M1 (G1): a failed session release stays cached until durable state proves it resolved, for example
// by `computer recover --apply` in another process. Then close_session confirms without an MCP restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { NativeSupervisor } = require('../src/computer/supervisor.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');

const CLEAR = { recoveryRequired: false, ready: true, code: null };
const PENDING = { recoveryRequired: true, ready: false, code: 'input_recovery_required', phase: 'input' };

// A fake native owner whose close does not confirm input cleanup, as after ctrl+shift+w (G2).
// `exitOnClose: false` keeps the child alive after stdin ends.
function supervisor({ exitOnClose = true } = {}) {
  const state = { durable: PENDING, checks: 0 };
  const native = new NativeSupervisor({
    verify: async () => {}, configure: async () => ({ providers: {}, allowControlled: false }), parentIdentity: async () => '123456789012345678',
    recoverImpl: async mode => { assert.equal(mode, '--check'); state.checks += 1; return state.durable; },
    spawnImpl() {
      const child = new EventEmitter(); child.pid = 1234;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let buffered = '';
      child.stdin = new Writable({
        write(chunk, encoding, done) {
          buffered += String(chunk);
          let i;
          while ((i = buffered.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffered.slice(0, i)); buffered = buffered.slice(i + 1);
            const result = message.method === 'configure' ? { ready: true, version: 1, monitors: 1 } : { closed: true, cleanup: 'unknown' };
            queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
          }
          done();
        },
        final(done) { if (exitOnClose) setImmediate(() => child.emit('close', 0, null)); done(); },
      });
      queueMicrotask(() => child.stdout.write(JSON.stringify({ event: 'hello', version: 1, pid: child.pid }) + '\n'));
      return child;
    },
  });
  const waitExit = native.waitExit.bind(native);
  native.waitExit = () => waitExit(50);
  return { native, state };
}

test('M1: a cached release error still refuses while the durable recovery record is present', async () => {
  const { native, state } = supervisor();
  await native.acquire('s');
  await assert.rejects(native.release('s'), { code: 'input_recovery_required' });
  assert.equal(native.child, null);
  await assert.rejects(native.release('s'), { code: 'input_recovery_required' });
  assert.equal(state.checks, 1, 'the retry re-checked durable state');
});

test('M1: once recovery is applied elsewhere, release confirms and the desktop is free again', async () => {
  const { native, state } = supervisor();
  await native.acquire('s');
  const first = await native.release('s').catch(error => error);
  assert.equal(first.code, 'input_recovery_required');
  state.durable = CLEAR; // `computer recover --apply` ran in another process
  assert.deepEqual(await native.release('s'), { cleanup: 'confirmed', recoveredExternally: true });
  assert.equal(native.releaseErrors.size, 0);
  await native.acquire('t');
  assert.equal(native.owner, 't');
});

test('M1: recovery cleared but the native owner has not exited still refuses', async () => {
  const { native, state } = supervisor({ exitOnClose: false });
  await native.acquire('s');
  await assert.rejects(native.release('s'));
  assert.ok(native.child, 'owner exit is unconfirmed');
  state.durable = CLEAR;
  await assert.rejects(native.release('s'));
  assert.equal(state.checks, 0, 'no recovery check while the owner may still hold input');
});

test('M1: an unreadable recovery state rethrows the original error unchanged', async () => {
  const { native } = supervisor();
  await native.acquire('s');
  const first = await native.release('s').catch(error => error);
  native.recoverImpl = async () => { throw Object.assign(new Error('x'), { code: 'recovery_unavailable' }); };
  assert.equal(await native.release('s').catch(error => error), first);
});

test('M1: close_session confirms after external recovery, and launch is no longer desktop_busy', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-m1-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { native, state } = supervisor();
  const window = { id: '77', pid: 456, processName: 'firefox', title: 'Firefox', processCreationTime: '100', sessionId: 1 };
  const backend = { listWindows: async () => [window], currentWindow: async () => window, doctor: async () => ({ ready: true }) };
  const launches = [];
  const controller = createComputerController({ backend, lease: native, runtimeDirectory: directory,
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} },
    createApplications: () => ({
      discover: async () => ({ applications: [{ name: 'notepad', appId: 'notepad' }] }),
      launch: async appId => { launches.push(appId); return { outcome: 'not_launched', code: 'test_stub' }; },
    }) });
  await controller.listWindows();
  const { sessionId } = await controller.openSession({ windowId: '77' });
  await assert.rejects(controller.closeSession({ sessionId }), { code: 'input_recovery_required' });
  await assert.rejects(controller.closeSession({ sessionId }), { code: 'input_recovery_required' });
  await assert.rejects(controller.launch({ app: 'notepad' }), { code: 'desktop_busy' });
  state.durable = CLEAR;
  assert.deepEqual(await controller.closeSession({ sessionId }), { sessionId, closed: true, cleanup: 'confirmed', recoveredExternally: true });
  const launched = await controller.launch({ app: 'notepad' });
  assert.equal(launched.outcome, 'not_launched');
  assert.deepEqual(launches, ['notepad']);
  await controller.close();
});

test('M1: doctor names a release that is waiting on a closed session once recovery is clear', async () => {
  const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
  const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });
  const supervisor = { binaryPath: 'supervisor.exe', ready: false, releaseErrors: new Map([['s', new Error('cached')]]), verify: async () => {} };
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor, verify: async () => {}, verifyBridge: async () => {},
    verifyIndicator: async () => ({ available: true }), run: async (executable, args) => {
      if (executable === 'supervisor.exe') return json(CLEAR);
      if (executable === 'dotnet') return { stdout: 'Microsoft.WindowsDesktop.App 9.0.4 [C:\dotnet]\n', stderr: '', exitCode: 0 };
      if (args[0] === '--version') return { stdout: '0.7.1\n', stderr: '', exitCode: 0 };
      return json({ version: 1 });
    } });
  const doctor = await backend.doctor();
  assert.equal(doctor.ready, true, JSON.stringify(doctor));
  assert.equal(doctor.supervision.code, 'release_pending_recovery');
  supervisor.releaseErrors.clear();
  assert.equal((await backend.doctor()).supervision.code, null);
});
