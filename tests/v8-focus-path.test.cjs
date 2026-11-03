'use strict';
// P0-5 (token cost incident): the focused control and its ancestors are included whatever the
// observed depth, so a shallow observation can still bind keyboard focus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');

const rect = { x: 0, y: 0, width: 1400, height: 1800 };
const window = { id: '1234', pid: 456, processName: 'firefox', title: 'Fixture' };
const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });
const urlbar = { selector: 'urlbar-input', automationId: 'urlbar-input', name: 'Search or enter address', type: 'Edit', className: 'urlbar', isEnabled: true, isOffscreen: false, x: 200, y: 60, width: 900, height: 30 };

// root > nav (depth 1) > [group (selectorless) > urlbar] + 40 buttons (depth 2) > ...
function tree() {
  const buttons = Array.from({ length: 40 }, (_, i) => ({ selector: `btn-${i}`, name: `Toolbar button ${i}`, type: 'Button', isEnabled: true, isOffscreen: false, x: 10 + i, y: 10, width: 20, height: 20, children: [] }));
  const group = { name: 'Address group', type: 'Group', isEnabled: true, isOffscreen: false, x: 190, y: 55, width: 920, height: 40, children: [{ ...urlbar, children: [] }] };
  const nav = { selector: 'nav-bar', name: 'Navigation', type: 'ToolBar', isEnabled: true, isOffscreen: false, x: 0, y: 50, width: 1400, height: 50, children: [group, ...buttons] };
  return { selector: 'win-root', name: 'Fixture', type: 'Window', isEnabled: true, isOffscreen: false, ...rect, children: [nav] };
}
function cut(node, depth) {
  const { children = [], ...rest } = node;
  if (depth <= 0) return children.length ? { ...rest, hasMoreChildren: true } : rest;
  return { ...rest, children: children.map(child => cut(child, depth - 1)) };
}
function chainTo(node, target) {
  if (node.selector === target) { const { children, ...rest } = node; return rest; }
  for (const child of node.children || []) {
    const below = chainTo(child, target);
    if (below) { const { children, ...rest } = node; return { ...rest, children: [below] }; }
  }
  return null;
}
const wrap = elements => ({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements }] });

function backendWith({ focus = { ...urlbar, selector: 'ed-transient-91' }, ancestors } = {}) {
  const calls = [];
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, verify: async () => {}, verifyBridge: async () => {}, verifyIndicator: async () => ({ available: true }), run: async (executable, args) => {
    calls.push(args);
    if (args[0] === 'bounds' || args[0] === 'activate') return json({ hwnd: '1234', pid: 456, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false, enabled: true });
    if (args[1] === 'status') return json({ hwnd: 1234, processId: 456, processName: 'firefox', windowTitle: 'Fixture', coordinateSpace: 'physical-screen-pixels' });
    if (args[1] === 'inspect' && args.includes('--ancestors')) {
      if (ancestors) return json(ancestors(args));
      // winapp resolves the transient focus selector; its chain uses the inspect selector.
      return json(wrap([chainTo(tree(), 'urlbar-input')]));
    }
    if (args[1] === 'inspect') return json(wrap([cut(tree(), Number(args[args.indexOf('--depth') + 1]))]));
    if (args[1] === 'get-focused') return json({ hasFocus: true, element: focus });
    return json({ hwnd: 1234 });
  } });
  return { backend, calls };
}
const observeShallow = backend => backend.observe({ window, depth: 1, includeScreenshot: false });
const typed = calls => calls.filter(args => args[1] === 'send-keys').length;

test('depth-1 observation includes the focused control and its ancestors, then type_text dispatches', async () => {
  const { backend, calls } = backendWith();
  const observation = await observeShallow(backend);
  assert.equal(observation.focused.binding, 'observed-control');
  assert.equal(observation.focused.elementId, 'urlbar-input');
  assert.equal(observation.focused.focusPath, true);
  // No duplicates: root and nav were already inspected; only the group and the edit are added.
  assert.deepEqual(observation.elements.map(e => e.id), ['win-root', 'nav-bar', 'urlbar-input']);
  const added = observation.elements.find(e => e.id === 'urlbar-input');
  const group = observation.hierarchy.find(n => n.focusPath);
  assert.equal(group.parentNodeId, observation.elements.find(e => e.id === 'nav-bar').treeNodeId);
  assert.equal(added.parentNodeId, group.nodeId);
  assert.equal(new Set([...observation.elements.map(e => e.treeNodeId), ...observation.hierarchy.map(n => n.nodeId)]).size, observation.elements.length + observation.hierarchy.length);

  const result = await backend.act({ window, observation, action: { type: 'type_text', text: 'example.com' } });
  assert.equal(result.performed, true);
  assert.equal(typed(calls), 1);
  // One chain read in observe() and one in dispatch(); the tree itself stays at depth 1.
  assert.equal(calls.filter(args => args[1] === 'inspect' && args.includes('--ancestors')).length, 2);
});

test('P0-5 size bar: a depth-1 observation with the focus path costs far less than the depth that reaches focus', async () => {
  const shallow = await observeShallow(backendWith().backend);
  const deep = await backendWith().backend.observe({ window, depth: 3, includeScreenshot: false });
  const size = o => JSON.stringify({ elements: o.elements, hierarchy: o.hierarchy, focused: o.focused }).length;
  assert.equal(deep.focused.binding, 'observed-control');
  assert.ok(size(shallow) <= size(deep) * 0.25, `${size(shallow)} vs ${size(deep)}`);
});

test('a focus path without AutomationId binds through the resolved chain target', async () => {
  const plain = { ...urlbar, automationId: undefined, selector: 'ed-stable-7' };
  const node = { ...plain };
  const { backend, calls } = backendWith({ focus: { ...plain, selector: 'ed-transient-91' },
    ancestors: () => wrap([{ ...cut(tree(), 0), hasMoreChildren: undefined, children: [{ ...cut(tree().children[0], 0), hasMoreChildren: undefined, children: [node] }] }]) });
  const observation = await observeShallow(backend);
  assert.equal(observation.focused.elementId, 'ed-stable-7');
  await backend.act({ window, observation, action: { type: 'press_key', key: 'enter' } });
  assert.equal(typed(calls), 1);
});

test('unresolvable focus paths keep focus unbound and keyboard input fails closed', async () => {
  const cases = {
    // Another window's root, a chain ending at a different control, a failed read and a forked chain.
    foreignRoot: () => wrap([{ ...urlbar, selector: 'other-root' }]),
    otherControl: () => wrap([{ ...cut(tree(), 0), children: [{ ...cut(tree().children[0], 0), children: [{ ...urlbar, selector: 'nav-bar', automationId: undefined }] }] }]),
    failed: () => { throw Object.assign(new Error('gone'), { code: 'element_not_found' }); },
    forked: () => wrap([{ ...cut(tree(), 0), children: [{ ...urlbar }, { ...urlbar, selector: 'b' }] }]),
  };
  for (const [name, ancestors] of Object.entries(cases)) {
    const { backend, calls } = backendWith({ ancestors });
    const observation = await observeShallow(backend);
    assert.equal(observation.focused.hasFocus, true, name);
    assert.equal(observation.focused.binding, 'unresolved', name);
    assert.equal(observation.elements.filter(e => e.id === 'nav-bar').length, 1, name);
    await assert.rejects(backend.act({ window, observation, action: { type: 'type_text', text: 'x' } }),
      error => error.code === 'focus_not_acquired' && error.details.outcome === 'not_dispatched', name);
    assert.equal(typed(calls), 0, name);
  }
});

test('an offscreen ancestor on the focus path is skipped unless includeOffscreen is set', async () => {
  const offChain = () => wrap([{ ...cut(tree(), 0), hasMoreChildren: undefined, children: [{ ...cut(tree().children[0], 0), hasMoreChildren: undefined,
    children: [{ selector: 'scroller', name: 'Scroller', type: 'Pane', isEnabled: true, isOffscreen: true, x: 0, y: 0, width: 5, height: 5, children: [{ ...urlbar }] }] }] }]);
  const hidden = await observeShallow(backendWith({ ancestors: offChain }).backend);
  assert.deepEqual(hidden.elements.map(e => e.id), ['win-root', 'nav-bar', 'urlbar-input']);
  assert.equal(hidden.elements[2].parentNodeId, hidden.elements[1].treeNodeId);
  const shown = await backendWith({ ancestors: offChain }).backend.observe({ window, depth: 1, includeScreenshot: false, includeOffscreen: true });
  assert.deepEqual(shown.elements.map(e => e.id), ['win-root', 'nav-bar', 'scroller', 'urlbar-input']);
});
