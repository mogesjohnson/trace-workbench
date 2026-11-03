'use strict';
// M7 (2.1.0 rerun defect D1): type_text compares the focused control's text before and after
// input, because SendInput reported success while Notepad dropped the second 16-character chunk.

const test = require('node:test');
const assert = require('node:assert/strict');
const { WinappBackend, pin } = require('../src/computer/winapp-backend.cjs');

const rect = { x: 100, y: 200, width: 300, height: 400 };
const window = { id: '1234', pid: 456, processName: 'TraceFixture', title: 'TRACE fixture', bounds: rect };
const doc = { selector: 'doc-text', name: 'Text editor', type: 'Document', isEnabled: true, isOffscreen: false, x: 110, y: 240, width: 280, height: 300 };
const root = () => ({ selector: 'win-tracefixture-a1b2', name: 'TRACE fixture', type: 'Window', isEnabled: true, ...rect, children: [{ ...doc }] });
const observation = () => ({ window: { ...window }, bounds: { ...rect }, uiaBounds: { ...rect }, frameBounds: { ...rect }, nativeWindowBounds: { ...rect },
  focused: { available: true, hasFocus: true, elementId: 'doc-text' }, elements: [
    { id: root().selector, name: 'TRACE fixture', controlType: 'Window', enabled: true, offscreen: false, bounds: { ...rect } },
    { id: 'doc-text', name: 'Text editor', controlType: 'Document', enabled: true, offscreen: false, bounds: { x: 110, y: 240, width: 280, height: 300 } }] });
const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });

// reads: the control text returned by successive document reads (the last one repeats).
function harness(reads) {
  const calls = [];
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', verify: async () => {}, verifyBridge: async () => {},
    verifyIndicator: async () => ({ available: true, integrity: 'verified', protocol: 1 }), run: async (executable, args) => {
      calls.push(args);
      if (args[0] === '--version') return { stdout: pin.version + '\n', stderr: '', exitCode: 0 };
      if (['identity', 'bounds', 'activate'].includes(args[0])) return json({ hwnd: '1234', pid: 456, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false });
      if (args[1] === 'status') return json({ hwnd: 1234, processId: 456, processName: 'TraceFixture', windowTitle: 'TRACE fixture', coordinateSpace: 'physical-screen-pixels' });
      if (args[1] === 'inspect') return json({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [root()] }] });
      if (args[1] === 'get-focused') return json({ hasFocus: true, element: { selector: 'doc-text', name: 'Text editor', type: 'Document' } });
      return json({ hwnd: 1234 });
    } });
  let index = 0;
  backend.readDocument = async () => {
    const text = reads[Math.min(index++, reads.length - 1)];
    return text === null ? { document: { available: false, reason: 'text_pattern_unavailable' } } : { document: { available: true, text, truncated: false } };
  };
  backend.reads = () => index;
  return { backend, calls };
}

test('type_text reports verified delivery when the control shows the typed text', async () => {
  const { backend, calls } = harness(['', 'trace-vs-ad trace 1']);
  const result = await backend.act({ window, observation: observation(), action: { type: 'type_text', text: 'trace-vs-ad trace 1' } });
  assert.deepEqual(result.textDelivery, { status: 'verified' });
  assert.ok(calls.some(args => args[1] === 'send-keys'));
});

test('type_text that loses its last chunk returns unknown with text_not_delivered (rerun D1)', async () => {
  const { backend } = harness(['', 'trace-vs-ad trac']);
  const started = Date.now();
  await assert.rejects(backend.act({ window, observation: observation(), action: { type: 'type_text', text: 'trace-vs-ad trace 1' } }), error => {
    assert.equal(error.code, 'text_not_delivered');
    assert.equal(error.details.outcome, 'unknown');
    assert.deepEqual(error.details.textDelivery, { status: 'missing', prefixFound: 16 });
    assert.match(error.message, /16 of 19/);
    return true;
  });
  assert.ok(Date.now() - started >= 1400, 'the check waits for late input before reporting');
});

test('late input within the polling window is verified, not reported missing', async () => {
  const { backend } = harness(['abc', 'abc', 'abc', 'abcxyz']);
  const result = await backend.act({ window, observation: observation(), action: { type: 'type_text', text: 'xyz' } });
  assert.deepEqual(result.textDelivery, { status: 'verified' });
});

test('text with Enter or Tab and unreadable controls are not checked', async () => {
  const withEnter = harness(['']);
  const entered = await withEnter.backend.act({ window, observation: observation(), action: { type: 'type_text', text: 'https://example.com\n' } });
  assert.deepEqual(entered.textDelivery, { status: 'not_checked', reason: 'control_characters' });
  assert.equal(withEnter.backend.reads(), 0);
  const unreadable = harness([null]);
  const result = await unreadable.backend.act({ window, observation: observation(), action: { type: 'type_text', text: 'hello' } });
  assert.deepEqual(result.textDelivery, { status: 'not_checked', reason: 'text_unreadable' });
  assert.equal(unreadable.backend.reads(), 1, 'an unreadable control is read once, before input only');
});

test('press_key carries no text check', async () => {
  const { backend } = harness(['']);
  const result = await backend.act({ window, observation: observation(), action: { type: 'press_key', key: 'enter' } });
  assert.equal(result.textDelivery, undefined);
  assert.equal(backend.reads(), 0);
});

test('the client error carries the bounded textDelivery and outcome unknown', () => {
  const { safeError } = require('../src/computer/controller.cjs');
  const projected = safeError(Object.assign(new Error('missing'), { code: 'text_not_delivered',
    details: { outcome: 'unknown', textDelivery: { status: 'missing', prefixFound: 16, typed: 'private text' } } }));
  assert.deepEqual(projected, { code: 'text_not_delivered', message: 'missing', outcome: 'unknown', textDelivery: { status: 'missing', prefixFound: 16 } });
});

// Rerun observation size: the lean (interactiveOnly) format, new in 2.1.0, also drops an
// automationId equal to the element ID and keeps only the naming fields of the window.
test('lean elements drop an automationId equal to the ID and keep a different one', () => {
  const { leanElement } = require('../src/computer/controller.cjs');
  assert.deepEqual(leanElement({ id: 'Close', name: 'Close', controlType: 'Button', automationId: 'Close', className: 'x', enabled: true, offscreen: false, secondaryActions: [] }),
    { id: 'Close', name: 'Close', controlType: 'Button' });
  assert.equal(leanElement({ id: 'cmb-urlbarinput-8ea3', automationId: 'urlbar-input' }).automationId, 'urlbar-input');
});

test('the lean window keeps id, pid, processName and title', () => {
  const { leanWindow } = require('../src/computer/controller.cjs');
  assert.deepEqual(leanWindow({ id: '26739568', pid: 65232, processName: 'firefox', title: 'Mozilla Firefox', bounds: rect,
    executable: 'C:\\Program Files\\WindowsApps\\Mozilla.Firefox\\firefox.exe', processCreationTime: '134382223735344095', sessionId: 1, ownerWindowId: null }),
  { id: '26739568', pid: 65232, processName: 'firefox', title: 'Mozilla Firefox' });
});

test('an interactiveOnly observation returns the lean envelope; the default mode is unchanged', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { createComputerController } = require('../src/computer/controller.cjs');
  const { DesktopLease } = require('../src/computer/lease.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-m7-test-'));
  const full = { ...window, executable: 'C:\Apps\fixture.exe', processCreationTime: '1', sessionId: 1, ownerWindowId: null };
  const focused = { available: true, hasFocus: true, elementId: 'Close', name: 'Close', controlType: 'Button', provenance: 'winapp-get-focused', binding: 'observed-control', nativeSelector: 'btn-close-1', focusPath: true };
  const targetState = { enabled: true, minimized: false, foreground: true, ownerWindowId: null, provenance: 'public-win32-dwm' };
  const backend = {
    async doctor() { return { ready: true }; },
    async listWindows() { return [{ ...full }]; },
    async observe() { return { window: { ...full }, bounds: { ...rect }, focused: { ...focused }, targetState: { ...targetState },
      elements: [{ id: 'Close', name: 'Close', controlType: 'Button', automationId: 'Close', className: 'b', enabled: true, offscreen: false, secondaryActions: [] }] }; },
    async act() { return { performed: true }; },
  };
  const indicator = { active: false, signal: new AbortController().signal, async start() { this.active = true; return { active: true, monitors: 1, protocol: 1 }; },
    assertActive() {}, async stop() { this.active = false; } };
  const controller = createComputerController({ backend, indicator, runtimeDirectory: directory, lease: new DesktopLease(path.join(directory, 'lease')) });
  t.after(async () => { await controller.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await controller.listWindows();
  const { sessionId } = await controller.openSession({ windowId: window.id });
  const lean = await controller.observe({ sessionId, screenshot: 'none', interactiveOnly: true });
  assert.deepEqual(lean.window, { id: '1234', pid: 456, processName: 'TraceFixture', title: 'TRACE fixture' });
  assert.deepEqual(lean.elements, [{ id: 'Close', name: 'Close', controlType: 'Button' }]);
  assert.deepEqual(lean.focused, { hasFocus: true, elementId: 'Close', name: 'Close', controlType: 'Button', binding: 'observed-control' });
  assert.deepEqual(lean.targetState, { enabled: true, minimized: false, foreground: true, ownerWindowId: null });
  const standard = await controller.observe({ sessionId, screenshot: 'none' });
  assert.deepEqual(standard.window, full);
  assert.deepEqual(standard.focused, focused);
  assert.deepEqual(standard.targetState, targetState);
  assert.equal(standard.elements[0].automationId, 'Close');
});
