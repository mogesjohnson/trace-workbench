'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DEFAULT_INDICATOR, verifyIndicatorFiles } = require('./activity-indicator.cjs');
const pin = require('./winapp-pin.json');
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_BINARY = path.join(ROOT, '.runtime', 'winapp', `v${pin.version}`, 'bin', 'winapp.exe');
const DEFAULT_BRIDGE = path.join(ROOT, '.runtime', 'window-bridge', 'bin', 'TraceWindowBridge.exe');
const BRIDGE_SOURCES = ['native/TraceWindowBridge/Program.cs', 'native/TraceWindowBridge/TraceWindowBridge.csproj'];

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
  constructor({ binaryPath = DEFAULT_BINARY, bridgePath = DEFAULT_BRIDGE, indicatorPath = DEFAULT_INDICATOR, run = runProcess, platform = process.platform, arch = process.arch, verify = verifyFiles, verifyBridge = verifyBridgeFiles, verifyIndicator = verifyIndicatorFiles } = {}) {
    this.binaryPath = binaryPath;
    this.bridgePath = bridgePath;
    this.indicatorPath = indicatorPath;
    this.run = run;
    this.platform = platform;
    this.arch = arch;
    this.verify = verify;
    this.verifyBridge = verifyBridge;
    this.verifyIndicator = verifyIndicator;
    this.inputRecoveryRequired = null;
  }
  async command(verb, args, signal) {
    const mouseGesture = verb === 'drag' || verb === 'click';
    let result;
    try { result = await this.run(this.binaryPath, ['ui', verb, '--json', ...args], {
      signal,
      ...(mouseGesture ? { drainMs: 250, interruptionRecovery: async () => {
        const released = await this.run(this.bridgePath, ['release-left'], { timeoutMs: 1500, maxOutputBytes: 1024 });
        const receipt = parseJson(released.stdout, released.stderr, released.exitCode);
        if (receipt.released !== true || receipt.button !== 'left') fail('input_recovery_failed', 'The bridge did not confirm a left-button release.');
        return { released: true, button: 'left', method: 'public-win32-sendinput' };
      } } : {})
    }); } catch (error) {
      const recovery = error.details?.recovery;
      if (mouseGesture && recovery && ((recovery.attempted && recovery.released !== true) || recovery.reason === 'process_exit_unconfirmed')) {
        this.inputRecoveryRequired = recovery.code || recovery.reason || 'input_recovery_failed';
      }
      throw error;
    }
    return parseJson(result.stdout, result.stderr, result.exitCode);
  }
  async bridge(verb, window, signal) {
    const args = verb === 'info' ? [verb] : [verb, id(window.id), String(window.pid)];
    const result = await this.run(this.bridgePath, args, { signal, timeoutMs: 10000 });
    const parsed = parseJson(result.stdout, result.stderr, result.exitCode);
    if (verb !== 'info' && (parsed.hwnd !== window.id || parsed.pid !== window.pid)) fail('window_identity_changed', 'Window bridge returned a different HWND/PID.');
    return parsed;
  }
  async doctor({ signal } = {}) {
    if (this.platform !== pin.platform || this.arch !== pin.architecture) return { ready: false, engine: 'winapp', version: pin.version, reason: 'Windows x64 is required by this pinned build.' };
    if (this.inputRecoveryRequired) return { ready: false, engine: 'winapp', version: pin.version, code: 'input_recovery_required', reason: 'Input is quarantined after incomplete mouse recovery. Check the owned input process and button state before restarting TRACE.' };
    try {
      await this.verify(this.binaryPath);
      await this.verifyBridge(this.bridgePath);
      const activityIndicator = await this.verifyIndicator(this.indicatorPath);
      const runtimes = await this.run('dotnet', ['--list-runtimes'], { signal, maxOutputBytes: 128 * 1024 });
      if (runtimes.exitCode !== 0 || !/^Microsoft\.WindowsDesktop\.App 9\.\d+\.\d+\s+\[/m.test(runtimes.stdout)) fail('indicator_runtime', 'The .NET 9 Windows Desktop runtime is required by the visible activity indicator.');
      const bridge = await this.bridge('info', null, signal);
      if (bridge.version !== 1) fail('bridge_version', 'Unexpected window bridge version.');
      const result = await this.run(this.binaryPath, ['--version'], { signal });
      if (result.exitCode !== 0 || !new RegExp(`(^|\\s)${pin.version.replaceAll('.', '\\.')}($|\\s)`).test(result.stdout)) fail('engine_version', 'Unexpected Windows engine version.');
      return { ready: true, engine: 'winapp', version: pin.version, platform: this.platform, architecture: this.arch, transport: 'public-cli', integrity: 'verified', bridge: { version: 1, runtime: '.NET 9', method: 'public-win32-dwm' }, activityIndicator, limitations: ['Windows x64', 'minimized observations restore the selected window', 'unlocked interactive desktop for input', 'horizontal scroll unsupported', 'no secure desktop or elevation bypass'] };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ready: false, engine: 'winapp', version: pin.version, code: error.code || 'engine_unavailable', reason: error.message };
    }
  }
  async listWindows({ signal } = {}) {
    const windows = await this.command('list-windows', [], signal);
    if (!Array.isArray(windows)) fail('invalid_native_response', 'Expected native window array.');
    return windows.map(window => {
      if (!Number.isSafeInteger(window.processId) || window.processId <= 0 || typeof window.processName !== 'string' || !Number.isFinite(window.width) || !Number.isFinite(window.height)) fail('invalid_native_response', 'Invalid native window identity.');
      return { id: id(window.hwnd), pid: window.processId, processName: window.processName, title: window.title || '', bounds: { x: null, y: null, width: window.width, height: window.height } };
    });
  }
  async identity(window, signal) {
    if (!object(window) || !Number.isSafeInteger(window.pid) || window.pid <= 0 || typeof window.processName !== 'string') fail('invalid_window', 'A pinned HWND, PID and process name are required.');
    const current = await this.command('status', ['-w', id(window.id)], signal);
    if (id(current.hwnd) !== window.id || current.processId !== window.pid || current.processName !== window.processName) fail('window_identity_changed', 'Window no longer belongs to the selected process.');
    if (current.coordinateSpace !== 'physical-screen-pixels') fail('coordinate_space', 'Engine coordinate space is not physical-screen-pixels.');
    return { ...window, title: current.windowTitle || '' };
  }
  async inspect(window, signal, depth = 8) {
    const result = await this.command('inspect', ['-w', id(window.id), '--depth', String(depth)], signal);
    const entry = result.windows?.find(candidate => String(candidate.hwnd) === window.id);
    if (!entry || entry.coordinateSpace !== 'physical-screen-pixels' || !Array.isArray(entry.elements) || !entry.elements.length) fail('invalid_native_response', 'Exact target UIA root was not returned.');
    const root = entry.elements[0];
    const flat = [];
    const visit = element => {
      if (flat.length >= 10000) fail('native_output_limit', 'UIA element count exceeds limit.');
      if (element.selector) {
        const item = { id: selector(element.selector), name: element.name || '', controlType: element.type || 'Unknown', enabled: element.isEnabled === true, offscreen: element.isOffscreen === true };
        if ([element.x, element.y, element.width, element.height].every(Number.isFinite) && element.width > 0 && element.height > 0) item.bounds = bounds(element);
        flat.push(item);
      }
      for (const child of element.children || []) visit(child);
    };
    for (const element of entry.elements) visit(element);
    return { bounds: bounds(root), rootSelector: selector(root.selector), elements: flat, coordinateSpace: entry.coordinateSpace, depth, truncated: JSON.stringify(entry.elements).includes('"hasMoreChildren":true') };
  }
  async focused(window, signal) {
    const result = await this.command('get-focused', ['-w', window.id], signal);
    if (typeof result.hasFocus !== 'boolean') fail('invalid_native_response', 'Invalid focused-element envelope.');
    return result.hasFocus ? { available: true, hasFocus: true, elementId: result.element?.selector || null, name: result.element?.name || '', controlType: result.element?.type || 'Unknown' } : { available: true, hasFocus: false };
  }
  async observe({ window, screenshotPath, signal }) {
    if (typeof screenshotPath !== 'string' || !path.isAbsolute(screenshotPath) || path.extname(screenshotPath).toLowerCase() !== '.png') fail('invalid_screenshot_path', 'An absolute PNG output path is required.');
    await this.identity(window, signal);
    let geometry = await this.bridge('bounds', window, signal);
    if (geometry.minimized) geometry = await this.bridge('activate', window, signal);
    const state = await this.inspect(window, signal);
    geometry = await this.bridge('bounds', window, signal);
    const captured = captureBounds(bounds(geometry.frameBounds), state.bounds);
    await this.identity(window, signal);
    // DWM exposes the exact WGC source origin. Selecting the root crops to its intersection with that
    // frame. A PrintWindow fallback with different bounds is rejected by the exact dimension check.
    const screenshot = await this.command('screenshot', ['-w', window.id, '--output', screenshotPath, '--', state.rootSelector], signal);
    if (String(screenshot.hwnd) !== window.id || screenshot.processId !== window.pid || path.resolve(screenshot.filePath || '') !== path.resolve(screenshotPath) || screenshot.windows?.length > 1) fail('invalid_screenshot', 'Screenshot provenance does not match the selected window.');
    const size = pngSize(await fs.readFile(screenshotPath));
    if (size.width !== screenshot.width || size.height !== screenshot.height) fail('invalid_screenshot', 'PNG dimensions disagree with native capture metadata.');
    if (size.width !== captured.width || size.height !== captured.height) fail('coordinate_space', 'PNG dimensions do not match exact DWM capture bounds. No scaling is assumed.');
    const current = await this.identity(window, signal);
    const after = await this.inspect(window, signal, 1);
    const afterGeometry = await this.bridge('bounds', window, signal);
    if (!sameBounds(state.bounds, after.bounds) || !sameBounds(bounds(geometry.frameBounds), bounds(afterGeometry.frameBounds)) || !sameBounds(bounds(geometry.windowBounds), bounds(afterGeometry.windowBounds))) fail('window_moved', 'Window moved during observation; request a fresh observation.');
    let focused;
    try { focused = await this.focused(window, signal); }
    catch (error) { if (signal?.aborted) throw error; focused = { available: false, code: error.code || 'focus_query_failed' }; }
    return { ...state, window: { ...current, bounds: captured }, bounds: captured, uiaBounds: state.bounds, nativeWindowBounds: bounds(geometry.windowBounds), frameBounds: bounds(geometry.frameBounds), focused, captureMethod: 'window-capture-dwm-bounds', actionCoordinateSpace: 'window-local-pixels', screenshot: { path: screenshotPath, mimeType: 'image/png', ...size } };
  }
  async act({ window, observation, action, signal }) {
    if (this.inputRecoveryRequired) fail('input_recovery_required', 'Input is quarantined after incomplete mouse recovery. Check the owned input process and button state before restarting TRACE.', { outcome: 'not_dispatched', cause: this.inputRecoveryRequired });
    if (!object(observation) || !sameBounds(bounds(observation.bounds), bounds(observation.window?.bounds)) || observation.window.id !== window.id || observation.window.pid !== window.pid) fail('invalid_observation', 'Action requires an observation of this exact window.');
    if (!object(action) || typeof action.type !== 'string') fail('invalid_action', 'A typed action is required.');
    await this.identity(window, signal);
    const fresh = await this.inspect(window, signal, 8);
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
    let verb, positional = [], options = [], transport;
    switch (action.type) {
      case 'activate': {
        const activated = await this.bridge('activate', window, signal);
        if (activated.enabled === false) fail('window_blocked', 'The selected window became disabled during activation.', { outcome: 'not_dispatched' });
        if (!activated.foreground) fail('foreground_not_target', 'Windows did not activate the selected window.');
        return { performed: true, type: action.type, engine: 'public-win32-dwm', version: 1, native: activated };
      }
      case 'click':
        if (action.elementId) { verb = 'click'; positional = [choose(action.elementId)]; }
        else {
          const p = point(action.x, action.y, captured);
          // The public drag command documents same-point, zero-hold button down/up gestures.
          verb = 'drag'; positional = [p, p]; options = ['--hold-ms', '0']; transport = 'same-point-button-down-up';
        }
        break;
      case 'type_text':
        if (typeof action.text !== 'string' || action.text.length > 16000 || action.text.includes('\0')) fail('invalid_action', 'Text must contain at most 16000 characters and no NUL.');
        verb = 'send-keys'; positional = [action.text]; options = ['--via', 'send-input', '--verbatim']; break;
      case 'press_key': {
        const key = typeof action.key === 'string' ? action.key.toLowerCase().split('+').map(token => token === 'control' ? 'ctrl' : token === 'return' ? 'enter' : token).join('+') : '';
        if (!/^(?:(?:ctrl|alt|shift)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-2])|enter|tab|escape|esc|backspace|delete|space|up|down|left|right|home|end|pageup|pagedown|insert)$/.test(key)) fail('invalid_action', 'Expected one named key or modifier combination.');
        verb = 'send-keys'; positional = [key]; options = ['--via', 'send-input']; break;
      }
      case 'drag': verb = 'drag'; positional = [point(action.fromX, action.fromY, captured), point(action.toX, action.toY, captured)]; break;
      case 'scroll': {
        point(action.x, action.y, captured);
        if (action.deltaX !== 0 || !Number.isInteger(action.deltaY) || !action.deltaY || action.deltaY % 120 !== 0 || Math.abs(action.deltaY) > 12000) fail('unsupported_action', 'This engine supports vertical wheel delta in multiples of 120, positive down, at an observed element. Horizontal scroll is unavailable.');
        const physicalX = captured.x + action.x, physicalY = captured.y + action.y;
        const candidates = fresh.elements.filter(element => element.enabled && !element.offscreen && element.bounds && physicalX >= element.bounds.x && physicalY >= element.bounds.y && physicalX < element.bounds.x + element.bounds.width && physicalY < element.bounds.y + element.bounds.height).sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
        if (!candidates.length) fail('unsupported_action', 'No observed element is available under the wheel position.');
        verb = 'scroll'; positional = [choose(candidates[0].id)]; options = ['--wheel', String(-action.deltaY / 120)]; transport = 'wheel-at-element-center'; break;
      }
      case 'invoke': verb = 'invoke'; positional = [choose(action.elementId)]; break;
      case 'set_value':
        if (typeof action.value !== 'string' || action.value.length > 16000 || action.value.includes('\0')) fail('invalid_action', 'Value must contain at most 16000 characters and no NUL.');
        verb = 'set-value'; positional = [choose(action.elementId), action.value]; break;
      default: fail('unsupported_action', `Unsupported action type: ${action.type}.`);
    }
    // Recheck PID immediately before launching the mutating native command. The CLI also pins the
    // HWND/PID during its native foreground/input operation; the discovery check alone is not relied on.
    await this.identity(window, signal);
    if (verb !== 'set-value') {
      const activated = await this.bridge('activate', window, signal);
      if (activated.enabled === false) fail('window_blocked', 'The selected window became disabled before input.', { outcome: 'not_dispatched' });
    }
    else {
      // UIA values skip foreground activation; recheck the native owner immediately before dispatch.
      const ready = await this.bridge('bounds', window, signal);
      if (ready.enabled === false) fail('window_blocked', 'The selected window became disabled before its value operation.', { outcome: 'not_dispatched' });
    }
    if (action.type === 'type_text' || action.type === 'press_key') {
      const focused = await this.focused(window, signal);
      if (!focused.hasFocus) fail('focus_not_acquired', 'Keyboard focus could not be verified inside the exact selected window.');
      if (observation.focused?.hasFocus && observation.focused.elementId !== focused.elementId) fail('focus_changed', 'Focused control changed since observation. Observe again.');
    }
    let result;
    try { result = await this.command(verb, ['-w', window.id, ...options, '--', ...positional], signal); }
    catch (error) { if (error instanceof BackendError) error.details = { ...error.details, outcome: 'unknown' }; throw error; }
    if (result.hwnd !== undefined && String(result.hwnd) !== window.id) fail('window_identity_changed', 'Native action receipt targets another window.', { outcome: 'unknown' });
    return { performed: true, type: action.type, engine: 'winapp', version: pin.version, ...(transport ? { transport } : {}), native: result };
  }
}

module.exports = { WinappBackend, BackendError, DEFAULT_BINARY, DEFAULT_BRIDGE, pin, runProcess, parseJson, pngSize, verifyFiles, verifyBridgeFiles, bridgeSourceHashes };
