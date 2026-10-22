'use strict';

// Private acceptance preparation, never a production input fallback. Import has no
// desktop effect. The caller supplies an exact anchor and fresh independent proof.
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DesktopLease } = require('../src/computer/lease.cjs');
const { DEFAULT_BRIDGE, verifyBridgeFiles, runProcess, parseJson } = require('../src/computer/winapp-backend.cjs');

const knownCodes = new Set(['desktop_busy', 'lease_unavailable', 'lease_lost', 'cancelled',
  'bridge_stale', 'bridge_integrity', 'bridge_unavailable', 'window_closed', 'window_identity_changed',
  'window_blocked', 'foreground_not_target', 'foreground_access_denied', 'native_timeout', 'native_terminated',
  'engine_unavailable', 'invalid_native_response', 'window_bridge_failed', 'native_error',
  'preparation_anchor_invalid', 'preparation_anchor_changed', 'preparation_safety_unavailable',
  'preparation_input_held', 'preparation_recovery_required', 'preparation_operation_active',
  'preparation_cleanup_unknown', 'preparation_failed']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => knownCodes.has(error?.code) ? error.code : 'preparation_failed';
const decimal = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
  && Number.isSafeInteger(Number(value));

function exactAnchor(value) {
  const hwnd = value?.hwnd ?? value?.id;
  if (!decimal(hwnd) || (value.hwnd !== undefined && value.id !== undefined && value.hwnd !== value.id)
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffffffff
    || typeof value.processCreationTime !== 'string' || !/^[1-9]\d{0,18}$/.test(value.processCreationTime)
    || BigInt(value.processCreationTime) > 0x7fffffffffffffffn
    || !Number.isSafeInteger(value.sessionId) || value.sessionId < 0) fail('preparation_anchor_invalid');
  return { hwnd, pid: value.pid, processCreationTime: value.processCreationTime, sessionId: value.sessionId };
}
function matches(actual, expected) {
  if (!actual || actual.hwnd !== expected.hwnd || actual.pid !== expected.pid
    || actual.processCreationTime !== expected.processCreationTime || actual.sessionId !== expected.sessionId) {
    fail('preparation_anchor_changed');
  }
}
function safe(proof) {
  if (!proof || proof.available !== true || proof.input?.available !== true
    || !Array.isArray(proof.input.down) || proof.recovery?.available !== true
    || typeof proof.recovery.recoveryRequired !== 'boolean') fail('preparation_safety_unavailable');
  if (proof.input.down.length) fail('preparation_input_held');
  if (proof.recovery.recoveryRequired || proof.recovery.ready !== true) fail('preparation_recovery_required');
  // leaseActive refers to the prior/native controller, not this helper's private
  // exclusion lease. These are trusted harness observations, not inferred here.
  if (proof.leaseActive !== false || proof.nativeOperationActive !== false
    || proof.inputChildExitVerified !== true) fail('preparation_operation_active');
}
async function fixedBridge(verb, anchor, { signal } = {}) {
  if (!['identity', 'bounds', 'activate'].includes(verb)) fail('preparation_failed');
  const result = await runProcess(DEFAULT_BRIDGE, [verb, anchor.hwnd, String(anchor.pid)], {
    signal, timeoutMs: 5000, maxOutputBytes: 32768,
  });
  return parseJson(result.stdout, result.stderr, result.exitCode);
}

/**
 * Optional private fixture preparation after the preceding native session is
 * closed, all input independently released, recovery clear and owned child exit
 * verified. Holds the actual global TRACE exclusion lease while activating only
 * the supplied anchor. It sends no keys/clicks, applies no recovery, launches no
 * application and takes no capture. The bridge's activation pins HWND/PID, not an
 * atomic expected creation/session tuple: pre/post checks detect lifetime changes
 * without claiming an OS compare-and-activate guarantee. Fresh next-cell guards
 * remain mandatory. Injected lease/verifier/bridge callbacks are pure-test seams.
 */
async function prepareAcceptanceForeground({ anchor, inspectSafety, signal,
  lease, verifyBridge = verifyBridgeFiles, bridge = fixedBridge } = {}) {
  const result = { preparation: 'fixture-foreground-anchor', prepared: false,
    activationAttempted: false, cleanupConfirmed: true, code: null };
  let acquired = false, owner;
  const abort = () => { if (signal?.aborted) fail('cancelled'); };
  try {
    const target = exactAnchor(anchor);
    if (typeof inspectSafety !== 'function' || typeof verifyBridge !== 'function' || typeof bridge !== 'function') {
      fail('preparation_safety_unavailable');
    }
    owner = `acceptance-foreground-${randomUUID()}`;
    lease ??= new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
    if (!['acquire', 'assert', 'release'].every(key => typeof lease[key] === 'function')) fail('preparation_safety_unavailable');
    abort();
    await lease.acquire(owner); acquired = true; result.cleanupConfirmed = false;
    await lease.assert(owner); abort();
    safe(await inspectSafety()); abort();
    await verifyBridge(DEFAULT_BRIDGE); abort();
    matches(await bridge('identity', target, { signal }), target);
    const before = await bridge('bounds', target, { signal }); matches(before, target);
    if (before.enabled !== true) fail('window_blocked');
    safe(await inspectSafety()); abort();
    await lease.assert(owner);
    matches(await bridge('identity', target, { signal }), target); abort();
    result.activationAttempted = true;
    const activated = await bridge('activate', target, { signal }); matches(activated, target);
    if (activated.foreground !== true || activated.minimized !== false || activated.enabled !== true) fail('foreground_not_target');
    await verifyBridge(DEFAULT_BRIDGE); abort();
    matches(await bridge('identity', target, { signal }), target);
    const after = await bridge('bounds', target, { signal }); matches(after, target);
    if (after.foreground !== true || after.minimized !== false || after.enabled !== true) fail('foreground_not_target');
    safe(await inspectSafety()); abort(); await lease.assert(owner);
    result.prepared = true;
  } catch (error) { result.code = codeOf(error); }
  finally {
    if (acquired) {
      try { await lease.release(owner); result.cleanupConfirmed = true; }
      catch { result.prepared = false; result.cleanupConfirmed = false; result.code = 'preparation_cleanup_unknown'; }
    }
  }
  return result;
}

module.exports = { prepareAcceptanceForeground };
