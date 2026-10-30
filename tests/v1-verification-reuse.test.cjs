'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createTraceProvider, ComputerMethod } = require('../src/method/index.cjs');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const hash = createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex');
const window = { id: 'w', pid: 7, processName: 'fixture', processCreationTime: '100', sessionId: 2, ownerWindowId: null };
const policy = { timing: 'immediate', requiredFields: ['images', 'elements', 'focus', 'targetState', 'accessibility'], maxAgeMs: 500 };
const spec = [{ id: 'effect', checkId: 'effect-check', steps: [{ id: 'step', checkId: 'step-check', capability: 'native-action',
  target: { environment: 'local', app: 'fixture', kind: 'app', windowId: 'w' } }] }];

async function setup(t, options = {}) {
  let captures = 0, actions = 0, now = 100, lease;
  const seen = [], control = { outcome: 'completed', missingImage: false, missingFocus: false, failObserve: false };
  function capture() {
    captures++;
    return { sessionId: 's', window, observationId: `capture-${captures}`, observedAt: '2026-10-29T12:00:00.000Z',
      bounds: { x: 0, y: 0, width: 1, height: 1 }, elements: [{ id: 'status', name: actions ? 'saved' : 'pending' }], accessibility: { depth: 8, truncated: false },
      focused: control.missingFocus ? { available: false } : { available: true, hasFocus: true, elementId: 'edit' },
      targetState: { ownerWindowId: null, enabled: true, minimized: false, foreground: true },
      screenshot: { data: PNG, mimeType: 'image/png', width: 1, height: 1, sha256: hash } };
  }
  const controller = {
    async doctor() { return { ready: true }; },
    async listWindows() { return { windows: [window] }; },
    async openSession() { lease = { sessionId: 's', window }; return lease; },
    async observe() { if (control.failObserve) throw new Error('capture failed'); return capture(); },
    async act() {
      actions++;
      const observation = capture();
      if (control.missingImage) delete observation.screenshot;
      return { actionId: 'a1', outcome: control.outcome, verification: 'fresh_observation', observation };
    },
    async closeSession() { lease = null; return { closed: true, cleanup: 'confirmed' }; },
    async close() { lease = null; }
  };
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller });
  await server.connect(b);
  const client = new Client({ name: 'reuse-test', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const p = createTraceProvider({ client, app: 'fixture', windowId: 'w', monotonicClock: () => now });
  await p.doctor();
  const verifyStep = async args => { seen.push(args); return options.check ? options.check(args, () => { now += 501; }) :
    args.after.evidence.state.elements.some(element => element.id === 'status' && element.name === 'saved') ? 'confirmed' : 'absent'; };
  const m = new ComputerMethod({ providers: [p], verifyStep, verifyEffect: async () => 'confirmed', clock: () => 1000,
    verificationPolicies: options.policy ? { 'step-check': options.policy } : {} });
  m.start({ goalId: 'goal', effects: spec });
  await m.discover('effect', 'step'); await m.observe('effect', 'step');
  return { p, m, control, seen, advance(ms) { now += ms; }, get captures() { return captures; }, get actions() { return actions; },
    async execute() { return m.execute('effect', 'step', { type: 'activate' }); } };
}

test('immediate policy reuses the native refresh; default and settled capture fresh', async t => {
  for (const selected of [policy, undefined, { timing: 'settled' }]) {
    const f = await setup(t, { policy: selected }); await f.execute();
    assert.equal(f.captures, 2);
    const result = await f.m.verifyStep('effect', 'step');
    const reuse = selected === policy;
    assert.equal(result.evidenceSource, reuse ? 'post-action' : 'fresh-observation');
    assert.equal(f.seen[0].evidenceSource, result.evidenceSource);
    assert.equal(f.captures, reuse ? 2 : 3);
    if (reuse) {
      assert.equal(f.seen[0].after.sourceCapturedAt, '2026-10-29T12:00:00.000Z');
      await assert.rejects(f.p.act({ target: f.seen[0].after.target, observationId: f.seen[0].after.id,
        capability: 'native-action', payload: { type: 'activate' } }), { code: 'stale-target' });
      await f.m.verifyEffect('effect'); assert.equal(f.captures, 3);
    }
    assert.equal(f.actions, 1);
  }
});

test('uncertain cached verdict or expiry falls back to fresh without repeating input', async t => {
  for (const mode of ['absent', 'unknown', 'throw', 'expires']) {
    const f = await setup(t, { policy, check: ({ evidenceSource }, expire) => {
      if (evidenceSource === 'fresh-observation') return 'confirmed';
      if (mode === 'throw') throw new Error('check failed');
      if (mode === 'expires') { expire(); return 'confirmed'; }
      return mode;
    } });
    await f.execute(); const result = await f.m.verifyStep('effect', 'step');
    assert.equal(result.verdict, 'confirmed'); assert.equal(result.evidenceSource, 'fresh-observation');
    assert.deepEqual(f.seen.map(x => x.evidenceSource), ['post-action', 'fresh-observation']);
    assert.equal(f.captures, 3); assert.equal(f.actions, 1);
  }
});

test('missing fields, expiry, unknown delivery, or invalid image force fresh verification', async t => {
  for (const mode of ['missing-field', 'expired', 'backwards', 'nonfinite', 'unknown', 'missing-image']) {
    const f = await setup(t, { policy });
    if (mode === 'missing-field') f.control.missingFocus = true;
    if (mode === 'unknown') f.control.outcome = 'unknown';
    if (mode === 'missing-image') f.control.missingImage = true;
    await f.execute();
    if (mode === 'expired') f.advance(501);
    if (mode === 'backwards') f.advance(-1);
    if (mode === 'nonfinite') f.advance(Infinity);
    const result = await f.m.verifyStep('effect', 'step');
    assert.equal(result.evidenceSource, 'fresh-observation');
    assert.deepEqual(f.seen.map(x => x.evidenceSource), ['fresh-observation']);
    assert.equal(f.captures, 3); assert.equal(f.actions, 1);
  }
});

test('checkpoint and discovery invalidate candidates and checkpoint stores no image', async t => {
  for (const invalidate of ['checkpoint', 'discover', 'consumed']) {
    const f = await setup(t, { policy }); await f.execute();
    if (invalidate === 'checkpoint') assert.equal(JSON.stringify(f.m.checkpoint()).includes(PNG), false);
    else if (invalidate === 'discover') await f.m.discover('effect', 'step');
    else assert.equal((await f.m.verifyStep('effect', 'step')).evidenceSource, 'post-action');
    assert.equal((await f.m.verifyStep('effect', 'step')).evidenceSource, 'fresh-observation');
    assert.equal(f.captures, 3); assert.equal(f.actions, 1);
  }
});

test('failed fallback capture leaves the uncertain step unresolved', async t => {
  const f = await setup(t, { policy, check: () => 'unknown' }); await f.execute();
  f.control.failObserve = true;
  await assert.rejects(f.m.verifyStep('effect', 'step'));
  const step = f.m.status().effects[0].steps[0];
  assert.equal(step.status, 'unknown'); assert.equal(step.uncertain, true); assert.equal(f.actions, 1);
});

test('fresh absent verdict records retry evidence', async t => {
  const f = await setup(t, { check: () => 'absent' });
  await f.execute();
  assert.equal((await f.m.verifyStep('effect', 'step')).status, 'retryable');
  assert.equal(f.actions, 1);
});

test('the next step needs its own discovery and observation after reuse', async t => {
  const f = await setup(t, { policy }); await f.execute(); await f.m.verifyStep('effect', 'step');
  f.m.appendStep('effect', { id: 'next', checkId: 'next-check', capability: 'native-action',
    target: { environment: 'local', app: 'fixture', kind: 'app', windowId: 'w' } });
  await assert.rejects(f.m.execute('effect', 'next', { type: 'activate' }), { code: 'route-changed' });
  await f.m.discover('effect', 'next');
  await assert.rejects(f.m.execute('effect', 'next', { type: 'activate' }), { code: 'stale-observation' });
  await f.m.observe('effect', 'next'); await f.m.execute('effect', 'next', { type: 'activate' });
  assert.equal(f.actions, 2); assert.equal(f.captures, 4);
});
