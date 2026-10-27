'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../scripts/accept-replay-pause.cjs');

const id = '11111111-1111-4111-8111-111111111111';
const observationId = '22222222-2222-4222-8222-222222222222';
const finalObservationId = '33333333-3333-4333-8333-333333333333';
const hash = 'a'.repeat(64);
const base = Date.parse('2026-10-27T12:00:00Z');
const at = new Date(base).toISOString();
function fixture(scenario) {
  const calls = [], cleanup = [], recipe = { hash, revision: 1 };
  let reads = 0, saved = 0, recorded;
  const state = (playing, position) => ({ projectId: 'p', playing, position, duration: 120, recipeHash: hash, revision: 1 });
  const session = { sessionId: id, since: at, openedAfter: at };
  const events = [
    { type: 'session_open', sessionId: id, windowId: '12', pid: 1, at },
    { type: 'observation', sessionId: id, observationId, screenshotSha256: hash, at },
    { type: 'observation', sessionId: id, observationId: finalObservationId, screenshotSha256: hash, at },
    { type: 'action_started', sessionId: id, actionId: 'x', actionType: 'click', at },
    { type: 'action_completed', sessionId: id, actionId: 'x', observationId: finalObservationId, at }
  ];
  const deps = {
    preflight: async () => {}, claim: async () => {}, launch: async () => ({}), identify: async () => ({ windowId: '12', pid: 1 }),
    grant: async () => ({}), connectReplay: async () => ({}), prepareMedia: async () => ({ path: 'synthetic' }), importMedia: async media => media,
    command: async (_, name, args, revision) => { calls.push(name); if (name !== 'project.import') assert.equal(revision, 1); return name === 'project.import' ? { id: 'p', revision: 1 } : {}; },
    record: async value => { recorded = structuredClone(value); }, savedRecipe: async () => { saved++; return scenario === 'recipe' && saved > 1 ? { ...recipe, revision: 2 } : recipe; },
    preview: async () => { reads++; if (reads < 4) return state(true, reads); return state(false, scenario === 'autoend' ? 120 : 4); },
    delay: async () => {}, connectTrace: async () => ({}), openTrace: async () => session,
    observe: async () => ({ id: observationId, sha256: hash, at: base, width: 100, height: 100 }),
    publishReview: async () => {}, waitReview: async () => ({ observationId, screenshotSha256: hash, point: { x: 10, y: 20 }, reviewedAt: at }),
    now: () => base, clickOnce: async () => { assert.equal(recorded.nativeInput.state, 'pending'); calls.push('click'); return { outcome: scenario === 'unknown' ? 'unknown' : 'completed', finalObservation: { id: finalObservationId, sha256: hash } }; },
    journal: async () => events, reconcile: async () => [],
    cleanup: async name => { cleanup.push(name); if (scenario === 'cleanup' && name === 'nativeSession') throw Error('close failed'); return true; }
  };
  return { deps, calls, cleanup };
}

test('plan is inert and requires injected dependencies', () => {
  const result = flow.plan();
  assert.equal(result.claimsAttempt, false);
  assert.equal(result.execution, 'injected');
  assert.equal(result.attempt, 5);
  assert.equal(flow.reviewMatches({ observationId, screenshotSha256: hash, point: { x: 1.5, y: 2 }, reviewedAt: at },
    { id: observationId, sha256: hash, at: base, width: 100, height: 100 }, base), false);
});

test('requires causal pause, unchanged recipe and completed delivery', async () => {
  for (const scenario of ['pass', 'autoend', 'recipe', 'unknown']) {
    const f = fixture(scenario);
    const result = await flow.runInjected(f.deps);
    assert.equal(result.status, scenario === 'pass' ? 'pass' : 'fail', scenario);
    assert.equal(f.calls.filter(name => name === 'click').length, 1);
    assert.equal(result.requests[1].expectedRevision, 1);
    assert.deepEqual(result.requests[1].input, { projectId: 'p', position: 0 });
    assert.deepEqual(f.cleanup, ['nativeSession', 'trace', 'replay', 'grant', 'app']);
  }
});

test('cleanup continues after native close failure', async () => {
  const f = fixture('cleanup');
  const result = await flow.runInjected(f.deps);
  assert.equal(result.status, 'fail');
  assert.deepEqual(f.cleanup, ['nativeSession', 'trace', 'replay', 'grant', 'app']);
});

test('runtime cancellation refuses preflight and review before any provider work', async () => {
  const runtime = require('../scripts/replay-pause-runtime.cjs');
  assert.equal(runtime.plan().execution, 'production-cli');
  const context = runtime.createRuntime({ directory: __dirname, decision: undefined });
  context.cancel();
  await assert.rejects(context.preflight(), /cancelled/);
  await assert.rejects(context.waitReview(45000), /cancelled/);
  assert.deepEqual(context.state.acquisitions, {});
});

test('transport still closes when owned inventory fails and quiescence remains unproved', async () => {
  const { closeTrace } = require('../scripts/replay-pause-support.cjs');
  const calls = [], node = { pid: 123, created: 'synthetic' };
  const trace = { nodeIdentity: node, close: async () => { calls.push('close'); } };
  await assert.rejects(closeTrace(trace, null, {
    readOwned: async () => { calls.push('inventory'); throw Error('inventory unavailable'); },
    waitIdentityExit: async identity => { assert.deepEqual(identity, node); calls.push('exit'); return true; },
    command: async ([name]) => { calls.push(name); return name === 'keystate' ? { down: [] } : { recoveryRequired: false }; },
    leaseFree: async () => { calls.push('lease'); return true; }
  }), /inventory unavailable/);
  assert.deepEqual(calls, ['inventory', 'close', 'exit', 'keystate', 'status', 'lease']);
});

test('PNG retention binds the full process generation before writing an artifact', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { frame } = require('../scripts/replay-pause-support.cjs');
  const common = require('../scripts/replacement-acceptance-common.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-pause-frame-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1EAAAAASUVORK5CYII=', 'base64');
  const identity = { windowId: '12', pid: 1, processCreationTime: '100', sessionId: 1 };
  const value = { sessionId: id, observationId, observedAt: at, window: { ...identity, id: '12' }, bounds: { width: 1, height: 1 },
    screenshot: { data: bytes.toString('base64'), sha256: common.digest(bytes), mimeType: 'image/png', width: 1, height: 1 } };
  await assert.rejects(frame(root, { sessionId: id }, { ...identity, processCreationTime: '101' }, value, 'wrong'));
  assert.deepEqual(await fs.readdir(root), []);
  const result = await frame(root, { sessionId: id }, identity, value, 'actual');
  assert.equal(result.sha256, common.digest(await fs.readFile(path.join(root, result.filename))));
});
