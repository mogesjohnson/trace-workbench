'use strict';
// P2-1…P2-4 (token cost incident): a compact doctor and opt-in metrics, Notepad document readback,
// and the follow-ups below, each checked against the incident's acceptance bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { actionSupport, compactSupport, effectiveSupport, compatibleSupport } = require('../src/computer/action-contract.cjs');

const rect = { x: 0, y: 0, width: 1200, height: 800 };
const window = { id: '1234', pid: 456, processName: 'Notepad', title: 'Untitled - Notepad', processCreationTime: '100', sessionId: 1 };
const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });
const failed = (code, message) => ({ stdout: '', stderr: JSON.stringify({ error: { code, message } }), exitCode: 1 });
const box = (x, y, width, height) => ({ isEnabled: true, isOffscreen: false, x, y, width, height });
const DOCUMENT = 'Line one\r\nLine two — naïve café 😀\r\n\tTabbed';
const FORMATTED = { FontName: 'Consolas', FontSize: '11', FontWeight: '400', ForegroundColor: '#000000', IsItalic: 'False', StrikethroughStyle: 'None' };
const UNFORMATTED = Object.fromEntries(Object.keys(FORMATTED).map(key => [key, 'Unavailable']));

// Notepad as the incident saw it: the RichEdit document has a ClassName but no AutomationId, so the
// bridge's AutomationId binding cannot reach it.
function notepad() {
  const editor = { selector: 'doc-texteditor-53ad', name: 'Text editor', type: 'Document', className: 'RichEditD2DPT', ...box(10, 90, 1180, 660), children: [] };
  return { selector: 'win-notepad', name: 'Notepad', type: 'Window', ...rect, children: [
    { selector: 'mnu-file', name: 'File', type: 'MenuItem', ...box(10, 40, 40, 30), children: [] },
    editor,
    { selector: 'txt-status', name: '19 characters', type: 'Text', ...box(10, 760, 200, 30), children: [] },
  ] };
}
function cut(node, depth) {
  const { children = [], ...rest } = node;
  if (depth <= 0) return children.length ? { ...rest, hasMoreChildren: true } : rest;
  return { ...rest, children: children.map(child => cut(child, depth - 1)) };
}
function find(node, selector) {
  if (node.selector === selector) return node;
  for (const child of node.children || []) { const hit = find(child, selector); if (hit) return hit; }
  return null;
}
const wrap = elements => ({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements }] });

function fakeWinapp(state) {
  return async (executable, args) => {
    state.calls.push(args);
    const hwnd = args[1] === 'status' ? args[args.indexOf('-w') + 1] : /^\d+$/.test(args[1] ?? '') ? args[1] : '1234';
    const identity = { hwnd, pid: 456, processCreationTime: '100', sessionId: 1 };
    if (executable === 'supervisor.exe') return json({ recoveryRequired: false, ready: true, code: null });
    if (executable === 'dotnet') return { stdout: 'Microsoft.WindowsDesktop.App 9.0.4 [C:\\dotnet]\n', stderr: '', exitCode: 0 };
    if (args[0] === '--version') return { stdout: '0.7.1\n', stderr: '', exitCode: 0 };
    if (args[0] === 'info') return json({ version: 1 });
    if (args[0] === 'bounds' || args[0] === 'activate') return json({ ...identity, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: true });
    if (args[0] === 'identity') return json(identity);
    if (args[1] === 'status') return json({ hwnd: Number(hwnd), processId: 456, processName: 'Notepad', windowTitle: 'Notepad', coordinateSpace: 'physical-screen-pixels' });
    if (args[1] === 'get-focused') return json({ hasFocus: false });
    if (args[1] === 'inspect') return json(wrap([cut(state.tree, Number(args[args.indexOf('--depth') + 1]))]));
    if (args[1] === 'get-property') {
      const slug = args.at(-1), node = find(state.tree, slug);
      if (!node) return failed('element_not_found', `No element found matching '${slug}'`);
      const { children, selector, name, type, className, ...rest } = node;
      return json({ elementId: slug, element: { type, className, ...rest, ...state.moved, selector, isInvokable: false },
        properties: { Name: name, AutomationId: null, ControlType: type, ClassName: className, IsPassword: state.password ? 'True' : 'False', ...state.formatting } });
    }
    if (args[1] === 'get-value') return json({ elementId: args.at(-1), text: state.text });
    return json({ hwnd: 1234 });
  };
}

// `supervised` adds a native supervisor for the doctor's readiness report; it is not ready for input.
async function harness(t, { supervised = false, ...options } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-p2-'));
  const state = { tree: notepad(), calls: [], text: DOCUMENT, formatting: FORMATTED, password: false, moved: {}, ...options };
  const supervisor = supervised ? { binaryPath: 'supervisor.exe', ready: false, verify: async () => ({ available: true, integrity: 'verified', protocol: 1 }) } : null;
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor, verify: async () => {}, verifyBridge: async () => {},
    verifyIndicator: async () => ({ available: true, integrity: 'verified', protocol: 1 }), run: fakeWinapp(state) });
  backend.listWindows = async () => [{ ...window, bounds: { x: null, y: null, width: rect.width, height: rect.height } }];
  const controller = createComputerController({ backend, runtimeDirectory: directory, observationTtlMs: 60000,
    lease: { acquire: async () => {}, assert: async () => {}, release: async () => {} },
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller }); await server.connect(serverTransport);
  const client = new Client({ name: 'trace-p2', version: '1.0.0' }); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name: `trace_computer_${name}`, arguments: args });
  return { call, state, client };
}
const text = result => result.content.find(item => item.type === 'text').text;
async function session(h) {
  await h.call('list_windows');
  return (await h.call('open_session', { windowId: window.id })).structuredContent.sessionId;
}
const readDocument = (h, sessionId) => h.call('observe', { sessionId, mode: 'accessibility', screenshot: 'none', accessibilityDepth: 2, documentElementId: 'doc-texteditor-53ad' });

test('P2-1 bar: a ready doctor is at most 2,500 chars, and verbose still returns the full descriptor', async t => {
  const h = await harness(t, { supervised: true });
  const compact = await h.call('doctor'), verbose = await h.call('doctor', { verbose: true });
  assert.equal(compact.structuredContent.ready, true, text(compact));
  console.log(`P2-1: doctor ${text(compact).length} chars (bar 2500); verbose ${text(verbose).length}`);
  assert.ok(text(compact).length <= 2500, `doctor was ${text(compact).length} chars`);
  // The key regexes appear in neither the compact doctor nor twice anywhere.
  assert.doesNotMatch(text(compact), /\[Cc\]\[Tt\]\[Rr\]\[Ll\]/);
  assert.deepEqual(compact.structuredContent.support.actions, Object.keys(actionSupport().actions));
  assert.deepEqual(verbose.structuredContent.support, actionSupport(60000));
  assert.equal((await h.call('doctor', { verbose: 'yes' })).isError, true);
});

test('P2-1: callers check a compact declaration by digest, and 1.x full declarations stay compatible', () => {
  const compact = compactSupport(12345);
  assert.deepEqual(effectiveSupport(compact), actionSupport(12345));
  assert.equal(compatibleSupport({ ...compact, sha256: '0'.repeat(64) }), false);
  assert.equal(compatibleSupport({ ...compact, contractVersion: 2 }), false);
  // A different TTL changes the descriptor, so the digest must be recomputed for it.
  assert.equal(compatibleSupport({ ...compact, observation: { ...compact.observation, ttlMs: 999 } }), false);
  // A 1.x server sends the full descriptor, possibly without later optional features.
  const legacy = actionSupport(); delete legacy.actions.accessibility_action; delete legacy.actions.press_key.extended;
  const effective = effectiveSupport(legacy);
  assert.equal(effective.actions.accessibility_action, undefined); assert.equal(effective.actions.press_key.extended, undefined);
  const wrong = actionSupport(); wrong.actions.click.variants.doubleButton = 'right';
  assert.equal(compatibleSupport(wrong), false);
});

test('P2-1: metrics are returned only on request, including on the action refresh', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const plain = await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2 });
  assert.equal(plain.structuredContent.metrics, undefined);
  assert.equal(plain._meta['trace/projection'], undefined);
  const act = await h.call('act', { sessionId, observationId: plain.structuredContent.observationId, action: { type: 'activate' }, returnObservation: 'full' });
  assert.equal(act.structuredContent.observation.metrics, undefined);
  const measured = await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2, metrics: true });
  assert.equal(typeof measured.structuredContent.metrics.stages.backend.durationMs, 'number');
  assert.equal(measured._meta['trace/projection'].version, 1);
  const refreshed = await h.call('act', { sessionId, observationId: measured.structuredContent.observationId, action: { type: 'activate' }, returnObservation: 'full' });
  assert.equal(typeof refreshed.structuredContent.observation.metrics.stages.backend.durationMs, 'number');
  console.log(`P2-1: observation ${text(plain).length} chars without metrics, ${text(measured).length} with`);
});

test('P2-2 bar: the Notepad document is read back exactly without an AutomationId', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const result = await readDocument(h, sessionId);
  assert.notEqual(result.isError, true, text(result));
  const read = result.structuredContent.documentRead;
  assert.deepEqual(read.document, { available: true, text: DOCUMENT, truncated: false });
  assert.equal(read.provenance, 'winapp-textpattern-value');
  assert.deepEqual(read.selection, { available: false, reason: 'selection_unavailable' });
  // The exact observed selector is read in the session window; the AutomationId bridge is not used.
  const verbs = h.state.calls.filter(args => args[1] === 'get-property' || args[1] === 'get-value');
  assert.deepEqual(verbs.map(args => args.slice(1)), [
    ['get-property', '--json', '-w', '1234', '--', 'doc-texteditor-53ad'], ['get-value', '--json', '-w', '1234', '--', 'doc-texteditor-53ad']]);
  assert.equal(h.state.calls.some(args => args[0] === 'document'), false);
});

test('P2-2: no label fallback, password refusal, a changed control and the 4,096-unit bound', async t => {
  // Without TextPattern get-value would return the Name ("Text editor"), so it is never called.
  let h = await harness(t, { formatting: UNFORMATTED });
  let read = (await readDocument(h, await session(h))).structuredContent.documentRead;
  assert.deepEqual(read.document, { available: false, reason: 'text_pattern_unavailable' });
  assert.equal(h.state.calls.some(args => args[1] === 'get-value'), false);
  h = await harness(t, { password: true });
  read = (await readDocument(h, await session(h))).structuredContent.documentRead;
  assert.deepEqual(read.document, { available: false, reason: 'password_or_unknown' });
  assert.equal(h.state.calls.some(args => args[1] === 'get-value'), false);
  // The control moved between the inspection and the property read.
  h = await harness(t);
  const sessionId = await session(h);
  h.state.moved = { y: 95 };
  const moved = await readDocument(h, sessionId);
  assert.equal(moved.isError, true); assert.equal(moved.structuredContent.error.code, 'stale_element');
  // A long document is cut at 4,096 UTF-16 units without splitting a surrogate pair.
  h = await harness(t, { text: `${'a'.repeat(4095)}😀tail` });
  read = (await readDocument(h, await session(h))).structuredContent.documentRead;
  assert.equal(read.document.text, 'a'.repeat(4095)); assert.equal(read.document.truncated, true);
});
