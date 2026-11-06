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
    if (executable === 'dotnet') return { stdout: 'Microsoft.WindowsDesktop.App 10.0.4 [C:\\dotnet]\n', stderr: '', exitCode: 0 };
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

test('P2-1 bar: a ready doctor is at most 2,750 chars, and verbose still returns the full descriptor', async t => {
  const h = await harness(t, { supervised: true });
  const compact = await h.call('doctor'), verbose = await h.call('doctor', { verbose: true });
  assert.equal(compact.structuredContent.ready, true, text(compact));
  console.log(`P2-1: doctor ${text(compact).length} chars (bar 2750); verbose ${text(verbose).length}`);
  assert.ok(text(compact).length <= 2750, `doctor was ${text(compact).length} chars`);
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

// P2-3 and P2-4 run against a controller-level fake desktop: a Notepad owner, an owned Save As
// modal that disables it while open, and an App Paths catalog for the launcher.
const { EventEmitter } = require('node:events');
const { createInstalledApplications } = require('../src/method/installed-applications.cjs');
const MODAL = { id: '5678', pid: 456, processName: 'Notepad', title: 'Save as', processCreationTime: '100', sessionId: 1, ownerWindowId: '1234' };
async function desktop(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-p2-desk-'));
  const executable = path.join(directory, 'notepad.exe');
  await fs.writeFile(executable, 'synthetic executable');
  const state = { modal: false, launched: false, spawns: [], listings: 0, fault: null };
  const launched = { ...window, id: '9000', pid: 400, processCreationTime: '300', executable };
  const sized = item => ({ ...item, bounds: { x: null, y: null, width: item.id === MODAL.id ? 600 : 1200, height: 400 } });
  const live = () => [window, ...(state.modal ? [MODAL] : []), ...(state.launched ? [launched] : [])].map(sized);
  const closed = () => Object.assign(new Error('closed'), { code: 'window_closed' });
  const backend = {
    async listWindows() { state.listings++; return live(); },
    async currentWindow(target) { if (!live().some(item => item.id === target.id)) throw closed(); return { ...target }; },
    async currentVisualWindow(target) { return this.currentWindow(target); },
    async targetClosed(target) { return !live().some(item => item.id === target.id); },
    async observe({ window: target }) {
      if (!live().some(item => item.id === target.id)) throw closed();
      const isModal = target.id === MODAL.id;
      return { window: { ...target }, bounds: { x: 0, y: 0, width: isModal ? 600 : 1200, height: 400 }, depth: 2,
        elements: [{ id: isModal ? 'btn-save' : 'mnu-file', name: isModal ? 'Save' : 'File', controlType: 'Button', enabled: true, bounds: { x: 1, y: 1, width: 20, height: 20 } }],
        focused: { available: true, hasFocus: false }, targetState: { enabled: isModal || !state.modal, minimized: false, foreground: true } };
    },
    // activate on the owner stands in for File > Save as; on the modal, for Save.
    async act({ window: target }) { state.modal = target.id !== MODAL.id; return { dispatched: true }; },
    async bridge(verb, _window, _signal, args) {
      if (verb === 'apps') return { applications: [{ name: 'notepad.exe', executable, registration: 'App Paths/notepad.exe' },
        { name: 'firefox.exe', executable: path.join(directory, 'WindowsApps', 'firefox.exe'), registration: 'App Paths/firefox.exe' }], coverage: 'App Paths', partial: false, issues: [] };
      assert.equal(verb, 'process'); assert.deepEqual(args, ['400']);
      return { pid: 400, processCreationTime: '300', sessionId: 1, executable };
    },
  };
  const lease = { owner: null, signal: new AbortController().signal,
    async acquire(owner) { if (this.owner) throw Object.assign(new Error('busy'), { code: 'desktop_busy' }); this.owner = owner; },
    async assert(owner) { if (this.owner !== owner) throw Object.assign(new Error('lost'), { code: 'lease_lost' }); },
    async release(owner) { if (this.owner === owner) this.owner = null; } };
  const spawnImpl = (file, args, options) => {
    state.spawns.push({ file, args, shell: options.shell });
    const child = new EventEmitter(); child.pid = 400; child.unref = () => {};
    queueMicrotask(() => { if (state.fault !== 'no-window') state.launched = true; child.emit('spawn'); });
    return child;
  };
  const controller = createComputerController({ backend, lease, runtimeDirectory: directory, observationTtlMs: 60000,
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} },
    createApplications: () => createInstalledApplications({ backend, lease, spawnImpl, verify: async () => {}, timeoutMs: 300 }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller }); await server.connect(serverTransport);
  const client = new Client({ name: 'trace-p2-desk', version: '1.0.0' }); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name: `trace_computer_${name}`, arguments: args });
  return { call, state, executable };
}
const errorCode = result => JSON.parse(text(result)).error.code;

test('P2-3 bar: launch starts the registered EXE without a shell, and open_session takes its window directly', async t => {
  const d = await desktop(t);
  const result = await d.call('launch', { app: 'Notepad' });
  assert.equal(result.structuredContent.outcome, 'launched', text(result));
  assert.deepEqual(d.state.spawns, [{ file: d.executable, args: [], shell: false }]);
  assert.deepEqual(result.structuredContent.windows.map(item => item.id), ['9000']);
  assert.equal(result.structuredContent.windows[0].executable, undefined);
  console.log(`P2-3: launch result ${text(result).length} chars`);
  assert.ok(text(result).length < 500, `launch result was ${text(result).length} chars`);
  const listings = d.state.listings;
  const opened = await d.call('open_session', { windowId: '9000' });
  assert.equal(opened.isError, undefined, text(opened));
  assert.equal(d.state.listings, listings, 'open_session needed no new listing');
  // The lease has one owner: a launch with a session open is refused before anything starts.
  assert.equal(errorCode(await d.call('launch', { app: 'notepad.exe' })), 'desktop_busy');
  assert.equal(d.state.spawns.length, 1);
  await d.call('close_session', { sessionId: opened.structuredContent.sessionId });
  assert.equal((await d.call('launch', { app: 'notepad.exe' })).structuredContent.outcome, 'launched', 'a deliberate relaunch after success is allowed');
});

test('P2-3: URIs, paths and unverifiable packaged EXEs are reported; an unknown outcome is not relaunched', async t => {
  const d = await desktop(t);
  const code = async app => errorCode(await d.call('launch', { app }));
  assert.equal(await code('ms-settings:'), 'application_unsupported');
  assert.equal(await code('C:\\Windows\\notepad.exe'), 'application_unsupported');
  assert.equal(await code('calc'), 'unknown_application');
  const firefox = JSON.parse(text(await d.call('launch', { app: 'firefox' }))).error;
  assert.equal(firefox.code, 'unknown_application'); assert.match(firefox.message, /WindowsApps/);
  d.state.fault = 'no-window';
  const unknown = await d.call('launch', { app: 'notepad' });
  assert.equal(unknown.structuredContent.outcome, 'unknown'); assert.equal(unknown.structuredContent.code, 'application_timeout');
  assert.equal(await code('notepad'), 'application_already_attempted');
  assert.equal(d.state.spawns.length, 1);
});

test('P2-4 bar: Save As is completed in its owned modal without close, re-list or re-open', async t => {
  const d = await desktop(t);
  await d.call('list_windows');
  const { sessionId } = (await d.call('open_session', { windowId: '1234' })).structuredContent;
  const first = await d.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2 });
  // File > Save as: the owner becomes disabled, and the act result names the modal that did it.
  const opened = await d.call('act', { sessionId, observationId: first.structuredContent.observationId, action: { type: 'activate' } });
  assert.equal(opened.structuredContent.summary.targetState.enabled, false);
  assert.equal(opened.structuredContent.ownedModal.windowId, MODAL.id, text(opened));
  const inModal = await d.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2, followModal: true });
  assert.equal(inModal.structuredContent.window.id, MODAL.id, text(inModal));
  assert.equal(inModal.structuredContent.sessionId, sessionId);
  const saved = await d.call('act', { sessionId, observationId: inModal.structuredContent.observationId, action: { type: 'activate' } });
  assert.equal(saved.structuredContent.outcome, 'target_closed_after_dispatch', text(saved));
  assert.equal(saved.structuredContent.returnedToOwner, true);
  assert.equal(saved.structuredContent.summary.targetState.enabled, true);
  console.log(`P2-4: modal report ${JSON.stringify(opened.structuredContent.ownedModal).length} chars; return ${text(saved).length} chars`);
  // The returned observation authorizes the next action in the owner, in the same session.
  const next = await d.call('act', { sessionId, observationId: saved.structuredContent.observationId, action: { type: 'activate' }, returnObservation: 'none' });
  assert.equal(next.structuredContent.outcome, 'completed', text(next));
  assert.equal(next.structuredContent.ownedModal.windowId, MODAL.id);
});

test('P2-4: following needs an owned modal, and a window from another process lifetime is not reported', async t => {
  const d = await desktop(t);
  await d.call('list_windows');
  const { sessionId } = (await d.call('open_session', { windowId: '1234' })).structuredContent;
  assert.equal(errorCode(await d.call('observe', { sessionId, followModal: true, screenshot: 'none' })), 'no_owned_modal');
  MODAL.processCreationTime = '999'; t.after(() => { MODAL.processCreationTime = '100'; });
  d.state.modal = true;
  const observed = await d.call('observe', { sessionId, screenshot: 'none' });
  assert.equal(observed.structuredContent.targetState.enabled, false);
  assert.equal(observed.structuredContent.ownedModal, undefined);
});
