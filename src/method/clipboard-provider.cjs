'use strict';
// Explicit text-only transactions. Snapshot contents remain in the source-owned helper;
// plaintext requests use inherited stdio, never argv, environment variables, or logs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CLIPBOARD = path.join(ROOT, '.runtime/clipboard/bin/TraceClipboard.exe');
const CLIPBOARD_SOURCES = ['native/TraceClipboard/TraceClipboard.csproj', 'native/TraceClipboard/Program.cs',
  'native/TraceClipboard/ClipboardService.cs', 'native/TraceClipboard/Win32Clipboard.cs', 'native/TraceClipboard/SelfTests.cs'];
const CLIPBOARD_OUTPUTS = ['TraceClipboard.exe', 'TraceClipboard.dll', 'TraceClipboard.deps.json', 'TraceClipboard.runtimeconfig.json'];
const failure = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tokenValid = token => typeof token === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(token);
const sequenceValid = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const commands = new Set(['info', 'snapshot', 'write_text', 'readback', 'defer_restore', 'restore', 'recover', 'recovery_info', 'abandon', 'close']);

async function clipboardSourceHashes(root = ROOT) {
  const hashes = {};
  for (const file of CLIPBOARD_SOURCES) hashes[file] = hash(await fs.readFile(path.join(root, file)));
  return hashes;
}
async function verifyClipboardFiles(binaryPath = DEFAULT_CLIPBOARD, root = ROOT) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(binaryPath)), 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || JSON.stringify(manifest.sources) !== JSON.stringify(await clipboardSourceHashes(root))) throw failure('clipboard_helper_stale');
    for (const file of CLIPBOARD_OUTPUTS) if (hash(await fs.readFile(path.join(path.dirname(binaryPath), file))) !== manifest.files?.[file]) throw failure('clipboard_helper_integrity');
    return { verified: true };
  } catch (error) { throw failure(error.code?.startsWith('clipboard_') ? error.code : 'clipboard_helper_unavailable'); }
}

function createClipboardTransport({ helperPath = DEFAULT_CLIPBOARD, timeoutMs = 4000, spawnImpl = spawn } = {}) {
  if (!path.isAbsolute(helperPath) || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw failure('clipboard_transport_config');
  let child, pending = null, buffer = '', closed = false, killTimer;
  const stop = code => {
    closed = true;
    if (pending) { clearTimeout(pending.timer); const rejected = pending.reject; pending = null; rejected(failure(code)); }
    child?.stdin.end();
    if (child && child.exitCode === null) { killTimer = setTimeout(() => child.kill(), 1200); killTimer.unref(); }
  };
  const start = () => {
    if (closed) throw failure('clipboard_transport_closed');
    if (child) return;
    child = spawnImpl(helperPath, ['--stdio'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.on('error', () => stop('clipboard_helper_unavailable'));
    child.on('close', () => { clearTimeout(killTimer); stop('clipboard_transport_uncertain'); });
    child.stdin.on('error', () => stop('clipboard_transport_uncertain'));
    child.stdout.on('data', bytes => {
      buffer += bytes.toString('utf8');
      if (Buffer.byteLength(buffer) > 512 * 1024) { stop('clipboard_response_limit'); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let response;
        try { response = JSON.parse(line); } catch { stop('clipboard_invalid_response'); return; }
        if (!pending || response.id !== pending.id) { stop('clipboard_invalid_response'); return; }
        const current = pending; pending = null; clearTimeout(current.timer);
        if (response.error) {
          const code = typeof response.error.code === 'string' && /^clipboard_[a-z_]+$/.test(response.error.code)
            ? response.error.code : 'clipboard_operation_failed';
          current.reject(failure(code));
        } else current.resolve(response.result);
      }
    });
  };
  return {
    async request(command, fields = {}) {
      if (!commands.has(command) || pending) throw failure(pending ? 'clipboard_busy' : 'clipboard_invalid_command');
      start();
      const id = randomUUID();
      const message = JSON.stringify({ id, command, ...fields }) + '\n';
      if (Buffer.byteLength(message) > 300000) throw failure('clipboard_request_limit');
      return new Promise((resolve, reject) => {
        pending = { id, resolve, reject, timer: setTimeout(() => stop('clipboard_transport_uncertain'), timeoutMs) };
        child.stdin.write(message, 'utf8', error => { if (error) stop('clipboard_transport_uncertain'); });
      });
    },
    async dispose() {
      if (!child) { closed = true; return; }
      child.stdin.end();
      if (child.exitCode !== null) { closed = true; return; }
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
      closed = true;
    }
  };
}

function createClipboardProvider({ environment = 'local', id = `clipboard:${environment}`, transport,
  helperPath = DEFAULT_CLIPBOARD, timeoutMs = 4000, platform = process.platform,
  verify = verifyClipboardFiles } = {}) {
  if (typeof environment !== 'string' || !environment || typeof id !== 'string' || !id) throw failure('clipboard_provider_config');
  const injected = !!transport;
  let wire = transport, active = null, busy = false, closed = false, lastClose = null;
  const exclusive = async work => {
    if (busy) throw failure('clipboard_busy');
    if (closed) throw failure('clipboard_provider_closed');
    busy = true; try { return await work(); } finally { busy = false; }
  };
  const request = async (command, fields) => {
    if (!wire || typeof wire.request !== 'function') throw failure('clipboard_provider_unavailable');
    try { return await wire.request(command, fields); }
    catch (error) { throw failure(typeof error.code === 'string' && /^clipboard_[a-z_]+$/.test(error.code) ? error.code : 'clipboard_transport_uncertain'); }
  };
  const requireToken = token => {
    if (!active || !tokenValid(token) || active.token !== token) throw failure('clipboard_transaction_mismatch');
  };
  const provider = {
    id, channel: 'app-connector', usesDesktop: false, available: false,
    environments: [environment], apps: ['clipboard'], capabilities: ['clipboard-text-transaction'],
    constraints: { mode: 'text-only', supportedFormats: [1, 7, 13, 16],
      acquireDesktopLease: false, snapshotContentReturned: false, recovery: 'dpapi-current-user',
      clipboardScope: 'current interactive window station; caller owns paste/input targeting' },
    doctor() { return exclusive(async () => {
      provider.available = false;
      if (!injected && platform !== 'win32') return { ready: false, code: 'clipboard_unsupported_platform' };
      try {
        if (!injected) { await verify(helperPath); wire ??= createClipboardTransport({ helperPath, timeoutMs }); }
        const response = await request('info');
        if (response?.version !== 1 || response.mode !== 'text-only' || response.desktopInput !== false) throw failure('clipboard_invalid_response');
        provider.available = response.ready === true;
        return { ready: provider.available, mode: 'text-only', recoveryPending: response.recoveryPending === true,
          code: provider.available ? null : 'clipboard_recovery_required', transport: injected ? 'injected' : 'source-owned-private-stdio' };
      } catch (error) { return { ready: false, code: error.code || 'clipboard_provider_unavailable' }; }
    }); },
    snapshot() { return exclusive(async () => {
      if (!provider.available) throw failure('clipboard_provider_unavailable');
      if (active) throw failure('clipboard_transaction_active');
      const response = await request('snapshot');
      if (!tokenValid(response?.token) || !sequenceValid(response.sequence) || response.mode !== 'text-only'
        || !Array.isArray(response.formats) || response.formats.length > 4
        || new Set(response.formats.map(f => f.id)).size !== response.formats.length
        || response.formats.some(f => ![1, 7, 13, 16].includes(f.id) || !Number.isInteger(f.bytes) || f.bytes < 1
          || f.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.sha256))) throw failure('clipboard_invalid_response');
      active = { token: response.token, attempted: false, sha256: null };
      return { token: response.token, sequence: response.sequence, mode: 'text-only',
        formats: response.formats.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })), snapshotContentReturned: false };
    }); },
    writeText({ token, text } = {}) { return exclusive(async () => {
      requireToken(token);
      if (typeof text !== 'string' || text.length > 65536 || text.includes('\0') || !text.isWellFormed()) throw failure('clipboard_invalid_text');
      if (active.attempted) throw failure('clipboard_write_already_attempted');
      active.attempted = true; active.sha256 = hash(Buffer.from(text, 'utf16le'));
      const response = await request('write_text', { token, text });
      if (response?.written !== true || response.verified !== true || response.token !== token
        || response.sha256 !== active.sha256 || !sequenceValid(response.sequence) || response.bytes !== Buffer.byteLength(text, 'utf16le')) throw failure('clipboard_readback_mismatch');
      return { token, written: true, verified: true, sequence: response.sequence, sha256: active.sha256,
        bytes: response.bytes, mode: 'text-only', recoveryProtected: 'dpapi-current-user' };
    }); },
    readback({ token } = {}) { return exclusive(async () => {
      requireToken(token);
      if (!active.attempted) throw failure('clipboard_not_written');
      const response = await request('readback', { token });
      if (response?.verified !== true || response.matches !== true || response.token !== token
        || response.sha256 !== active.sha256 || !sequenceValid(response.sequence)) throw failure('clipboard_readback_mismatch');
      return { token, verified: true, matches: true, sequence: response.sequence, sha256: active.sha256, contentReturned: false };
    }); },
    deferAutomaticRestore({ token } = {}) { return exclusive(async () => {
      requireToken(token);
      if (!active.attempted) throw failure('clipboard_not_written');
      active.requiresInputQuiescence = true; // A lost acknowledgement must remain conservative.
      const response = await request('defer_restore', { token });
      if (response?.token !== token || response.automaticRestoreDeferred !== true || response.requiresInputQuiescence !== true) throw failure('clipboard_defer_unverified');
      return { automaticRestoreDeferred: true, requiresInputQuiescence: true };
    }); },
    restore({ token, inputQuiescent = false } = {}) { return exclusive(async () => {
      requireToken(token);
      if (active.requiresInputQuiescence && inputQuiescent !== true) throw failure('clipboard_input_quiescence_required');
      const response = await request('restore', { token, inputQuiescent: inputQuiescent === true });
      if (response?.restored !== true || (response.verified !== true && response.changed !== false)) throw failure('clipboard_restore_unverified');
      active = null;
      return { restored: true, verified: response.verified === true, changed: response.changed !== false,
        exactSupportedBytes: response.exactSupportedBytes === true, mode: 'text-only' };
    }); },
    recover({ inputQuiescent = false } = {}) { return exclusive(async () => {
      const response = await request('recover', { inputQuiescent: inputQuiescent === true });
      if (response?.restored !== true || response.verified !== true) throw failure('clipboard_recovery_unverified');
      active = null; return { recovered: true, verified: true, mode: 'text-only' };
    }); },
    recoveryInfo() { return exclusive(async () => {
      if (active) throw failure('clipboard_transaction_active');
      const response = await request('recovery_info');
      if (!tokenValid(response?.token) || !['prepared','written'].includes(response.phase)
        || response.recoveryPending !== true || !/^[a-f0-9]{64}$/.test(response.sha256)) throw failure('clipboard_invalid_response');
      active = { token: response.token, attempted: true, sha256: response.sha256, requiresInputQuiescence: response.requiresInputQuiescence === true };
      return { token: response.token, phase: response.phase, sequence: response.sequence,
        recoveryPending: true, requiresInputQuiescence: response.requiresInputQuiescence === true, mode: 'text-only', contentReturned: false };
    }); },
    abandon({ token } = {}) { return exclusive(async () => {
      requireToken(token);
      const response = await request('abandon', { token });
      if (response?.currentClipboardPreserved !== true || response.restored !== false) throw failure('clipboard_abandon_unverified');
      active = null; return { restored: false, currentClipboardPreserved: true, recoveryArchived: response.recoveryArchived === true };
    }); },
    close() { if (closed) return Promise.resolve(lastClose); return exclusive(async () => {
      let response;
      try { response = wire ? await request('close') : { cleanup: 'confirmed' }; }
      catch { response = { cleanup: 'unknown' }; }
      finally { await Promise.resolve(wire?.dispose?.()).catch(() => {}); closed = true; provider.available = false; }
      active = null;
      lastClose = { cleanup: response?.cleanup === 'confirmed' ? 'confirmed' : 'unknown',
        ...(typeof response?.code === 'string' && /^clipboard_[a-z_]+$/.test(response.code) ? { code: response.code } : {}), mode: 'text-only' };
      return lastClose;
    }); }
  };
  return provider;
}

module.exports = { createClipboardProvider, createClipboardTransport, clipboardSourceHashes, verifyClipboardFiles,
  DEFAULT_CLIPBOARD, CLIPBOARD_OUTPUTS, CLIPBOARD_SOURCES };
