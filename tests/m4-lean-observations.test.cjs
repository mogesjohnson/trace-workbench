'use strict';
// M4 (G4, G5): interactiveOnly drops unnamed structural leaves that winapp -i keeps, and a
// documentElementId outside the observed tree names the fix instead of a bare stale_element.
const test = require('node:test'), assert = require('node:assert/strict');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { safeError } = require('../src/computer/controller.cjs');

const window = { id: '1234', pid: 456 };
const box = (x, y, width, height) => ({ isEnabled: true, isOffscreen: false, x, y, width, height });
const node = (selector, type, name = '', children = [], extra = {}) => ({ selector, type, name, ...box(0, 0, 10, 10), ...extra, children });
// What winapp -i returned for Firefox and Save As: controls between empty, unnamed containers.
const interactive = node('win-main', 'Window', 'Main', [
  node('grp-empty-1', 'Group'), node('sep-1', 'Separator'), node('pane-empty', 'Pane', '', [node('grp-empty-2', 'Group')]),
  node('grp-named', 'Group', 'Bookmarks'), node('grp-invokable', 'Group', '', [], { isInvokable: true }),
  node('grp-toggle', 'Group', '', [], { toggleState: 'off' }),
  node('pane-host', 'Pane', '', [node('btn-ok', 'Button', 'OK', [], { isInvokable: true })]),
  node('grp-more', 'Group', '', [], { hasMoreChildren: true }),
]);
function backend(tree) {
  const run = async (_file, args) => {
    const elements = args[args.indexOf('--depth') + 1] === '1' ? [{ ...tree, children: [] }] : [tree];
    return { stdout: JSON.stringify({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements }] }), stderr: '', exitCode: 0 };
  };
  return new WinappBackend({ platform: 'win32', arch: 'x64', supervisor: null, verify: async () => {}, verifyBridge: async () => {}, run });
}

test('interactiveOnly prunes unnamed, actionless, childless Group, Separator and Pane nodes and keeps the rest', async () => {
  const result = await backend(interactive).inspect(window, null, 6, { interactiveOnly: true });
  const ids = result.elements.map(element => element.id);
  assert.deepEqual(ids, ['win-main', 'grp-named', 'grp-invokable', 'grp-toggle', 'pane-host', 'btn-ok', 'grp-more']);
  assert.equal(result.prunedContainers, 4, 'grp-empty-1, sep-1, grp-empty-2 and then its emptied pane-empty');
  // Parent links stay valid: every kept parent ID names a kept node.
  const nodes = new Set(result.elements.map(element => element.treeNodeId));
  assert.ok(result.elements.every(element => element.parentNodeId === null || nodes.has(element.parentNodeId)));
  assert.equal(result.nodeCount, result.elements.length + result.hierarchy.length);
  assert.equal(result.elements.find(element => element.id === 'btn-ok').parentNodeId, result.elements.find(element => element.id === 'pane-host').treeNodeId);
});

test('without interactiveOnly nothing is pruned', async () => {
  const result = await backend(interactive).inspect(window, null, 6);
  assert.ok(result.elements.some(element => element.id === 'grp-empty-1'));
  assert.equal(result.prunedContainers, undefined);
});

test('a documentElementId outside the observed tree names the fix and keeps stale_element', async () => {
  const error = await backend(interactive).readDocument(window, null, [], 'doc-text-editor').catch(value => value);
  assert.equal(error.code, 'stale_element');
  assert.match(error.message, /accessibilityDepth/); assert.match(error.message, /rootElementId/);
  assert.deepEqual({ code: safeError(error).code, reason: safeError(error).reason }, { code: 'stale_element', reason: 'not_in_observed_tree' });
});
