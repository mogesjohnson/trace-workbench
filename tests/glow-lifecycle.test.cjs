'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const driver = require('../scripts/accept-glow-lifecycle.cjs');
const common = require('../scripts/replacement-acceptance-common.cjs');

test('lifecycle plan is inert and proposes no repeated input', async () => {
  const result = await driver.run({}, { command: () => assert.fail('No desktop read during plan') });
  assert.equal(result.attempt, 9); assert.equal(result.claimsAttempt, false); assert.equal(result.inputActions, 0);
});

test('injected lifecycle covers cleanup failure and late absence without any input or real claims', async t => {
  const base = path.join(common.ROOT, '.runtime'); await fs.mkdir(base, { recursive: true });
  for (const scenario of ['pass', 'missing-approval', 'close-failure', 'late-absence']) {
    const root = await fs.mkdtemp(path.join(base, 'lifecycle-test-'));
    t.after(async () => { assert.equal(path.dirname(root), base); await fs.rm(root, { recursive: true, force: true }); });
    const events = [], target = { id: '12', pid: 123, processCreationTime: '1000', sessionId: 1 };
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const display = { monitors: 1, displays: [{ device: 'synthetic', primary: true, dpi: 144, bounds }] };
    const state = { ready: true, pid: 123, windowId: '12', monitor: bounds, dpi: 144, input: { leftButtonDown: false } };
    for (const name of ['count', 'mouseClickCount', 'activationCount', 'mouseDownCount', 'mouseUpCount']) state[name] = 0;
    const chain = Object.fromEntries(['node', 'supervisor', 'marker'].map((name, i) => [name, { pid: 200 + i, name, created: name, sessionId: 1 }]));
    let clock = 0;
    const deps = { clock: () => clock, verify: async () => {}, sourceHashes: async () => ({ files: {} }), delay: async () => {},
      command: async ([verb]) => {
        if (verb === 'display') return display;
        if (verb === 'status') return { recoveryRequired: false };
        if (verb === 'input-access') return { observable: true };
        if (verb === 'keystate') return { down: [] };
        assert.equal(verb, 'identity'); return { pid: 123, processCreationTime: '1000', session: 1 };
      },
      leaseFree: async () => true, bridge: async () => ({ ...target, foreground: true }),
      claim: async () => { if (scenario === 'missing-approval') throw Error('No approval'); return { attempt: 9 }; },
      waitFor: async (read, predicate) => { const value = await read(); assert.ok(predicate(value)); return value; },
      readChain: async () => chain, waitIdentityExit: async () => true,
      fixture: async () => { events.push('fixture'); return { pid: 123, sha256: 'synthetic', state: async () => state,
        focus: async () => ({ fixtureForeground: true, foregroundWindowId: '12', focusedWindowId: '12' }),
        capture: async (filename, pid) => {
          if (scenario === 'late-absence' && filename.includes('-absent')) clock += 6000;
          return { bytes: Buffer.from('injected frame'), interiorBackgroundVerified: true,
            bands: { width: 1920, height: 1080, tintedLeft: pid ? 11 : 0, tintedTop: pid ? 11 : 0,
              backgroundLeft: pid ? 0 : 24, backgroundTop: pid ? 0 : 24 } };
        }, close: async () => { events.push('fixture-closed'); return { exited: true }; } }; },
      connect: async () => ({ close: async () => { events.push('transport-closed'); return true; },
        killAbruptly: async () => { events.push('owned-node-loss'); }, call: async name => {
          events.push(name);
          if (name === 'doctor') return { ready: true };
          if (name === 'list_windows') return { windows: [target] };
          if (name === 'open_session') return { sessionId: 'synthetic', activityIndicator: { monitors: 1, owner: 'native-supervisor' } };
          assert.equal(name, 'close_session', 'Unexpected action, observation or input');
          if (scenario === 'close-failure') throw Error('Close failed'); return { closed: true };
        } }) };
    const result = await driver.run({ mode: 'live', directory: path.join(root, 'result') }, deps);
    assert.equal(result.status, scenario === 'pass' ? 'pass' : 'fail');
    if (scenario === 'missing-approval') assert.deepEqual(events, []);
    else { assert.ok(events.includes('transport-closed')); assert.ok(events.includes('fixture-closed')); }
    if (scenario === 'pass') { assert.equal(result.phases.length, 2); assert.ok(events.includes('owned-node-loss')); }
  }
});
