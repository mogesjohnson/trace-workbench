'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../scripts/continuation-adapter.cjs');
const CASE = 'A32-QUARANTINE-ACK-TYPING';
test('continuation options keep lifetime3/4 and cannot mix historical reset flags', () => {
  assert.equal(adapter.parse(['--plan', '--continuation', '1'], CASE).lifetimeAttemptOrdinal, 3);
  for (const args of [['--continuation', '3'], ['--continuation', '1', '--attempt', '1'], ['--continuation', '2'], ['--live', '--continuation', '1']]) assert.throws(() => adapter.parse(args, CASE));
});
test('continuation options reject unknown modes and unsafe readiness references', () => {
  assert.equal(adapter.options({ continuationAttempt: 1 }, CASE).mode, 'plan');
  assert.throws(() => adapter.options({ continuationAttempt: 1, mode: 'pretend-live' }, CASE));
  for (const ref of ['', '../private.json', 'evidence/../private.json', 'C:/private.json'])
    assert.throws(() => adapter.options({ continuationAttempt: 1, idleReadinessRef: ref }, CASE));
  assert.equal(adapter.parse(['--plan', '--continuation', '2', '--continuation-prior', 'evidence/prior.json', '--change', 'Actual source fix'], CASE).lifetimeAttemptOrdinal, 4);
});
function fixture() {
  const now = Date.parse('2026-10-22T13:50:00Z'), anchor = { id: '10', pid: 20, processCreationTime: '30', sessionId: 1 };
  const record = { schemaVersion: 1, source: 'direct-owner', caseId: CASE, ready: true, confirmedAt: new Date(now).toISOString(), anchorOwnership: 'run-owned-child', anchor };
  const calls = [], display = { synthetic: true };
  const deps = { now: () => now, compareDisplay: (actual, pinned) => assert.deepEqual(actual, pinned), leaseFree: async () => true,
    bridge: async () => ({ ...anchor, foreground: true }), command: async args => {
      calls.push(args[0]); return ({ display, status: { recoveryRequired: false }, 'input-access': { observable: true, foregroundPid: anchor.pid },
        identity: { pid: anchor.pid, processCreationTime: anchor.processCreationTime, session: anchor.sessionId }, keystate: { down: [] } })[args[0]];
    } };
  return { record, caseId: CASE, anchor, now, deps, calls, pinnedDisplay: display };
}
test('actual idle readiness is separate from approval, exact anchor bound and limited to60s', () => {
  const data = fixture(); assert.equal(adapter.validateReadiness(data.record, data).source, 'direct-owner');
  for (const change of [r => r.source = 'approved', r => r.ready = false, r => r.caseId = 'OTHER', r => r.confirmedAt = '2026-10-22T04:00:00Z',
    r => r.anchor.processCreationTime = '31', r => r.anchorOwnership = 'title-only']) {
    const record = structuredClone(data.record); change(record); assert.throws(() => adapter.validateReadiness(record, data));
  }
});
test('readiness boundary rejects future, negative session and expiration during final sampling', async () => {
  const data = fixture();
  adapter.validateReadiness(data.record, { ...data, now: data.now + 60000 });
  assert.throws(() => adapter.validateReadiness(data.record, { ...data, now: data.now + 60001 }));
  assert.throws(() => adapter.validateReadiness(data.record, { ...data, now: data.now - 1 }));
  const record = structuredClone(data.record); record.anchor.sessionId = -1;
  assert.throws(() => adapter.validateReadiness(record, { ...data, anchor: record.anchor }));
  let samples = 0;
  await assert.rejects(adapter.idlePreflight(data, { ...data.deps, now: () => data.now + (samples++ ? 60001 : 0) }));
});

test('prepared fixture consumption verifies exact source/output sets without builds or UI', async () => {
  const path = require('node:path'), { digest } = require('../scripts/live-acceptance-continuation.cjs');
  const root = path.resolve('synthetic-prepared-workspace'), folder = path.join(root, '.runtime/computer-fixture');
  const sources = ['tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj', 'scripts/smoke-computer-live.cjs'];
  const outputs = ['TraceComputerFixture.exe', 'TraceComputerFixture.dll', 'TraceComputerFixture.runtimeconfig.json', 'TraceComputerFixture.deps.json'];
  const files = new Map();
  const hashes = (names, base) => Object.fromEntries(names.map(name => { const bytes = Buffer.from(`synthetic-${name}`); files.set(path.join(base, name), bytes); return [name, digest(bytes)]; }));
  const manifest = { schemaVersion: 1, uiCreated: 0, inputActions: 0, sources: hashes(sources, root), files: hashes(outputs, path.join(folder, 'bin')) };
  const manifestPath = path.join(folder, 'prepared-manifest.json'), update = () => files.set(manifestPath, Buffer.from(JSON.stringify(manifest))); update();
  const io = { readFile: async name => files.get(name), realpath: async name => name, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }) };
  assert.equal((await adapter.preparedFixture(root, io)).executable, path.join(folder, 'bin/TraceComputerFixture.exe'));
  files.set(path.join(folder, 'bin', outputs[1]), Buffer.from('changed output'));
  await assert.rejects(adapter.preparedFixture(root, io), { code: 'continuation_preflight_required' });
  manifest.files[outputs[1]] = digest(Buffer.from('changed output')); manifest.files['unexpected.exe'] = digest(Buffer.from('extra')); update();
  await assert.rejects(adapter.preparedFixture(root, io));
  delete manifest.files['unexpected.exe']; update();
  await assert.rejects(adapter.preparedFixture(root, { ...io, realpath: async name => `${name}.redirected` }));
});
test('runtime freeze reads native output manifests and every pinned engine dependency without execution', async () => {
  const calls = [], io = { readFile: async name => { calls.push(name); return Buffer.from(`synthetic:${name}`); } };
  const snapshot = await adapter.runtimeSnapshot(require('node:path').resolve('synthetic-runtime'), io);
  assert.equal(Object.keys(snapshot).length, 18); assert.equal(calls.length, 18);
  assert.equal(Object.keys(snapshot).some(name => name.includes('C:') || name.startsWith('.runtime')), false);
  assert.equal(Object.values(snapshot).every(hash => /^[a-f0-9]{64}$/.test(hash)), true);
  assert.ok(snapshot['pinned-engine/libSkiaSharp.dll']); assert.ok(snapshot['window-bridge/manifest']);
});
test('read-only final preflight requires exact foreground, accessible all-up input and free lease', async () => {
  const data = fixture(); const result = await adapter.idlePreflight(data, data.deps); assert.deepEqual(result.keysDown, []);
  assert.deepEqual(data.calls, ['display', 'status', 'input-access', 'identity', 'keystate']);
  for (const [verb, value] of [['status', { recoveryRequired: true }], ['input-access', { observable: true, foregroundPid: 99 }],
    ['identity', { pid: 20, processCreationTime: 'reused', session: 1 }], ['keystate', { down: [1] }]]) {
    const original = data.deps.command;
    await assert.rejects(adapter.idlePreflight(data, { ...data.deps, command: args => args[0] === verb ? value : original(args) }));
  }
  await assert.rejects(adapter.idlePreflight(data, { ...data.deps, leaseFree: async () => false }));
});
