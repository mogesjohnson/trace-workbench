'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ActivityIndicator, SOURCES, OUTPUTS, indicatorSourceHashes, verifyIndicatorFiles } = require('../src/computer/activity-indicator.cjs');

function nativeDouble({ ready = true, eofExit = true, killExit = true, reply } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = 0; let exited = false;
  child.exit = () => { if (!exited) { exited = true; child.emit('exit', 0, null); } };
  child.kill = () => { child.kills++; if (killExit) setImmediate(child.exit); return true; };
  if (eofExit) child.stdin.once('finish', () => setImmediate(child.exit));
  const calls = [];
  const marker = new ActivityIndicator({
    binaryPath: 'synthetic-marker.exe', verify: async () => { calls.push('verify'); },
    spawnChild: (binary, args, options) => {
      calls.push({ binary, args, options });
      if (ready) setImmediate(() => child.stdout.write(JSON.stringify(reply ?? { version: 1, ready: true, pid: child.pid, monitors: 2 }) + '\n'));
      return child;
    }, startupMs: 30, stopMs: 15,
  });
  return { marker, child, calls };
}

test('starting verifies local files, pins parent PID and accepts bounded all-monitor readiness', async () => {
  const { marker, child, calls } = nativeDouble();
  assert.throws(() => marker.assertActive(), { code: 'indicator_not_active' });
  assert.deepEqual(await marker.start(), { active: true, monitors: 2, protocol: 1 });
  marker.assertActive();
  assert.equal(calls[0], 'verify');
  assert.deepEqual(calls[1].args, ['--parent-pid', String(process.pid)]);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.windowsHide, false);
  assert.deepEqual(calls[1].options.stdio, ['pipe', 'pipe', 'pipe']);
  await marker.stop();
  assert.equal(child.kills, 0);
  assert.equal(marker.signal.aborted, false);
  assert.throws(() => marker.assertActive(), { code: 'indicator_not_active' });
});

test('missing or changed native marker never spawns a process', async () => {
  let spawns = 0;
  const marker = new ActivityIndicator({ verify: async () => { throw Object.assign(new Error('stale'), { code: 'indicator_stale' }); }, spawnChild: () => { spawns++; } });
  await assert.rejects(marker.start(), { code: 'indicator_stale' });
  assert.equal(spawns, 0);
});

test('invalid readiness identity or zero monitors fails closed and cleans up', async () => {
  for (const reply of [{ version: 1, ready: true, pid: 999, monitors: 1 }, { version: 1, ready: true, pid: 12345, monitors: 0 }]) {
    const { marker } = nativeDouble({ reply });
    await assert.rejects(marker.start(), { code: 'indicator_protocol' });
    assert.throws(() => marker.assertActive(), { code: 'indicator_not_active' });
    assert.equal(marker.child, null);
  }
});

test('startup has a bounded timeout and exits without permitting input', async () => {
  const { marker } = nativeDouble({ ready: false });
  await assert.rejects(marker.start(), { code: 'indicator_timeout' });
  assert.equal(marker.child, null);
  assert.throws(() => marker.assertActive(), { code: 'indicator_not_active' });
});

test('cancellation during startup cleans up; pre-aborted calls do not spawn', async () => {
  const { marker, calls } = nativeDouble({ ready: false });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(marker.start({ signal: aborted.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, []);
  const abort = new AbortController();
  const pending = marker.start({ signal: abort.signal });
  setImmediate(() => abort.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(marker.child, null);
});

test('unexpected marker exit immediately aborts in-flight work and rejects more input', async () => {
  const { marker, child } = nativeDouble();
  await marker.start();
  let interrupted = false;
  marker.signal.addEventListener('abort', () => { interrupted = true; });
  child.exit();
  assert.equal(interrupted, true);
  assert.equal(marker.signal.reason.code, 'indicator_exited');
  assert.throws(() => marker.assertActive(), { code: 'indicator_not_active' });
  await marker.stop();
});

test('protocol output limits remain enforced after readiness', async () => {
  const { marker, child } = nativeDouble();
  await marker.start();
  child.stdout.write('x'.repeat(8193));
  assert.equal(marker.signal.aborted, true);
  assert.equal(marker.signal.reason.code, 'indicator_output_limit');
  await marker.stop();
});

test('EOF gets a bounded grace period, then owned child kill is confirmed', async () => {
  const { marker, child } = nativeDouble({ eofExit: false });
  await marker.start();
  await marker.stop();
  assert.equal(child.kills, 1);
  assert.equal(marker.child, null);
});

test('an unconfirmed process exit is explicit and retains the owned child', async () => {
  const { marker, child } = nativeDouble({ eofExit: false, killExit: false });
  await marker.start();
  await assert.rejects(marker.stop(), { code: 'indicator_stop_unconfirmed' });
  assert.equal(marker.child, child);
  assert.throws(() => marker.assertActive(), { code: 'indicator_not_active' });
  child.exit();
  await marker.stop();
});

test('integrity checks reject source drift, output corruption and missing manifests', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-indicator-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('trace-indicator-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const binary = path.join(root, 'build', 'bin', OUTPUTS[0]);
  await assert.rejects(verifyIndicatorFiles(binary, root), { code: 'indicator_unavailable' });
  for (const name of SOURCES) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), `source:${name}`); }
  await fs.mkdir(path.dirname(binary), { recursive: true });
  const files = {};
  for (const name of OUTPUTS) { const data = Buffer.from(`output:${name}`); await fs.writeFile(path.join(path.dirname(binary), name), data); files[name] = createHash('sha256').update(data).digest('hex'); }
  const manifestPath = path.join(root, 'build', 'manifest.json');
  const manifest = { version: 1, sources: await indicatorSourceHashes(root), files };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  assert.deepEqual(await verifyIndicatorFiles(binary, root), { available: true, integrity: 'verified', protocol: 1 });
  await fs.appendFile(path.join(root, SOURCES[0]), 'changed');
  await assert.rejects(verifyIndicatorFiles(binary, root), { code: 'indicator_stale' });
  manifest.sources = await indicatorSourceHashes(root);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.appendFile(binary, 'changed');
  await assert.rejects(verifyIndicatorFiles(binary, root), { code: 'indicator_integrity' });
});
