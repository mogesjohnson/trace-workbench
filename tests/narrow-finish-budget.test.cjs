'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const budget = require('../scripts/narrow-finish-budget.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const repo = path.resolve(__dirname, '..');

// Decision schema: schemaVersion 1, approved direct-owner source and directReply,
// a hash-bound proposal, and one exact case entry with maximumAttempts 1.
async function fixture(caseId) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-budget-'));
  const selected = budget.plan(caseId);
  for (const dir of ['docs', 'evidence/live-acceptance-continuation/ledger', 'evidence/decisions']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.copyFile(path.join(repo, selected.ledger), path.join(root, selected.ledger));
  const proposal = Buffer.from('synthetic proposal\n');
  await fs.writeFile(path.join(root, budget.DOC), proposal);
  const ref = 'evidence/decisions/owner.json';
  const decision = { schemaVersion: 1, status: 'approved', source: 'direct-owner', directReply: 'I approve this exact case.',
    proposal: { ref: budget.DOC, sha256: hash(proposal) },
    cases: [{ caseId, attempt: selected.attempt, scope: selected.scope, maximumAttempts: 1 }] };
  async function save() {
    const bytes = Buffer.from(JSON.stringify(decision));
    await fs.writeFile(path.join(root, ref), bytes);
    return { caseId, decision: { ref, sha256: hash(bytes) } };
  }
  return { root, selected, decision, save };
}

test('one approved claim per canonical ledger and no automatic retry', async t => {
  for (const caseId of ['R31-GLOW-NATIVE', 'A4-REPLAY']) {
    const f = await fixture(caseId);
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const filename = path.join(f.root, f.selected.ledger);
    const before = await fs.readFile(filename);
    assert.equal(hash(before), f.selected.previousLedgerSha256);
    const prior = JSON.parse(before);
    const input = await f.save();
    const results = await Promise.allSettled([budget.claim(input, { root: f.root }), budget.claim(input, { root: f.root })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const after = await fs.readFile(filename);
    const ledger = JSON.parse(after);
    assert.deepEqual(ledger.claims.slice(0, -1), prior.claims);
    assert.equal(ledger.claims.length, prior.claims.length + 1);
    assert.equal(ledger.claims.at(-1).previousLedgerSha256, hash(before));
    await assert.rejects(budget.claim(input, { root: f.root }));
    assert.deepEqual(await fs.readFile(filename), after);
  }
});

test('missing, unapproved, incorrect and stale inputs never mutate the ledger', async t => {
  const f = await fixture('A4-REPLAY');
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const filename = path.join(f.root, f.selected.ledger);
  const before = await fs.readFile(filename);
  await assert.rejects(budget.claim({ caseId: f.selected.caseId }, { root: f.root }));
  for (const mutate of [
    d => { d.status = 'pending'; }, d => { d.directReply = ' '; },
    d => { d.cases[0].maximumAttempts = 2; }, d => { d.cases[0].scope = 'other'; },
    d => { d.proposal.sha256 = '0'.repeat(64); }
  ]) {
    const copy = structuredClone(f.decision);
    mutate(f.decision);
    await assert.rejects(budget.claim(await f.save(), { root: f.root }));
    Object.assign(f.decision, copy);
    assert.deepEqual(await fs.readFile(filename), before);
  }
  const input = await f.save();
  await fs.appendFile(filename, ' ');
  const stale = await fs.readFile(filename);
  await assert.rejects(budget.claim(input, { root: f.root }));
  assert.deepEqual(await fs.readFile(filename), stale);
});
