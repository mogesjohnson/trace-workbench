'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const DOC = 'docs/NARROW_DESKTOP_FINISH.md';
const LEDGERS = 'evidence/live-acceptance-continuation/ledger';
const CASES = {
  'R31-GLOW-NATIVE': { attempt: 9, scope: 'lifecycle-only', sha256: '2cfac756b8198919ae53899e6684c83c60f67ae8674f91ee65db74a242b59861' },
  'A4-REPLAY': { attempt: 5, scope: 'pause-only', sha256: 'bf65b041542b94694fef3a34796691c6f99c0e9400d08a3388d5eff3398e13b9' }
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function need(condition, message) { if (!condition) throw new Error(message); }
function plan(caseId) {
  need(Object.hasOwn(CASES, caseId), 'Unknown case');
  const item = CASES[caseId];
  return { caseId, attempt: item.attempt, scope: item.scope, maximumAttempts: 1,
    ledger: `${LEDGERS}/${caseId}.json`, previousLedgerSha256: item.sha256 };
}
async function safe(root, ref) {
  need(typeof ref === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(ref) &&
    ref.split('/').every(part => part !== '.' && part !== '..'), 'Unsafe reference');
  const base = await fs.realpath(root);
  let current = base;
  for (const part of ref.split('/')) {
    current = path.join(current, part);
    need(!(await fs.lstat(current)).isSymbolicLink(), 'Symbolic link rejected');
  }
  const resolved = await fs.realpath(current);
  const relative = path.relative(base, resolved);
  need(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path escapes root');
  return resolved;
}
async function claim(input, { root = path.resolve(__dirname, '..') } = {}) {
  const selected = plan(input.caseId);
  const owner = input.decision;
  need(root && owner && /^evidence\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.json$/.test(owner.ref || '') &&
    /^[a-f0-9]{64}$/.test(owner.sha256 || ''), 'Invalid decision reference');
  const read = async ref => fs.readFile(await safe(root, ref));
  const decisionBytes = await read(owner.ref);
  need(digest(decisionBytes) === owner.sha256, 'Decision hash changed');
  const decision = JSON.parse(decisionBytes);
  const proposalHash = digest(await read(DOC));
  need(decision.schemaVersion === 1 && decision.status === 'approved' && decision.source === 'direct-owner' &&
    typeof decision.directReply === 'string' && decision.directReply.trim() &&
    decision.proposal?.ref === DOC && decision.proposal?.sha256 === proposalHash && Array.isArray(decision.cases), 'Unapproved decision');
  const entries = decision.cases.filter(entry => entry.caseId === selected.caseId);
  need(entries.length === 1 && entries[0].attempt === selected.attempt && entries[0].scope === selected.scope &&
    entries[0].maximumAttempts === 1, 'Decision case mismatch');
  const filename = await safe(root, selected.ledger);
  const lock = path.join(path.dirname(filename), `${selected.caseId}.lock`);
  await fs.mkdir(lock);
  let temporary;
  try {
    // Recheck every input under the shared ledger lock before changing the ledger.
    need((await safe(root, selected.ledger)) === filename && digest(await read(owner.ref)) === owner.sha256 &&
      digest(await read(DOC)) === proposalHash, 'Inputs changed');
    const bytes = await fs.readFile(filename);
    need(digest(bytes) === selected.previousLedgerSha256, 'Stale ledger');
    const ledger = JSON.parse(bytes);
    need(Array.isArray(ledger.claims) && !ledger.claims.some(item => item.lifetimeAttemptOrdinal >= selected.attempt), 'Duplicate claim');
    const value = { caseId: selected.caseId, attempt: selected.attempt, lifetimeAttemptOrdinal: selected.attempt,
      continuationAttempt: 1, scope: selected.scope, maximumAttempts: 1, previousLedgerSha256: selected.previousLedgerSha256,
      ownerDecision: { ...owner }, proposal: { ref: DOC, sha256: proposalHash }, claimId: randomUUID(), claimedAt: new Date().toISOString() };
    ledger.claims.push(value);
    temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, filename);
    temporary = undefined;
    return value;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true });
    await fs.rmdir(lock);
  }
}
module.exports = { DOC, plan, claim };
