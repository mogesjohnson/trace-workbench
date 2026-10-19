'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildActivityIndicator } = require('../scripts/setup-computer.cjs');
const { SOURCES, OUTPUTS, verifyIndicatorFiles } = require('../src/computer/activity-indicator.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-indicator-setup-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('trace-indicator-setup-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  for (const name of SOURCES) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), `synthetic source ${name}`); }
  const binaryPath = path.join(root, 'build', 'bin', OUTPUTS[0]);
  return { root, binaryPath, manifestPath: path.join(root, 'build', 'manifest.json') };
}

test('helper setup uses only an empty local feed and writes verified source/output hashes', async t => {
  const { root, binaryPath } = await fixture(t);
  let calls = 0;
  const result = await buildActivityIndicator({ root, binaryPath, run: async (executable, args, options) => {
    calls++;
    assert.equal(executable, 'dotnet');
    assert.equal(args[0], 'publish');
    assert.equal(args[1], path.join(root, SOURCES[1]));
    assert.equal(options.timeoutMs, 120000);
    const feed = args[args.indexOf('--source') + 1];
    assert.equal(feed, path.join(root, 'build', 'empty-package-feed'));
    assert.deepEqual(await fs.readdir(feed), []);
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    for (const name of OUTPUTS) await fs.writeFile(path.join(path.dirname(binaryPath), name), `synthetic output ${name}`);
    return { exitCode: 0 };
  } });
  assert.equal(calls, 1);
  assert.equal(result.packageDownloads, false);
  assert.deepEqual(await verifyIndicatorFiles(binaryPath, root), { available: true, integrity: 'verified', protocol: 1 });
});

test('a failed helper build preserves the previous manifest and reports the missing prerequisite', async t => {
  const { root, binaryPath, manifestPath } = await fixture(t);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const prior = '{"prior":"must remain"}\n';
  await fs.writeFile(manifestPath, prior);
  await assert.rejects(buildActivityIndicator({ root, binaryPath, run: async () => ({ exitCode: 1 }) }), /\.NET 9 SDK with Windows Desktop reference pack/);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), prior);
});

test('source drift during helper build cannot publish a successful manifest', async t => {
  const { root, binaryPath, manifestPath } = await fixture(t);
  await assert.rejects(buildActivityIndicator({ root, binaryPath, run: async () => {
    await fs.appendFile(path.join(root, SOURCES[0]), ' changed during build');
    return { exitCode: 0 };
  } }), /source changed during the build/);
  await assert.rejects(fs.access(manifestPath), { code: 'ENOENT' });
});
