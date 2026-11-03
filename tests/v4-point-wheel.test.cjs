'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { parseAction, actionSupport, compatibleSupport } = require('../src/computer/action-contract.cjs');
const { createTraceProvider, TOOL_NAMES } = require('../src/method/trace-adapter.cjs');
const rect = { x: -300, y: 100, width: 300, height: 200 }, window = { id: '123', pid: 7, processName: 'fixture', bounds: rect };
const action = { type: 'scroll', x: 20, y: 30, placement: 'point', deltaX: 120, deltaY: -240 };
function fixture() {
  const calls = [], control = { events: 2, enabled: true, fail: false };
  const supervisor = { ready: true, async run(provider, args, options) {
    calls.push({ provider, args, options });
    if (control.fail && args[0] === 'wheel') throw Object.assign(new Error('insertion lost'), { code: 'input_rejected' });
    return { stdout: JSON.stringify({ hwnd: '123', pid: 7, frameBounds: rect, windowBounds: rect,
      enabled: control.enabled, foreground: true, minimized: false, performed: true, operation: args[0], inputEvents: control.events }), stderr: '', exitCode: 0 };
  } };
  const backend = new WinappBackend({ supervisor });
  backend.identity = async () => window;
  // No element under the point: image-space wheel does not substitute a UIA element's center.
  backend.inspect = async () => ({ bounds: rect, elements: [] });
  const observation = { window, bounds: rect, uiaBounds: rect, frameBounds: rect, nativeWindowBounds: rect, elements: [] };
  return { backend, calls, control, act: payload => backend.act({ window, observation, action: payload }) };
}
test('point wheel validates both axes and units while omitted placement retains legacy rejection', () => {
  assert.deepEqual(parseAction(action), action);
  for (const extra of [{ deltaX: 0, deltaY: 0 }, { deltaX: 1 }, { deltaY: 2520 }, { placement: 'center' }]) {
    assert.throws(() => parseAction({ ...action, ...extra }), error => error.details?.outcome === 'not_dispatched');
  }
  const legacy = { ...action }; delete legacy.placement;
  assert.throws(() => parseAction(legacy), { code: 'unsupported_action' });
});
test('point wheel preserves requested physical point and both signed axes without a matching element', async () => {
  const f = fixture(), result = await f.act(action), call = f.calls.find(c => c.args[0] === 'wheel');
  assert.deepEqual(call.args, ['wheel', '123', '7', '-280', '130', '120', '-240']);
  assert.equal(call.provider, 'bridge'); assert.equal(call.options.mutating, true);
  assert.equal(result.engine, 'public-win32-sendinput');
  const single = fixture(); single.control.events = 1;
  assert.equal((await single.act({ ...action, deltaY: 0 })).performed, true);
});
test('point wheel retains owner gating, refuses unsupervised input and preserves partial uncertainty', async () => {
  const f = fixture(); f.backend.supervisor = null;
  await assert.rejects(f.act(action), error => error.code === 'supervision_required' && error.details.outcome === 'not_dispatched');
  assert.equal(f.calls.length, 0);
  const disabled = fixture(); disabled.control.enabled = false;
  await assert.rejects(disabled.act(action), { code: 'window_blocked', details: { outcome: 'not_dispatched', preparation: [] } });
  assert.equal(disabled.calls.filter(c => c.args[0] === 'wheel').length, 0);
  for (const control of [{ events: 1 }, { fail: true }]) {
    const partial = fixture(); Object.assign(partial.control, control);
    await assert.rejects(partial.act(action), error => error.details.outcome === 'unknown');
    assert.equal(partial.calls.filter(c => c.args[0] === 'wheel').length, 1);
  }
});
test('real MCP schema admits point/horizontal wheel and rejects zero pair before controller', async t => {
  const received = [], controller = Object.fromEntries(['doctor', 'listWindows', 'openSession', 'observe', 'closeSession', 'close'].map(name => [name, async () => ({})]));
  controller.act = async request => { received.push(request.action); return { outcome: 'completed' }; };
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller }); await server.connect(b);
  const client = new Client({ name: 'wheel-schema', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const send = action => client.callTool({ name: 'trace_computer_act', arguments: { sessionId: 's', observationId: 'o', action } });
  for (const payload of [action, { ...action, deltaY: 0 }, { ...action, deltaX: 0 }, { type: 'scroll', x: 1, y: 2, deltaX: 0, deltaY: 120 }]) assert.notEqual((await send(payload)).isError, true);
  assert.equal((await send({ ...action, deltaX: 0, deltaY: 0 })).isError, true); assert.equal(received.length, 4);
});
test('older native descriptors never acquire advertised point wheel or extended buttons', async () => {
  const legacy = actionSupport(); delete legacy.actions.scroll.point; delete legacy.actions.click.variants;
  assert.equal(compatibleSupport(legacy), true);
  const provider = createTraceProvider({ app: 'fixture', windowId: '123', tools: TOOL_NAMES.map(name => ({ name, inputSchema: {} })),
    callTool: async () => ({ structuredContent: { ready: true, support: legacy } }) });
  assert.equal((await provider.doctor()).ready, true);
  assert.equal(provider.constraints.nativeSupport.actions.scroll.point, undefined);
  assert.equal(provider.constraints.nativeSupport.actions.click.variants, undefined);
  const invalid = actionSupport(); invalid.actions.scroll.point.positiveX = 'left'; assert.equal(compatibleSupport(invalid), false);
});
