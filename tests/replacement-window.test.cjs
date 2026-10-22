'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const driver = require('../scripts/accept-replacement-window.cjs');
const common = require('../scripts/replacement-acceptance-common.cjs');

const display = () => ({ monitors: 1, displays: [{ device: 'synthetic-display', primary: true, dpi: 144, bounds: { x: -200, y: 0, width: 1920, height: 1080 } }] });
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-replacement-window-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'trace-replacement-window-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
function simulation(root, settings = {}) {
  const events = [], target = { id: '10', pid: 123, processCreationTime: '1001', sessionId: 1, title: 'owned-synthetic-fixture' };
  const state = { count: 0, text: '', dialogOpen: false, minimized: false, revision: 1, windowX: -180, windowY: 30, windowWidth: 400, windowHeight: 300 };
  let closed = false, observation = 0, lastFrame;
  function frame(restore = false) {
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(400, 16); png.writeUInt32BE(300, 20);
    return { observationId: `frame-${++observation}`, window: target, bounds: { x: state.windowX, y: state.windowY, width: 400, height: 300 },
      elements: [{ id: 'counter', name: 'Increment counter', enabled: true, bounds: { x: state.windowX + 50, y: state.windowY + 30, width: 100, height: 40 } }],
      ...(restore ? { preparation: [{ step: 'restore', status: 'restored' }] } : {}), screenshot: { data: png.toString('base64'), width: 400, height: 300 } };
  }
  const chain = { node: { pid: 200, parent: process.pid, name: 'node.exe', created: 'node-generation', sessionId: target.sessionId },
    supervisor: { pid: 201, parent: 200, name: 'TraceSupervisor.exe', created: 'native-generation', sessionId: target.sessionId },
    marker: { pid: 202, parent: 201, name: 'TraceActivityIndicator.exe', created: 'marker-generation', sessionId: target.sessionId } };
  if (settings.sessionRole) chain[settings.sessionRole].sessionId = settings.sessionId;
  const connection = { pid: 200,
    async call(method, args) {
      events.push(method);
      if (method === 'doctor') return { ready: true };
      if (method === 'list_windows') return { windows: [target] };
      if (method === 'open_session') return { sessionId: 'session' };
      if (method === 'close_session') { if (settings.closeSessionError) throw common.failure('close_failed', 'Injected close failure.'); return { closed: true }; }
      if (method === 'observe') { const restored = state.minimized; state.minimized = false; lastFrame = frame(restored); return lastFrame; }
      if (method === 'act' && args.action.type === 'invoke') {
        assert.ok(state.minimized || lastFrame.bounds.x !== state.windowX || lastFrame.bounds.y !== state.windowY, 'Stale action must precede refresh.');
        events.push('stale-invoke'); return { outcome: settings.wrongStale ? 'unknown' : 'not_dispatched', error: { code: 'window_moved' } };
      }
      if (method === 'act' && args.action.type === 'click') {
        assert.deepEqual(args.action, { type: 'click', x: 100, y: 50 }); assert.equal(state.minimized, false);
        events.push('coordinate-click'); state.count++; lastFrame = frame(); return { outcome: 'completed', observation: lastFrame };
      }
      throw new Error(`Unexpected method ${method}`);
    },
    async close() { events.push('connection-close'); if (settings.connectionError) throw common.failure('connection_close_failed', 'Injected teardown failure.'); },
  };
  const deps = { runtimeRoot: path.join(root, 'private'), verify: async () => { events.push('verify'); },
    sourceHashes: async () => ({ baseCommit: 'synthetic', files: { 'synthetic-source': 'same' } }),
    command: async args => {
      if (args[0] === 'display') return display();
      if (args[0] === 'status') return { recoveryRequired: false };
      if (args[0] === 'input-access') return { observable: true, foregroundPid: 1 };
      if (args[0] === 'identity') return { pid: target.pid, processCreationTime: target.processCreationTime, session: target.sessionId };
      if (args[0] === 'keystate') { events.push(`keys-${closed ? 'after' : 'before'}-fixture-close`); return { down: settings.initialHeld ? [32] : [] }; }
      throw new Error('Unexpected native command');
    },
    waitFor: async (work, predicate) => { const value = await work(); assert.equal(predicate(value), true); return value; },
    delay: async () => {}, connect: async () => connection, readChain: async () => chain,
    waitIdentityExit: async identity => { events.push(`exit-${identity.name}`); return true; },
    fixture: async () => {
      events.push('fixture-start');
      return { pid: target.pid, title: target.title, sha256: 'synthetic-binary', state: async () => ({ ...state }),
        async command(op, predicate) {
          events.push(`fixture-${op}`); if (op === 'move') { state.windowX += 80; state.windowY += 40; } else state.minimized = true;
          assert.equal(predicate(state), true); return { ...state };
        },
        async close() { events.push('fixture-close'); closed = true; return { exited: true }; } };
    },
    bridge: async () => ({ ...target, minimized: state.minimized,
      windowBounds: { x: state.windowX, y: state.windowY, width: state.windowWidth, height: state.windowHeight },
      frameBounds: { x: state.windowX, y: state.windowY, width: state.windowWidth, height: state.windowHeight } }),
  };
  return { events, state, deps, frame, target };
}

test('replacement plan/import is pure, has a new fixed ID and cannot infer an owner decision', async () => {
  const result = await driver.run({}, { command: () => { throw new Error('Plan must not inspect native/UI state.'); } });
  assert.equal(result.caseId, 'R3-WINDOW-COORDINATES'); assert.deepEqual(result.replaces, ['A3-WINDOW']);
  assert.equal(result.ownerDecision, null); assert.equal(result.expected.maximumPrimaryClicks, 2);
  assert.throws(() => driver.parseArgs(['out', '--live']), { code: 'owner_decision_required' });
  await assert.rejects(driver.run({ mode: 'live', directory: 'out' }), { code: 'owner_decision_required' });
  assert.throws(() => driver.parseArgs(['--plan', '--attempt', '3']), { code: 'invalid_plan' });
  assert.throws(() => driver.parseArgs(['out', '--live', '--owner-decision', 'decision', '--attempt', '2']), { code: 'invalid_retry' });
});

test('replacement corrective evidence must match the new case, owner decision, original attempt and unfinished status', async t => {
  const root = await workspace(t), prior = path.join(root, 'prior'); await fs.mkdir(prior);
  const options = { caseId: driver.CASE, attempt: 2, ownerDecision: 'recorded owner reference', prior, change: 'Source fix' };
  const valid = { planContract: 1, caseId: driver.CASE, attempt: 1, ownerDecision: options.ownerDecision, status: 'blocked' };
  for (const bad of [{ ...valid, caseId: 'A3-WINDOW' }, { ...valid, attempt: 2 }, { ...valid, status: 'pass' }, { ...valid, ownerDecision: 'other' }]) {
    await fs.writeFile(path.join(prior, 'receipt.json'), JSON.stringify(bad)); await assert.rejects(common.checkPrior(options), { code: 'invalid_retry' });
  }
  await fs.writeFile(path.join(prior, 'receipt.json'), JSON.stringify(valid)); assert.equal((await common.checkPrior(options)).status, 'blocked');
});

test('native ownership chain rejects direct Node markers, duplicate supervisors and unrelated Node generations', () => {
  const node = { pid: 10, parent: 1, name: 'node.exe', created: 'node' }, native = { pid: 11, parent: 10, name: 'TraceSupervisor.exe', created: 'native' };
  const marker = { pid: 12, parent: 11, name: 'TraceActivityIndicator.exe', created: 'marker' };
  assert.equal(common.ownershipChain([node, native, marker], 10, 1).marker.pid, 12);
  assert.throws(() => common.ownershipChain([node, native, { ...marker, parent: 10 }], 10, 1), { code: 'owner_identity_changed' });
  assert.throws(() => common.ownershipChain([node, native, { ...native, pid: 13 }, marker], 10, 1), { code: 'owner_identity_changed' });
  assert.throws(() => common.ownershipChain([{ ...node, parent: 2 }, native, marker], 10, 1), { code: 'owner_identity_changed' });
  assert.throws(() => common.ownershipChain([node, native, marker], 10, 1, 'previous-generation'), { code: 'owner_identity_changed' });
});

test('new window route performs stale-before-fresh coordinate hits and closes native work before fixture', async t => {
  const root = await workspace(t), mock = simulation(root);
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'evidence'), ownerDecision: 'test-only injected decision; no live UI' }, mock.deps);
  assert.equal(result.status, 'pass'); assert.equal(result.transitions.length, 2); assert.equal(mock.state.count, 2);
  assert.deepEqual(mock.events.filter(value => /^(fixture-move|fixture-minimize|stale-invoke|coordinate-click)$/.test(value)),
    ['fixture-move', 'stale-invoke', 'coordinate-click', 'fixture-minimize', 'stale-invoke', 'coordinate-click']);
  const closeAt = mock.events.indexOf('fixture-close');
  assert.ok(mock.events.indexOf('connection-close') < closeAt); assert.ok(mock.events.indexOf('exit-TraceSupervisor.exe') < closeAt);
  assert.equal(mock.events.includes('keys-after-fixture-close'), false);
  assert.equal(result.cleanup.ownedHelpersExited, true); assert.ok(result.completedAt);
  for (const role of ['node', 'supervisor', 'marker']) assert.equal(result.ownership[role].sessionId, result.target.sessionId);
  const disk = JSON.parse(await fs.readFile(path.join(root, 'evidence/receipt.json'), 'utf8')); assert.equal(disk.status, 'pass');
});

test('missing or different Windows session on any window owner blocks all transition input and retains cleanup', async t => {
  const root = await workspace(t);
  for (const role of ['node', 'supervisor', 'marker']) for (const sessionId of [undefined, 2]) {
    const mock = simulation(root, { sessionRole: role, sessionId });
    const result = await driver.run({ mode: 'live', directory: path.join(root, `${role}-${sessionId}`), ownerDecision: 'injected test-only decision' }, mock.deps);
    assert.equal(result.status, 'fail'); assert.equal(result.error.code, 'owner_identity_changed');
    assert.equal(mock.events.includes('fixture-move'), false); assert.equal(mock.events.includes('coordinate-click'), false);
    assert.equal(result.cleanup.ownedHelpersExited, true); assert.equal(result.cleanup.fixture.exited, true); assert.ok(result.completedAt);
  }
});

test('unknown stale result halts primary clicks and still writes a terminal cleanup receipt', async t => {
  const root = await workspace(t), mock = simulation(root, { wrongStale: true, closeSessionError: true, connectionError: true });
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'evidence'), ownerDecision: 'test-only injected decision' }, mock.deps);
  assert.equal(result.status, 'fail'); assert.equal(mock.state.count, 0); assert.equal(mock.events.includes('coordinate-click'), false);
  assert.ok(result.cleanup.sessionError); assert.ok(result.cleanup.connectionError); assert.equal(result.cleanup.fixture.exited, true);
  assert.ok(JSON.parse(await fs.readFile(path.join(root, 'evidence/receipt.json'), 'utf8')).completedAt);
});

test('pre-existing held input remains an environment block without launching or releasing owned input', async t => {
  const root = await workspace(t), mock = simulation(root, { initialHeld: true });
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'evidence'), ownerDecision: 'test-only injected decision' }, mock.deps);
  assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'input_busy'); assert.equal(mock.events.includes('fixture-start'), false);
  assert.equal(result.cleanup.noOwnedUiOrInputStarted, true);
});

test('pixel mapping and independent geometry reject stale origin, changed generation and changed capture bounds', () => {
  const mock = simulation('synthetic'); const observed = mock.frame();
  assert.deepEqual(driver.center(observed), { x: 100, y: 50 });
  assert.throws(() => driver.center({ ...observed, bounds: { ...observed.bounds, x: 10000 } }));
  assert.throws(() => driver.assertStale({ outcome: 'not_dispatched', error: { code: 'window_moved' } }, { count: 0 }, { count: 1 }));
  assert.throws(() => common.assertIdentity({ ...mock.target, processCreationTime: 'replacement' }, mock.target));
  const pinned = display(), changed = display(); changed.displays[0].dpi = 96;
  assert.throws(() => common.compareDisplay(changed, pinned), { code: 'display_mismatch' });
});
