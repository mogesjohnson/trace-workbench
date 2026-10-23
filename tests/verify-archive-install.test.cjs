'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const verifier = require('../scripts/verify-archive-install.cjs');
const commit = 'a'.repeat(40);
async function temporary(work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-archive-test-'));
  try { return await work(directory); }
  finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('trace-archive-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
test('import, default CLI and explicit plan do not touch disk or launch tools', () => {
  const file = path.resolve(__dirname, '../scripts/verify-archive-install.cjs');
  const script = `const fs=require('node:fs/promises'),cp=require('node:child_process');
    for(const name of ['mkdir','mkdtemp','writeFile','readFile','lstat'])fs[name]=()=>{throw Error('unexpected filesystem effect')};
    cp.execFile=()=>{throw Error('unexpected process effect')};
    const v=require(process.argv[1]);v.main(['--plan','--commit', '${commit}']).then(x=>process.stdout.write(JSON.stringify(x)));`;
  const child = spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const plan = JSON.parse(child.stdout);
  assert.equal(plan.effectsStarted, false); assert.equal(plan.commit, commit);
  assert.ok(plan.limits.some(value => value.includes('not by itself complete RC-INSTALL')));
});
test('CLI does not accept a caller-selected home/directory or abbreviated revisions', () => {
  for (const args of [['--verify', '--home', os.homedir()], ['--directory', 'elsewhere'], ['--commit', 'HEAD'],
    ['--commit', '1234567'], ['--verify', '--plan'], ['--commit', commit, '--commit', commit]])
    assert.throws(() => verifier.parseArgs(args), { code: 'archive_arguments_invalid' });
  assert.deepEqual(verifier.parseArgs(['--verify', '--commit', commit]), { mode: 'verify', commit });
  assert.equal(verifier.inside('/owned', '/owned-copy/file'), false);
  assert.equal(verifier.inside('/owned', '/owned/../private'), false);
});
test('public receipt allowlists hashes and known measurements, excluding raw output and environment paths', () => {
  const receipt = verifier.sanitizedReceipt({ commit, archiveSha256: 'b'.repeat(64), archiveBytes: 400,
    status: 'pass', errorCode: 'private C:/users/example/token',
    checks: { providerReady: true, computerMcpTools: 6, stdout: 'secret-token', home: 'C:/private', configuration: {
      clients: 4, idempotent: true, path: 'C:/private-settings', token: 'secret-token' } } });
  assert.deepEqual(receipt.checks, { providerReady: true, computerMcpTools: 6, configuration: { clients: 4, idempotent: true } });
  assert.equal(receipt.errorCode, 'archive_verification_failed');
  assert.doesNotMatch(JSON.stringify(receipt), /secret-token|C:\/private|example/);
});

async function fixture(directory, options = {}) {
  const root = path.join(directory, 'repo'); await fs.mkdir(root);
  const npmCli = path.join(directory, 'npm-cli.js'); await fs.writeFile(npmCli, '// synthetic execution seam only');
  const calls = [];
  const run = async (executable, args, settings) => {
    calls.push({ executable, args, settings });
    if (args[0] === 'rev-parse') return { stdout: `${commit}\n` };
    if (args[0] === 'ls-tree') return { stdout: `${options.treeLink ? '120000' : '100644'} blob ${'b'.repeat(40)}\tpackage.json\0` };
    if (args[0] === 'archive') {
      const destination = args.find(value => value.startsWith('--output=')).slice(9);
      await fs.writeFile(destination, options.mismatch && destination.endsWith('reproduction.zip') ? 'different' : 'synthetic exact archive bytes');
      return { stdout: '', stderr: '' };
    }
    if (args.includes('-Destination')) {
      const extracted = path.join(args[args.indexOf('-Destination') + 1], 'trace-workbench'); await fs.mkdir(extracted, { recursive: true });
      for (const name of ['package.json', 'package-lock.json', 'bin/trace.cjs', 'scripts/setup-computer.cjs', 'src/computer/configuration.cjs']) {
        await fs.mkdir(path.dirname(path.join(extracted, name)), { recursive: true });
        await fs.writeFile(path.join(extracted, name), '{}\n');
      }
      if (options.dirtyExtraction) await fs.mkdir(path.join(extracted, '.runtime'));
      return { stdout: '', stderr: '' };
    }
    assert.ok(verifier.inside(root, settings.cwd));
    assert.ok(settings.env.HOME.endsWith('scratch-home'));
    assert.equal(settings.env.HOME, settings.env.USERPROFILE);
    assert.ok(verifier.inside(path.dirname(settings.env.HOME), settings.env.npm_config_cache));
    assert.ok(verifier.inside(settings.env.HOME, settings.env.npm_config_userconfig));
    assert.ok(verifier.inside(path.dirname(settings.env.HOME), settings.env.NUGET_PACKAGES));
    assert.ok(verifier.inside(path.dirname(settings.env.HOME), settings.env.NUGET_HTTP_CACHE_PATH));
    assert.equal(settings.env.DOTNET_GENERATE_ASPNET_CERTIFICATE, 'false');
    assert.equal(args.includes('recover'), false); assert.equal(args.includes('--report'), false);
    if (args[0] === npmCli) {
      assert.equal(args[1], 'ci');
      if (options.npmFails) throw Object.assign(new Error('private-secret-token'), { stdout: 'private-output', stderr: 'C:/private' });
      return { stdout: 'synthetic install', stderr: '' };
    }
    if (args[0] === 'scripts/setup-computer.cjs') return { stdout: JSON.stringify({ installed: true, integrity: 'verified',
      bridge: { built: true }, activityIndicator: { built: true }, supervisor: { built: true }, clipboard: { built: true, clipboardContentsRead: false, clipboardContentsChanged: false } }) };
    if (args[0] === 'bin/trace.cjs') return { stdout: JSON.stringify({ ready: !options.notReady, integrity: 'verified' }) };
    if (args[0] === 'scripts/smoke-computer-mcp.cjs') return { stdout: JSON.stringify({ result: 'pass', providerReady: true, toolCount: 6, desktopActions: 0, modelRequests: 0 }) };
    if (args[0] === 'scripts/smoke-mcp.cjs') return { stdout: JSON.stringify({ passed: true, toolCount: 207, target: { unchanged: true }, limits: { paidCalls: 0, modelClientTests: 0, executedTargetCode: false } }) };
    throw Error('Unexpected command');
  };
  const configurationCheck = async ({ extracted, home }) => {
    assert.equal(path.dirname(home), path.dirname(path.dirname(extracted)));
    assert.ok(verifier.inside(root, home));
    return { clients: 4, skillDestinations: 3, managedFilesPerBundle: 5, idempotent: true };
  };
  return { root, npmCli, calls, verify: (overrides = {}) => verifier.verify({ root, npmCli, commit, platform: 'win32', arch: 'x64', run, configurationCheck, ...overrides }) };
}
test('injected verification executes only extracted-source stages and confines all settings to its unique scratch home', async () => temporary(async directory => {
  const f = await fixture(directory), result = await f.verify();
  assert.equal(result.status, 'pass'); assert.equal(result.commit, commit); assert.equal(result.checks.providerReady, true);
  assert.equal(f.calls.filter(call => call.args[0] === 'archive').length, 2);
  const extract = f.calls.find(call => call.args.includes('-Destination'));
  assert.ok(extract.args.includes('-File')); assert.ok(!extract.args.includes('-Command'));
  const runs = await fs.readdir(path.join(f.root, '.runtime/archive-install')); assert.equal(runs.length, 1);
  const run = path.join(f.root, '.runtime/archive-install', runs[0]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run, 'receipt.json'), 'utf8')), result);
  assert.equal(result.privateArtifacts, `.runtime/archive-install/${runs[0]}`);
  assert.ok((await fs.readdir(path.join(run, 'logs'))).includes('npm_ci.stdout.log'));
}));
test('archive mismatch, dirty extraction, npm failure and unavailable provider stop downstream execution with sanitized receipts', async () => {
  for (const options of [{ treeLink: true }, { mismatch: true }, { dirtyExtraction: true }, { npmFails: true }, { notReady: true }]) await temporary(async directory => {
    const f = await fixture(directory, options), result = await f.verify();
    assert.equal(result.status, 'fail'); assert.doesNotMatch(JSON.stringify(result), /private-secret|private-output|C:\/private/);
    if (options.treeLink || options.mismatch || options.dirtyExtraction) assert.equal(f.calls.some(call => call.args[0] === f.npmCli), false);
    if (options.npmFails) assert.equal(f.calls.some(call => call.args[0] === 'scripts/setup-computer.cjs'), false);
    if (options.notReady) assert.equal(f.calls.some(call => call.args[0] === 'scripts/smoke-computer-mcp.cjs'), false);
  });
});
test('platform rejection performs no subprocess work; existing runtime links are rejected before writes through them', async t => temporary(async directory => {
  let called = false;
  await assert.rejects(verifier.verify({ platform: 'linux', arch: 'x64', run: async () => { called = true; } }), { code: 'archive_windows_x64_required' });
  assert.equal(called, false);
  const f = await fixture(directory), outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  try { await fs.symlink(outside, path.join(f.root, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host cannot create a synthetic directory link'); return; } throw error; }
  await assert.rejects(f.verify(), { code: 'archive_link_rejected' });
  assert.deepEqual(await fs.readdir(outside), []);
}));
test('a normal read-only npm runtime directory alias resolves to its real tool before verification', async t => temporary(async directory => {
  const f = await fixture(directory), alias = path.join(directory, 'tool-alias');
  try { await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host cannot create a synthetic runtime alias'); return; } throw error; }
  const result = await f.verify({ npmCli: path.join(alias, 'npm-cli.js') });
  assert.equal(result.status, 'pass');
  assert.equal(f.calls.find(call => call.args[1] === 'ci').args[0], await fs.realpath(f.npmCli));
}));
test('configuration verification uses the real installer only against a synthetic home and verifies exact rollback', async () => temporary(async directory => {
  const home = path.join(directory, 'scratch-home'); await fs.mkdir(home);
  const result = await verifier.verifyScratchConfiguration({ extracted: path.resolve(__dirname, '..'), home });
  assert.equal(result.clients, 4); assert.equal(result.managedFilesPerBundle, 5);
  assert.equal(result.exactOriginalBackups, true); assert.equal(result.exactConfigRollback, true);
  assert.equal(result.idempotent, true); assert.equal(result.conflictProducedNoWrites, true); assert.equal(result.personalSettingsModified, false);
}));
