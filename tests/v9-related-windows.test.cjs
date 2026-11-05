'use strict';
// R21: menus, tooltips and owned popups above the session window are reported as context with
// origin, size, z-order, owner relation and unavailable states. They never authorize input.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { createComputerServer } = require('../src/computer/server.cjs');
const { encode } = require('../src/computer/png-scale.cjs');

const window = { id: '330198', pid: 28836, processName: 'fixture', title: 'Fixture' };
const rootBounds = { x: 1189, y: 740, width: 502, height: 311 };
const png = (width, height) => encode({ width, height, channels: 4, colorType: 6, pixels: new Uint8Array(width * height * 4).map((_, i) => (i * 37) & 255) });
// Shapes recorded in the live inventory of 5 November 2026 (V9_ITEM19_INVENTORY.md).
const nativeEntry = (index, overrides = {}) => ({ hwnd: String(264660 + index), pid: 28836, relation: 'owned', kind: 'menu',
  className: 'WindowsForms10.Window.20808.app.0.1', title: null, zOrder: index, bounds: { x: 1241, y: 873, width: 200, height: 100 },
  boundsSource: 'dwm-frame', dpi: 144, dpiAwareness: 'per-monitor', topmost: true,
  uia: { available: true, controlType: 'ControlType.Menu', name: '' }, image: null, ...overrides });
const nativeList = windows => ({ hwnd: window.id, pid: window.pid, method: 'public-win32-related',
  menuMode: { available: true, active: false }, coverage: { ownerChain: true, threadMenu: true, sameThreadPopups: true, otherThreadsAndProcesses: false },
  truncated: false, windows });

function bridgeBackend(reply) {
  const calls = [];
  const backend = new WinappBackend({ supervisor: null, run: async (_exe, args) => {
    calls.push(args);
    const value = await reply(args);
    return value instanceof Error ? { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code: value.code, message: value.message } }) }
      : { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
  } });
  return { backend, calls };
}

test('the backend checks the native list and keeps relation, z-order, bounds and DPI', async () => {
  const { backend, calls } = bridgeBackend(() => nativeList([nativeEntry(0),
    nativeEntry(1, { hwnd: '2492002', relation: 'same-thread-popup', kind: 'tooltip', className: 'WindowsForms10.tooltips_class32.app.0.1',
      bounds: { x: 1251, y: 795, width: 180, height: 30 }, uia: { available: false, code: 'uia_timeout' } })]));
  const related = await backend.relatedWindows(window);
  assert.deepEqual(calls, [['related', window.id, String(window.pid)]]);
  assert.equal(related.available, true);
  assert.deepEqual(related.windows.map(item => [item.windowId, item.relation, item.kind, item.zOrder]),
    [['264660', 'owned', 'menu', 0], ['2492002', 'same-thread-popup', 'tooltip', 1]]);
  assert.deepEqual(related.windows[1].uia, { available: false, code: 'uia_timeout' });
  assert.equal(related.windows[0].dpi, 144); assert.equal(Object.hasOwn(related.windows[0], 'image'), false);
  assert.equal(related.coverage.otherThreadsAndProcesses, false);
});

test('a malformed or failed native read makes the list unavailable, never partly trusted', async () => {
  const bad = [
    nativeList([nativeEntry(1)]), // z-order out of sequence
    nativeList([nativeEntry(0, { relation: 'nearby' })]),
    nativeList([nativeEntry(0, { bounds: { x: 0, y: 0, width: 0, height: 5 } })]),
    nativeList([nativeEntry(0, { image: { available: true, filePath: 'C:/elsewhere.png', width: 1, height: 1 } })]),
    nativeList(Array.from({ length: 17 }, (_, i) => nativeEntry(i))),
    { ...nativeList([]), method: 'screen-scrape' },
  ];
  for (const reply of bad) {
    const { backend } = bridgeBackend(() => reply);
    assert.deepEqual(await backend.relatedWindows(window), { available: false, code: 'invalid_native_response' });
  }
  const { backend } = bridgeBackend(() => Object.assign(new Error('gone'), { code: 'window_closed' }));
  assert.deepEqual(await backend.relatedWindows(window), { available: false, code: 'window_closed' });
});

test('a cancelled related read still cancels the observation', async () => {
  const controller = new AbortController(); controller.abort();
  const { backend } = bridgeBackend(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }); });
  await assert.rejects(backend.relatedWindows(window, controller.signal));
});

test('image paths must be the requested prefix and an image failure stays per window', async () => {
  const prefix = path.join(os.tmpdir(), 'obs-related');
  const { backend, calls } = bridgeBackend(() => nativeList([
    nativeEntry(0, { image: { available: true, filePath: `${prefix}-0.png`, width: 200, height: 100 } }),
    nativeEntry(1, { image: { available: false, code: 'capture_blank' } })]));
  const related = await backend.relatedWindows(window, undefined, prefix);
  assert.deepEqual(calls[0], ['related', window.id, String(window.pid), prefix]);
  assert.deepEqual(related.windows.map(item => item.image.available), [true, false]);
  assert.equal(related.windows[1].image.code, 'capture_blank');
  await assert.rejects(backend.relatedWindows(window, undefined, `${prefix}.png`), { code: 'invalid_observation' });
});

async function connection(t, relatedFor) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-related-'));
  const calls = { observe: [], act: [] };
  const backend = {
    doctor: async () => ({ ready: true }), listWindows: async () => [{ ...window }],
    observe: async options => {
      calls.observe.push(options);
      if (options.screenshotPath) await fs.writeFile(options.screenshotPath, png(rootBounds.width, rootBounds.height));
      const relatedWindows = options.related ? await relatedFor(options) : undefined;
      return { window: { ...window, bounds: rootBounds }, bounds: rootBounds, depth: options.depth,
        elements: [{ id: 'target', name: 'Target', controlType: 'Button', enabled: true, offscreen: false, bounds: { x: 1229, y: 780, width: 160, height: 48 } }],
        focused: { available: false, code: 'focus_unavailable' }, targetState: { enabled: true, minimized: false, foreground: true, ownerWindowId: null },
        ...(options.screenshotPath ? { screenshot: { path: options.screenshotPath } } : {}), ...(relatedWindows ? { relatedWindows } : {}) };
    },
    act: async request => { calls.act.push(request); return { performed: true, type: request.action.type }; },
  };
  const controller = createComputerController({ backend, runtimeDirectory: directory, observationTtlMs: 60000,
    lease: { acquire: async () => {}, assert: async () => {}, release: async () => {} },
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller }); await server.connect(serverTransport);
  const client = new Client({ name: 'trace-related', version: '1.0.0' }); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name: `trace_computer_${name}`, arguments: args });
  await call('list_windows');
  const { sessionId } = (await call('open_session', { windowId: window.id })).structuredContent;
  return { call, sessionId, calls, directory };
}
const menu = { windowId: '264660', pid: 28836, relation: 'owned', kind: 'menu', className: 'WindowsForms10.Window.20808.app.0.1', zOrder: 0,
  bounds: { x: 1241, y: 873, width: 200, height: 100 }, boundsSource: 'dwm-frame', dpi: 144, dpiAwareness: 'per-monitor', topmost: true,
  uia: { available: true, controlType: 'ControlType.Menu', name: '' } };
const listOf = windows => ({ available: true, windows, truncated: false, menuMode: { available: true, active: false },
  coverage: { ownerChain: true, threadMenu: true, sameThreadPopups: true, otherThreadsAndProcesses: false } });

test('full observations report related windows as context with offsets in the action-point space', async t => {
  const outside = { ...menu, windowId: '999', zOrder: 1, bounds: { x: 3000, y: 10, width: 50, height: 20 } };
  const { call, sessionId, calls } = await connection(t, () => listOf([menu, outside]));
  const value = (await call('observe', { sessionId })).structuredContent;
  assert.equal(calls.observe[0].related, true); assert.equal(calls.observe[0].relatedImagePrefix, undefined);
  assert.equal(value.relatedWindows.authority, 'context-only');
  assert.deepEqual(value.relatedWindows.windows[0].offset, { x: 52, y: 133 });
  assert.equal(value.relatedWindows.windows[0].coversWindow, true);
  assert.equal(value.relatedWindows.windows[1].coversWindow, false);
  // A popup gets no element ID, so it cannot be named as an action target.
  assert.deepEqual(value.elements.map(item => item.id), ['target']);
  assert.equal(value.coordinates.actionPoints, 'window-local-physical-pixels');
});

test('accessibility mode reads no related windows and rejects relatedImages', async t => {
  const { call, sessionId, calls } = await connection(t, () => listOf([menu]));
  const value = (await call('observe', { sessionId, mode: 'accessibility' })).structuredContent;
  assert.equal(Object.hasOwn(value, 'relatedWindows'), false); assert.equal(calls.observe[0].related, undefined);
  const rejected = await call('observe', { sessionId, mode: 'accessibility', relatedImages: true });
  assert.equal(rejected.isError, true);
});

test('an unavailable list is reported, and the observation still authorizes its one action', async t => {
  const { call, sessionId, calls } = await connection(t, () => ({ available: false, code: 'window_closed' }));
  const value = (await call('observe', { sessionId })).structuredContent;
  assert.deepEqual(value.relatedWindows, { available: false, code: 'window_closed', authority: 'context-only' });
  const acted = await call('act', { sessionId, observationId: value.observationId, action: { type: 'click', elementId: 'target' } });
  assert.notEqual(acted.isError, true); assert.equal(calls.act.length, 1);
  // The summary repeats an unavailable list, so the caller knows popups were not checked.
  assert.equal(acted.structuredContent.summary.relatedWindows.available, false);
});

test('a related window ID is not an element: acting on it is rejected before dispatch', async t => {
  const { call, sessionId, calls } = await connection(t, () => listOf([menu]));
  const value = (await call('observe', { sessionId })).structuredContent;
  const rejected = await call('act', { sessionId, observationId: value.observationId, action: { type: 'click', elementId: menu.windowId } });
  assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent.error.code, 'unknown_element');
  assert.equal(calls.act.length, 0);
});

test('relatedImages returns each popup PNG as image content and leaves no file behind', async t => {
  const { call, sessionId, directory } = await connection(t, async ({ relatedImagePrefix }) => {
    await fs.writeFile(`${relatedImagePrefix}-0.png`, png(200, 100));
    await fs.writeFile(`${relatedImagePrefix}-1.png`, png(7, 7)); // differs from its window: rejected
    return listOf([{ ...menu, image: { available: true, path: `${relatedImagePrefix}-0.png`, width: 200, height: 100 } },
      { ...menu, windowId: '2492002', zOrder: 1, image: { available: true, path: `${relatedImagePrefix}-1.png`, width: 7, height: 7 } },
      { ...menu, windowId: '330100', zOrder: 2, image: { available: false, code: 'capture_blank' } }]);
  });
  const result = await call('observe', { sessionId, relatedImages: true }), value = result.structuredContent;
  const [first, second, third] = value.relatedWindows.windows.map(item => item.image);
  assert.equal(first.available, true); assert.equal(first.physicalPerImagePixel, 1);
  assert.equal(result.content[first.screenshot.contentIndex].type, 'image');
  assert.equal(Buffer.from(result.content[first.screenshot.contentIndex].data, 'base64').readUInt32BE(16), 200);
  assert.deepEqual(second, { available: false, code: 'capture_mismatch' });
  assert.deepEqual(third, { available: false, code: 'capture_blank' });
  assert.equal(result._meta['trace/response'].imageCount, 2);
  const leftovers = [];
  for (const entry of await fs.readdir(directory, { recursive: true })) if (String(entry).includes('-related-')) leftovers.push(entry);
  assert.deepEqual(leftovers, []);
});

test('the act summary shows a popup the action opened, and a full refresh keeps relatedImages', async t => {
  let opened = false;
  const { call, sessionId, calls } = await connection(t, async ({ relatedImagePrefix }) => {
    if (!opened) return listOf([]);
    if (relatedImagePrefix) await fs.writeFile(`${relatedImagePrefix}-0.png`, png(200, 100));
    return listOf([{ ...menu, ...(relatedImagePrefix ? { image: { available: true, path: `${relatedImagePrefix}-0.png`, width: 200, height: 100 } } : {}) }]);
  });
  let value = (await call('observe', { sessionId })).structuredContent;
  assert.deepEqual(value.relatedWindows.windows, []);
  opened = true;
  const acted = (await call('act', { sessionId, observationId: value.observationId, action: { type: 'click', elementId: 'target' } })).structuredContent;
  assert.equal(acted.summary.relatedWindows.windows[0].kind, 'menu');
  value = (await call('observe', { sessionId, relatedImages: true })).structuredContent;
  const full = await call('act', { sessionId, observationId: value.observationId, action: { type: 'click', elementId: 'target' }, returnObservation: 'full' });
  assert.equal(full.structuredContent.observation.relatedWindows.windows[0].image.available, true);
  assert.ok(calls.observe.at(-1).relatedImagePrefix);
});

// Item 8: winapp presses at screen points without an occlusion check, so TRACE checks first.
function guarded(hitFor) {
  const rect = { x: 100, y: 200, width: 300, height: 200 }, target = { id: '123', pid: 7, processName: 'fixture', bounds: rect };
  const element = { id: 'button', enabled: true, name: 'Button', controlType: 'Button', bounds: { x: 110, y: 220, width: 40, height: 20 } };
  const before = () => ({ window: target, bounds: rect, uiaBounds: rect, frameBounds: rect, nativeWindowBounds: rect, elements: [structuredClone(element)] });
  const calls = [];
  const supervisor = { ready: true, async run(provider, args) {
    calls.push({ provider, args });
    const value = args[0] === 'hit' ? { hwnd: '123', pid: 7, method: 'public-win32-hit', ...hitFor(args) }
      : { hwnd: '123', pid: 7, frameBounds: rect, windowBounds: rect, enabled: true, foreground: true, minimized: false,
        ...(args[0] === 'click' ? { performed: true, operation: 'click', inputEvents: 2 } : {}) };
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
  } };
  const backend = new WinappBackend({ supervisor });
  backend.identity = async () => target; backend.inspect = async () => before();
  backend.command = async (verb, args) => { calls.push({ verb, args }); return { hwnd: 123 }; };
  return { calls, act: action => backend.act({ window: target, observation: before(), action }) };
}
const pointsOf = args => Array.from({ length: (args.length - 3) / 2 }, (_, i) => ({ x: Number(args[3 + 2 * i]), y: Number(args[4 + 2 * i]) }));
const coveredWhen = (predicate, related = true) => args => ({ points: pointsOf(args).map(item => predicate(item)
  ? { ...item, clear: false, coveredBy: { windowId: '264660', pid: 7, className: '#32768', related } } : { ...item, clear: true }) });

test('a click, element click, drag or wheel under one of the window\'s own popups is refused before dispatch', async () => {
  for (const [action, expected] of [[{ type: 'click', x: 3, y: 4 }, [{ x: 103, y: 204 }]],
    [{ type: 'click', elementId: 'button' }, [{ x: 130, y: 230 }]],
    [{ type: 'drag', fromX: 1, fromY: 1, toX: 50, toY: 60 }, [{ x: 101, y: 201 }, { x: 150, y: 260 }]],
    [{ type: 'scroll', x: 15, y: 25, deltaX: 0, deltaY: 120 }, [{ x: 130, y: 230 }]]]) {
    const f = guarded(coveredWhen(item => item.x === expected.at(-1).x));
    await assert.rejects(f.act(action), error => error.code === 'target_occluded' && error.details.outcome === 'not_dispatched'
      && error.details.coveredBy.windowId === '264660' && error.details.preparation[0].step === 'activation');
    assert.deepEqual(pointsOf(f.calls.find(call => call.args?.[0] === 'hit').args), expected);
    assert.equal(f.calls.some(call => call.verb), false, 'winapp must not be called');
    // The check runs after TRACE's own activation, which leaves an open menu in place.
    assert.ok(f.calls.findIndex(call => call.args?.[0] === 'activate') < f.calls.findIndex(call => call.args?.[0] === 'hit'));
  }
});

test('another application\'s window over the point is left to activation, as before', async () => {
  const f = guarded(coveredWhen(() => true, false));
  await f.act({ type: 'click', x: 3, y: 4 });
  assert.equal(f.calls.find(call => call.verb)?.verb, 'drag');
});

test('a malformed occlusion reply refuses, and bridge pointer input keeps its own check', async () => {
  for (const reply of [() => ({ points: [] }), () => ({ points: [{ x: 1, y: 2, clear: true }] }), () => ({ points: [{ x: 103, y: 204, clear: false }] })]) {
    const f = guarded(reply);
    await assert.rejects(f.act({ type: 'click', x: 3, y: 4 }), error => error.code === 'invalid_native_response' && error.details.outcome === 'not_dispatched');
    assert.equal(f.calls.some(call => call.verb), false);
  }
  const f = guarded(() => { throw new Error('hit must not be called'); });
  await f.act({ type: 'click', x: 3, y: 4, button: 'right' });
  assert.equal(f.calls.some(call => call.args?.[0] === 'hit'), false);
});

test('keyboard and UIA pattern actions need no point and skip the check', async () => {
  const f = guarded(() => { throw new Error('hit must not be called'); });
  await f.act({ type: 'invoke', elementId: 'button' });
  assert.equal(f.calls.some(call => call.args?.[0] === 'hit'), false);
});
