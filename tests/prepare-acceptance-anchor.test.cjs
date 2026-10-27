'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const anchor = require('../scripts/prepare-acceptance-anchor.cjs');
const CASE = anchor.CASES[0];
function synthetic() {
  let now = Date.parse('2026-10-22T18:00:00Z'), closed = 0;
  const identity = { id: '10', pid: 20, processCreationTime: '30', sessionId: 1 };
  const calls = [], display = { synthetic: true };
  const deps = { now: () => now, verifyFixture: async () => { calls.push('verify'); return { executable: 'synthetic-only' }; },
    launch: async () => { calls.push('launch'); return { pid: 20, title: 'Owned', close: async () => { closed++; return { exited: true }; } }; },
    windows: async () => [{ ...identity, title: 'Owned' }], bridge: async () => ({ ...identity, foreground: true }),
    command: async args => { calls.push(args[0]); return ({ display, status: { recoveryRequired: false }, keystate: { down: [] },
      'input-access': { observable: true, foregroundPid: 20 }, identity: { pid: 20, processCreationTime: '30', session: 1 } })[args[0]]; },
    compareDisplay: (a, b) => assert.deepEqual(a, b), leaseFree: async () => true, waitExit: async () => true };
  const record = () => ({ schemaVersion: 1, source: 'direct-owner', caseId: CASE, ready: true, confirmedAt: new Date(now).toISOString(),
    anchorOwnership: 'run-owned-child', anchor: { ...identity } });
  const cleanup = () => ({ schemaVersion: 1, source: 'independent-native-cleanup', caseId: CASE, anchor: { ...identity },
    verifiedAt: new Date(now).toISOString(), nativeRequestsSettled: true, downstreamStarted: true,
    ownedProcesses: [{ pid: 50, created: 'exact-generation', sessionId: 1 }] });
  return { deps, identity, calls, record, cleanup, closed: () => closed, advance: ms => { now += ms; } };
}
test('import and plan require no execution dependencies or claims', async () => {
  const source = await fs.readFile(require.resolve('../scripts/prepare-acceptance-anchor.cjs'), 'utf8');
  const module = { exports: {} }, calls = [];
  require('node:vm').runInNewContext(source, { module, __dirname: path.dirname(require.resolve('../scripts/prepare-acceptance-anchor.cjs')),
    require: name => {
      calls.push(name);
      if (name === 'node:fs/promises') return new Proxy({}, { get: () => () => { throw new Error('Import/plan attempted I/O'); } });
      if (name === './continuation-adapter.cjs') return require('../scripts/continuation-adapter.cjs');
      assert.ok(['node:path', 'node:crypto'].includes(name), `Import eagerly loaded execution dependency ${name}`);
      return require(name);
    } });
  const imported = module.exports;
  assert.equal(imported.plan().claimsAttempt, false);
  assert.equal(imported.plan().inputActions, 0);
  assert.equal((await imported.main(['--plan'])).claimsAttempt, false);
  assert.equal(calls.some(name => name.includes('child_process')), false);
  assert.throws(() => anchor.parse(['--start', '--case', 'CLIPBOARD']), { code: 'anchor_case_required' });
  assert.throws(() => anchor.parse(['--close', '--case', CASE, '--id', '../escape']), { code: 'anchor_id_required' });
});
test('prepared verification precedes launch and exact discovery rejects duplicate or changed generations', async () => {
  const data = synthetic(), owner = await anchor.createOwner({ id: 'synthetic', caseId: CASE, directory: 'unused' }, data.deps);
  assert.deepEqual(data.calls.slice(0, 3), ['verify', 'display', 'launch']);
  assert.deepEqual(owner.status().anchor, data.identity);
  assert.equal(owner.status().readiness, null);
  assert.equal(data.closed(), 0);
  for (const override of [
    { windows: async () => [{ ...data.identity, title: 'Owned' }, { ...data.identity, title: 'Owned' }] },
    { bridge: async () => ({ ...data.identity, processCreationTime: 'reused' }) },
    { command: async () => ({ pid: 20, processCreationTime: 'reused', session: 1 }) },
  ]) await assert.rejects(anchor.discover({ pid: 20, title: 'Owned' }, { ...data.deps, ...override }));
  const held = await anchor.createOwner({ id: 'synthetic', caseId: CASE, directory: 'unused' }, { ...data.deps, windows: async () => [] });
  assert.equal(held.status().state, 'held');
  await assert.rejects(held.confirm(data.record()), { code: 'anchor_not_available' });
  assert.equal(data.closed(), 0);
});
test('confirmation requires fresh post-anchor direct owner evidence and one exact idle preflight', async () => {
  const data = synthetic(), owner = await anchor.createOwner({ id: 'synthetic', caseId: CASE, directory: 'unused' }, data.deps);
  const stale = data.record(); stale.confirmedAt = '2026-10-22T17:59:59Z';
  await assert.rejects(owner.confirm(stale), { code: 'anchor_confirmation_predates_window' });
  for (const change of [r => r.source = 'poll', r => r.caseId = anchor.CASES[1], r => r.anchor.pid = 21,
    r => r.anchor.processCreationTime = '31', r => r.confirmedAt = '2026-10-22T18:00:01Z']) {
    const record = data.record(); change(record); await assert.rejects(owner.confirm(record));
  }
  const record = data.record(); data.advance(60001); await assert.rejects(owner.confirm(record));
  const confirmed = await owner.confirm(data.record());
  assert.deepEqual(confirmed.record.anchor, data.identity);
  assert.equal(data.calls.filter(value => value === 'input-access').length, 1);
  assert.ok(owner.status().readiness);
  data.advance(60001); assert.equal(owner.status().readiness, null);
  assert.equal(data.closed(), 0);
});
test('held input or changed foreground invalidates confirmation without closing or performing an action', async () => {
  for (const [verb, replacement] of [['keystate', { down: [1] }], ['input-access', { observable: true, foregroundPid: 99 }]]) {
    const data = synthetic(), original = data.deps.command;
    data.deps.command = args => args[0] === verb ? replacement : original(args);
    const owner = await anchor.createOwner({ id: 'synthetic', caseId: CASE, directory: 'unused' }, data.deps);
    await assert.rejects(owner.confirm(data.record())); assert.equal(owner.status().readiness, null); assert.equal(data.closed(), 0);
  }
});
test('explicit close independently verifies downstream exits and input/recovery/lease before retained-handle close', async () => {
  const data = synthetic(), events = [], original = data.deps.command;
  data.deps.waitExit = async identity => { events.push(['exit', identity.pid]); return true; };
  data.deps.command = args => { events.push(args[0]); return original(args); };
  const owner = await anchor.createOwner({ id: 'synthetic', caseId: CASE, directory: 'unused' }, data.deps);
  events.length = 0;
  assert.equal((await owner.close(data.cleanup())).state, 'closed');
  assert.deepEqual(events, [['exit', 50], 'identity', 'status', 'keystate']);
  assert.equal(data.closed(), 1);
  await assert.rejects(owner.close(data.cleanup()), { code: 'anchor_already_closed' });
  assert.equal(data.closed(), 1);
});
test('exact exit verification keeps arbitrary native input children live and rejects session uncertainty', async () => {
  const identity = { pid: 44, created: 'exact-generation', sessionId: 1 };
  let now = 0;
  const deps = { list: async () => [{ ...identity, name: 'arbitrary-input-child.exe' }], now: () => now, sleep: async ms => { now += ms; }, timeoutMs: 200 };
  assert.equal(await anchor.waitOwnedExit(identity, deps), false);
  assert.equal(await anchor.waitOwnedExit(identity, { ...deps, list: async () => [] }), true);
  assert.equal(await anchor.waitOwnedExit(identity, { ...deps, list: async () => [{ ...identity, created: 'reused-pid' }] }), true);
  await assert.rejects(anchor.waitOwnedExit(identity, { ...deps, list: async () => [{ ...identity, sessionId: 2 }] }), { code: 'anchor_cleanup_identity_invalid' });
});
test('unknown cleanup, generation drift, held input and unavailable queries preserve owned anchor', async () => {
  for (const kind of ['unsettled', 'wrong-anchor', 'empty-identities', 'exit-unknown', 'generation', 'held', 'recovery', 'lease', 'query-error']) {
    const data = synthetic(), owner = await anchor.createOwner({ id: 'synthetic', caseId: CASE, directory: 'unused' }, data.deps);
    const cleanup = data.cleanup(), original = data.deps.command;
    if (kind === 'unsettled') cleanup.nativeRequestsSettled = false;
    if (kind === 'wrong-anchor') cleanup.anchor.processCreationTime = '31';
    if (kind === 'empty-identities') cleanup.ownedProcesses = [];
    if (kind === 'exit-unknown') data.deps.waitExit = async () => false;
    if (kind === 'generation') data.deps.bridge = async () => ({ ...data.identity, processCreationTime: '31' });
    if (kind === 'held') data.deps.command = args => args[0] === 'keystate' ? { down: [1] } : original(args);
    if (kind === 'recovery') data.deps.command = args => args[0] === 'status' ? { recoveryRequired: true } : original(args);
    if (kind === 'lease') data.deps.leaseFree = async () => false;
    if (kind === 'query-error') data.deps.command = async () => { throw new Error('private native error'); };
    await assert.rejects(owner.close(cleanup)); assert.notEqual(owner.status().state, 'closed'); assert.equal(data.closed(), 0);
  }
});
test('crashed owner leaves private state as context and command timeout never terminates a cached PID', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-anchor-crash-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', directory = anchor.sessionFolder(id, root);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ ownerPid: 123, state: 'open' }));
  await assert.rejects(anchor.request({ mode: 'status', id, caseId: CASE }, { root, timeoutMs: 1, sleep: async () => {} }), { code: 'anchor_owner_unresponsive' });
  const files = await fs.readdir(directory);
  assert.ok(files.some(name => name.startsWith('request-')));
  assert.equal(files.some(name => name.startsWith('reply-')), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'state.json'))).ownerPid, 123);
});
test('atomic channel reaches the same owner and closes only on a fresh explicit cleanup message', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-anchor-channel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = synthetic(); let client;
  await anchor.serve({ caseId: CASE }, { root, deps: data.deps, output: status => {
    client = (async () => {
      const base = { id: status.id, caseId: CASE };
      const response = await anchor.request({ ...base, mode: 'status' }, { root });
      assert.deepEqual(response.value.anchor, data.identity);
      await fs.mkdir(path.join(root, 'evidence'));
      const ownerRef = 'evidence/synthetic-owner.json'; await fs.writeFile(path.join(root, ownerRef), JSON.stringify(data.record()));
      const ready = await anchor.request({ ...base, mode: 'confirm-ready', ownerRecord: ownerRef }, { root });
      assert.equal(ready.ok, true);
      const published = await require('../scripts/continuation-adapter.cjs').evidence(ready.value.readinessReference.ref, root);
      assert.equal(published.descriptor.sha256, ready.value.readinessReference.sha256);
      assert.deepEqual(published.value.anchor, data.identity);
      const wrong = await anchor.request({ ...base, caseId: anchor.CASES[1], mode: 'status' }, { root });
      assert.equal(wrong.ok, false); assert.equal(wrong.ownerRetained, true);
      const malformedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', directory = anchor.sessionFolder(status.id, root);
      await fs.writeFile(path.join(directory, `request-${malformedId}.json`), 'malformed JSON');
      const healthy = await anchor.request({ ...base, mode: 'status' }, { root });
      assert.equal(healthy.ok, true);
      const malformedReply = JSON.parse(await fs.readFile(path.join(directory, `reply-${malformedId}.json`), 'utf8'));
      assert.equal(malformedReply.ok, false); assert.equal(malformedReply.ownerRetained, true);
      const ref = 'evidence/synthetic-cleanup.json';
      await fs.writeFile(path.join(root, ref), JSON.stringify(data.cleanup()));
      const closed = await anchor.request({ ...base, mode: 'close', cleanupRef: ref }, { root });
      assert.equal(closed.value.state, 'closed');
    })();
  } });
  await client; assert.equal(data.closed(), 1);
});
