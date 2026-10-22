'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const driver = require('../scripts/accept-replacement-glow.cjs');
const common = require('../scripts/replacement-acceptance-common.cjs');

test('default capture boundary accepts actual .NET byte-array serialization and exact integer RGB only', () => {
  // System.Text.Json serializes new[] { Color.R, Color.G, Color.B } (System.Byte[]) as canonical base64.
  const expected = { filename: 'glow-active-1.png', sha256: 'a'.repeat(64), width: 2880, height: 1800 };
  const actualShape = { file: expected.filename, sha256: expected.sha256, width: 2880, height: 1800,
    method: 'public-win32-bitblt-captureblt', layeredWindows: true, sanitizedInteriorRgb: 'GBwo' };
  for (const sanitizedInteriorRgb of ['GBwo', [24, 28, 40]]) {
    const value = { ...actualShape, sanitizedInteriorRgb }, checked = driver.captureMetadata(value, expected);
    assert.equal(checked.interiorBackgroundVerified, true); assert.deepEqual(checked.captureMetadata, value);
    assert.equal(checked.captureMetadataSha256, common.digest(Buffer.from(JSON.stringify(value))));
  }
  for (const rgb of [null, undefined, '', 'GBwo=', 'GBwo\n', ' GBwo', 'GBwp', 'GBw=', 'GBwoAA==', ['24', 28, 40], [24, 28], [24, 28, 40, 0], [24, 28, 41], { 0: 24, 1: 28, 2: 40 }])
    assert.throws(() => driver.captureMetadata({ ...actualShape, sanitizedInteriorRgb: rgb }, expected), { code: 'capture_metadata_invalid' });
  for (const change of [{ file: 'other.png' }, { sha256: 'b'.repeat(64) }, { width: 1920 }, { height: 1080 }, { method: 'unknown' }, { layeredWindows: false }])
    assert.throws(() => driver.captureMetadata({ ...actualShape, ...change }, expected), { code: 'capture_metadata_invalid' });
});

test('owned fixture state rejects stale JSON after retained child exit, including exit during read', async t => {
  const root = await workspace(t), status = { ready: true, count: 1, mouseUpCount: 0 };
  await fs.writeFile(path.join(root, 'status.json'), JSON.stringify(status));
  for (const child of [{ exitCode: 10, signalCode: null }, { exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }])
    await assert.rejects(driver.readFixtureState(root, child), { code: 'fixture_process_exited' });
  const child = { exitCode: null, signalCode: null };
  assert.deepEqual(await driver.readFixtureState(root, child), status);
  await assert.rejects(driver.readFixtureState(root, child, () => undefined, async () => {
    child.exitCode = 10; return JSON.stringify(status);
  }), { code: 'fixture_process_exited' });
  await assert.rejects(driver.readFixtureState(root, { exitCode: null, signalCode: null }, () => new Error('spawn')),
    { code: 'fixture_start_failed' });
  assert.equal(await driver.readFixtureState(path.join(root, 'missing'), { exitCode: null, signalCode: null }), null);
});

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-replacement-glow-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'trace-replacement-glow-'))); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
const display = () => ({ monitors: 1, displays: [{ device: 'synthetic-primary', primary: true, dpi: 144, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] });
function counts(state, count) { for (const key of ['count', 'mouseClickCount', 'activationCount', 'mouseDownCount', 'mouseUpCount']) state[key] = count; }
function simulation(root, settings = {}) {
  const events = [], target = { id: '1234', pid: 123, processCreationTime: '1001', sessionId: 1 };
  const state = { ready: true, pid: 123, windowId: '1234', monitor: display().displays[0].bounds, dpi: 144,
    input: { leftButtonDown: false }, button: { x: 1, y: 496, width: 12, height: 88 } }; counts(state, 0);
  let connectionNumber = 0, fixtureClosed = false;
  const focus = { fixtureForeground: true, foregroundWindowId: target.id, focusedWindowId: '0' };
  const chains = new Map();
  function frame() {
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
    return { window: target, observationId: 'frame', bounds: display().displays[0].bounds, screenshot: { data: png.toString('base64'), width: 1920, height: 1080 } };
  }
  const deps = { runtimeRoot: path.join(root, 'private'), verify: async () => {}, sourceHashes: async () => ({ files: { 'synthetic-source': 'same' }, baseCommit: 'synthetic' }),
    delay: async () => {}, notifyReady: value => { events.push('reference-ready'); assert.ok(value.proofPath); },
    waitFor: async (work, predicate) => { const value = await work(); assert.equal(predicate(value), true); return value; },
    command: async args => {
      if (args[0] === 'display') return display(); if (args[0] === 'status') return { recoveryRequired: false };
      if (args[0] === 'input-access') return { observable: true, foregroundPid: 1 };
      if (args[0] === 'keystate') { events.push(`keys-${fixtureClosed ? 'after' : 'before'}-fixture-close`); return { down: [] }; }
      if (args[0] === 'identity') return { pid: target.pid, processCreationTime: target.processCreationTime, session: target.sessionId };
      throw new Error('Unexpected native command');
    },
    bridge: async () => ({ ...target, foreground: true, frameBounds: display().displays[0].bounds }), leaseFree: async () => { events.push('lease-free'); return true; },
    readChain: async connection => chains.get(connection.pid), waitIdentityExit: async identity => { events.push(`exit-${identity.name}`); return true; },
    connect: async () => {
      const number = ++connectionNumber, pid = 200 + number * 10;
      chains.set(pid, { node: { pid, name: 'node.exe', created: `node-${number}`, sessionId: target.sessionId }, supervisor: { pid: pid + 1, name: 'TraceSupervisor.exe', created: `native-${number}`, sessionId: target.sessionId }, marker: { pid: pid + 2, name: 'TraceActivityIndicator.exe', created: `marker-${number}`, sessionId: target.sessionId } });
      if (settings.sessionRole && number === (settings.sessionConnection ?? 1)) chains.get(pid)[settings.sessionRole].sessionId = settings.sessionId;
      return { pid,
        call: async (method, args) => {
          events.push(`${method}-${number}`);
          if (method === 'doctor') return { ready: true };
          if (method === 'list_windows') return { windows: [target] };
          if (method === 'open_session') return { sessionId: `session-${number}`, activityIndicator: { monitors: 1, owner: 'native-supervisor' } };
          if (method === 'close_session') return { closed: true };
          if (method === 'observe') return frame();
          if (method === 'act') { assert.deepEqual(args.action, { type: 'click', x: 7, y: 540 }); events.push('one-trace-click'); counts(state, 2);
            state.lastMouseClick = { button: 'Left', clicks: 1, screenX: 7, screenY: 540, atUtc: new Date().toISOString() };
            return { outcome: 'completed', observation: frame() }; }
          throw new Error(`Unexpected MCP method ${method}`);
        }, close: async () => events.push(`connection-close-${number}`), killAbruptly: async () => events.push('private-node-self-death'),
      };
    },
    waitReference: async (fixture, pending) => {
      events.push('one-external-reference-click'); if (settings.referenceError) throw common.failure('reference_missing', 'Injected missing external executor.');
      counts(state, 1);
      state.lastMouseClick = { button: 'Left', clicks: 1, screenX: 7, screenY: 540, atUtc: new Date().toISOString() };
      return driver.assertReferenceProof({ source: 'reference-executor', executor: pending.executor, operation: 'click', checkpointId: pending.checkpointId,
        windowId: target.id, pid: target.pid, processCreationTime: target.processCreationTime, screenX: pending.point.x, screenY: pending.point.y,
        at: new Date().toISOString(), toolReceiptRef: 'test-only:injected-reference-contract' }, pending);
    },
    fixture: async () => ({ pid: target.pid, sha256: 'synthetic', state: async () => ({ ...state }), focus: async () => ({ ...focus }),
      capture: async (filename, markerPid) => {
        events.push(`capture-${filename}`); if (settings.captureError) throw new Error('Owned fixture command failed: foreign_overlay_above_fixture.');
        const bytes = Buffer.from(`injected synthetic pixel oracle ${filename}; no actual desktop`), expected = { filename, sha256: common.digest(bytes), width: 1920, height: 1080 };
        const metadata = { file: filename, sha256: expected.sha256, width: 1920, height: 1080, method: 'public-win32-bitblt-captureblt', layeredWindows: true, sanitizedInteriorRgb: 'GBwo' };
        return { bytes, ...driver.captureMetadata(metadata, expected), interiorBackgroundVerified: settings.interiorBackgroundVerified ?? true, bands: { width: 1920, height: 1080,
          tintedLeft: markerPid ? 11 : 0, tintedTop: markerPid ? 11 : 0, backgroundLeft: markerPid ? 13 : 24, backgroundTop: markerPid ? 13 : 24 } };
      }, close: async () => { events.push('fixture-close'); fixtureClosed = true; return { exited: true }; } }),
  };
  return { deps, events, state, target };
}

test('glow replacement planning is pure and requires actual owner/reference prerequisites for live launch', async () => {
  const plan = await driver.run({}, { command: () => { throw new Error('Plan must not inspect desktop.'); } });
  assert.equal(plan.caseId, 'R31-GLOW-NATIVE'); assert.deepEqual(plan.replaces, ['A31-GLOW', 'GLOW-LIVE']);
  assert.equal(plan.bounds.referenceClicks, 1); assert.equal(plan.bounds.traceClicks, 1); assert.equal(plan.bounds.referenceWaitMs, 60000);
  await assert.rejects(driver.run({ mode: 'live', directory: 'out' }), { code: 'owner_decision_required' });
  await assert.rejects(driver.run({ mode: 'live', directory: 'out', ownerDecision: 'reference' }), { code: 'reference_missing' });
  assert.throws(() => driver.parseArgs(['--plan', '--reference-executor', '']), { code: 'invalid_plan' });
  assert.throws(() => driver.parseArgs(['--plan', '--reference-executor', 'trace-computer']), { code: 'invalid_plan' });
});

test('reference proof binds the actual executor receipt to exact generation, point, checkpoint and time without leaking checkpoint', () => {
  const pending = { executor: 'reference-executor', checkpointId: 'private-checkpoint', startedAt: '2026-10-21T12:00:00Z',
    target: { id: '100', pid: 200, processCreationTime: '300' }, point: { x: 7, y: 400 } };
  const proof = { source: 'reference-executor', executor: pending.executor, operation: 'click', checkpointId: pending.checkpointId,
    windowId: '100', pid: 200, processCreationTime: '300', screenX: 7, screenY: 400, at: '2026-10-21T12:00:01Z', toolReceiptRef: 'actual-tool-call:reference' };
  assert.equal(JSON.stringify(driver.assertReferenceProof(proof, pending)).includes('private-checkpoint'), false);
  for (const bad of [{ ...proof, source: 'TRACE' }, { ...proof, executor: 'TRACE' }, { ...proof, operation: 'invoke' }, { ...proof, pid: 201 },
    { ...proof, processCreationTime: 'new-generation' }, { ...proof, screenX: 8 }, { ...proof, checkpointId: 'old' },
    { ...proof, at: '2026-10-21T11:00:00Z' }, { ...proof, toolReceiptRef: '' }, { ...proof, toolReceiptRef: 'C:\\private\\receipt' }]) {
    assert.throws(() => driver.assertReferenceProof(bad, pending), { code: 'reference_proof_invalid' });
  }
});

test('injected glow lifecycle requires one external and one TRACE click and exact normal/parent-loss cleanup', async t => {
  const root = await workspace(t), mock = simulation(root);
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'evidence'), ownerDecision: 'injected test-only decision', referenceExecutor: 'external-test-contract' }, mock.deps);
  assert.equal(result.status, 'pass'); assert.equal(mock.state.count, 2);
  assert.equal(mock.events.filter(value => value === 'one-trace-click').length, 1); assert.equal(mock.events.filter(value => value === 'one-external-reference-click').length, 1);
  assert.ok(mock.events.indexOf('one-external-reference-click') < mock.events.indexOf('one-trace-click'));
  assert.equal(mock.events.filter(value => value === 'private-node-self-death').length, 1);
  assert.equal(result.phases.ordinaryClose.helpersExited, true); assert.equal(result.phases.parentLoss.helpersExited, true);
  for (const phase of ['start', 'parentLossStart']) for (const role of ['node', 'supervisor', 'marker'])
    assert.equal(result.phases[phase].ownership[role].sessionId, result.target.sessionId);
  assert.equal(result.frames.some(value => value.label === 'mcp-before-click'), true); assert.equal(result.frames.some(value => value.label === 'mcp-after-click'), true);
  assert.equal(mock.events.includes('keys-after-fixture-close'), false); assert.ok(result.completedAt);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'evidence/receipt.json'), 'utf8')).status, 'pass');
});

test('supplemental glow claims lifetime3 before fixture and consumes actual-reference region adapter only once', async t => {
  for (const interiorBackgroundVerified of [true, false]) {
  const root = await workspace(t), mock = simulation(root, { interiorBackgroundVerified }), physicalDisplay = driver.regionDisplay(display());
  const targetProof = { windowId: mock.target.id, pid: mock.target.pid, processCreationTime: mock.target.processCreationTime, windowsSessionId: 1 };
  mock.state.countOracle = 'left-button-mouseclick-events';
  let checkpoint, claimCount = 0;
  const launch = mock.deps.fixture;
  mock.deps.claimRequest = async () => ({ caseId: driver.CASE });
  mock.deps.claim = async () => { claimCount++; mock.events.push('claim'); return { claimId: 'synthetic-injected-only', historicalAttemptsUsed: 2, continuationAttempt: 1, lifetimeAttemptOrdinal: 3 }; };
  mock.deps.fixture = async (...args) => { assert.equal(claimCount, 1); mock.events.push('fixture-launch'); return launch(...args); };
  mock.deps.notifyReady = value => {
    if (value.phase === 'REFERENCE_READY') checkpoint = value.checkpoint;
  };
  mock.deps.waitSkyObservation = async () => {
    // Real run identity must already be persisted when the external observer starts.
    const running = JSON.parse(await fs.readFile(path.join(root, 'supplemental/receipt.json'), 'utf8'));
    assert.deepEqual(running.target, mock.target);
    mock.events.push('actual-sky-observation');
    return { target: targetProof, display: physicalDisplay, sampledAt: new Date().toISOString(),
      executor: 'Sky', unique: true, elementId: 'traceGlowEdgeButton', elementIndex: 1 };
  };
  mock.deps.measureGlowRegion = (before, active) => {
    assert.match(before.toString(), /before-glow-reference-1/);
    assert.match(active.toString(), /glow-reference-fresh-1/);
    assert.ok(mock.events.indexOf('actual-sky-observation') < mock.events.indexOf('capture-glow-reference-fresh-1.png'));
    return { bounds: { x: 0, y: mock.state.button.y, width: 10, height: mock.state.button.height }, containsTintedPoint: point => point.x === 5 };
  };
  mock.deps.waitRegionReference = async (fixture, actualCheckpoint, proofPath, sampleInput) => {
    assert.equal(actualCheckpoint, checkpoint);
    counts(mock.state, 1); const at = new Date().toISOString();
    for (const key of ['lastMouseDown', 'lastMouseClick', 'lastMouseUp']) mock.state[key] = { button: 'Left', clicks: 1, screenX: 5, screenY: 540, atUtc: at };
    mock.state.lastActivation = { atUtc: at };
    await fs.writeFile(proofPath, JSON.stringify({ source: 'external-sky-accessibility', executor: 'Sky', tool: 'sky.click', operation: 'click',
      mechanism: 'accessibility-mouse', completed: true, synthetic: false, noInvoke: true, checkpointId: checkpoint.checkpointId,
      target: targetProof, display: physicalDisplay, elementId: 'traceGlowEdgeButton', elementIndex: 1,
      toolReceiptRef: 'actual-tool-call:injected-test-data-only', startedAt: at, completedAt: at }));
    // This is injected synthetic test data; it never establishes a live click or inspected real tool receipt.
    return driver.waitRegionReference(fixture, checkpoint, proofPath, sampleInput);
  };
  mock.deps.waitReference = () => assert.fail('The historical center proof cannot supply supplemental Sky evidence.');
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'supplemental'), continuationAttempt: 1,
    decisionRef: 'evidence/synthetic-decision.json', referenceExecutor: 'Sky' }, mock.deps);
  assert.equal(result.attempt, 3); assert.equal(result.lifetimeAttemptOrdinal, 3);
  assert.equal(claimCount, 1); assert.ok(mock.events.indexOf('claim') < mock.events.indexOf('fixture-launch'));
  const privateFolders = await fs.readdir(mock.deps.runtimeRoot), bytes = await fs.readFile(path.join(mock.deps.runtimeRoot, privateFolders[0], 'reference-checkpoint-candidate.json'));
  assert.equal(result.referenceCheckpointCandidate.sha256, common.digest(bytes));
  assert.equal(result.referenceCheckpointCandidate.status, 'candidate-not-validated');
  assert.equal(result.referenceCheckpointCandidate.checkpoint.checkpointId, '<private-checkpoint>');
  assert.equal(result.referenceCheckpointValidation.status, interiorBackgroundVerified ? 'pass' : 'fail');
  for (const frame of result.frames.filter(frame => frame.captureMetadata)) {
    assert.equal(frame.captureMetadata.sanitizedInteriorRgb, 'GBwo');
    assert.equal(frame.captureMetadataSha256, common.digest(Buffer.from(JSON.stringify(frame.captureMetadata))));
  }
  if (!interiorBackgroundVerified) {
    assert.equal(result.status, 'fail'); assert.equal(result.error.code, 'glow_reference_region_invalid');
    assert.equal(mock.state.count, 0); assert.equal(checkpoint, undefined); assert.equal(mock.events.includes('one-trace-click'), false);
    assert.equal(result.referenceCheckpointCandidate.checkpoint.glow.interiorBackgroundVerified, false); continue;
  }
  assert.equal(result.status, 'pass', JSON.stringify(result.error));
  assert.equal(checkpoint.glow.frameLabel, 'glow-reference-fresh');
  assert.equal(checkpoint.glow.frameSha256, result.frames.find(frame => frame.label === 'glow-reference-fresh').sha256);
  assert.deepEqual(result.phases.reference.point, { x: 5, y: 540 }); assert.deepEqual(result.phases.traceClick.point, { x: 7, y: 540 });
  assert.equal(mock.events.filter(item => item === 'one-trace-click').length, 1);
  }
});

test('missing or mismatched glow owner sessions stop clicks or abrupt termination and retain terminal cleanup', async t => {
  const root = await workspace(t);
  for (const role of ['node', 'supervisor', 'marker']) for (const sessionId of [undefined, 2]) for (const sessionConnection of [1, 2]) {
    const mock = simulation(root, { sessionRole: role, sessionId, sessionConnection });
    const result = await driver.run({ mode: 'live', directory: path.join(root, `${role}-${sessionId}-${sessionConnection}`),
      ownerDecision: 'injected test-only decision', referenceExecutor: 'external-test-contract' }, mock.deps);
    assert.equal(result.status, 'fail'); assert.equal(result.error.code, 'owner_identity_changed');
    if (sessionConnection === 1) { assert.equal(mock.events.includes('one-trace-click'), false); assert.equal(mock.events.includes('reference-ready'), false); }
    assert.equal(mock.events.includes('private-node-self-death'), false);
    assert.equal(result.cleanup.ownedHelpersExited, true); assert.equal(result.cleanup.fixture.exited, true); assert.ok(result.completedAt);
  }
});

test('missing external reference halts TRACE click and parent-loss phases but always closes ownership first', async t => {
  const root = await workspace(t), mock = simulation(root, { referenceError: true });
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'evidence'), ownerDecision: 'injected test-only decision', referenceExecutor: 'external-test-contract' }, mock.deps);
  assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'reference_missing');
  assert.equal(mock.events.includes('one-trace-click'), false); assert.equal(mock.events.includes('private-node-self-death'), false);
  assert.ok(mock.events.indexOf('connection-close-1') < mock.events.indexOf('fixture-close')); assert.ok(result.completedAt);
});
test('terminal glow cleanup rejects changed runtime outputs even when source hashes remain unchanged', async t => {
  const root = await workspace(t), mock = simulation(root); let snapshots = 0;
  mock.deps.sourceHashes = async () => ({ files: { source: 'same' }, runtimeOutputs: { supervisor: ++snapshots === 1 ? 'before' : 'changed' } });
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'changed-output'), ownerDecision: 'injected test-only decision', referenceExecutor: 'external-test-contract' }, mock.deps);
  assert.equal(result.status, 'fail'); assert.equal(result.sourcesUnchangedDuringRun, false); assert.equal(result.cleanup.fixture.exited, true);
  assert.equal(mock.events.filter(item => item === 'one-trace-click').length, 1);
});

test('safe desktop capture refusal has three unique capture-only attempts and does not request any click', async t => {
  const root = await workspace(t), mock = simulation(root, { captureError: true });
  const result = await driver.run({ mode: 'live', directory: path.join(root, 'evidence'), ownerDecision: 'injected test-only decision', referenceExecutor: 'external-test-contract' }, mock.deps);
  assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'capture_refused');
  assert.deepEqual(mock.events.filter(value => value.startsWith('capture-')), ['capture-glow-active-1.png', 'capture-glow-active-2.png', 'capture-glow-active-3.png']);
  assert.equal(result.captureRefusals['glow-active'][0].code, 'foreign_overlay_above_fixture'); assert.equal(mock.events.includes('reference-ready'), false);
});

test('focus changes, UIA-only activation and nonreleased mouse state cannot pass glow oracles', () => {
  const before = { fixtureForeground: true, foregroundWindowId: '100', focusedWindowId: '101' };
  driver.assertFocus(before, { ...before });
  assert.throws(() => driver.assertFocus(before, { ...before, focusedWindowId: '102' }));
  const state = { input: { leftButtonDown: false } }; counts(state, 1); driver.assertCounts(state, 1);
  assert.throws(() => driver.assertCounts({ ...state, mouseClickCount: 0 }, 1));
  assert.throws(() => driver.assertCounts({ ...state, input: { leftButtonDown: true } }, 1));
  state.lastMouseClick = { button: 'Left', clicks: 1, screenX: 7, screenY: 400, atUtc: '2026-10-21T12:00:01Z' };
  driver.assertClick(state, 1, { x: 7, y: 400 }, '2026-10-21T12:00:00Z');
  assert.throws(() => driver.assertClick(state, 1, { x: 8, y: 400 }, '2026-10-21T12:00:00Z'));
  assert.throws(() => driver.assertClick(state, 1, { x: 7, y: 400 }, '2026-10-21T12:00:02Z'));
});
