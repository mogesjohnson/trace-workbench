'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { createObservationMetrics } = require('../src/computer/observation-metrics.cjs');

const rect = { x: 100, y: 200, width: 300, height: 400 };
const window = { id: '1234', pid: 456, processName: 'Fixture', processCreationTime: '1000', sessionId: 2 };
const png = Buffer.alloc(33);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(300, 16); png.writeUInt32BE(400, 20);

function fixture(screenshotPath, alter = () => {}) {
  const calls = [];
  const seen = {};
  const backend = new WinappBackend({ run: async (executable, args, options) => {
    const verb = args[0] === 'ui' ? args[1] : args[0];
    const number = seen[verb] = (seen[verb] || 0) + 1;
    calls.push({ verb, args, options });
    let value;
    if (verb === 'status') value = { hwnd: 1234, processId: 456, processName: 'Fixture', windowTitle: 'Fixture', coordinateSpace: 'physical-screen-pixels' };
    if (verb === 'identity' || verb === 'bounds') value = { hwnd: '1234', pid: 456, processCreationTime: '1000', sessionId: 2, ownerWindowId: '99', frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: true };
    if (verb === 'inspect') value = { windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [{ selector: 'root', name: 'Fixture', type: 'Window', isEnabled: true, ...rect }] }] };
    if (verb === 'screenshot') {
      await fs.writeFile(screenshotPath, png);
      value = { hwnd: 1234, processId: 456, filePath: screenshotPath, width: 300, height: 400 };
    }
    if (verb === 'get-focused') value = { hasFocus: false };
    assert.ok(value, `unexpected request ${args.join(' ')}`);
    alter(verb, number, value);
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
  } });
  return { backend, calls };
}

async function withFrame(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-adjacent-'));
  const frame = path.join(dir, 'frame.png');
  try { await fn(frame); }
  finally {
    assert.equal(path.dirname(path.resolve(frame)), path.resolve(dir));
    await fs.unlink(frame).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(dir);
  }
}

test('adjacent bounds supplies pinned identity once while independent checks bracket capture', async () => withFrame(async screenshotPath => {
  const { backend, calls } = fixture(screenshotPath);
  const signal = new AbortController().signal;
  const metrics = createObservationMetrics();
  const result = await metrics.run(() => backend.observe({ window, screenshotPath, signal }));
  assert.deepEqual(calls.map(call => call.verb), ['status', 'identity', 'bounds', 'inspect', 'bounds', 'status', 'screenshot', 'status', 'identity', 'inspect', 'bounds', 'get-focused']);
  assert.ok(calls.every(call => call.options.signal === signal));
  assert.equal(metrics.snapshot().counts.providerRequests, 12);
  assert.deepEqual(await fs.readFile(screenshotPath), png);
  assert.deepEqual(result.screenshot, { path: screenshotPath, mimeType: 'image/png', width: 300, height: 400 });
  assert.deepEqual(result.bounds, rect);
  assert.equal(result.targetState.ownerWindowId, '99');
}));

test('adjacent receipt and status fail closed before capture without identity fallback', async () => {
  const variants = [
    ['missing generation', (verb, n, v) => { if (verb === 'bounds' && n === 2) delete v.processCreationTime; }, 'window_identity_changed'],
    ['changed generation', (verb, n, v) => { if (verb === 'bounds' && n === 2) v.processCreationTime = '1001'; }, 'window_identity_changed'],
    ['missing session', (verb, n, v) => { if (verb === 'bounds' && n === 2) delete v.sessionId; }, 'window_identity_changed'],
    ['changed session', (verb, n, v) => { if (verb === 'bounds' && n === 2) v.sessionId = 3; }, 'window_identity_changed'],
    ['substituted hwnd', (verb, n, v) => { if (verb === 'bounds' && n === 2) v.hwnd = '999'; }, 'window_identity_changed'],
    ['substituted pid', (verb, n, v) => { if (verb === 'bounds' && n === 2) v.pid = 999; }, 'window_identity_changed'],
    ['changed name', (verb, n, v) => { if (verb === 'status' && n === 2) v.processName = 'Other'; }, 'window_identity_changed'],
    ['changed coordinates', (verb, n, v) => { if (verb === 'status' && n === 2) v.coordinateSpace = 'logical'; }, 'coordinate_space']
  ];
  for (const [name, alter, code] of variants) await test(name, async () => withFrame(async screenshotPath => {
    const { backend, calls } = fixture(screenshotPath, alter);
    await assert.rejects(backend.observe({ window, screenshotPath }), { code });
    assert.equal(calls.filter(call => call.verb === 'identity').length, 1);
    assert.ok(!calls.some(call => call.verb === 'screenshot'));
  }));
});

test('post-capture independent identity and geometry still reject changes', async () => {
  for (const [name, alter, code] of [
    ['generation', (verb, n, v) => { if (verb === 'identity' && n === 2) v.processCreationTime = '1001'; }, 'window_identity_changed'],
    ['geometry', (verb, n, v) => { if (verb === 'bounds' && n === 3) v.frameBounds.x++; }, 'window_moved']
  ]) await test(name, async () => withFrame(async screenshotPath => {
    const { backend, calls } = fixture(screenshotPath, alter);
    await assert.rejects(backend.observe({ window, screenshotPath }), { code });
    assert.ok(calls.some(call => call.verb === 'screenshot'));
  }));
});
