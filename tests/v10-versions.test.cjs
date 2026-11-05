'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');
const { createComputerController } = require('../src/computer/controller.cjs');
const { actionSupport, compactSupport } = require('../src/computer/action-contract.cjs');

test('item 20: doctor reports versions and deprecations outside the support descriptor', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-v10-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = createComputerController({ runtimeDirectory: directory,
    backend: { async doctor() { return { ready: true, version: '0.7.1', bridge: { version: 1 } }; } } });
  t.after(() => controller.close());
  const result = await controller.doctor();
  assert.deepEqual(result.versions, { package: version, contract: 1, engine: '0.7.1', bridge: 1, supervisor: 1, skillBundle: 'trace.skill-bundle/1' });
  assert.deepEqual(result.deprecations, []);
  assert.deepEqual(result.support, compactSupport());
  assert.equal(Object.hasOwn(actionSupport(), 'versions'), false);
});

test('item 20: doctor reports null for a version it could not read', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-v10-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = createComputerController({ runtimeDirectory: directory,
    backend: { async doctor() { return { ready: false, code: 'bridge_unavailable' }; } } });
  t.after(() => controller.close());
  const { versions } = await controller.doctor();
  assert.equal(versions.engine, null);
  assert.equal(versions.bridge, null);
});

test('item 20: --version prints only the package version', () => {
  const bin = path.join(__dirname, '..', 'bin', 'trace.cjs');
  const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${version}\n`);
});
