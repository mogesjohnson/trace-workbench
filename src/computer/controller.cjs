'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DesktopLease } = require('./lease.cjs');
const { ActivityIndicator } = require('./activity-indicator.cjs');
const { validateAction, actionSupport } = require('./action-contract.cjs');
const { createObservationMetrics, measure, count } = require('./observation-metrics.cjs');

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

function createComputerController(options = {}) {
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
  async function cleanupSession(session) {
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
  }
  async function currentWindow(session, signal) {
    const current = backend.currentWindow ? await backend.currentWindow(session.window, { signal })
      : (await backend.listWindows({ signal })).find(window => window.id === session.window.id);
    if (!identityMatches(current, session.window)) {
      session.observation = null;
      throw fail('window_changed', 'The selected window closed or its process identity changed. Open a new session.');
    }
    return current;
  }
  async function record(session, event) {
    // No typed text, values, screenshots, or full window inventory in the journal.
    await fs.appendFile(path.join(session.directory, 'events.jsonl'), `${JSON.stringify({ at: new Date(now()).toISOString(), sessionId: session.id, ...event })}\n`);
  }
  async function observeInternal(session, signal, depth = DEFAULT_DEPTH, mode = 'full') {
    // A valid selective read revokes input authority even if readiness/capture fails.
    if (mode !== 'full') session.observation = null;
    const metrics = createObservationMetrics({ clock: options.metricsClock,
      sample: observedBefore ? 'later-controller-attempt' : 'first-controller-attempt' });
    observedBefore = true;
    return metrics.run(async () => {
      const result = await measure('observation', () => observeMeasured(session, signal, depth, mode));
      result.metrics = metrics.snapshot();
      return result;
    });
  }
  async function observeMeasured(session, signal, depth, mode) {
    signal = markedSignal(signal);
    await lease.assert(session.id);
    await measure('identity', () => currentWindow(session, signal));
    session.observation = null;
    const observationId = randomUUID();
    const screenshotPath = mode === 'accessibility' ? undefined : path.join(session.directory, `${observationId}.png`);
    const snapshot = await measure('backend', () => backend.observe({ window: session.window, screenshotPath, signal, depth,
      ...(mode === 'accessibility' ? { includeScreenshot: false } : {}) }));
    // The effective depth stays server-side with the observation; actions cannot replace it.
    snapshot.depth = Number.isInteger(snapshot.depth) ? snapshot.depth : depth;
    if (!identityMatches(snapshot.window, session.window)) throw fail('window_changed', 'Observation returned a different window identity.');
    const bounds = snapshot.bounds;
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width < 1 || bounds.height < 1) throw fail('invalid_observation', 'Backend returned invalid window bounds.');
    let bytes, screenshot, width, height;
    if (mode !== 'accessibility') {
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
      screenshot = measure('hashEncode', () => ({ data: bytes.toString('base64'), mimeType: 'image/png', width, height,
        sha256: createHash('sha256').update(bytes).digest('hex') }));
      count('base64', screenshot.data.length);
    }
    const result = {
      sessionId: session.id, observationId, window: snapshot.window, bounds,
      elements: snapshot.elements ?? [], observedAt: new Date(observedAtMs).toISOString(),
      coordinateSpace: 'window-local-physical-pixels', captureMethod: snapshot.captureMethod ?? 'native-window',
      accessibility: { truncated: snapshot.truncated === true, depth: snapshot.depth },
      focused: snapshot.focused ? { ...snapshot.focused } : { available: false, code: 'focus_unavailable' },
      targetState: snapshot.targetState ?? { available: false },
      ...(snapshot.restoredFromMinimized === true ? { preparation: [{ step: 'restore', status: 'restored' }] } : {}),
      screenshot,
    };
    if (mode === 'full') session.observation = { id: observationId, observedAtMs, snapshot, result };
    else {
      Object.assign(result, { mode, actionable: false });
      if (mode === 'screenshot') { delete result.elements; delete result.accessibility; }
      else { delete result.screenshot; delete result.captureMethod; delete result.coordinateSpace; }
    }
    await measure('journal', () => record(session, { type: 'observation', observationId,
      ...(mode !== 'full' ? { mode } : {}), ...(screenshot ? { screenshotSha256: screenshot.sha256 } : {}) }));
    signal.throwIfAborted();
    indicator.assertActive();
    return result;
  }

  return {
    doctor(callOptions) {
      return queued(async signal => {
        const result = await backend.doctor({ signal });
        return { ...result, support: actionSupport(observationTtlMs),
          observationModes: { default: 'full', actionable: ['full'], evidenceOnly: ['accessibility', 'screenshot'] }, readiness: {
          native: { ready: result.ready === true, code: result.code || null, reason: result.reason || null },
          target: { ready: null, reason: 'Exact target, geometry, patterns and focus are checked during observation and dispatch.' },
        } };
      }, callOptions);
    },
    listWindows(callOptions) {
      return queued(async signal => {
        const windows = targetWindows(await backend.listWindows({ signal }));
        discovered = new Map(windows.map(window => [window.id, window]));
        return { windows };
      }, callOptions);
    },
    openSession({ windowId }, callOptions) {
      return queued(async signal => {
        const selected = discovered.get(windowId);
        if (!selected) throw fail('unknown_window', 'Select a windowId returned by list_windows.');
        if (selected.identity?.available === false) throw fail('window_identity_unavailable', 'The selected window identity could not be inspected. Choose an available target.');
        const current = backend.currentWindow ? await backend.currentWindow(selected, { signal })
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
          const session = { id, window: current, directory, observation: null };
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
    observe({ sessionId, accessibilityDepth, mode }, callOptions) {
      return queued(signal => observeInternal(getSession(sessionId), signal, validateDepth(accessibilityDepth), validateObservationMode(mode)), callOptions);
    },
    act({ sessionId, observationId, action }, callOptions) {
      return queued(async signal => {
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
        let nativeCompleted = false;
        try {
          signal.throwIfAborted();
          indicator.assertActive();
          const nativeResult = await backend.act({ window: session.window, observation: observation.snapshot, action: checked, signal });
          nativeCompleted = true;
          const fresh = await observeInternal(session, signal, observation.snapshot.depth);
          await record(session, { type: 'action_completed', actionId, observationId: fresh.observationId });
          return { actionId, outcome: 'completed', verification: 'fresh_observation', nativeResult, observation: fresh };
        } catch (error) {
          session.observation = null;
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
    closeSession({ sessionId }, callOptions) {
      return queued(async () => {
        const session = getSession(sessionId);
        session.observation = null;
        await cleanupSession(session);
        return { sessionId, closed: true, cleanup: 'confirmed' };
      }, callOptions);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      shutdown.abort();
      closePromise = queued(async () => {
        const errors = [];
        try { await backend.close?.(); } catch (error) { errors.push(error); }
        if (!sessions.size) {
          try { await indicator.stop(); } catch (error) { errors.push(error); }
        }
        for (const session of [...sessions.values()]) {
          try { await cleanupSession(session); } catch (error) { errors.push(error); }
        }
        if (errors.length) {
          const error = errors.find(item => item.details?.recovery || item.details?.inputRecoveryRequired || item.code === 'input_recovery_required') || errors[0];
          error.details = { ...error.details, cleanup: 'unknown' };
          error.cleanupCodes = errors.flatMap(item => item.cleanupCodes || [item.code || 'cleanup_failed']);
          throw error;
        }
      }, {}, true);
      return closePromise;
    },
  };
}

module.exports = { createComputerController, defaultRuntimeDirectory, validateAction, validateDepth, safeError };
