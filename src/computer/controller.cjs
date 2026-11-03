'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DesktopLease } = require('./lease.cjs');
const { ActivityIndicator } = require('./activity-indicator.cjs');
const { validateAction, actionSupport, compactSupport } = require('./action-contract.cjs');
const { createObservationMetrics, measure, count } = require('./observation-metrics.cjs');
const { parseCaptureKeepLast, createCaptureRetention } = require('./capture-retention.cjs');
const { downscalePng, DEFAULT_MAX_EDGE } = require('./png-scale.cjs');

const fail = (code, message) => Object.assign(new Error(message), { code });
const identityMatches = (a, b) => a && b && a.id === b.id && a.pid === b.pid && a.processName === b.processName
  && (b.processCreationTime === undefined || a.processCreationTime === b.processCreationTime)
  && (b.sessionId === undefined || a.sessionId === b.sessionId);
function safeError(error) {
  const result = { code: typeof error.code === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(error.code)
    ? error.code : 'backend_error', message: String(error.message).slice(0, 1500) };
  if (['unknown', 'not_dispatched'].includes(error.details?.outcome)) result.outcome = error.details.outcome;
  if (error.details?.cleanup === 'unknown') result.cleanup = 'unknown';
  if (Array.isArray(error.cleanupCodes)) result.cleanupCodes = error.cleanupCodes
    .filter(code => typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)).slice(0, 8);
  const recovery = error.details?.recovery;
  if (recovery && typeof recovery.attempted === 'boolean') {
    result.recovery = { attempted: recovery.attempted };
    if (typeof recovery.released === 'boolean') result.recovery.released = recovery.released;
    if (typeof recovery.processExitConfirmed === 'boolean') result.recovery.processExitConfirmed = recovery.processExitConfirmed;
    if (recovery.button === 'left') result.recovery.button = 'left';
    if (recovery.method === 'public-win32-sendinput') result.recovery.method = recovery.method;
    if (recovery.method === 'declared-sendinput') result.recovery.method = recovery.method;
    if (['native_drained', 'not_dispatched', 'process_exit_unconfirmed', 'cancelled', 'native_timeout', 'physical_escape', 'parent_exited', 'stdin_eof', 'normal_exit', 'operation_failed', 'input_release_unconfirmed'].includes(recovery.reason)) result.recovery.reason = recovery.reason;
    if (typeof recovery.code === 'string' && /^[a-z_]{1,64}$/.test(recovery.code)) result.recovery.code = recovery.code;
  }
  if (Array.isArray(error.details?.preparation)) {
    result.preparation = error.details.preparation.filter(item => item?.step === 'activation').slice(0, 8).map(item => ({ step: 'activation', status: ['started', 'foreground', 'not_foreground'].includes(item.status) ? item.status : 'unknown' }));
  }
  if (error.details?.inputRecoveryRequired === true || result.cleanup === 'unknown' || result.code === 'input_recovery_required' || recovery?.released === false || recovery?.reason === 'process_exit_unconfirmed') result.inputRecoveryRequired = true;
  return result;
}

function defaultRuntimeDirectory() {
  if (process.env.TRACE_COMPUTER_RUNTIME) {
    if (!path.isAbsolute(process.env.TRACE_COMPUTER_RUNTIME)) throw fail('invalid_runtime_directory', 'TRACE_COMPUTER_RUNTIME must be an absolute directory.');
    return process.env.TRACE_COMPUTER_RUNTIME;
  }
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'TRACE', 'computer');
}

const DEFAULT_DEPTH = 8;
function validateDepth(depth) {
  if (depth === undefined) return DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw fail('invalid_depth', 'accessibilityDepth must be an integer from 1 to 32.');
  return depth;
}
function validateObservationMode(mode = 'full') {
  if (!['full', 'accessibility', 'screenshot'].includes(mode)) throw fail('invalid_observation_mode', 'mode must be full, accessibility or screenshot.');
  return mode;
}
const SCREENSHOT_MODES = ['none', 'scaled', 'full'];
// Pixels are evidence, not authority: dispatch guards use UIA bounds and DWM geometry, so a
// full observation without a PNG still authorizes one action.
function validateScreenshot(screenshot, mode) {
  const fallback = mode === 'accessibility' ? 'none' : 'full';
  if (screenshot === undefined) return fallback;
  if (!SCREENSHOT_MODES.includes(screenshot)) throw fail('invalid_observation', 'screenshot must be none, scaled or full.');
  if (mode === 'accessibility' && screenshot !== 'none') throw fail('invalid_observation', 'Accessibility mode has no screenshot.');
  if (mode === 'screenshot' && screenshot === 'none') throw fail('invalid_observation', 'Screenshot mode requires an image.');
  return screenshot;
}
const validElementId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.startsWith('-') && !/[\u0000-\u001f]/.test(value);
// rootElementId observes one subtree of the window; interactiveOnly keeps interactive controls
// (and truncation markers) under their nearest kept ancestor. Neither applies to screenshot mode.
function validateScope(rootElementId, interactiveOnly, mode) {
  if (rootElementId === undefined && interactiveOnly === undefined) return {};
  if (mode === 'screenshot') throw fail('invalid_observation', 'Screenshot mode has no accessibility tree to scope.');
  if (rootElementId !== undefined && !validElementId(rootElementId)) throw fail('invalid_observation', 'rootElementId must be an observed element ID.');
  if (interactiveOnly !== undefined && typeof interactiveOnly !== 'boolean') throw fail('invalid_observation', 'interactiveOnly must be a boolean.');
  return { ...(rootElementId === undefined ? {} : { rootElementId }), ...(interactiveOnly ? { interactiveOnly: true } : {}) };
}
const RETURN_OBSERVATIONS = ['full', 'summary', 'none'];
const DIFF_LIMIT = 15;
const short = value => { const text = String(value ?? ''); return text.length > 80 ? `${text.slice(0, 79)}…` : text; };
const sameRect = (a, b) => (!a && !b) || (a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]));
function compactFocus(focused) {
  if (!focused || focused.available === false || !focused.hasFocus) return focused ? { available: focused.available !== false, hasFocus: false, ...(focused.code ? { code: focused.code } : {}) } : { available: false };
  return { hasFocus: true, elementId: focused.elementId ?? null, name: short(focused.name), controlType: focused.controlType, ...(focused.binding ? { binding: focused.binding } : {}) };
}
// A bounded element diff between the consumed observation and the fresh one, keyed by element ID.
function elementDiff(before = [], after = []) {
  const old = new Map(), now = new Map();
  for (const item of before) if (!old.has(item.id)) old.set(item.id, item);
  for (const item of after) if (!now.has(item.id)) now.set(item.id, item);
  const added = [], removed = [], changed = [];
  for (const [id, item] of now) {
    const prior = old.get(id);
    if (!prior) { added.push({ id, name: short(item.name), controlType: item.controlType }); continue; }
    const fields = ['name', 'enabled', 'offscreen', 'toggleState', 'expandState'].filter(key => prior[key] !== item[key]);
    if (!sameRect(prior.bounds, item.bounds)) fields.push('bounds');
    if (fields.length) changed.push({ id, fields, ...(fields.includes('name') ? { name: short(item.name) } : {}),
      ...(fields.includes('toggleState') ? { toggleState: item.toggleState } : {}), ...(fields.includes('expandState') ? { expandState: item.expandState } : {}) });
  }
  for (const id of old.keys()) if (!now.has(id)) removed.push(id);
  const truncated = added.length > DIFF_LIMIT || removed.length > DIFF_LIMIT || changed.length > DIFF_LIMIT;
  return { counts: { added: added.length, removed: removed.length, changed: changed.length },
    ...(added.length ? { added: added.slice(0, DIFF_LIMIT) } : {}), ...(removed.length ? { removed: removed.slice(0, DIFF_LIMIT) } : {}),
    ...(changed.length ? { changed: changed.slice(0, DIFF_LIMIT) } : {}), ...(truncated ? { truncated: true } : {}) };
}
function actSummary(before, fresh) {
  const titleChanged = before.window?.title !== fresh.window?.title;
  return { elementCount: fresh.elements?.length ?? 0, focused: compactFocus(fresh.focused),
    ...(titleChanged ? { titleChanged: true, title: short(fresh.window?.title) } : {}),
    targetState: fresh.targetState, changes: elementDiff(before.elements, fresh.elements) };
}

// The default listing drops windows an agent cannot use: tiny or zero-size helpers, cloaked shell
// hosts (lock screen, touch keyboard, Start, Search, notification surfaces), explorer helper
// classes and untitled UWP frames. `verbose` lists everything with every identity field.
const SHELL_PROCESSES = new Set(['lockapp', 'textinputhost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost']);
const SHELL_CLASSES = new Set(['ThumbnailDeviceHelperWnd', 'EdgeUiInputTopWndClass', 'Windows.Internal.Shell.TabProxyWindow',
  'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW']);
const MIN_LISTED_EDGE = 8;
function listingNoise(window) {
  if (!(window.bounds?.width >= MIN_LISTED_EDGE && window.bounds?.height >= MIN_LISTED_EDGE)) return 'tiny';
  if (SHELL_PROCESSES.has(String(window.processName).toLowerCase()) || SHELL_CLASSES.has(window.className)) return 'shell';
  if (window.className === 'ApplicationFrameWindow' && !window.title) return 'untitled-frame';
  return null;
}
// Executable paths, process creation times and session IDs stay server-side for identity checks.
function listedWindow(window) {
  const title = String(window.title ?? '');
  return { id: window.id, pid: window.pid, processName: window.processName, title: title.length > 160 ? `${title.slice(0, 159)}…` : title,
    width: window.bounds?.width ?? null, height: window.bounds?.height ?? null,
    ...(window.foreground === true ? { foreground: true } : {}), ...(window.ownerWindowId ? { ownerWindowId: window.ownerWindowId } : {}),
    ...(window.identity?.available === false ? { identity: window.identity } : {}) };
}
const LIST_TEXT_LIMIT = 256;
function validateListing({ verbose, processName, title } = {}) {
  if (verbose !== undefined && typeof verbose !== 'boolean') throw fail('invalid_argument', 'verbose must be a boolean.');
  for (const [name, value] of [['processName', processName], ['title', title]]) {
    if (value !== undefined && (typeof value !== 'string' || !value || value.length > LIST_TEXT_LIMIT)) throw fail('invalid_argument', `${name} must be a non-empty string of at most ${LIST_TEXT_LIMIT} characters.`);
  }
  const wantedProcess = processName?.toLowerCase().replace(/\.exe$/, ''), wantedTitle = title?.toLowerCase();
  return { verbose: verbose === true, filtered: processName !== undefined,
    matches: window => (wantedProcess === undefined || String(window.processName).toLowerCase() === wantedProcess)
      && (wantedTitle === undefined || String(window.title ?? '').toLowerCase().includes(wantedTitle)) };
}

// An owned window of the session window, from the same process lifetime: the modal that disables it.
const ownsModal = (owner, window) => window.ownerWindowId === owner.id && window.pid === owner.pid
  && window.processCreationTime === owner.processCreationTime && !listingNoise(window) && window.identity?.available !== false;
const modalSummary = window => ({ windowId: window.id, title: listedWindow(window).title, width: window.bounds?.width ?? null, height: window.bounds?.height ?? null });
// Launch names come from the App Paths catalog: an EXE name, `.exe` optional, without a path or URI.
const LAUNCH_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;
const launchName = value => String(value).toLowerCase().replace(/\.exe$/, '');
// Live 2026-11-03: a window listing takes about 0.7 s and a handed-off window can take several
// seconds to appear, so launch uses the launcher's largest allowed deadline.
const LAUNCH_TIMEOUT_MS = 15000;

function createComputerController(options = {}) {
  const captureKeepLast = parseCaptureKeepLast(options.captureKeepLast === undefined ? process.env.TRACE_CAPTURE_KEEP_LAST : options.captureKeepLast);
  const backend = options.backend ?? new (require('./winapp-backend.cjs').WinappBackend)();
  const runtimeDirectory = path.resolve(options.runtimeDirectory ?? defaultRuntimeDirectory());
  // Artifact directories may differ between hosts. Desktop ownership must not.
  // userInfo comes from the OS rather than the configurable artifact path.
  const lease = options.lease ?? backend.supervisor ?? new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
  const indicator = options.indicator ?? backend.supervisor?.indicator() ?? new ActivityIndicator();
  const observationTtlMs = options.observationTtlMs ?? 60000;
  const now = options.now ?? Date.now;
  const shutdown = new AbortController();
  const sessions = new Map();
  let discovered = new Map();
  let queue = Promise.resolve();
  let closed = false;
  let closePromise;
  let observedBefore = false;
  // Apps whose last launch outcome was unknown are never relaunched automatically.
  const uncertainLaunches = new Set();
  const createApplications = options.createApplications ?? (() => require('../method/installed-applications.cjs')
    .createInstalledApplications({ backend, lease, timeoutMs: LAUNCH_TIMEOUT_MS }));

  function queued(work, callOptions = {}, allowClosed = false) {
    const signal = callOptions.signal ? AbortSignal.any([callOptions.signal, shutdown.signal]) : shutdown.signal;
    const pending = queue.then(() => {
      if (closed && !allowClosed) throw fail('controller_closed', 'Controller is closed.');
      if (!allowClosed) signal.throwIfAborted();
      return work(signal);
    });
    queue = pending.catch(() => {});
    return pending;
  }
  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw fail('unknown_session', 'Open a session for a discovered window first.');
    return session;
  }
  function targetWindows(windows) {
    return windows.filter(window => window.pid !== indicator.pid && String(window.processName).toLowerCase() !== 'traceactivityindicator');
  }
  function markedSignal(signal) {
    indicator.assertActive();
    const combined = AbortSignal.any([signal, indicator.signal]);
    combined.throwIfAborted();
    return combined;
  }
  async function cleanupSession(session, allowStorageCleanup = true) {
    const errors = [];
    // The operation queue has already drained native input/recovery before this runs.
    try { await indicator.stop(); } catch (error) { errors.push(error); }
    try { await lease.release(session.id); sessions.delete(session.id); } catch (error) { errors.push(error); }
    if (errors.length) {
      const error = errors.find(item => item.details?.recovery || item.details?.inputRecoveryRequired || item.code === 'input_recovery_required') || errors[0];
      error.details = { ...error.details, cleanup: 'unknown' };
      error.cleanupCodes = errors.flatMap(item => item.cleanupCodes || [item.code || 'cleanup_failed']);
      throw error;
    }
    if (allowStorageCleanup && session.captureRetention) return session.captureRetention.close();
  }
  async function currentWindow(session, signal, visualOnly = false) {
    const read = visualOnly && backend.currentVisualWindow ? backend.currentVisualWindow : backend.currentWindow;
    const current = read ? await read.call(backend, session.window, { signal })
      : (await backend.listWindows({ signal })).find(window => window.id === session.window.id);
    if (!identityMatches(current, session.window)) {
      session.observation = null;
      throw fail('window_changed', 'The selected window closed or its process identity changed. Open a new session.');
    }
    return current;
  }
  async function targetClosed(session, signal) {
    if (typeof backend.targetClosed !== 'function') return false;
    try { return await backend.targetClosed(session.window, { signal }) === true; } catch { return false; }
  }
  // Lists once and returns the session window's owned modals, which also become selectable.
  async function ownedModals(session, signal) {
    try {
      const windows = targetWindows(await backend.listWindows({ signal }));
      for (const window of windows) discovered.set(window.id, window);
      return windows.filter(window => ownsModal(session.window, window));
    } catch (error) { if (signal.aborted) throw error; return []; }
  }
  async function reportModal(session, result, signal) {
    if (result?.targetState?.enabled !== false) return result;
    const modals = await ownedModals(session, signal);
    if (modals.length) result.ownedModal = { ...modalSummary(modals[0]), ...(modals.length > 1 ? { count: modals.length } : {}),
      hint: 'Observe with followModal: true to work in it; the session returns here when it closes.' };
    return result;
  }
  // Retargets the session at its owned modal under the same lease; the owner is kept for the return.
  async function followModal(session, signal) {
    const [modal] = await ownedModals(session, signal);
    if (!modal) throw fail('no_owned_modal', 'The session window has no owned modal window to follow.');
    const { className, foreground, ...selected } = modal;
    const open = backend.openWindow ?? backend.currentWindow;
    const current = open ? await open.call(backend, selected, { signal }) : selected;
    if (!identityMatches(selected, current)) throw fail('window_changed', 'The owned modal changed. Observe again.');
    session.owners = [...(session.owners ?? []), session.window];
    session.window = current; session.observation = null;
    await record(session, { type: 'modal_followed', windowId: current.id, pid: current.pid });
  }
  async function record(session, event) {
    // No typed text, values, screenshots, or full window inventory in the journal.
    await fs.appendFile(path.join(session.directory, 'events.jsonl'), `${JSON.stringify({ at: new Date(now()).toISOString(), sessionId: session.id, ...event })}\n`);
  }
  async function observeInternal(session, signal, { depth = DEFAULT_DEPTH, mode = 'full', documentElementId, includeOffscreen = false, screenshot = mode === 'accessibility' ? 'none' : 'full', screenshotPreference = screenshot, scope = {}, metrics: reportMetrics = false } = {}) {
    // A valid selective read revokes input authority even if readiness/capture fails.
    if (mode !== 'full') session.observation = null;
    const metrics = createObservationMetrics({ clock: options.metricsClock,
      sample: observedBefore ? 'later-controller-attempt' : 'first-controller-attempt' });
    observedBefore = true;
    return metrics.run(async () => {
      const result = await measure('observation', () => observeMeasured(session, signal, depth, mode, documentElementId, includeOffscreen, screenshot, screenshotPreference, scope));
      // Stage timings are diagnostics, so they are returned only on request.
      if (reportMetrics) result.metrics = metrics.snapshot();
      if (session.observation?.id === result.observationId) session.observation.snapshot.metrics = reportMetrics;
      return result;
    });
  }
  async function observeMeasured(session, signal, depth, mode, documentElementId, includeOffscreen, screenshotMode, screenshotPreference, { rootElementId, interactiveOnly = false }) {
    signal = markedSignal(signal);
    await lease.assert(session.id);
    await measure('identity', () => currentWindow(session, signal, mode === 'screenshot'));
    session.observation = null;
    const observationId = randomUUID();
    const capture = screenshotMode !== 'none';
    const screenshotPath = capture ? path.join(session.directory, `${observationId}.png`) : undefined;
    const snapshot = await measure('backend', () => backend.observe({ window: session.window, screenshotPath, signal, depth,
      ...(!capture ? { includeScreenshot: false } : {}),
      ...(mode === 'screenshot' ? { visualOnly: true } : {}),
      ...(includeOffscreen ? { includeOffscreen: true } : {}),
      ...(rootElementId === undefined ? {} : { rootElementId }), ...(interactiveOnly ? { interactiveOnly: true } : {}),
      ...(documentElementId === undefined ? {} : { documentElementId }) }));
    // The effective depth stays server-side with the observation; actions cannot replace it.
    snapshot.depth = Number.isInteger(snapshot.depth) ? snapshot.depth : depth;
    snapshot.includeOffscreen = includeOffscreen;
    // The scope is retained the same way, so dispatch and the post-action refresh reuse it.
    if (rootElementId === undefined) delete snapshot.rootElementId; else snapshot.rootElementId = rootElementId;
    snapshot.interactiveOnly = interactiveOnly;
    // What the caller asked for, kept for a later act with returnObservation: full.
    snapshot.screenshotPreference = screenshotPreference;
    if (!identityMatches(snapshot.window, session.window)) throw fail('window_changed', 'Observation returned a different window identity.');
    const bounds = snapshot.bounds;
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width < 1 || bounds.height < 1) throw fail('invalid_observation', 'Backend returned invalid window bounds.');
    let bytes, screenshot, width, height;
    if (capture) {
      if (path.resolve(snapshot.screenshot?.path ?? '') !== screenshotPath) throw fail('invalid_capture', 'Backend returned a different screenshot path.');
      const stat = await measure('fileStat', () => fs.stat(screenshotPath));
      if (stat.size > 6 * 1024 * 1024) throw fail('capture_too_large', 'Capture exceeds the 6 MiB image limit.');
      bytes = await measure('fileRead', () => fs.readFile(screenshotPath));
      count('controllerPngRead', bytes.length);
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('invalid_capture', 'Backend capture must be a PNG image.');
      width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
      if (width !== bounds.width || height !== bounds.height) throw fail('capture_mismatch', 'Screenshot dimensions differ from the observed window. Re-observe before input.');
    }
    count('elements', snapshot.elements?.length ?? 0);
    const observedAtMs = now();
    if (bytes) {
      // A scaled image is sent instead of the source; multiply its pixels by `scale.factor`
      // to get window-local physical coordinates.
      const scaled = screenshotMode === 'scaled' ? measure('scale', () => downscalePng(bytes, DEFAULT_MAX_EDGE)) : null;
      const sent = scaled ? scaled.data : bytes;
      screenshot = measure('hashEncode', () => ({ data: sent.toString('base64'), mimeType: 'image/png',
        width: scaled?.width ?? width, height: scaled?.height ?? height,
        ...(scaled ? { scale: { factor: scaled.factor, sourceWidth: width, sourceHeight: height, ...(scaled.reason ? { reason: scaled.reason } : {}) } } : {}),
        sha256: createHash('sha256').update(sent).digest('hex') }));
      count('base64', screenshot.data.length);
    }
    const result = {
      sessionId: session.id, observationId, window: snapshot.window, bounds,
      elements: snapshot.elements ?? [], observedAt: new Date(observedAtMs).toISOString(),
      coordinateSpace: 'window-local-physical-pixels', captureMethod: snapshot.captureMethod ?? 'native-window',
      accessibility: { truncated: snapshot.truncated === true, depth: snapshot.depth,
        ...(Number.isInteger(snapshot.offscreenOmitted) && snapshot.offscreenOmitted > 0 ? { offscreenOmitted: snapshot.offscreenOmitted } : {}),
        ...(rootElementId === undefined ? {} : { rootElementId }), ...(interactiveOnly ? { interactiveOnly: true } : {}),
        ...(Array.isArray(snapshot.hierarchy) && snapshot.hierarchy.length ? { hierarchy: snapshot.hierarchy } : {}) },
      ...(documentElementId === undefined ? {} : { documentRead: snapshot.documentRead }),
      focused: snapshot.focused ? { ...snapshot.focused } : { available: false, code: 'focus_unavailable' },
      targetState: snapshot.targetState ?? { available: false },
      ...(snapshot.restoredFromMinimized === true ? { preparation: [{ step: 'restore', status: 'restored' }] } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
    if (mode === 'full' && !screenshot) delete result.captureMethod;
    if (mode === 'full') session.observation = { id: observationId, observedAtMs, snapshot, result };
    else {
      Object.assign(result, { mode, actionable: false });
      if (mode === 'screenshot') { delete result.elements; delete result.accessibility; }
      else { delete result.screenshot; delete result.captureMethod; delete result.coordinateSpace; }
    }
    await measure('journal', () => record(session, { type: 'observation', observationId,
      ...(mode !== 'full' ? { mode } : {}), ...(screenshotMode !== (mode === 'accessibility' ? 'none' : 'full') ? { screenshot: screenshotMode } : {}),
      ...(screenshot ? { screenshotSha256: screenshot.sha256 } : {}) }));
    signal.throwIfAborted();
    indicator.assertActive();
    return result;
  }

  async function retainCapture(session, result, signal) {
    if (!session.captureRetention || !result.screenshot) return result;
    const file = path.join(session.directory, `${result.observationId}.png`);
    signal.throwIfAborted(); indicator.assertActive();
    try {
      result.captureRetention = await session.captureRetention.remember(file, session.observation?.snapshot.screenshot?.path);
      signal.throwIfAborted(); indicator.assertActive();
    } catch (error) {
      session.captureRetention.forget(file);
      if (session.observation?.id === result.observationId) session.observation = null;
      throw error;
    }
    return result;
  }

  return {
    // `verbose` travels with the call options, like the listing filters.
    doctor(callOptions = {}) {
      return queued(async signal => {
        if (callOptions.verbose !== undefined && typeof callOptions.verbose !== 'boolean') throw fail('invalid_argument', 'verbose must be a boolean.');
        const result = await backend.doctor({ signal });
        return { ...result, support: callOptions.verbose ? actionSupport(observationTtlMs) : compactSupport(observationTtlMs),
          observationModes: { default: 'full', actionable: ['full'], evidenceOnly: ['accessibility', 'screenshot'], screenshotRequiresReadableUiaRoot: false,
            screenshotModes: { values: [...SCREENSHOT_MODES], default: 'full', actionableWithout: true, scaledMaxEdge: DEFAULT_MAX_EDGE } },
          observationScope: { rootElementId: true, interactiveOnly: true },
          actResult: { returnObservation: [...RETURN_OBSERVATIONS], default: 'summary', diffLimit: DIFF_LIMIT, closedTargetOutcome: 'target_closed_after_dispatch' },
          windowListing: { verbose: true, filters: ['processName', 'title'], defaultOmits: ['tiny', 'shell', 'untitled-frame'] },
          responseSize: { meta: 'trace/response', field: 'responseBytes' },
          launch: { catalog: 'app-paths', shell: false, uri: false }, ownedModal: { follow: 'followModal', returnOnClose: true },
          captureRetention: { mode: captureKeepLast ? 'keep-last' : 'preserve', keepLast: captureKeepLast,
            scope: 'validated-current-session-captures', onClose: captureKeepLast ? 'remove-tracked' : 'preserve' }, readiness: {
          native: { ready: result.ready === true, code: result.code || null, reason: result.reason || null },
          target: { ready: null, reason: 'Exact target, geometry, patterns and focus are checked during observation and dispatch.' },
        } };
      }, callOptions);
    },
    // Listing options travel with the call options: { signal, verbose, processName, title }.
    listWindows(callOptions = {}) {
      return queued(async signal => {
        const listing = validateListing(callOptions);
        const windows = targetWindows(await backend.listWindows({ signal }));
        // Every listed target stays selectable, including ones a filter or the default view hides.
        discovered = new Map(windows.map(window => [window.id, window]));
        const wanted = windows.filter(listing.matches);
        if (listing.verbose) return { windows: wanted };
        // An explicit process filter is a deliberate choice, so the noise filter does not apply.
        const shown = listing.filtered ? wanted : wanted.filter(window => !listingNoise(window));
        const omitted = wanted.length - shown.length;
        return { windows: shown.map(listedWindow), ...(omitted ? { omitted, hint: 'verbose: true also lists tiny, shell and helper windows.' } : {}) };
      }, callOptions);
    },
    openSession({ windowId }, callOptions) {
      return queued(async signal => {
        // A window that appeared after the last listing (a just-launched app or a new dialog) is
        // looked up server-side once, so the caller need not list again.
        if (!discovered.has(windowId)) discovered = new Map(targetWindows(await backend.listWindows({ signal })).map(window => [window.id, window]));
        const listed = discovered.get(windowId);
        if (!listed) throw fail('unknown_window', 'No current window has this windowId. Choose one from list_windows.');
        const { className, foreground, ...selected } = listed;
        if (selected.identity?.available === false) throw fail('window_identity_unavailable', 'The selected window identity could not be inspected. Choose an available target.');
        const open = backend.openWindow ?? backend.currentWindow;
        const current = open ? await open.call(backend, selected, { signal })
          : targetWindows(await backend.listWindows({ signal })).find(window => window.id === windowId);
        if (!identityMatches(selected, current)) throw fail('window_changed', 'The discovered window changed. Refresh the window list.');
        const id = randomUUID();
        await lease.acquire(id);
        const directory = path.join(runtimeDirectory, 'sessions', id);
        try {
          signal.throwIfAborted();
          await fs.mkdir(directory, { recursive: true });
          signal.throwIfAborted();
          const activityIndicator = await indicator.start({ signal });
          signal.throwIfAborted();
          indicator.assertActive();
          const session = { id, window: current, directory, observation: null,
            ...(captureKeepLast ? { captureRetention: createCaptureRetention(directory, captureKeepLast) } : {}) };
          await record(session, { type: 'session_open', windowId, pid: current.pid });
          signal.throwIfAborted();
          indicator.assertActive();
          sessions.set(id, session);
          return { sessionId: id, window: current, activityIndicator };
        } catch (error) {
          try { await cleanupSession({ id }); } catch (cleanup) {
            error.cleanupCodes = cleanup.cleanupCodes || [cleanup.code || 'cleanup_failed'];
            error.details = { ...error.details, cleanup: 'unknown', recovery: cleanup.details?.recovery ?? error.details?.recovery };
          }
          throw error;
        }
      }, callOptions);
    },
    observe({ sessionId, accessibilityDepth, mode, documentElementId, includeOffscreen, screenshot, rootElementId, interactiveOnly, metrics, followModal: follow }, callOptions) {
      return queued(async signal => {
        const session = getSession(sessionId);
        const depth = validateDepth(accessibilityDepth), checkedMode = validateObservationMode(mode);
        if (documentElementId !== undefined && (checkedMode !== 'accessibility' || typeof documentElementId !== 'string'
          || !documentElementId || documentElementId.length > 512 || documentElementId.startsWith('-') || /[\u0000-\u001f]/.test(documentElementId)))
          throw fail('invalid_document_request', 'documentElementId requires accessibility mode and a valid observed element ID.');
        if (includeOffscreen !== undefined && typeof includeOffscreen !== 'boolean') throw fail('invalid_observation', 'includeOffscreen must be a boolean.');
        if (metrics !== undefined && typeof metrics !== 'boolean') throw fail('invalid_observation', 'metrics must be a boolean.');
        const screenshotMode = validateScreenshot(screenshot, checkedMode);
        const scope = validateScope(rootElementId, interactiveOnly, checkedMode);
        if (follow !== undefined && typeof follow !== 'boolean') throw fail('invalid_observation', 'followModal must be a boolean.');
        if (follow) { const marked = markedSignal(signal); await lease.assert(session.id); await followModal(session, marked); }
        const result = await observeInternal(session, signal, { depth, mode: checkedMode, documentElementId, includeOffscreen: includeOffscreen === true, screenshot: screenshotMode, scope, metrics: metrics === true });
        await reportModal(session, result, signal);
        return retainCapture(session, result, signal);
      }, callOptions);
    },
    act({ sessionId, observationId, action, returnObservation = 'summary' }, callOptions) {
      return queued(async signal => {
        if (!RETURN_OBSERVATIONS.includes(returnObservation)) throw Object.assign(fail('invalid_argument', 'returnObservation must be full, summary or none.'), { details: { outcome: 'not_dispatched' } });
        const session = getSession(sessionId);
        signal = markedSignal(signal);
        await lease.assert(sessionId);
        const observation = session.observation;
        // These guards run before backend.act. Preserve that proof on the rejected
        // promise; the public MCP boundary must not infer dispatch from a code name.
        if (!observation || observation.id !== observationId) throw Object.assign(fail('stale_observation', 'Use the latest observationId. Every action consumes it.'), { details: { outcome: 'not_dispatched' } });
        if (now() - observation.observedAtMs > observationTtlMs) {
          session.observation = null;
          throw Object.assign(fail('stale_observation', 'Observation expired. Observe again before input.'), { details: { outcome: 'not_dispatched' } });
        }
        const checked = validateAction(action, observation.result);
        session.observation = null;
        await currentWindow(session, signal);
        signal.throwIfAborted();
        const actionId = randomUUID();
        await record(session, { type: 'action_started', actionId, observationId, actionType: checked.type });
        let nativeCompleted = false, nativeResult;
        try {
          signal.throwIfAborted();
          indicator.assertActive();
          nativeResult = await backend.act({ window: session.window, observation: observation.snapshot, action: checked, signal });
          nativeCompleted = true;
          // The fresh observation always runs server-side so the next action has authority. Only
          // `full` returns it; it keeps the consumed observation's depth, offscreen, scope and image setting.
          const snapshot = observation.snapshot;
          const refresh = scope => observeInternal(session, signal, { depth: snapshot.depth, mode: 'full',
            includeOffscreen: snapshot.includeOffscreen === true, scope, metrics: snapshot.metrics === true,
            screenshot: returnObservation === 'full' ? snapshot.screenshotPreference ?? 'full' : 'none',
            screenshotPreference: snapshot.screenshotPreference ?? 'full' });
          const scope = { ...(snapshot.rootElementId === undefined ? {} : { rootElementId: snapshot.rootElementId }), ...(snapshot.interactiveOnly ? { interactiveOnly: true } : {}) };
          let fresh, scopeLost = false;
          try { fresh = await refresh(scope); }
          catch (error) {
            // The action can remove its own scope root (a closed pane or dialog). Refresh the whole
            // window once instead; the input has already been sent.
            if (scope.rootElementId === undefined || error.code !== 'element_not_found' || signal.aborted) throw error;
            const { rootElementId, ...unscoped } = scope;
            fresh = await refresh(unscoped); scopeLost = true;
          }
          await record(session, { type: 'action_completed', actionId, observationId: fresh.observationId });
          await retainCapture(session, fresh, signal);
          const completed = { actionId, outcome: 'completed', verification: 'fresh_observation', ...(scopeLost ? { scopeLost: true } : {}) };
          await reportModal(session, fresh, signal);
          const modal = fresh.ownedModal ? { ownedModal: fresh.ownedModal } : {};
          if (returnObservation === 'full') return { ...completed, nativeResult, observation: fresh };
          if (returnObservation === 'none') return { ...completed, observationId: fresh.observationId, ...modal };
          return { ...completed, nativeResult, observationId: fresh.observationId, summary: actSummary(observation.result, fresh), ...modal };
        } catch (error) {
          session.observation = null;
          // Input was sent and the refresh failed because the window itself is gone (Save, Close, OK).
          // This is a distinct, expected outcome rather than an internal error.
          if (nativeCompleted && !signal.aborted && !safeError(error).inputRecoveryRequired && await targetClosed(session, signal)) {
            await record(session, { type: 'action_target_closed', actionId }).catch(() => {});
            // A followed modal closed: the session returns to the window that owned it.
            const owner = session.owners?.at(-1);
            if (owner) {
              session.owners = session.owners.slice(0, -1); session.window = owner;
              const snapshot = observation.snapshot;
              const fresh = await observeInternal(session, signal, { depth: snapshot.depth, mode: 'full', includeOffscreen: snapshot.includeOffscreen === true,
                metrics: snapshot.metrics === true, screenshot: returnObservation === 'full' ? snapshot.screenshotPreference ?? 'full' : 'none',
                screenshotPreference: snapshot.screenshotPreference ?? 'full' });
              await record(session, { type: 'modal_returned', windowId: owner.id, observationId: fresh.observationId });
              await retainCapture(session, fresh, signal);
              await reportModal(session, fresh, signal);
              const returned = { actionId, outcome: 'target_closed_after_dispatch', verification: 'window_closed', returnedToOwner: true, windowId: owner.id };
              if (returnObservation === 'full') return { ...returned, nativeResult, observation: fresh };
              return { ...returned, observationId: fresh.observationId, ...(fresh.ownedModal ? { ownedModal: fresh.ownedModal } : {}),
                ...(returnObservation === 'summary' ? { nativeResult, summary: { elementCount: fresh.elements.length, focused: compactFocus(fresh.focused),
                  title: short(fresh.window?.title), targetState: fresh.targetState } } : {}) };
            }
            return { actionId, outcome: 'target_closed_after_dispatch', verification: 'window_closed', nativeResult,
              nextStep: 'The input was sent and the session window then closed. Close this session; list windows to continue in another window.' };
          }
          const outcome = !nativeCompleted && error.details?.outcome === 'not_dispatched' ? 'not_dispatched' : 'unknown';
          await record(session, { type: outcome === 'not_dispatched' ? 'action_not_dispatched' : 'action_unknown', actionId, errorCode: error.code ?? 'backend_error' }).catch(() => {});
          const projected = safeError(error);
          if (nativeCompleted && projected.outcome === 'not_dispatched') projected.outcome = 'unknown';
          if (outcome === 'not_dispatched' && !indicator.signal.aborted && !projected.inputRecoveryRequired) {
            return { actionId, outcome, error: projected, nextStep: 'The requested input was not sent. Observe again and resolve the reported condition before at most one new attempt.' };
          }
          return { actionId, outcome, error: projected, nextStep: indicator.signal.aborted
            ? 'The visible activity marker was lost. Input is stopped. Verify the action outcome and input cleanup, then close the session before reopening; do not replay automatically.'
            : projected.inputRecoveryRequired
            ? 'Input is quarantined. Check the owned input process and button state before restarting TRACE; observation alone does not clear this condition.'
            : 'Observe the window before deciding whether to retry. The input may have occurred.' };
        }
      }, callOptions);
    },
    // Starts a registered App Paths EXE directly (shell: false) and returns its windows, which open_session
    // accepts without a new listing. The launch holds the desktop lease, so no session may be open.
    launch({ app } = {}, callOptions) {
      return queued(async signal => {
        if (typeof app !== 'string' || !app) throw fail('invalid_argument', 'app must be an application name such as notepad.');
        if (app.includes(':') || /[\\/]/.test(app)) throw fail('application_unsupported', 'Only App Paths EXE names launch; URIs (such as ms-settings:) and paths are unsupported.');
        if (!LAUNCH_NAME.test(app)) throw fail('invalid_argument', 'app must be an application name such as notepad.');
        if (sessions.size) throw fail('desktop_busy', 'Close the open session before launching; a launch holds the desktop lease.');
        const wanted = launchName(app);
        if (uncertainLaunches.has(wanted)) throw fail('application_already_attempted', 'The last launch of this app had an unknown outcome. List windows instead of relaunching.');
        const catalog = createApplications();
        const listed = await catalog.discover({ signal, match: row => launchName(row.name) === wanted });
        const matches = listed.applications.filter(item => launchName(item.name) === wanted);
        if (!matches.length) throw fail('unknown_application', listed.skipped
          ? 'This app is registered, but its EXE cannot be verified (packaged apps under WindowsApps may be unreadable).'
          : 'No App Paths registration has this name.');
        if (matches.length > 1) throw fail('ambiguous_application', 'Several registered EXEs have this name.');
        const result = await catalog.launch(matches[0].appId, { signal });
        if (result.outcome === 'unknown') uncertainLaunches.add(wanted);
        if (result.outcome !== 'launched') {
          return { outcome: result.outcome, app: wanted, ...(result.code ? { code: result.code } : {}), ...(result.cleanup ? { cleanup: result.cleanup } : {}),
            nextStep: result.outcome === 'unknown' ? 'The app may have started. List windows before deciding; it is not relaunched automatically.' : 'Nothing was started.' };
        }
        for (const window of result.windows) discovered.set(window.id, window);
        return { outcome: 'launched', app: wanted, pid: result.process.pid, ...(result.ownership === 'handed-off' ? { handedOff: true } : {}),
          windows: result.windows.map(listedWindow), cleanup: result.cleanup };
      }, callOptions);
    },
    closeSession({ sessionId }, callOptions) {
      return queued(async () => {
        const session = getSession(sessionId);
        session.observation = null;
        const captureRetention = await cleanupSession(session);
        return { sessionId, closed: true, cleanup: 'confirmed', ...(captureRetention ? { captureRetention } : {}) };
      }, callOptions);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      shutdown.abort();
      closePromise = queued(async () => {
        const errors = [];
        const retention = [];
        try { await backend.close?.(); } catch (error) { errors.push(error); }
        if (!sessions.size) {
          try { await indicator.stop(); } catch (error) { errors.push(error); }
        }
        for (const session of [...sessions.values()]) {
          try { const result = await cleanupSession(session, errors.length === 0); if (result) retention.push(result); }
          catch (error) { errors.push(error); }
        }
        if (errors.length) {
          const error = errors.find(item => item.details?.recovery || item.details?.inputRecoveryRequired || item.code === 'input_recovery_required') || errors[0];
          error.details = { ...error.details, cleanup: 'unknown' };
          error.cleanupCodes = errors.flatMap(item => item.cleanupCodes || [item.code || 'cleanup_failed']);
          throw error;
        }
        if (captureKeepLast) return { captureRetention: retention };
      }, {}, true);
      return closePromise;
    },
  };
}

module.exports = { createComputerController, defaultRuntimeDirectory, validateAction, validateDepth, validateScreenshot, elementDiff, safeError, listingNoise, listedWindow };
