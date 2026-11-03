'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { WinappBackend, verifyFiles, verifyBridgeFiles } = require('../computer/winapp-backend.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const digest = value => createHash('sha256').update(value).digest('hex');

function createInstalledApplications({ backend = new WinappBackend(), lease = backend.supervisor,
  spawnImpl = spawn, verify = async () => { await verifyFiles(backend.binaryPath); await verifyBridgeFiles(backend.bridgePath); }, timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail('application_config', 'Use a bounded launch deadline.');
  let apps = new Map(), busy = false;
  const attempted = new Set();
  async function file(executable) {
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== '.exe' || executable.includes('\0')) fail('application_path', 'Expected a registered absolute EXE path.');
    const real = await fs.realpath(executable), stat = await fs.stat(real, { bigint: true });
    if (!stat.isFile() || path.extname(real).toLowerCase() !== '.exe'
      || (process.platform === 'win32' && !/^[A-Za-z]:\\/.test(real))) fail('application_path', 'Canonical target must remain a local regular EXE.');
    return { executable: real, fingerprint: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
  }
  function inventory(value) {
    if (!value || !Array.isArray(value.applications) || value.applications.length > 2000 || typeof value.partial !== 'boolean'
      || typeof value.coverage !== 'string' || !Array.isArray(value.issues) || value.issues.length > 16
      || value.issues.some(issue => typeof issue !== 'string' || issue.length > 1024)) fail('invalid_app_catalog', 'Malformed native application inventory.');
    return value;
  }
  // `match` narrows discovery to matching registrations, so one launch does not verify the whole catalog.
  async function discover({ signal, match } = {}) {
    if (busy) fail('application_busy', 'A launch or discovery is already in flight.');
    busy = true; apps.clear();
    try {
      await verify(); const native = inventory(await backend.bridge('apps', null, signal));
      const windows = await backend.listWindows({ signal }), next = new Map(); let skipped = 0;
      for (const row of native.applications) {
        signal?.throwIfAborted();
        if (!row || typeof row.name !== 'string' || typeof row.registration !== 'string' || row.registration.length > 1024) fail('invalid_app_catalog', 'Malformed registration evidence.');
        if (match && !match(row)) continue;
        let actual; try { actual = await file(row.executable); } catch { skipped++; continue; }
        const appId = `app:${digest(canonical(actual.executable) + ':' + actual.fingerprint)}`;
        if (next.has(appId)) continue;
        const related = [];
        for (const window of windows) {
          if (!window.processCreationTime || !window.executable) continue;
          try { if (canonical(await fs.realpath(window.executable)) === canonical(actual.executable)) related.push({ ...window }); } catch { /* Unreadable path cannot establish an app relationship. */ }
        }
        next.set(appId, { appId, name: row.name.slice(0, 512), ...actual, registration: row.registration,
          registeredPath: row.executable, windows: related, verification: 'canonical-regular-exe' });
      }
      apps = next;
      return { applications: [...apps.values()].map(({ fingerprint, registeredPath, ...app }) => app),
        coverage: native.coverage, partial: native.partial || skipped > 0, issues: native.issues, skipped };
    } finally { busy = false; }
  }
  async function launch(appId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'signal')) fail('invalid_application_request', 'Launch options accept only a cancellation signal.');
    const { signal } = options;
    if (busy) fail('application_busy', 'A launch or discovery is already in flight.');
    if (typeof appId !== 'string' || !/^app:[a-f0-9]{64}$/.test(appId) || !apps.has(appId)) fail('unknown_application', 'Choose an ID from the current application catalog.');
    if (attempted.has(appId)) fail('application_already_attempted', 'Inspect the previous launch; no automatic replay is permitted.');
    if (!lease?.acquire || !lease?.release || !lease?.assert) fail('supervision_required', 'App launch needs native desktop ownership.');
    busy = true; const owner = randomUUID(); let acquired = false, child, result;
    try {
      await verify(); const app = apps.get(appId), native = inventory(await backend.bridge('apps', null, signal));
      if (!native.applications.some(row => row.registration === app.registration && row.executable === app.registeredPath)) fail('application_changed', 'Registration changed before launch.');
      const actual = await file(app.registeredPath);
      if (canonical(actual.executable) !== canonical(app.executable) || actual.fingerprint !== app.fingerprint) fail('application_changed', 'Executable changed before launch.');
      await lease.acquire(owner); acquired = true; await lease.assert(owner);
      const active = AbortSignal.any([...(signal ? [signal] : []), ...(lease.signal ? [lease.signal] : []), AbortSignal.timeout(timeoutMs)]);
      active.throwIfAborted(); attempted.add(appId);
      child = spawnImpl(app.executable, [], { shell: false, windowsHide: false, cwd: path.dirname(app.executable), stdio: 'ignore' });
      child.on('error', () => {});
      await new Promise((resolve, reject) => {
        const finish = error => { active.removeEventListener('abort', abort); child.off('spawn', ready); child.off('error', failed); error ? reject(error) : resolve(); };
        const ready = () => finish(), failed = error => finish(error), abort = () => finish(active.reason);
        child.once('spawn', ready); child.once('error', failed); active.addEventListener('abort', abort, { once: true });
        if (active.aborted) abort();
      });
      const readProcess = async () => {
        const value = await backend.bridge('process', null, active, [String(child.pid)]);
        if (value.pid !== child.pid || typeof value.processCreationTime !== 'string' || !/^[1-9]\d*$/.test(value.processCreationTime) || !Number.isInteger(value.sessionId) || value.sessionId < 0
          || typeof value.executable !== 'string' || canonical(await fs.realpath(value.executable)) !== canonical(app.executable)) fail('application_identity_changed', 'Actual launched process differs from the registered executable.');
        return value;
      };
      const process = await readProcess(); let candidates = [];
      while (!active.aborted) {
        await lease.assert(owner);
        candidates = (await backend.listWindows({ signal: active })).filter(window => window.pid === process.pid
          && window.processCreationTime === process.processCreationTime && window.sessionId === process.sessionId);
        if (candidates.length) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      active.throwIfAborted();
      if (!candidates.length) fail('application_window_unavailable', 'Launched process has no verified window.');
      const final = await readProcess();
      if (final.processCreationTime !== process.processCreationTime || final.sessionId !== process.sessionId) fail('application_identity_changed', 'Launched process lifetime changed.');
      const after = await file(app.registeredPath);
      if (after.fingerprint !== app.fingerprint || canonical(after.executable) !== canonical(app.executable)) fail('application_changed', 'Executable changed during launch.');
      const handoff = [];
      for (const window of candidates) handoff.push(await backend.currentVisualWindow(window, { signal: active }));
      result = { outcome: 'launched', appId, process, windows: handoff, ownership: 'created-process', applicationClosed: false };
    } catch (error) {
      const code = typeof error.code === 'string' ? error.code : error.name === 'TimeoutError' ? 'application_timeout' : error.name === 'AbortError' ? 'cancelled' : 'application_launch_failed';
      result = { outcome: child?.pid ? 'unknown' : 'not_dispatched', appId, code,
        ...(child?.pid ? { pid: child.pid } : {}), applicationClosed: false };
    } finally {
      if (acquired || lease.owner === owner) {
        try { await lease.release(owner); if (result) result.cleanup = 'confirmed'; }
        catch (error) { result = { ...result, outcome: child?.pid ? 'unknown' : 'not_dispatched', cleanup: 'unknown', cleanupCode: error.code || 'lease_release_failed' }; }
      }
      child?.unref(); busy = false;
    }
    return result;
  }
  return { discover, launch };
}
module.exports = { createInstalledApplications };
