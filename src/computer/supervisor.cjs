'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_SUPERVISOR = path.join(ROOT, '.runtime', 'supervisor', 'bin', 'TraceSupervisor.exe');
const OUTPUTS = ['TraceSupervisor.exe', 'TraceSupervisor.dll', 'TraceSupervisor.runtimeconfig.json', 'TraceSupervisor.deps.json'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
const execFileAsync = promisify(execFile);

async function supervisorSourceHashes(root = ROOT) {
  const directory = path.join(root, 'native', 'TraceSupervisor');
  const names = (await fs.readdir(directory)).filter(name => /\.(cs|csproj)$/.test(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => {
    const relative = `native/TraceSupervisor/${name}`;
    return [relative, digest(await fs.readFile(path.join(root, relative)))];
  })));
}

async function verifySupervisorFiles(binaryPath = DEFAULT_SUPERVISOR, root = ROOT) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(binaryPath)), 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || JSON.stringify(manifest.sources) !== JSON.stringify(await supervisorSourceHashes(root))) throw failure('supervisor_stale', 'Native supervisor source changed; rebuild computer setup.');
    for (const name of OUTPUTS) {
      if (digest(await fs.readFile(path.join(path.dirname(binaryPath), name))) !== manifest.files?.[name]) throw failure('supervisor_integrity', 'Native supervisor output differs from its setup manifest.');
    }
    return { available: true, integrity: 'verified', protocol: 1 };
  } catch (error) {
    if (error.code?.startsWith('supervisor_')) throw error;
    throw failure('supervisor_unavailable', 'Native supervisor is not built. Run computer setup with the .NET 9 SDK.');
  }
}

async function configuration() {
  const { DEFAULT_BINARY, DEFAULT_BRIDGE, verifyFiles, verifyBridgeFiles } = require('./winapp-backend.cjs');
  const { DEFAULT_INDICATOR, verifyIndicatorFiles } = require('./activity-indicator.cjs');
  await verifyFiles(DEFAULT_BINARY);
  await verifyBridgeFiles(DEFAULT_BRIDGE);
  await verifyIndicatorFiles(DEFAULT_INDICATOR);
  const providers = {};
  for (const [name, location] of Object.entries({ winapp: DEFAULT_BINARY, bridge: DEFAULT_BRIDGE, indicator: DEFAULT_INDICATOR })) {
    providers[name] = { path: location, sha256: digest(await fs.readFile(location)) };
  }
  return { providers, allowControlled: false };
}

// One detached native owner per desktop session. The private pipe to this process is its only
// command channel; public MCP requests never supply executables, provider names or held inputs.
class NativeSupervisor {
  constructor({ binaryPath = DEFAULT_SUPERVISOR, spawnImpl = spawn, verify = verifySupervisorFiles, configure = configuration, parentIdentity, onDispatch = () => {}, onTestReleaseReady = () => {}, onStopped = () => {} } = {}) {
    this.binaryPath = binaryPath;
    this.spawnImpl = spawnImpl;
    this.verify = verify;
    this.configure = configure;
    this.parentIdentity = parentIdentity;
    this.onDispatch = onDispatch;
    this.onTestReleaseReady = onTestReleaseReady;
    this.onStopped = onStopped;
    this.lastStop = null;
    this.child = null;
    this.pending = new Map();
    this.nextId = 0;
    this.owner = null;
    this.ready = false;
    this.stopping = false;
    this.releaseErrors = new Map();
    this.abort = new AbortController();
    this.signal = this.abort.signal;
  }

  async identity() {
    if (this.parentIdentity) return this.parentIdentity();
    const result = await execFileAsync(this.binaryPath, ['identity', String(process.pid)], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const parsed = JSON.parse(result.stdout.trim());
    if (parsed.pid !== process.pid || !/^\d+$/.test(parsed.processCreationTime)) throw failure('supervisor_identity', 'Native parent identity could not be established.');
    return parsed.processCreationTime;
  }

  lost(error) {
    this.ready = false;
    if (!this.abort.signal.aborted) this.abort.abort(error);
    for (const { reject, cleanup } of this.pending.values()) { cleanup(); reject(error); }
    this.pending.clear();
  }

  async acquire(sessionId) {
    if (this.child) throw failure('desktop_busy', 'This controller already owns a desktop session.');
    await this.verify(this.binaryPath);
    const config = await this.configure();
    const created = await this.identity();
    this.abort = new AbortController(); this.signal = this.abort.signal;
    this.lastStop = null;
    this.stopping = false;
    let child;
    try { child = this.spawnImpl(this.binaryPath, ['session', String(process.pid), created], { detached: true, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: '1', WINAPP_UI_WORKFLOW_ID: undefined } }); }
    catch { throw failure('supervisor_unavailable', 'Native supervisor could not start.'); }
    this.child = child;
    this.exit = new Promise(resolve => child.once('close', (code, signal) => {
      this.lost(failure('supervisor_exited', 'Native owner exited; input requires recovery verification.', { outcome: 'unknown', recovery: { attempted: false, released: false, reason: 'process_exit_unconfirmed' } }));
      resolve({ code, signal });
    }));
    let helloResolve, helloReject;
    const hello = new Promise((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
    let helloSeen = false;
    let buffer = '';
    let diagnostics = 0;
    const protocolFailed = () => {
      const error = failure('supervisor_protocol', 'Native supervisor returned an invalid protocol envelope.', { outcome: 'unknown' });
      helloReject(error); this.lost(error); child.stdin.end();
    };
    child.once('error', () => { const error = failure('supervisor_unavailable', 'Native supervisor failed to start.'); helloReject(error); this.lost(error); });
    child.stdin.on('error', () => this.lost(failure('supervisor_disconnected', 'Native owner command pipe closed.', { outcome: 'unknown' })));
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) return protocolFailed();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let item;
        try { item = JSON.parse(line); } catch { protocolFailed(); return; }
        if (item.event === 'hello' && !helloSeen && item.version === 1 && item.pid === child.pid) { helloSeen = true; helloResolve(item); continue; }
        if (item.event === 'stopped') {
          const stop = { code: item.code || 'session_stopped' };
          if (item.physical === true && item.code === 'physical_escape' && Number.isFinite(item.stopLatencyMs)
            && item.stopLatencyMs >= 0 && Number.isSafeInteger(item.dispatchCount) && item.dispatchCount >= 0) {
            Object.assign(stop, { physical: true, stopLatencyMs: item.stopLatencyMs, dispatchCount: item.dispatchCount });
          }
          this.lastStop = stop;
          try { this.onStopped({ ...stop }); } catch {}
          this.ready = false;
          if (!this.signal.aborted) this.abort.abort(failure(item.code || 'session_stopped', 'Native owner stopped this session; close it after verifying input cleanup.', { outcome: 'unknown' }));
          continue;
        }
        if (item.event === 'dispatch' && this.pending.has(item.id) && Number.isInteger(item.pid) && typeof item.processCreationTime === 'string' && item.inJob === true) {
          try { this.onDispatch({ requestId: item.id, pid: item.pid, processCreationTime: item.processCreationTime, inJob: true,
            ...(Number.isSafeInteger(item.dispatchCount) && item.dispatchCount >= 0 ? { dispatchCount: item.dispatchCount } : {}) }); } catch {}
          continue;
        }
        if (item.event === 'test-release-ready' && this.pending.has(item.id)
          && /^[a-f0-9]{32}$/.test(item.token) && Number.isInteger(item.childPid)
          && typeof item.processCreationTime === 'string' && item.processExitConfirmed === true
          && item.physicalReleaseObserved === true && Array.isArray(item.declaredKeys)
          && item.declaredKeys.every(key => Number.isInteger(key) && key >= 1 && key <= 254)
          && Array.isArray(item.remainingDown) && item.remainingDown.length === 0) {
          try { this.onTestReleaseReady({ ...item }); } catch {}
          continue;
        }
        const pending = this.pending.get(item.id);
        if (!pending) { protocolFailed(); return; }
        this.pending.delete(item.id); pending.cleanup();
        if (item.error) {
          const details = { ...item.error, outcome: item.error.outcome ?? 'unknown', nativeSupervision: true };
          delete details.message; delete details.code;
          pending.reject(failure(item.error.code || 'supervisor_failed', item.error.message || 'Native supervised operation failed.', details));
        } else if (item.result && typeof item.result === 'object') pending.resolve(item.result);
        else { pending.reject(failure('supervisor_protocol', 'Native supervisor omitted its result.')); protocolFailed(); return; }
      }
    });
    child.stderr.on('data', chunk => { diagnostics += chunk.length; if (diagnostics > 8192) protocolFailed(); });
    let timer;
    try {
      await Promise.race([hello, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('supervisor_timeout', 'Native supervisor did not start within five seconds.')), 5000); })]);
      clearTimeout(timer);
      const result = await this.request('configure', config, { deadlineMs: 10000 });
      if (result.ready !== true || result.version !== 1 || !Number.isInteger(result.monitors) || result.monitors < 1) throw failure('supervisor_protocol', 'Native owner did not verify session readiness.');
      this.ready = true; this.owner = sessionId; this.readiness = result;
    } catch (error) {
      clearTimeout(timer);
      child.stdin.end();
      try { await this.waitExit(17000); }
      catch (cleanup) {
        this.owner = sessionId;
        error.details = { ...error.details, recovery: { attempted: false, released: false, reason: 'process_exit_unconfirmed' }, cleanupCode: cleanup.code };
        throw error;
      }
      this.child = null; this.owner = null;
      throw error;
    }
  }

  request(method, fields = {}, { signal, deadlineMs = 19000 } = {}) {
    if (!this.child || this.child.stdin.destroyed) return Promise.reject(failure('supervisor_unavailable', 'Native owner is unavailable.', { outcome: 'not_dispatched' }));
    if (signal?.aborted) return Promise.reject(failure('cancelled', 'Operation cancelled before native dispatch.', { outcome: 'not_dispatched' }));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const abort = () => { void this.request('cancel', { targetId: id }, { deadlineMs: 5000 }).catch(() => {}); };
      const timer = setTimeout(() => {
        this.pending.delete(id); signal?.removeEventListener('abort', abort);
        this.child?.stdin.end();
        const error = failure('supervisor_timeout', 'Native owner failed to confirm cleanup before its deadline.', { outcome: 'unknown', recovery: { attempted: false, released: false, reason: 'process_exit_unconfirmed' } });
        reject(error); this.lost(error);
      }, deadlineMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      this.child.stdin.write(JSON.stringify({ id, method, ...fields }) + '\n');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async assert(sessionId) {
    if (!this.ready || this.owner !== sessionId || this.signal.aborted) throw failure('session_stopped', 'Native desktop owner is unavailable or stopped. Close the session and inspect recovery.');
  }
  assertActive() {
    if (!this.ready || this.signal.aborted) throw failure('session_stopped', 'Native desktop session has stopped.');
  }
  async run(provider, args, { signal, timeoutMs = 15000, mutating = false } = {}) {
    this.assertActive();
    return this.request('run', { provider, args, declaredKeys: [], mutating, timeoutMs: Math.min(timeoutMs, 15000) }, { signal, deadlineMs: Math.min(timeoutMs, 15000) + 4500 });
  }
  async waitExit(timeoutMs) {
    let timer;
    try { return await Promise.race([this.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('supervisor_exit_unconfirmed', 'Native owner exit remains unconfirmed.')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async release(sessionId) {
    if (this.releaseErrors.has(sessionId)) throw this.releaseErrors.get(sessionId);
    if (!this.child || this.owner !== sessionId) return;
    this.stopping = true;
    this.ready = false;
    let error;
    try {
      if (this.child.stdin.destroyed) throw failure('supervisor_disconnected', 'Native close acknowledgment is unavailable.');
      const result = await this.request('close', {}, { deadlineMs: 19000 });
      if (result.closed !== true || result.cleanup !== 'confirmed') {
        throw failure('input_recovery_required', 'Native close did not confirm input cleanup. Inspect recovery before further input.');
      }
    } catch (caught) { error = caught; }
    // Always drain the owner, preserving a close failure even if exit succeeds.
    try { this.child.stdin.end(); } catch (caught) { error ??= caught; }
    try {
      const exit = await this.waitExit(19000);
      this.child = null; this.owner = null; this.ready = false;
      if (exit.code !== 0 || exit.signal) throw failure('supervisor_exit_unconfirmed', 'Native owner did not exit normally.');
    } catch (exitError) {
      if (error) error.cleanupCodes = [error.code || 'cleanup_failed', exitError.code || 'cleanup_failed'];
      else error = exitError;
    }
    if (error) {
      error.details = { ...error.details, cleanup: 'unknown',
        recovery: error.details?.recovery ?? { attempted: false, released: false, reason: 'input_release_unconfirmed' } };
      this.releaseErrors.set(sessionId, error);
      throw error;
    }
    return { cleanup: 'confirmed' };
  }
  indicator() {
    const native = this;
    return {
      get pid() { return null; }, get signal() { return native.signal; },
      start: async () => { native.assertActive(); return { active: true, monitors: native.readiness.monitors, protocol: 1, owner: 'native-supervisor' }; },
      assertActive: () => native.assertActive(),
      stop: async () => ({ stopped: !native.ready, deferredToNativeOwner: true }),
    };
  }
}

async function recovery(mode = '--check', { binaryPath = DEFAULT_SUPERVISOR } = {}) {
  if (!['--check', '--apply'].includes(mode)) throw failure('invalid_arguments', 'Use computer recover --check or --apply.');
  await verifySupervisorFiles(binaryPath);
  try {
    const result = await execFileAsync(binaryPath, ['recover', mode], { windowsHide: true, timeout: 19000, maxBuffer: 32768 });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    if (error.stdout) { try { return JSON.parse(error.stdout.trim()); } catch {} }
    throw failure('recovery_unavailable', 'Native recovery inspection failed.');
  }
}

module.exports = { NativeSupervisor, DEFAULT_SUPERVISOR, OUTPUTS, supervisorSourceHashes, verifySupervisorFiles, recovery, configuration };
