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
