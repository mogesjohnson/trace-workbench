'use strict';
// M4 (G4, G5): interactiveOnly filters in TRACE instead of winapp -i, so Documents survive and
// Gecko's isInvokable-on-everything no longer keeps empty structure; the result uses a lean
// element format; and a documentElementId outside the observed tree names the fix.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { createComputerController, safeError, validateAction } = require('../src/computer/controller.cjs');
const trees = require('./fixtures/m4-trees.cjs');

const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });
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
// winapp 0.7.1 as TRACE drives it: depth-limited reads, optionally under a selector. -i must not be used.
function fakeWinapp(state) {
  return async (_file, args) => {
    state.calls.push(args);
    const hwnd = args[1] === 'status' ? args[args.indexOf('-w') + 1] : /^\d+$/.test(args[1] ?? '') ? args[1] : '1234';
    const identity = { hwnd, pid: 456, processCreationTime: '100', sessionId: 1 };
    const rect = { x: state.tree.x, y: state.tree.y, width: state.tree.width, height: state.tree.height };
    if (args[0] === 'bounds' || args[0] === 'activate') return json({ ...identity, frameBounds: rect, windowBounds: rect, foreground: true, minimized: false, enabled: true });
    if (args[0] === 'identity') return json(identity);
    if (args[1] === 'status') return json({ hwnd: Number(hwnd), processId: 456, processName: 'app', windowTitle: state.tree.name, coordinateSpace: 'physical-screen-pixels' });
    if (args[1] === 'get-focused') return json({ hasFocus: false });
    if (args[1] === 'inspect') {
      if (args.includes('-i')) throw new Error('interactiveOnly must not use winapp -i');
      const depth = Number(args[args.indexOf('--depth') + 1]), dash = args.indexOf('--');
      const start = dash >= 0 ? find(state.tree, args[dash + 1]) ?? state.tree : state.tree;
      return json({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [cut(start, depth)] }] });
    }
    if (['invoke', 'expand', 'collapse', 'toggle', 'set-value', 'send-keys'].includes(args[1])) { state.dispatched.push(args[1]); return json({ hwnd: 1234 }); }
    return json({ hwnd: 1234 });
  };
}
async function harness(t, tree) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-m4-'));
  const state = { tree, calls: [], dispatched: [] };
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, verify: async () => {}, verifyBridge: async () => {}, verifyIndicator: async () => ({ available: true }), run: fakeWinapp(state) });
  const window = { id: '1234', pid: 456, processName: 'app', title: tree.name, processCreationTime: '100', sessionId: 1 };
  backend.listWindows = async () => [{ ...window, bounds: { x: null, y: null, width: tree.width, height: tree.height } }];
  const controller = createComputerController({ backend, runtimeDirectory: directory, observationTtlMs: 60000,
    lease: { acquire: async () => {}, assert: async () => {}, release: async () => {} },
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} } });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await controller.listWindows();
  const { sessionId } = await controller.openSession({ windowId: window.id });
  const observe = args => controller.observe({ sessionId, screenshot: 'none', ...args });
  return { controller, state, sessionId, observe };
}
const chars = value => JSON.stringify(value).length;
const named = (result, controlType, name) => result.elements.filter(element => element.controlType === controlType && element.name === name);
const linksValid = result => {
  const ids = new Set(result.elements.map(element => element.treeNodeId));
  return result.elements.every(element => element.parentNodeId === null || ids.has(element.parentNodeId));
};

test('M4 bar: Notepad at depth 6 keeps the Text editor Document', async t => {
  const h = await harness(t, trees.notepad());
  const full = await h.observe({ accessibilityDepth: 6 });
  const lean = await h.observe({ accessibilityDepth: 6, interactiveOnly: true });
  assert.equal(named(lean, 'Document', 'Text editor').length, 1);
  assert.ok(!lean.elements.some(element => ['Pane', 'Tab', 'List', 'MenuBar', 'TitleBar', 'Text'].includes(element.controlType)));
  assert.ok(linksValid(lean));
  console.log(`M4 Notepad d6: full ${chars(full)} chars, interactiveOnly ${chars(lean)} chars, ${lean.elements.length} elements`);
  assert.ok(chars(lean) < chars(full));
});

test('M4 bar: Firefox at depth 6 is at most 9,000 chars, keeps the page Document and drops Gecko structure', async t => {
  const h = await harness(t, trees.firefox());
  const full = await h.observe({ accessibilityDepth: 6 });
  const lean = await h.observe({ accessibilityDepth: 6, interactiveOnly: true });
  console.log(`M4 Firefox d6: full ${chars(full)} chars, interactiveOnly ${chars(lean)} chars, ${lean.elements.length} elements (bar 9000)`);
  assert.ok(chars(full) > 15000, 'the fixture is at the measured scale');
  assert.ok(chars(lean) <= 9000, `interactiveOnly was ${chars(lean)} chars`);
  assert.equal(named(lean, 'Document', 'Example Domain').length, 1);
  assert.equal(named(lean, 'Hyperlink', 'More info…').length, 1);
  assert.equal(named(lean, 'ComboBox', 'Search with Google or enter address').length, 1);
  // Every Gecko node is isInvokable; unnamed Groups, Separators, Panes and ToolBars still go.
  assert.ok(!lean.elements.some(element => ['Group', 'Separator', 'Pane', 'ToolBar', 'Tab', 'Text', 'Menu'].includes(element.controlType)));
  // Kept controls hang under their nearest kept ancestor: the URL field under the window root.
  const url = named(lean, 'ComboBox', 'Search with Google or enter address')[0];
  assert.equal(url.parentNodeId, lean.elements[0].treeNodeId);
  assert.ok(linksValid(lean));
});

// Owner decision, 3 November: the Save As bar is one unscoped depth-3 interactiveOnly read, the
// skill's starting depth. A whole-dialog depth-8 read grows by about 175 characters per row.
test('M4 bar: Save As at depth 3 is at most 10,000 chars', async t => {
  const h = await harness(t, trees.saveAs());
  const lean = await h.observe({ accessibilityDepth: 3, interactiveOnly: true });
  console.log(`M4 Save As d3: interactiveOnly ${chars(lean)} chars, ${lean.elements.length} elements (bar 10000)`);
  assert.ok(chars(lean) <= 10000, `interactiveOnly was ${chars(lean)} chars`);
  for (const [type, name] of [['Button', 'Save'], ['Button', 'Cancel'], ['ComboBox', 'File name:']]) assert.equal(named(lean, type, name).length, 1, `${type} ${name}`);
  assert.ok(linksValid(lean));
});

test('M4: Save As at depth 8 drops scroll parts, row fields, combo arrows and duplicate group headers', async t => {
  const h = await harness(t, trees.saveAs());
  const full = await h.observe({ accessibilityDepth: 8 });
  const lean = await h.observe({ accessibilityDepth: 8, interactiveOnly: true });
  console.log(`M4 Save As d8: full ${chars(full)} chars, interactiveOnly ${chars(lean)} chars, ${lean.elements.length} elements`);
  assert.ok(chars(full) > 20000, 'the fixture is at the measured scale');
  assert.equal(lean.elements.filter(element => element.controlType === 'ListItem').length, 4);
  // Each date group appears once and offers collapse itself; the header's Collapse Group button goes.
  const groups = lean.elements.filter(element => element.controlType === 'Group');
  assert.deepEqual(groups.map(group => group.name), ['Yesterday', 'Last week', 'Last month']);
  assert.ok(groups.every(group => group.secondaryActions?.includes('collapse')));
  assert.equal(named(lean, 'Button', 'Collapse Group').length, 0);
  assert.equal(lean.elements.filter(element => element.controlType === 'TreeItem').length, 8);
  for (const [type, name] of [['Edit', 'File name:'], ['Edit', 'Search Box'], ['Button', 'Save'], ['Button', 'Cancel'], ['ComboBox', 'Save as type:']])
    assert.equal(named(lean, type, name).length, 1, `${type} ${name}`);
  assert.ok(!lean.elements.some(element => ['ScrollBar', 'Thumb'].includes(element.controlType)));
  for (const name of ['Line up', 'Page down', 'Column left', 'Open', 'Date modified', 'Size'])
    assert.ok(!lean.elements.some(element => element.name === name && ['Button', 'Edit'].includes(element.controlType)), name);
  const rows = new Set(lean.elements.filter(element => element.controlType === 'ListItem').map(element => element.treeNodeId));
  assert.ok(!lean.elements.some(element => rows.has(element.parentNodeId)), 'row fields are dropped');
  assert.ok(linksValid(lean));
});

// The duplicate rule is narrow: only a Group whose nearest kept ancestor is a Group with the same
// name and expand state. A same-named folder inside a folder, or a same-named Group with another
// state, stays.
test('M4: the duplicate Group rule keeps nested same-named TreeItems and Groups whose state differs', async t => {
  const t0 = trees.saveAs();
  const n = (type, name, o = {}, children = []) => ({ type, name, isEnabled: true, isOffscreen: false, x: 20, y: 20, width: 40, height: 20,
    selector: `${type.slice(0, 3).toLowerCase()}-${name.toLowerCase().replace(/W+/g, '')}-${o.id}`, ...(o.exp ? { expandState: o.exp } : {}), children });
  t0.children.push(n('Tree', 'Extra', { id: 'a001' }, [n('TreeItem', 'Reports', { id: 'a002', exp: 'expanded' }, [n('TreeItem', 'Reports', { id: 'a003', exp: 'expanded' })]),
    n('Group', 'Pinned', { id: 'a004', exp: 'expanded' }, [n('Group', 'Pinned', { id: 'a005', exp: 'collapsed' }, [n('Button', 'Pin', { id: 'a006' })]),
      n('Group', 'Pinned', { id: 'a007' }, [n('Button', 'Unpin', { id: 'a008' })])])]));
  const h = await harness(t, t0);
  const lean = await h.observe({ accessibilityDepth: 8, interactiveOnly: true });
  assert.equal(named(lean, 'TreeItem', 'Reports').length, 2);
  assert.equal(named(lean, 'Group', 'Pinned').length, 2, 'the outer Group and the one with another expand state');
  assert.equal(named(lean, 'Button', 'Pin').length, 1);
  assert.equal(named(lean, 'Button', 'Unpin').length, 1, 'a stateless Group is not a duplicate, so its Button stays');
});

test('M4: the lean format omits className and default enabled, offscreen and secondaryActions, and still acts', async t => {
  const h = await harness(t, trees.saveAs());
  const full = await h.observe({ accessibilityDepth: 8 });
  const lean = await h.observe({ accessibilityDepth: 8, interactiveOnly: true });
  assert.ok(full.elements.some(element => 'className' in element && element.enabled === true && element.offscreen === false && Array.isArray(element.secondaryActions)));
  assert.ok(lean.elements.every(element => !('className' in element) && element.enabled !== true && element.offscreen !== false
    && (element.secondaryActions === undefined || element.secondaryActions.length > 0)));
  assert.equal(named(lean, 'Button', 'Back (Alt + Left Arrow)')[0].enabled, false);
  const folder = named(lean, 'TreeItem', 'AppData')[0];
  assert.deepEqual(folder.secondaryActions, ['expand']);
  // The action contract reads lean elements: a missing enabled is enabled, a missing secondaryActions offers none.
  assert.equal(validateAction({ type: 'accessibility_action', action: 'expand', elementId: folder.id }, lean).action, 'expand');
  assert.throws(() => validateAction({ type: 'accessibility_action', action: 'expand', elementId: named(lean, 'Button', 'Save')[0].id }, lean),
    error => error.code === 'unsupported_action');
  assert.throws(() => validateAction({ type: 'invoke', elementId: named(lean, 'Button', 'Back (Alt + Left Arrow)')[0].id }, lean),
    error => error.code === 'unknown_element');
  // The server-side snapshot keeps every field, so dispatch and its stale checks still work.
  const save = await h.controller.act({ sessionId: h.sessionId, observationId: lean.observationId,
    action: { type: 'invoke', elementId: named(lean, 'Button', 'Save')[0].id } });
  assert.equal(save.outcome, 'completed');
  assert.deepEqual(h.state.dispatched, ['invoke']);
  assert.equal(save.summary.changes.counts.changed, 0, 'a lean refresh diffs cleanly against a lean observation');
});

test('M4: rootElementId with interactiveOnly filters the subtree and never calls winapp -i', async t => {
  const h = await harness(t, trees.saveAs());
  const whole = await h.observe({ accessibilityDepth: 3 });
  const list = whole.elements.find(element => element.controlType === 'List' && element.name === 'Items View');
  const scoped = await h.observe({ accessibilityDepth: 4, rootElementId: list.id, interactiveOnly: true });
  assert.equal(scoped.elements[0].id, list.id);
  assert.equal(scoped.accessibility.rootElementId, list.id);
  assert.equal(scoped.accessibility.interactiveOnly, true);
  // Each expandable date group stays once and keeps its header's Name field; the rows' fields are dropped.
  assert.deepEqual([...new Set(scoped.elements.slice(1).map(element => element.controlType))].sort(), ['Button', 'Edit', 'Group', 'ListItem', 'SplitButton']);
  assert.equal(scoped.elements.filter(element => element.controlType === 'Group').length, 3);
  assert.equal(scoped.elements.filter(element => element.controlType === 'Edit').length, 3);
  assert.equal(scoped.elements.filter(element => element.controlType === 'ListItem').length, 4);
  assert.ok(linksValid(scoped));
  assert.ok(!h.state.calls.some(args => args.includes('-i')));
});

test('M4: keep rules for text, state and invokable nodes outside the structural types', async () => {
  const node = (selector, type, extra = {}, children = []) => ({ selector, type, name: selector, isEnabled: true, isOffscreen: false, x: 0, y: 0, width: 9, height: 9, ...extra, children });
  const tree = node('root', 'Window', {}, [
    node('text-value', 'Text', { value: '42 items' }), node('text-plain', 'Text'), node('text-blank', 'Text', { value: '  ' }),
    node('custom-inv', 'Custom', { isInvokable: true }), node('group-inv', 'Group', { isInvokable: true }), node('image-inv', 'Image', { isInvokable: true }),
    node('group-toggle', 'Group', { toggleState: 'off' }), node('group-expand', 'Group', { expandState: 'collapsed' }),
    node('sep', 'Separator', { isInvokable: true, toggleState: 'off' }), node('group-more', 'Group', { hasMoreChildren: true }),
    node('pane', 'Pane', {}, [node('btn-hoisted', 'Button')]),
  ]);
  const run = async () => json({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [tree] }] });
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, verify: async () => {}, verifyBridge: async () => {}, run });
  const result = await backend.inspect({ id: '1234', pid: 456 }, null, 6, { interactiveOnly: true });
  assert.deepEqual(result.elements.map(element => element.id), ['root', 'text-value', 'custom-inv', 'group-toggle', 'group-expand', 'group-more', 'btn-hoisted']);
  assert.equal(result.elements.at(-1).parentNodeId, result.elements[0].treeNodeId);
  assert.equal(result.filteredOut, 6);
  assert.equal(result.nodeCount, result.elements.length);
  const plain = await backend.inspect({ id: '1234', pid: 456 }, null, 6);
  assert.equal(plain.elements.length, 13);
  assert.equal(plain.filteredOut, undefined);
});

test('a documentElementId outside the observed tree names the fix and keeps stale_element', async () => {
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, verify: async () => {}, verifyBridge: async () => {}, run: async () => json({}) });
  const error = await backend.readDocument({ id: '1234', pid: 456 }, null, [], 'doc-text-editor').catch(value => value);
  assert.equal(error.code, 'stale_element');
  assert.match(error.message, /accessibilityDepth/); assert.match(error.message, /rootElementId/);
  assert.deepEqual({ code: safeError(error).code, reason: safeError(error).reason }, { code: 'stale_element', reason: 'not_in_observed_tree' });
});
