'use strict';

// Acceptance bookkeeping only. Importing or planning does no I/O and claims no attempt.
// An approved record is evidence supplied by the human-facing caller, not authorization created here.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'invalid_continuation' });
const REGISTRY = Object.freeze(Object.fromEntries([
  ['R31-GLOW-NATIVE', 'glow-sky-physical-point-v1', [
    ['evidence/replacement-acceptance/r31-glow-native/attempt-1/receipt.json', 'c11e25b9c7b2f70371b4c1967411a9a2ac84a6615cde3b1c51ef0e83cc58c710'],
    ['evidence/replacement-acceptance/r31-glow-native/attempt-2/receipt.json', '162638516bcbc0a4cfc9b9471b9141910754aae704e46ff941722e1ce6a37c85']]],
  ['CODEX-TRACE-SKILL-NATIVE', 'codex-utf8-host-v1', [
    ['evidence/computer-use-method/codex-host-attempt-1/receipt.json', 'b7d53fbabff03d480b9f1d5f0b6430ad30948cff2f814dd0000b47daaf5f0a61'],
    ['evidence/computer-use-method/codex-host-attempt-2/receipt.json', '15d564c1a2673bba35e90fb70cc17d8993429f2e169701214640bc54196882a1']]],
  ['A32-QUARANTINE-ACK-TYPING', 'typing-ack-idle-anchor-v1', [
    ['evidence/0.1.0-alpha.3.2/quarantine-ack-typing/receipt.json', '0935c5d335bbd808261e66caf2a2bcb54f881b86232b22a88703390403c0d8ad'],
    ['evidence/0.1.0-alpha.3.2/quarantine-ack-typing-attempt-2/receipt.json', '1e323a378613c64750fd973471175e4f7083123e4c4b3aa560b0e0743bda1bb6']]],
  ['CLAUDE-TRACE-SKILL-NATIVE', 'claude-queued-host-settings-v1', [
    ['evidence/computer-use-method/claude-host-attempt-1/receipt.json', 'aa724fd9fcb831b6ba2aaa5f133e142f79bfdabd92bb0e0f607ea3d5c221fbb1'],
    ['evidence/computer-use-method/claude-host-attempt-2/receipt.json', 'c866366f12bf2aab0f2d877ea7c41c16d6726e5926e9d18a3d0edafb555887e5']]],
  ['METHOD-CLIPBOARD-UNICODE-PASTE', 'clipboard-supported-snapshot-v1', [
    ['evidence/computer-use-method/clipboard/live-attempt-1/receipt.json', '07b8d79f795150e1b9c4a961c984bbc536e017426b04f2f41c446a183f92af17'],
    ['evidence/computer-use-method/clipboard/live-attempt-2/receipt.json', 'bc2ce5eefd62f6a90a8f87f8794ca72a1861518fa8a5e5491e651149ee003ff8']]],
].map(([caseId, contract, originals]) => [caseId, Object.freeze({ contract,
  originals: Object.freeze(originals.map(([ref, sha256]) => Object.freeze({ ref, sha256 }))) })])));

function selected(caseId, contract) {
  if (!Object.hasOwn(REGISTRY, caseId) || REGISTRY[caseId].contract !== contract) throw fail('Select a fixed existing case and its exact continuation contract.');
  return REGISTRY[caseId];
}
function plan(caseId, contract = REGISTRY[caseId]?.contract) {
  const entry = selected(caseId, contract);
  return { caseId, contract, proposal: true, claimsAttempt: false, acceptancePlan: 'docs/LIVE_ACCEPTANCE_CONTINUATION.md',
    historicalAttemptsUsed: 2, continuationMaximum: 2, lifetimeAttemptOrdinals: [3, 4], originals: entry.originals.map(value => ({ ...value })) };
}
function reference(value) {
  if (!value || Object.keys(value).some(key => !['ref', 'sha256'].includes(key))
    || typeof value.ref !== 'string' || !/^evidence\/[a-zA-Z0-9_./-]+\.json$/.test(value.ref)
    || value.ref.split('/').some(part => !part || part.startsWith('.'))
    || !/^[a-f0-9]{64}$/.test(value.sha256 || '')) throw fail('Use a safe evidence-relative JSON reference and its SHA256.');
  return { ref: value.ref, sha256: value.sha256 };
}
function validateDecision(decision, caseId, contract) {
  selected(caseId, contract);
  if (decision?.schemaVersion !== 1 || decision.status !== 'approved' || decision.source !== 'direct-owner'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(decision.decisionId || '') || !Array.isArray(decision.cases))
    throw fail('An actual recorded direct-owner approved decision is required; a proposal cannot authorize a claim.');
  const seen = new Set();
  for (const entry of decision.cases) {
    selected(entry.caseId, entry.contract);
    if (seen.has(entry.caseId) || entry.historicalAttemptsUsed !== 2 || entry.continuationMaximum !== 2) throw fail('Decision case selection or finite budget is invalid.');
    seen.add(entry.caseId);
  }
  if (!seen.has(caseId)) throw fail('The actual owner decision did not select this case.');
  return { decisionId: decision.decisionId, caseId, contract };
}
function validateOriginals(receipts, caseId) {
  if (!Array.isArray(receipts) || receipts.length !== 2) throw fail('Two exact retained original receipts are required.');
  receipts.forEach((value, index) => {
    if (value?.caseId !== caseId || value.attempt !== index + 1 || !['fail', 'blocked'].includes(value.status))
      throw fail('Original receipts must be this exact case attempts 1 and 2 with retained fail/blocked outcomes.');
  });
}
function changed(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]|[A-Za-z]:[\\/]|(?:^|\s)(?:\/|\\)|(?:https?:\/\/)/.test(value))
    throw fail('A bounded explicit actual change without private paths or content is required.');
  return value.trim();
}
function terminalMatches(receipt, claim) {
  for (const field of ['claimId', 'decisionId', 'caseId', 'contract', 'historicalAttemptsUsed', 'continuationAttempt', 'lifetimeAttemptOrdinal'])
    if (receipt?.[field] !== claim[field]) throw fail('Prior terminal receipt does not match the exact first continuation claim.');
  if (JSON.stringify(receipt.ownerDecision) !== JSON.stringify(claim.ownerDecision) || !['fail', 'blocked'].includes(receipt.status)
    || typeof receipt.completedAt !== 'string' || !Number.isFinite(Date.parse(receipt.completedAt)))
    throw fail('Only the same-decision terminal fail/blocked first continuation permits a correction.');
}

function createBookkeeper({ root = ROOT } = {}) {
  const workspace = path.resolve(root);
  // One canonical per-case ledger across decision IDs; changing a directory/decision cannot reset it.
  const ledgerRoot = path.join(workspace, 'evidence', 'live-acceptance-continuation', 'ledger');
  async function read(descriptor) {
    const safe = reference(descriptor), filename = path.join(workspace, ...safe.ref.split('/'));
    const realRoot = await fs.realpath(workspace), realFile = await fs.realpath(filename), relative = path.relative(realRoot, realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail('Evidence reference escapes the workspace.');
    const bytes = await fs.readFile(realFile);
    if (digest(bytes) !== safe.sha256) throw fail('Referenced evidence SHA256 changed.');
    return JSON.parse(bytes.toString('utf8'));
  }
  async function claim(input) {
    const allowed = ['caseId', 'contract', 'decision', 'originals', 'historicalAttemptsUsed', 'continuationAttempt', 'lifetimeAttemptOrdinal', 'prior', 'changedPrecondition'];
    if (!input || Object.keys(input).some(key => !allowed.includes(key))) throw fail('Unknown claim fields; attempt numbers and ledger locations cannot be reset.');
    const entry = selected(input.caseId, input.contract), attempt = input.continuationAttempt;
    if (input.historicalAttemptsUsed !== 2 || ![1, 2].includes(attempt)
      || input.lifetimeAttemptOrdinal !== attempt + 2) throw fail('Continuation 1 or 2 must retain historical count 2 and lifetime ordinal 3 or 4.');
    if (attempt === 1 && (input.prior !== undefined || input.changedPrecondition !== undefined)) throw fail('First continuation cannot pretend to be a corrective retry.');
    const change = attempt === 2 ? changed(input.changedPrecondition) : undefined;
    const decisionRef = reference(input.decision), decision = validateDecision(await read(decisionRef), input.caseId, input.contract);
    if (JSON.stringify(input.originals) !== JSON.stringify(entry.originals)) throw fail('Original references and hashes must match the frozen exhausted receipts.');
    const originals = await Promise.all(entry.originals.map(read)); validateOriginals(originals, input.caseId);
    const decisionMetadata = { ...decision, ownerDecision: decisionRef, historicalAttemptsUsed: 2, originals: entry.originals.map(value => ({ ...value })) };
    await fs.mkdir(ledgerRoot, { recursive: true });
    if ((await fs.lstat(ledgerRoot)).isSymbolicLink()) throw fail('The canonical ledger must not be redirected.');
    const lock = path.join(ledgerRoot, `${input.caseId}.lock`), ledgerPath = path.join(ledgerRoot, `${input.caseId}.json`);
    try { await fs.mkdir(lock); } catch (error) {
      if (error.code === 'EEXIST') throw fail('Another claim holds this case lock; do not retry automatically or clear an uncertain claim.'); throw error;
    }
    try {
      let ledger;
      try {
        if ((await fs.lstat(ledgerPath)).isSymbolicLink()) throw fail('The canonical ledger must not be redirected.');
        ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (ledger) {
        if (ledger.schemaVersion !== 1 || JSON.stringify(ledger.selection) !== JSON.stringify(decisionMetadata) || !Array.isArray(ledger.claims))
          throw fail('Existing ledger belongs to a different decision/contract/history; no reset is allowed.');
        if (ledger.claims.length !== 1 || attempt !== 2) throw fail('Continuation budget is already claimed or exhausted.');
        const first = ledger.claims[0];
        if (first.continuationAttempt !== 1 || first.lifetimeAttemptOrdinal !== 3
          || !/^[a-f0-9-]{36}$/.test(first.claimId || '')
          || Object.keys(decisionMetadata).some(key => JSON.stringify(first[key]) !== JSON.stringify(decisionMetadata[key])))
          throw fail('Existing ledger is not a valid matching first continuation.');
        const prior = reference(input.prior); terminalMatches(await read(prior), first);
      } else if (attempt !== 1) throw fail('A corrective continuation requires its existing first claim ledger.');
      const value = { ...decisionMetadata, claimId: randomUUID(), continuationAttempt: attempt, lifetimeAttemptOrdinal: attempt + 2,
        claimedAt: new Date().toISOString(), ...(attempt === 2 ? { prior: reference(input.prior), changedPreconditionSha256: digest(change) } : {}) };
      const next = { schemaVersion: 1, selection: decisionMetadata, claims: [...(ledger?.claims ?? []), value] };
      const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      await fs.rename(temporary, ledgerPath);
      return value;
    } finally { await fs.rmdir(lock); }
  }
  return { claim };
}

module.exports = { REGISTRY, digest, plan, reference, validateDecision, validateOriginals, terminalMatches, createBookkeeper };
