'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { NativeSupervisor } = require('../src/computer/supervisor.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');

function fixture(handler = () => {}) {
  let child;
  const requests = [];
  let spawnOptions;
  const native = new NativeSupervisor({
    verify: async () => {}, configure: async () => ({ providers: {}, allowControlled: false }), parentIdentity: async () => '123456789012345678',
    spawnImpl(exe, args, options) {
      spawnOptions = options;
      assert.deepEqual(args, ['session', String(process.pid), '123456789012345678']);
      child = new EventEmitter(); child.pid = 1234;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let buffered = '';
      child.stdin = new Writable({ write(chunk, encoding, done) {
        buffered += String(chunk);
        let i;
        while ((i = buffered.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffered.slice(0, i)); buffered = buffered.slice(i + 1); requests.push(message);
          queueMicrotask(() => {
            const response = handler(message, child);
            if (response === false) return;
            const result = response ?? (message.method === 'configure' ? { ready: true, version: 1, monitors: 1 } : message.method === 'run' ? { stdout: '{}', stderr: '', exitCode: 0 } : { closed: true });
            child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
            if (message.method === 'close') setImmediate(() => child.emit('close', 0, null));
          });
        }
        done();
      } });
      queueMicrotask(() => child.stdout.write(JSON.stringify({ event: 'hello', version: 1, pid: child.pid }) + '\n'));
      return child;
    },
  });
  return { native, requests, options: () => spawnOptions, child: () => child };
}

test('production owner is detached, configured through stdio, and keeps one lease until verified close', async () => {
  const { native, requests, options } = fixture();
  await native.acquire('session');
  assert.equal(options().detached, true);
  assert.equal(options().windowsHide, true);
  assert.equal(options().shell, false);
  assert.equal(requests[0].method, 'configure');
  assert.equal(requests[0].allowControlled, false);
  await assert.rejects(native.acquire('other'), { code: 'desktop_busy' });
  await native.assert('session');
  assert.equal((await native.indicator().start()).active, true);
  const result = await native.run('winapp', ['ui', 'status', '--json']);
  assert.equal(result.exitCode, 0);
  await native.release('session');
  assert.equal(native.child, null);
  await assert.rejects(native.assert('session'), { code: 'session_stopped' });
});

test('cancellation requests native cleanup and waits for the operation recovery result', async () => {
  let actionId;
  const { native, requests } = fixture((message, child) => {
    if (message.method === 'run') { actionId = message.id; return false; }
    if (message.method === 'cancel') {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: actionId, error: { code: 'cancelled', outcome: 'unknown', recovery: { attempted: true, released: true } } }) + '\n'));
      return { cancelled: true };
    }
  });
  await native.acquire('s');
  const abort = new AbortController();
  const operation = native.run('winapp', ['ui', 'drag'], { signal: abort.signal, mutating: true });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(operation, error => error.code === 'cancelled' && error.details.outcome === 'unknown' && error.details.recovery.released === true);
  assert.equal(requests.filter(item => item.method === 'run').length, 1);
  await native.release('s');
});

test('physical stop blocks later commands while retaining the owner for explicit close', async () => {
  const { native, child } = fixture();
  await native.acquire('s');
  child().stdout.write(JSON.stringify({ event: 'stopped', code: 'physical_escape' }) + '\n');
  assert.equal(native.signal.aborted, true);
  await assert.rejects(native.run('winapp', ['ui', 'click'], { mutating: true }), { code: 'session_stopped' });
  assert.ok(native.child);
  await native.release('s');
});

test('backend uses native ownership for all session commands and refuses unowned mutation', async () => {
  const calls = [];
  const owner = { ready: false, async run(provider, args, options) { calls.push({ provider, args, options }); return { stdout: '{}', stderr: '', exitCode: 0 }; } };
  const backend = new WinappBackend({ supervisor: owner });
  await assert.rejects(backend.command('send-keys', [], undefined), { code: 'session_stopped' });
  owner.ready = true;
  await backend.command('send-keys', ['--', 'synthetic']);
  await backend.command('inspect', []);
  assert.equal(calls[0].options.mutating, true);
  assert.equal(calls[1].options.mutating, false);
  assert.equal(calls.length, 2);
});

test('backend preserves proven native non-dispatch and failed-cleanup details through its action wrapper', async () => {
  const owner = { ready: true, child: {}, owner: 's', async release(id) { assert.equal(id, 's'); this.child = null; } };
  const backend = new WinappBackend({ supervisor: owner });
  backend.dispatch = async (request, progress) => {
    progress.primary = true;
    throw Object.assign(new Error('Native rejection.'), { code: 'input_busy', details: { nativeSupervision: true, outcome: 'not_dispatched', recovery: { attempted: false, released: false, processExitConfirmed: false } } });
  };
  await assert.rejects(backend.act({}), error => error.code === 'input_busy' && error.details.outcome === 'not_dispatched' && error.details.recovery.released === false && error.details.recovery.processExitConfirmed === false);
  await backend.close();
  assert.equal(owner.child, null);
});
