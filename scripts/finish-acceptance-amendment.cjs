'use strict';
// Fixed owner-approved extension only. Planning/import never claims or starts UI.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const book = require('./live-acceptance-continuation.cjs');
const ROOT = path.resolve(__dirname, '..');
const DECISION = Object.freeze({ ref: 'evidence/live-acceptance-continuation/owner-finish-decision.json', sha256: 'b4f11d92fe995b3be54e35f02bc2cd9cce56d778a5b0502b3c454c375cfb1327' });
const PROPOSAL = Object.freeze({ ref: 'docs/GAP_CLOSURE_FINISH_PLAN.md', sha256: 'd98fddf5359c31021ebf7d28108cf949a219d939c3e5d8046a0a05277388835b' });
const HISTORY = Object.freeze({ 'R31-GLOW-NATIVE': 6, 'A32-STOP-MOUSE': 1, 'A32-STOP-KEYBOARD': 2, 'A32-STOP-INJECTED': 1, 'A4-REPLAY': 2 });
const fail = () => { throw Object.assign(new Error('The fixed approved finish amendment, intact history and remaining canonical budget are required.'), { code: 'finish_amendment_invalid' }); };
const need = value => { if (!value) fail(); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function plan(caseId) {
  need(Object.hasOwn(HISTORY, caseId));
  const historicalAttemptsUsed = HISTORY[caseId];
  return { caseId, amendment: 3, contract: caseId === 'R31-GLOW-NATIVE' ? 'glow-sky-physical-point-v1' : 'finish-approved-v1',
    historicalAttemptsUsed, lifetimeAttemptOrdinals: [historicalAttemptsUsed + 1, historicalAttemptsUsed + 2], continuationMaximum: 2,
    claimsAttempt: false, proposalDocument: { ...PROPOSAL }, decision: { ...DECISION } };
}
async function read(ref, root) {
  book.reference(ref);
  const filename = await fs.realpath(path.join(root, ref.ref)), base = await fs.realpath(root), relative = path.relative(base, filename);
  need(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const bytes = await fs.readFile(filename); need(book.digest(bytes) === ref.sha256); return JSON.parse(bytes.toString('utf8'));
}
async function request(input, caseId, { root = ROOT } = {}) {
  const selected = plan(caseId), attempt = input.continuationAttempt;
  need([1, 2].includes(attempt));
  need(input.decisionRef === undefined || input.decisionRef === DECISION.ref);
  need(attempt === 1 ? !input.continuationPrior && !input.change : input.continuationPrior && typeof input.change === 'string' && input.change.trim() && input.change.length <= 1024);
  const decision = await read(DECISION, root);
  need(decision.status === 'approved' && decision.source === 'direct-owner' && decision.amendment === 3 && equal(decision.proposal, PROPOSAL));
  need(book.digest(await fs.readFile(path.join(root, PROPOSAL.ref))) === PROPOSAL.sha256);
  const entry = decision.cases.find(value => value.caseId === caseId);
  need(entry && entry.historicalAttemptsUsed === selected.historicalAttemptsUsed && entry.history.length === selected.historicalAttemptsUsed && entry.continuationMaximum === 2);
  for (const [index, ref] of entry.history.entries()) {
    const receipt = await read(ref, root);
    need(receipt.caseId === caseId && receipt.attempt === index + 1 && ['pass', 'fail', 'blocked'].includes(receipt.status));
    if (caseId === 'R31-GLOW-NATIVE' || caseId === 'A4-REPLAY') need(receipt.status !== 'pass');
  }
  const baseLedger = entry.baseLedger ? await read(entry.baseLedger, root) : { schemaVersion: 1, caseId, history: entry.history, claims: [] };
  let prior;
  if (attempt === 2) {
    book.reference({ ref: input.continuationPrior, sha256: '0'.repeat(64) });
    const filename = await fs.realpath(path.join(root, input.continuationPrior));
    const relative = path.relative(await fs.realpath(root), filename); need(!relative.startsWith('..') && !path.isAbsolute(relative));
    const bytes = await fs.readFile(filename);
    prior = { ref: input.continuationPrior, sha256: book.digest(bytes) };
  }
  return { ...selected, decisionId: decision.decisionId, ownerDecision: { ...DECISION }, proposal: { ...PROPOSAL },
    history: entry.history, continuationAttempt: attempt, lifetimeAttemptOrdinal: selected.historicalAttemptsUsed + attempt,
    ...(prior ? { prior, change: input.change.trim(), changedPreconditionSha256: book.digest(input.change.trim()) } : {}), baseLedger };
}
async function claim(input, { root = ROOT } = {}) {
  // Revalidate the frozen approval and receipt bytes immediately before the atomic claim.
  const canonical = await request({ continuationAttempt: input.continuationAttempt, decisionRef: DECISION.ref,
    ...(input.prior ? { continuationPrior: input.prior.ref, change: input.change } : {}) }, input.caseId, { root });
  need(equal(canonical, input));
  const folder = path.join(root, 'evidence/live-acceptance-continuation/ledger'); await fs.mkdir(folder, { recursive: true });
  need(!(await fs.lstat(folder)).isSymbolicLink());
  const relative = path.relative(await fs.realpath(root), await fs.realpath(folder)); need(!relative.startsWith('..') && !path.isAbsolute(relative));
  const lock = path.join(folder, input.caseId + '.lock'), filename = path.join(folder, input.caseId + '.json');
  await fs.mkdir(lock);
  try {
    let ledger;
    try { need(!(await fs.lstat(filename)).isSymbolicLink()); ledger = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const first = input.continuationAttempt === 1, baseline = input.baseLedger;
    const selection = { ownerDecision: DECISION, proposal: PROPOSAL, history: input.history };
    if (first) need(equal(ledger ?? baseline, baseline) && (!baseline.claims.length || ledger));
    else {
      need(ledger && equal(ledger.finishAmendment, selection) && ledger.claims.length === baseline.claims.length + 1);
      const original = { ...ledger, claims: ledger.claims.slice(0, baseline.claims.length) }; delete original.finishAmendment;
      need(equal(original, baseline));
      const previous = ledger.claims.at(-1), terminal = await read(input.prior, root);
      need(previous.continuationAttempt === 1 && previous.lifetimeAttemptOrdinal === HISTORY[input.caseId] + 1);
      need(['fail', 'blocked'].includes(terminal.status) && Number.isFinite(Date.parse(terminal.completedAt)));
      need(Object.keys(previous).every(key => equal(previous[key], terminal[key])));
    }
    const { baseLedger, claimsAttempt, continuationMaximum, lifetimeAttemptOrdinals, decision, proposalDocument, change, ...metadata } = input;
    const value = { ...metadata, claimId: randomUUID(), claimedAt: new Date().toISOString(), attempt: input.lifetimeAttemptOrdinal };
    const next = { ...(ledger ?? baseline), finishAmendment: selection, claims: [...(ledger ?? baseline).claims, value] };
    const temporary = filename + '.' + randomUUID() + '.tmp'; await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, filename);
    return value;
  } finally { await fs.rmdir(lock); }
}
module.exports = { DECISION, PROPOSAL, plan, request, claim };
