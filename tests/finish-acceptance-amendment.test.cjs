'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const finish = require('../scripts/finish-acceptance-amendment.cjs');
const ROOT = path.resolve(__dirname, '..');
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trace-finish-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const decision = JSON.parse(await fs.readFile(path.join(ROOT, finish.DECISION.ref), 'utf8'));
  const refs = [finish.DECISION, finish.PROPOSAL, ...decision.cases.flatMap(item => [...item.history, ...(item.baseLedger ? [item.baseLedger] : [])])];
  for (const { ref } of refs) { const target = path.join(root, ref); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(ROOT, ref), target); }
  const glow = decision.cases.find(item => item.caseId === 'R31-GLOW-NATIVE');
  const ledger = path.join(root, 'evidence/live-acceptance-continuation/ledger/R31-GLOW-NATIVE.json');
  await fs.mkdir(path.dirname(ledger), { recursive: true }); await fs.copyFile(path.join(root, glow.baseLedger.ref), ledger);
  return { root, ledger };
}
test('fixed glow extension appends lifetime 7 and one changed correction 8 to the intact existing ledger', async t => {
  const { root, ledger } = await setup(t), baseline = JSON.parse(await fs.readFile(ledger, 'utf8'));
  const request = await finish.request({ continuationAttempt: 1 }, 'R31-GLOW-NATIVE', { root });
  const claim = await finish.claim(request, { root }); assert.equal(claim.attempt, 7);
  await assert.rejects(finish.claim(request, { root }), { code: 'finish_amendment_invalid' });
  const prior = 'evidence/finish-synthetic-prior.json';
  await fs.writeFile(path.join(root, prior), JSON.stringify({ ...claim, status: 'blocked', completedAt: new Date().toISOString() }));
  const correction = await finish.request({ continuationAttempt: 2, continuationPrior: prior, change: 'Synthetic changed precondition' }, claim.caseId, { root });
  assert.equal((await finish.claim(correction, { root })).attempt, 8);
  await assert.rejects(finish.claim(correction, { root }), { code: 'finish_amendment_invalid' });
  const result = JSON.parse(await fs.readFile(ledger, 'utf8'));
  assert.deepEqual(result.claims.slice(0, 4), baseline.claims); assert.equal(result.claims.length, 6);
  await assert.rejects(finish.request({ continuationAttempt: 3 }, claim.caseId, { root }), { code: 'finish_amendment_invalid' });
});
test('stop and REPLAY retain exact historical ordinals; changed history or approval cannot authorize a claim', async t => {
  const { root } = await setup(t);
  for (const [caseId, ordinal] of [['A32-STOP-MOUSE', 2], ['A32-STOP-KEYBOARD', 3], ['A32-STOP-INJECTED', 2], ['A4-REPLAY', 3]]) {
    const request = await finish.request({ continuationAttempt: 1 }, caseId, { root });
    assert.equal((await finish.claim(request, { root })).attempt, ordinal);
    await assert.rejects(finish.claim(request, { root }), { code: 'finish_amendment_invalid' });
  }
  const decision = JSON.parse(await fs.readFile(path.join(root, finish.DECISION.ref), 'utf8'));
  await fs.appendFile(path.join(root, decision.cases[0].history[0].ref), ' ');
  await assert.rejects(finish.request({ continuationAttempt: 1 }, 'R31-GLOW-NATIVE', { root }), { code: 'finish_amendment_invalid' });
  await fs.appendFile(path.join(root, finish.DECISION.ref), ' ');
  await assert.rejects(finish.request({ continuationAttempt: 1 }, 'A4-REPLAY', { root }), { code: 'finish_amendment_invalid' });
});
