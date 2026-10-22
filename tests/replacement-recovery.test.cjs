'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const driver = require('../scripts/accept-replacement-recovery.cjs');
const common = require('../scripts/replacement-acceptance-common.cjs');
const MOUSE = 'R32-CANCEL-MOUSE-COMPLETE', TYPING = 'R32-CANCEL-TYPING-COMPLETE';
const options = caseId => ({ caseId, mode: 'live', directory: 'unused', ownerDecision: 'owner-review-reference' });

test('replacement selection is fixed before execution and preserves exhausted original links', () => {
  assert.deepEqual(Object.keys(driver.REGISTRY), [MOUSE, TYPING]);
  assert.throws(() => driver.plan({ caseId: 'R32-ARBITRARY' }), /Select exactly/);
  for (const caseId of [MOUSE, TYPING]) {
    const declared = driver.plan({ caseId });
    assert.equal(declared.caseId, caseId); assert.equal(declared.ownerDecision, null);
    assert.equal(declared.declaredBeforeUiLaunch, true); assert.equal(declared.executionRequiresExplicitOwnerDecision, true);
    assert.ok(declared.replaces.every(id => id.startsWith('A32-')));
    assert.equal(declared.actions.length, 5);
  }
});

test('live plans require a decision reference and finite attempt metadata', () => {
  assert.throws(() => driver.plan({ caseId: MOUSE, mode: 'live', directory: 'unused' }), /owner decision/);
  assert.throws(() => driver.plan({ ...options(MOUSE), attempt: 3 }), /attempt 1 or 2/);
  assert.throws(() => driver.plan({ ...options(MOUSE), attempt: 2, prior: 'unused' }), /changed precondition/);
  assert.throws(() => driver.plan({ ...options(MOUSE), prior: 'unused', change: 'change' }), /Attempt 1/);
  assert.throws(() => driver.parseArgs(['--case', MOUSE, '--attempt']), /Missing value/);
  assert.equal(driver.parseArgs(['--plan', '--case', TYPING]).caseId, TYPING);
});

test('read-only plan performs no file/native/UI dependency calls', async () => {
  assert.equal((await driver.run({ caseId: MOUSE })).caseId, MOUSE);
  assert.equal((await driver.run({ caseId: TYPING })).caseId, TYPING);
});

test('retry rejects wrong case, third attempt, pass, missing contract and mismatched decision', async t => {
  const prior = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-replacement-recovery-'));
  t.after(() => fs.rm(prior, { recursive: true, force: true }));
  const base = { caseId: MOUSE, attempt: 1, status: 'blocked', planContract: 1, ownerDecision: 'owner-review-reference' };
  const next = driver.optionsFor({ ...options(MOUSE), attempt: 2, prior, change: 'Accessible foreground established before the next launch.' });
  for (const delta of [{ caseId: TYPING }, { caseId: 'A32-RECOVERY-CANCEL-MOUSE' }, { attempt: 2 }, { status: 'pass' }, { status: 'running' }, { planContract: undefined }, { ownerDecision: 'another-decision' }]) {
    await fs.writeFile(path.join(prior, 'receipt.json'), JSON.stringify({ ...base, ...delta }));
    await assert.rejects(common.checkPrior(next), /exact replacement/);
  }
  for (const status of ['fail', 'blocked']) {
    await fs.writeFile(path.join(prior, 'receipt.json'), JSON.stringify({ ...base, status }));
    assert.equal((await common.checkPrior(next)).status, status);
  }
});

function passing(caseId = MOUSE) {
  const target = { pid: 10, processCreationTime: '100', sessionId: 2 };
  const identity = (pid, parent) => ({ pid, parent, created: `created-${pid}`, processCreationTime: String(pid * 10), session: 2, user: 'synthetic-user' });
  const ownership = { node: identity(11, 99), supervisor: identity(12, 11), marker: identity(13, 12), fixture: identity(10) };
  const child = identity(14, 12), exits = Object.fromEntries(['node', 'supervisor', 'marker'].map(name => [name, { exited: true, identity: ownership[name] }]));
  const followupOwnership = { node: identity(21, 99), supervisor: identity(22, 21), marker: identity(23, 22), fixture: identity(10) };
  const followupExits = Object.fromEntries(['node', 'supervisor', 'marker'].map(name => [name, { exited: true, identity: structuredClone(followupOwnership[name]) }]));
  return { caseId, input: caseId === MOUSE ? 'mouse' : 'typing', failure: 'cancel', status: 'pass', target, ownership,
    controlled: { inJob: true, pid: 14, processCreationTime: '140', supervisorPid: 12, identity: child },
    focus: { public: { available: true, hasFocus: true, elementId: 'edit' }, element: { id: 'edit', name: 'TRACE text input', enabled: true },
      independent: { focusedControl: 'traceTextInput', text: '', count: 0 }, boundObservedMatches: 1, observationId: 'fresh-frame' },
    nativeOutcome: { code: 'cancelled', outcome: 'unknown', recovery: { released: true, processExitConfirmed: true } },
    childExitIndependently: true, keysAfter: [], effect: { text: caseId === MOUSE ? '' : 'abcccc', count: 0, unchangedAfterCleanup: true },
    followupOwnership,
    followup: { before: 0, after: 1, exactIncrement: 1, provider: 'pinned-engine' }, cleanup: { connectionClosed: true, inputChildExited: true,
      supervisorExited: true, fixtureExited: true, inputState: { available: true, down: [] }, recovery: { recoveryRequired: false },
      exactOwnedExit: { ...structuredClone(exits), inputChild: { exited: true, identity: child } },
      followupExactOwnedExit: followupExits, exactFixtureExit: { exited: true, identity: ownership.fixture } } };
}
test('terminal oracle retains controlled unknown cancellation, stable text and exactly one followup', () => {
  assert.deepEqual(driver.validateResult(passing(TYPING), { caseId: TYPING }), { text: 'abcccc', repeatedCCount: 3 });
  assert.deepEqual(driver.validateResult(passing(), { caseId: MOUSE }), { text: '', repeatedCCount: 0 });
  for (const change of [p => p.nativeOutcome.code = 'native_timeout', p => p.controlled.inJob = false,
    p => p.nativeOutcome.outcome = 'completed', p => p.followup.after = 2, p => p.cleanup.inputState.available = false,
    p => p.cleanup.recovery.recoveryRequired = true, p => p.effect.unchangedAfterCleanup = false]) {
    const primary = passing(); change(primary); assert.throws(() => driver.validateResult(primary, { caseId: MOUSE }));
  }
  for (const text of ['', 'abcx', 'ab', 'ABC']) {
    const primary = passing(TYPING); primary.effect.text = text;
    assert.throws(() => driver.validateResult(primary, { caseId: TYPING }));
  }
});

test('terminal validation rejects missing or mismatched focus, process generations, sessions and exit evidence', () => {
  for (const change of [p => delete p.focus, p => p.focus.public.hasFocus = false, p => p.focus.public.elementId = 'other',
    p => p.focus.boundObservedMatches = 2, p => p.focus.independent.focusedControl = 'anotherControl',
    p => delete p.target.sessionId, p => p.ownership.marker.session = 3, p => p.ownership.supervisor.parent = 45,
    p => p.ownership.fixture.processCreationTime = 'wrong', p => p.controlled.identity.processCreationTime = '141',
    p => delete p.cleanup.exactOwnedExit.marker, p => p.cleanup.exactOwnedExit.inputChild.exited = false, p => p.followupOwnership = p.ownership,
    p => p.cleanup.followupExactOwnedExit.node.identity.processCreationTime = '999',
    p => p.cleanup.exactFixtureExit.identity.session = 3, p => p.cleanup.retainedQuarantine = { recoveryRequired: true }]) {
    const primary = passing(); change(primary); assert.throws(() => driver.validateResult(primary, { caseId: MOUSE }));
  }
});

function injectedEvidence() {
  const primary = passing(), target = { id: 'owned-hwnd', ...primary.target };
  const chain = Object.fromEntries(['node', 'supervisor', 'marker'].map(name => {
    const { pid, parent, created } = primary.ownership[name]; return [name, { pid, parent, created }];
  }));
  const identities = new Map(Object.values(primary.ownership).concat(primary.controlled.identity).map(value => [value.pid, structuredClone(value)]));
  const injected = { readChain: async () => structuredClone(chain), bridge: async () => ({ ...target }),
    command: async args => structuredClone(identities.get(Number(args[1]))), alive: async () => false,
    waitFor: async (work, predicate) => { const value = await work(); assert.equal(predicate(value), true); return value; } };
  return { primary, target, chain, identities, injected, connection: { transport: { pid: chain.node.pid } } };
}
test('injected evidence captures bound focus/owned chain and verifies exact primary and followup exits', async () => {
  const state = injectedEvidence(), callbacks = driver.evidenceCallbacks(state.injected);
  assert.deepEqual(await callbacks.opened(state.connection, state.target), state.primary.ownership);
  const frame = { window: state.target, focused: state.primary.focus.public, elements: [state.primary.focus.element], observationId: 'fresh-frame' };
  assert.deepEqual(await callbacks.focus(state.connection, state.target, frame, state.primary.focus.independent), state.primary.focus);
  assert.deepEqual(await callbacks.dispatched(state.connection, state.target, state.primary.controlled), state.primary.controlled.identity);
  assert.equal((await callbacks.closed()).marker.exited, true);
  for (const name of ['node', 'supervisor', 'marker']) {
    state.chain[name] = state.primary.followupOwnership[name];
    state.identities.set(state.chain[name].pid, state.chain[name]);
  }
  await callbacks.followupOpened({ transport: { pid: state.chain.node.pid } }, state.target);
  assert.equal((await callbacks.followupClosed()).node.exited, true);
  assert.equal((await callbacks.fixtureClosed()).exited, true);
});
test('injected evidence rejects generation changes, wrong session and unavailable live exit queries', async () => {
  {
    const state = injectedEvidence(); state.identities.get(13).session = 3;
    await assert.rejects(driver.evidenceCallbacks(state.injected).opened(state.connection, state.target));
  }
  {
    const state = injectedEvidence(); let reads = 0;
    state.injected.readChain = async () => ({ ...state.chain, node: { ...state.chain.node, created: ++reads === 1 ? 'first' : 'reused' } });
    await assert.rejects(driver.evidenceCallbacks(state.injected).opened(state.connection, state.target), /generation changed/);
  }
  {
    const state = injectedEvidence(), callbacks = driver.evidenceCallbacks(state.injected);
    await callbacks.opened(state.connection, state.target);
    // A live PID plus an inaccessible identity must remain unconfirmed, never prove exit.
    state.injected.alive = async () => true;
    const inaccessible = driver.evidenceCallbacks({ ...state.injected, command: async () => { throw new Error('identity unavailable'); } });
    await assert.rejects(inaccessible.opened(state.connection, state.target), /identity unavailable/);
    // The callback snapshots dependencies, so create its owner before switching the query result.
    let available = true;
    const exitCallbacks = driver.evidenceCallbacks({ ...state.injected, command: async args => {
      if (!available) throw new Error('identity unavailable'); return state.injected.command(args);
    } });
    await exitCallbacks.opened(state.connection, state.target); available = false;
    await assert.rejects(exitCallbacks.closed(), /identity unavailable/);
  }
});
