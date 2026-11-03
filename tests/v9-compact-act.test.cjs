'use strict';
// P0-3 and P0-4 (token cost incident): compact act results by default and an optional
// observation screenshot, measured against the incident's acceptance bars.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createComputerController, validateScreenshot, elementDiff } = require('../src/computer/controller.cjs');
const { downscalePng, decode, encode } = require('../src/computer/png-scale.cjs');
const { createActCompat, advertisesFullReturn } = require('../src/computer/act-compat.cjs');

// The incident's Firefox frame: 1436×1798 physical pixels.
const WIDTH = 1436, HEIGHT = 1798;
function syntheticPng(width = WIDTH, height = HEIGHT) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = (i / width) | 0;
    pixels.set([(x * 7) & 255, (y * 3) & 255, ((x ^ y) * 5) & 255, 255], i * 4);
  }
  return encode({ width, height, channels: 4, colorType: 6, pixels });
}
const PNG = syntheticPng();
const element = i => ({ id: `ctl-${i}`, name: `Toolbar control number ${i} with a label`, controlType: 'Button', enabled: true, offscreen: false,
  automationId: `auto-${i}`, bounds: { x: 10 + i, y: 20, width: 30, height: 20 }, secondaryActions: [], treeNodeId: `n${i}`, parentNodeId: i ? 'n0' : null });

async function connection(t, { elementsAfter, titleAfter } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-compact-act-'));
  const window = { id: '101', pid: 42, processName: 'synthetic-browser', title: 'Synthetic page' };
  const calls = { observe: [], act: 0 };
  let observations = 0;
  const backend = {
    doctor: async () => ({ ready: true }), listWindows: async () => [{ ...window }],
    observe: async ({ screenshotPath, includeScreenshot, depth }) => {
      calls.observe.push({ screenshotPath, includeScreenshot, depth });
      if (screenshotPath) await fs.writeFile(screenshotPath, PNG);
      const after = observations++ > 0 && calls.act > 0;
      const elements = after && elementsAfter ? elementsAfter() : Array.from({ length: 300 }, (_, i) => element(i));
      return { window: { ...window, title: after && titleAfter ? titleAfter : window.title }, bounds: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, elements, depth,
        focused: { available: true, hasFocus: true, elementId: 'ctl-5', name: 'Toolbar control number 5 with a label', controlType: 'Button', binding: 'observed-control' },
        targetState: { enabled: true, minimized: false, foreground: true, ownerWindowId: null, provenance: 'public-win32-dwm' },
        ...(screenshotPath ? { screenshot: { path: screenshotPath } } : {}) };
    },
    act: async () => { calls.act++; return { performed: true, type: 'press_key', engine: 'winapp', version: '0.7.1', preparation: [{ step: 'activation', status: 'foreground' }], native: { hwnd: 101 } }; },
  };
  const controller = createComputerController({ backend, runtimeDirectory: directory, observationTtlMs: 60000,
    lease: { acquire: async () => {}, assert: async () => {}, release: async () => {} },
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller }); await server.connect(serverTransport);
  const client = new Client({ name: 'trace-compact-act', version: '1.0.0' }); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name: `trace_computer_${name}`, arguments: args });
  await call('list_windows');
  const { sessionId } = (await call('open_session', { windowId: window.id })).structuredContent;
  return { call, sessionId, calls, controller };
}
const text = result => result.content.find(item => item.type === 'text').text;
const images = result => result.content.filter(item => item.type === 'image');
const pressEnter = { type: 'press_key', key: 'enter' };

test('P0-3 bar: the default press_key response is at most 1,500 chars with no image', async t => {
  const c = await connection(t);
  const observed = await c.call('observe', { sessionId: c.sessionId });
  assert.equal(images(observed).length, 1);
  const result = await c.call('act', { sessionId: c.sessionId, observationId: observed.structuredContent.observationId, action: pressEnter });
  assert.notEqual(result.isError, true);
  assert.equal(images(result).length, 0);
  assert.ok(text(result).length <= 1500, `${text(result).length} chars`);
  const value = result.structuredContent;
  assert.equal(value.outcome, 'completed'); assert.equal(value.verification, 'fresh_observation');
  assert.equal(value.observation, undefined); assert.equal(typeof value.observationId, 'string');
  assert.deepEqual(value.summary.focused, { hasFocus: true, elementId: 'ctl-5', name: 'Toolbar control number 5 with a label', controlType: 'Button', binding: 'observed-control' });
  assert.deepEqual(value.summary.changes, { counts: { added: 0, removed: 0, changed: 0 } });
  // The server-side refresh took no PNG.
  assert.equal(c.calls.observe.at(-1).includeScreenshot, false);
  // The same act with returnObservation full is the 1.x result: tens of thousands of chars plus a PNG.
  const full = await c.call('act', { sessionId: c.sessionId, observationId: value.observationId, action: pressEnter, returnObservation: 'full' });
  assert.equal(images(full).length, 1);
  assert.ok(text(full).length > 20 * text(result).length, `${text(full).length} vs ${text(result).length}`);
  t.diagnostic(`default press_key: ${text(result).length} chars, 0 images; returnObservation full: ${text(full).length} chars + ${images(full)[0].data.length} base64 image chars`);
});

test('the summary reports a bounded element diff and a changed title', async t => {
  const c = await connection(t, { titleAfter: 'Next page',
    elementsAfter: () => [...Array.from({ length: 290 }, (_, i) => i === 3 ? { ...element(3), name: 'Renamed', enabled: false } : element(i)), ...Array.from({ length: 20 }, (_, i) => element(1000 + i))] });
  const observed = (await c.call('observe', { sessionId: c.sessionId })).structuredContent;
  const { summary } = (await c.call('act', { sessionId: c.sessionId, observationId: observed.observationId, action: pressEnter })).structuredContent;
  assert.equal(summary.titleChanged, true); assert.equal(summary.title, 'Next page');
  assert.deepEqual(summary.changes.counts, { added: 20, removed: 10, changed: 1 });
  assert.equal(summary.changes.added.length, 15); assert.equal(summary.changes.truncated, true);
  assert.deepEqual(summary.changes.removed, Array.from({ length: 10 }, (_, i) => `ctl-${290 + i}`));
  assert.deepEqual(summary.changes.changed, [{ id: 'ctl-3', fields: ['name', 'enabled'], name: 'Renamed' }]);
  assert.equal(summary.elementCount, 310);
});

test('returnObservation none still authorizes exactly one further action; a full return keeps the image setting', async t => {
  const c = await connection(t);
  const observed = (await c.call('observe', { sessionId: c.sessionId })).structuredContent;
  const none = await c.call('act', { sessionId: c.sessionId, observationId: observed.observationId, action: pressEnter, returnObservation: 'none' });
  assert.deepEqual(Object.keys(none.structuredContent).sort(), ['actionId', 'observationId', 'outcome', 'verification']);
  const next = { sessionId: c.sessionId, observationId: none.structuredContent.observationId, action: pressEnter, returnObservation: 'full' };
  const full = await c.call('act', next);
  assert.equal(full.structuredContent.outcome, 'completed');
  // The preference came from the original full observation, not from the PNG-free refresh.
  assert.equal(images(full).length, 1);
  const stale = await c.call('act', next);
  assert.equal(stale.structuredContent.error.code, 'stale_observation'); assert.equal(stale.structuredContent.outcome, 'not_dispatched');
  assert.equal(c.calls.act, 2);
});

test('an invalid returnObservation is rejected without dispatch and without consuming the observation', async t => {
  const c = await connection(t);
  const observed = await c.controller.observe({ sessionId: c.sessionId });
  await assert.rejects(c.controller.act({ sessionId: c.sessionId, observationId: observed.observationId, action: pressEnter, returnObservation: 'brief' }),
    error => error.code === 'invalid_argument' && error.details.outcome === 'not_dispatched');
  const schema = await c.call('act', { sessionId: c.sessionId, observationId: observed.observationId, action: pressEnter, returnObservation: 'brief' });
  assert.equal(schema.isError, true);
  assert.equal((await c.controller.act({ sessionId: c.sessionId, observationId: observed.observationId, action: pressEnter })).outcome, 'completed');
  assert.equal(c.calls.act, 1);
});

test('P0-4 bar: a full observation with screenshot none returns 0 PNG bytes and still authorizes one action', async t => {
  const c = await connection(t);
  const observed = await c.call('observe', { sessionId: c.sessionId, screenshot: 'none' });
  assert.equal(images(observed).length, 0);
  assert.equal(observed.structuredContent.screenshot, undefined);
  assert.equal(observed.structuredContent.actionable, undefined);
  assert.equal(c.calls.observe.at(-1).includeScreenshot, false); assert.equal(c.calls.observe.at(-1).screenshotPath, undefined);
  const request = { sessionId: c.sessionId, observationId: observed.structuredContent.observationId, action: pressEnter };
  assert.equal((await c.call('act', request)).structuredContent.outcome, 'completed');
  assert.equal((await c.call('act', request)).structuredContent.error.code, 'stale_observation');
  assert.equal(c.calls.act, 1);
});

test('screenshot scaled sends a downscaled PNG with its factor; invalid mode pairs are rejected', async t => {
  const c = await connection(t);
  const full = await c.call('observe', { sessionId: c.sessionId });
  const scaled = await c.call('observe', { sessionId: c.sessionId, screenshot: 'scaled' });
  const meta = scaled.structuredContent.screenshot;
  assert.deepEqual(meta.scale, { factor: 2, sourceWidth: WIDTH, sourceHeight: HEIGHT });
  assert.equal(meta.width, 718); assert.equal(meta.height, 899);
  const image = decode(Buffer.from(images(scaled)[0].data, 'base64'));
  assert.equal(image.width, 718); assert.equal(image.height, 899);
  assert.ok(images(scaled)[0].data.length < images(full)[0].data.length / 3, `${images(scaled)[0].data.length} vs ${images(full)[0].data.length}`);
  // A scaled full observation stays actionable in window-local physical coordinates.
  const act = await c.call('act', { sessionId: c.sessionId, observationId: scaled.structuredContent.observationId, action: { type: 'click', x: 1400, y: 1700 } });
  assert.equal(act.structuredContent.outcome, 'completed');
  for (const args of [{ mode: 'accessibility', screenshot: 'scaled' }, { mode: 'screenshot', screenshot: 'none' }, { screenshot: 'tiny' }]) {
    assert.equal((await c.call('observe', { sessionId: c.sessionId, ...args })).isError, true, JSON.stringify(args));
  }
  assert.equal(validateScreenshot(undefined, 'accessibility'), 'none');
  assert.equal(validateScreenshot(undefined, 'full'), 'full');
  assert.throws(() => validateScreenshot('scaled', 'accessibility'), { code: 'invalid_observation' });
});

test('downscale averages boxes, keeps small images and reports unsupported formats', () => {
  const pixels = new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 0, 0, 0, 255]);
  const small = encode({ width: 2, height: 2, channels: 4, colorType: 6, pixels });
  assert.equal(downscalePng(small).factor, 1);
  const halved = downscalePng(small, 1);
  assert.equal(halved.factor, 2);
  assert.deepEqual([...decode(halved.data).pixels], [75, 75, 75, 255]);
  assert.deepEqual(downscalePng(Buffer.from('not a png')), { data: Buffer.from('not a png'), factor: 1, reason: 'unsupported_png_format' });
  assert.deepEqual(elementDiff([element(1)], [element(1)]), { counts: { added: 0, removed: 0, changed: 0 } });
});

test('doctor advertises the act result and screenshot options; compat requests full only when advertised', async t => {
  const c = await connection(t);
  const doctorResult = await c.call('doctor'); assert.notEqual(doctorResult.isError, true);
  const doctor = doctorResult.structuredContent;
  assert.deepEqual(doctor.actResult, { returnObservation: ['full', 'summary', 'none'], default: 'summary', diffLimit: 15 });
  assert.deepEqual(doctor.observationModes.screenshotModes, { values: ['none', 'scaled', 'full'], default: 'full', actionableWithout: true, scaledMaxEdge: 1280 });
  assert.equal(advertisesFullReturn(doctor), true);
  assert.equal(advertisesFullReturn({ ready: true }), false);
  const seen = [];
  const older = createActCompat().wrap(async (name, args) => { seen.push(args); return name === 'doctor' ? { ready: true } : {}; });
  await older('doctor', {}); await older('act', { observationId: 'a' });
  const newer = createActCompat().wrap(async (name, args) => { seen.push(args); return name === 'trace_computer_doctor' ? doctor : {}; });
  await newer('trace_computer_act', { observationId: 'b' });
  await newer('trace_computer_doctor', {}); await newer('trace_computer_act', { observationId: 'c' });
  await newer('trace_computer_act', { observationId: 'd', returnObservation: 'none' });
  assert.deepEqual(seen.filter(args => args.observationId), [{ observationId: 'a' }, { observationId: 'b' },
    { observationId: 'c', returnObservation: 'full' }, { observationId: 'd', returnObservation: 'none' }]);
});
