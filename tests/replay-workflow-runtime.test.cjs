'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseJournal, verifyJournal, cropRgb, rms, reviewCovers, sourceReviewCovers, validCommand, runLoop, advance, persistRecovery, readRequestReceipt } = require('../scripts/replay-workflow-runtime.cjs');
const session = '03d902dc-7da2-41c9-809f-1531674ba13b', observation = '6a85b164-1fe4-4569-967f-f184c129622e';
const target = { pid: 48020, windowId: '10358094' };
const at = seconds => new Date(Date.UTC(2026, 9, 22, 14, 0, seconds)).toISOString();
function journal(extra = []) {
  return [{ at: at(1), sessionId: session, type: 'session_open', windowId: '10358094', pid: 48020 },
    { at: at(2), sessionId: session, type: 'observation', observationId: observation, screenshotSha256: 'a'.repeat(64) },
    ...[1, 2, 3].flatMap(index => [
      { at: at(10 + index), sessionId: session, type: 'action_started', actionId: `action-${index}`, observationId: observation, actionType: index === 1 ? 'type_text' : 'click' },
      { at: at(10 + index), sessionId: session, type: 'action_completed', actionId: `action-${index}`, observationId: observation }]),
    ...extra];
}
const window = { sessionId: session, target, since: at(5), openedAfter: at(0), minimumActions: 3 };

test('journal parsing ignores only an unterminated tail written in progress', () => {
  const line = JSON.stringify({ type: 'session_open' });
  assert.equal(parseJournal(`${line}\n${line}\n{"type":"obs`).length, 2);
  assert.throws(() => parseJournal(`${line}\n{"broken"\n`), { code: 'replay_trace_journal_invalid' });
});

test('TRACE evidence binds the exact session target, opening time, completed actions and final observation', () => {
  const summary = verifyJournal(journal(), window);
  assert.deepEqual(summary.actions.map(value => value.actionType), ['type_text', 'click', 'click']);
  assert.deepEqual(summary.finalObservation, { observationId: observation, sha256: 'a'.repeat(64) });
  assert.equal(verifyJournal(journal(), { ...window, minimumActions: 0, observationId: observation }).finalObservation.observationId, observation);
  const cases = [
    [journal(), { ...window, target: { ...target, pid: 1 } }, 'replay_trace_target_mismatch'],
    [journal(), { ...window, target: { ...target, windowId: '1' } }, 'replay_trace_target_mismatch'],
    [journal(), { ...window, openedAfter: at(3) }, 'replay_trace_session_predates_target'],
    [journal(), { ...window, sessionId: '../escape' }, 'replay_trace_session_invalid'],
    [journal(), { ...window, since: 'not-a-time' }, 'replay_trace_window_invalid'],
    [journal(), { ...window, minimumActions: 4 }, 'replay_trace_actions_missing'],
    [journal(), { ...window, since: at(12) }, 'replay_trace_actions_missing'],
    [journal([{ at: at(20), sessionId: session, type: 'action_unknown', actionId: 'action-4', errorCode: 'x' }]), window, 'replay_trace_action_uncertain'],
    [journal([{ at: at(20), sessionId: session, type: 'action_started', actionId: 'action-4', observationId: observation, actionType: 'click' }]), window, 'replay_trace_action_uncertain'],
    [journal().filter(value => value.type !== 'observation'), window, 'replay_trace_observation_missing'],
    [journal(), { ...window, minimumActions: 0, observationId: randomUUID() }, 'replay_trace_observation_missing'],
    [[...journal(), journal()[0]], window, 'replay_trace_target_mismatch']];
  for (const [events, options, code] of cases) assert.throws(() => verifyJournal(events, options), { code });
  // A safely undelivered action closes its start but never counts as a completed demonstration action.
  const undelivered = journal([{ at: at(20), sessionId: session, type: 'action_started', actionId: 'action-4', observationId: observation, actionType: 'click' },
    { at: at(20), sessionId: session, type: 'action_not_dispatched', actionId: 'action-4', errorCode: 'x' }]);
  assert.equal(verifyJournal(undelivered, window).actions.length, 3);
  assert.throws(() => verifyJournal(undelivered, { ...window, minimumActions: 4 }), { code: 'replay_trace_actions_missing' });
});

test('region crops and audio windows measure exactly the declared geometry and timing', () => {
  const width = 10, height = 10, rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.fill(y * 10 + x, (y * width + x) * 3, (y * width + x + 1) * 3);
  const crop = cropRgb(rgb, width, height, { x: 0.2, y: 0.3, width: 0.4, height: 0.5 });
  assert.deepEqual([crop.width, crop.height], [4, 5]);
  assert.equal(crop.rgb[0], 32); assert.equal(crop.rgb.at(-1), 75);
  assert.throws(() => cropRgb(rgb, width, height, { x: 0, y: 0, width: 0.1, height: 0.1 }), { code: 'replay_decode_invalid' });
  const rate = 1000, samples = new Float32Array(6 * rate);
  for (let i = 1.5 * rate; i < 2.5 * rate; i++) samples[i] = 0.125 * Math.sin(i / 5);
  assert.ok(rms(samples, rate, [0.2, 1.3]) < 0.005); assert.ok(rms(samples, rate, [1.7, 2.3]) > 0.05);
  assert.ok(rms(samples, rate, [2.8, 5.8]) < 0.005);
  assert.throws(() => rms(samples, rate, [5.95, 7]), { code: 'replay_audio_window_invalid' });
});

test('root review must cover every produced frame hash with a concrete observation', () => {
  const measured = { fixture: { frames: [{ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }] }, walkthrough: { frames: [{ sha256: 'c'.repeat(64) }] } };
  const reviewedFrames = ['a', 'b', 'c'].map(value => ({ sha256: value.repeat(64), observed: 'Owned fixture visible with blurred region.' }));
  assert.equal(reviewCovers({ pass: true, reviewedFrames }, measured), true);
  assert.equal(reviewCovers({ pass: false, reviewedFrames }, measured), false);
  assert.equal(reviewCovers({ pass: true, reviewedFrames: reviewedFrames.slice(1) }, measured), false);
  assert.equal(reviewCovers({ pass: true, reviewedFrames: reviewedFrames.map(value => ({ ...value, observed: 'ok' })) }, measured), false);
  assert.equal(reviewCovers({ pass: true, reviewedFrames }, {}), false);
});

test('source content review binds the whole six-second video, actual source interval, all frames and a result after the observed action', () => {
  const review = { sourceSha256: 'a'.repeat(64), sourceStart: 61, sourceEnd: 67, segment: { sha256: 'b'.repeat(64), duration: 6 },
    frames: [0.25, 1.5, 3, 4.5, 5.75].map((seconds, index) => ({ sha256: String(index + 1).repeat(64), segmentSeconds: seconds, requestedSourceSeconds: 61 + seconds })) };
  const input = { pass: true, reviewedEntireSegment: true, sourceSha256: review.sourceSha256, sourceStart: 61, sourceEnd: 67,
    segmentSha256: review.segment.sha256, reviewedFrames: review.frames.map(frame => ({ sha256: frame.sha256, observed: 'Synthetic fixture is visible in the actual captured source frame.' })),
    observedAction: { from: 1.7, to: 2.5, description: 'Increment control visibly changes Count:1 to Count:2.' },
    observedResult: { frameSha256: review.frames[2].sha256, text: 'TRACE REPLAY demo', count: 2 } };
  assert.equal(sourceReviewCovers(input, review), true);
  for (const patch of [{ reviewedEntireSegment: false }, { sourceSha256: 'c'.repeat(64) }, { segmentSha256: 'd'.repeat(64) },
    { sourceStart: 1, sourceEnd: 7 }, { reviewedFrames: input.reviewedFrames.slice(1) }, { observedAction: { from: 7, to: 8, description: 'Action occurred after the segment.' } },
    { observedAction: { from: 1, to: 2, description: 'ok' } }, { observedResult: { ...input.observedResult, frameSha256: review.frames[0].sha256 } },
    { observedResult: { ...input.observedResult, text: 'different text' } }, { observedResult: { ...input.observedResult, count: 0 } }]) {
    assert.equal(sourceReviewCovers({ ...input, ...patch }, review), false);
  }
  assert.equal(sourceReviewCovers({ pass: true }, review), false); // Final fixture state or a bare approval never suffices.
});

test('commands must be the next sequence number with a declared stage and object input', () => {
  assert.equal(validCommand({ schemaVersion: 1, id: 1, stage: 'provision' }, 0), true);
  assert.equal(validCommand({ schemaVersion: 1, id: 3, stage: 'abort' }, 2), true);
  for (const value of [{ schemaVersion: 1, id: 2, stage: 'provision' }, { schemaVersion: 1, id: 1, stage: 'shell' },
    { schemaVersion: 2, id: 1, stage: 'provision' }, { schemaVersion: 1, id: 1, stage: 'provision', input: [] },
    { schemaVersion: 1, id: 1, stage: 'provision', input: null }]) assert.equal(validCommand(value, 0), false);
});

function harness(options = {}) {
  const calls = [];
  const workflow = {
    advance: async (stage, input) => {
      calls.push(['advance', stage, input]);
      if (stage === options.failStage) throw Object.assign(new Error('C:\\private\\path'), { code: 'replay_capture_not_started', replayCode: 'CAPTURE_CONFLICT' });
      return { status: 'prepared_or_running', completed: [stage] };
    },
    reconcile: async () => { calls.push(['reconcile']); return [{ label: 'editor', connected: true }]; },
    cleanup: async () => { calls.push(['cleanup']); return { confirmed: true, instances: [] }; },
    state: () => ({ status: options.finalStatus ?? 'prepared_or_running', completed: calls.filter(call => call[0] === 'advance').map(call => call[1]),
      requests: options.requests ?? [] }),
  };
  return { calls, workflow };
}
async function loop(options = {}) {
  const directory = path.join(os.tmpdir(), `trace-replay-loop-${randomUUID()}`); await fs.mkdir(directory);
  const receipt = { caseId: 'A4-REPLAY', status: 'running', lastCommandId: 0 };
  const record = async update => { Object.assign(receipt, update); await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt)); return receipt; };
  await record({});
  const f = harness(options);
  const running = runLoop({ directory, workflow: f.workflow, record, pollMs: 5, ...options.loop });
  return { directory, receipt, running, ...f, send: (stage, input) => sendInput(directory, stage, input),
    done: async () => { const result = await running; await fs.rm(directory, { recursive: true, force: true }); return result; } };
}
async function sendInput(directory, stage, input) {
  let file;
  if (input !== undefined) { file = path.join(directory, `input-${randomUUID()}.json`); await fs.writeFile(file, JSON.stringify(input)); }
  return advance(directory, stage, file, { timeoutMs: 5000, pollMs: 5 });
}

test('durable loop answers each command once in order, rejects invalid commands without effect and stops on stage failure', async () => {
  const f = await loop({ failStage: 'fixture-record-start', requests: [{ state: 'unknown' }] });
  assert.deepEqual(await f.send('provision'), { id: 1, ok: true, state: { status: 'prepared_or_running', completed: ['provision'] } });
  assert.deepEqual((await f.send('shell')).error, { code: 'replay_command_invalid' });
  assert.equal((await f.send('fixture-ready', { traceSessionId: session, observationId: observation })).ok, true);
  assert.deepEqual(f.calls.find(call => call[1] === 'fixture-ready')[2], { traceSessionId: session, observationId: observation });
  const failed = await f.send('fixture-record-start');
  assert.deepEqual(failed.error, { stage: 'fixture-record-start', code: 'replay_capture_not_started', replayCode: 'CAPTURE_CONFLICT' });
  assert.equal(failed.terminal, 'blocked');
  const receipt = await f.done();
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.terminalReason, 'stage_failed'); assert.equal(receipt.lastCommandId, 4);
  assert.deepEqual(f.calls.slice(-2).map(call => call[0]), ['reconcile', 'cleanup']); // Read-only state before any process is closed.
  assert.doesNotMatch(JSON.stringify(receipt), /private/);
});

test('abort, interruption and idle timeout reconcile and clean up; a failure before any change is blocked', async () => {
  const aborted = await loop();
  assert.equal((await aborted.send('abort')).terminal, 'blocked');
  assert.equal((await aborted.done()).terminalReason, 'aborted'); assert.deepEqual(aborted.calls.map(call => call[0]), ['reconcile', 'cleanup']);
  let stop = false;
  const interrupted = await loop({ loop: { stopRequested: () => stop } });
  stop = true; assert.equal((await interrupted.done()).terminalReason, 'interrupted');
  let now = 0;
  const idle = await loop({ loop: { clock: () => now, idleMs: 10 } });
  now = 11; assert.equal((await idle.done()).terminalReason, 'operator_timeout');
});

test('a completed cleanup stage reports success only for a reviewed, confirmed workflow', async () => {
  const f = await loop({ finalStatus: 'awaiting_runtime_evidence_audit' });
  const response = await f.send('cleanup');
  assert.equal(response.ok, true); assert.equal(response.terminal, 'awaiting_runtime_evidence_audit');
  const receipt = await f.done(); assert.equal(receipt.terminalReason, 'completed');
  assert.equal(f.calls.some(call => call[0] === 'reconcile'), false);
});

test('terminal cleanup cannot promote pending, unknown or explicitly unresolved requests', async () => {
  for (const request of [{ state: 'pending' }, { state: 'unknown' }, { state: 'completed', reconciliation: { outcome: 'unresolved' } }]) {
    const f = await loop({ finalStatus: 'awaiting_runtime_evidence_audit', requests: [request] });
    assert.equal((await f.send('cleanup')).terminal, 'blocked');
    assert.equal((await f.done()).status, 'blocked');
  }
  const knownFailure = await loop({ failStage: 'fixture-record-start', requests: [{ state: 'failed' }] });
  assert.equal((await knownFailure.send('fixture-record-start')).terminal, 'fail');
  await knownFailure.done();
});

test('a fresh reader can verify immutable private recovery snapshots after a simulated driver crash', async () => {
  const privateRoot = path.join(os.tmpdir(), `trace-replay-recovery-${randomUUID()}`);
  try {
    const first = { schemaVersion: 1, instances: [{ label: 'editor', launchedPid: 44, identity: { pid: 44, processCreationTime: '123', windowId: '55', sessionId: 1 } }], requests: [] };
    const ref1 = await persistRecovery(privateRoot, first);
    const pending = { ...first, requests: [{ app: 'editor', command: 'project.edit', requestId: 'trace-replay-original', state: 'pending',
      payload: { input: { projectId: 'owned-project', operations: [{ type: 'trim', sourceStart: 1, sourceEnd: 7 }] }, expectedRevision: 3 } }] };
    const ref2 = await persistRecovery(privateRoot, pending);
    // No workflow object is used below: recovery depends solely on synced files and their references.
    for (const [reference, expected] of [[ref1, first], [ref2, pending]]) {
      const bytes = await fs.readFile(path.resolve(__dirname, '..', reference.path));
      assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), reference.sha256);
      assert.equal(bytes.length, reference.bytes);
      assert.deepEqual(JSON.parse(bytes), expected);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(privateRoot, 'recovery', 'latest.json'), 'utf8')), ref2);
    assert.equal(Object.keys(ref2).sort().join(','), 'bytes,path,sha256');
    assert.notEqual(ref1.path, ref2.path);
  } finally { await fs.rm(privateRoot, { recursive: true, force: true }); }
});

test('the production request reader uses REPLAY hashed request journals and never dispatches a command', async () => {
  const root = path.join(os.tmpdir(), `trace-replay-request-${randomUUID()}`), library = path.join(root, 'Library');
  const requestId = `trace-replay-${randomUUID()}`;
  const file = path.join(root, 'Automation', 'requests', `${require('node:crypto').createHash('sha256').update(requestId).digest('hex')}.json`);
  try {
    assert.equal(await readRequestReceipt(library, requestId), null);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const receipt = { schemaVersion: 1, requestId, state: 'pending' };
    await fs.writeFile(file, JSON.stringify(receipt));
    assert.deepEqual(await readRequestReceipt(library, requestId), receipt);
    assert.equal(await readRequestReceipt(path.join(root, 'other-instance', 'Library'), requestId), null);
    await assert.rejects(readRequestReceipt(library, '../foreign'), { code: 'replay_request_id_invalid' });
    await fs.writeFile(file, '{partial');
    assert.equal(await readRequestReceipt(library, requestId), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the CLI loads both modules as a real process, plans purely and fails closed without creating a run directory', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'accept-replay-workflow.cjs');
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const planned = run(['--plan']);
  assert.equal(planned.status, 0); assert.equal(JSON.parse(planned.stdout).claimsAttempt, false);
  const missing = path.join(os.tmpdir(), `trace-replay-absent-${randomUUID()}`);
  for (const [args, code] of [[['--status', missing], 'replay_loop_not_running'], [['--advance', missing, 'provision'], 'replay_loop_not_running'],
    [['--advance', missing], 'replay_arguments_invalid'], [[missing, '--live'], 'owner_decision_required'], [['--plan', 'extra'], 'replay_arguments_invalid']]) {
    const result = run(args);
    assert.equal(result.status, 1); assert.equal(result.stderr.trim(), code);
  }
  assert.equal(require('node:fs').existsSync(missing), false);
});

test('the client refuses a stopped loop or an unconsumed command instead of overwriting it', async () => {
  const directory = path.join(os.tmpdir(), `trace-replay-client-${randomUUID()}`); await fs.mkdir(directory);
  try {
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify({ caseId: 'A4-REPLAY', status: 'fail', lastCommandId: 2 }));
    await assert.rejects(advance(directory, 'provision', undefined, { timeoutMs: 50, pollMs: 5 }), { code: 'replay_loop_not_running' });
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify({ caseId: 'A4-REPLAY', status: 'running', lastCommandId: 2 }));
    await fs.writeFile(path.join(directory, 'command.json'), JSON.stringify({ schemaVersion: 1, id: 3, stage: 'provision' }));
    await assert.rejects(advance(directory, 'fixture-ready', undefined, { timeoutMs: 50, pollMs: 5 }), { code: 'replay_command_pending' });
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'command.json'), 'utf8')).stage, 'provision');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
