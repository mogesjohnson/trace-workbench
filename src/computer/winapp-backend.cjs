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
// interactiveOnly keeps these control types, Text that carries a value, and nodes with a toggle or
// expand state. isInvokable counts only outside STRUCTURAL: Gecko reports it on every node.
// Parts whose action the parent already offers are dropped: a ScrollBar with its line and page
// buttons, the Edit and Text fields inside a list, tree or data item (Explorer lists a Name, Date
// modified, Type and Size field per row), and a ComboBox's own Open button. Explorer also lists
// each file group twice, as the group and its header: a Group with the same name and expand state
// as its nearest kept Group is dropped, with the header's Buttons, because the kept Group already
// offers expand and collapse. The rule never matches on a localized name such as Collapse Group.
const INTERACTIVE_TYPES = new Set(['Button', 'SplitButton', 'MenuItem', 'ComboBox', 'Edit', 'Hyperlink', 'TabItem', 'ListItem', 'TreeItem',
  'CheckBox', 'RadioButton', 'Slider', 'Spinner', 'DataItem', 'HeaderItem', 'Document']);
const ITEM_TYPES = new Set(['ListItem', 'TreeItem', 'DataItem']);
const STRUCTURAL_TYPES = new Set(['Window', 'Pane', 'Group', 'Separator', 'TitleBar', 'MenuBar', 'Menu', 'ToolBar', 'Tab', 'List', 'Tree',
  'Table', 'DataGrid', 'StatusBar', 'Header', 'Text', 'Image']);
// `within` is what the walk is inside: 'skip' (a ScrollBar), 'item', 'header' (a dropped duplicate
// Group), or the type of the kept parent.
function interactiveNode(element, within) {
  if (within === 'skip' || element.type === 'Separator' || element.type === 'ScrollBar') return false;
  if (within === 'header' && element.type === 'Button') return false;
  if (within === 'item' && (element.type === 'Edit' || element.type === 'Text')) return false;
  if (within === 'ComboBox' && element.type === 'Button') return false;
  if (INTERACTIVE_TYPES.has(element.type) || element.hasMoreChildren === true) return true;
  if (element.type === 'Text') return typeof element.value === 'string' && element.value.trim() !== '';
  return ['on', 'off', 'indeterminate'].includes(element.toggleState) || ['expanded', 'collapsed'].includes(element.expandState)
    || (element.isInvokable === true && !STRUCTURAL_TYPES.has(element.type));
}
function duplicateGroup(element, keptParent) {
  return element.type === 'Group' && keptParent?.type === 'Group' && typeof element.name === 'string' && element.name !== ''
    && element.name === keptParent.name && ['expanded', 'collapsed'].includes(element.expandState) && element.expandState === keptParent.expandState;
}
const BRIDGE_SOURCES = ['native/TraceWindowBridge/Program.cs', 'native/TraceWindowBridge/TraceWindowBridge.csproj', 'native/TraceWindowBridge/Capture.cs', 'native/TraceWindowBridge/Related.cs', 'native/TraceWindowBridge/Applications.cs', 'native/TraceWindowBridge/Packages.cs', 'native/TraceSupervisor/WindowRead.cs', 'native/TraceWindowBridge/ReadWorker.cs', 'native/TraceWindowBridge/CachedTree.cs', 'native/TraceWindowBridge/GuardedClick.cs', 'native/TraceWindowBridge/packages.lock.json'];
const BRIDGE_OUTPUTS = ['TraceWindowBridge.exe', 'TraceWindowBridge.dll', 'TraceWindowBridge.runtimeconfig.json',
  'TraceWindowBridge.deps.json', 'Microsoft.Extensions.DependencyInjection.Abstractions.dll', 'Microsoft.Extensions.DependencyInjection.dll',
  'Microsoft.Extensions.Logging.Abstractions.dll', 'Microsoft.Windows.SDK.BuildTools.WinApp.UIAutomation.dll',
  'Microsoft.Windows.SDK.NET.dll', 'WinRT.Runtime.dll'];

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
// R21: menus, tooltips and owned popups above the session window. The native list is checked
// field by field; anything malformed makes the whole list unavailable rather than partly trusted.
const RELATED_LIMIT = 16;
const RELATED_RELATIONS = new Set(['owned', 'thread-menu', 'same-thread-popup']);
const RELATED_KINDS = new Set(['menu', 'tooltip', 'window', 'other']);
function normalizeRelated(native, imagePrefix) {
  const invalid = () => fail('invalid_native_response', 'Invalid related-window response.');
  const text = (value, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= 256) ? value : invalid();
  const flag = value => typeof value === 'boolean' ? value : invalid();
  if (native?.method !== 'public-win32-related' || !Array.isArray(native.windows) || native.windows.length > RELATED_LIMIT
    || !object(native.coverage) || !object(native.menuMode)) invalid();
  const coverage = native.coverage;
  for (const key of ['ownerChain', 'threadMenu', 'sameThreadPopups', 'otherThreadsAndProcesses']) flag(coverage[key]);
  if (flag(native.menuMode.available) && native.menuMode.active !== undefined) flag(native.menuMode.active);
  const windows = native.windows.map((item, index) => {
    if (!object(item) || item.zOrder !== index || !RELATED_RELATIONS.has(item.relation) || !RELATED_KINDS.has(item.kind)
      || !['dwm-frame', 'window-rect'].includes(item.boundsSource) || !Number.isInteger(item.pid) || item.pid <= 0 || !object(item.uia)) invalid();
    const uia = flag(item.uia.available) ? { available: true, controlType: text(item.uia.controlType), name: text(item.uia.name) }
      : { available: false, code: text(item.uia.code) };
    let image;
    if (imagePrefix !== undefined) {
      const raw = item.image;
      if (!object(raw)) invalid();
      image = flag(raw.available)
        ? (path.resolve(raw.filePath ?? '') === path.resolve(`${imagePrefix}-${index}.png`) && Number.isInteger(raw.width) && Number.isInteger(raw.height)
          ? { available: true, path: path.resolve(raw.filePath), width: raw.width, height: raw.height } : invalid())
        : { available: false, code: text(raw.code) };
    } else if (item.image !== null && item.image !== undefined) invalid();
    return { windowId: id(item.hwnd), pid: item.pid, relation: item.relation, kind: item.kind, className: text(item.className),
      ...(item.title === null ? {} : { title: text(item.title) }), zOrder: index, bounds: bounds(item.bounds), boundsSource: item.boundsSource,
      ...(Number.isInteger(item.dpi) && item.dpi > 0 ? { dpi: item.dpi } : {}), ...(typeof item.dpiAwareness === 'string' ? { dpiAwareness: item.dpiAwareness } : {}),
      topmost: flag(item.topmost), uia, ...(image ? { image } : {}) };
  });
  return { available: true, windows, truncated: flag(native.truncated),
    menuMode: native.menuMode.available ? { available: true, active: native.menuMode.active === true } : { available: false },
    coverage: { ownerChain: coverage.ownerChain, threadMenu: coverage.threadMenu, sameThreadPopups: coverage.sameThreadPopups, otherThreadsAndProcesses: coverage.otherThreadsAndProcesses } };
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
    for (const name of BRIDGE_OUTPUTS) {
      const digest = crypto.createHash('sha256').update(await fs.readFile(path.join(path.dirname(bridgePath), name))).digest('hex');
      if (digest !== manifest.files?.[name]) fail('bridge_integrity', 'Window bridge build output differs from its setup manifest.');
    }
  } catch (error) {
    if (error instanceof BackendError) throw error;
    fail('bridge_unavailable', 'Window bridge is not built. Computer setup requires the .NET 10 SDK; running it requires .NET 10.');
  }
}

// The largest k such that `after` is `before` with one span (the caret, or a replaced selection)
// replaced by the first k characters of `text`, or -1 when no span fits. Only the changed span
// counts, so text already in the control cannot stand in for dropped input.
function deliveredPrefix(before, after, text) {
  const limit = Math.min(before.length, after.length);
  let prefix = 0, suffix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  while (suffix < limit && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  let best = -1;
  for (let start = 0; start <= prefix && best < text.length; start++) {
    let match = 0;
    while (match < text.length && start + match < after.length && after[start + match] === text[match]) match++;
    // The kept tail must be a common suffix and must not overlap the kept head.
    const least = Math.max(0, after.length - start - suffix, after.length - before.length);
    if (match >= least && match > best) best = match;
  }
  return best;
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
    const mutating = verb === 'activate' || verb === 'guarded-click' || pointer;
    if (this.supervisor && mutating && !this.supervisor.ready) fail('session_stopped', 'A ready native session is required before activation.', { outcome: 'not_dispatched' });
    const result = await providerRequest(this.supervisor?.ready === true, () => this.supervisor?.ready
      ? this.supervisor.run('bridge', args, { signal, timeoutMs: 10000, mutating })
      : this.run(this.bridgePath, args, { signal, timeoutMs: 10000 }));
    const parsed = parseJson(result.stdout, result.stderr, result.exitCode);
    if (!standalone && (parsed.hwnd !== window.id || parsed.pid !== window.pid)) fail('window_identity_changed', 'Window bridge returned a different HWND/PID.');
    return parsed;
  }
  // Context only: a failed or malformed read leaves the observation intact and says why the list
  // is missing. Cancellation still propagates.
  async relatedWindows(window, signal, imagePrefix) {
    if (imagePrefix !== undefined && (typeof imagePrefix !== 'string' || !path.isAbsolute(imagePrefix) || path.extname(imagePrefix).toLowerCase() === '.png')) fail('invalid_observation', 'Related image prefix must be an absolute path without an extension.');
    try { return normalizeRelated(await this.bridge('related', window, signal, imagePrefix === undefined ? [] : [imagePrefix]), imagePrefix); }
    catch (error) { if (signal?.aborted) throw error; return { available: false, code: error?.code || 'related_unavailable' }; }
  }
  // Refuses before dispatch when one of the window's own popups (owner chain or UI thread) covers a
  // point. Other applications' windows are left to activation, as before; a malformed reply refuses.
  async assertNoOwnPopup(window, signal, points) {
    const result = await this.bridge('hit', window, signal, points.flatMap(item => [String(item.x), String(item.y)]));
    if (result.method !== 'public-win32-hit' || !Array.isArray(result.points) || result.points.length !== points.length
      || result.points.some((item, index) => !object(item) || item.x !== points[index].x || item.y !== points[index].y || typeof item.clear !== 'boolean'
        || (!item.clear && (!object(item.coveredBy) || typeof item.coveredBy.related !== 'boolean'))))
      fail('invalid_native_response', 'Invalid occlusion check response.', { outcome: 'not_dispatched' });
    const covered = result.points.find(item => !item.clear && item.coveredBy.related);
    if (covered) fail('target_occluded', 'A menu, tooltip or popup of this window covers the point. Close it (for example with escape) or choose its item with the keyboard, then observe again.',
      { outcome: 'not_dispatched', coveredBy: { windowId: covered.coveredBy.windowId, className: covered.coveredBy.className } });
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
      if (runtimes.exitCode !== 0 || !/^Microsoft\.WindowsDesktop\.App 10\.\d+\.\d+\s+\[/m.test(runtimes.stdout)) fail('indicator_runtime', 'The .NET 10 Windows Desktop runtime is required by the visible activity indicator.');
      const bridge = await this.bridge('info', null, signal);
      if (bridge.version !== 1) fail('bridge_version', 'Unexpected window bridge version.');
      const result = await this.run(this.binaryPath, ['--version'], { signal });
      if (result.exitCode !== 0 || !new RegExp(`(^|\\s)${pin.version.replaceAll('.', '\\.')}($|\\s)`).test(result.stdout)) fail('engine_version', 'Unexpected Windows engine version.');
      return { ready: true, engine: 'winapp', version: pin.version, platform: this.platform, architecture: this.arch, transport: 'public-cli', integrity: 'verified', bridge: { version: 1, runtime: '.NET 10', method: 'public-win32-dwm' }, activityIndicator, ...(supervision ? { supervision } : {}), limitations: ['Windows x64', 'observing restores a minimized window', 'unlocked interactive desktop for input', 'point/horizontal wheel requires native supervision', 'no secure desktop or elevation bypass'] };
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
  // A pinned window (every session window: openWindow records the generation) is checked by the
  // bridge guard, which proves the HWND still belongs to that process generation and session and
  // returns the title. A bounds receipt carries the same guarded fields, so a check right after a
  // bounds read reuses it instead of launching a provider. Every UIA read still rejects a coordinate
  // space other than physical-screen-pixels before its bounds are used. An unpinned window keeps the
  // engine's status read, the only check that binds its PID to the process name.
  async identity(window, signal, adjacentBounds) {
    if (!object(window) || !Number.isSafeInteger(window.pid) || window.pid <= 0 || typeof window.processName !== 'string') fail('invalid_window', 'A pinned HWND, PID and process name are required.');
    if (adjacentBounds !== undefined && !object(adjacentBounds)) fail('invalid_native_response', 'Expected the observation bounds receipt.');
    if (window.processCreationTime === undefined) {
      const current = await this.command('status', ['-w', id(window.id)], signal);
      if (id(current.hwnd) !== window.id || current.processId !== window.pid || current.processName !== window.processName) fail('window_identity_changed', 'Window no longer belongs to the selected process.');
      if (current.coordinateSpace !== 'physical-screen-pixels') fail('coordinate_space', 'Engine coordinate space is not physical-screen-pixels.');
      return { ...window, title: current.windowTitle || '' };
    }
    const native = adjacentBounds ?? await this.bridge('identity', window, signal);
    if (native.hwnd !== window.id || native.pid !== window.pid || native.processCreationTime !== window.processCreationTime || native.sessionId !== window.sessionId) fail('window_identity_changed', 'The selected process identity changed.');
    return { ...window, title: typeof native.title === 'string' ? native.title : window.title || '' };
  }
  // The tree is serialized once: every selector-backed node is an element carrying its
  // treeNodeId/parentNodeId; `hierarchy` holds only selectorless structural nodes.
  // Offscreen nodes are omitted unless requested; kept descendants attach to the
  // nearest kept ancestor. The root is always kept.
  // Scoping: `rootElementId` walks only that element's subtree (winapp's selector argument) and
  // `interactiveOnly` reads the same tree and keeps only interactiveNode() nodes; survivors attach to
  // their nearest kept ancestor. TRACE filters instead of winapp -i, because -i drops Documents and
  // keeps every Gecko node. A subtree drops the window root, so a depth-1 read supplies it: bounds,
  // the capture selector and the movement guards stay window-level, and the window root stays the
  // first element unless a subtree is requested.
  async inspect(window, signal, depth = 8, { includeOffscreen = false, rootElementId, interactiveOnly = false } = {}) {
    const scoped = rootElementId !== undefined;
    const read = async (args, missing) => {
      const result = await this.command('inspect', ['-w', id(window.id), ...args], signal);
      const entry = result.windows?.find(candidate => String(candidate.hwnd) === window.id);
      if (!entry || entry.coordinateSpace !== 'physical-screen-pixels' || !Array.isArray(entry.elements) || (missing && !entry.elements.length)) fail('invalid_native_response', missing || 'Exact target UIA root was not returned.');
      return entry;
    };
    const windowEntry = scoped ? await read(['--depth', '1'], 'Exact target UIA root was not returned.') : null;
    // winapp 0.7.1 can answer an unresolved selector with the window root, or fail with a generic
    // error. A subtree read therefore counts only when its single top node is the requested element.
    const scopeLost = () => fail('element_not_found', 'The scope root is not in this window now. Observe without rootElementId.');
    const deep = ['--depth', String(depth)];
    let entry;
    if (scoped) {
      try { entry = await read([...deep, '--', selector(rootElementId)]); }
      catch (error) { if (signal?.aborted || !['element_not_found', 'stale_element', 'internal_error'].includes(error.code)) throw error; scopeLost(); }
      if (entry.elements.length !== 1 || entry.elements[0]?.selector !== rootElementId) scopeLost();
    } else entry = await read(deep, 'Exact target UIA root was not returned.');
    return this.inspectState(entry, windowEntry, depth, { includeOffscreen, rootElementId, interactiveOnly });
  }
  inspectState(entry, windowEntry, depth, { includeOffscreen, rootElementId, interactiveOnly }) {
    const scoped = rootElementId !== undefined;
    const root = (windowEntry ?? entry).elements[0];
    const flat = [], hierarchy = [], active = new WeakSet();
    let visited = 0, kept = 0, offscreenOmitted = 0, filteredOut = 0, truncated = false;
    // The top node of a walk (window root or scope root) is always kept.
    const starts = entry.elements, tops = new Set(scoped ? starts : [starts[0]]);
    const inside = (element, within) => within === 'skip' || within === 'item' ? within
      : element.type === 'ScrollBar' ? 'skip' : ITEM_TYPES.has(element.type) ? 'item' : element.type;
    // keptParent is the nearest kept ancestor's raw node, for the duplicate Group rule.
    const visit = (element, parentNodeId = null, nestingDepth = 0, within = undefined, keptParent = null) => {
      if (!object(element) || active.has(element)) fail('invalid_native_response', 'UIA tree contains an invalid node or cycle.');
      if (visited >= 10000 || nestingDepth > 32) fail('native_output_limit', 'UIA tree exceeds its node/depth bounds.');
      if (element.children != null && !Array.isArray(element.children)) fail('invalid_native_response', 'UIA children must be an array.');
      active.add(element);
      visited++;
      const offscreen = !includeOffscreen && element.isOffscreen === true;
      const duplicate = interactiveOnly && !offscreen && duplicateGroup(element, keptParent);
      if ((offscreen || (interactiveOnly && (duplicate || !interactiveNode(element, within)))) && !tops.has(element)) {
        if (offscreen) offscreenOmitted++; else filteredOut++;
        const below = interactiveOnly && (within === 'skip' || element.type === 'ScrollBar') ? 'skip' : duplicate ? 'header' : within;
        for (const child of element.children || []) visit(child, parentNodeId, nestingDepth + 1, below, keptParent);
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
      for (const child of element.children || []) visit(child, nodeId, nestingDepth + 1, interactiveOnly ? inside(element, within) : undefined, element);
      active.delete(element);
    };
    for (const element of starts) visit(element);
    return { bounds: bounds(root), rootSelector: selector(root.selector), elements: flat, hierarchy,
      coordinateSpace: entry.coordinateSpace, depth, truncated, includeOffscreen, offscreenOmitted, nodeCount: kept,
      ...(scoped ? { rootElementId } : {}), ...(interactiveOnly ? { interactiveOnly: true, filteredOut } : {}) };
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
  async focused(window, signal, elements, state, receipt) {
    const result = receipt ?? await this.command('get-focused', ['-w', window.id], signal);
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
    // An ID absent from this observation is usually below the observed depth or outside rootElementId.
    // The code stays stale_element for compatibility; reason and message name the fix.
    if (!candidates.length) fail('stale_element', 'documentElementId is not in the tree observed now. Raise accessibilityDepth until the control is listed, or set rootElementId to its parent control, then read again.', { reason: 'not_in_observed_tree' });
    if (candidates.length !== 1) fail('ambiguous_element', 'Document target must be a unique currently observed control.');
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
  async observeVisual({ window, screenshotPath, signal, related = false, relatedImagePrefix }) {
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
    const relatedWindows = related ? await measure('related', () => this.relatedWindows(window, signal, relatedImagePrefix)) : undefined;
    const current = await this.currentVisualWindow(window, { signal }), after = await this.bridge('bounds', window, signal);
    if (after.processCreationTime !== current.processCreationTime || after.sessionId !== current.sessionId) fail('window_identity_changed', 'Native lifetime changed after visual capture.');
    if (after.minimized || !sameBounds(after.frameBounds, frame) || !sameBounds(after.windowBounds, outer)) fail('window_moved', 'Window moved during visual observation.');
    return { window: { ...current, bounds: frame }, bounds: frame, elements: [],
      focused: { available: false, code: 'visual_only' },
      targetState: { enabled: after.enabled, minimized: after.minimized, foreground: after.foreground, provenance: 'public-win32-dwm' },
      restoredFromMinimized: restored, captureMethod: capture.method, screenshot: { path: screenshotPath, mimeType: 'image/png', ...size },
      ...(relatedWindows ? { relatedWindows } : {}) };
  }
  async observe({ window, screenshotPath, signal, depth = 8, includeScreenshot = true, documentElementId, visualOnly = false, includeOffscreen = false, rootElementId, interactiveOnly = false, related = false, relatedImagePrefix }) {
    if (typeof related !== 'boolean' || (relatedImagePrefix !== undefined && !related)) fail('invalid_observation', 'related must be a boolean, and related images need related.');
    if (typeof includeOffscreen !== 'boolean' || typeof interactiveOnly !== 'boolean') fail('invalid_observation', 'includeOffscreen and interactiveOnly must be booleans.');
    if (rootElementId !== undefined && (visualOnly || selector(rootElementId) !== rootElementId)) fail('invalid_observation', 'rootElementId needs an accessibility tree.');
    if (typeof visualOnly !== 'boolean' || (visualOnly && (!includeScreenshot || documentElementId !== undefined))) fail('invalid_observation', 'Visual-only capture cannot include document reads or omit PNG.');
    if (visualOnly) return this.observeVisual({ window, screenshotPath, signal, related, relatedImagePrefix });
    if (typeof includeScreenshot !== 'boolean') fail('invalid_observation', 'includeScreenshot must be a boolean.');
    if (documentElementId !== undefined && (includeScreenshot || selector(documentElementId) !== documentElementId)) fail('invalid_document_request', 'Document reads require accessibility-only observation.');
    if (includeScreenshot && (typeof screenshotPath !== 'string' || !path.isAbsolute(screenshotPath) || path.extname(screenshotPath).toLowerCase() !== '.png')) fail('invalid_screenshot_path', 'An absolute PNG output path is required.');
    if (!includeScreenshot && screenshotPath !== undefined) fail('invalid_screenshot_path', 'A screenshot path is not allowed when capture is omitted.');
    // The controller has just run the guard, so the opening bounds receipt re-proves a pinned identity.
    // An unpinned window is checked by name before its geometry is read.
    const pinned = window.processCreationTime !== undefined;
    if (!pinned) await measure('identity', () => this.identity(window, signal));
    let geometry = await measure('geometry', () => this.bridge('bounds', window, signal));
    if (pinned) await measure('identity', () => this.identity(window, signal, geometry));
    const restored = geometry.minimized === true;
    if (restored) {
      await measure('restore', () => this.bridge('activate', window, signal));
      geometry = await measure('settle', () => this.settledBounds(window, signal));
    }
    if (pinned && this.supervisor?.ready && this.supervisor.readiness?.readWorker === true && documentElementId === undefined
      && rootElementId === undefined && relatedImagePrefix === undefined && !restored) {
      const warm = await this.observeWarm({ window, signal, depth, includeOffscreen, interactiveOnly, related, screenshotPath });
      if (warm) return warm;
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
    // Read next to the capture: popups are transient. The identity and geometry checks below still bracket it.
    const relatedWindows = related ? await measure('related', () => this.relatedWindows(window, signal, relatedImagePrefix)) : undefined;
    const documentRead = documentElementId === undefined ? undefined
      : await measure('document', () => this.readDocument(window, signal, state.elements, documentElementId));
    const current = await measure('identity', () => this.identity(window, signal));
    // Only the root rectangle is compared here. Depth zero in the pinned CLI reads the root
    // and reports its truncation without walking its children. Public observation depth is unchanged.
    const after = await measure('uia', () => this.inspect(window, signal, 0));
    const afterGeometry = await measure('geometry', () => this.bridge('bounds', window, signal));
    if (!sameBounds(state.bounds, after.bounds) || !sameBounds(bounds(geometry.frameBounds), bounds(afterGeometry.frameBounds)) || !sameBounds(bounds(geometry.windowBounds), bounds(afterGeometry.windowBounds))) fail('window_moved', 'Window moved during observation; request a fresh observation.');
    let focused;
    try { focused = await measure('focus', () => this.focused(window, signal, state.elements, state)); }
    catch (error) { if (signal?.aborted) throw error; focused = { available: false, code: error.code || 'focus_query_failed' }; }
    if (window.processCreationTime !== undefined && afterGeometry.processCreationTime !== window.processCreationTime) fail('window_identity_changed', 'The selected process was replaced.');
    return { ...state, ...(documentRead ? { documentRead } : {}), window: { ...current, bounds: captured }, bounds: captured, uiaBounds: state.bounds, nativeWindowBounds: bounds(geometry.windowBounds), frameBounds: bounds(geometry.frameBounds), ...(Number.isInteger(afterGeometry.dpi) && afterGeometry.dpi > 0 ? { dpi: afterGeometry.dpi } : {}), ...(typeof afterGeometry.dpiAwareness === 'string' ? { dpiAwareness: afterGeometry.dpiAwareness } : {}), focused,
      targetState: { enabled: afterGeometry.enabled, minimized: afterGeometry.minimized, foreground: afterGeometry.foreground, ownerWindowId: afterGeometry.ownerWindowId ?? null, provenance: 'public-win32-dwm' },
      restoredFromMinimized: restored, ...(includeScreenshot ? { captureMethod: 'window-capture-dwm-bounds', actionCoordinateSpace: 'window-local-pixels', screenshot: { path: screenshotPath, mimeType: 'image/png', ...size } } : {}),
      ...(relatedWindows ? { relatedWindows } : {}) };
  }
  async observeWarm({ window, signal, depth, includeOffscreen, interactiveOnly, related, screenshotPath }) {
    let receipt;
    try {
      if (screenshotPath) count('captureRequests');
      receipt = await measure('uia', () => this.bridge('observe', window, signal, [
        String(depth), window.processCreationTime, String(window.sessionId), related ? 'related' : 'none', screenshotPath ?? ''
      ]));
    } catch (error) {
      if (signal?.aborted || !['worker_read_failed', 'coordinate_space'].includes(error.code)) throw error;
      // Some UIA providers only support the isolated CLI path. The worker writes a PNG before
      // its last guard, so remove a failed request's partial frame before falling back.
      if (screenshotPath) await fs.rm(screenshotPath, { force: true });
      return undefined;
    }
    const current = await this.identity(window, signal, receipt.identity);
    const geometry = receipt.bounds;
    await this.identity(window, signal, geometry);
    if (geometry.minimized) fail('window_moved', 'Window was minimized during observation.');
    if (!Array.isArray(receipt.elements) || receipt.elements.length !== 1)
      fail('invalid_native_response', 'Worker did not return the exact UIA root.');
    const state = this.inspectState({ elements: receipt.elements, coordinateSpace: 'physical-screen-pixels' }, null, depth,
      { includeOffscreen, interactiveOnly });
    const frame = bounds(geometry.frameBounds), captured = captureBounds(frame, state.bounds);
    const screenshot = receipt.screenshot;
    if (screenshotPath && (screenshot?.filePath !== screenshotPath || screenshot.width !== captured.width || screenshot.height !== captured.height))
      fail('invalid_screenshot', 'Worker screenshot does not match the exact window rectangle.');
    let relatedWindows;
    if (related) {
      try { relatedWindows = normalizeRelated(receipt.related); }
      catch (error) { relatedWindows = { available: false, code: error.code || 'related_unavailable' }; }
    }
    let focused;
    try { focused = receipt.focused ? await this.focused(window, signal, state.elements, state, receipt.focused) : { available: false, code: 'focus_query_failed' }; }
    catch (error) { if (signal?.aborted) throw error; focused = { available: false, code: error.code || 'focus_query_failed' }; }
    return { ...state, runtimeIds: receipt.runtimeIds, window: { ...current, bounds: captured }, bounds: captured, uiaBounds: state.bounds,
      nativeWindowBounds: bounds(geometry.windowBounds), frameBounds: frame, dpi: geometry.dpi, dpiAwareness: geometry.dpiAwareness,
      focused, targetState: { enabled: geometry.enabled, minimized: false, foreground: geometry.foreground,
        ownerWindowId: geometry.ownerWindowId ?? null, provenance: 'public-win32-dwm' }, restoredFromMinimized: false,
      ...(related ? { relatedWindows } : {}),
      ...(screenshotPath ? { captureMethod: 'window-capture-dwm-bounds', actionCoordinateSpace: 'window-local-pixels',
        screenshot: { path: screenshotPath, mimeType: 'image/png', width: screenshot.width, height: screenshot.height } } : {}) };
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
    if (action.type === 'click' && this.supervisor?.ready && this.supervisor.readiness?.readWorker === true && window.processCreationTime
      && observation.rootElementId === undefined && (action.button ?? 'left') === 'left' && (action.count ?? 1) === 1) {
      const selected = action.elementId ? observation.elements.find(item => item.id === action.elementId) : undefined;
      if (!action.elementId || (selected?.enabled && selected.id === selected.automationId && selected.bounds
        && Array.isArray(observation.runtimeIds?.[selected.id]))) {
        return this.guardedClick(window, observation, action, selected, signal, progress);
      }
    }
    const pointerClick = action.type === 'click' && ((action.button ?? 'left') !== 'left' || (action.count ?? 1) !== 1);
    const pointWheel = action.type === 'scroll' && action.placement === 'point';
    if (action.type === 'accessibility_action' && !this.supervisor?.ready) fail('supervision_required', 'Named UIA actions require native supervision.', { outcome: 'not_dispatched' });
    if ((pointerClick || pointWheel) && !this.supervisor?.ready) fail('supervision_required', 'Extended pointer input requires declared-input native supervision.', { outcome: 'not_dispatched' });
    // The controller has just run the guard; the bounds receipt after this read re-proves identity.
    // Reinspect at the server-retained depth and scope so deeply or narrowly observed controls remain targetable.
    const fresh = await this.inspect(window, signal, observation.depth ?? 8, { includeOffscreen: observation.includeOffscreen === true,
      ...(observation.rootElementId !== undefined ? { rootElementId: observation.rootElementId } : {}), interactiveOnly: observation.interactiveOnly === true });
    const geometry = await this.bridge('bounds', window, signal);
    await this.identity(window, signal, geometry);
    if (geometry.enabled === false) fail('window_blocked', 'The selected window is disabled. Select its enabled dialog explicitly before input.', { outcome: 'not_dispatched' });
    const captured = captureBounds(bounds(geometry.frameBounds), fresh.bounds);
    if (geometry.minimized || !sameBounds(observation.uiaBounds, fresh.bounds) || !sameBounds(observation.frameBounds, geometry.frameBounds) || !sameBounds(observation.nativeWindowBounds, geometry.windowBounds) || !sameBounds(observation.bounds, captured)) fail('window_moved', 'Window moved or resized since observation. Observe again.');
    const choose = elementId => {
      const old = observation.elements?.find(element => element.id === elementId);
      const now = fresh.elements.find(element => element.id === elementId);
      if (!old || !now || !now.enabled || old.enabled !== now.enabled || old.name !== now.name || old.controlType !== now.controlType || (old.bounds && (!now.bounds || !sameBounds(old.bounds, now.bounds)))) fail('stale_element', 'Element changed since observation. Observe again.');
      return selector(elementId);
    };
    // Screen points where winapp will press or wheel; checked against the window's own popups before dispatch.
    let verb, positional = [], options = [], transport, pointerArgs, hitPoints = [];
    const center = rect => ({ x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) });
    const screen = (x, y) => ({ x: captured.x + x, y: captured.y + y });
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
        if (action.elementId) {
          verb = 'click'; positional = [choose(action.elementId)];
          const rect = fresh.elements.find(item => item.id === action.elementId)?.bounds;
          if (rect) hitPoints = [center(rect)];
        }
        else {
          const p = point(action.x, action.y, captured); hitPoints = [screen(action.x, action.y)];
          // The public drag command documents same-point, zero-hold button down/up gestures.
          verb = 'drag'; positional = [p, p]; options = ['--hold-ms', '0']; transport = 'same-point-button-down-up';
        }
        break;
      case 'type_text':
        if (action.expectedFocusElementId !== undefined) {
          if (observation.focused?.available !== true || observation.focused.hasFocus !== true
            || observation.focused.elementId !== action.expectedFocusElementId) {
            fail('focus_changed', 'Expected typing focus differs from the observed bound control.', { outcome: 'not_dispatched' });
          }
          choose(action.expectedFocusElementId);
        }
        verb = 'send-keys'; positional = [action.text]; options = ['--via', 'send-input', '--verbatim']; break;
      case 'press_key': {
        const key = normalizeKey(action.key);
        verb = 'send-keys'; positional = [key]; options = ['--via', 'send-input']; break;
      }
      case 'drag': verb = 'drag'; positional = [point(action.fromX, action.fromY, captured), point(action.toX, action.toY, captured)];
        hitPoints = [screen(action.fromX, action.fromY), screen(action.toX, action.toY)]; break;
      case 'scroll': {
        if (pointWheel) {
          pointerArgs = [...point(action.x, action.y, captured).split(','), String(action.deltaX), String(action.deltaY)];
          verb = 'wheel'; transport = 'supervised-public-win32'; break;
        }
        point(action.x, action.y, captured);
        const physicalX = captured.x + action.x, physicalY = captured.y + action.y;
        const candidates = fresh.elements.filter(element => element.enabled && !element.offscreen && element.bounds && physicalX >= element.bounds.x && physicalY >= element.bounds.y && physicalX < element.bounds.x + element.bounds.width && physicalY < element.bounds.y + element.bounds.height).sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
        if (!candidates.length) fail('unsupported_action', 'No observed element is available under the wheel position.');
        verb = 'scroll'; positional = [choose(candidates[0].id)]; options = ['--wheel', String(-action.deltaY / 120)]; transport = 'wheel-at-element-center';
        hitPoints = [center(candidates[0].bounds)]; break;
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
    // R21: activation leaves an open menu or tooltip in place, and winapp presses at screen points
    // without an occlusion check, so a popup of this window over a point would take the input.
    if (hitPoints.length) await this.assertNoOwnPopup(window, signal, hitPoints);
    // Typed text is checked against the focused control's text (D1: SendInput reported success while
    // Notepad dropped the second 16-character chunk). Enter and Tab may submit or move focus, so text
    // holding them is not checked.
    const checkText = action.type === 'type_text' && !/[\r\n\t]/.test(action.text);
    let typedTarget, textBefore;
    if (action.type === 'type_text' || action.type === 'press_key') {
      // The text is read before focus is verified, so focus cannot move unchecked between the read
      // and input: the observed focus must match the verified one. Without an observed focus, the
      // focus is verified again after the read.
      const expected = observation.focused?.hasFocus ? observation.focused.elementId : undefined;
      if (checkText && expected) textBefore = await this.typedText(window, signal, fresh.elements, expected);
      const focused = await this.focused(window, signal, fresh.elements, fresh);
      if (!focused.hasFocus) fail('focus_not_acquired', 'Keyboard focus could not be verified inside the exact selected window.');
      if (observation.focused?.hasFocus && observation.focused.elementId !== focused.elementId) fail('focus_changed', 'Focused control changed since observation. Observe again.');
      if (!focused.elementId) fail('focus_not_acquired', 'Keyboard focus could not be bound to an observed control inside the exact selected window.');
      if (action.expectedFocusElementId !== undefined && focused.elementId !== action.expectedFocusElementId) {
        fail('focus_changed', 'Activation did not preserve the intended typing control.', { outcome: 'not_dispatched' });
      }
      typedTarget = focused.elementId;
      if (checkText && !expected) {
        textBefore = await this.typedText(window, signal, fresh.elements, typedTarget);
        const again = await this.focused(window, signal, fresh.elements, fresh);
        if (!again.hasFocus || again.elementId !== typedTarget) fail('focus_changed', 'Focus moved while the control text was read. Observe again.', { outcome: 'not_dispatched' });
      }
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
    const textDelivery = action.type !== 'type_text' ? undefined
      : !checkText ? { status: 'not_checked', reason: 'control_characters' }
      : typeof textBefore !== 'string' ? { status: 'not_checked', reason: 'text_unreadable' }
      : await this.textDelivery(window, signal, fresh.elements, typedTarget, textBefore, action.text);
    // A shortfall (status missing) is returned, not thrown: the controller still refreshes the
    // observation, then reports the act as unknown with text_not_delivered.
    return { performed: true, type: action.type, engine: pointerArgs ? 'public-win32-sendinput' : 'winapp', version: pointerArgs ? 1 : pin.version, ...(transport ? { transport } : {}), preparation: progress.preparation, native: result,
      ...(textDelivery ? { textDelivery } : {}) };
  }
  // The focused control's text, or undefined when it cannot be read exactly (no TextPattern, a
  // password field, truncated at the read bound, or a control that changed).
  async guardedClick(window, observation, action, element, signal, progress) {
    const coordinates = rect => ['x', 'y', 'width', 'height'].map(key => rect[key]);
    const geometry = [observation.nativeWindowBounds, observation.frameBounds, observation.uiaBounds].flatMap(coordinates);
    const x = element ? Math.floor(element.bounds.x + element.bounds.width / 2) : observation.bounds.x + action.x;
    const y = element ? Math.floor(element.bounds.y + element.bounds.height / 2) : observation.bounds.y + action.y;
    const target = element && { id: element.id, name: element.name, type: element.controlType,
      className: element.className ?? '', ...element.bounds, runtimeId: observation.runtimeIds[element.id] };
    progress.primary = true;
    const native = await this.bridge('guarded-click', window, signal, [JSON.stringify({
      created: window.processCreationTime, session: window.sessionId, geometry, x, y, target
    })]);
    if (native.activated === true) progress.preparation.push({ step: 'activation', status: 'foreground' });
    if (native.performed === false && native.refusedBeforeSend === true)
      fail(native.code, native.message, { outcome: 'not_dispatched', refusedBeforeSend: true });
    if (native.performed !== true || native.operation !== 'click' || native.inputEvents !== 2)
      fail('invalid_native_response', 'Pointer receipt did not confirm both events.');
    return { performed: true, type: 'click', engine: 'public-win32-sendinput', version: 1,
      transport: 'supervised-public-win32', preparation: progress.preparation, native };
  }
  async typedText(window, signal, elements, elementId) {
    try {
      const read = await this.readDocument(window, signal, elements, elementId);
      return read.document?.available && !read.document.truncated ? read.document.text.replace(/\r\n?/g, '\n') : undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }
  // SendInput returns before the target has processed its queue, so the text is polled briefly.
  // Polling stops at once when the text cannot be read: it will not become readable.
  async textDelivery(window, signal, elements, elementId, before, text, { timeoutMs = 1500, intervalMs = 100 } = {}) {
    const started = Date.now();
    let after;
    for (;;) {
      after = await this.typedText(window, signal, elements, elementId);
      if (typeof after !== 'string') return { status: 'not_checked', reason: 'text_unreadable' };
      if (after !== before && deliveredPrefix(before, after, text) === text.length) return { status: 'verified' };
      if (Date.now() - started >= timeoutMs) break;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      signal?.throwIfAborted();
    }
    // Unchanged text that already holds the typed text cannot tell delivery over an identical
    // selection from a drop. Otherwise unchanged text means nothing arrived.
    if (after === before) return deliveredPrefix(before, after, text) === text.length
      ? { status: 'not_checked', reason: 'text_unchanged' } : { status: 'missing', prefixFound: 0, unchanged: true };
    return { status: 'missing', prefixFound: Math.max(0, deliveredPrefix(before, after, text)) };
  }
  async close() {
    if (this.supervisor?.child && this.supervisor.owner) await this.supervisor.release(this.supervisor.owner);
  }
}

module.exports = { WinappBackend, deliveredPrefix, BackendError, DEFAULT_BINARY, DEFAULT_BRIDGE, BRIDGE_OUTPUTS, pin, runProcess, parseJson, pngSize, readPngHeader, verifyFiles, verifyBridgeFiles, bridgeSourceHashes };
