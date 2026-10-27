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

const AMENDMENT_2 = Object.freeze({ amendment: 2,
  proposal: Object.freeze({ ref: 'docs/LIVE_ACCEPTANCE_AMENDMENT_2.md', sha256: '84a4d9df1d91ff28f257b35d0a09d4ce9fc22a159b9a75feaa6480d35061ef90' }),
  supplements: Object.freeze({
    'R31-GLOW-NATIVE': [
      { ref: 'evidence/live-acceptance-continuation/glow-supplemental-1/receipt.json', sha256: '1e448b086180161f7cf79684b0ee173b42b9da7579444a77a527dcf8d30299e3' },
      { ref: 'evidence/live-acceptance-continuation/glow-supplemental-2/receipt.json', sha256: '28c395d6db30eae1565af8e1937505c5d4a8e0ed4a5b3f804e22120fe72fb296' }],
    'CODEX-TRACE-SKILL-NATIVE': [
      { ref: 'evidence/live-acceptance-continuation/codex/attempt-1/receipt.json', sha256: 'e7a23461b1e07fd5e4cbb4292c4c55c870fb45dc8339a571551b8249f6c6e982' },
      { ref: 'evidence/live-acceptance-continuation/codex/attempt-2/receipt.json', sha256: '154834ccec67dc7656fba762284f15831165f5427f85c61a583a484f866b6bac' }]
  }) });
for (const rows of Object.values(AMENDMENT_2.supplements)) { rows.forEach(value => Object.freeze(value)); Object.freeze(rows); }
function amendmentHistory(caseId) {
  if (!Object.hasOwn(AMENDMENT_2.supplements, caseId)) throw fail('Amendment 2 selects only the frozen glow and Codex cases.');
  return [...REGISTRY[caseId].originals, ...AMENDMENT_2.supplements[caseId]].map(value => ({ ...value }));
}
function selected(caseId, contract) {
  if (!Object.hasOwn(REGISTRY, caseId) || REGISTRY[caseId].contract !== contract) throw fail('Select a fixed existing case and its exact continuation contract.');
  return REGISTRY[caseId];
}
function plan(caseId, contract = REGISTRY[caseId]?.contract, amendment) {
  const entry = selected(caseId, contract);
  if (amendment === 3 && caseId === 'R31-GLOW-NATIVE') return { ...require('./finish-acceptance-amendment.cjs').plan(caseId), originals: entry.originals.map(value => ({ ...value })) };
  if (amendment !== undefined) {
    if (amendment !== 2) throw fail('Only explicit amendment 2 is supported.');
    return { caseId, contract, amendment: 2, proposal: true, claimsAttempt: false, acceptancePlan: AMENDMENT_2.proposal.ref,
      proposalDocument: { ...AMENDMENT_2.proposal }, historicalAttemptsUsed: 4, continuationMaximum: 2, lifetimeAttemptOrdinals: [5, 6],
      originals: entry.originals.map(value => ({ ...value })), history: amendmentHistory(caseId) };
  }
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
function validateDecision(decision, caseId, contract, amendment) {
  selected(caseId, contract);
  if (decision?.schemaVersion !== 1 || decision.status !== 'approved' || decision.source !== 'direct-owner'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(decision.decisionId || '') || !Array.isArray(decision.cases))
    throw fail('An actual recorded direct-owner approved decision is required; a proposal cannot authorize a claim.');
  const seen = new Set();
  if (amendment !== undefined && (amendment !== 2 || decision.amendment !== 2
    || JSON.stringify(decision.proposal) !== JSON.stringify(AMENDMENT_2.proposal))) throw fail('Actual amendment 2 approval must bind the frozen proposal SHA256.');
  if (amendment === undefined && decision.amendment !== undefined) throw fail('Amendment decisions require explicit amendment selection.');
  for (const entry of decision.cases) {
    selected(entry.caseId, entry.contract);
    if (seen.has(entry.caseId) || entry.historicalAttemptsUsed !== (amendment === 2 ? 4 : 2) || entry.continuationMaximum !== 2) throw fail('Decision case selection or finite budget is invalid.');
    if (amendment === 2 && JSON.stringify(entry.history) !== JSON.stringify(amendmentHistory(entry.caseId))) throw fail('Amendment approval must bind all four exact retained receipts.');
    seen.add(entry.caseId);
  }
  if (!seen.has(caseId)) throw fail('The actual owner decision did not select this case.');
  return { decisionId: decision.decisionId, caseId, contract, ...(amendment === 2 ? { amendment: 2, proposal: { ...AMENDMENT_2.proposal }, history: amendmentHistory(caseId) } : {}) };
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
  if (claim.amendment !== undefined) for (const field of ['amendment', 'proposal', 'history', 'originals', 'prior', 'claimedAt', 'changedPreconditionSha256'])
    if (JSON.stringify(receipt?.[field]) !== JSON.stringify(claim[field])) throw fail('Prior terminal receipt belongs to another amendment or history.');
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
    const allowed = ['caseId', 'contract', 'decision', 'originals', 'historicalAttemptsUsed', 'continuationAttempt', 'lifetimeAttemptOrdinal', 'prior', 'changedPrecondition', 'amendment', 'history', 'proposal'];
    if (!input || Object.keys(input).some(key => !allowed.includes(key))) throw fail('Unknown claim fields; attempt numbers and ledger locations cannot be reset.');
    const entry = selected(input.caseId, input.contract), attempt = input.continuationAttempt;
    const amended = input.amendment !== undefined, historical = amended ? 4 : 2;
    if (amended) {
      plan(input.caseId, input.contract, input.amendment);
      if (JSON.stringify(input.history) !== JSON.stringify(amendmentHistory(input.caseId))
        || JSON.stringify(input.proposal) !== JSON.stringify(AMENDMENT_2.proposal)) throw fail('Claim must bind the exact amendment proposal and four-receipt history.');
      const proposalFile = await fs.realpath(path.join(workspace, AMENDMENT_2.proposal.ref));
      const proposalRelative = path.relative(await fs.realpath(workspace), proposalFile);
      if (proposalRelative.startsWith('..') || path.isAbsolute(proposalRelative)
        || digest(await fs.readFile(proposalFile)) !== AMENDMENT_2.proposal.sha256) throw fail('Frozen amendment proposal SHA256 changed.');
    } else if (input.history !== undefined || input.proposal !== undefined) throw fail('Amendment metadata requires explicit amendment 2.');
    if (input.historicalAttemptsUsed !== historical || ![1, 2].includes(attempt)
      || input.lifetimeAttemptOrdinal !== attempt + historical) throw fail('Continuation must retain its exact historical count and lifetime ordinal.');
    if (attempt === 1 && ((!amended && input.prior !== undefined) || input.changedPrecondition !== undefined)) throw fail('First continuation cannot pretend to be a corrective retry.');
    const change = attempt === 2 ? changed(input.changedPrecondition) : undefined;
    const decisionRef = reference(input.decision), decision = validateDecision(await read(decisionRef), input.caseId, input.contract, input.amendment);
    if (JSON.stringify(input.originals) !== JSON.stringify(entry.originals)) throw fail('Original references and hashes must match the frozen exhausted receipts.');
    const originals = await Promise.all(entry.originals.map(read)); validateOriginals(originals, input.caseId);
    const decisionMetadata = { ...decision, ownerDecision: decisionRef, historicalAttemptsUsed: historical, originals: entry.originals.map(value => ({ ...value })) };
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
      if (amended) {
        const history = amendmentHistory(input.caseId), receipts = await Promise.all(history.slice(2).map(read));
        if (!ledger || ledger.schemaVersion !== 1 || !Array.isArray(ledger.claims) || ![2, 3].includes(ledger.claims.length)
          || !ledger.selection || JSON.stringify(ledger.selection.originals) !== JSON.stringify(entry.originals)) throw fail('Amendment requires the intact canonical first-round ledger.');
        const originalDecisionRef = reference(ledger.selection.ownerDecision);
        const originalDecision = validateDecision(await read(originalDecisionRef), input.caseId, input.contract);
        const originalMetadata = { ...originalDecision, ownerDecision: originalDecisionRef, historicalAttemptsUsed: 2, originals: entry.originals.map(value => ({ ...value })) };
        if (JSON.stringify(ledger.selection) !== JSON.stringify(originalMetadata) || originalDecision.decisionId === decision.decisionId) throw fail('Amendment must retain the original owner selection and use a distinct actual decision.');
        for (let index = 0; index < 2; index++) {
          const claim = ledger.claims[index];
          if (!claim || claim.amendment !== undefined || claim.continuationAttempt !== index + 1 || claim.lifetimeAttemptOrdinal !== index + 3
            || !/^[a-f0-9-]{36}$/.test(claim.claimId || '') || !Number.isFinite(Date.parse(claim.claimedAt))
            || Object.keys(originalMetadata).some(key => JSON.stringify(claim[key]) !== JSON.stringify(originalMetadata[key]))) throw fail('Malformed or cross-case historical ledger claim.');
          terminalMatches(receipts[index], claim);
          if (Object.keys(claim).some(key => JSON.stringify(claim[key]) !== JSON.stringify(receipts[index][key]))) throw fail('Historical ledger claim differs from its exact frozen terminal receipt.');
          if (index === 1 && (JSON.stringify(claim.prior) !== JSON.stringify(history[2])
            || JSON.stringify(receipts[index].prior) !== JSON.stringify(history[2]) || !/^[a-f0-9]{64}$/.test(claim.changedPreconditionSha256 || '')))
            throw fail('Lifetime 4 must retain its exact same-owner lifetime 3 correction chain.');
        }
        const amendments = ledger.amendments ?? [];
        if (!Array.isArray(amendments) || amendments.length !== (attempt === 1 ? 0 : 1)
          || ledger.claims.length !== (attempt === 1 ? 2 : 3)) throw fail('Amendment budget is already claimed, missing or exhausted.');
        let prior;
        if (attempt === 1) {
          prior = reference(input.prior);
          if (JSON.stringify(prior) !== JSON.stringify(history[3])) throw fail('Lifetime 5 requires the exact frozen terminal lifetime 4.');
        } else {
          if (JSON.stringify(amendments[0]) !== JSON.stringify({ amendment: 2, selection: decisionMetadata })) throw fail('Different amendment decision/history cannot reset the budget.');
          const first = ledger.claims[2];
          if (first.continuationAttempt !== 1 || first.lifetimeAttemptOrdinal !== 5 || !/^[a-f0-9-]{36}$/.test(first.claimId || '') || !Number.isFinite(Date.parse(first.claimedAt))
            || Object.keys(decisionMetadata).some(key => JSON.stringify(first[key]) !== JSON.stringify(decisionMetadata[key]))
            || JSON.stringify(first.prior) !== JSON.stringify(history[3])) throw fail('Malformed lifetime 5 claim.');
          prior = reference(input.prior); terminalMatches(await read(prior), first);
        }
        const value = { ...decisionMetadata, claimId: randomUUID(), continuationAttempt: attempt, lifetimeAttemptOrdinal: attempt + 4,
          claimedAt: new Date().toISOString(), prior, ...(attempt === 2 ? { changedPreconditionSha256: digest(change) } : {}) };
        const next = { ...ledger, amendments: attempt === 1 ? [{ amendment: 2, selection: decisionMetadata }] : amendments, claims: [...ledger.claims, value] };
        const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, ledgerPath);
        return value;
      }
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

module.exports = { REGISTRY, AMENDMENT_2, amendmentHistory, digest, plan, reference, validateDecision, validateOriginals, terminalMatches, createBookkeeper };
