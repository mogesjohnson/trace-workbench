'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ControlledBackend, replacement, validate, publicReleaseCheckpoint, privateAcknowledgement, publishJournal } = require('./fixtures/supervised-mcp.cjs');
const quarantine = require('../scripts/accept-supervisor-quarantine.cjs');
const physicalStop = require('../scripts/accept-supervisor-stop.cjs');
const { cells, plan, parseArgs, validateDisplay, compareDisplay, stateOf } = require('../scripts/accept-supervisor-recovery.cjs');

const config = mode => ({ mode, runtimeDirectory: path.resolve('synthetic-runtime'), journalPath: path.resolve('synthetic-journal.json'), controlPath: path.resolve('synthetic-control.json'), operationTimeoutMs: 12000 });

test('typing supplemental preparation consumes verified fixture and claims once only after final owner readiness', async () => {
  const now = Date.parse('2026-10-22T14:00:00Z'), events = [], anchor = { id: '10', pid: 20, processCreationTime: '30', sessionId: 1 };
  const display = { monitors: 1, displays: [{ device: 'synthetic', primary: true, dpi: 144, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] };
  const record = { schemaVersion: 1, source: 'direct-owner', caseId: 'A32-QUARANTINE-ACK-TYPING', ready: true,
    confirmedAt: new Date(now).toISOString(), anchorOwnership: 'run-owned-child', anchor };
  const options = quarantine.parseArgs(['evidence/synthetic-unused', '--live', '--input', 'typing', '--continuation', '1',
    '--decision-ref', 'evidence/decision.json', '--idle-readiness', 'evidence/ready.json']);
  let held = false;
  const deps = { now: () => now, verify: async () => events.push('verify'), verifyFixture: async () => { events.push('prepared-only'); return { executable: 'synthetic.exe', summary: {} }; },
    evidence: async () => ({ value: structuredClone(record), descriptor: { ref: 'evidence/ready.json' } }),
    claimRequest: async () => { events.push('decision-read'); return { caseId: record.caseId }; },
    claim: async () => { events.push('claim'); return { claimId: 'synthetic-test-only', lifetimeAttemptOrdinal: 3 }; },
    leaseFree: async () => { events.push('lease'); return true; }, bridge: async () => ({ ...anchor, foreground: true }),
    command: async args => { events.push(args[0]); return ({ display, status: { recoveryRequired: false }, 'input-access': { observable: true, foregroundPid: anchor.pid },
      identity: { pid: anchor.pid, processCreationTime: anchor.processCreationTime, session: 1 }, keystate: { down: held ? [1] : [] } })[args[0]]; } };
  const prepared = await quarantine.prepareContinuation(options, deps);
  assert.equal(events.includes('claim'), false);
  assert.equal((await prepared.claim()).lifetimeAttemptOrdinal, 3);
  assert.deepEqual(events.slice(-7), ['display', 'status', 'input-access', 'identity', 'keystate', 'lease', 'claim']);
  assert.ok(events.indexOf('decision-read') < events.lastIndexOf('display'));
  await assert.rejects(prepared.claim()); assert.equal(events.filter(item => item === 'claim').length, 1);
  held = true; const blocked = await quarantine.prepareContinuation(options, deps);
  await assert.rejects(blocked.claim()); assert.equal(events.filter(item => item === 'claim').length, 1);
  await assert.rejects(quarantine.run({ mode: 'live', input: 'typing', directory: 'must-never-be-created' }), { code: 'invalid_retry' });
  assert.equal(quarantine.plan(options).attempt, 3);
  assert.equal((await quarantine.run({ continuationAttempt: 1 }, { command: () => assert.fail('Default plan cannot inspect native state') })).attempt, 3);
  await assert.rejects(quarantine.run({ mode: 'invented' }, { command: () => assert.fail('Invalid mode cannot inspect native state') }));
});

test('typing exact native exit distinguishes retained generation from reused PID without native calls', async () => {
  const identity = { pid: 10, processCreationTime: '100', session: 1, user: 'synthetic-user' };
  const waitFor = async (work, predicate) => { assert.equal(predicate(await work()), true); return true; };
  assert.equal(await quarantine.exactNativeExit(identity, { alive: () => false, waitFor, command: () => assert.fail('No query after proven exit') }), true);
  assert.equal(await quarantine.exactNativeExit(identity, { alive: () => true, waitFor, command: async () => ({ ...identity, processCreationTime: '101' }) }), true);
  await assert.rejects(quarantine.exactNativeExit(identity, { alive: () => true, waitFor, command: async () => identity }));
  await assert.rejects(quarantine.exactNativeExit(identity, { alive: () => true, waitFor, command: async () => { throw new Error('unavailable'); } }));
});

test('typing retained fixture rejects stale publication after process exit or exit during read', async () => {
  const child = { exitCode: null, signalCode: null };
  assert.deepEqual(await quarantine.fixtureState('synthetic.json', child, async () => '{"count":0}'), { count: 0 });
  await assert.rejects(quarantine.fixtureState('synthetic.json', child, async () => { child.exitCode = 0; return '{"count":1}'; }), { code: 'fixture_process_exited' });
});

test('journal replacement retries transient Windows sharing errors without repeating the write or input', () => {
  let writes = 0, renames = 0; const waits = [];
  publishJournal('owned.json', { events: [{ type: 'controlled-start' }] }, {
    write(file, bytes) { writes++; assert.equal(file, 'owned.json.tmp'); assert.equal(JSON.parse(bytes).events[0].type, 'controlled-start'); },
    rename(from, to) { assert.equal(from, 'owned.json.tmp'); assert.equal(to, 'owned.json'); if (++renames < 4) throw Object.assign(new Error(), { code: 'EPERM' }); },
    pause(ms) { waits.push(ms); },
  });
  assert.equal(writes, 1); assert.equal(renames, 4); assert.deepEqual(waits, [2, 4, 8]);
});
test('journal replacement has a finite wait and preserves permanent or unrelated failures', () => {
  let calls = 0; const waits = [];
  assert.throws(() => publishJournal('owned.json', {}, { write() {}, rename() { calls++; throw Object.assign(new Error(), { code: 'EACCES' }); }, pause(ms) { waits.push(ms); } }), { code: 'EACCES' });
  assert.equal(calls, 7); assert.equal(waits.reduce((a, b) => a + b, 0), 126);
  calls = 0;
  assert.throws(() => publishJournal('owned.json', {}, { write() {}, rename() { calls++; throw Object.assign(new Error(), { code: 'ENOSPC' }); }, pause() { assert.fail('No unrelated-error retry'); } }), { code: 'ENOSPC' });
  assert.equal(calls, 1);
});

test('private recovery fixtures replace only the selected final verb and preserve literal click setup', () => {
  assert.equal(replacement('mouse', 'drag', ['-w', '1', '--hold-ms', '0', '--', '20,30', '20,30']), null);
  assert.deepEqual(replacement('mouse', 'drag', ['-w', '1', '--', '-20,30', '20,30']), ['provider', 'hold-mouse', '-20', '30']);
  assert.equal(replacement('typing', 'inspect', []), null);
  assert.equal(replacement('chord', 'send-keys', ['--verbatim', '--', 'abc']), null);
  assert.deepEqual(replacement('typing', 'send-keys', ['--verbatim', '--', 'abc']), ['provider', 'type-hold', 'abc']);
  assert.equal(replacement('none', 'send-keys', ['--verbatim', '--', 'abc']), null);
});

test('private test configuration rejects missing scope and unbounded deadlines', () => {
  assert.throws(() => validate({ ...config('typing'), runtimeDirectory: 'relative' }));
  assert.throws(() => validate({ ...config('typing'), mode: 'arbitrary' }));
  assert.throws(() => validate({ ...config('typing'), operationTimeoutMs: 15001 }));
  assert.deepEqual(validate(config('typing')), config('typing'));
});

test('private connectors retain the quarantine deadline and pass the physical plan deadline unchanged', () => {
  const paths = { directory: path.resolve('synthetic-evidence'), privateDirectory: path.resolve('synthetic-private'), input: 'mouse' };
  assert.equal(quarantine.connectionConfiguration(paths).operationTimeoutMs, 12000);
  const physical = quarantine.connectionConfiguration({ ...paths, operationTimeoutMs: physicalStop.plan().inputOperationDeadlineMs });
  assert.equal(physical.operationTimeoutMs, 15000);
  assert.equal(physical.testRecovery, undefined);
  assert.throws(() => quarantine.connectionConfiguration({ ...paths, operationTimeoutMs: 15001 }), { code: 'invalid_fixture_config' });
  assert.throws(() => quarantine.connectionConfiguration({ ...paths, operationTimeoutMs: 0 }), { code: 'invalid_fixture_config' });
});

test('controlled substitution uses native ownership once and retains original cancellation recovery evidence', async () => {
  const calls = [], events = [];
  const failure = Object.assign(new Error('Synthetic interruption'), { code: 'cancelled',
    details: { nativeSupervision: true, outcome: 'unknown', recovery: { attempted: true, released: true, processExitConfirmed: true } } });
  const native = { ready: true, child: { pid: 10 }, async run(provider, args, options) {
    calls.push({ provider, args, options });
    if (provider === 'controlled') throw failure;
    return { stdout: '{}', stderr: '', exitCode: 0 };
  } };
  const backend = new ControlledBackend({ config: config('typing'), native, record: (type, details) => events.push({ type, ...details }) });
  await assert.rejects(backend.command('send-keys', ['--verbatim', '--', 'abc']), error => error === failure);
  await backend.command('send-keys', ['--verbatim', '--', 'abc']);
  assert.deepEqual(calls.map(call => call.provider), ['controlled', 'winapp']);
  assert.equal(calls[0].options.mutating, true);
  assert.equal(events.at(-1).recovery.released, true);
  assert.equal(backend.controlledInFlight, false);
});

test('acceptance private config does not add parameters or tools to the production MCP source', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '../src/computer/server.cjs'), 'utf8');
  assert.equal((source.match(/register\("trace_computer_/g) || []).length, 6);
  assert.equal(/allowControlled|operationTimeoutMs|hold-mouse|type-hold/.test(source), false);
});

test('recovery plan declares every failure/input pair and preserves unsupported physical/fault coverage', () => {
  const matrix = cells();
  assert.equal(matrix.length, 15);
  assert.equal(new Set(matrix.map(cell => cell.id)).size, 15);
  for (const failure of ['cancel', 'timeout', 'disconnect', 'node-death', 'supervisor-death']) {
    assert.deepEqual(matrix.filter(cell => cell.failure === failure).map(cell => cell.input), ['mouse', 'chord', 'typing']);
  }
  assert.equal(parseArgs(['--plan']).mode, 'plan');
  const declared = plan({ caseId: 'A32-RECOVERY-SUPERVISOR-DEATH-TYPING' });
  assert.equal(declared.cells.length, 1);
  assert.match(declared.outsideScope.physicalEscape, /^not_run/);
  assert.match(declared.outsideScope.failedCleanupAcknowledgement, /^not_run/);
  assert.throws(() => plan({ caseId: 'unknown' }));
});

test('recovery retry launch requires both prior evidence and a changed precondition', () => {
  assert.throws(() => parseArgs(['out', '--live', '--attempt', '2']));
  assert.throws(() => parseArgs(['out', '--live', '--attempt', '3']));
  assert.throws(() => parseArgs(['out', '--live', '--attempt', '1', '--prior', 'previous']));
  const valid = parseArgs(['out', '--live', '--attempt', '2', '--prior', 'previous', '--change', 'Verified text focus']);
  assert.equal(valid.attempt, 2);
  assert.equal(valid.change, 'Verified text focus');
});

test('real MCP image projection resolves indexed PNG evidence for both observe and nested action results', () => {
  const content = [{ type: 'text', text: '{}' }, { type: 'image', mimeType: 'image/png', data: 'owned-png' }];
  const screenshot = { mimeType: 'image/png', contentIndex: 1, width: 2, height: 1 };
  const observed = stateOf({ content, structuredContent: { screenshot } });
  const acted = stateOf({ content, structuredContent: { outcome: 'completed', observation: { screenshot } } });
  assert.equal(observed.screenshot.data, 'owned-png');
  assert.equal(acted.observation.screenshot.data, 'owned-png');
  assert.equal(screenshot.data, undefined, 'Structured server state must remain free of duplicated screenshot bytes.');
  assert.throws(() => stateOf({ content: [content[0]], structuredContent: { screenshot } }), { code: 'invalid_mcp_screenshot' });
});

test('live mode is observed once and exact display identity/bounds/DPI comparisons block changes', () => {
  const pinned = { monitors: 1, displays: [{ device: 'synthetic-monitor', primary: true, dpi: 144, bounds: { x: -20, y: 0, width: 1920, height: 1080 } }] };
  assert.deepEqual(validateDisplay(pinned), pinned);
  assert.deepEqual(compareDisplay(structuredClone(pinned), pinned), pinned);
  const changed = structuredClone(pinned); changed.displays[0].bounds.width = 2880;
  assert.throws(() => compareDisplay(changed, pinned), { code: 'display_mismatch' });
  const changedDpi = structuredClone(pinned); changedDpi.displays[0].dpi = 96;
  assert.throws(() => compareDisplay(changedDpi, pinned), { code: 'display_mismatch' });
  const changedDevice = structuredClone(pinned); changedDevice.displays[0].device = 'other';
  assert.throws(() => compareDisplay(changedDevice, pinned), { code: 'display_mismatch' });
  assert.throws(() => validateDisplay({ monitors: 2, displays: pinned.displays }), { code: 'display_mismatch' });
  assert.equal(plan({ pinnedDisplay: pinned }).initial.display, pinned);
  assert.equal(typeof plan().initial.display, 'string');
});

test('private cleanup fault requires controlled scope, keeps checkpoint tokens private and binds the exact ACK', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const configured = { ...config('mouse'), testRecovery: { mode: 'fail-release-ack', token } };
  assert.deepEqual(validate(configured), configured);
  assert.throws(() => validate({ ...configured, mode: 'none' }), { code: 'invalid_fixture_config' });
  assert.throws(() => validate({ ...configured, testRecovery: { mode: 'fail-release-ack', token: 'wrong' } }), { code: 'invalid_fixture_config' });
  const pending = { id: 'operation-2', token, childPid: 100, processCreationTime: '1234', processExitConfirmed: true,
    physicalReleaseObserved: true, declaredKeys: [1], remainingDown: [] };
  assert.equal(JSON.stringify(publicReleaseCheckpoint(pending)).includes(token), false);
  const proof = { requestId: pending.id, independentReleaseVerified: true, verifiedAt: '2026-10-20T20:00:00.000Z' };
  assert.deepEqual(privateAcknowledgement(configured, pending, proof), { targetId: pending.id, token, independentReleaseVerified: true });
  assert.equal(privateAcknowledgement(configured, pending, { ...proof, requestId: 'other' }), null);
  assert.equal(privateAcknowledgement(configured, pending, { ...proof, independentReleaseVerified: false }), null);
});

test('quarantine failure injection cannot be acknowledged before independent exit and all-up evidence', () => {
  const checkpoint = { childPid: 100, at: '2026-10-20T20:00:00.000Z' };
  const proof = { childPid: 100, childExited: true, keysDown: [], beforeFailureInjection: true, verifiedAt: '2026-10-20T20:00:00.001Z' };
  assert.equal(quarantine.assertIndependentProof(proof, checkpoint), proof);
  for (const wrong of [{ ...proof, childPid: 101 }, { ...proof, childExited: false }, { ...proof, keysDown: [1] },
    { ...proof, beforeFailureInjection: false }, { ...proof, verifiedAt: '2026-10-20T19:59:59.999Z' }]) {
    assert.throws(() => quarantine.assertIndependentProof(wrong, checkpoint), { code: 'invalid_independent_proof' });
  }
  assert.equal(quarantine.parseArgs(['--plan']).mode, 'plan');
  assert.throws(() => quarantine.parseArgs(['out', '--live', '--attempt', '2']));
  assert.throws(() => quarantine.plan({ input: 'unsupported' }));
});

test('physical acceptance requires actual physical metadata, bounded native latency and unchanged dispatch admission', () => {
  const stopped = { code: 'physical_escape', physical: true, stopLatencyMs: 0.2, dispatchCount: 12 };
  assert.equal(physicalStop.assertStopMetadata(stopped), stopped);
  assert.throws(() => physicalStop.assertStopMetadata({ ...stopped, physical: false }));
  assert.throws(() => physicalStop.assertStopMetadata({ ...stopped, stopLatencyMs: 1001 }));
  assert.throws(() => physicalStop.assertStopMetadata({ ...stopped, dispatchCount: undefined }));
  physicalStop.assertNoNewDispatch([{ type: 'native-dispatch', dispatchCount: 11 }, { type: 'native-dispatch', dispatchCount: 12 }], stopped);
  assert.throws(() => physicalStop.assertNoNewDispatch([{ type: 'native-dispatch', dispatchCount: 13 }], stopped));
  assert.throws(() => physicalStop.assertNoNewDispatch([{ type: 'native-dispatch' }], stopped));
});

test('physical cleanup requires native hook-to-release timing as well as confirmed exit and release', () => {
  const recovery = { released: true, processExitConfirmed: true, reason: 'physical_escape', stopCleanupMs: 22.1 };
  const finished = { code: 'physical_escape', outcome: 'unknown', recovery };
  assert.equal(physicalStop.assertCleanupMetadata(finished), recovery);
  for (const wrong of [{ ...recovery, released: false }, { ...recovery, processExitConfirmed: false },
    { ...recovery, reason: 'native_timeout' }, { ...recovery, stopCleanupMs: undefined },
    { ...recovery, stopCleanupMs: -1 }, { ...recovery, stopCleanupMs: 15001 }]) {
    assert.throws(() => physicalStop.assertCleanupMetadata({ ...finished, recovery: wrong }));
  }
});

test('physical stop plan separates actual taps from injected Escape and keeps the fixed held deadline', () => {
  const keyboard = physicalStop.plan({ caseName: 'keyboard' });
  assert.equal(keyboard.physicalRequired, true); assert.equal(keyboard.inputOperationDeadlineMs, 15000);
  assert.equal(keyboard.preparationWaitSeconds, 60); assert.equal(keyboard.physicalObservationWaitSeconds, 60);
  assert.match(keyboard.phases[0], /PREPARED/);
  assert.match(keyboard.input, /type-hold abc/);
  assert.equal(physicalStop.plan({ caseName: 'injected' }).physicalRequired, false);
  assert.equal(physicalStop.parseArgs(['--plan', '--case', 'mouse']).mode, 'plan');
  assert.throws(() => physicalStop.parseArgs(['out', '--live', '--case', 'fake']));
  assert.throws(() => physicalStop.parseArgs(['out', '--live', '--case', 'mouse', '--attempt', '2']));
});
