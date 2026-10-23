#!/usr/bin/env node
'use strict';

// Noninteractive distribution checks. Import and --plan perform no I/O or subprocess work.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ROOT = path.resolve(__dirname, '..');
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fail(code); };
const FULL_SHA = /^[a-f0-9]{40}$/;
const LIMITS = ['Clean extraction on this host; not by itself complete RC-INSTALL or final release acceptance.',
  'No desktop actions, model requests, clipboard contents access, personal client settings changes or recovery apply.',
  'Native provider diagnostics and synthetic static MCP analysis are separate from live host/application acceptance.'];

function parseArgs(args) {
  const options = { mode: 'plan' }; let selected = false;
  for (let i = 0; i < args.length; i++) {
    if (['--plan', '--verify'].includes(args[i]) && !selected) { options.mode = args[i].slice(2); selected = true; }
    else if (args[i] === '--commit' && !options.commit && FULL_SHA.test(args[i + 1] ?? '')) options.commit = args[++i];
    else throw fail('archive_arguments_invalid');
  }
  return options;
}
function plan({ commit } = {}) {
  need(commit === undefined || FULL_SHA.test(commit), 'archive_commit_invalid');
  return { schemaVersion: 1, mode: 'plan', effectsStarted: false, commit: commit ?? 'HEAD resolved once at verification',
    requirements: ['Windows x64', 'Git', 'Node and npm CLI', '.NET 9 SDK and Windows Desktop runtime', 'Network for locked npm dependencies and pinned engine archive'],
    steps: ['Archive one full commit twice and compare exact bytes.', 'Extract into a unique ignored directory; reject links and preexisting runtimes/dependencies.',
      'Install the extracted lock with npm ci; build and verify local helpers and pinned engine.', 'Check actual doctor and both read-only MCP smoke paths.',
      'Verify four synthetic client configurations, three skill bundles, exact backups, idempotence, conflict preservation and rollback.'],
    output: '.runtime/archive-install/verify-*/receipt.json; raw logs stay private beside it', limits: LIMITS };
}
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function noLinks(target) {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    need(!stat.isSymbolicLink(), 'archive_link_rejected');
  }
}
async function fileTree(folder, prefix = '') {
  const output = {};
  for (const entry of await fs.readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    need(!entry.isSymbolicLink(), 'archive_link_rejected');
    const file = path.join(folder, name); await noLinks(file);
    if (entry.isDirectory()) Object.assign(output, await fileTree(folder, name));
    else { need(entry.isFile(), 'archive_nonordinary_file'); output[name] = hash(await fs.readFile(file)); }
  }
  return output;
}
async function verifyExtraction(extracted) {
  await noLinks(extracted);
  for (const name of ['node_modules', '.runtime', '.git', '.env']) {
    try { await fs.lstat(path.join(extracted, name)); throw fail('archive_not_clean'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const files = await fileTree(extracted);
  need(!Object.keys(files).some(name => /(^|\/)\.env(?:\.|$)/.test(name) && !name.endsWith('.env.example')), 'archive_private_environment_file');
  for (const name of ['package.json', 'package-lock.json', 'bin/trace.cjs', 'scripts/setup-computer.cjs', 'src/computer/configuration.cjs'])
    need(Object.hasOwn(files, name), 'archive_source_incomplete');
  return files;
}

async function verifyScratchConfiguration({ extracted, home }) {
  // Every configuration operation receives both explicit paths; never use default home discovery.
  await noLinks(extracted); await noLinks(home);
  const fromArchive = createRequire(path.join(extracted, 'package.json'));
  const cfg = fromArchive('./src/computer/configuration.cjs'), toml = fromArchive('smol-toml');
  const originals = new Map(), parsed = new Map();
  for (const [client, item] of Object.entries(cfg.CLIENTS)) {
    const bytes = Buffer.from(item.format === 'toml'
      ? '# Synthetic unrelated settings\r\nmodel="synthetic"\r\n[mcp_servers.other]\r\ncommand="preserve"\r\nargs=["synthetic"]\r\n'
      : '{\r\n "theme":"synthetic",\r\n "mcpServers":{"other":{"command":"preserve","args":["synthetic"]}}\r\n}\r\n');
    const file = path.resolve(home, item.path); need(inside(home, file), 'archive_scratch_escape');
    await fs.mkdir(path.dirname(file), { recursive: true }); await noLinks(path.dirname(file));
    await fs.writeFile(file, bytes, { flag: 'wx' });
    originals.set(client, bytes); parsed.set(client, item.format === 'json' ? JSON.parse(bytes) : structuredClone(toml.parse(bytes.toString())));
  }
  const options = { home, root: extracted }, proposed = await cfg.plan(options);
  assert.equal(proposed.conflicts, 0); assert.equal(proposed.entries.length, 7);
  const installed = await cfg.apply(options);
  assert.equal(installed.applied, true); assert.equal(installed.completed.length, 7);
  const shownPath = shown => { need(typeof shown === 'string' && shown.startsWith('~/'), 'archive_backup_invalid');
    const target = path.resolve(home, shown.slice(2)); need(inside(home, target), 'archive_scratch_escape'); return target; };
  for (const [client, item] of Object.entries(cfg.CLIENTS)) {
    const bytes = await fs.readFile(path.join(home, item.path));
    const value = item.format === 'json' ? JSON.parse(bytes) : structuredClone(toml.parse(bytes.toString()));
    assert.deepEqual(value[item.table]['trace-computer'], proposed.server); delete value[item.table]['trace-computer'];
    assert.deepEqual(value, parsed.get(client));
    const backup = installed.completed.find(entry => entry.path === `~/${item.path}`);
    await noLinks(shownPath(backup.backup));
    assert.ok((await fs.readFile(shownPath(backup.backup))).equals(originals.get(client)));
  }
  const bundle = await cfg.loadSkillBundle(path.join(extracted, 'skills/trace-computer-use'));
  assert.equal(bundle.files.size, 5); assert.equal(cfg.SKILL_DESTINATIONS.length, 3); assert.equal(Object.keys(cfg.CLIENTS).length, 4);
  for (const directory of cfg.SKILL_DESTINATIONS) for (const [name, bytes] of bundle.files)
    assert.ok((await fs.readFile(path.join(home, directory, name))).equals(bytes));
  const unrelated = path.join(home, cfg.SKILL_DESTINATIONS[0], 'synthetic-unrelated-note.txt');
  await fs.writeFile(unrelated, 'Preserve this unrelated synthetic file.\r\n', { flag: 'wx' });
  const beforeRepeat = await fileTree(home), repeated = await cfg.apply(options);
  assert.equal(repeated.applied, true); assert.deepEqual(repeated.completed, []); assert.deepEqual(await fileTree(home), beforeRepeat);
  assert.equal((await cfg.rollback({ home, receipt: installed })).applied, true);
  for (const [client, item] of Object.entries(cfg.CLIENTS)) assert.ok((await fs.readFile(path.join(home, item.path))).equals(originals.get(client)));
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'Preserve this unrelated synthetic file.\r\n');
  for (const directory of cfg.SKILL_DESTINATIONS) for (const name of bundle.files.keys())
    await assert.rejects(fs.access(path.join(home, directory, name)), { code: 'ENOENT' });
  const target = path.join(home, cfg.CLIENTS.gemini_cli.path), conflict = JSON.parse(await fs.readFile(target, 'utf8'));
  conflict.mcpServers['trace-computer'] = { command: 'synthetic-conflicting-server', args: [] }; await fs.writeFile(target, JSON.stringify(conflict));
  const beforeConflict = await fileTree(home), blocked = await cfg.apply(options);
  assert.equal(blocked.applied, false); assert.ok(blocked.conflicts > 0); assert.deepEqual(await fileTree(home), beforeConflict);
  return { clients: 4, skillDestinations: 3, managedFilesPerBundle: 5, exactOriginalBackups: true, unrelatedSettingsPreserved: true,
    idempotent: true, exactConfigRollback: true, ownedSkillFilesRemoved: true, unrelatedSkillFilePreserved: true,
    conflictingServerPreserved: true, conflictProducedNoWrites: true, personalSettingsModified: false };
}

function sanitizedReceipt({ commit, archiveSha256, archiveBytes, checks, errorCode, status, runId }) {
  // Deliberate allowlist: raw command output, errors, paths and configuration content stay private.
  const publicChecks = {};
  for (const key of ['reproducibleArchives', 'extractedInitiallyClean', 'lockedDependenciesInstalled', 'pinnedEngineAndHelpersVerified', 'providerReady', 'archivedSourceUnchanged'])
    if (typeof checks?.[key] === 'boolean') publicChecks[key] = checks[key];
  for (const [key, count] of [['computerMcpTools', 6], ['reaMcpTools', 207]]) if (checks?.[key] === count) publicChecks[key] = count;
  if (checks?.configuration) {
    publicChecks.configuration = {};
    for (const [key, count] of [['clients', 4], ['skillDestinations', 3], ['managedFilesPerBundle', 5]])
      if (checks.configuration[key] === count) publicChecks.configuration[key] = count;
    for (const key of ['exactOriginalBackups', 'unrelatedSettingsPreserved', 'idempotent', 'exactConfigRollback', 'ownedSkillFilesRemoved',
      'unrelatedSkillFilePreserved', 'conflictingServerPreserved', 'conflictProducedNoWrites', 'personalSettingsModified'])
      if (typeof checks.configuration[key] === 'boolean') publicChecks.configuration[key] = checks.configuration[key];
  }
  return { schemaVersion: 1, caseId: 'SOURCE-ARCHIVE-INSTALL', status: status === 'pass' ? 'pass' : 'fail', ...(FULL_SHA.test(commit) ? { commit } : {}),
    ...(/^verify-[A-Za-z0-9]{6}$/.test(runId ?? '') ? { privateArtifacts: `.runtime/archive-install/${runId}` } : {}),
    ...(/^[a-f0-9]{64}$/.test(archiveSha256 ?? '') && Number.isSafeInteger(archiveBytes) && archiveBytes > 0 ? { archiveSha256, archiveBytes } : {}), checks: publicChecks,
    ...(errorCode ? { errorCode: /^archive_[a-z_]+$/.test(errorCode) ? errorCode : 'archive_verification_failed' } : {}), desktopActions: 0, modelRequests: 0, clipboardContentsRead: false,
    clipboardContentsChanged: false, personalSettingsModified: false, recoveryApplied: false, limits: LIMITS };
}

async function verify({ commit, root = ROOT, platform = process.platform, arch = process.arch,
  npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  run = execute, configurationCheck = verifyScratchConfiguration } = {}) {
  need(platform === 'win32' && arch === 'x64', 'archive_windows_x64_required');
  need(commit === undefined || FULL_SHA.test(commit), 'archive_commit_invalid');
  await noLinks(root);
  // npm is a trusted read-only host tool: resolve normal runtime/nvm aliases first.
  // Owned workspace destinations below deliberately keep strict link rejection.
  try { npmCli = await fs.realpath(npmCli); } catch { throw fail('archive_npm_cli_missing'); }
  await noLinks(npmCli); need((await fs.lstat(npmCli)).isFile(), 'archive_npm_cli_missing');
  const resolved = (await run('git', ['rev-parse', '--verify', `${commit ?? 'HEAD'}^{commit}`], { cwd: root, windowsHide: true, timeout: 15000 })).stdout.trim();
  need(FULL_SHA.test(resolved) && (!commit || resolved === commit), 'archive_commit_mismatch'); commit = resolved;
  const runtime = path.join(root, '.runtime');
  await fs.mkdir(runtime, { recursive: true }); await noLinks(runtime);
  const parent = path.join(runtime, 'archive-install'); await fs.mkdir(parent, { recursive: true }); await noLinks(parent);
  const directory = await fs.mkdtemp(path.join(parent, 'verify-')); await noLinks(directory);
  const logs = path.join(directory, 'logs'); await fs.mkdir(logs);
  const home = path.join(directory, 'scratch-home'); await fs.mkdir(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    TRACE_COMPUTER_RUNTIME: path.join(directory, 'diagnostics'), NODE_OPTIONS: '', NODE_PATH: '', DOTNET_CLI_HOME: home,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    NUGET_PACKAGES: path.join(directory, 'nuget-packages'), NUGET_HTTP_CACHE_PATH: path.join(directory, 'nuget-http-cache'),
    WINAPP_CLI_TELEMETRY_OPTOUT: '1', npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_globalconfig: path.join(home, 'global.npmrc'), npm_config_cache: path.join(directory, 'npm-cache') };
  const checks = {}; let archiveSha256, archiveBytes;
  const command = async (label, executable, args, cwd = root, timeout = 180000) => {
    try {
      const result = await run(executable, args, { cwd, env, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
      await fs.writeFile(path.join(logs, `${label}.stdout.log`), result.stdout ?? '', { flag: 'wx' });
      await fs.writeFile(path.join(logs, `${label}.stderr.log`), result.stderr ?? '', { flag: 'wx' });
      return result.stdout;
    } catch (error) {
      await fs.writeFile(path.join(logs, `${label}.failure.log`), JSON.stringify({ stdout: error.stdout, stderr: error.stderr, message: error.message }) + '\n', { flag: 'wx' });
      throw fail(`archive_${label}_failed`);
    }
  };
  try {
    const tree = await command('tree', 'git', ['ls-tree', '-r', '-z', '--full-tree', commit]);
    need(tree.length > 0 && tree.split('\0').filter(Boolean).every(entry => /^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry)), 'archive_tree_links_or_submodules');
    for (const name of ['source.zip', 'reproduction.zip']) await command(name === 'source.zip' ? 'archive' : 'reproduce', 'git',
      ['archive', '--format=zip', '--prefix=trace-workbench/', `--output=${path.join(directory, name)}`, commit]);
    const bytes = await fs.readFile(path.join(directory, 'source.zip'));
    need(bytes.length > 0 && bytes.equals(await fs.readFile(path.join(directory, 'reproduction.zip'))), 'archive_not_reproducible');
    archiveSha256 = hash(bytes); archiveBytes = bytes.length; checks.reproducibleArchives = true;
    const script = path.join(directory, 'extract.ps1');
    await fs.writeFile(script, 'param([string]$Archive,[string]$Destination)\n$ErrorActionPreference="Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n', { flag: 'wx' });
    await command('extract', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-File', script, '-Archive', path.join(directory, 'source.zip'), '-Destination', path.join(directory, 'extracted')]);
    const extracted = path.join(directory, 'extracted/trace-workbench'), sourceFiles = await verifyExtraction(extracted);
    checks.extractedInitiallyClean = true;
    await command('npm_ci', process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], extracted, 300000); checks.lockedDependenciesInstalled = true;
    const setup = JSON.parse(await command('setup', process.execPath, ['scripts/setup-computer.cjs', '--apply'], extracted, 600000));
    need(setup.installed === true && setup.integrity === 'verified' && ['bridge', 'activityIndicator', 'supervisor', 'clipboard'].every(key => setup[key]?.built === true)
      && setup.clipboard.clipboardContentsRead === false && setup.clipboard.clipboardContentsChanged === false, 'archive_setup_incomplete');
    checks.pinnedEngineAndHelpersVerified = true;
    const doctor = JSON.parse(await command('doctor', process.execPath, ['bin/trace.cjs', 'computer', 'doctor'], extracted));
    need(doctor.ready === true && doctor.integrity === 'verified', 'archive_provider_not_ready'); checks.providerReady = true;
    const computer = JSON.parse(await command('computer_mcp', process.execPath, ['scripts/smoke-computer-mcp.cjs'], extracted));
    need(computer.result === 'pass' && computer.providerReady === true && computer.toolCount === 6 && computer.desktopActions === 0 && computer.modelRequests === 0, 'archive_computer_mcp_unverified');
    checks.computerMcpTools = 6;
    const analysis = JSON.parse(await command('rea_mcp', process.execPath, ['scripts/smoke-mcp.cjs'], extracted));
    need(analysis.passed === true && analysis.toolCount === 207 && analysis.target?.unchanged === true
      && analysis.limits?.paidCalls === 0 && analysis.limits.modelClientTests === 0 && analysis.limits.executedTargetCode === false, 'archive_rea_mcp_unverified'); checks.reaMcpTools = 207;
    checks.configuration = await configurationCheck({ extracted, home });
    for (const [name, expected] of Object.entries(sourceFiles)) need(hash(await fs.readFile(path.join(extracted, name))) === expected, 'archive_source_changed');
    checks.archivedSourceUnchanged = true;
    const receipt = sanitizedReceipt({ commit, archiveSha256, archiveBytes, checks, status: 'pass', runId: path.basename(directory) });
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  } catch (error) {
    const errorCode = /^archive_[a-z_]+$/.test(error.code ?? '') ? error.code : 'archive_verification_failed';
    const receipt = sanitizedReceipt({ commit, archiveSha256, archiveBytes, checks, errorCode, status: 'fail', runId: path.basename(directory) });
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  }
}
async function main(args = process.argv.slice(2), deps = {}) {
  const options = parseArgs(args); return options.mode === 'plan' ? plan(options) : verify({ ...deps, commit: options.commit });
}
module.exports = { parseArgs, plan, inside, noLinks, fileTree, verifyExtraction, verifyScratchConfiguration, sanitizedReceipt, verify, main };
if (require.main === module) main().then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.status === 'fail') process.exitCode = 1;
}, error => { process.stderr.write(`${/^archive_[a-z_]+$/.test(error.code ?? '') ? error.code : 'archive_verification_failed'}\n`); process.exitCode = 1; });
