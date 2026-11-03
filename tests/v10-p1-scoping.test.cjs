'use strict';
// P1-1…P1-5 (token cost incident): scoped observation, a trimmed window listing, opening a
// window without a mandatory re-list, a distinct closed-target outcome and a reported response
// size, each measured against the incident's acceptance bars where it sets one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createComputerController, listingNoise } = require('../src/computer/controller.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { createActCompat, advertisesVerboseListing } = require('../src/computer/act-compat.cjs');

const rect = { x: 0, y: 0, width: 1000, height: 700 };
const window = { id: '1234', pid: 456, processName: 'notepad', title: 'Save As', processCreationTime: '100', sessionId: 1 };
const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });
const box = (x, y, width, height) => ({ isEnabled: true, isOffscreen: false, x, y, width, height });

// A Save As dialog like the incident's: a folder tree, a file list and the file-name box.
function saveDialog({ fileBox = true } = {}) {
  const folders = Array.from({ length: 60 }, (_, i) => ({ selector: `tvi-folder-${i}`, name: `Folder number ${i}`, type: 'TreeItem', ...box(10, 100 + i * 8, 200, 8), children: [] }));
  const files = Array.from({ length: 80 }, (_, i) => ({ selector: `lvi-file-${i}`, name: `Document number ${i}.txt`, type: 'ListItem', ...box(220, 100 + i * 6, 700, 6),
    children: [{ selector: `txt-file-${i}`, name: `Document number ${i}.txt`, type: 'Text', ...box(222, 100 + i * 6, 300, 6), children: [] }] }));
  const edit = { selector: 'edt-filename', automationId: '1001', className: 'Edit', name: 'File name:', type: 'Edit', ...box(120, 600, 600, 24), children: [] };
  const bottom = [
    ...(fileBox ? [{ selector: 'cbx-filename', automationId: 'FileNameControlHost', className: 'AppControlHost', name: 'File name:', type: 'ComboBox', ...box(110, 598, 640, 28),
      children: [edit, { selector: 'btn-filename-open', name: 'Open', type: 'Button', ...box(720, 600, 28, 24), children: [] }] }] : []),
    { selector: 'cbx-filetype', name: 'Save as type:', type: 'ComboBox', ...box(110, 630, 640, 28), children: [] },
    { selector: 'btn-save', automationId: '1', name: 'Save', type: 'Button', isInvokable: true, ...box(760, 660, 100, 28), children: [] },
    { selector: 'btn-cancel', automationId: '2', name: 'Cancel', type: 'Button', isInvokable: true, ...box(870, 660, 100, 28), children: [] },
  ];
  return { selector: 'win-saveas', name: 'Save As', type: 'Window', ...rect, children: [
    { selector: 'pane-nav', name: 'Navigation pane', type: 'Pane', ...box(0, 90, 210, 500), children: [{ selector: 'tree-nav', name: 'Folders', type: 'Tree', ...box(0, 90, 210, 500), children: folders }] },
    { selector: 'pane-files', name: 'Items view', type: 'Pane', ...box(210, 90, 790, 500), children: [{ selector: 'list-files', name: 'Items', type: 'List', ...box(210, 90, 790, 500), children: files }] },
    { selector: 'pane-bottom', name: 'Details', type: 'Pane', ...box(0, 590, 1000, 110), children: bottom },
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
function chainTo(node, target) {
  if (node.selector === target) { const { children, ...rest } = node; return rest; }
  for (const child of node.children || []) {
    const below = chainTo(child, target);
    if (below) { const { children, ...rest } = node; return { ...rest, children: [below] }; }
  }
  return null;
}
// winapp -i: the tree is nested first, then non-interactive nodes are collapsed so survivors keep
// their nearest interactive ancestor; truncated nodes survive as markers.
const INTERACTIVE = new Set(['Button', 'CheckBox', 'ComboBox', 'Edit', 'Hyperlink', 'ListItem', 'MenuItem', 'RadioButton', 'TabItem', 'TreeItem', 'SplitButton']);
function collapse(nodes) {
  const out = [];
  for (const node of nodes) {
    const kids = collapse(node.children || []);
    if (INTERACTIVE.has(node.type) || node.isInvokable || node.hasMoreChildren) out.push({ ...node, children: kids });
    else out.push(...kids);
  }
  return out;
}
const wrap = elements => ({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements }] });

function fakeWinapp(state) {
  return async (executable, args) => {
    state.calls.push(args);
    // The bridge and status echo the requested HWND, as the real ones do for a live window.
    const hwnd = args[1] === 'status' ? args[args.indexOf('-w') + 1] : /^\d+$/.test(args[1] ?? '') ? args[1] : '1234';
    const identity = { hwnd, pid: 456, processCreationTime: '100', sessionId: 1 };
    if (state.closed && (args[0] === 'bounds' || args[0] === 'identity' || args[1] === 'status')) return { stdout: '', stderr: JSON.stringify({ error: { code: 'window_closed', message: 'The selected window no longer exists.' } }), exitCode: 1 };
    if (args[0] === 'bounds' || args[0] === 'activate') return json({ ...identity, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: true });
    if (args[0] === 'identity') return json(identity);
    if (args[1] === 'status') return json({ hwnd: Number(hwnd), processId: 456, processName: 'notepad', windowTitle: 'Save As', coordinateSpace: 'physical-screen-pixels' });
    if (args[1] === 'get-focused') return json({ hasFocus: true, element: { ...find(state.tree, 'edt-filename') ?? find(state.tree, 'btn-save'), selector: 'ed-transient-7', children: undefined } });
    if (args[1] === 'inspect') {
      if (state.inspectFails) return { stdout: '', stderr: JSON.stringify({ error: { code: 'internal_error', message: 'UIA read failed.' } }), exitCode: 1 };
      if (args.includes('--ancestors')) return json(wrap([chainTo(state.tree, 'edt-filename')]));
      const depth = Number(args[args.indexOf('--depth') + 1]), dash = args.indexOf('--');
      // winapp 0.7.1 answers an unresolved selector with the window root.
      const start = dash >= 0 ? find(state.tree, args[dash + 1]) ?? state.tree : state.tree;
      const tops = [cut(start, depth)];
      return json(wrap(args.includes('-i') ? collapse(tops) : tops));
    }
    if (args[1] === 'send-keys' && state.keyError) return { stdout: '', stderr: JSON.stringify({ error: { code: 'invalid_arguments', message: state.keyError } }), exitCode: 1 };
    if (args[1] === 'send-keys' || args[1] === 'set-value' || args[1] === 'invoke') { state.dispatched.push(args[1]); state.afterDispatch?.(); return json({ hwnd: 1234 }); }
    return json({ hwnd: 1234 });
  };
}

async function harness(t, { tree = saveDialog(), windows = [window] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-p1-'));
  const state = { tree, calls: [], dispatched: [], closed: false };
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, verify: async () => {}, verifyBridge: async () => {}, verifyIndicator: async () => ({ available: true }), run: fakeWinapp(state) });
  backend.listWindows = async () => windows.map(item => ({ ...item, bounds: item.bounds ?? { x: null, y: null, width: rect.width, height: rect.height } }));
  const controller = createComputerController({ backend, runtimeDirectory: directory, observationTtlMs: 60000,
    lease: { acquire: async () => {}, assert: async () => {}, release: async () => {} },
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller }); await server.connect(serverTransport);
  const client = new Client({ name: 'trace-p1', version: '1.0.0' }); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name: `trace_computer_${name}`, arguments: args });
  return { call, state, directory };
}
const text = result => result.content.find(item => item.type === 'text').text;
async function session(h) {
  await h.call('list_windows');
  return (await h.call('open_session', { windowId: window.id })).structuredContent.sessionId;
}
const inspects = calls => calls.filter(args => args[1] === 'inspect' && !args.includes('--ancestors'));

test('P1-1 bar: the Save dialog file-name box is observable in at most 3,000 chars', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const whole = await h.call('observe', { sessionId, screenshot: 'none' });
  const scoped = await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2, rootElementId: 'cbx-filename' });
  assert.notEqual(scoped.isError, true, text(scoped));
  const value = scoped.structuredContent;
  assert.deepEqual(value.elements.map(e => e.id), ['cbx-filename', 'edt-filename', 'btn-filename-open']);
  assert.equal(value.elements[0].parentNodeId, null);
  assert.equal(value.accessibility.rootElementId, 'cbx-filename');
  // Coordinates and the movement guard stay window-level.
  assert.deepEqual(value.bounds, rect);
  assert.equal(value.focused.elementId, 'edt-filename');
  console.log(`P1-1: whole dialog ${text(whole).length} chars, file-name box ${text(scoped).length} chars (bar 3000)`);
  assert.ok(text(scoped).length <= 3000, `scoped observation was ${text(scoped).length} chars`);
  assert.ok(text(whole).length > 5 * text(scoped).length);
});

test('P1-1: dispatch re-inspects with the observed scope, and a scoped type_text binds focus and dispatches', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const observation = (await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2, rootElementId: 'cbx-filename' })).structuredContent;
  h.state.calls.length = 0;
  const acted = await h.call('act', { sessionId, observationId: observation.observationId, action: { type: 'type_text', text: 'notes.txt' } });
  assert.equal(acted.structuredContent.outcome, 'completed', text(acted));
  assert.deepEqual(h.state.dispatched, ['send-keys']);
  // Dispatch and the post-action refresh both read the subtree at the retained depth.
  const scopedReads = inspects(h.state.calls).filter(args => args.includes('cbx-filename'));
  assert.equal(scopedReads.length, 2);
  for (const args of scopedReads) assert.equal(args[args.indexOf('--depth') + 1], '2');
  assert.equal(acted.structuredContent.summary.elementCount, 3);
});

test('P1-1: a scope root missing from the window fails closed, and one removed by the action falls back once', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  // winapp answers the unknown selector with the window root; TRACE refuses to treat that as the scope.
  const missing = await h.call('observe', { sessionId, screenshot: 'none', rootElementId: 'pane-gone' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'element_not_found');
  const observation = (await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2, rootElementId: 'cbx-filename' })).structuredContent;
  h.state.afterDispatch = () => { h.state.tree = saveDialog({ fileBox: false }); };
  const acted = (await h.call('act', { sessionId, observationId: observation.observationId, action: { type: 'set_value', elementId: 'edt-filename', value: 'notes.txt' } })).structuredContent;
  assert.equal(acted.outcome, 'completed');
  assert.equal(acted.scopeLost, true);
  assert.ok(acted.summary.elementCount > 3);
  // The refresh now authorizes the next action for the whole window.
  const next = await h.call('act', { sessionId, observationId: acted.observationId, action: { type: 'invoke', elementId: 'btn-cancel' } });
  assert.equal(next.structuredContent.outcome, 'completed', text(next));
});

test('P1-1: interactiveOnly filters in TRACE, keeps the window root and is reused at dispatch', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const plain = (await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 3 })).structuredContent;
  const interactive = await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 3, interactiveOnly: true });
  const value = interactive.structuredContent;
  assert.equal(value.accessibility.interactiveOnly, true);
  assert.equal(value.elements[0].id, 'win-saveas');
  assert.ok(!value.elements.some(e => ['Pane', 'Tree', 'List', 'Text'].includes(e.controlType)));
  // Survivors attach to their nearest kept ancestor: here the window root.
  assert.equal(value.elements.find(e => e.id === 'btn-save').parentNodeId, value.elements[0].treeNodeId);
  assert.ok(value.elements.length < plain.elements.length);
  h.state.calls.length = 0;
  await h.call('act', { sessionId, observationId: value.observationId, action: { type: 'invoke', elementId: 'btn-save' }, returnObservation: 'none' });
  // Dispatch re-reads at the observed depth without winapp -i (TRACE filters, M4).
  const reads = inspects(h.state.calls).filter(args => args.includes('--depth') && args[args.indexOf('--depth') + 1] === '3');
  assert.ok(reads.length > 0 && !h.state.calls.some(args => args.includes('-i')));
  // Screenshot mode has no tree to scope.
  const rejected = await h.call('observe', { sessionId, mode: 'screenshot', interactiveOnly: true });
  assert.equal(rejected.isError, true);
});

// The incident's desktop: ~30 windows, most of them shell or helper surfaces.
function desktop() {
  const shell = [
    ...Array.from({ length: 3 }, () => ['explorer', 'Windows.Internal.Shell.TabProxyWindow', 198, 56, 'Tab proxy']),
    ...Array.from({ length: 3 }, () => ['explorer', 'ApplicationFrameWindow', 198, 56, '']),
    ...Array.from({ length: 4 }, () => ['TextInputHost', 'Windows.UI.Core.CoreWindow', 1920, 1200, 'Windows Input Experience']),
    ['LockApp', 'Windows.UI.Core.CoreWindow', 2880, 1800, 'Windows Default Lock Screen'],
    ['explorer', 'ThumbnailDeviceHelperWnd', 1, 1, ''], ['explorer', 'ThumbnailDeviceHelperWnd', 1, 1, ''],
    ['ShellExperienceHost', 'Windows.UI.Core.CoreWindow', 540, 2160, 'Notification Centre'], ['ShellExperienceHost', 'Windows.UI.Core.CoreWindow', 594, 0, 'Quick settings'],
    ['ShellExperienceHost', 'Windows.UI.Core.CoreWindow', 1, 1, 'Shell host'], ['SearchHost', 'Windows.UI.Core.CoreWindow', 1287, 1335, 'Search'],
    ['StartMenuExperienceHost', 'Windows.UI.Core.CoreWindow', 2880, 1728, 'Start'], ['explorer', 'Shell_TrayWnd', 2880, 72, ''],
    ['explorer', 'EdgeUiInputTopWndClass', 2857, 4, ''], ['explorer', 'Progman', 2880, 1800, 'Program Manager'],
  ];
  const apps = [
    ['firefox', 'MozillaWindowClass', 1436, 1798, 'Example Domain — Mozilla Firefox'], ['notepad', 'Notepad', 1200, 900, 'notes.txt - Notepad'],
    ['notepad', '#32770', 900, 640, 'Save As'], ['WindowsTerminal', 'CASCADIA_HOSTING_WINDOW_CLASS', 1458, 1809, 'Windows PowerShell'],
    ['msedge', 'Chrome_WidgetWin_1', 1458, 1809, 'New tab - Work - Microsoft Edge'], ['ApplicationFrameHost', 'ApplicationFrameWindow', 1134, 492, 'Settings'],
    ['SystemSettings', 'Windows.UI.Core.CoreWindow', 1112, 480, 'Settings'], ['Taskmgr', 'TaskManagerWindow', 900, 700, 'Task Manager'],
    ['Code', 'Chrome_WidgetWin_1', 1600, 1000, 'controller.cjs - trace-workbench - Visual Studio Code'],
  ];
  return [...shell, ...apps].map(([processName, className, width, height, title], i) => ({
    id: String(70000 + i * 17), pid: 3000 + i, processName, title, className, bounds: { x: null, y: null, width, height },
    executable: `C:\\Program Files\\WindowsApps\\Vendor.${processName}_1.2.3.4_x64__8wekyb3d8bbwe\\${processName}.exe`,
    processCreationTime: String(134000000000000000 + i), sessionId: 1, ...(processName === 'notepad' && className === '#32770' ? { ownerWindowId: '70323' } : {}),
    ...(processName === 'firefox' ? { foreground: true } : {}),
  }));
}

test('P1-2 bar: a 30-window desktop lists in at most 2,500 chars without paths or creation times', async t => {
  const windows = desktop();
  assert.equal(windows.length, 30);
  const h = await harness(t, { windows });
  const listed = await h.call('list_windows');
  const verbose = await h.call('list_windows', { verbose: true });
  const value = listed.structuredContent;
  console.log(`P1-2: default ${text(listed).length} chars (${value.windows.length} windows, ${value.omitted} omitted), verbose ${text(verbose).length} chars (bar 2500)`);
  assert.ok(text(listed).length <= 2500, `listing was ${text(listed).length} chars`);
  assert.equal(value.windows.length + value.omitted, 30);
  assert.deepEqual(value.windows.map(w => w.processName), ['firefox', 'notepad', 'notepad', 'WindowsTerminal', 'msedge', 'ApplicationFrameHost', 'SystemSettings', 'Taskmgr', 'Code']);
  assert.ok(!/executable|processCreationTime|sessionId|className/.test(text(listed)));
  assert.equal(value.windows.find(w => w.title === 'Save As').ownerWindowId, '70323');
  assert.equal(verbose.structuredContent.windows.length, 30);
  assert.ok(verbose.structuredContent.windows.every(w => w.executable && w.processCreationTime));
  // Omitted windows stay selectable: the server keeps every listed identity.
  const hidden = windows.find(w => w.processName === 'Progman' || w.className === 'Progman');
  assert.equal(listingNoise(hidden), 'shell');
});

test('P1-3: processName and title filters, and open_session on a window that appeared after the listing', async t => {
  const windows = desktop();
  const h = await harness(t, { windows });
  const byProcess = (await h.call('list_windows', { processName: 'NOTEPAD.exe' })).structuredContent.windows;
  assert.deepEqual(byProcess.map(w => w.title), ['notes.txt - Notepad', 'Save As']);
  assert.deepEqual((await h.call('list_windows', { title: 'save' })).structuredContent.windows.map(w => w.processName), ['notepad']);
  // An explicit process filter is a deliberate choice: shell windows are listed too.
  assert.equal((await h.call('list_windows', { processName: 'TextInputHost' })).structuredContent.windows.length, 4);
  // A window launched after the last listing opens in one call.
  windows.push({ ...window, id: '99001', bounds: { x: null, y: null, width: 800, height: 600 } });
  const opened = await h.call('open_session', { windowId: '99001' });
  assert.notEqual(opened.isError, true, text(opened));
  assert.ok(text(opened).length < 1000);
  const unknown = await h.call('open_session', { windowId: '424242' });
  assert.equal(unknown.structuredContent.error.code, 'unknown_window');
  const invalid = await h.call('list_windows', { processName: '' });
  assert.equal(invalid.isError, true);
});

test('P1-2/P1-3: identity-binding callers get the verbose listing once doctor advertises it', async () => {
  assert.equal(advertisesVerboseListing({ windowListing: { verbose: true } }), true);
  assert.equal(advertisesVerboseListing({ ready: true }), false);
  const seen = [];
  const wrapped = createActCompat().wrap(async (name, args) => { seen.push([name, args]); return name === 'doctor' ? { windowListing: { verbose: true } } : {}; });
  await wrapped('list_windows', {}); await wrapped('doctor', {}); await wrapped('list_windows', {}); await wrapped('trace_computer_list_windows', { verbose: false });
  assert.deepEqual(seen.filter(([name]) => name.endsWith('list_windows')).map(([, args]) => args), [{}, { verbose: true }, { verbose: false }]);
});

test('P1-4: Save closes the dialog: distinct outcome, journal entry, no internal_error', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const observation = (await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 3 })).structuredContent;
  h.state.afterDispatch = () => { h.state.closed = true; };
  const acted = await h.call('act', { sessionId, observationId: observation.observationId, action: { type: 'invoke', elementId: 'btn-save' } });
  assert.notEqual(acted.isError, true, text(acted));
  const value = acted.structuredContent;
  assert.equal(value.outcome, 'target_closed_after_dispatch');
  assert.equal(value.verification, 'window_closed');
  assert.equal(value.error, undefined);
  assert.ok(!/internal_error/.test(text(acted)));
  const journal = await fs.readFile(path.join(h.directory, 'sessions', sessionId, 'events.jsonl'), 'utf8');
  assert.match(journal, /"type":"action_target_closed"/);
  const after = await h.call('observe', { sessionId, screenshot: 'none' });
  assert.equal(after.isError, true);
  assert.equal((await h.call('close_session', { sessionId })).structuredContent.closed, true);
});

test('P1-4: a refresh failure on a window that still exists stays unknown', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const observation = (await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 3 })).structuredContent;
  h.state.afterDispatch = () => { h.state.inspectFails = true; };
  const acted = (await h.call('act', { sessionId, observationId: observation.observationId, action: { type: 'invoke', elementId: 'btn-save' } })).structuredContent;
  assert.equal(acted.outcome, 'unknown');
  // The backend probe distinguishes a closed or reused HWND from other bridge failures.
  const probe = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, run: async () => ({ stdout: '', stderr: JSON.stringify({ error: { code: 'window_bridge_failed', message: 'x' } }), exitCode: 1 }) });
  assert.equal(await probe.targetClosed(window), false);
  const closed = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, run: async () => ({ stdout: '', stderr: JSON.stringify({ error: { code: 'window_closed', message: 'x' } }), exitCode: 1 }) });
  assert.equal(await closed.targetClosed(window), true);
});

test('P1-5: every result reports responseBytes in _meta, and doctor advertises it', async t => {
  const h = await harness(t);
  const listed = await h.call('list_windows');
  const meta = listed._meta['trace/response'];
  assert.equal(meta.responseBytes, Buffer.byteLength(text(listed)));
  assert.equal(meta.imageCount, 0);
  const sessionId = (await h.call('open_session', { windowId: window.id })).structuredContent.sessionId;
  const observed = await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2 });
  assert.equal(observed._meta['trace/response'].responseBytes, Buffer.byteLength(text(observed)));
  const acted = await h.call('act', { sessionId, observationId: observed.structuredContent.observationId, action: { type: 'invoke', elementId: 'btn-cancel' } });
  assert.equal(acted._meta['trace/response'].jsonTextBytes, Buffer.byteLength(text(acted)));
  const doctor = (await h.call('doctor')).structuredContent;
  assert.deepEqual(doctor.responseSize, { meta: 'trace/response', field: 'responseBytes' });
  assert.deepEqual(doctor.observationScope, { rootElementId: true, interactiveOnly: true });
});

test('G2 follow-up: a system key winapp refuses before sending is not_dispatched; other argument errors stay unknown', async t => {
  const h = await harness(t);
  const sessionId = await session(h);
  const press = async () => {
    const observation = (await h.call('observe', { sessionId, screenshot: 'none', accessibilityDepth: 2 })).structuredContent;
    return (await h.call('act', { sessionId, observationId: observation.observationId, action: { type: 'press_key', key: 'alt+f4' } })).structuredContent;
  };
  // The message winapp 0.7.1 emitted live on 3 November 2026 (PR 114).
  h.state.keyError = 'Refusing to synthesize system-reserved key(s) via --via send-input: alt+f4. These act on the OS/shell rather than just the target app. Pass --allow-system-keys to opt in.';
  const refused = await press();
  assert.equal(refused.outcome, 'not_dispatched', JSON.stringify(refused));
  assert.equal(refused.error.code, 'invalid_arguments');
  assert.notEqual(refused.error.inputRecoveryRequired, true);
  assert.deepEqual(h.state.dispatched, []);
  // The session stays usable after a refusal.
  h.state.keyError = undefined;
  assert.equal((await press()).outcome, 'completed');
  h.state.keyError = 'Unknown key token.';
  assert.equal((await press()).outcome, 'unknown');
});
