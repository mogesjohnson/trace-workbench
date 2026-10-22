'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareAcceptanceForeground } = require('../scripts/acceptance-foreground.cjs');

const anchor = { id: '123456', pid: 123, processCreationTime: '134370250537189590', sessionId: 1 };
const proof = () => ({ available: true, leaseActive: false, nativeOperationActive: false, inputChildExitVerified: true,
  input: { available: true, down: [] }, recovery: { available: true, ready: true, recoveryRequired: false } });
function harness(options = {}) {
  const calls = []; let owner = null, checks = 0, identities = 0, verifications = 0;
  const expected = { hwnd: anchor.id, pid: anchor.pid, processCreationTime: anchor.processCreationTime, sessionId: anchor.sessionId };
  const lease = {
    async acquire(id) { calls.push('acquire'); if (options.busy) throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'desktop_busy' }); owner = id; },
    async assert(id) { calls.push('assert'); assert.equal(id, owner); },
    async release(id) { calls.push('release'); assert.equal(id, owner); if (options.releaseFails) throw new Error('PRIVATE_PATH'); owner = null; },
  };
  return { calls, get owner() { return owner; }, run: (extra = {}) => prepareAcceptanceForeground({ anchor,
    lease,
    inspectSafety: async () => { calls.push('safety'); checks++; return options.proof ? options.proof(checks) : proof(); },
    verifyBridge: async () => { calls.push('verify'); verifications++; if (options.verifyFails === verifications) throw Object.assign(new Error('PRIVATE_PATH'), { code: 'bridge_integrity' }); },
    bridge: async (verb, target) => {
      calls.push(verb); assert.deepEqual(target, expected);
      const actual = { ...expected, enabled: true, foreground: true, minimized: false };
      if (verb === 'identity' && ++identities === options.changedAt) Object.assign(actual, options.change);
      if (verb === 'activate' && options.activateFails) throw Object.assign(new Error('PRIVATE_ERROR'), { code: 'foreground_not_target' });
      if (verb === 'bounds' && options.disabled) actual.enabled = false;
      if (verb === 'activate' && options.activationChange) Object.assign(actual, options.activationChange);
      return actual;
    }, ...extra }) };
}

test('foreground preparation is exact, exclusive, independently guarded and sanitized', async () => {
  const h = harness(), result = await h.run();
  assert.deepEqual(result, { preparation: 'fixture-foreground-anchor', prepared: true, activationAttempted: true, cleanupConfirmed: true, code: null });
  assert.equal(h.calls.filter(x => x === 'activate').length, 1);
  assert.equal(h.calls.filter(x => x === 'verify').length, 2);
  assert.equal(h.calls.filter(x => x === 'safety').length, 3);
  assert.equal(h.calls[0], 'acquire'); assert.equal(h.calls.at(-1), 'release'); assert.equal(h.owner, null);
  assert.equal(h.calls.some(x => /release-left|recover|click|key|capture/.test(x)), false);
  assert.equal(JSON.stringify(result).includes(anchor.processCreationTime), false);
});

test('invalid or incomplete exact anchors reject before acquiring ownership or bridge calls', async () => {
  for (const bad of [null, {}, { ...anchor, processCreationTime: undefined }, { ...anchor, sessionId: undefined },
    { ...anchor, sessionId: '1' }, { ...anchor, hwnd: '999' }, { ...anchor, pid: -1 }, { ...anchor, id: 'C:/PRIVATE' }]) {
    const h = harness(), result = await h.run({ anchor: bad });
    assert.equal(result.code, 'preparation_anchor_invalid'); assert.equal(result.activationAttempted, false); assert.deepEqual(h.calls, []);
  }
});

test('unavailable safety, held keys, recovery and active native ownership block all activation', async () => {
  const cases = [undefined, { ...proof(), available: false }, { ...proof(), input: { available: true, down: [1] } },
    { ...proof(), recovery: { available: true, ready: false, recoveryRequired: true } },
    { ...proof(), leaseActive: true }, { ...proof(), nativeOperationActive: true }, { ...proof(), inputChildExitVerified: false }];
  for (const value of cases) {
    const h = harness({ proof: () => value }), result = await h.run();
    assert.equal(result.prepared, false); assert.equal(result.activationAttempted, false);
    assert.equal(h.calls.includes('activate'), false); assert.equal(h.calls.at(-1), 'release'); assert.equal(h.owner, null);
  }
});

test('cleanup proof is refreshed before activation and after activation', async () => {
  for (const unsafeAt of [2, 3]) {
    const h = harness({ proof: n => n === unsafeAt ? { ...proof(), input: { available: false } } : proof() });
    const result = await h.run(); assert.equal(result.code, 'preparation_safety_unavailable');
    assert.equal(result.activationAttempted, unsafeAt === 3); assert.equal(result.prepared, false); assert.equal(result.cleanupConfirmed, true);
  }
});

test('same HWND/PID with changed creation time or session rejects before activation', async () => {
  for (const change of [{ processCreationTime: '134370250537189591' }, { sessionId: 2 }, { hwnd: '999999' }, { pid: 124 }]) {
    for (const changedAt of [1, 2]) {
      const h = harness({ change, changedAt }), result = await h.run();
      assert.equal(result.code, 'preparation_anchor_changed'); assert.equal(h.calls.includes('activate'), false);
      assert.equal(result.cleanupConfirmed, true); assert.equal(h.calls.at(-1), 'release');
    }
  }
});

test('post-activation identity change or failed foreground result is never accepted', async () => {
  for (const options of [{ changedAt: 3, change: { sessionId: 2 } },
    { activationChange: { processCreationTime: '134370250537189591' } }, { activateFails: true }]) {
    const h = harness(options), result = await h.run();
    assert.equal(result.prepared, false); assert.equal(result.activationAttempted, true); assert.equal(result.cleanupConfirmed, true);
    assert.equal(h.calls.at(-1), 'release');
  }
});

test('busy lease, disabled anchor and bridge integrity failures never bypass guards', async () => {
  for (const options of [{ busy: true }, { disabled: true }, { verifyFails: 1 }, { verifyFails: 2 }]) {
    const h = harness(options), result = await h.run(); assert.equal(result.prepared, false);
    assert.equal(result.activationAttempted, options.verifyFails === 2);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(h.calls.includes('release'), !options.busy);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});

test('aborted work sends no activation and uncertain lease release cannot report success', async () => {
  const abort = new AbortController(); abort.abort(); const h = harness();
  assert.equal((await h.run({ signal: abort.signal })).code, 'cancelled'); assert.deepEqual(h.calls, []);
  const unknown = harness({ releaseFails: true }), result = await unknown.run();
  assert.equal(result.code, 'preparation_cleanup_unknown'); assert.equal(result.prepared, false); assert.equal(result.cleanupConfirmed, false);
});
