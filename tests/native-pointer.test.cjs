'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');

test('compiled pointer planning and supervisor declaration/release checks send no input', {
  skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 180000
}, async t => {
  let sdks;
  try { sdks = await execute('dotnet', ['--list-sdks'], { windowsHide: true, timeout: 15000 }); }
  catch { t.skip('.NET 9 SDK unavailable; native contract checks not run.'); return; }
  if (!/^9\./m.test(sdks.stdout)) { t.skip('.NET 9 SDK unavailable; native contract checks not run.'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-pointer-contract-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('trace-pointer-contract-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const feed = path.join(directory, 'empty-feed'); await fs.mkdir(feed);
  for (const name of ['TraceWindowBridge', 'TraceSupervisor']) {
    const output = path.join(directory, name);
    await execute('dotnet', ['publish', path.join(root, 'native', name, `${name}.csproj`), '--configuration', 'Release',
      '--output', output, '--artifacts-path', path.join(output, 'artifacts'), '--source', feed, '--nologo'],
    { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 });
    const result = await execute(path.join(output, `${name}.exe`), ['selftest'], { windowsHide: true, timeout: 15000 });
    const value = JSON.parse(result.stdout);
    assert.equal(value.passed, true);
    if (name === 'TraceWindowBridge') assert.equal(value.inputSent, false);
  }
});
