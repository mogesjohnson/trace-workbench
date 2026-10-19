'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertScroll, assertChord, assertDrag, resultState, waitForOwnedProcessExit, rejectedModalParentAction } = require('../scripts/smoke-computer-live.cjs');

test('scroll evidence rejects a requested offset when the visible viewport stayed still', () => {
  assert.throws(() => assertScroll({ scrollY: 96, scrollRowOffset: 0 }, 96));
  assert.throws(() => assertScroll({ scrollY: 0, scrollRowOffset: 96 }, 96));
});

test('reverse scroll cannot pass using the previous maximum offset', () => {
  assert.throws(() => assertScroll({ scrollY: 96, scrollRowOffset: 0 }, 0));
  assert.doesNotThrow(() => assertScroll({ scrollY: 0, scrollRowOffset: 0 }, 0));
});

test('drag evidence rejects wrong Y, duplicate drops, or a button still held', () => {
  const expected = { x: 100, y: 46, drops: 1, starts: 1 };
  const receipt = { dragX: 100, dragY: 46, dragDrops: 1, dragStarts: 1, dragPressed: false, leftButtonDown: false };
  assert.doesNotThrow(() => assertDrag(receipt, expected));
  assert.throws(() => assertDrag({ ...receipt, dragY: 47 }, expected));
  assert.throws(() => assertDrag({ ...receipt, dragDrops: 2 }, expected));
  assert.throws(() => assertDrag({ ...receipt, leftButtonDown: true }, expected));
});

test('chord evidence requires exact selection, unchanged text and released modifiers', () => {
  const text = 'TRACE acceptance';
  const receipt = { chord: 'ctrl+d', text, selectedText: 'TRACE', selectionStart: 0, selectionLength: 5,
    controlPressed: false, shiftPressed: false, altPressed: false, modifiers: 'None' };
  assert.doesNotThrow(() => assertChord(receipt, text));
  assert.throws(() => assertChord({ ...receipt, selectedText: '', selectionLength: 0 }, text));
  assert.throws(() => assertChord({ ...receipt, text: `${text}d` }, text));
  assert.throws(() => assertChord({ ...receipt, controlPressed: true }, text));
});

test('a scoped pass with blocked or unrun required cases keeps the milestone incomplete', () => {
  for (const status of ['blocked', 'not_run']) {
    assert.deepEqual(resultState([{ status: 'pass' }, { status }]), { result: 'passed', milestoneStatus: 'incomplete' });
  }
});

test('case failures and external failures cannot publish a passing or complete result', () => {
  assert.deepEqual(resultState([{ status: 'pass' }, { status: 'fail' }]), { result: 'failed', milestoneStatus: 'incomplete' });
  assert.deepEqual(resultState([{ status: 'pass' }], true), { result: 'failed', milestoneStatus: 'incomplete' });
});

test('server teardown requires ESRCH, not a successful close call or a live PID', async () => {
  await assert.rejects(waitForOwnedProcessExit(123, { timeoutMs: 0, probe: () => true }), { code: 'process_exit_unconfirmed' });
  const gone = await waitForOwnedProcessExit(123, { probe: (pid, signal) => {
    assert.equal(pid, 123);
    assert.equal(signal, 0, 'Exit verification must never signal or kill another process');
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  assert.equal(gone.exited, true);
});

test('permission and probe errors cannot be converted into successful cleanup', async () => {
  const denied = Object.assign(new Error('not allowed'), { code: 'EPERM' });
  await assert.rejects(waitForOwnedProcessExit(123, { probe: () => { throw denied; } }), (error) => error === denied);
});

test('a checkpoint remains running even if its completed cases passed; only finalization yields a scoped pass', () => {
  const cases = [{ status: 'pass' }, { status: 'not_run' }];
  assert.deepEqual(resultState(cases, false, false), { result: 'running', milestoneStatus: 'incomplete' });
  assert.deepEqual(resultState(cases, false, true), { result: 'passed', milestoneStatus: 'incomplete' });
  assert.deepEqual(resultState([{ status: 'pass' }], false, false), { result: 'running', milestoneStatus: 'incomplete' });
  assert.deepEqual(resultState([{ status: 'pass' }], false, true), { result: 'passed', milestoneStatus: 'complete' });
});

test('modal safety accepts only known pre-input guards, regardless of descendant UIA enabled flags', async () => {
  for (const code of ['window_blocked', 'foreground_not_target', 'stale_element']) {
    assert.equal(await rejectedModalParentAction(async () => ({ outcome: 'unknown', error: { code } })), code);
  }
  assert.equal(await rejectedModalParentAction(async () => { throw Object.assign(new Error('disabled'), { code: 'unknown_element' }); }), 'unknown_element');
  await assert.rejects(rejectedModalParentAction(async () => ({ outcome: 'completed' })));
  await assert.rejects(rejectedModalParentAction(async () => ({ outcome: 'unknown', error: { code: 'cancelled' } })));
  await assert.rejects(rejectedModalParentAction(async () => ({ outcome: 'unknown', error: { code: 'foreground_not_target', inputRecoveryRequired: true } })));
  const badIdentity = Object.assign(new Error('wrong fixture PID'), { code: 'ERR_ASSERTION' });
  await assert.rejects(rejectedModalParentAction(async () => { throw badIdentity; }), (error) => error === badIdentity);
});
