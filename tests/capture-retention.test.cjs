'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseCaptureKeepLast, createCaptureRetention } = require('../src/computer/capture-retention.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-retention-'));
  const files = [];
  t.after(async () => {
    for (const file of files) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(dir);
  });
  return { dir, async file() {
    const file = path.join(dir, `${randomUUID()}.png`);
    files.push(file); await fs.writeFile(file, 'capture'); return file;
  } };
}
async function exists(file) { return fs.stat(file).then(() => true, () => false); }

test('retention option is bounded and strict', () => {
  for (const [input, output] of [[undefined, 0], [0, 0], ['01', 1], [100, 100]]) assert.equal(parseCaptureKeepLast(input), output);
  for (const input of ['', ' 1', '1\n', '-1', '1.0', 1.5, 101, null, NaN]) {
    assert.throws(() => parseCaptureKeepLast(input), { code: 'invalid_capture_retention' });
  }
});

test('keeps newest and protected capture, closes tracked only', async t => {
  const { dir, file } = await fixture(t);
  const retention = createCaptureRetention(dir, 1);
  const a = await file(), b = await file(), c = await file(), unregistered = await file();
  await retention.remember(a);
  await retention.remember(b, process.platform === 'win32' ? a.toUpperCase() : a);
  assert.equal(await exists(a), true);
  const result = await retention.remember(c, a);
  assert.equal(result.removed, 1);
  assert.equal(await exists(b), false);
  assert.equal(await exists(a), true);
  assert.equal(await exists(c), true);
  assert.deepEqual(await retention.close(), { mode: 'keep-last', keepLast: 1, tracked: 0, removed: 2, status: 'applied', warnings: [] });
  assert.equal(await exists(unregistered), true);
});

test('changed capture is preserved and no longer tracked', async t => {
  const { dir, file } = await fixture(t);
  const retention = createCaptureRetention(dir, 1);
  const a = await file(), b = await file();
  await retention.remember(a);
  await fs.writeFile(a, 'replacement content');
  const result = await retention.remember(b);
  assert.deepEqual(result.warnings, ['capture_changed']);
  assert.equal(result.status, 'incomplete');
  assert.equal(await exists(a), true);
  assert.equal(result.tracked, 1);
  assert.deepEqual((await retention.remember(`${b}\n`)).warnings, ['invalid_capture_path']);
  assert.equal(await exists(b), true);
});

test('unlink failure is reported without losing tracked captures', async t => {
  const { dir, file } = await fixture(t);
  const retention = createCaptureRetention(dir, 1, { ...fs, unlink: async () => { throw new Error('private path'); } });
  const a = await file(), b = await file();
  await retention.remember(a);
  const result = await retention.remember(b);
  assert.deepEqual(result.warnings, ['io_failure']);
  assert.equal(result.tracked, 2);
  assert.equal(result.status, 'incomplete');
  assert.equal(await exists(a), true);
  assert.equal(JSON.stringify(result).includes(dir), false);
});

test('close bounds deletion attempts and refuses a changed runtime directory', async t => {
  const { dir, file } = await fixture(t);
  let changed = false;
  const retention = createCaptureRetention(dir, 100, { ...fs, realpath: async target =>
    changed && target === dir ? `${dir}-replacement` : fs.realpath(target) });
  for (let i = 0; i < 35; i++) await retention.remember(await file());
  changed = true;
  const blocked = await retention.close();
  assert.deepEqual(blocked.warnings, ['directory_changed']);
  assert.equal(blocked.removed, 0);
  changed = false;
  const bounded = await retention.close();
  assert.equal(bounded.removed, 32); assert.equal(bounded.tracked, 3);
  assert.deepEqual(bounded.warnings, ['pending']);
  assert.equal((await retention.close()).tracked, 0);
});
