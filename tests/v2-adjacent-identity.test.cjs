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
    if (verb === 'identity') value = { hwnd: '1234', pid: 456, processCreationTime: '1000', sessionId: 2, ownerWindowId: '99', title: 'Fixture title' };
    if (verb === 'bounds' || verb === 'activate') value = { hwnd: '1234', pid: 456, processCreationTime: '1000', sessionId: 2, ownerWindowId: '99', frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: true };
    if (verb === 'inspect') value = { windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [{ selector: 'root', name: 'Fixture', type: 'Window', isEnabled: true, ...rect }] }] };
    if (verb === 'screenshot') {
      await fs.writeFile(screenshotPath, png);
      value = { hwnd: 1234, processId: 456, filePath: screenshotPath, width: 300, height: 400 };
    }
    if (verb === 'get-focused') value = { hasFocus: false };
    if (verb === 'invoke') value = { hwnd: 1234 };
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

const receiptChanges = [
  ['missing generation', v => { delete v.processCreationTime; }],
  ['changed generation', v => { v.processCreationTime = '1001'; }],
  ['missing session', v => { delete v.sessionId; }],
  ['changed session', v => { v.sessionId = 3; }],
  ['substituted hwnd', v => { v.hwnd = '999'; }],
  ['substituted pid', v => { v.pid = 999; }]
];

test('observe reuses its bounds receipts for identity and runs one guard after capture', async () => withFrame(async screenshotPath => {
  const { backend, calls } = fixture(screenshotPath);
  const signal = new AbortController().signal;
  const metrics = createObservationMetrics();
  const result = await metrics.run(() => backend.observe({ window, screenshotPath, signal }));
  assert.deepEqual(calls.map(call => call.verb), ['bounds', 'inspect', 'bounds', 'screenshot', 'identity', 'inspect', 'bounds', 'get-focused']);
  assert.ok(calls.every(call => call.options.signal === signal));
  assert.equal(metrics.snapshot().counts.providerRequests, 8);
  assert.equal(result.window.title, 'Fixture title');
  assert.deepEqual(result.screenshot, { path: screenshotPath, mimeType: 'image/png', width: 300, height: 400 });
  assert.deepEqual(result.bounds, rect);
  assert.equal(result.targetState.ownerWindowId, '99');
}));

test('opening and pre-capture bounds receipts fail closed before capture without a fallback read', async () => {
  for (const n of [1, 2]) for (const [name, alter] of receiptChanges) await test(`bounds ${n}: ${name}`, async () => withFrame(async screenshotPath => {
    const { backend, calls } = fixture(screenshotPath, (verb, number, value) => { if (verb === 'bounds' && number === n) alter(value); });
    await assert.rejects(backend.observe({ window, screenshotPath }), { code: 'window_identity_changed' });
    assert.equal(calls.filter(call => call.verb === 'bounds').length, n);
    assert.ok(!calls.some(call => call.verb === 'identity' || call.verb === 'screenshot'));
  }));
});

test('post-capture guard and geometry still reject changes', async () => {
  for (const [name, alter, code] of [
    ['generation', (verb, n, v) => { if (verb === 'identity' && n === 1) v.processCreationTime = '1001'; }, 'window_identity_changed'],
    ['geometry', (verb, n, v) => { if (verb === 'bounds' && n === 3) v.frameBounds.x++; }, 'window_moved']
  ]) await test(name, async () => withFrame(async screenshotPath => {
    const { backend, calls } = fixture(screenshotPath, alter);
    await assert.rejects(backend.observe({ window, screenshotPath }), { code });
    assert.ok(calls.some(call => call.verb === 'screenshot'));
  }));
});

test('a window without a pinned generation keeps the engine status name check, the first before bounds', async () => {
  const unpinned = { id: window.id, pid: window.pid, processName: window.processName };
  await withFrame(async screenshotPath => {
    const { backend, calls } = fixture(screenshotPath);
    await backend.observe({ window: unpinned, screenshotPath });
    assert.deepEqual(calls.map(call => call.verb), ['status', 'bounds', 'inspect', 'bounds', 'status', 'screenshot', 'status', 'inspect', 'bounds', 'get-focused']);
  });
  await withFrame(async screenshotPath => {
    const { backend, calls } = fixture(screenshotPath, (verb, n, v) => { if (verb === 'status') v.processName = 'Other'; });
    await assert.rejects(backend.observe({ window: unpinned, screenshotPath }), { code: 'window_identity_changed' });
    assert.deepEqual(calls.map(call => call.verb), ['status']);
  });
});

test('initial bounds failure or cancellation is not retried', async () => {
  for (const code of ['bounds_failed', 'ABORT_ERR']) await test(code, async () => withFrame(async screenshotPath => {
    const controller = new AbortController();
    const { backend, calls } = fixture(screenshotPath, (verb, n) => {
      if (verb === 'bounds' && n === 1) {
        if (code === 'ABORT_ERR') controller.abort();
        throw Object.assign(new Error(code), { code });
      }
    });
    await assert.rejects(backend.observe({ window, screenshotPath, signal: controller.signal }), { code });
    assert.deepEqual(calls.map(call => call.verb), ['bounds']);
  }));
});

test('initial bounds accepts synchronous injected bridge receipts', async () => withFrame(async screenshotPath => {
  const { backend } = fixture(screenshotPath);
  backend.bridge = () => ({ hwnd: window.id, pid: window.pid,
    processCreationTime: window.processCreationTime, sessionId: window.sessionId,
    frameBounds: rect, windowBounds: rect, minimized: false, enabled: true });
  const result = await backend.observe({ window, screenshotPath });
  assert.deepEqual(result.bounds, rect);
  assert.deepEqual(await fs.readFile(screenshotPath), png);
}));

const observed = screenshotPath => fixture(screenshotPath).backend.observe({ window, screenshotPath });
const invoke = { type: 'invoke', elementId: 'root' };

test('dispatch proves identity from its bounds receipt and keeps the guard just before input', async () => withFrame(async screenshotPath => {
  const observation = await observed(screenshotPath);
  const { backend, calls } = fixture(screenshotPath);
  assert.equal((await backend.act({ window, observation, action: invoke })).performed, true);
  assert.deepEqual(calls.map(call => call.verb), ['inspect', 'bounds', 'identity', 'activate', 'invoke']);
}));

test('a changed dispatch bounds receipt or pre-input guard stops before input', async () => {
  for (const verb of ['bounds', 'identity']) for (const [name, alter] of receiptChanges) await test(`${verb}: ${name}`, async () => withFrame(async screenshotPath => {
    const observation = await observed(screenshotPath);
    const { backend, calls } = fixture(screenshotPath, (called, n, value) => { if (called === verb && n === 1) alter(value); });
    await assert.rejects(backend.act({ window, observation, action: invoke }),
      error => error.code === 'window_identity_changed' && error.details.outcome === 'not_dispatched');
    assert.ok(!calls.some(call => call.verb === 'activate' || call.verb === 'invoke'));
  }));
});
