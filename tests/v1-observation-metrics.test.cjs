'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createObservationMetrics, measure, count, providerRequest } = require('../src/computer/observation-metrics.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');

test('measure preserves values and errors, records inclusive spans and rejects unrecognized data', async () => {
  let now = 0;
  const metrics = createObservationMetrics({ sample: 'first-controller-attempt', clock: () => now });
  const error = new Error('secret-error');
  await metrics.run(async () => {
    assert.equal(measure('observation', () => { now++; return measure('backend', () => { now += 2; return 42; }); }), 42);
    assert.throws(() => measure('backend', () => { now++; throw error; }), e => e === error);
    await assert.rejects(measure('backend', async () => { now++; throw error; }), e => e === error);
    assert.equal(await measure('identity', async () => 'secret-result'), 'secret-result');
    measure('secret-label', () => 'secret-result');
    count('secret-label', 5); count('elements', -1); count('elements', Infinity); count('elements', 2);
    await providerRequest(true, async () => 1); providerRequest(false, () => 2);
  });
  const s = metrics.snapshot();
  assert.deepEqual(s.stages.observation, { calls: 1, failures: 0, durationMs: 3 });
  assert.deepEqual(s.stages.backend, { calls: 3, failures: 2, durationMs: 4 });
  assert.deepEqual(s.counts, { elements: 2, providerRequests: 2, supervisedRequests: 1, directRequests: 1 });
  assert.equal(s.version, 1); assert.equal(s.clock, 'process-monotonic');
  assert.deepEqual(s.unavailable, ['helperStartup', 'providerExecution', 'wireTransport', 'clientLatency', 'modelTime']);
  assert.doesNotMatch(JSON.stringify(s), /secret/);
});

test('concurrent metric contexts remain isolated and invalid timing samples are counted', async () => {
  let clock = 3;
  const a = createObservationMetrics({ sample: 'first-controller-attempt', clock: () => clock-- });
  const b = createObservationMetrics({ sample: 'later-controller-attempt', clock: () => 0 });
  await Promise.all([a.run(async () => { await Promise.resolve(); measure('identity', () => count('elements', 1)); }),
    b.run(async () => { count('elements', 4); await Promise.resolve(); measure('backend', () => count('base64', 8)); })]);
  assert.deepEqual(a.snapshot().counts, { elements: 1, invalidTimingSamples: 1 });
  assert.deepEqual(b.snapshot().counts, { elements: 4 });
  assert.deepEqual(b.snapshot().bytes, { base64: 8 });
  assert.equal(a.snapshot().stages.identity.durationMs, 0);
  assert.equal(a.snapshot().stages.backend, undefined);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=', 'base64');
const window = { id: '101', pid: 123, processName: 'fixture', title: 'secret-title', bounds: { x: 10, y: 20, width: 1, height: 1 } };
test('controller publishes observation metrics for first and action refresh captures', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-metrics-test-'));
  let tick = 0, wall = 1000;
  const indicator = { pid: 999, signal: new AbortController().signal, async start() { return { active: true, monitors: 1, protocol: 1 }; }, assertActive() {}, async stop() {} };
  const backend = { async listWindows() { return [window]; }, async observe({ screenshotPath }) {
    await fs.writeFile(screenshotPath, png); return { window, bounds: window.bounds, elements: [{ id: 'secret-element' }], screenshot: { path: screenshotPath } };
  }, async act() { return { performed: true }; } };
  const lease = { async acquire() {}, async assert() {}, async release() {} };
  const controller = createComputerController({ backend, indicator, lease, runtimeDirectory: directory, now: () => wall, metricsClock: () => tick++ });
  t.after(async () => { await controller.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await controller.listWindows(); const session = await controller.openSession({ windowId: window.id });
  const first = await controller.observe(session);
  assert.equal(first.observedAt, new Date(wall).toISOString());
  assert.equal(first.metrics.sample, 'first-controller-attempt');
  for (const phase of ['observation', 'identity', 'backend', 'fileStat', 'fileRead', 'hashEncode', 'journal']) assert.equal(first.metrics.stages[phase].calls, 1, phase);
  assert.equal(first.metrics.counts.elements, 1);
  assert.equal(first.metrics.bytes.controllerPngRead, png.length);
  assert.equal(first.metrics.bytes.base64, png.toString('base64').length);
  assert.doesNotMatch(JSON.stringify(first.metrics), /secret|iVBOR/);
  wall++;
  const result = await controller.act({ ...session, observationId: first.observationId, action: { type: 'activate' } });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.observation.observedAt, new Date(wall).toISOString());
  assert.equal(result.observation.metrics.sample, 'later-controller-attempt');
  assert.equal(result.observation.metrics.bytes.controllerPngRead, png.length);
});

test('backend observation records each synthetic provider call without leaking evidence', async t => {
  const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-metrics-backend-'));
  const screenshotPath = path.join(dir, 'private-frame.png');
  t.after(async () => { await fs.unlink(screenshotPath).catch(() => {}); await fs.rmdir(dir); });
  const calls = [];
  const rect = window.bounds;
  const root = { selector: 'private-root', name: 'private-title', type: 'Window', isEnabled: true, ...rect };
  const json = value => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', run: async (_executable, args) => {
    calls.push(args);
    if (args[0] === 'bounds') return json({ hwnd: window.id, pid: window.pid, frameBounds: rect, windowBounds: rect, minimized: false });
    if (args[1] === 'status') return json({ hwnd: Number(window.id), processId: window.pid, processName: window.processName, windowTitle: 'private-title', coordinateSpace: 'physical-screen-pixels' });
    if (args[1] === 'inspect') return json({ windows: [{ hwnd: Number(window.id), coordinateSpace: 'physical-screen-pixels', elements: [root] }] });
    if (args[1] === 'get-focused') return json({ hasFocus: false });
    if (args[1] === 'screenshot') {
      await fs.writeFile(screenshotPath, png);
      return json({ hwnd: Number(window.id), processId: window.pid, filePath: screenshotPath, width: 1, height: 1 });
    }
    assert.fail('unexpected provider call');
  } });
  const metrics = createObservationMetrics({ sample: 'first-controller-attempt' });
  await metrics.run(() => backend.observe({ window, screenshotPath }));
  const snapshot = metrics.snapshot();
  assert.equal(calls.length, 10);
  assert.equal(snapshot.counts.providerRequests, calls.length);
  assert.equal(snapshot.counts.directRequests, 10);
  assert.equal(snapshot.counts.captureRequests, 1);
  assert.equal(calls.filter(args => args[1] === 'screenshot').length, 1);
  for (const [stage, count] of Object.entries({ provider: 10, identity: 3, uia: 2, geometry: 3, capture: 1, backendPngRead: 1, pngHeader: 1, focus: 1 })) {
    assert.equal(snapshot.stages[stage].calls, count, stage);
  }
  assert.ok(png.length > 33);
  assert.equal(snapshot.bytes.backendPngRead, 33);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|iVBOR/);
});

test('MCP projection reports serialized byte counts without duplicating the image', async t => {
  const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
  const { createComputerServer } = require('../src/computer/server.cjs');
  let captures = 0;
  const data = png.toString('base64');
  const metrics = createObservationMetrics({ sample: 'first-controller-attempt' }).snapshot();
  const observation = { sessionId: 's', observationId: 'o', window, bounds: window.bounds, elements: [],
    screenshot: { data, mimeType: 'image/png', width: 1, height: 1 }, metrics };
  const controller = Object.fromEntries(['doctor', 'listWindows', 'openSession', 'act', 'closeSession', 'close'].map(name => [name, async () => ({})]));
  controller.observe = async () => { captures++; return observation; };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller }); await server.connect(serverTransport);
  const client = new Client({ name: 'metrics-projection-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'trace_computer_observe', arguments: { sessionId: 's' } });
  const projection = result._meta['trace/projection'];
  assert.equal(projection.version, 1); assert.equal(projection.clock, 'process-monotonic');
  assert.ok(Number.isFinite(projection.durationMs) && projection.durationMs >= 0);
  assert.equal(projection.jsonTextBytes, Buffer.byteLength(result.content[0].text));
  assert.equal(projection.imageBase64Bytes, Buffer.byteLength(data)); assert.equal(projection.imageCount, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.screenshot.contentIndex, 1);
  assert.deepEqual(result.content[1], { type: 'image', data, mimeType: 'image/png' });
  assert.deepEqual(result.structuredContent.metrics, metrics);
  assert.equal(captures, 1); assert.equal(observation.screenshot.data, data);
  assert.doesNotMatch(JSON.stringify(projection), /secret|iVBOR/);
});
