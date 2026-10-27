#!/usr/bin/env node
'use strict';

// Replaces installed TRACE Computer Use skill copies with the repository version after exact backups.
// It touches only TRACE-owned SKILL.md files; client settings are verified separately by computer:config.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { SKILL_NAME, plan: configurationPlan } = require('../src/computer/configuration.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'skills', SKILL_NAME, 'SKILL.md');
const DESTINATIONS = [`.agents/skills/${SKILL_NAME}`, `.claude/skills/${SKILL_NAME}`, `.grok/skills/${SKILL_NAME}`];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = bytes => /^name: trace-computer-use\r?$/m.test(bytes.toString('utf8'));
const failure = (code, message) => Object.assign(new Error(message), { code });

async function inspect(home, relative, source) {
  const directory = path.join(home, relative);
  const target = path.join(directory, 'SKILL.md');
  const entry = { path: `~/${relative}/SKILL.md`, directory, target };
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return { ...entry, action: 'skip', reason: 'not_installed' }; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ...entry, action: 'conflict', reason: 'unsafe_destination' };
  const bytes = await fs.readFile(target);
  if (!owned(bytes)) return { ...entry, action: 'conflict', reason: 'not_trace_owned' };
  const unexpected = (await fs.readdir(directory)).filter(name => name !== 'SKILL.md' && !name.startsWith('SKILL.md.trace.backup.'));
  if (unexpected.length) return { ...entry, action: 'conflict', reason: 'unexpected_files' };
  return { ...entry, original: bytes, priorSha256: hash(bytes), action: bytes.equals(source) ? 'unchanged' : 'replace' };
}

async function prepare(home) {
  const source = await fs.readFile(SOURCE);
  if (!owned(source)) throw failure('invalid_skill_source', 'Repository skill has an unexpected name.');
  const entries = [];
  for (const relative of DESTINATIONS) entries.push(await inspect(home, relative, source));
  return { source, sourceSha256: hash(source), entries };
}

const describe = (prepared, extra = {}) => ({
  skill: SKILL_NAME, sourceSha256: prepared.sourceSha256,
  entries: prepared.entries.map(({ path: shown, action, reason, priorSha256 }) => ({ path: shown, action, ...(reason ? { reason } : {}), ...(priorSha256 ? { priorSha256 } : {}) })),
  ...extra,
});

async function apply(home) {
  const prepared = await prepare(home);
  if (prepared.entries.some(entry => entry.action === 'conflict')) return describe(prepared, { applied: false, error: 'conflict' });
  const copies = [];
  for (const entry of prepared.entries.filter(item => item.action === 'replace')) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${entry.target}.trace.backup.${stamp}-${randomUUID()}`;
    await fs.writeFile(backup, entry.original, { flag: 'wx' });
    const backupVerified = hash(await fs.readFile(backup)) === entry.priorSha256;
    if (!backupVerified) throw failure('backup_mismatch', `Backup for ${entry.path} differs from the installed copy.`);
    const temporary = path.join(entry.directory, `.trace-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, prepared.source, { flag: 'wx' });
    // Refuse a destination that changed after planning; its content stays untouched.
    if (hash(await fs.readFile(entry.target)) !== entry.priorSha256) { await fs.unlink(temporary); throw failure('destination_changed', `${entry.path} changed during synchronization.`); }
    await fs.rename(temporary, entry.target);
    const installedSha256 = hash(await fs.readFile(entry.target));
    copies.push({ path: entry.path, priorSha256: entry.priorSha256, installedSha256, backup: `~/${path.relative(home, backup).replaceAll(path.sep, '/')}`, exactBackupVerified: backupVerified });
  }
  const after = await prepare(home);
  return describe(after, { applied: true, copies, allMatch: after.entries.every(entry => ['unchanged', 'skip'].includes(entry.action)) });
}

async function discovery() {
  const result = await configurationPlan();
  return { serverEntries: result.entries.filter(item => item.kind === 'configuration').map(({ client, action }) => ({ client, action })), skillEntries: result.entries.filter(item => item.kind === 'skill').map(({ path: shown, action }) => ({ path: shown, action })), skillSha256: result.skill.sha256 };
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--plan', '--apply'].includes(args[0])) throw new Error('Usage: node scripts/sync-computer-skill.cjs --plan|--apply');
  const home = os.homedir();
  if (args[0] === '--plan') return { mode: 'plan', ...describe(await prepare(home)), discovery: await discovery() };
  const applied = await apply(home);
  return { mode: 'apply', observedAt: new Date().toISOString(), ...applied, discovery: await discovery() };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => { process.stderr.write(`Skill synchronization failed: ${error.message}\n`); process.exitCode = 1; });
module.exports = { main, prepare, apply, DESTINATIONS };
