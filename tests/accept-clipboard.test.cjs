'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PAYLOAD, plan, parseArgs, sameSupportedBytes, launchOwnedFixture, runCase, run, runContinuation, trackedClose } = require('../scripts/accept-clipboard.cjs');

const error = code => Object.assign(new Error('PRIVATE_ERROR_CONTENT'), { code });
function harness(options = {}) {
  const events = [], saved = [];
  const original = { token: 'PRIVATE_ORIGINAL_TOKEN', sequence: 123456, mode: 'text-only',
    formats: [{ id: 13, bytes: 38, sha256: 'PRIVATE_ORIGINAL_HASH' }] };
  const state = { text: '', count: 0, focusedControl: 'traceTextInput' };
  let readbacks = 0;
  let deferred = false, restored = false;
  const clipboard = {
    async doctor() { events.push('clipboard-doctor'); return { ready: !options.pending, code: 'clipboard_recovery_required' }; },
    async snapshot() { events.push('snapshot'); if (options.rich) throw error('clipboard_unsupported_formats'); return original; },
    async writeText({ text }) { events.push('write'); assert.equal(text, PAYLOAD); if (options.writeLost) throw error('clipboard_transport_uncertain'); return { verified: true }; },
    async readback() {
      events.push('readback'); readbacks++;
      if (options.changedAt === readbacks) throw error('clipboard_changed');
      return { matches: true };
    },
    async deferAutomaticRestore() { events.push('defer'); deferred = true; return { automaticRestoreDeferred: true }; },
    async restore({ inputQuiescent }) { events.push('restore'); assert.equal(inputQuiescent, true); if (options.restoreChanged) throw error('clipboard_changed'); restored = true; return { restored: true, verified: true, exactSupportedBytes: true }; },
    async close() { events.push('clipboard-close'); return { cleanup: options.restoreChanged || (deferred && !restored) ? 'unknown' : 'confirmed' }; },
    async abandon() { throw new Error('Acceptance must never abandon/reset the clipboard automatically.'); },
  };
  const verifier = {
    async doctor() { events.push('verifier-doctor'); return { ready: true }; },
    async snapshot() { events.push('verifier-snapshot'); return options.finalChanged ? { ...original, formats: [] } : structuredClone(original); },
    async close() { events.push('verifier-close'); return { cleanup: 'confirmed' }; },
  };
  const connection = {
    async call(name, args) {
      events.push(`mcp-${name}${name === 'act' ? '-' + args.action.type : ''}`);
      if (name === 'doctor') return { ready: true };
      if (name === 'list_windows') return { windows: [{ id: 'owned-hwnd', pid: 555, title: 'owned-title', processCreationTime: 'owned-generation' }] };
      if (name === 'open_session') return { sessionId: 'owned-session' };
      if (name === 'observe') return { observationId: 'before-click', elements: [{ id: 'edit-id', name: 'TRACE text input', enabled: true }] };
      if (name === 'act' && args.action.type === 'click') {
        assert.equal(args.observationId, 'before-click'); assert.equal(args.action.elementId, 'edit-id');
        return { outcome: 'completed', observation: { observationId: 'after-click', focused: { hasFocus: true, elementId: options.wrongFocus ? 'other' : 'edit-id' } } };
      }
      if (name === 'act') {
        assert.deepEqual(args.action, { type: 'press_key', key: 'CTRL+V' }); assert.equal(args.observationId, 'after-click');
        state.text = options.wrongText ? 'PRIVATE_HUMAN_CLIPBOARD' : PAYLOAD;
        if (options.pasteLost) throw error('transport_closed');
        return { outcome: options.pasteRejected ? 'not_dispatched' : 'completed' };
      }
      if (name === 'close_session') {
        if (options.latePaste) { assert.equal(restored, false, 'Private clipboard must not be restored before native drain.'); events.push('late-paste-drained'); }
        return { closed: true };
      }
      throw new Error(name);
    },
    async close() { events.push('mcp-close'); return { closed: !options.connectionUnknown }; },
  };
  return {
    events, saved,
    async run() { return runCase({ clipboard, preparedSnapshot: options.prepared ? original : undefined, freshClipboard: async () => verifier,
      connect: async () => { events.push('connect'); if (options.connectCleanupUnknown) throw Object.assign(error('connect_failed'), { ownedConnectionCleanupUnknown: true }); return connection; },
      launchTarget: async () => { events.push('fixture-launch'); if (options.fixtureCleanupUnknown) throw Object.assign(error('fixture_failed'), { ownedFixtureCleanupUnknown: true }); return { pid: 555, title: 'owned-title',
        state: async () => { events.push('fixture-state'); return { ...state }; },
        close: async () => { events.push('fixture-close'); return { exited: true }; } }; },
      inspectInput: async () => { events.push('input-check'); return { safe: !options.inputUnknown }; },
      persist: async receipt => { events.push('persist'); saved.push(JSON.parse(JSON.stringify(receipt))); },
      signal: options.signal,
    }); },
  };
}

test('clipboard acceptance plan is safe to import/run and retry requires prior failed evidence plus change', async () => {
  assert.equal(plan().declaredBeforeSnapshotAndUi, true);
  assert.equal(plan().expected.pasteDispatches, 1);
  assert.equal(parseArgs([]).mode, 'plan');
  assert.deepEqual(await run(parseArgs(['--plan'])), plan());
  for (const args of [['--live'], ['out', '--live', '--attempt', '2'], ['out', '--live', '--attempt', '3'], ['out', '--live', '--prior', 'old']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['out', '--live', '--attempt', '2', '--prior', 'old', '--change', 'Verified source fix']).attempt, 2);
});

test('live workflow pastes once, verifies both guards/effect, restores before close and compares fresh metadata only in memory', async () => {
  const h = harness(), receipt = await h.run();
  assert.equal(receipt.status, 'pass'); assert.equal(receipt.cleanup.confirmed, true);
  assert.equal(receipt.paste.dispatches, 1); assert.equal(receipt.paste.clipboardGuardBeforeAndAfter, true);
  assert.equal(receipt.cleanup.independentSupportedBytesRestored, true);
  assert.equal(h.events.filter(item => item === 'mcp-act-press_key').length, 1);
  assert.ok(h.events.indexOf('restore') < h.events.indexOf('clipboard-close'));
  assert.ok(h.events.indexOf('input-check') < h.events.indexOf('restore'));
  assert.ok(h.events.indexOf('fixture-close') < h.events.indexOf('restore'));
  assert.ok(h.events.indexOf('mcp-act-click') < h.events.indexOf('write'));
  assert.ok(h.events.indexOf('defer') < h.events.indexOf('mcp-act-press_key'));
  assert.ok(h.events.indexOf('clipboard-close') < h.events.indexOf('verifier-snapshot'));
  assert.ok(h.events.indexOf('mcp-close') < h.events.indexOf('fixture-close'));
  const persistedAttempt = h.saved.find(item => item.paste.attempted);
  assert.equal(persistedAttempt.paste.requests, 1); assert.equal(persistedAttempt.paste.dispatches, null);
  const output = JSON.stringify(h.saved);
  for (const privateValue of ['PRIVATE_ORIGINAL_TOKEN', 'PRIVATE_ORIGINAL_HASH', '123456', 'PRIVATE_ERROR_CONTENT']) assert.equal(output.includes(privateValue), false);
});

test('rich clipboard blocks before mutation or fixture launch and never resets/abandons it', async () => {
  const h = harness({ rich: true }), receipt = await h.run();
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.error.code, 'clipboard_unsupported_formats');
  assert.equal(receipt.paste.attempted, false); assert.equal(receipt.cleanup.confirmed, true);
  for (const event of ['write', 'fixture-launch', 'restore', 'mcp-act-press_key']) assert.equal(h.events.includes(event), false);
});

test('pending recovery never launches UI; failed write after focus never pastes and still attempts guarded restore', async () => {
  for (const options of [{ pending: true }, { writeLost: true }]) {
    const h = harness(options), receipt = await h.run();
    assert.equal(receipt.status, 'blocked'); assert.equal(h.events.includes('fixture-launch'), !options.pending);
    assert.equal(h.events.includes('mcp-act-press_key'), false);
    assert.equal(h.events.filter(item => item === 'write').length, options.pending ? 0 : 1);
    assert.equal(h.events.includes('restore'), !options.pending);
  }
});

test('incorrect native focus rejects clipboard mutation and the only paste before dispatch', async () => {
  const h = harness({ wrongFocus: true }), receipt = await h.run();
  assert.equal(receipt.status, 'fail'); assert.equal(receipt.error.code, 'fixture_focus_mismatch');
  assert.equal(receipt.paste.attempted, false); assert.equal(h.events.includes('restore'), true);
  assert.equal(h.events.includes('write'), false); assert.equal(h.events.includes('defer'), false);
  assert.deepEqual(receipt.focus, { publicHasFocus: true, publicMatchesObservedEdit: false, independentMatches: true, textEmpty: true });
});

test('lost paste receipt still gets independent fixture inspection and cannot replay', async () => {
  const h = harness({ pasteLost: true }), receipt = await h.run();
  assert.equal(receipt.status, 'fail'); assert.equal(receipt.paste.outcome, 'unknown');
  assert.equal(receipt.paste.requests, 1); assert.equal(receipt.paste.dispatches, null);
  assert.equal(receipt.effect.exactSyntheticText, true);
  assert.equal(h.events.filter(item => item === 'mcp-act-press_key').length, 1);
  assert.ok(h.events.lastIndexOf('fixture-state') > h.events.indexOf('mcp-act-press_key'));
  assert.equal(receipt.cleanup.confirmed, true);
});

test('clipboard changes before paste reject it; changes after paste preserve uncertainty and protected recovery', async () => {
  const before = harness({ changedAt: 2, restoreChanged: true }), a = await before.run();
  assert.equal(a.status, 'blocked'); assert.equal(a.paste.attempted, false);
  const after = harness({ changedAt: 3, restoreChanged: true }), b = await after.run();
  assert.equal(b.status, 'blocked'); assert.equal(b.paste.dispatches, 1);
  assert.equal(b.cleanup.outcome, 'unknown'); assert.equal(b.cleanup.restoration.protectedRecovery, 'preserved_if_pending');
  assert.equal(b.cleanup.restoration.currentClipboardPreserved, true);
  assert.equal(after.events.includes('verifier-snapshot'), false);
  assert.equal(after.events.filter(item => item === 'write').length, 1);
});

test('unexpected pasted text remains absent from every checkpoint and the final receipt', async () => {
  const h = harness({ wrongText: true }), receipt = await h.run();
  assert.equal(receipt.status, 'fail'); assert.equal(receipt.effect.exactSyntheticText, false);
  assert.equal(JSON.stringify(h.saved).includes('PRIVATE_HUMAN_CLIPBOARD'), false);
  assert.equal(JSON.stringify(h.saved).includes('PRIVATE_ERROR_CONTENT'), false);
  assert.equal(h.events.filter(item => item === 'mcp-act-press_key').length, 1);
});

test('fresh-byte mismatch and unconfirmed owned cleanup cannot report acceptance pass', async () => {
  for (const options of [{ finalChanged: true }, { connectionUnknown: true }, { inputUnknown: true }]) {
    const receipt = await harness(options).run();
    assert.equal(receipt.status, 'blocked'); assert.equal(receipt.cleanup.confirmed, false); assert.equal(receipt.cleanup.outcome, 'unknown');
  }
});

test('pre-existing interruption never starts any clipboard or UI work', async () => {
  const abort = new AbortController(); abort.abort();
  const h = harness({ signal: abort.signal }), receipt = await h.run();
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.error.code, 'acceptance_interrupted');
  assert.equal(h.events.includes('snapshot'), false); assert.equal(h.events.includes('connect'), false);
});

test('startup cleanup uncertainty remains visible even before a resource can be assigned to the case', async () => {
  for (const options of [{ connectCleanupUnknown: true }, { fixtureCleanupUnknown: true }]) {
    const receipt = await harness(options).run();
    assert.equal(receipt.cleanup.confirmed, false); assert.equal(receipt.cleanup.ownedResourcesClosed, false);
    assert.equal(receipt.cleanup.outcome, 'unknown'); assert.equal(receipt.paste.requests, 0);
    if (options.connectCleanupUnknown) assert.equal(receipt.cleanup.mcp.closed, false);
    else assert.equal(receipt.cleanup.fixture.exited, false);
  }
});

test('a late uncertain paste drains before restoration; unknown input never acknowledges quiescence or restores', async () => {
  const drained = harness({ pasteLost: true, latePaste: true }), a = await drained.run();
  assert.equal(a.paste.outcome, 'unknown'); assert.ok(drained.events.indexOf('late-paste-drained') < drained.events.indexOf('restore'));
  for (const options of [{ inputUnknown: true }, { connectionUnknown: true }]) {
    const h = harness(options), receipt = await h.run();
    assert.equal(h.events.includes('restore'), false); assert.equal(receipt.cleanup.restoration.attempted, false);
    assert.equal(receipt.cleanup.restoration.code, 'clipboard_input_quiescence_required');
    assert.equal(receipt.cleanup.clipboard.cleanup, 'unknown'); assert.equal(receipt.cleanup.confirmed, false);
  }
});

test('proven native rejection reports zero paste dispatches and does not become a successful effect', async () => {
  const h = harness({ pasteRejected: true }), receipt = await h.run();
  assert.equal(receipt.paste.requests, 1); assert.equal(receipt.paste.dispatches, 0);
  assert.equal(receipt.status, 'fail'); assert.equal(receipt.paste.outcome, 'not_dispatched');
});

test('private comparison checks exact supported bytes independent of enumeration order, sequence and owner', () => {
  const before = { token: 'private', sequence: 1, formats: [{ id: 13, bytes: 2, sha256: 'a' }, { id: 1, bytes: 1, sha256: 'b' }] };
  assert.equal(sameSupportedBytes(before, { sequence: 99, formats: before.formats.toReversed() }), true);
  assert.equal(sameSupportedBytes(before, { formats: [{ id: 13, bytes: 2, sha256: 'changed' }, before.formats[1]] }), false);
});

test('owned fixture consumes asynchronous spawn errors without attempting PID cleanup for a process never created', async () => {
  const child = new EventEmitter(); let stops = 0;
  await assert.rejects(launchOwnedFixture({ executable: 'synthetic.exe', directory: path.resolve('synthetic-private'),
    spawnImpl: () => { queueMicrotask(() => child.emit('error', error('ENOENT'))); return child; },
    readState: async (_file, _signal, startupError) => { await Promise.resolve(); throw startupError(); },
    stop: async () => { stops++; },
  }), { code: 'fixture_launch_failed' });
  assert.equal(stops, 0);
});

test('owned fixture startup failure retains uncertainty if exact ChildProcess cleanup cannot be verified', async () => {
  const child = new EventEmitter(); child.pid = 1234;
  await assert.rejects(launchOwnedFixture({ executable: 'synthetic.exe', directory: path.resolve('synthetic-private'),
    spawnImpl: (_exe, _args, options) => { assert.equal(options.shell, false); return child; },
    readState: async () => { throw error('fixture_start_timeout'); },
    stop: async owned => { assert.equal(owned, child); throw error('cleanup_unknown'); },
  }), value => value.code === 'fixture_start_timeout' && value.ownedFixtureCleanupUnknown === true);
});

function continuationHarness(overrides = {}) {
  const calls = [], caseId = 'METHOD-CLIPBOARD-UNICODE-PASTE';
  const input = { mode: 'live', directory: 'evidence/synthetic-clipboard-continuation', continuationAttempt: 1,
    decisionRef: 'evidence/live-acceptance-continuation/owner-decision.json', idleReadinessRef: 'evidence/synthetic-idle.json' };
  const claim = { schemaVersion: 1, caseId, historicalAttemptsUsed: 2, continuationAttempt: 1, lifetimeAttemptOrdinal: 3, decisionId: 'synthetic-owner-decision' };
  const deps = {
    validateDestination: async () => { calls.push('destination'); },
    verifyFixture: async () => { calls.push('prepared-fixture'); },
    verifyRuntime: async () => { calls.push('runtime'); },
    probeFormats: async () => { calls.push('formats'); return { ready: true, supported: true, contentsRead: false, contentsChanged: false, recoveryWritten: false, recoveryPending: false }; },
    evidence: async () => { calls.push('readiness-record'); return { value: { anchor: { id: '10', pid: 20, processCreationTime: '30', sessionId: 1 } } }; },
    prepareClipboard: async () => { calls.push('private-snapshot'); return { original: { token: 'PRIVATE_PRECLAIM_TOKEN' }, clipboard: {}, close: async () => { calls.push('prepared-close'); } }; },
    claimRequest: async (selected, actualCase) => { calls.push('claim-request'); assert.equal(actualCase, caseId); assert.equal(selected.lifetimeAttemptOrdinal, 3); return { caseId }; },
    command: async args => { calls.push(args[0]); return { monitors: 1, displays: [{ device: 'synthetic', dpi: 144, bounds: { x: 0, y: 0, width: 100, height: 100 } }] }; },
    idlePreflight: async value => { calls.push('idle'); assert.equal(value.anchor.pid, 20); },
    claim: async request => { calls.push('claim'); assert.equal(request.caseId, caseId); return claim; },
    runOriginal: async selected => { calls.push('live'); assert.deepEqual(selected.continuationClaim, claim); assert.equal(selected.attempt, undefined); return { ...claim, status: 'pass' }; },
    persistError: async (_directory, receipt) => { calls.push('persist-error'); assert.equal(receipt.cleanup.outcome, 'unknown'); },
    ...overrides,
  };
  return { calls, input, deps, claim, run: () => runContinuation(input, deps) };
}

test('supplemental clipboard plan has no side effects and original exhausted live entry refuses', async () => {
  const h = continuationHarness(); const result = await runContinuation({ ...h.input, mode: 'plan' }, new Proxy({}, { get() { throw Error('No I/O in plan'); } }));
  assert.equal(result.lifetimeAttemptOrdinal, 3);
  await assert.rejects(run({ mode: 'live', directory: 'must-not-be-created', attempt: 1 }), { code: 'clipboard_historical_budget_exhausted' });
  assert.deepEqual(h.calls, []);
});

test('unsupported clipboard identifiers stop supplemental workflow without claim, snapshot, UI or contents', async () => {
  const h = continuationHarness({ probeFormats: async () => ({ ready: false, supported: false, code: 'clipboard_unsupported_formats', contentsRead: false, contentsChanged: false }) });
  await assert.rejects(h.run(), { code: 'clipboard_unsupported_formats' });
  assert.deepEqual(h.calls, ['destination', 'prepared-fixture', 'runtime']);
});

test('destination, prepared fixture or stale readiness failure leaves supplemental budget unclaimed', async () => {
  for (const field of ['validateDestination', 'verifyFixture', 'verifyRuntime', 'idlePreflight']) {
    const h = continuationHarness({ [field]: async () => { throw error('preflight_failed'); } });
    await assert.rejects(h.run(), { code: 'preflight_failed' });
    assert.equal(h.calls.includes('claim'), false); assert.equal(h.calls.includes('live'), false);
  }
});

test('supplemental clipboard resolves request before final readiness then claims once before live work', async () => {
  const h = continuationHarness(), receipt = await h.run();
  assert.equal(receipt.lifetimeAttemptOrdinal, 3);
  assert.deepEqual(h.calls, ['destination', 'prepared-fixture', 'runtime', 'formats', 'readiness-record', 'claim-request', 'private-snapshot', 'display', 'idle', 'claim', 'live', 'prepared-close']);
});

test('postclaim failure keeps exact lifetime and unknown cleanup with no automatic replay', async () => {
  const h = continuationHarness({ runOriginal: async () => { throw error('transport_closed'); } });
  const receipt = await h.run();
  assert.equal(receipt.attempt, 3); assert.equal(receipt.continuationAttempt, 1); assert.equal(receipt.historicalAttemptsUsed, 2);
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.cleanup.confirmed, false); assert.equal(receipt.error.code, 'transport_closed');
  assert.equal(h.calls.filter(value => value === 'claim').length, 1); assert.deepEqual(h.calls.slice(-2), ['persist-error', 'prepared-close']);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE_ERROR_CONTENT'), false);
});

test('private supported snapshot precedes claim, stays out of receipts and is closed on preclaim rejection', async () => {
  const h = continuationHarness({ idlePreflight: async () => { throw error('readiness_expired'); } });
  await assert.rejects(h.run(), { code: 'readiness_expired' });
  assert.equal(h.calls.includes('private-snapshot'), true); assert.equal(h.calls.includes('claim'), false);
  assert.equal(h.calls.at(-1), 'prepared-close');
  const success = await continuationHarness().run(); assert.equal(JSON.stringify(success).includes('PRIVATE_PRECLAIM_TOKEN'), false);
});

test('claimed paste uses the exact private preclaim snapshot once, without a second snapshot or leaking identity', async () => {
  const h = harness({ prepared: true }), receipt = await h.run();
  assert.equal(receipt.status, 'pass'); assert.equal(h.events.includes('snapshot'), false);
  assert.equal(h.events.filter(value => value === 'write').length, 1);
  assert.equal(receipt.cleanup.independentSupportedBytesRestored, true);
  for (const value of ['PRIVATE_ORIGINAL_TOKEN', 'PRIVATE_ORIGINAL_HASH']) assert.equal(JSON.stringify(h.saved).includes(value), false);
});

test('clipboard connection close drains once and independently verifies every exact owner generation', async () => {
  const calls = [], records = ['node', 'supervisor', 'marker'].map((name, index) => ({ name, pid: index + 1, created: `generation-${index}` }));
  const close = trackedClose({ identities: async () => { calls.push('identities'); return records; }, required: () => true,
    client: { close: async () => { calls.push('client'); } }, transport: { close: async () => { calls.push('transport'); } },
    waitExit: async identity => { calls.push(identity.created); } });
  const first = close(), second = close(); assert.equal(first, second);
  const result = await first;
  assert.equal(result.exactGenerationExitConfirmed, true); assert.equal(result.processes.length, 3);
  assert.deepEqual(calls, ['identities', 'client', 'transport', 'generation-0', 'generation-1', 'generation-2']);
});

test('transport success cannot hide absent identity, missing chain or one unconfirmed native exit', async () => {
  for (const fault of ['absent', 'chain', 'exit', 'transport']) {
    let clientClosed = false, transportClosed = false;
    const close = trackedClose({ identities: async () => fault === 'absent' ? [] : [{ pid: 42, created: 'exact' }], required: () => fault !== 'chain',
      client: { close: async () => { clientClosed = true; } },
      transport: { close: async () => { transportClosed = true; if (fault === 'transport') throw error('transport_closed'); } },
      waitExit: async () => { if (fault === 'exit') throw error('exit_unknown'); } });
    await assert.rejects(close(), { code: 'clipboard_native_exit_unconfirmed' });
    await assert.rejects(close(), { code: 'clipboard_native_exit_unconfirmed' });
    assert.equal(clientClosed, true); assert.equal(transportClosed, true);
  }
});
