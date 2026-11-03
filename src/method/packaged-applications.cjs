'use strict';
const { randomUUID } = require('node:crypto');
const { WinappBackend, verifyFiles, verifyBridgeFiles } = require('../computer/winapp-backend.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Starts a packaged app by AUMID through the window bridge (IApplicationActivationManager, no shell
// process). A window is the app's only when it is new since the pre-launch snapshot and its own
// process, or the CoreWindow it hosts (ApplicationFrameHost frames), reports the activated AUMID.
// An instance that is already open is reported and never activated: the owner's windows are off limits.
function createPackagedApplications({ backend = new WinappBackend(), lease = backend.supervisor,
  verify = async () => { await verifyFiles(backend.binaryPath); await verifyBridgeFiles(backend.bridgePath); }, timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail('application_config', 'Use a bounded launch deadline.');
  let busy = false;
  const attempted = new Set();
  async function identities(windows, signal) {
    const result = new Map();
    for (let offset = 0; offset < windows.length; offset += 100) {
      const batch = windows.slice(offset, offset + 100);
      const native = await backend.bridge('packaged-identities', null, signal, batch.map(window => `${window.id}:${window.pid}`));
      if (!Array.isArray(native?.windows) || native.windows.length !== batch.length) fail('invalid_native_response', 'Packaged identity batch did not return every requested window.');
      for (const item of native.windows) result.set(`${item.hwnd}:${item.pid}`, item);
    }
    return result;
  }
  const runs = (identity, aumid) => !!identity && !identity.identityError
    && (same(identity.aumid, aumid) || (Array.isArray(identity.hosted) && identity.hosted.some(hosted => same(hosted?.aumid, aumid))));
  async function matching(windows, aumid, signal) {
    if (!windows.length) return [];
    const found = await identities(windows, signal);
    return windows.filter(window => runs(found.get(`${window.id}:${window.pid}`), aumid));
  }
  async function launch({ aumid, uri } = {}, { signal } = {}) {
    if (busy) fail('application_busy', 'A launch or discovery is already in flight.');
    if (typeof aumid !== 'string' || !aumid) fail('invalid_application_request', 'An AUMID is required.');
    if (uri !== undefined && typeof uri !== 'string') fail('invalid_application_request', 'A protocol page must be a string.');
    const key = `${aumid.toLowerCase()}|${uri ?? ''}`;
    if (attempted.has(key)) fail('application_already_attempted', 'Inspect the previous launch; no automatic replay is permitted.');
    if (!lease?.acquire || !lease?.release || !lease?.assert) fail('supervision_required', 'App launch needs native desktop ownership.');
    busy = true; const owner = randomUUID(); let acquired = false, activated = null, dispatched = false, result, deadline;
    try {
      await verify();
      const resolved = await backend.bridge('packaged', null, signal, [aumid]);
      if (!same(resolved?.aumid, aumid)) fail('application_changed', 'The package catalog returned a different AUMID.');
      await lease.acquire(owner); acquired = true; await lease.assert(owner);
      const held = AbortSignal.any([...(signal ? [signal] : []), ...(lease.signal ? [lease.signal] : [])]);
      const windowKey = window => `${window.id}:${window.pid}:${window.processCreationTime ?? ''}`;
      const snapshot = await backend.listWindows({ signal: held });
      if ((await matching(snapshot, resolved.aumid, held)).length) fail('already_running', 'An instance is already open; it was not activated.');
      const before = new Set(snapshot.map(windowKey));
      deadline = AbortSignal.timeout(timeoutMs);
      const active = AbortSignal.any([held, deadline]);
      active.throwIfAborted(); attempted.add(key); dispatched = true;
      activated = await backend.bridge('activate-package', null, active, uri ? [resolved.aumid, uri] : [resolved.aumid]);
      if (!Number.isInteger(activated?.pid) || activated.pid < 0) fail('invalid_native_response', 'Activation returned no process ID.');
      let candidates = [];
      while (!active.aborted) {
        await lease.assert(owner);
        const fresh = (await backend.listWindows({ signal: active })).filter(window => !before.has(windowKey(window)));
        candidates = await matching(fresh, resolved.aumid, active);
        if (candidates.length) { candidates = candidates.filter(window => window.pid === candidates[0].pid); break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      active.throwIfAborted();
      const windows = [];
      for (const window of candidates) {
        const current = await backend.currentVisualWindow(window, { signal: active });
        if (current.pid !== window.pid || current.processCreationTime !== window.processCreationTime) fail('window_identity_changed', 'The packaged window changed before it was returned.');
        windows.push(current);
      }
      const first = windows[0];
      const ownership = first.pid === activated.pid ? 'created-process' : 'handed-off';
      result = { outcome: 'launched', aumid: resolved.aumid, process: { pid: first.pid, processCreationTime: first.processCreationTime, sessionId: first.sessionId, executable: first.executable },
        windows, ownership, activatedPid: activated.pid, applicationClosed: false };
    } catch (error) {
      const code = deadline?.aborted && !signal?.aborted && !lease.signal?.aborted ? 'application_timeout' : typeof error.code === 'string' ? error.code : error.name === 'TimeoutError' ? 'application_timeout' : error.name === 'AbortError' ? 'cancelled' : 'application_launch_failed';
      // Refusals before COM activation started nothing. Anything after it may have started the app.
      const before = !dispatched || ['application_unsupported', 'unknown_application', 'invalid_arguments'].includes(code);
      result = { outcome: before ? 'not_dispatched' : 'unknown', aumid, code, ...(activated?.pid ? { pid: activated.pid } : {}), applicationClosed: false };
    } finally {
      if (acquired || lease.owner === owner) {
        try { await lease.release(owner); if (result) result.cleanup = 'confirmed'; }
        catch (error) { result = { ...result, outcome: dispatched ? 'unknown' : 'not_dispatched', cleanup: 'unknown', cleanupCode: error.code || 'lease_release_failed' }; }
      }
      busy = false;
    }
    return result;
  }
  return { launch };
}
module.exports = { createPackagedApplications };
