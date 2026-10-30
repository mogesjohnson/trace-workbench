'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../scripts/observation-profile.cjs');

function sample(kind = 'first', changes = {}) {
  return { status: 'completed', observation: {
    version: 1, clock: 'process-monotonic', sample: `${kind}-controller-attempt`,
    stages: {}, counts: {}, bytes: {},
  }, ...changes };
}
function identity(value) { return { calls: 1, failures: 0, durationMs: value }; }

test('separates attempts and aggregates only present values', () => {
  const a = sample(); a.observation.stages.identity = identity(1);
  a.observation.counts.providerRequests = 2; a.observation.bytes.backendPngRead = 33;
  const b = sample(); b.observation.stages.identity = identity(5);
  const c = sample(); c.observation.stages.identity = identity(3);
  const d = sample('later', { clientRoundTripMs: 12, projection: { version: 1, clock: 'process-monotonic', durationMs: 4, imageCount: 1 } });
  const result = summarize([a, b, c, d]);
  assert.equal(result.version, 1);
  assert.equal(result.scope, 'provided-numeric-samples');
  assert.equal(result.failedSamples, 0);
  assert.equal(result.groups.first.samples, 3);
  assert.deepEqual(result.groups.first.metrics['stages.identity.durationMs'], { samples: 3, min: 1, median: 3, max: 5 });
  assert.deepEqual(result.groups.first.metrics['counts.providerRequests'], { samples: 1, min: 2, median: 2, max: 2 });
  assert.deepEqual(result.groups.first.metrics['bytes.backendPngRead'], { samples: 1, min: 33, median: 33, max: 33 });
  assert.equal(result.groups.later.samples, 1);
  assert.equal(result.groups.later.metrics.clientRoundTripMs.median, 12);
  assert.equal(result.groups.later.metrics['projection.durationMs'].median, 4);
  assert.equal(result.groups.later.metrics['projection.imageCount'].median, 1);
  assert.equal(result.groups.later.metrics['counts.providerRequests'], undefined);
  assert.equal(result.unavailable.length, 5);
});

test('does not output arbitrary fields and excludes failed samples', () => {
  const a = sample('later', { secret: 'PRIVATE-TITLE', projection: { version: 1, clock: 'process-monotonic', path: 'PRIVATE-PATH', jsonTextBytes: 20 } });
  a.observation.stages.secret = { calls: 1, failures: 0, durationMs: 77 };
  a.observation.counts.secret = 88;
  const result = summarize([a, { status: 'failed', observation: null, secret: 'PRIVATE-FAILURE', clientRoundTripMs: 999 }]);
  assert.equal(result.failedSamples, 1);
  assert.equal(result.groups.later.samples, 1);
  assert.equal(result.groups.later.metrics['projection.jsonTextBytes'].median, 20);
  assert.equal(result.groups.later.metrics.clientRoundTripMs, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret|999/);
});

test('rejects malformed envelopes and invalid numeric measurements', () => {
  const invalid = [[], Array(1001).fill(sample()), [{ status: 'other' }],
    [sample('first', { observation: null })], [sample('first', { clientRoundTripMs: -1 })],
    [sample('first', { projection: { version: 1, clock: 'process-monotonic', imageCount: 0.5 } })]];
  for (const mutate of [
    o => { o.version = 2; }, o => { o.clock = 'wall'; }, o => { o.sample = 'cold'; },
    o => { o.stages = null; }, o => { o.counts.providerRequests = 1.5; },
    o => { o.bytes.backendPngRead = -1; }, o => { o.counts.invalidTimingSamples = 1; },
    o => { o.stages.identity = { calls: 1, failures: 2, durationMs: 1 }; },
    o => { o.stages.identity = { calls: 1, failures: 0, durationMs: Infinity }; },
  ]) { const s = sample(); mutate(s.observation); invalid.push([s]); }
  for (const input of invalid) assert.throws(() => summarize(input));
});
