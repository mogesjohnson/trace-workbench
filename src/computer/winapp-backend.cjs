'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DEFAULT_INDICATOR, verifyIndicatorFiles } = require('./activity-indicator.cjs');
const { parseAction, normalizeKey } = require('./action-contract.cjs');
const { measure, count, providerRequest } = require('./observation-metrics.cjs');
const pin = require('./winapp-pin.json');
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_BINARY = path.join(ROOT, '.runtime', 'winapp', `v${pin.version}`, 'bin', 'winapp.exe');
const DEFAULT_BRIDGE = path.join(ROOT, '.runtime', 'window-bridge', 'bin', 'TraceWindowBridge.exe');
const BRIDGE_SOURCES = ['native/TraceWindowBridge/Program.cs', 'native/TraceWindowBridge/TraceWindowBridge.csproj', 'native/TraceWindowBridge/Capture.cs', 'native/TraceWindowBridge/Applications.cs', 'native/TraceWindowBridge/Packages.cs'];

class BackendError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new BackendError(code, message, details); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function id(value) {
  const str = String(value);
  if (!/^[1-9]\d*$/.test(str) || !Number.isSafeInteger(Number(str))) fail('invalid_window', 'Expected a positive, safe decimal HWND.');
  return str;
}
function bounds(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) || value.width <= 0 || value.height <= 0) {
    fail('invalid_native_response', 'The engine did not return usable physical-screen bounds.');
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function selector(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('-') || /[\u0000-\u001f]/.test(value)) {
    fail('invalid_element', 'Invalid observed element selector.');
  }
  return value;
}
function sameBounds(a, b) { return object(a) && object(b) && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]); }
function captureBounds(frame, root) {
  const x = Math.max(frame.x, root.x), y = Math.max(frame.y, root.y);
  return bounds({ x, y, width: Math.min(frame.x + frame.width, root.x + root.width) - x, height: Math.min(frame.y + frame.height, root.y + root.height) - y });
}
function point(x, y, rect) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= rect.width || y >= rect.height) {
    fail('invalid_coordinates', 'Point must be an integer window-local pixel position inside the observed window.');
  }
  return `${rect.x + x},${rect.y + y}`;
}
function parseJson(stdout, stderr, exitCode) {
  let parsed;
  for (const text of [stderr, stdout]) {
    try {
      const candidate = JSON.parse(text.trim());
      if (object(candidate) && candidate.error) {
        fail(candidate.error.code || 'native_error', candidate.error.message || 'Native operation failed.', { native: candidate.error, exitCode });
      }
    } catch (error) { if (error instanceof BackendError) throw error; }
  }
  if (exitCode !== 0) fail('native_error', 'Native command exited unsuccessfully.', { exitCode });
  try { parsed = JSON.parse(stdout.trim()); }
  catch { fail('invalid_native_response', 'Native command did not return a JSON envelope.'); }
  return parsed;
}

/** Runs only an exact executable/argv; never invokes a shell or prints native output. */
function runProcess(executable, args, { signal, timeoutMs = 15000, maxOutputBytes = 8 * 1024 * 1024, env = process.env, spawnImpl = spawn, drainMs = 0, interruptionRecovery } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BackendError('cancelled', 'Operation cancelled before dispatch.', { outcome: 'not_dispatched' }));
    let child;
    let timer;
    let drainTimer;
    let terminationTimer;
    let finished = false;
    let forcedError;
    let terminationRequested = false;
    let bytes = 0;
    const chunks = { stdout: [], stderr: [] };
    const cleanup = () => { clearTimeout(timer); clearTimeout(drainTimer); clearTimeout(terminationTimer); signal?.removeEventListener('abort', abort); };
    const terminate = () => {
      if (finished) return;
      terminationRequested = true;
      // The pinned self-contained CLI performs UI work in-process. Its finally blocks cannot run
      // after TerminateProcess, so mouse commands supply a separate source-owned release below.
      try { child.kill(); }
      catch (error) { forcedError.details.terminationCode = error.code || 'termination_failed'; }
      terminationTimer = setTimeout(() => {
        if (finished) return;
        finished = true; cleanup();
        forcedError.details.recovery = { attempted: false, reason: 'process_exit_unconfirmed' };
        reject(forcedError);
      }, 2000);
    };
    const stop = (code, message) => {
      if (finished || forcedError) return;
      forcedError = new BackendError(code, message, { outcome: 'unknown', pid: child?.pid });
      // Give an already dispatched finite gesture a short chance to finish its own button-up.
      // A drain is not a release guarantee: forced termination still requires explicit recovery.
      if (drainMs > 0) drainTimer = setTimeout(terminate, Math.min(drainMs, 1000));
      else terminate();
    };
    const abort = () => stop('cancelled', 'Operation cancelled; native action outcome is unknown.');
    try {
      child = spawnImpl(executable, args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, WINAPP_CLI_TELEMETRY_OPTOUT: '1', WINAPP_UI_WORKFLOW_ID: undefined }
      });
    } catch (error) { cleanup(); return reject(new BackendError('engine_unavailable', 'Unable to start the pinned engine.', { cause: error.code })); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop('native_output_limit', 'Native output exceeded the bounded buffer.');
      else if (!forcedError) chunks[stream].push(chunk);
    });
    child.once('error', error => {
      if (finished) return;
      if (forcedError && Number.isSafeInteger(child.pid) && child.pid > 0) {
        forcedError.details.terminationCode = error.code || 'termination_failed';
        return; // Wait for confirmed exit or the bounded termination deadline before recovery.
      }
      finished = true; cleanup();
      reject(new BackendError('engine_unavailable', 'Unable to start the pinned engine.', { cause: error.code }));
    });
    child.once('close', async (exitCode, exitSignal) => {
      if (finished) return;
      finished = true; cleanup();
      const interruption = forcedError || (exitSignal ? new BackendError('native_terminated', 'Native command was terminated.', { outcome: 'unknown' }) : null);
      if (interruption) {
        if (interruptionRecovery && (terminationRequested || exitSignal) && Number.isSafeInteger(child.pid) && child.pid > 0) {
          // The owned input process has exited. Never inherit its already-aborted signal for the
          // bounded release operation, and do not release buttons for a process that never started.
          let recoveryTimer;
          try {
            const recovery = await Promise.race([
              Promise.resolve().then(interruptionRecovery),
              new Promise((_, rejectRecovery) => { recoveryTimer = setTimeout(() => rejectRecovery(new BackendError('input_recovery_timeout', 'Button release recovery timed out.')), 4000); })
            ]);
            interruption.details.recovery = { attempted: true, ...recovery };
          } catch (error) {
            interruption.details.recovery = { attempted: true, released: false, code: error.code || 'input_recovery_failed' };
          } finally { clearTimeout(recoveryTimer); }
        } else if (interruptionRecovery) {
          interruption.details.recovery = { attempted: false, reason: terminationRequested ? 'not_dispatched' : 'native_drained' };
        }
        return reject(interruption);
      }
      resolve({ stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'), exitCode });
    });
    timer = setTimeout(() => stop('native_timeout', 'Native command timed out; action outcome is unknown.'), timeoutMs);
    timer.unref?.();
  });
}

function pngSize(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    fail('invalid_screenshot', 'Engine output is not a PNG image.');
  }
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768) fail('invalid_screenshot', 'PNG dimensions are invalid.');
  return { width, height };
}

async function readPngHeader(filePath, open = fs.open) {
  const file = await open(filePath, 'r');
  const header = Buffer.alloc(33);
  let offset = 0, failure;
  try {
    while (offset < header.length) {
      const { bytesRead } = await file.read(header, offset, header.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return header.subarray(0, offset);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await file.close(); }
    catch (error) { if (!failure) throw error; }
  }
}

async function verifyFiles(binaryPath = DEFAULT_BINARY) {
  for (const [name, expected] of Object.entries(pin.files)) {
    let data;
    try { data = await fs.readFile(path.join(path.dirname(binaryPath), name)); }
    catch { fail('engine_unavailable', 'Pinned Windows engine is missing. Run npm run computer:setup -- --apply.'); }
    if (crypto.createHash('sha256').update(data).digest('hex') !== expected) fail('engine_integrity', `Pinned engine file failed integrity verification: ${name}.`);
  }
}

async function bridgeSourceHashes() {
  const result = {};
  for (const file of BRIDGE_SOURCES) result[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, file))).digest('hex');
  return result;
}

async function verifyBridgeFiles(bridgePath = DEFAULT_BRIDGE) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(bridgePath)), 'manifest.json'), 'utf8'));
    const sources = await bridgeSourceHashes();
    if (manifest.version !== 1 || JSON.stringify(sources) !== JSON.stringify(manifest.sources)) fail('bridge_stale', 'Window bridge source changed; rebuild with computer setup.');
    for (const name of ['TraceWindowBridge.exe', 'TraceWindowBridge.dll', 'TraceWindowBridge.runtimeconfig.json', 'TraceWindowBridge.deps.json']) {
      const digest = crypto.createHash('sha256').update(await fs.readFile(path.join(path.dirname(bridgePath), name))).digest('hex');
      if (digest !== manifest.files?.[name]) fail('bridge_integrity', 'Window bridge build output differs from its setup manifest.');
    }
  } catch (error) {
    if (error instanceof BackendError) throw error;
    fail('bridge_unavailable', 'Window bridge is not built. Computer setup requires the .NET 9 SDK; running it requires .NET 9.');
  }
}

class WinappBackend {
  constructor({ binaryPath = DEFAULT_BINARY, bridgePath = DEFAULT_BRIDGE, indicatorPath = DEFAULT_INDICATOR, run = runProcess, platform = process.platform, arch = process.arch, verify = verifyFiles, verifyBridge = verifyBridgeFiles, verifyIndicator = verifyIndicatorFiles, supervisor } = {}) {
    this.binaryPath = binaryPath;
    this.bridgePath = bridgePath;
    this.indicatorPath = indicatorPath;
    this.run = run;
    this.platform = platform;
    this.arch = arch;
    this.verify = verify;
    this.verifyBridge = verifyBridge;
    this.verifyIndicator = verifyIndicator;
    this.supervisor = supervisor === undefined && run === runProcess && platform === 'win32'
      ? new (require('./supervisor.cjs').NativeSupervisor)() : supervisor || null;
    this.inputRecoveryRequired = null;
  }
  async command(verb, args, signal) {
    const mutating = !['list-windows', 'status', 'inspect', 'get-focused', 'get-property', 'get-value', 'screenshot'].includes(verb);
    if (verb === 'screenshot') count('captureRequests');
    if (this.supervisor) {
      if (this.supervisor.ready) {
        const result = await providerRequest(true, () => this.supervisor.run('winapp', ['ui', verb, '--json', ...args], { signal, mutating }));
        return parseJson(result.stdout, result.stderr, result.exitCode);
      }
      if (mutating) fail('session_stopped', 'A ready native session is required before input.', { outcome: 'not_dispatched' });
    }
    const mouseGesture = verb === 'drag' || verb === 'click';
    let result;
    try { result = await providerRequest(false, () => this.run(this.binaryPath, ['ui', verb, '--json', ...args], {
      signal,
      ...(mouseGesture ? { drainMs: 250, interruptionRecovery: async () => {
        const released = await this.run(this.bridgePath, ['release-left'], { timeoutMs: 1500, maxOutputBytes: 1024 });
        const receipt = parseJson(released.stdout, released.stderr, released.exitCode);
        if (receipt.released !== true || receipt.button !== 'left') fail('input_recovery_failed', 'The bridge did not confirm a left-button release.');
        return { released: true, button: 'left', method: 'public-win32-sendinput' };
      } } : {})
    })); } catch (error) {
      const recovery = error.details?.recovery;
      if (mouseGesture && recovery && ((recovery.attempted && recovery.released !== true) || recovery.reason === 'process_exit_unconfirmed')) {
        this.inputRecoveryRequired = recovery.code || recovery.reason || 'input_recovery_failed';
      }
      throw error;
    }
    return parseJson(result.stdout, result.stderr, result.exitCode);
  }
  async bridge(verb, window, signal, parameters = []) {
    const pointer = verb === 'click' || verb === 'wheel';
    if (pointer && !this.supervisor?.ready) fail('supervision_required', 'New pointer input requires a ready native owner.', { outcome: 'not_dispatched' });
    const standalone = ['info', 'apps', 'process', 'packaged', 'packaged-identities', 'activate-package'].includes(verb);
    const args = standalone ? [verb, ...parameters] : [verb, id(window.id), String(window.pid), ...parameters];
    const mutating = verb === 'activate' || pointer;
    if (this.supervisor && mutating && !this.supervisor.ready) fail('session_stopped', 'A ready native session is required before activation.', { outcome: 'not_dispatched' });
    const result = await providerRequest(this.supervisor?.ready === true, () => this.supervisor?.ready
      ? this.supervisor.run('bridge', args, { signal, timeoutMs: 10000, mutating })
      : this.run(this.bridgePath, args, { signal, timeoutMs: 10000 }));
    const parsed = parseJson(result.stdout, result.stderr, result.exitCode);
    if (!standalone && (parsed.hwnd !== window.id || parsed.pid !== window.pid)) fail('window_identity_changed', 'Window bridge returned a different HWND/PID.');
    return parsed;
  }
  async identities(windows, signal) {
    const args = ['identities', ...windows.map(window => `${id(window.id)}:${window.pid}`)];
    const result = this.supervisor?.ready
      ? await this.supervisor.run('bridge', args, { signal, timeoutMs: 10000, mutating: false })
      : await this.run(this.bridgePath, args, { signal, timeoutMs: 10000 });
    const parsed = parseJson(result.stdout, result.stderr, result.exitCode);
    if (!Array.isArray(parsed.windows) || parsed.windows.length !== windows.length) fail('invalid_native_response', 'Identity batch did not return every requested window.');
    const expected = new Set(windows.map(window => `${window.id}:${window.pid}`));
    for (const item of parsed.windows) {
      const key = `${item.hwnd}:${item.pid}`;
      if (!expected.delete(key)) fail('window_identity_changed', 'Identity batch returned a different or duplicate HWND/PID.');
    }
    return new Map(parsed.windows.map(item => [item.hwnd, item]));
  }
  async doctor({ signal } = {}) {
    if (this.platform !== pin.platform || this.arch !== pin.architecture) return { ready: false, engine: 'winapp', version: pin.version, reason: 'Windows x64 is required by this pinned build.' };
    if (this.inputRecoveryRequired) return { ready: false, engine: 'winapp', version: pin.version, code: 'input_recovery_required', reason: 'Input is quarantined after incomplete mouse recovery. Check the owned input process and button state before restarting TRACE.' };
    try {
      await this.verify(this.binaryPath);
      await this.verifyBridge(this.bridgePath);
      const activityIndicator = await this.verifyIndicator(this.indicatorPath);
      let supervision;
      if (this.supervisor) {
        await this.supervisor.verify(this.supervisor.binaryPath);
        const inspected = await this.run(this.supervisor.binaryPath, ['status'], { signal, maxOutputBytes: 32768 });
        supervision = parseJson(inspected.stdout, inspected.stderr, inspected.exitCode);
        if (supervision.recoveryRequired === true) fail('input_recovery_required', 'Durable native recovery is required. Inspect computer recover --check before --apply.');
        if (this.supervisor.releaseErrors?.size) supervision = { ...supervision, code: 'release_pending_recovery',
          nextStep: 'A session release failed earlier. Recovery is clear now; close that session to release the desktop.' };
      }
      const runtimes = await this.run('dotnet', ['--list-runtimes'], { signal, maxOutputBytes: 128 * 1024 });
      if (runtimes.exitCode !== 0 || !/^Microsoft\.WindowsDesktop\.App 9\.\d+\.\d+\s+\[/m.test(runtimes.stdout)) fail('indicator_runtime', 'The .NET 9 Windows Desktop runtime is required by the visible activity indicator.');
      const bridge = await this.bridge('info', null, signal);
      if (bridge.version !== 1) fail('bridge_version', 'Unexpected window bridge version.');
      const result = await this.run(this.binaryPath, ['--version'], { signal });
      if (result.exitCode !== 0 || !new RegExp(`(^|\\s)${pin.version.replaceAll('.', '\\.')}($|\\s)`).test(result.stdout)) fail('engine_version', 'Unexpected Windows engine version.');
      return { ready: true, engine: 'winapp', version: pin.version, platform: this.platform, architecture: this.arch, transport: 'public-cli', integrity: 'verified', bridge: { version: 1, runtime: '.NET 9', method: 'public-win32-dwm' }, activityIndicator, ...(supervision ? { supervision } : {}), limitations: ['Windows x64', 'minimized observations restore the selected window', 'unlocked interactive desktop for input', 'legacy wheel is vertical at element center; point/horizontal wheel requires native supervision', 'no secure desktop or elevation bypass'] };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ready: false, engine: 'winapp', version: pin.version, code: error.code || 'engine_unavailable', reason: error.message };
    }
  }
  async listWindows({ signal } = {}) {
    const windows = await this.command('list-windows', [], signal);
    if (!Array.isArray(windows)) fail('invalid_native_response', 'Expected native window array.');
    const discovered = windows.map(window => {
      if (!Number.isSafeInteger(window.processId) || window.processId <= 0 || typeof window.processName !== 'string' || !Number.isFinite(window.width) || !Number.isFinite(window.height)) fail('invalid_native_response', 'Invalid native window identity.');
      return { id: id(window.hwnd), pid: window.processId, processName: window.processName, title: window.title || '', bounds: { x: null, y: null, width: window.width, height: window.height },
        // Listing-only hints for the default noise filter; they are not part of the session identity.
        ...(typeof window.className === 'string' && window.className ? { className: window.className.slice(0, 256) } : {}),
        ...(window.isForeground === true ? { foreground: true } : {}) };
    });
    const enriched = [];
    // One read-only process per bounded batch replaces one .NET process per window. Selected
    // targets are still individually revalidated immediately before capture and primary input.
    for (let offset = 0; offset < discovered.length; offset += 100) {
      const batch = discovered.slice(offset, offset + 100);
      const identities = await this.identities(batch, signal);
      for (const window of batch) {
        const native = identities.get(window.id);
        const code = native.identityError?.code;
        if (['window_closed', 'window_identity_changed'].includes(code)) continue;
        if (code) {
          if (!['window_bridge_failed', 'identity_unavailable', 'window_access_denied'].includes(code)) fail('invalid_native_response', 'Identity batch reported an unexpected target error.');
          enriched.push({ ...window, identity: { available: false, code } });
          continue;
        }
        enriched.push({ ...window,
          ...(typeof native.executable === 'string' ? { executable: native.executable } : {}),
          ...(typeof native.processCreationTime === 'string' ? { processCreationTime: native.processCreationTime } : {}),
          ...(Number.isInteger(native.sessionId) ? { sessionId: native.sessionId } : {}),
          ...(native.ownerWindowId !== undefined ? { ownerWindowId: native.ownerWindowId } : {}),
        });
      }
    }
    return enriched;
  }
  currentWindow(window, { signal } = {}) { return this.identity(window, signal); }
  // True only when the bridge proves the HWND is gone or now belongs to another process.
  async targetClosed(window, { signal } = {}) {
    try { await this.bridge('bounds', window, signal); return false; }
    catch (error) {
      if (signal?.aborted) throw error;
      return ['window_closed', 'window_identity_changed'].includes(error.code);
    }
  }
  openWindow(window, options) { return this.currentVisualWindow(window, options); }
  async currentVisualWindow(window, { signal } = {}) {
    const native = await this.bridge('identity', window, signal);
    if (typeof native.processCreationTime !== 'string' || !/^\d+$/.test(native.processCreationTime) || !Number.isInteger(native.sessionId)
      || (window.processCreationTime !== undefined && native.processCreationTime !== window.processCreationTime)
      || (window.sessionId !== undefined && native.sessionId !== window.sessionId)) fail('window_identity_changed', 'Native window lifetime changed.');
    return { ...window, processCreationTime: native.processCreationTime, sessionId: native.sessionId };
  }
  async identity(window, signal, adjacentBounds) {
    if (!object(window) || !Number.isSafeInteger(window.pid) || window.pid <= 0 || typeof window.processName !== 'string') fail('invalid_window', 'A pinned HWND, PID and process name are required.');
    const current = await this.command('status', ['-w', id(window.id)], signal);
    if (id(current.hwnd) !== window.id || current.processId !== window.pid || current.processName !== window.processName) fail('window_identity_changed', 'Window no longer belongs to the selected process.');
    if (current.coordinateSpace !== 'physical-screen-pixels') fail('coordinate_space', 'Engine coordinate space is not physical-screen-pixels.');
    // Initial observation supplies a lazy bounds read so status is validated first.
    const supplied = typeof adjacentBounds === 'function' ? await adjacentBounds() : adjacentBounds;
    if (adjacentBounds !== undefined && !object(supplied)) fail('invalid_native_response', 'Expected the observation bounds receipt.');
    if (window.processCreationTime !== undefined) {
      // Only observe supplies bounds; other identity checks always read independently.
      const native = adjacentBounds === undefined ? await this.bridge('identity', window, signal) : supplied;
      if (native.hwnd !== window.id || native.pid !== window.pid || native.processCreationTime !== window.processCreationTime || native.sessionId !== window.sessionId) fail('window_identity_changed', 'The selected process identity changed.');
    }
    return { ...window, title: current.windowTitle || '' };
  }
  // The tree is serialized once: every selector-backed node is an element carrying its
  // treeNodeId/parentNodeId; `hierarchy` holds only selectorless structural nodes.
  // Offscreen nodes are omitted unless requested; kept descendants attach to the
  // nearest kept ancestor. The root is always kept.
  // Scoping: `rootElementId` walks only that element's subtree (winapp's selector argument) and
  // `interactiveOnly` uses winapp -i, which nests the full tree before collapsing non-interactive
  // nodes, so survivors keep their nearest interactive ancestor. Both can drop the window root, so
  // a depth-1 read supplies it: bounds, the capture selector and the movement guards stay
  // window-level, and the window root stays the first element unless a subtree is requested.
  async inspect(window, signal, depth = 8, { includeOffscreen = false, rootElementId, interactiveOnly = false } = {}) {
    const scoped = rootElementId !== undefined, filtered = scoped || interactiveOnly;
    const read = async (args, missing) => {
      const result = await this.command('inspect', ['-w', id(window.id), ...args], signal);
      const entry = result.windows?.find(candidate => String(candidate.hwnd) === window.id);
      if (!entry || entry.coordinateSpace !== 'physical-screen-pixels' || !Array.isArray(entry.elements) || (missing && !entry.elements.length)) fail('invalid_native_response', missing || 'Exact target UIA root was not returned.');
      return entry;
    };
    const windowEntry = filtered ? await read(['--depth', '1'], 'Exact target UIA root was not returned.') : null;
    // winapp 0.7.1 can answer an unresolved selector with the window root, or fail with a generic
    // error. A subtree read therefore counts only when its single top node is the requested
    // element. -i can collapse a non-interactive scope root, so that case checks it separately.
    const scopeLost = () => fail('element_not_found', 'The scope root is not in this window now. Observe without rootElementId.');
    const scopedRead = async (args, verify) => {
      let entry;
      try { entry = await read([...args, '--', selector(rootElementId)]); }
      catch (error) { if (signal?.aborted || !['element_not_found', 'stale_element', 'internal_error'].includes(error.code)) throw error; scopeLost(); }
      if (verify && (entry.elements.length !== 1 || entry.elements[0]?.selector !== rootElementId)) scopeLost();
      return entry;
    };
    if (scoped && interactiveOnly) await scopedRead(['--depth', '1'], true);
    const deep = ['--depth', String(depth), ...(interactiveOnly ? ['-i'] : [])];
    const entry = scoped ? await scopedRead(deep, !interactiveOnly)
      : await read(deep, filtered ? undefined : 'Exact target UIA root was not returned.');
    const root = (windowEntry ?? entry).elements[0];
    const flat = [], hierarchy = [], active = new WeakSet();
    let visited = 0, kept = 0, offscreenOmitted = 0, truncated = false;
    // Top-level nodes of a scoped or filtered walk are kept like the root.
    let starts = entry.elements;
    if (interactiveOnly && !scoped && entry.elements[0]?.selector !== root.selector) {
      // The window root itself was collapsed by -i: keep it and hang the interactive nodes under it.
      const { children, hasMoreChildren, ...windowRoot } = root;
      starts = [{ ...windowRoot, children: entry.elements }];
    }
    const tops = new Set(scoped ? starts : [starts[0]]);
    const visit = (element, parentNodeId = null, nestingDepth = 0) => {
      if (!object(element) || active.has(element)) fail('invalid_native_response', 'UIA tree contains an invalid node or cycle.');
      if (visited >= 10000 || nestingDepth > 32) fail('native_output_limit', 'UIA tree exceeds its node/depth bounds.');
      if (element.children != null && !Array.isArray(element.children)) fail('invalid_native_response', 'UIA children must be an array.');
      active.add(element);
      visited++;
      if (!includeOffscreen && element.isOffscreen === true && !tops.has(element)) {
        offscreenOmitted++;
        for (const child of element.children || []) visit(child, parentNodeId, nestingDepth + 1);
        active.delete(element);
        return;
      }
      const nodeId = `n${kept++}`;
      const more = element.hasMoreChildren === true;
      if (more) truncated = true;
      if (!element.selector) {
        hierarchy.push({ nodeId, parentNodeId, name: String(element.name || '').slice(0, 512), controlType: element.type || 'Unknown',
          ...(more ? { hasMoreChildren: true } : {}) });
      } else {
        const item = { id: selector(element.selector), name: element.name || '', controlType: element.type || 'Unknown', enabled: element.isEnabled === true, offscreen: element.isOffscreen === true };
        if (typeof element.automationId === 'string' && element.automationId) item.automationId = element.automationId;
        if (typeof element.className === 'string' && element.className) item.className = element.className;
        const secondaryActions = [];
        if (element.expandState === 'collapsed') secondaryActions.push('expand');
        if (element.expandState === 'expanded') secondaryActions.push('collapse');
        if (['on', 'off', 'indeterminate'].includes(element.toggleState)) secondaryActions.push('toggle');
        if (['on', 'off', 'indeterminate'].includes(element.toggleState)) item.toggleState = element.toggleState;
        if (['expanded', 'collapsed'].includes(element.expandState)) item.expandState = element.expandState;
        item.secondaryActions = item.enabled ? secondaryActions : [];
        if ([element.x, element.y, element.width, element.height].every(Number.isFinite) && element.width > 0 && element.height > 0) item.bounds = bounds(element);
        flat.push({ ...item, treeNodeId: nodeId, parentNodeId, ...(more ? { hasMoreChildren: true } : {}) });
      }
      for (const child of element.children || []) visit(child, nodeId, nestingDepth + 1);
      active.delete(element);
    };
    for (const element of starts) visit(element);
    return { bounds: bounds(root), rootSelector: selector(root.selector), elements: flat, hierarchy,
      coordinateSpace: entry.coordinateSpace, depth, truncated, includeOffscreen, offscreenOmitted, nodeCount: kept,
      ...(scoped ? { rootElementId } : {}), ...(interactiveOnly ? { interactiveOnly: true } : {}) };
  }
  // The common file dialog (#32770) keeps its own copy of the File name; a UIA ValuePattern write
  // changes the edit text but not that copy, so Save uses the previous name (seen live 2026-11-02).
  // Only an Edit 1001 of class Edit pays for the confirming unscoped read.
  async fileDialogNameBox(window, signal, target) {
    if (target?.controlType !== 'Edit' || target.automationId !== '1001' || target.className !== 'Edit') return false;
    const tree = await this.inspect(window, signal, 3);
    if (tree.elements[0]?.className !== '#32770') return false;
    const hosts = new Set(tree.elements.filter(element => element.automationId === 'FileNameControlHost' && element.controlType === 'ComboBox').map(element => element.treeNodeId));
    return tree.elements.some(element => element.id === target.id && hosts.has(element.parentNodeId));
  }
  // Root-first UIA chain from the window root to the element the selector resolves to.
  async ancestors(window, signal, nativeSelector) {
    const result = await this.command('inspect', ['-w', id(window.id), '--ancestors', '--', selector(nativeSelector)], signal);
    const entry = result.windows?.find(candidate => String(candidate.hwnd) === window.id);
    if (!entry || entry.coordinateSpace !== 'physical-screen-pixels' || !Array.isArray(entry.elements) || entry.elements.length !== 1) fail('invalid_native_response', 'Focus ancestor chain was not returned for the exact target.');
    const chain = [];
    for (let node = entry.elements[0]; node; node = node.children?.[0]) {
      if (!object(node) || chain.length > 64 || (node.children != null && (!Array.isArray(node.children) || node.children.length > 1))) fail('invalid_native_response', 'Focus ancestor chain must be a single bounded path.');
      chain.push(node);
    }
    return chain;
  }
  // Adds the focused control and its ancestors to an inspected tree that stopped above them.
  // Nodes already present (same selector, or same AutomationId, type and bounds) are reused, so
  // nothing is listed twice. Returns the target's element id, or null when nothing can be merged.
  // A scoped tree merges only the part of the chain below its scope root; focus outside the scope
  // stays unresolved.
  mergeFocusPath(state, chain) {
    if (!chain.length || chain[0].selector !== state.rootSelector) return null;
    const anchor = state.rootElementId === undefined ? 0 : chain.findIndex(node => node.selector === state.rootElementId);
    if (anchor < 0) return null;
    let next = Number.isInteger(state.nodeCount) ? state.nodeCount : state.elements.length + state.hierarchy.length;
    const anchorElement = state.elements.find(item => item.id === chain[anchor].selector);
    let parentNodeId = anchorElement?.treeNodeId ?? null, targetId = anchor === chain.length - 1 && anchorElement ? anchorElement.id : null;
    for (let index = anchor + 1; index < chain.length; index++) {
      const node = chain[index], last = index === chain.length - 1;
      const nodeBounds = [node.x, node.y, node.width, node.height].every(Number.isFinite) && node.width > 0 && node.height > 0 ? bounds(node) : null;
      const existing = node.selector ? state.elements.find(item => item.id === node.selector
        || (node.automationId && item.automationId === node.automationId && item.controlType === (node.type || 'Unknown') && nodeBounds && sameBounds(item.bounds, nodeBounds))) : null;
      if (existing) { parentNodeId = existing.treeNodeId; if (last) targetId = existing.id; continue; }
      if (!state.includeOffscreen && node.isOffscreen === true && !last) continue;
      const nodeId = `n${next++}`;
      if (!node.selector) state.hierarchy.push({ nodeId, parentNodeId, name: String(node.name || '').slice(0, 512), controlType: node.type || 'Unknown', focusPath: true });
      else {
        const item = { id: selector(node.selector), name: node.name || '', controlType: node.type || 'Unknown', enabled: node.isEnabled === true, offscreen: node.isOffscreen === true };
        if (typeof node.automationId === 'string' && node.automationId) item.automationId = node.automationId;
        if (typeof node.className === 'string' && node.className) item.className = node.className;
        if (nodeBounds) item.bounds = nodeBounds;
        item.secondaryActions = [];
        state.elements.push({ ...item, treeNodeId: nodeId, parentNodeId, focusPath: true });
        if (last) targetId = item.id;
      }
      parentNodeId = nodeId;
    }
    state.nodeCount = next;
    return targetId;
  }
  // With `state`, an unresolved focus outside the inspected depth is completed with its ancestor
  // chain and bound again. The unique-binding rule is unchanged.
  async focused(window, signal, elements, state) {
    const result = await this.command('get-focused', ['-w', window.id], signal);
    if (typeof result.hasFocus !== 'boolean') fail('invalid_native_response', 'Invalid focused-element envelope.');
    if (!result.hasFocus) return { available: true, hasFocus: false, provenance: 'winapp-get-focused' };
    const native = result.element ?? {};
    const focused = { available: true, hasFocus: true, elementId: native.selector || null, name: native.name || '', controlType: native.type || 'Unknown', provenance: 'winapp-get-focused' };
    if (!elements) return focused;
    const nativeBounds = [native.x, native.y, native.width, native.height].every(Number.isFinite) && native.width > 0 && native.height > 0 ? bounds(native) : null;
    const bind = (items, chainTarget) => {
      const candidates = items.filter(item => {
        const exactSelector = item.id === native.selector;
        const automationIdentity = native.automationId && item.automationId === native.automationId && nativeBounds && sameBounds(item.bounds, nativeBounds)
          && (!native.className || item.className === native.className);
        // The chain target is the element winapp resolved from this focus selector in this capture.
        const resolved = chainTarget !== undefined && item.id === chainTarget && nativeBounds && sameBounds(item.bounds, nativeBounds);
        return (exactSelector || automationIdentity || resolved) && item.name === focused.name && item.controlType === focused.controlType;
      });
      // get-focused generates a transient selector while inspect can use AutomationId. Bind only a
      // unique same-control match from this capture; a shared label alone never identifies focus.
      return { ...focused, elementId: candidates.length === 1 ? candidates[0].id : null,
        binding: candidates.length === 1 ? 'observed-control' : 'unresolved', nativeSelector: native.selector || null };
    };
    const bound = bind(elements);
    if (bound.binding !== 'unresolved' || !state || !native.selector) return bound;
    let target = null;
    // A failed chain read leaves focus unresolved: observation still succeeds and keyboard input
    // still fails closed with focus_not_acquired.
    try { target = this.mergeFocusPath(state, await this.ancestors(window, signal, native.selector)); }
    catch (error) { if (signal?.aborted) throw error; }
    return target === null ? bound : { ...bind(state.elements, target), focusPath: true };
  }
  // A restored window animates from its minimized state; capture only after two equal geometry reads.
  async settledBounds(window, signal, { attempts = 15, intervalMs = 100 } = {}) {
    let previous = await this.bridge('bounds', window, signal);
    for (let attempt = 0; attempt < attempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      const next = await this.bridge('bounds', window, signal);
      if (!next.minimized && !previous.minimized && sameBounds(next.frameBounds, previous.frameBounds) && sameBounds(next.windowBounds, previous.windowBounds)) return next;
      previous = next;
    }
    fail('window_moved', 'The restored window did not settle; observe again.');
  }
  async readDocument(window, signal, elements, elementId) {
    const candidates = elements.filter(element => element.id === elementId);
    if (candidates.length !== 1) fail(candidates.length ? 'ambiguous_element' : 'stale_element', 'Document target must be a unique currently observed control.');
    const element = candidates[0], rect = element.bounds;
    const unavailable = reason => ({ available: false, reason });
    if (!/^[A-Za-z]{1,64}$/.test(element.controlType) || !rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width <= 0 || rect.height <= 0)
      return { elementId, document: unavailable('binding_unavailable'), selection: unavailable('binding_unavailable') };
    if (typeof element.automationId !== 'string' || !element.automationId || element.automationId.length > 512
      || typeof element.className !== 'string' || element.className.length > 512) {
      // The bridge binds by AutomationId. Notepad's RichEdit document has none, so its text is read
      // through the engine's own selector instead.
      if (['Document', 'Edit'].includes(element.controlType)) return this.readDocumentValue(window, signal, element);
      return { elementId, document: unavailable('binding_unavailable'), selection: unavailable('binding_unavailable') };
    }
    const result = await this.bridge('document', window, signal,
      [element.automationId, element.controlType, element.className, ...['x', 'y', 'width', 'height'].map(key => String(rect[key]))]);
    const invalid = () => fail('invalid_native_response', 'Invalid bounded TextPattern response.');
    const text = (value, limit) => {
      if (!object(value) || typeof value.text !== 'string' || value.text.length > limit || typeof value.truncated !== 'boolean') invalid();
      return { text: value.text, truncated: value.truncated };
    };
    const read = (value, selection) => {
      if (!object(value) || typeof value.available !== 'boolean') invalid();
      if (!value.available) {
        if (!['password_or_unknown', 'text_pattern_unavailable', 'selection_unavailable'].includes(value.reason)) invalid();
        return unavailable(value.reason);
      }
      if (!selection) return { available: true, ...text(value, 4096) };
      if (!Array.isArray(value.ranges) || value.ranges.length > 4 || typeof value.truncated !== 'boolean') invalid();
      return { available: true, ranges: value.ranges.map(range => text(range, 1024)), truncated: value.truncated };
    };
    if (result.method !== 'managed-uia-textpattern') invalid();
    return { elementId, provenance: result.method, document: read(result.document, false), selection: read(result.selection, true) };
  }
  // TextPattern readback by engine selector, for documents without an AutomationId. get-value falls
  // back to ValuePattern, SelectionPattern and finally the Name (a label), so it runs only after
  // get-property shows that the exact observed control answers TextPattern and is not a password
  // field. This path cannot read the selection.
  async readDocumentValue(window, signal, element) {
    const elementId = element.id, slug = selector(elementId);
    const unavailable = reason => ({ available: false, reason });
    const result = document => ({ elementId, provenance: 'winapp-textpattern-value', document, selection: unavailable('selection_unavailable') });
    const invalid = () => fail('invalid_native_response', 'Invalid document value response.');
    const read = await this.command('get-property', ['-w', id(window.id), '--', slug], signal);
    const node = read?.element, properties = read?.properties;
    if (!object(node) || !object(properties) || read.elementId !== slug) invalid();
    if (node.selector !== slug || (node.type || 'Unknown') !== element.controlType
      || ![node.x, node.y, node.width, node.height].every(Number.isFinite) || !sameBounds(bounds(node), element.bounds)) fail('stale_element', 'The document control changed after the observation.');
    if (properties.IsPassword !== 'False') return result(unavailable('password_or_unknown'));
    // Whole-document formatting is read through TextPattern; every value is "Unavailable" without it.
    const formatting = ['FontName', 'FontSize', 'FontWeight', 'ForegroundColor', 'IsItalic', 'StrikethroughStyle'];
    if (!formatting.some(name => typeof properties[name] === 'string' && properties[name] !== 'Unavailable')) return result(unavailable('text_pattern_unavailable'));
    const value = await this.command('get-value', ['-w', id(window.id), '--', slug], signal);
    if (!object(value) || value.elementId !== slug || typeof value.text !== 'string') invalid();
    let text = value.text.slice(0, 4096);
    const last = text.charCodeAt(text.length - 1);
    if (text.length < value.text.length && last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    return result({ available: true, text, truncated: text.length < value.text.length });
  }
  async observeVisual({ window, screenshotPath, signal }) {
    if (typeof screenshotPath !== 'string' || !path.isAbsolute(screenshotPath) || path.extname(screenshotPath).toLowerCase() !== '.png') fail('invalid_screenshot_path', 'An absolute PNG output path is required.');
    await this.currentVisualWindow(window, { signal });
    let geometry = await this.bridge('bounds', window, signal);
    const restored = geometry.minimized === true;
    if (restored) { await this.bridge('activate', window, signal); geometry = await this.settledBounds(window, signal); }
    const frame = bounds(geometry.frameBounds), outer = bounds(geometry.windowBounds);
    const capture = await this.bridge('capture', window, signal, [screenshotPath]);
    if (capture.method !== 'public-win32-printwindow-dwm' || capture.uiaRequired !== false
      || path.resolve(capture.filePath || '') !== screenshotPath || !sameBounds(capture.bounds, frame)) fail('invalid_capture', 'Native visual capture provenance differs.');
    const png = await readPngHeader(screenshotPath); count('backendPngRead', png.length);
    const size = pngSize(png);
    if (size.width !== capture.width || size.height !== capture.height || size.width !== frame.width || size.height !== frame.height) fail('capture_mismatch', 'Native PNG dimensions differ from exact DWM frame.');
    const current = await this.currentVisualWindow(window, { signal }), after = await this.bridge('bounds', window, signal);
    if (after.processCreationTime !== current.processCreationTime || after.sessionId !== current.sessionId) fail('window_identity_changed', 'Native lifetime changed after visual capture.');
    if (after.minimized || !sameBounds(after.frameBounds, frame) || !sameBounds(after.windowBounds, outer)) fail('window_moved', 'Window moved during visual observation.');
    return { window: { ...current, bounds: frame }, bounds: frame, elements: [],
      focused: { available: false, code: 'visual_only' },
      targetState: { enabled: after.enabled, minimized: after.minimized, foreground: after.foreground, provenance: 'public-win32-dwm' },
      restoredFromMinimized: restored, captureMethod: capture.method, screenshot: { path: screenshotPath, mimeType: 'image/png', ...size } };
  }
  async observe({ window, screenshotPath, signal, depth = 8, includeScreenshot = true, documentElementId, visualOnly = false, includeOffscreen = false, rootElementId, interactiveOnly = false }) {
    if (typeof includeOffscreen !== 'boolean' || typeof interactiveOnly !== 'boolean') fail('invalid_observation', 'includeOffscreen and interactiveOnly must be booleans.');
    if (rootElementId !== undefined && (visualOnly || selector(rootElementId) !== rootElementId)) fail('invalid_observation', 'rootElementId needs an accessibility tree.');
    if (typeof visualOnly !== 'boolean' || (visualOnly && (!includeScreenshot || documentElementId !== undefined))) fail('invalid_observation', 'Visual-only capture cannot include document reads or omit PNG.');
    if (visualOnly) return this.observeVisual({ window, screenshotPath, signal });
    if (typeof includeScreenshot !== 'boolean') fail('invalid_observation', 'includeScreenshot must be a boolean.');
    if (documentElementId !== undefined && (includeScreenshot || selector(documentElementId) !== documentElementId)) fail('invalid_document_request', 'Document reads require accessibility-only observation.');
    if (includeScreenshot && (typeof screenshotPath !== 'string' || !path.isAbsolute(screenshotPath) || path.extname(screenshotPath).toLowerCase() !== '.png')) fail('invalid_screenshot_path', 'An absolute PNG output path is required.');
    if (!includeScreenshot && screenshotPath !== undefined) fail('invalid_screenshot_path', 'A screenshot path is not allowed when capture is omitted.');
    let initialBounds;
    const readInitialBounds = () => {
      if (initialBounds === undefined) {
        initialBounds = Promise.resolve(measure('geometry', () => this.bridge('bounds', window, signal)));
        // An injected identity override can start this read and then throw first.
        // Observe rejection now; normal flow still awaits the original promise.
        void initialBounds.catch(() => {});
      }
      return initialBounds;
    };
    await measure('identity', () => this.identity(window, signal, readInitialBounds));
    // Injected identity implementations may ignore the supplier; still read once.
    let geometry = await (initialBounds ?? readInitialBounds());
    const restored = geometry.minimized === true;
    if (restored) {
      await measure('restore', () => this.bridge('activate', window, signal));
      geometry = await measure('settle', () => this.settledBounds(window, signal));
    }
    const state = await measure('uia', () => this.inspect(window, signal, depth, { includeOffscreen, rootElementId, interactiveOnly }));
    geometry = await measure('geometry', () => this.bridge('bounds', window, signal));
    const captured = captureBounds(bounds(geometry.frameBounds), state.bounds);
    await measure('identity', () => this.identity(window, signal, geometry));
    // DWM exposes the exact WGC source origin. Selecting the root crops to its intersection with that
    // frame. A PrintWindow fallback with different bounds is rejected by the exact dimension check.
    let size;
    if (includeScreenshot) {
      const screenshot = await measure('capture', () => this.command('screenshot', ['-w', window.id, '--output', screenshotPath, '--', state.rootSelector], signal));
      if (String(screenshot.hwnd) !== window.id || screenshot.processId !== window.pid || path.resolve(screenshot.filePath || '') !== path.resolve(screenshotPath) || screenshot.windows?.length > 1) fail('invalid_screenshot', 'Screenshot provenance does not match the selected window.');
      const png = await measure('backendPngRead', () => readPngHeader(screenshotPath));
      count('backendPngRead', png.length);
      size = measure('pngHeader', () => pngSize(png));
      if (size.width !== screenshot.width || size.height !== screenshot.height) fail('invalid_screenshot', 'PNG dimensions disagree with native capture metadata.');
      if (size.width !== captured.width || size.height !== captured.height) fail('coordinate_space', 'PNG dimensions do not match exact DWM capture bounds. No scaling is assumed.');
    }
    const documentRead = documentElementId === undefined ? undefined
      : await measure('document', () => this.readDocument(window, signal, state.elements, documentElementId));
    const current = await measure('identity', () => this.identity(window, signal));
    const after = await measure('uia', () => this.inspect(window, signal, 1));
    const afterGeometry = await measure('geometry', () => this.bridge('bounds', window, signal));
    if (!sameBounds(state.bounds, after.bounds) || !sameBounds(bounds(geometry.frameBounds), bounds(afterGeometry.frameBounds)) || !sameBounds(bounds(geometry.windowBounds), bounds(afterGeometry.windowBounds))) fail('window_moved', 'Window moved during observation; request a fresh observation.');
    let focused;
    try { focused = await measure('focus', () => this.focused(window, signal, state.elements, state)); }
    catch (error) { if (signal?.aborted) throw error; focused = { available: false, code: error.code || 'focus_query_failed' }; }
    if (window.processCreationTime !== undefined && afterGeometry.processCreationTime !== window.processCreationTime) fail('window_identity_changed', 'The selected process was replaced.');
    return { ...state, ...(documentRead ? { documentRead } : {}), window: { ...current, bounds: captured }, bounds: captured, uiaBounds: state.bounds, nativeWindowBounds: bounds(geometry.windowBounds), frameBounds: bounds(geometry.frameBounds), focused,
      targetState: { enabled: afterGeometry.enabled, minimized: afterGeometry.minimized, foreground: afterGeometry.foreground, ownerWindowId: afterGeometry.ownerWindowId ?? null, provenance: 'public-win32-dwm' },
      restoredFromMinimized: restored, ...(includeScreenshot ? { captureMethod: 'window-capture-dwm-bounds', actionCoordinateSpace: 'window-local-pixels', screenshot: { path: screenshotPath, mimeType: 'image/png', ...size } } : {}) };
  }
  // Any rejection before the requested primary mutation begins is provably not dispatched. Once it
  // may have begun, the outcome stays unknown even if an error code was raised before input.
  async act(request) {
    const progress = { primary: false, preparation: [] };
    try { return await this.dispatch(request, progress); }
    catch (error) {
      const failure = error instanceof BackendError ? error : new BackendError(error?.code || 'backend_error', String(error?.message || 'Native action failed.'), error?.details ?? {});
      const provenNativeRejection = (failure.details?.nativeSupervision === true || failure.details?.refusedBeforeSend === true) && failure.details?.outcome === 'not_dispatched';
      failure.details = { ...failure.details, outcome: progress.primary && !provenNativeRejection ? 'unknown' : 'not_dispatched', preparation: progress.preparation };
      throw failure;
    }
  }
  async dispatch({ window, observation, action, signal }, progress) {
    if (this.inputRecoveryRequired) fail('input_recovery_required', 'Input is quarantined after incomplete mouse recovery. Check the owned input process and button state before restarting TRACE.', { outcome: 'not_dispatched', cause: this.inputRecoveryRequired });
    if (!object(observation) || !sameBounds(bounds(observation.bounds), bounds(observation.window?.bounds)) || observation.window.id !== window.id || observation.window.pid !== window.pid) fail('invalid_observation', 'Action requires an observation of this exact window.');
    action = parseAction(action);
    const pointerClick = action.type === 'click' && ((action.button ?? 'left') !== 'left' || (action.count ?? 1) !== 1);
    const pointWheel = action.type === 'scroll' && action.placement === 'point';
    if (action.type === 'accessibility_action' && !this.supervisor?.ready) fail('supervision_required', 'Named UIA actions require native supervision.', { outcome: 'not_dispatched' });
    if ((pointerClick || pointWheel) && !this.supervisor?.ready) fail('supervision_required', 'Extended pointer input requires declared-input native supervision.', { outcome: 'not_dispatched' });
    await this.identity(window, signal);
    // Reinspect at the server-retained depth and scope so deeply or narrowly observed controls remain targetable.
    const fresh = await this.inspect(window, signal, observation.depth ?? 8, { includeOffscreen: observation.includeOffscreen === true,
      ...(observation.rootElementId !== undefined ? { rootElementId: observation.rootElementId } : {}), interactiveOnly: observation.interactiveOnly === true });
    const geometry = await this.bridge('bounds', window, signal);
    if (geometry.enabled === false) fail('window_blocked', 'The selected window is disabled. Select its enabled dialog explicitly before input.', { outcome: 'not_dispatched' });
    const captured = captureBounds(bounds(geometry.frameBounds), fresh.bounds);
    if (geometry.minimized || !sameBounds(observation.uiaBounds, fresh.bounds) || !sameBounds(observation.frameBounds, geometry.frameBounds) || !sameBounds(observation.nativeWindowBounds, geometry.windowBounds) || !sameBounds(observation.bounds, captured)) fail('window_moved', 'Window moved or resized since observation. Observe again.');
    const choose = elementId => {
      const old = observation.elements?.find(element => element.id === elementId);
      const now = fresh.elements.find(element => element.id === elementId);
      if (!old || !now || !now.enabled || old.enabled !== now.enabled || old.name !== now.name || old.controlType !== now.controlType || (old.bounds && (!now.bounds || !sameBounds(old.bounds, now.bounds)))) fail('stale_element', 'Element changed since observation. Observe again.');
      return selector(elementId);
    };
    let verb, positional = [], options = [], transport, pointerArgs;
    switch (action.type) {
      case 'activate': {
        // Activation is the primary mutation of an activate action.
        progress.primary = true;
        const activated = await this.bridge('activate', window, signal);
        if (activated.enabled === false) fail('window_blocked', 'The selected window became disabled during activation.');
        if (!activated.foreground) fail('foreground_not_target', 'Windows did not activate the selected window.');
        return { performed: true, type: action.type, engine: 'public-win32-dwm', version: 1, native: activated };
      }
      case 'click':
        if (pointerClick) {
          let x = action.x, y = action.y;
          if (action.elementId) {
            choose(action.elementId);
            const rect = fresh.elements.find(item => item.id === action.elementId)?.bounds;
            if (!rect) fail('unsupported_action', 'An extended element click needs current physical bounds.');
            x = Math.floor(rect.x + rect.width / 2) - captured.x; y = Math.floor(rect.y + rect.height / 2) - captured.y;
          }
          pointerArgs = [...point(x, y, captured).split(','), action.button ?? 'left', String(action.count ?? 1)];
          verb = 'click'; transport = 'supervised-public-win32'; break;
        }
        if (action.elementId) { verb = 'click'; positional = [choose(action.elementId)]; }
        else {
          const p = point(action.x, action.y, captured);
          // The public drag command documents same-point, zero-hold button down/up gestures.
          verb = 'drag'; positional = [p, p]; options = ['--hold-ms', '0']; transport = 'same-point-button-down-up';
        }
        break;
      case 'type_text':
        verb = 'send-keys'; positional = [action.text]; options = ['--via', 'send-input', '--verbatim']; break;
      case 'press_key': {
        const key = normalizeKey(action.key);
        verb = 'send-keys'; positional = [key]; options = ['--via', 'send-input']; break;
      }
      case 'drag': verb = 'drag'; positional = [point(action.fromX, action.fromY, captured), point(action.toX, action.toY, captured)]; break;
      case 'scroll': {
        if (pointWheel) {
          pointerArgs = [...point(action.x, action.y, captured).split(','), String(action.deltaX), String(action.deltaY)];
          verb = 'wheel'; transport = 'supervised-public-win32'; break;
        }
        point(action.x, action.y, captured);
        const physicalX = captured.x + action.x, physicalY = captured.y + action.y;
        const candidates = fresh.elements.filter(element => element.enabled && !element.offscreen && element.bounds && physicalX >= element.bounds.x && physicalY >= element.bounds.y && physicalX < element.bounds.x + element.bounds.width && physicalY < element.bounds.y + element.bounds.height).sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
        if (!candidates.length) fail('unsupported_action', 'No observed element is available under the wheel position.');
        verb = 'scroll'; positional = [choose(candidates[0].id)]; options = ['--wheel', String(-action.deltaY / 120)]; transport = 'wheel-at-element-center'; break;
      }
      case 'invoke': verb = 'invoke'; positional = [choose(action.elementId)]; break;
      case 'accessibility_action': {
        const old = observation.elements.filter(item => item.id === action.elementId), current = fresh.elements.filter(item => item.id === action.elementId);
        if (old.length !== 1 || current.length !== 1 || !Array.isArray(old[0].secondaryActions) || !old[0].secondaryActions.includes(action.action)
          || !Array.isArray(current[0].secondaryActions) || !current[0].secondaryActions.includes(action.action) || old[0].automationId !== current[0].automationId
          || old[0].className !== current[0].className) fail('stale_element', 'Named action or exact control binding changed. Observe again.');
        if (action.action === 'toggle' && old[0].toggleState !== current[0].toggleState) fail('stale_element', 'Toggle state changed since observation. Observe again.');
        positional = [choose(action.elementId)]; transport = 'exact-uia-pattern';
        verb = 'invoke'; options = ['--action', action.action];
        break;
      }
      case 'set_value': {
        positional = [choose(action.elementId), action.value];
        if (await this.fileDialogNameBox(window, signal, fresh.elements.find(element => element.id === action.elementId)))
          fail('unsupported_action', 'The file dialog ignores a File name value set through UI Automation and would save under its previous name. Click the File name box, press ctrl+a and use type_text instead.', { outcome: 'not_dispatched' });
        verb = 'set-value'; break;
      }
      default: fail('unsupported_action', `Unsupported action type: ${action.type}.`);
    }
    // Recheck PID immediately before launching the mutating native command. The CLI also pins the
    // HWND/PID during its native foreground/input operation; the discovery check alone is not relied on.
    await this.identity(window, signal);
    if (verb !== 'set-value') {
      // Preparatory activation changes the foreground but is not the requested input.
      const step = { step: 'activation', status: 'started' };
      progress.preparation.push(step);
      const activated = await this.bridge('activate', window, signal);
      step.status = activated.foreground ? 'foreground' : 'not_foreground';
      if (activated.enabled === false) fail('window_blocked', 'The selected window became disabled before input.', { outcome: 'not_dispatched' });
    }
    else {
      // UIA values skip foreground activation; recheck the native owner immediately before dispatch.
      const ready = await this.bridge('bounds', window, signal);
      if (ready.enabled === false) fail('window_blocked', 'The selected window became disabled before its value operation.', { outcome: 'not_dispatched' });
    }
    if (action.type === 'type_text' || action.type === 'press_key') {
      const focused = await this.focused(window, signal, fresh.elements, fresh);
      if (!focused.hasFocus) fail('focus_not_acquired', 'Keyboard focus could not be verified inside the exact selected window.');
      if (observation.focused?.hasFocus && observation.focused.elementId !== focused.elementId) fail('focus_changed', 'Focused control changed since observation. Observe again.');
      if (!focused.elementId) fail('focus_not_acquired', 'Keyboard focus could not be bound to an observed control inside the exact selected window.');
    }
    progress.primary = true;
    let result;
    try {
      result = pointerArgs ? await this.bridge(verb, window, signal, pointerArgs)
        : await this.command(verb, ['-w', window.id, ...options, '--', ...positional], signal);
    } catch (error) {
      // winapp 0.7.1 refuses system-reserved combos (alt+f4, win+<key>, ctrl+alt+del) during
      // argument checks and exits before sending any input (UiSendKeysCommand), so nothing was sent.
      if (verb === 'send-keys' && error.code === 'invalid_arguments' && /^Refusing to synthesize /.test(error.message)) {
        error.details = { ...error.details, outcome: 'not_dispatched', refusedBeforeSend: true };
      }
      throw error;
    }
    const expectedEvents = pointWheel ? Number(action.deltaX !== 0) + Number(action.deltaY !== 0) : 2 * (action.count ?? 1);
    if (pointerArgs && (result.performed !== true || result.operation !== verb || result.inputEvents !== expectedEvents)) {
      fail('invalid_native_response', 'Pointer receipt did not confirm the complete sequence.', { outcome: 'unknown' });
    }
    if (result.hwnd !== undefined && String(result.hwnd) !== window.id) fail('window_identity_changed', 'Native action receipt targets another window.', { outcome: 'unknown' });
    return { performed: true, type: action.type, engine: pointerArgs ? 'public-win32-sendinput' : 'winapp', version: pointerArgs ? 1 : pin.version, ...(transport ? { transport } : {}), preparation: progress.preparation, native: result };
  }
  async close() {
    if (this.supervisor?.child && this.supervisor.owner) await this.supervisor.release(this.supervisor.owner);
  }
}

module.exports = { WinappBackend, BackendError, DEFAULT_BINARY, DEFAULT_BRIDGE, pin, runProcess, parseJson, pngSize, readPngHeader, verifyFiles, verifyBridgeFiles, bridgeSourceHashes };
