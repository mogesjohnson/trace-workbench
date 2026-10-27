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

test('plan is inert and marks runtime unavailable', () => {
  const result = flow.plan();
  assert.equal(result.claimsAttempt, false);
  assert.equal(result.productionRuntimeAvailable, false);
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
