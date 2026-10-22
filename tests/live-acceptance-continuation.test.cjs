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
