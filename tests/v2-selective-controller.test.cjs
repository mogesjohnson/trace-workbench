'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createComputerController } = require('../src/computer/controller.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=', 'base64');
const window = { id: '101', pid: 123, processName: 'fixture', bounds: { x: 0, y: 0, width: 1, height: 1 } };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-selective-'));
  const calls = [], control = { fail: false, leaseFail: false, acts: 0 };
  const backend = { async listWindows() { return [window]; }, async observe(request) {
    calls.push(request);
    if (control.fail) throw Object.assign(new Error('capture failed'), { code: 'capture_failed' });
    const result = { window, bounds: window.bounds, elements: [{ id: 'button', enabled: true }], depth: request.depth,
      focused: { available: true }, targetState: { enabled: true }, captureMethod: 'test' };
    if (request.includeScreenshot !== false) {
      await fs.writeFile(request.screenshotPath, png); result.screenshot = { path: request.screenshotPath };
    }
    return result;
  }, async act() { control.acts++; return { performed: true }; } };
  const indicator = { signal: new AbortController().signal, async start() { return {}; }, assertActive() {}, async stop() {} };
  const lease = { async acquire() {}, async assert() { if (control.leaseFail) throw new Error('lease failed'); }, async release() {} };
  const controller = createComputerController({ backend, indicator, lease, runtimeDirectory: directory });
  t.after(async () => {
    await controller.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('trace-selective-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await controller.listWindows();
  const session = await controller.openSession({ windowId: window.id });
  return { controller, session, calls, control, directory };
}

const stale = error => error.code === 'stale_observation' && error.details?.outcome === 'not_dispatched';
const activate = { type: 'activate' };

test('selective observations expose only requested evidence and never authorize input', async t => {
  const f = await fixture(t), { controller: c, session } = f;
  const full = await c.observe({ ...session, accessibilityDepth: 12 });
  assert.ok(full.screenshot && full.elements && full.accessibility);
  assert.equal(Object.hasOwn(full, 'mode'), false);
  const sessionDirectory = path.join(f.directory, 'sessions', session.sessionId);
  const filesBefore = await fs.readdir(sessionDirectory);
  const a11y = await c.observe({ ...session, mode: 'accessibility', accessibilityDepth: 12 });
  assert.notEqual(a11y.observationId, full.observationId);
  assert.equal(a11y.mode, 'accessibility'); assert.equal(a11y.actionable, false);
  assert.equal(a11y.accessibility.depth, 12); assert.equal(a11y.elements[0].id, 'button');
  for (const field of ['screenshot', 'captureMethod', 'coordinateSpace']) assert.equal(Object.hasOwn(a11y, field), false);
  assert.equal(f.calls.at(-1).includeScreenshot, false);
  assert.deepEqual(await fs.readdir(sessionDirectory), filesBefore);
  assert.equal(a11y.metrics.stages.fileRead, undefined); assert.equal(a11y.metrics.stages.hashEncode, undefined);
  const image = await c.observe({ ...session, mode: 'screenshot', accessibilityDepth: 12 });
  assert.equal(image.mode, 'screenshot'); assert.equal(image.actionable, false); assert.ok(image.screenshot);
  assert.equal(Object.hasOwn(image, 'elements'), false); assert.equal(Object.hasOwn(image, 'accessibility'), false);
  assert.equal(f.calls.at(-1).depth, 12);
  for (const observationId of [full.observationId, a11y.observationId, image.observationId]) {
    for (const action of [activate, { type: 'click', x: 0, y: 0 }, { type: 'invoke', elementId: 'button' }])
      await assert.rejects(c.act({ ...session, observationId, action }), stale);
  }
  assert.equal(f.control.acts, 0);
  const journal = (await fs.readFile(path.join(f.directory, 'sessions', session.sessionId, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const entry = journal.find(e => e.observationId === a11y.observationId);
  assert.equal(entry.mode, 'accessibility'); assert.equal(Object.hasOwn(entry, 'screenshotSha256'), false);
});

test('failed selective capture invalidates authority; invalid arguments preserve it and full refresh retains depth', async t => {
  const f = await fixture(t), { controller: c, session } = f;
  let full = await c.observe({ ...session, accessibilityDepth: 12 });
  await assert.rejects(c.observe({ ...session, mode: 'invalid' }));
  await assert.rejects(c.observe({ ...session, mode: 'accessibility', accessibilityDepth: 0 }));
  assert.equal((await c.act({ ...session, observationId: full.observationId, action: activate })).outcome, 'completed');
  full = await c.observe({ ...session, accessibilityDepth: 12 });
  f.control.fail = true;
  await assert.rejects(c.observe({ ...session, mode: 'accessibility' }), { code: 'capture_failed' });
  await assert.rejects(c.act({ ...session, observationId: full.observationId, action: activate }), stale);
  f.control.fail = false;
  full = await c.observe({ ...session, accessibilityDepth: 12 });
  const backendCalls = f.calls.length;
  f.control.leaseFail = true;
  await assert.rejects(c.observe({ ...session, mode: 'screenshot' }), /lease failed/);
  assert.equal(f.calls.length, backendCalls);
  f.control.leaseFail = false;
  await assert.rejects(c.act({ ...session, observationId: full.observationId, action: activate }), stale);
  full = await c.observe({ ...session, accessibilityDepth: 12 });
  const result = await c.act({ ...session, observationId: full.observationId, action: activate });
  assert.equal(result.outcome, 'completed'); assert.ok(result.observation.screenshot);
  assert.equal(result.observation.accessibility.depth, 12); assert.equal(f.calls.at(-1).depth, 12);
});
