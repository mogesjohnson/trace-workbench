'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { parseAction, actionSupport, compatibleSupport } = require('../src/computer/action-contract.cjs');
const { createTraceProvider } = require('../src/method/trace-adapter.cjs');
const rect = { x: 100, y: 200, width: 300, height: 200 };
const window = { id: '123', pid: 7, processName: 'fixture', bounds: rect };
const element = { id: 'button', enabled: true, name: 'Button', controlType: 'Button', bounds: { x: 110, y: 220, width: 40, height: 20 } };
const before = () => ({ window, bounds: rect, uiaBounds: rect, frameBounds: rect,
  nativeWindowBounds: rect, elements: [structuredClone(element)] });
function fixture() {
  const calls = [], control = { events: null, nativeError: false };
  const supervisor = { ready: true, async run(provider, args, options) {
    calls.push({ provider, args, options });
    const value = { hwnd: '123', pid: 7, frameBounds: rect, windowBounds: rect, enabled: true, foreground: true, minimized: false };
    if (args[0] === 'click') Object.assign(value, { performed: true, operation: 'click', inputEvents: control.events ?? 2 * Number(args[6]) });
    if (args[0] === 'click' && control.nativeError) throw Object.assign(new Error('partial insertion'), { code: 'input_rejected' });
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
  } };
  const backend = new WinappBackend({ supervisor });
  backend.identity = async () => window; backend.inspect = async () => before();
  backend.command = async (verb, args) => { calls.push({ verb, args }); return { hwnd: 123 }; };
  return { backend, calls, control, act: action => backend.act({ window, observation: before(), action }) };
}
test('extended click forms validate before provider activity and preserve legacy defaults', () => {
  for (const action of [{ type: 'click', x: 0, y: 0 }, { type: 'click', elementId: 'button', button: 'middle' },
    { type: 'click', x: 1, y: 2, button: 'right' }, { type: 'click', x: 1, y: 2, count: 2 }]) assert.deepEqual(parseAction(action), action);
  for (const extra of [{ button: 'secondary' }, { count: 0 }, { count: 3 }, { button: 'middle', count: 2 }]) {
    assert.throws(() => parseAction({ type: 'click', x: 1, y: 2, ...extra }), error => error.details?.outcome === 'not_dispatched');
  }
});
test('point and element variants use supervised bridge with exact button/count and crop coordinates', async () => {
  for (const [extra, x, y, button, count] of [[{ x: 3, y: 4, button: 'right' }, 103, 204, 'right', 1],
    [{ elementId: 'button', button: 'middle' }, 130, 230, 'middle', 1], [{ x: 3, y: 4, count: 2 }, 103, 204, 'left', 2]]) {
    const f = fixture(), receipt = await f.act({ type: 'click', ...extra });
    const call = f.calls.find(c => c.args[0] === 'click');
    assert.deepEqual(call.args, ['click', '123', '7', String(x), String(y), button, String(count)]);
    assert.equal(call.provider, 'bridge'); assert.equal(call.options.mutating, true);
    assert.equal(receipt.engine, 'public-win32-sendinput'); assert.equal(f.calls.some(c => c.verb), false);
  }
  const legacy = fixture(); await legacy.act({ type: 'click', x: 3, y: 4 });
  assert.equal(legacy.calls.find(c => c.verb)?.verb, 'drag');
});
test('unsupervised variants fail before activation; partial/malformed receipts remain unknown without replay', async () => {
  const f = fixture(); f.backend.supervisor = null;
  await assert.rejects(f.act({ type: 'click', x: 1, y: 2, button: 'right' }), { code: 'supervision_required', details: { outcome: 'not_dispatched', preparation: [] } });
  assert.equal(f.calls.length, 0);
  for (const control of [{ events: 1 }, { nativeError: true }]) {
    const other = fixture(); Object.assign(other.control, control);
    await assert.rejects(other.act({ type: 'click', x: 1, y: 2, count: 2 }), error => error.details?.outcome === 'unknown');
    assert.equal(other.calls.filter(c => c.args[0] === 'click').length, 1);
  }
});
test('live MCP schema transports extended clicks and rejects unsupported combinations before controller', async t => {
  const received = [], controller = Object.fromEntries(['doctor', 'listWindows', 'openSession', 'observe', 'closeSession', 'close'].map(name => [name, async () => ({})]));
  controller.act = async request => { received.push(request.action); return { outcome: 'completed' }; };
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller }); await server.connect(b);
  const client = new Client({ name: 'pointer-schema', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  for (const button of ['left', 'right', 'middle']) {
    assert.notEqual((await client.callTool({ name: 'trace_computer_act', arguments: { sessionId: 's', observationId: 'o', action: { type: 'click', x: 1, y: 2, button } } })).isError, true);
  }
  const bad = await client.callTool({ name: 'trace_computer_act', arguments: { sessionId: 's', observationId: 'o', action: { type: 'click', x: 1, y: 2, button: 'right', count: 2 } } });
  assert.equal(bad.isError, true); assert.equal(received.length, 3);
});
test('legacy descriptors remain compatible but cannot acquire invented extended click support', async () => {
  const legacy = actionSupport(); delete legacy.actions.click.variants;
  assert.equal(compatibleSupport(legacy), true);
  const provider = createTraceProvider({ app: 'fixture', windowId: '123', tools: ['doctor', 'list_windows', 'open_session', 'observe', 'act', 'close_session']
    .map(name => ({ name: `trace_computer_${name}`, inputSchema: {} })), callTool: async () => ({ structuredContent: { ready: true, support: legacy } }) });
  assert.equal((await provider.doctor()).ready, true);
  assert.equal(provider.constraints.nativeSupport.actions.click.variants, undefined);
  const invalid = actionSupport(); invalid.actions.click.variants.doubleButton = 'right'; assert.equal(compatibleSupport(invalid), false);
});
