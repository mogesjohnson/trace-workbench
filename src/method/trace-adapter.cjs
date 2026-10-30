'use strict';
const { digest, fail, text } = require('./shared.cjs');
const { validateAction: validateNativeAction, safeError } = require('../computer/controller.cjs');
const TOOL_NAMES = ['doctor', 'list_windows', 'open_session', 'observe', 'act', 'close_session'].map(s => `trace_computer_${s}`);
function state(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  try { return JSON.parse(result?.content?.find(c => c.type === 'text')?.text); }
  catch { fail('invalid-response', 'TRACE returned no structured response.'); }
}
function createTraceProvider({ client, callTool = client?.callTool?.bind(client),
  listTools = client?.listTools?.bind(client), tools, environment = 'local', app, windowId,
  id = `trace-native:${environment}:${app}:${windowId}`, accessibilityDepth = 8, recover } = {}) {
  if (typeof callTool !== 'function' || !text(app) || !text(windowId) || !text(environment) || !text(id)
    || !Number.isInteger(accessibilityDepth) || accessibilityDepth < 1 || accessibilityDepth > 32) {
    fail('adapter-config', 'Bind a transport, exact environment/app/window and depth 1-32.');
  }
  let sessionId = null, capture = null, binding = null, supportsDepth = false;
  let closeFailure = null;
  const identity = w => [w.id || w.windowId, w.pid ?? w.processId, w.processName, w.processCreationTime ?? null];
  const reference = w => ({ environment, app, windowId, ownership: 'attached',
    ownerWindowId: w.ownerWindowId ?? w.targetState?.ownerWindowId ?? null,
    identity: { pid: w.pid ?? w.processId, processName: w.processName,
      generation: w.processCreationTime ?? null } });
  const call = async (index, args) => callTool({ name: TOOL_NAMES[index], arguments: args });
  const provider = {
    id, channel: 'desktop', usesDesktop: true, available: false, environments: [environment], windowIds: [windowId],
    apps: [app], capabilities: ['native-action'],
    constraints: { coordinateSpace: 'window-local-physical-pixels', observationTtlMs: 60000,
      accessibilityDepth, physicalRecovery: typeof recover === 'function' ? 'injected' : 'unavailable' },
    async doctor() {
      provider.available = false;
      const listing = tools || (typeof listTools === 'function' ? (await listTools({})).tools : null);
      if (!Array.isArray(listing) || !TOOL_NAMES.every(name => listing.some(t => t.name === name))) {
        return { ready: false, code: 'schema-unavailable', reason: 'Discover all six live TRACE tools before enabling the adapter.' };
      }
      const schema = listing.find(t => t.name === TOOL_NAMES[3]).inputSchema;
      supportsDepth = !!schema?.properties?.accessibilityDepth;
      if (!supportsDepth && accessibilityDepth !== 8) {
        return { ready: false, code: 'depth-unsupported', reason: 'The live observation schema does not advertise requested depth.' };
      }
      const result = await call(0, {}), value = state(result);
      provider.available = result.isError !== true && value.ready === true;
      return { ready: provider.available, code: value.code || null, reason: value.reason || null };
    },
    async discover(target) {
      if (!provider.available) fail('provider-unavailable', 'Run successful tool discovery and diagnostics first.');
      if (target.environment !== environment || target.app !== app || (target.windowId && target.windowId !== windowId)) return [];
      const result = await call(1, {}), value = state(result);
      if (result.isError) fail(value.error?.code || 'discovery-failed', 'TRACE window discovery failed.');
      const windows = Array.isArray(value) ? value : value.windows;
      if (!Array.isArray(windows)) fail('invalid-response', 'Expected a window inventory.');
      const matches = windows.filter(w => (w.id || w.windowId) === windowId);
      if (matches.length !== 1) return [];
      const key = digest(identity(matches[0]));
      if (binding && key !== binding) fail('target-changed', 'This window now belongs to another process lifetime.');
      binding = key; return matches.map(reference);
    },
    async observe({ target }) {
      capture = null;
      if (closeFailure) fail('input_recovery_required', 'Resolve the uncertain close and create a new provider before observing.');
      if (!provider.available || !binding || target.environment !== environment || target.app !== app
        || target.windowId !== windowId) fail('target-mismatch', 'Observe the exact discovered app/window.');
      if (!sessionId) {
        let result, value;
        try {
          result = await call(2, { windowId }); value = state(result);
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-response', 'TRACE returned an invalid session response.');
        }
        catch (error) { closeFailure = { cleanup: 'unknown', applicationClosed: false, inputRecoveryRequired: true }; throw error; }
        if (value.error?.cleanup === 'unknown' || value.error?.inputRecoveryRequired === true) {
          const error = safeError({ ...value.error, details: value.error });
          closeFailure = { cleanup: 'unknown', applicationClosed: false, inputRecoveryRequired: true,
            recovery: error.recovery || null, errorCode: error.code };
        }
        if (!result.isError && !text(value.sessionId)) closeFailure = { cleanup: 'unknown', applicationClosed: false, inputRecoveryRequired: true };
        if (closeFailure) fail('input_recovery_required', 'Session cleanup is uncertain; inspect recovery before opening again.');
        if (result.isError || !text(value.sessionId)) fail(value.error?.code || 'session-failed', 'TRACE session could not be opened.');
        sessionId = value.sessionId;
        if (digest(identity(value.window || {})) !== binding) fail('target-changed', 'Opened process lifetime differs; release the owned session.');
      }
      const result = await call(3, { sessionId, ...(supportsDepth ? { accessibilityDepth } : {}) }), value = state(result);
      if (result.isError) fail(value.error?.code || 'observe-failed', 'TRACE capture failed.');
      if (!text(value.observationId) || value.sessionId !== sessionId || digest(identity(value.window || {})) !== binding) {
        fail('target-mismatch', 'Observed process/session identity differs from discovery.');
      }
      const observedOwner = (Object.hasOwn(value.targetState || {}, 'ownerWindowId')
        ? value.targetState.ownerWindowId : value.window?.ownerWindowId) ?? null;
      if (String(observedOwner) !== String(target.ownerWindowId ?? null)) {
        fail('ownership-changed', 'Current dialog ownership differs from the discovered parent relation.');
      }
      capture = value;
      return { id: value.observationId, target: { ...target, ownerWindowId: observedOwner },
        evidenceKey: digest([value.screenshot?.sha256, value.elements || [], value.focused || null, value.targetState || null]),
        evidence: { state: value, images: result.content?.filter(c => c.type === 'image') || [],
          focus: value.focused || { available: false, reason: 'Executor did not expose intended-control focus.' } },
        preparation: value.preparation || [] };
    },
    validateAction({ observationId, payload }) {
      if (!capture || observationId !== capture.observationId) fail('stale-target', 'Validate against the current native capture.');
      return validateNativeAction(payload, capture);
    },
    async act({ target, observationId, capability, payload }) {
      if (!provider.available || target.environment !== environment || target.app !== app || target.windowId !== windowId
        || capability !== 'native-action' || !capture || observationId !== capture.observationId) {
        fail('stale-target', 'One current exact-target native observation is required.');
      }
      capture = null;
      let result;
      try { result = await call(4, { sessionId, observationId, action: payload }); }
      catch { return { delivery: 'unknown' }; }
      const value = state(result), recovery = value.error?.recovery;
      const cleanupRequired = value.error?.inputRecoveryRequired === true || value.error?.code === 'input_recovery_required'
        || recovery?.released === false || recovery?.reason === 'process_exit_unconfirmed';
      return { delivery: value.outcome === 'completed' ? 'delivered' : value.outcome === 'not_dispatched' ? 'not-delivered' : 'unknown',
        blocked: value.error?.code === 'window_blocked', cleanup: cleanupRequired ? 'unknown' : undefined,
        preparation: value.preparation || value.error?.preparation || value.nativeResult?.preparation || [],
        errorCode: value.error?.code || null, resultingState: value.observation || null, recovery: recovery || null };
    },
    async close({ target }) {
      if (target.environment !== environment || target.app !== app || target.windowId !== windowId) fail('target-mismatch', 'Do not close unrelated resources.');
      capture = null;
      if (closeFailure) return { ...closeFailure };
      if (!sessionId) return { cleanup: 'confirmed', applicationClosed: false };
      try {
        const result = await call(5, { sessionId }), value = state(result);
        if (result.isError || value.closed !== true || value.cleanup !== 'confirmed') {
          const details = value.error || value;
          const error = safeError({ ...details, details });
          closeFailure = { cleanup: 'unknown', applicationClosed: false,
            recovery: error.recovery || null, errorCode: error.code, inputRecoveryRequired: true };
          return { ...closeFailure };
        }
        sessionId = null; return { cleanup: 'confirmed', applicationClosed: false };
      } catch {
        closeFailure = { cleanup: 'unknown', applicationClosed: false, inputRecoveryRequired: true };
        return { ...closeFailure };
      }
    },
    ...(typeof recover === 'function' ? { recover: request => recover(request) } : {})
  };
  return provider;
}
module.exports = { createTraceProvider, state, TOOL_NAMES };
