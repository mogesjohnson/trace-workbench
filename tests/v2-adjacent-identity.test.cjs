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
    const identity = { hwnd: '1234', pid: 456, processCreationTime: '1000', sessionId: 2, ownerWindowId: '99', title: 'Fixture title', method: 'public-win32-identity' };
    if (verb === 'identity') value = identity;
    if (verb === 'related') {
      const related = { hwnd: window.id, pid: window.pid, method: 'public-win32-related', windows: [], truncated: false,
        menuMode: { available: false }, coverage: { ownerChain: true, threadMenu: false, sameThreadPopups: true, otherThreadsAndProcesses: false } };
      value = args[3] === '--with-identity'
        ? { hwnd: window.id, pid: window.pid, method: 'public-win32-related-identity', related, relatedError: null, identity, identityDeferred: false }
        : related;
    }
    if (verb === 'bounds' || verb === 'activate') value = { hwnd: '1234', pid: 456, processCreationTime: '1000', sessionId: 2, ownerWindowId: '99', frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: true };
    if (verb === 'inspect') value = { windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [{ selector: 'root', name: 'Fixture', type: 'Window', isEnabled: true, ...rect }] }] };
    if (verb === 'screenshot') {
      await fs.writeFile(screenshotPath, png);
      value = { hwnd: 1234, processId: 456, filePath: screenshotPath, width: 300, height: 400 };
    }
    if (verb === 'get-focused') value = { hasFocus: false };
    if (verb === 'invoke') value = { hwnd: 1234 };
    assert.ok(value, `unexpected request ${args.join(' ')}`);
    const envelopeFields = alter(verb, number, value);
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0, ...envelopeFields };
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

function supervisedFixture(alter) {
  const mock = fixture(undefined, alter);
  mock.backend.supervisor = { ready: true, assertActive() {}, run: mock.backend.run };
  return mock;
}

const noImage = { window, includeScreenshot: false, related: true };
const prelude = ['bounds', 'inspect', 'bounds', 'related'];

test('combined related and final identity use one supervised request before final UIA and bounds', async () => {
  const { backend, calls } = supervisedFixture();
  const signal = new AbortController().signal;
  const metrics = createObservationMetrics();
  const result = await metrics.run(() => backend.observe({ ...noImage, signal, window: { ...window, title: 'Earlier title' } }));
  assert.deepEqual(calls.map(call => call.verb), [...prelude, 'inspect', 'bounds', 'get-focused']);
  assert.deepEqual(calls[3].args, ['related', window.id, String(window.pid), '--with-identity']);
  assert.equal(calls[3].options.mutating, false);
  assert.ok(calls.every(call => call.options.signal === signal));
  assert.equal(metrics.snapshot().counts.providerRequests, 7);
  assert.equal(metrics.snapshot().counts.supervisedRequests, 7);
  assert.equal(result.window.title, 'Fixture title');
  assert.deepEqual(result.relatedWindows.windows, []);
  assert.equal(result.relatedWindows.coverage.otherThreadsAndProcesses, false);
});

test('combined malformed or recoverably failed related evidence stays unavailable with a fresh identity', async () => {
  for (const code of ['invalid_native_response', 'window_closed']) {
    const { backend, calls } = supervisedFixture((verb, _, value) => {
      if (verb !== 'related') return;
      if (code === 'window_closed') Object.assign(value, { related: null, relatedError: code });
      else value.related.truncated = 'malformed';
    });
    const result = await backend.observe(noImage);
    assert.deepEqual(result.relatedWindows, { available: false, code });
    assert.equal(result.window.title, 'Fixture title');
    assert.deepEqual(calls.map(call => call.verb), [...prelude, 'inspect', 'bounds', 'get-focused']);
  }
});

test('combined identity disagreement or missing final caption fails before subsequent reads', async () => {
  const cases = [
    ...receiptChanges.map(([name, alter]) => [value => alter(value.identity),
      name.startsWith('missing') ? 'invalid_native_response' : 'window_identity_changed']),
    [value => { value.identity = null; }, 'invalid_native_response'],
    [value => { delete value.identity.title; }, 'invalid_native_response'],
    [value => { value.related.pid++; }, 'window_identity_changed'],
  ];
  for (const [alter, code] of cases) {
    const { backend, calls } = supervisedFixture((verb, _, value) => { if (verb === 'related') alter(value); });
    await assert.rejects(backend.observe(noImage), { code });
    assert.deepEqual(calls.map(call => call.verb), prelude);
  }
});

test('combined cancellation and uncertain cleanup fail closed without an identity fallback', async () => {
  const abort = new AbortController();
  const cancelled = supervisedFixture(verb => { if (verb === 'related') abort.abort(); });
  await assert.rejects(cancelled.backend.observe({ ...noImage, signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(cancelled.calls.map(call => call.verb), prelude);

  const uncertain = supervisedFixture(verb => verb === 'related' ? { recovery: { reason: 'process_exit_unconfirmed' } } : undefined);
  await assert.rejects(uncertain.backend.observe(noImage), { code: 'input_recovery_required' });
  assert.deepEqual(uncertain.calls.map(call => call.verb), prelude);

  const timedOut = supervisedFixture(verb => {
    if (verb === 'related') throw Object.assign(new Error('Unconfirmed read timeout'), { code: 'native_timeout' });
  });
  await assert.rejects(timedOut.backend.observe(noImage), { code: 'native_timeout' });
  assert.deepEqual(timedOut.calls.map(call => call.verb), prelude);
});

test('a combined read with a pending UIA task requires a separate fresh identity after job completion', async () => {
  const { backend, calls } = supervisedFixture((verb, _, value) => {
    if (verb === 'related') Object.assign(value, { identityDeferred: true, identity: null });
  });
  const result = await backend.observe(noImage);
  assert.equal(result.window.title, 'Fixture title');
  assert.deepEqual(calls.map(call => call.verb), [...prelude, 'identity', 'inspect', 'bounds', 'get-focused']);
});

test('related image and document work keep their separate ordering before final identity', async () => {
  const { backend, calls } = supervisedFixture();
  backend.readDocument = async () => { calls.push({ verb: 'document' }); return { available: true }; };
  const prefix = path.resolve('related-image-prefix');
  // No popups in the fake receipt, so no image file is created.
  await backend.observe({ ...noImage, relatedImagePrefix: prefix, documentElementId: 'root' });
  assert.deepEqual(calls.map(call => call.verb), [...prelude, 'document', 'identity', 'inspect', 'bounds', 'get-focused']);
  assert.deepEqual(calls[3].args, ['related', window.id, String(window.pid), prefix]);
});
