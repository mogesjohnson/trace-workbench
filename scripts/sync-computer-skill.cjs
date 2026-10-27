#!/usr/bin/env node
'use strict';

// Synchronize the canonical TRACE skill bundle, retaining exact managed-file backups.
// Unknown files stay untouched. A changed managed file requires explicit conflict resolution.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  SKILL_NAME, SKILL_DESTINATIONS, loadSkillBundle, skillItem, publishSkillBundle,
  rollbackSkillBundle, assertSourceUnchanged, assertUnchanged,
  plan: configurationPlan, rollback: rollbackConfiguration,
} = require('../src/computer/configuration.cjs');

const ROOT = path.resolve(__dirname, '..');
const DESTINATIONS = SKILL_DESTINATIONS;

async function prepare(home, options = {}) {
  const bundle = await loadSkillBundle(path.join(options.root ?? ROOT, 'skills', SKILL_NAME));
  const entries = [];
  for (const relative of DESTINATIONS) entries.push(await skillItem({ home }, relative, bundle, { migrateLegacy: true, skipMissing: true }));
  return { bundle, source: bundle.files.get('SKILL.md'), sourceSha256: bundle.sha256, sourceBundleSha256: bundle.bundleSha256, entries };
}

const describe = (prepared, extra = {}) => ({
  skill: SKILL_NAME, sourceSha256: prepared.sourceSha256, sourceBundleSha256: prepared.sourceBundleSha256,
  entries: prepared.entries.map(({ path: shown, action, reason, files }) => ({ path: shown, action, ...(reason ? { reason } : {}),
    ...(files ? { files: files.map(file => ({ path: file.name, action: file.action, priorSha256: file.original.fingerprint, sha256: file.sha256 })) } : {}) })),
  ...extra,
});

async function apply(home, options = {}) {
  home = path.resolve(home);
  const prepared = await prepare(home, options);
  if (prepared.entries.some(entry => entry.action === 'conflict')) return describe(prepared, { applied: false, error: 'conflict' });
  if (options.beforeWrite) await options.beforeWrite();
  await assertSourceUnchanged(prepared.bundle);
  for (const entry of prepared.entries.filter(item => item.action !== 'skip')) await assertUnchanged(entry);
  const copies = [];
  try {
    for (const entry of prepared.entries.filter(item => ['add', 'replace'].includes(item.action))) {
      const installed = await publishSkillBundle(entry, { home, beforeFileWrite: options.beforeFileWrite });
      copies.push({ path: entry.path, ...installed });
    }
  } catch (error) {
    const restored = [];
    for (const copy of [...copies].reverse()) restored.push({ path: copy.path, ...await rollbackSkillBundle(home, copy.backup) });
    return describe(prepared, { applied: false, error: error.code || 'synchronization_failed', copies,
      ...(error.bundleRecovery ? { bundleRecovery: error.bundleRecovery } : {}), rollback: restored });
  }
  const after = await prepare(home, options);
  return describe(after, { applied: true, copies, allMatch: after.entries.every(entry => ['unchanged', 'skip'].includes(entry.action)) });
}

async function rollback(home, receipt) {
  if (Array.isArray(receipt?.completed)) return rollbackConfiguration({ home, receipt });
  if (!Array.isArray(receipt?.copies)) throw Object.assign(new Error('Expected a TRACE synchronization or installation receipt.'), { code: 'invalid_rollback' });
  const changes = [...receipt.copies, ...(receipt.bundleRecovery ? [receipt.bundleRecovery] : [])];
  for (const copy of changes) {
    const checked = await rollbackSkillBundle(home, copy.backup, { dryRun: true });
    if (checked.conflicts) return { applied: false, conflicts: checked.conflicts, copies: [] };
  }
  const copies = [];
  for (const copy of [...changes].reverse()) {
    const restored = await rollbackSkillBundle(home, copy.backup);
    copies.push({ path: copy.path, ...restored });
    if (!restored.applied) return { applied: false, conflicts: restored.conflicts, copies };
  }
  return { applied: true, conflicts: 0, copies };
}

async function discovery() {
  const result = await configurationPlan();
  return { serverEntries: result.entries.filter(item => item.kind === 'configuration').map(({ client, action }) => ({ client, action })),
    skillEntries: result.entries.filter(item => item.kind === 'skill').map(({ path: shown, action }) => ({ path: shown, action })),
    skillSha256: result.skill.sha256, bundleSha256: result.skill.bundleSha256 };
}

async function main(args = process.argv.slice(2)) {
  const home = os.homedir();
  if (args.length === 2 && args[0] === '--rollback') return { mode: 'rollback', ...await rollback(home, JSON.parse(await fs.readFile(path.resolve(args[1]), 'utf8'))) };
  if (args.length !== 1 || !['--plan', '--apply'].includes(args[0])) throw new Error('Usage: node scripts/sync-computer-skill.cjs --plan|--apply|--rollback <saved-receipt.json>');
  if (args[0] === '--plan') return { mode: 'plan', ...describe(await prepare(home)), discovery: await discovery() };
  const applied = await apply(home);
  return { mode: 'apply', observedAt: new Date().toISOString(), ...applied, discovery: await discovery() };
}

if (require.main === module) main().then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.applied === false && result.mode !== 'plan') process.exitCode = 1;
}).catch(error => { process.stderr.write('Skill synchronization failed (' + (error.code || 'invalid_arguments') + ').\n'); process.exitCode = 1; });
module.exports = { main, prepare, apply, rollback, DESTINATIONS };
