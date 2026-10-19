'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DesktopLease } = require('./lease.cjs');

const fail = (code, message) => Object.assign(new Error(message), { code });
const identityMatches = (a, b) => a && b && a.id === b.id && a.pid === b.pid && a.processName === b.processName;
function safeError(error) {
  const result = { code: error.code ?? 'backend_error', message: String(error.message).slice(0, 1500) };
  if (['unknown', 'not_dispatched'].includes(error.details?.outcome)) result.outcome = error.details.outcome;
  const recovery = error.details?.recovery;
  if (recovery && typeof recovery.attempted === 'boolean') {
    result.recovery = { attempted: recovery.attempted };
    if (typeof recovery.released === 'boolean') result.recovery.released = recovery.released;
    if (recovery.button === 'left') result.recovery.button = 'left';
    if (recovery.method === 'public-win32-sendinput') result.recovery.method = recovery.method;
    if (['native_drained', 'not_dispatched', 'process_exit_unconfirmed'].includes(recovery.reason)) result.recovery.reason = recovery.reason;
    if (typeof recovery.code === 'string' && /^[a-z_]{1,64}$/.test(recovery.code)) result.recovery.code = recovery.code;
  }
  if (result.code === 'input_recovery_required' || recovery?.released === false || recovery?.reason === 'process_exit_unconfirmed') result.inputRecoveryRequired = true;
  return result;
}

function defaultRuntimeDirectory() {
  if (process.env.TRACE_COMPUTER_RUNTIME) {
    if (!path.isAbsolute(process.env.TRACE_COMPUTER_RUNTIME)) throw fail('invalid_runtime_directory', 'TRACE_COMPUTER_RUNTIME must be an absolute directory.');
    return process.env.TRACE_COMPUTER_RUNTIME;
  }
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'TRACE', 'computer');
}

function validateAction(action, observation) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw fail('invalid_action', 'Provide an action object.');
  const fields = {
    activate: [], click: ['x', 'y', 'elementId'], type_text: ['text'], press_key: ['key'],
    scroll: ['x', 'y', 'deltaX', 'deltaY'], drag: ['fromX', 'fromY', 'toX', 'toY'],
    invoke: ['elementId'], set_value: ['elementId', 'value'],
  }[action.type];
  if (!fields || Object.keys(action).some(key => key !== 'type' && !fields.includes(key))) throw fail('invalid_action', 'Unknown action type or field.');
  const text = (key, maximum = 8192) => {
    if (typeof action[key] !== 'string' || action[key].length === 0 || action[key].length > maximum || action[key].includes('\0')) throw fail('invalid_action', `${key} must be a bounded nonempty string.`);
  };
  const point = (x, y) => {
    if (!Number.isInteger(action[x]) || !Number.isInteger(action[y]) || action[x] < 0 || action[y] < 0 || action[x] >= observation.bounds.width || action[y] >= observation.bounds.height) throw fail('invalid_coordinates', 'Use integer coordinates inside the observed window.');
  };
  const element = () => {
    text('elementId', 512);
    if (!(observation.elements ?? []).some(item => item.id === action.elementId && item.enabled !== false)) throw fail('unknown_element', 'Choose an enabled element from the latest observation.');
  };
  switch (action.type) {
    case 'click':
      if (action.elementId !== undefined) {
        if (action.x !== undefined || action.y !== undefined) throw fail('invalid_action', 'Choose elementId or coordinates, not both.');
        element();
      } else point('x', 'y');
      break;
    case 'type_text': text('text'); break;
    case 'press_key':
      text('key', 100);
      if (!/^(?:(?:CTRL|CONTROL|ALT|SHIFT)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ENTER|RETURN|TAB|ESC|ESCAPE|BACKSPACE|DELETE|HOME|END|PAGEUP|PAGEDOWN|LEFT|RIGHT|UP|DOWN|SPACE)$/i.test(action.key)) throw fail('invalid_key', 'Use a supported key or Ctrl/Alt/Shift chord.');
      break;
    case 'scroll':
      point('x', 'y');
      if (![action.deltaX, action.deltaY].every(value => Number.isInteger(value) && Math.abs(value) <= 2400) || (!action.deltaX && !action.deltaY)) throw fail('invalid_action', 'Scroll deltas must be nonzero bounded integers.');
      break;
    case 'drag': point('fromX', 'fromY'); point('toX', 'toY'); break;
    case 'invoke': element(); break;
    case 'set_value': element(); if (typeof action.value !== 'string' || action.value.length > 8192 || action.value.includes('\0')) throw fail('invalid_action', 'value must be a bounded string.'); break;
  }
  return { ...action };
}

function createComputerController(options = {}) {
  const backend = options.backend ?? new (require('./winapp-backend.cjs').WinappBackend)();
  const runtimeDirectory = path.resolve(options.runtimeDirectory ?? defaultRuntimeDirectory());
  // Artifact directories may differ between hosts. Desktop ownership must not.
  // userInfo comes from the OS rather than the configurable artifact path.
  const lease = options.lease ?? new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
  const observationTtlMs = options.observationTtlMs ?? 60000;
  const now = options.now ?? Date.now;
  const shutdown = new AbortController();
  const sessions = new Map();
  let discovered = new Map();
  let queue = Promise.resolve();
  let closed = false;

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
  async function currentWindow(session, signal) {
    const windows = await backend.listWindows({ signal });
    const current = windows.find(window => window.id === session.window.id);
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
  async function observeInternal(session, signal) {
    await lease.assert(session.id);
    await currentWindow(session, signal);
    session.observation = null;
    const observationId = randomUUID();
    const screenshotPath = path.join(session.directory, `${observationId}.png`);
    const snapshot = await backend.observe({ window: session.window, screenshotPath, signal });
    if (!identityMatches(snapshot.window, session.window)) throw fail('window_changed', 'Observation returned a different window identity.');
    const bounds = snapshot.bounds;
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width < 1 || bounds.height < 1) throw fail('invalid_observation', 'Backend returned invalid window bounds.');
    if (path.resolve(snapshot.screenshot?.path ?? '') !== screenshotPath) throw fail('invalid_capture', 'Backend returned a different screenshot path.');
    const stat = await fs.stat(screenshotPath);
    if (stat.size > 6 * 1024 * 1024) throw fail('capture_too_large', 'Capture exceeds the 6 MiB image limit.');
    const bytes = await fs.readFile(screenshotPath);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('invalid_capture', 'Backend capture must be a PNG image.');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width !== bounds.width || height !== bounds.height) throw fail('capture_mismatch', 'Screenshot dimensions differ from the observed window. Re-observe before input.');
    const observedAtMs = now();
    const result = {
      sessionId: session.id, observationId, window: snapshot.window, bounds,
      elements: snapshot.elements ?? [], observedAt: new Date(observedAtMs).toISOString(),
      coordinateSpace: 'window-local-physical-pixels', captureMethod: snapshot.captureMethod ?? 'native-window',
      accessibility: { truncated: snapshot.truncated === true, depth: snapshot.depth ?? null },
      screenshot: { data: bytes.toString('base64'), mimeType: 'image/png', width, height, sha256: createHash('sha256').update(bytes).digest('hex') },
    };
    session.observation = { id: observationId, observedAtMs, snapshot, result };
    await record(session, { type: 'observation', observationId, screenshotSha256: result.screenshot.sha256 });
    return result;
  }

  return {
    doctor(callOptions) { return queued(signal => backend.doctor({ signal }), callOptions); },
    listWindows(callOptions) {
      return queued(async signal => {
        const windows = await backend.listWindows({ signal });
        discovered = new Map(windows.map(window => [window.id, window]));
        return { windows };
      }, callOptions);
    },
    openSession({ windowId }, callOptions) {
      return queued(async signal => {
        const selected = discovered.get(windowId);
        if (!selected) throw fail('unknown_window', 'Select a windowId returned by list_windows.');
        const current = (await backend.listWindows({ signal })).find(window => window.id === windowId);
        if (!identityMatches(selected, current)) throw fail('window_changed', 'The discovered window changed. Refresh the window list.');
        const id = randomUUID();
        await lease.acquire(id);
        const directory = path.join(runtimeDirectory, 'sessions', id);
        try {
          signal.throwIfAborted();
          await fs.mkdir(directory, { recursive: true });
          signal.throwIfAborted();
          const session = { id, window: current, directory, observation: null };
          await record(session, { type: 'session_open', windowId, pid: current.pid });
          signal.throwIfAborted();
          sessions.set(id, session);
          return { sessionId: id, window: current };
        } catch (error) { await lease.release(id); throw error; }
      }, callOptions);
    },
    observe({ sessionId }, callOptions) { return queued(signal => observeInternal(getSession(sessionId), signal), callOptions); },
    act({ sessionId, observationId, action }, callOptions) {
      return queued(async signal => {
        const session = getSession(sessionId);
        await lease.assert(sessionId);
        const observation = session.observation;
        if (!observation || observation.id !== observationId) throw fail('stale_observation', 'Use the latest observationId. Every action consumes it.');
        if (now() - observation.observedAtMs > observationTtlMs) {
          session.observation = null;
          throw fail('stale_observation', 'Observation expired. Observe again before input.');
        }
        const checked = validateAction(action, observation.result);
        session.observation = null;
        await currentWindow(session, signal);
        signal.throwIfAborted();
        const actionId = randomUUID();
        await record(session, { type: 'action_started', actionId, observationId, actionType: checked.type });
        try {
          const nativeResult = await backend.act({ window: session.window, observation: observation.snapshot, action: checked, signal });
          const fresh = await observeInternal(session, signal);
          await record(session, { type: 'action_completed', actionId, observationId: fresh.observationId });
          return { actionId, outcome: 'completed', verification: 'fresh_observation', nativeResult, observation: fresh };
        } catch (error) {
          session.observation = null;
          await record(session, { type: 'action_unknown', actionId, errorCode: error.code ?? 'backend_error' }).catch(() => {});
          const projected = safeError(error);
          return { actionId, outcome: 'unknown', error: projected, nextStep: projected.inputRecoveryRequired
            ? 'Input is quarantined. Check the owned input process and button state before restarting TRACE; observation alone does not clear this condition.'
            : 'Observe the window before deciding whether to retry. The input may have occurred.' };
        }
      }, callOptions);
    },
    closeSession({ sessionId }, callOptions) {
      return queued(async () => {
        const session = getSession(sessionId);
        session.observation = null;
        await lease.release(session.id);
        sessions.delete(session.id);
        return { sessionId, closed: true };
      }, callOptions);
    },
    close() {
      if (closed) return queue;
      closed = true;
      shutdown.abort();
      return queued(async () => {
        for (const session of sessions.values()) await lease.release(session.id);
        sessions.clear();
        await backend.close?.();
      }, {}, true);
    },
  };
}

module.exports = { createComputerController, defaultRuntimeDirectory, validateAction };
