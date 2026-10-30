'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTraceProvider, ComputerMethod, TOOL_NAMES } = require('../src/method/index.cjs');

const window = { id: 'w', pid: 7, processName: 'fixture', processCreationTime: '100' };
const effects = [{ id: 'effect', checkId: 'effect-check', steps: [{ id: 'step', checkId: 'step-check',
  capability: 'native-action', target: { environment: 'local', app: 'fixture', kind: 'app', windowId: 'w' } }] }];
const checks = { verifyStep: async () => 'confirmed', verifyEffect: async () => 'confirmed' };
const tools = TOOL_NAMES.map(name => ({ name, inputSchema: { properties: {} } }));
const response = structuredContent => ({ structuredContent });

async function provider(mode, proof = () => ({ verified: true, inputReleased: true, ownedProcessExited: true }), options = {}) {
  const p = createTraceProvider({ app: 'fixture', windowId: 'w', tools, recover: proof, ...(options.id ? { id: options.id } : {}),
    callTool: async ({ name }) => {
      if (name === TOOL_NAMES[0]) return response({ ready: true });
      if (name === TOOL_NAMES[1]) return response({ windows: [options.window || window] });
      if (name === TOOL_NAMES[2]) {
        if (mode === 'transport') throw new Error('transport failed');
        if (mode === 'malformed') return response({});
        return { ...response({ error: { code: 'open_failed', cleanup: 'unknown', inputRecoveryRequired: true } }), isError: true };
      }
      throw new Error('unexpected call');
    } });
  await p.doctor(); return p;
}

test('uncertain native open quarantines and survives checkpoint with a new provider', async () => {
  for (const mode of ['transport', 'malformed', 'cleanup']) {
    const p = await provider(mode);
    const m = new ComputerMethod({ providers: [p], ...checks });
    m.start({ goalId: 'goal', effects }); await m.discover('effect', 'step');
    await assert.rejects(m.observe('effect', 'step'));
    const state = m.status().effects[0].steps[0];
    assert.equal(state.quarantine, true); assert.equal(state.attempts, 0); assert.equal(state.uncertain, false);
    const snapshot = m.checkpoint(); assert.equal(snapshot.effects[0].steps[0].quarantine, true);
    const differentProvider = await provider(mode, undefined, { id: 'different-provider' });
    const wrongRoute = ComputerMethod.resume(snapshot, { goalId: 'goal', effects, providers: [differentProvider], ...checks });
    await assert.rejects(wrongRoute.discover('effect', 'step'), { code: 'no-route' });
    const differentLifetime = await provider(mode, undefined, { window: { ...window, processCreationTime: '101' } });
    const wrongTarget = ComputerMethod.resume(snapshot, { goalId: 'goal', effects, providers: [differentLifetime], ...checks });
    await assert.rejects(wrongTarget.discover('effect', 'step'), { code: 'target-changed' });
    const replacement = await provider(mode, () => ({ verified: false, inputReleased: true, ownedProcessExited: true }));
    const resumed = ComputerMethod.resume(snapshot, { goalId: 'goal', effects, providers: [replacement], ...checks });
    await resumed.discover('effect', 'step');
    await assert.rejects(resumed.observe('effect', 'step'), { code: 'quarantined' });
    await assert.rejects(resumed.execute('effect', 'step', { type: 'activate' }), { code: 'quarantined' });
    await assert.rejects(resumed.recover('effect', 'step'), { code: 'recovery-unverified' });
    assert.equal(resumed.status().effects[0].steps[0].quarantine, true);
    const recoveredProvider = await provider(mode);
    const recovered = ComputerMethod.resume(snapshot, { goalId: 'goal', effects, providers: [recoveredProvider], ...checks });
    await recovered.discover('effect', 'step');
    assert.equal((await recovered.recover('effect', 'step')).effectStillUncertain, false);
    assert.equal(recovered.status().effects[0].steps[0].quarantine, false);
    assert.equal(recovered.status().effects[0].steps[0].needsRevalidation, false);
  }
});

test('readiness rejection before desktop observation does not quarantine', async () => {
  const p = await provider('transport');
  const m = new ComputerMethod({ providers: [p], ...checks });
  m.start({ goalId: 'goal', effects }); await m.discover('effect', 'step');
  p.available = false;
  await assert.rejects(m.observe('effect', 'step'), { code: 'provider-unavailable' });
  assert.equal(m.status().effects[0].steps[0].quarantine, false);
});
