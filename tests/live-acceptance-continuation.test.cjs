'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const book = require('../scripts/live-acceptance-continuation.cjs');
const SOURCE = path.resolve(__dirname, '..'), CASE = 'R31-GLOW-NATIVE', CONTRACT = book.REGISTRY[CASE].contract;

async function setup(t, caseId = CASE) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-continuation-bookkeeping-'));
  t.after(async () => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'trace-continuation-bookkeeping-'))); await fs.rm(root, { recursive: true, force: true }); });
  const originalBytes = [];
  for (const descriptor of book.REGISTRY[caseId].originals) {
    const bytes = await fs.readFile(path.join(SOURCE, descriptor.ref)); originalBytes.push(bytes);
    await fs.mkdir(path.dirname(path.join(root, descriptor.ref)), { recursive: true }); await fs.writeFile(path.join(root, descriptor.ref), bytes);
  }
  async function write(ref, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    await fs.mkdir(path.dirname(path.join(root, ref)), { recursive: true }); await fs.writeFile(path.join(root, ref), bytes);
    return { ref, sha256: book.digest(bytes) };
  }
  const decision = { schemaVersion: 1, status: 'approved', source: 'direct-owner', decisionId: 'synthetic-isolated-test-only',
    cases: [{ caseId, contract: book.REGISTRY[caseId].contract, historicalAttemptsUsed: 2, continuationMaximum: 2 }] };
  const decisionRef = await write('evidence/test-only/decision.json', decision);
  const input = { caseId, contract: book.REGISTRY[caseId].contract, decision: decisionRef, originals: book.plan(caseId).originals,
    historicalAttemptsUsed: 2, continuationAttempt: 1, lifetimeAttemptOrdinal: 3 };
  return { root, input, decision, originalBytes, write, keeper: book.createBookkeeper({ root }) };
}
async function terminal(state, claim, patch = {}) {
  return state.write('evidence/test-only/terminal.json', { ...claim, status: 'blocked', completedAt: new Date().toISOString(), ...patch });
}
async function ledger(state) {
  return JSON.parse(await fs.readFile(path.join(state.root, 'evidence/live-acceptance-continuation/ledger', `${state.input.caseId}.json`), 'utf8'));
}

test('import/plan is pure, fixes exactly five existing identities and never claims approval', () => {
  assert.deepEqual(Object.keys(book.REGISTRY), [CASE, 'CODEX-TRACE-SKILL-NATIVE', 'A32-QUARANTINE-ACK-TYPING', 'CLAUDE-TRACE-SKILL-NATIVE', 'METHOD-CLIPBOARD-UNICODE-PASTE']);
  for (const caseId of Object.keys(book.REGISTRY)) {
    const plan = book.plan(caseId); assert.equal(plan.proposal, true); assert.equal(plan.claimsAttempt, false);
    assert.deepEqual(plan.lifetimeAttemptOrdinals, [3, 4]); assert.equal(plan.originals.length, 2);
  }
  assert.throws(() => book.plan('NEW-LAUNDERED-ID'));
  assert.throws(() => book.plan(CASE, 'other-contract'));
  assert.throws(() => book.validateDecision({}, CASE, CONTRACT));
});

test('Claude and clipboard contracts cannot borrow another case decision/history or reset their two blocked outcomes', async t => {
  for (const caseId of ['CLAUDE-TRACE-SKILL-NATIVE', 'METHOD-CLIPBOARD-UNICODE-PASTE']) {
    const state = await setup(t, caseId);
    await assert.rejects(state.keeper.claim({ ...state.input, contract: CONTRACT }));
    await assert.rejects(state.keeper.claim({ ...state.input, originals: book.plan(CASE).originals }));
    for (const original of state.input.originals) {
      const receipt = JSON.parse(await fs.readFile(path.join(state.root, original.ref), 'utf8'));
      assert.equal(receipt.status, 'blocked'); assert.equal(receipt.caseId, caseId);
    }
    const first = await state.keeper.claim(state.input), prior = await terminal(state, first);
    const corrective = await state.keeper.claim({ ...state.input, continuationAttempt: 2, lifetimeAttemptOrdinal: 4, prior,
      changedPrecondition: 'Actual preparation prerequisite and reviewed harness correction recorded separately.' });
    assert.equal(corrective.lifetimeAttemptOrdinal, 4);
    await assert.rejects(state.keeper.claim(state.input));
  }
});

test('claim refuses proposed, missing, unselected or changed decisions without creating a ledger', async t => {
  const state = await setup(t);
  for (const patch of [{ status: 'proposed' }, { source: 'proposal-document' }, { cases: [] }, { cases: [{ ...state.decision.cases[0], continuationMaximum: 3 }] }]) {
    const decision = await state.write('evidence/test-only/decision.json', { ...state.decision, ...patch });
    await assert.rejects(state.keeper.claim({ ...state.input, decision }));
  }
  await assert.rejects(state.keeper.claim({ ...state.input, decision: undefined }));
  await assert.rejects(fs.stat(path.join(state.root, 'evidence/live-acceptance-continuation/ledger')), { code: 'ENOENT' });
});

test('all cases require exact frozen originals and retain their bytes unchanged', async t => {
  for (const caseId of Object.keys(book.REGISTRY)) {
    const state = await setup(t, caseId), claimed = await state.keeper.claim(state.input);
    assert.equal(claimed.caseId, caseId); assert.equal(claimed.continuationAttempt, 1); assert.equal(claimed.lifetimeAttemptOrdinal, 3);
    for (let index = 0; index < state.input.originals.length; index++)
      assert.deepEqual(await fs.readFile(path.join(state.root, state.input.originals[index].ref)), state.originalBytes[index]);
  }
});

test('modified originals, changed hashes, wrong case/attempt/status and substituted original paths are rejected', async t => {
  const state = await setup(t), first = state.input.originals[0], filename = path.join(state.root, first.ref);
  const parsed = JSON.parse(state.originalBytes[0].toString('utf8'));
  for (const patch of [{ caseId: 'OTHER' }, { attempt: 2 }, { status: 'pass' }]) {
    await fs.writeFile(filename, JSON.stringify({ ...parsed, ...patch }));
    await assert.rejects(state.keeper.claim(state.input), /SHA256 changed/);
    const updated = { ref: first.ref, sha256: book.digest(await fs.readFile(filename)) };
    await assert.rejects(state.keeper.claim({ ...state.input, originals: [updated, state.input.originals[1]] }), /frozen exhausted/);
  }
  await fs.writeFile(filename, state.originalBytes[0]);
  await assert.rejects(state.keeper.claim({ ...state.input, originals: [{ ...first, ref: 'evidence/test-only/another.json' }, state.input.originals[1]] }));
  for (const patch of [{ caseId: 'OTHER' }, { attempt: 2 }, { status: 'pass' }])
    assert.throws(() => book.validateOriginals([{ ...parsed, ...patch }, { caseId: CASE, attempt: 2, status: 'blocked' }], CASE));
});

test('concurrent claims admit exactly one first attempt and persist no raw decision/private contents', async t => {
  const state = await setup(t), other = book.createBookkeeper({ root: state.root });
  const results = await Promise.allSettled([state.keeper.claim(state.input), other.claim(state.input), state.keeper.claim(state.input)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const stored = await ledger(state); assert.equal(stored.claims.length, 1);
  assert.equal(JSON.stringify(stored).includes(state.root), false); assert.equal(JSON.stringify(stored).includes('source'), false);
});

test('same-case same-decision terminal failure and actual change permit only one corrective claim', async t => {
  const state = await setup(t), first = await state.keeper.claim(state.input), prior = await terminal(state, first);
  const second = { ...state.input, continuationAttempt: 2, lifetimeAttemptOrdinal: 4, prior, changedPrecondition: 'Actual source fix recorded in the reviewed plan.' };
  const results = await Promise.allSettled([state.keeper.claim(second), book.createBookkeeper({ root: state.root }).claim(second)]);
  const successful = results.find(value => value.status === 'fulfilled'); assert.ok(successful);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1); assert.equal(successful.value.lifetimeAttemptOrdinal, 4);
  assert.equal(successful.value.changedPreconditionSha256, book.digest(second.changedPrecondition));
  assert.equal(JSON.stringify(await ledger(state)).includes(second.changedPrecondition), false);
  for (const reset of [state.input, second, { ...second, continuationAttempt: 3, lifetimeAttemptOrdinal: 5 }]) await assert.rejects(state.keeper.claim(reset));
  assert.equal((await ledger(state)).claims.length, 2);
});

test('retry cannot use pass/running/not_run, mismatched identity, changed hash or missing actual change', async t => {
  const state = await setup(t), first = await state.keeper.claim(state.input);
  const retry = { ...state.input, continuationAttempt: 2, lifetimeAttemptOrdinal: 4, changedPrecondition: 'Recorded actual correction.' };
  for (const patch of [{ status: 'pass' }, { status: 'running' }, { status: 'not_run' }, { caseId: 'OTHER' }, { decisionId: 'other' },
    { claimId: 'other' }, { lifetimeAttemptOrdinal: 4 }, { ownerDecision: { ...first.ownerDecision, sha256: '0'.repeat(64) } }]) {
    await assert.rejects(state.keeper.claim({ ...retry, prior: await terminal(state, first, patch) }));
  }
  const prior = await terminal(state, first);
  await assert.rejects(state.keeper.claim({ ...retry, prior, changedPrecondition: '' }));
  await assert.rejects(state.keeper.claim({ ...retry, prior: { ...prior, sha256: '0'.repeat(64) } }));
  assert.equal((await ledger(state)).claims.length, 1);
});

test('new decision, arbitrary ledger path, historical count reset and corrective without first ledger cannot reset the cap', async t => {
  const state = await setup(t);
  const prior = await state.write('evidence/test-only/terminal.json', { status: 'blocked' });
  await assert.rejects(state.keeper.claim({ ...state.input, continuationAttempt: 2, lifetimeAttemptOrdinal: 4, prior, changedPrecondition: 'Actual correction.' }));
  for (const patch of [{ ledgerDirectory: 'fresh' }, { attempt: 1 }, { historicalAttemptsUsed: 0 }, { lifetimeAttemptOrdinal: 1 }])
    await assert.rejects(state.keeper.claim({ ...state.input, ...patch }));
  await state.keeper.claim(state.input);
  const decision = await state.write('evidence/test-only/second-decision.json', { ...state.decision, decisionId: 'a-new-decision-cannot-reset' });
  await assert.rejects(state.keeper.claim({ ...state.input, decision }), /different decision/);
  assert.equal((await ledger(state)).claims.length, 1);
});

test('safe references reject absolute paths, traversal and private data payloads', () => {
  for (const ref of ['C:/private/file.json', '../evidence/file.json', 'evidence/../file.json', 'evidence/.runtime/file.json', '/tmp/file.json']) {
    assert.throws(() => book.reference({ ref, sha256: 'a'.repeat(64) }));
  }
  assert.throws(() => book.reference({ ref: 'evidence/test.json', sha256: 'a'.repeat(64), contents: 'private' }));
});

async function amendmentSetup(t, caseId = CASE) {
  const state = await setup(t, caseId), history = book.amendmentHistory(caseId);
  const copy = async ref => {
    await fs.mkdir(path.dirname(path.join(state.root, ref)), { recursive: true });
    await fs.copyFile(path.join(SOURCE, ref), path.join(state.root, ref));
  };
  await copy(book.AMENDMENT_2.proposal.ref);
  for (const item of history.slice(2)) await copy(item.ref);
  const ledgerRef = `evidence/live-acceptance-continuation/ledger/${caseId}.json`;
  // The canonical ledger now also holds the actual amendment claims; rebuild its first-round state.
  const canonical = JSON.parse(await fs.readFile(path.join(SOURCE, ledgerRef), 'utf8'));
  delete canonical.amendments;
  await state.write(ledgerRef, { ...canonical, claims: canonical.claims.slice(0, 2) });
  const existing = await ledger(state); await copy(existing.selection.ownerDecision.ref);
  const amendmentDecision = { schemaVersion: 1, status: 'approved', source: 'direct-owner', decisionId: 'synthetic-amendment-two-test-only',
    amendment: 2, proposal: { ...book.AMENDMENT_2.proposal },
    cases: [{ caseId, contract: book.REGISTRY[caseId].contract, historicalAttemptsUsed: 4, continuationMaximum: 2, history }] };
  const decision = await state.write('evidence/test-only/amendment-decision.json', amendmentDecision);
  const input = { ...state.input, decision, amendment: 2, proposal: { ...book.AMENDMENT_2.proposal }, history,
    historicalAttemptsUsed: 4, lifetimeAttemptOrdinal: 5, prior: history[3] };
  return { ...state, input, amendmentDecision, existing, ledgerRef };
}
test('amendment 2 plans are pure and limited to glow and Codex while existing contracts stay unchanged', () => {
  for (const caseId of [CASE, 'CODEX-TRACE-SKILL-NATIVE']) {
    const selected = book.plan(caseId, undefined, 2);
    assert.deepEqual(selected.lifetimeAttemptOrdinals, [5, 6]); assert.equal(selected.history.length, 4);
    assert.equal(selected.historicalAttemptsUsed, 4); assert.equal(selected.claimsAttempt, false);
    assert.deepEqual(book.plan(caseId).lifetimeAttemptOrdinals, [3, 4]);
  }
  for (const caseId of ['CLAUDE-TRACE-SKILL-NATIVE', 'A32-QUARANTINE-ACK-TYPING', 'METHOD-CLIPBOARD-UNICODE-PASTE'])
    assert.throws(() => book.plan(caseId, undefined, 2));
  assert.throws(() => book.plan(CASE, undefined, 3));
});
test('amendment appends lifetime 5 and 6 under one canonical lock without modifying original selection or claims', async t => {
  for (const caseId of [CASE, 'CODEX-TRACE-SKILL-NATIVE']) {
    const state = await amendmentSetup(t, caseId);
    const results = await Promise.allSettled([state.keeper.claim(state.input), book.createBookkeeper({ root: state.root }).claim(state.input)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    const first = results.find(item => item.status === 'fulfilled').value;
    assert.equal(first.lifetimeAttemptOrdinal, 5); assert.equal(first.historicalAttemptsUsed, 4); assert.equal(first.amendment, 2);
    const stored = await ledger(state);
    assert.deepEqual(stored.selection, state.existing.selection); assert.deepEqual(stored.claims.slice(0, 2), state.existing.claims);
    assert.equal(stored.amendments[0].selection.decisionId, state.amendmentDecision.decisionId);
    const prior = await terminal(state, first);
    const retry = { ...state.input, continuationAttempt: 2, lifetimeAttemptOrdinal: 6, prior, changedPrecondition: 'Actual reviewed source correction and fresh observation.' };
    const corrections = await Promise.allSettled([state.keeper.claim(retry), book.createBookkeeper({ root: state.root }).claim(retry)]);
    assert.equal(corrections.filter(item => item.status === 'fulfilled').length, 1);
    const second = corrections.find(item => item.status === 'fulfilled').value; assert.equal(second.lifetimeAttemptOrdinal, 6);
    const final = await ledger(state); assert.deepEqual(final.claims.slice(0, 2), state.existing.claims); assert.equal(final.claims.length, 4);
    await assert.rejects(state.keeper.claim(state.input)); await assert.rejects(state.keeper.claim(retry));
  }
});
test('proposal, wrong scope, changed proposal and incomplete history cannot authorize amendment claims', async t => {
  const state = await amendmentSetup(t), original = structuredClone(state.amendmentDecision);
  for (const mutate of [d => d.status = 'proposed', d => d.source = 'agent', d => delete d.amendment,
    d => d.proposal.sha256 = '0'.repeat(64), d => d.cases[0].continuationMaximum = 3,
    d => d.cases[0].history.pop(), d => d.cases[0].history[3].sha256 = '0'.repeat(64),
    d => d.cases[0].caseId = 'CLAUDE-TRACE-SKILL-NATIVE']) {
    const decision = structuredClone(original); mutate(decision);
    const descriptor = await state.write('evidence/test-only/rejected-amendment.json', decision);
    await assert.rejects(state.keeper.claim({ ...state.input, decision: descriptor }));
  }
  await assert.rejects(state.keeper.claim({ ...state.input, amendment: undefined }));
  await fs.appendFile(path.join(state.root, book.AMENDMENT_2.proposal.ref), '\nchanged');
  await assert.rejects(state.keeper.claim(state.input), /proposal SHA256 changed/);
  assert.deepEqual(await ledger(state), state.existing);
});
test('all four exact history hashes and prior owner chain are rechecked before amendment append', async t => {
  const state = await amendmentSetup(t);
  for (const descriptor of state.input.history) {
    const filename = path.join(state.root, descriptor.ref), bytes = await fs.readFile(filename);
    await fs.appendFile(filename, '\n'); await assert.rejects(state.keeper.claim(state.input), /SHA256 changed/); await fs.writeFile(filename, bytes);
  }
  for (const mutate of [l => l.claims[1].caseId = 'OTHER', l => l.claims[1].ownerDecision.sha256 = '0'.repeat(64),
    l => l.claims[1].prior = state.input.history[0], l => l.claims[0].decisionId = 'OTHER', l => l.claims.pop(),
    l => l.selection.contract = 'OTHER', l => l.claims[1].claimId = 'invalid',
    l => l.claims[1].changedPreconditionSha256 = '0'.repeat(64), l => l.claims[0].claimedAt = '2000-01-01T00:00:00Z']) {
    const malformed = structuredClone(state.existing); mutate(malformed);
    await state.write(state.ledgerRef, malformed); await assert.rejects(state.keeper.claim(state.input));
  }
  await state.write(state.ledgerRef, state.existing);
  await assert.rejects(state.keeper.claim({ ...state.input, prior: state.input.history[2] }));
  assert.deepEqual(await ledger(state), state.existing);
});
test('amendment retry needs exact terminal lifetime 5 failure and correction; pass closes round and changed decision cannot reset', async t => {
  const state = await amendmentSetup(t), first = await state.keeper.claim(state.input);
  const retry = { ...state.input, continuationAttempt: 2, lifetimeAttemptOrdinal: 6, changedPrecondition: 'Actual correction recorded.' };
  for (const patch of [{ status: 'pass' }, { status: 'running' }, { amendment: undefined }, { caseId: 'OTHER' },
    { history: [] }, { historicalAttemptsUsed: 2 }, { ownerDecision: state.existing.selection.ownerDecision },
    { prior: state.input.history[2] }, { claimedAt: '2000-01-01T00:00:00Z' }])
    await assert.rejects(state.keeper.claim({ ...retry, prior: await terminal(state, first, patch) }));
  const prior = await terminal(state, first);
  await assert.rejects(state.keeper.claim({ ...retry, prior, changedPrecondition: '' }));
  const decision = await state.write('evidence/test-only/another-amendment-decision.json', { ...state.amendmentDecision, decisionId: 'new-agent-or-directory-cannot-reset' });
  await assert.rejects(state.keeper.claim({ ...retry, prior, decision }));
  await assert.rejects(state.keeper.claim({ ...state.input, decision }));
  await assert.rejects(state.keeper.claim({ ...retry, prior, historicalAttemptsUsed: 0 }));
  assert.equal((await ledger(state)).claims.length, 3);
});
