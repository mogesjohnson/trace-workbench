'use strict';

// Acceptance-only glue. Import and option/plan validation perform no I/O or claim.
const fs = require('node:fs/promises');
const path = require('node:path');
const book = require('./live-acceptance-continuation.cjs');
const ROOT = path.resolve(__dirname, '..');
const fail = message => Object.assign(new Error(message), { code: 'continuation_preflight_required' });
const DECISION = 'evidence/live-acceptance-continuation/owner-decision.json';
function options(input, caseId) {
  const proposal = book.plan(caseId, undefined, input.amendment);
  const mode = input.mode ?? 'plan';
  if (!['plan', 'live'].includes(mode)) throw fail('Mode must be plan or live.');
  if (![1, 2].includes(input.continuationAttempt) || input.attempt !== undefined || input.prior !== undefined || input.ownerDecision !== undefined)
    throw fail('Use explicit continuation 1 or 2; original attempt/prior/owner-decision fields cannot be reset.');
  if (mode === 'live' && (!input.directory || !input.decisionRef)) throw fail('A fresh directory and evidence-relative actual decision reference are required.');
  if (input.decisionRef) book.reference({ ref: input.decisionRef, sha256: '0'.repeat(64) });
  if (input.idleReadinessRef !== undefined) book.reference({ ref: input.idleReadinessRef, sha256: '0'.repeat(64) });
  if (input.continuationAttempt === 1 && (input.continuationPrior || input.change)) throw fail('First continuation cannot have corrective prior/change.');
  if (input.continuationAttempt === 2 && (!input.continuationPrior || typeof input.change !== 'string' || !input.change.trim())) throw fail('Second continuation requires exact terminal prior reference and actual change.');
  if (input.continuationPrior) book.reference({ ref: input.continuationPrior, sha256: '0'.repeat(64) });
  return { ...input, mode, caseId, contract: proposal.contract, historicalAttemptsUsed: proposal.historicalAttemptsUsed,
    lifetimeAttemptOrdinal: input.continuationAttempt + proposal.historicalAttemptsUsed };
}
function parse(args, caseId, extras = {}) {
  const value = { mode: 'plan' }, fields = { '--continuation': 'continuationAttempt', '--decision-ref': 'decisionRef',
    '--continuation-prior': 'continuationPrior', '--change': 'change', '--idle-readiness': 'idleReadinessRef', '--amendment': 'amendment', ...extras };
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === '--plan' || item === '--live') value.mode = item.slice(2);
    else if (fields[item]) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw fail(`Missing value for ${item}.`);
      value[fields[item]] = ['--continuation', '--amendment'].includes(item) ? Number(args[++index]) : args[++index];
    } else if (!item.startsWith('--') && !value.directory) value.directory = item;
    else throw fail('Unknown continuation flag; do not mix historical retry flags.');
  }
  return options(value, caseId);
}
async function evidence(ref, root = ROOT) {
  book.reference({ ref, sha256: '0'.repeat(64) });
  const filename = await fs.realpath(path.join(root, ...ref.split('/'))), base = await fs.realpath(root), relative = path.relative(base, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail('Evidence reference escapes its workspace.');
  const bytes = await fs.readFile(filename);
  return { descriptor: { ref, sha256: book.digest(bytes) }, value: JSON.parse(bytes.toString('utf8')) };
}
async function claimRequest(input, caseId, { root = ROOT } = {}) {
  if (input.amendment === 3) return require('./finish-acceptance-amendment.cjs').request(input, caseId, { root });
  const selected = options(input, caseId), decision = await evidence(selected.decisionRef, root);
  book.validateDecision(decision.value, caseId, selected.contract, selected.amendment);
  const amended = selected.amendment === 2;
  return { caseId, contract: selected.contract, decision: decision.descriptor, originals: book.plan(caseId).originals,
    historicalAttemptsUsed: selected.historicalAttemptsUsed, continuationAttempt: selected.continuationAttempt, lifetimeAttemptOrdinal: selected.lifetimeAttemptOrdinal,
    ...(amended ? { amendment: 2, proposal: { ...book.AMENDMENT_2.proposal }, history: book.amendmentHistory(caseId),
      ...(selected.continuationAttempt === 1 ? { prior: book.amendmentHistory(caseId)[3] } : {}) } : {}),
    ...(selected.continuationAttempt === 2 ? { prior: (await evidence(selected.continuationPrior, root)).descriptor, changedPrecondition: selected.change } : {}) };
}
async function preparedFixture(root = ROOT, io = fs) {
  const folder = path.join(root, '.runtime/computer-fixture');
  async function ordinary(filename) {
    const stat = await io.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || path.resolve(await io.realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase())
      throw fail('Prepared fixture must contain ordinary, unredirected files.');
    return io.readFile(filename);
  }
  const bytes = await ordinary(path.join(folder, 'prepared-manifest.json')), manifest = JSON.parse(bytes.toString('utf8'));
  const sources = ['tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj', 'scripts/smoke-computer-live.cjs'];
  const outputs = ['TraceComputerFixture.exe', 'TraceComputerFixture.dll', 'TraceComputerFixture.runtimeconfig.json', 'TraceComputerFixture.deps.json'];
  const sameKeys = (value, expected) => JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
  if (manifest.schemaVersion !== 1 || manifest.uiCreated !== 0 || manifest.inputActions !== 0
    || !sameKeys(manifest.sources, sources) || !sameKeys(manifest.files, outputs)) throw fail('Prepared fixture manifest is invalid.');
  for (const [names, hashes, base] of [[sources, manifest.sources, root], [outputs, manifest.files, path.join(folder, 'bin')]])
    for (const name of names) if (!/^[a-f0-9]{64}$/.test(hashes[name]) || book.digest(await ordinary(path.join(base, name))) !== hashes[name])
      throw fail('Prepared fixture source/output changed; rebuild only after closing preparation UI.');
  return { executable: path.join(folder, 'bin/TraceComputerFixture.exe'), summary: { manifestSha256: book.digest(bytes), sources: manifest.sources, files: manifest.files } };
}
async function runtimeSnapshot(root = ROOT, io = fs) {
  // Content hashes only: no executable launch, control path or personal configuration is returned.
  const pin = require('../src/computer/winapp-pin.json'), result = {};
  const groups = [['supervisor', 'TraceSupervisor'], ['activity-indicator', 'TraceActivityIndicator'], ['window-bridge', 'TraceWindowBridge']];
  for (const [role, stem] of groups) {
    result[`${role}/manifest`] = book.digest(await io.readFile(path.join(root, '.runtime', role, 'manifest.json')));
    for (const extension of ['exe', 'dll', 'runtimeconfig.json', 'deps.json'])
      result[`${role}/${stem}.${extension}`] = book.digest(await io.readFile(path.join(root, '.runtime', role, 'bin', `${stem}.${extension}`)));
  }
  for (const name of Object.keys(pin.files)) result[`pinned-engine/${name}`] = book.digest(await io.readFile(path.join(root, '.runtime', 'winapp', `v${pin.version}`, 'bin', name)));
  return result;
}
function validateReadiness(record, { caseId, anchor, now = Date.now() } = {}) {
  const at = Date.parse(record?.confirmedAt);
  if (record?.schemaVersion !== 1 || record.source !== 'direct-owner' || record.caseId !== caseId || record.ready !== true
    || !Number.isFinite(at) || at > now || now - at > 60000 || record.anchorOwnership !== 'run-owned-child')
    throw fail('A current direct owner idle-readiness record for this case and run-owned anchor is required; approval/polling is insufficient.');
  for (const field of ['id', 'pid', 'processCreationTime', 'sessionId']) if (record.anchor?.[field] !== anchor?.[field]) throw fail('Owner readiness belongs to another anchor generation.');
  if (!/^[1-9]\d*$/.test(anchor?.id || '') || !Number.isInteger(anchor?.pid) || anchor.pid < 1
    || !/^\d+$/.test(anchor?.processCreationTime || '') || !Number.isInteger(anchor?.sessionId) || anchor.sessionId < 0) throw fail('The exact run-owned anchor identity is required.');
  return { source: 'direct-owner', confirmedAt: record.confirmedAt, caseId, anchor: { ...anchor } };
}
async function idlePreflight({ record, caseId, anchor, pinnedDisplay }, deps) {
  // Called immediately before claim, never polling readiness into existence or creating/activating UI.
  const now = deps.now?.() ?? Date.now(); validateReadiness(record, { caseId, anchor, now });
  const display = await deps.command(['display']); deps.compareDisplay(display, pinnedDisplay);
  const recovery = await deps.command(['status']); if (recovery.recoveryRequired !== false) throw fail('Durable recovery is not clear.');
  const access = await deps.command(['input-access']); if (access.observable !== true || access.foregroundPid !== anchor.pid) throw fail('The exact owned anchor is not accessible foreground.');
  const identity = await deps.command(['identity', String(anchor.pid)]);
  if (identity.pid !== anchor.pid || identity.processCreationTime !== anchor.processCreationTime || identity.session !== anchor.sessionId) throw fail('Owned anchor generation/session changed.');
  const bounds = await deps.bridge('bounds', anchor);
  if (String(bounds.hwnd ?? bounds.id) !== anchor.id || bounds.pid !== anchor.pid || bounds.processCreationTime !== anchor.processCreationTime
    || bounds.sessionId !== anchor.sessionId || bounds.foreground !== true || bounds.minimized === true) throw fail('Owned anchor identity/foreground changed.');
  const input = await deps.command(['keystate', 'all']); if (!Array.isArray(input.down) || input.down.length) throw fail('Input is held or unavailable; readiness must be renewed before a later claim.');
  if (await deps.leaseFree() !== true) throw fail('Existing desktop ownership blocks a claim.');
  validateReadiness(record, { caseId, anchor, now: deps.now?.() ?? Date.now() });
  return { verifiedAt: new Date(deps.now?.() ?? Date.now()).toISOString(), anchor: { ...anchor }, keysDown: [], recoveryRequired: false, leaseFree: true };
}
module.exports = { DECISION, options, parse, evidence, claimRequest, preparedFixture, runtimeSnapshot, validateReadiness, idlePreflight };
