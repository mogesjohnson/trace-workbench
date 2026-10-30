'use strict';
const { digest, fail, text } = require('./shared.cjs');
const { validateAction: validateNativeAction, safeError } = require('../computer/controller.cjs');
const { actionSupport, compatibleSupport } = require('../computer/action-contract.cjs');
const { validateObservationImages, windowIdentity: identity } = require('./observation-images.cjs');
const { createPostActionEvidence } = require('./post-action-evidence.cjs');
const { performance } = require('node:perf_hooks');
const TOOL_NAMES = ['doctor', 'list_windows', 'open_session', 'observe', 'act', 'close_session'].map(s => `trace_computer_${s}`);
function state(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  try { return JSON.parse(result?.content?.find(c => c.type === 'text')?.text); }
  catch { fail('invalid-response', 'TRACE returned no structured response.'); }
}
function createTraceProvider({ client, callTool = client?.callTool?.bind(client),
  listTools = client?.listTools?.bind(client), tools, environment = 'local', app, windowId,
  id = `trace-native:${environment}:${app}:${windowId}`, accessibilityDepth = 8, recover,
  monotonicClock = () => performance.now() } = {}) {
  if (typeof callTool !== 'function' || !text(app) || !text(windowId) || !text(environment) || !text(id)
    || !Number.isInteger(accessibilityDepth) || accessibilityDepth < 1 || accessibilityDepth > 32 || typeof monotonicClock !== 'function') {
    fail('adapter-config', 'Bind a transport, exact environment/app/window and depth 1-32.');
  }
  let sessionId = null, capture = null, binding = null, supportsDepth = false;
  let boundWindow = null;
  const seenObservations = new Set();
  let closeFailure = null;
  let evidenceEpoch = 0;
  const reference = w => ({ environment, app, windowId, ownership: 'attached',
    ownerWindowId: w.ownerWindowId ?? w.targetState?.ownerWindowId ?? null,
    identity: { pid: w.pid ?? w.processId, processName: w.processName,
      generation: w.processCreationTime ?? null, sessionId: w.sessionId ?? null } });
  const call = async (index, args) => callTool({ name: TOOL_NAMES[index], arguments: args });
  function assertBoundTarget(target) {
    if (digest(identity({ id: windowId, ...target.identity, processCreationTime: target.identity?.generation })) !== binding
      || reference(boundWindow).ownerWindowId !== (target.ownerWindowId ?? null)) {
      fail('target-mismatch', 'The supplied target differs from the privately discovered process and owner.');
    }
  }
  function checkedObservation(value, content, target) {
    const evidence = validateObservationImages(value, content, { sessionId, window: boundWindow,
      ownerWindowId: reference(boundWindow).ownerWindowId });
    if (seenObservations.has(value.observationId)) fail('duplicate-observation', 'A reused observation ID cannot refresh native evidence.');
    seenObservations.add(value.observationId);
    return { id: value.observationId, target: structuredClone(target),
      evidenceKey: digest([value.screenshot?.sha256, value.elements || [], value.focused || null, value.targetState || null]),
      evidence: { ...evidence, focus: value.focused || { available: false, reason: 'Executor did not expose intended-control focus.' } },
      preparation: value.preparation || [] };
  }
  const unknownSupport = () => ({ status: 'unknown', code: 'support-unavailable' });
  function diagnostics(ready, code = null, reason = null, support = unknownSupport(), { configured = false, native = null } = {}) {
    provider.available = ready;
    const readiness = { configured: { ready: configured, code: configured ? null : code, reason: configured ? null : reason },
      native: { ready: native, code: native === false ? code : null, reason: native === false ? reason : null },
      target: { ready: null, reason: 'Discover and observe the exact target; runtime readiness does not prove target readiness.' } };
    provider.constraints.nativeSupport = support;
    provider.constraints.observationTtlMs = support.observation?.ttlMs ?? 60000;
    provider.constraints.readiness = readiness;
    return { ready, code, reason, support, readiness };
  }
  const provider = {
    id, channel: 'desktop', usesDesktop: true, available: false, environments: [environment], windowIds: [windowId],
    apps: [app], capabilities: ['native-action'],
    constraints: { coordinateSpace: 'window-local-physical-pixels', observationTtlMs: 60000,
      accessibilityDepth, physicalRecovery: typeof recover === 'function' ? 'injected' : 'unavailable' },
    async doctor() {
      evidenceEpoch++;
      diagnostics(false, 'diagnostics-pending', 'Tool discovery and runtime diagnostics are pending.');
      try {
        const listing = tools || (typeof listTools === 'function' ? (await listTools({})).tools : null);
        if (!Array.isArray(listing) || !TOOL_NAMES.every(name => listing.some(t => t.name === name))) {
          return diagnostics(false, 'schema-unavailable', 'Discover all six live TRACE tools before enabling the adapter.');
        }
        const schema = listing.find(t => t.name === TOOL_NAMES[3]).inputSchema;
        supportsDepth = !!schema?.properties?.accessibilityDepth;
        if (!supportsDepth && accessibilityDepth !== 8) {
          return diagnostics(false, 'depth-unsupported', 'The live observation schema does not advertise requested depth.');
        }
        const result = await call(0, {}), value = state(result), support = value.support ?? unknownSupport();
        if (value.support != null && !compatibleSupport(support)) {
          return diagnostics(false, 'support-unsupported', 'The live server declares an unsupported native action contract.', unknownSupport(), { native: value.ready === true });
        }
        const effectiveSupport = value.support != null ? actionSupport(support.observation.ttlMs) : support;
        return diagnostics(result.isError !== true && value.ready === true, value.code || value.error?.code || null, value.reason || value.error?.message || null, effectiveSupport,
          { configured: true, native: result.isError !== true && value.ready === true });
      } catch { return diagnostics(false, 'diagnostics-unavailable', 'TRACE diagnostics could not be read.'); }
    },
    async discover(target) {
      evidenceEpoch++;
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
      binding = key; boundWindow = structuredClone(matches[0]); return matches.map(reference);
    },
    async observe({ target }) {
      evidenceEpoch++;
      capture = null;
      if (closeFailure) fail('input_recovery_required', 'Resolve the uncertain close and create a new provider before observing.');
      if (!provider.available || !binding || target.environment !== environment || target.app !== app
        || target.windowId !== windowId) fail('target-mismatch', 'Observe the exact discovered app/window.');
      assertBoundTarget(target);
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
        seenObservations.clear();
      }
      const result = await call(3, { sessionId, ...(supportsDepth ? { accessibilityDepth } : {}) }), value = state(result);
      if (result.isError) fail(value.error?.code || 'observe-failed', 'TRACE capture failed.');
      const observation = checkedObservation(value, result.content, target);
      capture = structuredClone(observation.evidence.state);
      return observation;
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
      assertBoundTarget(target);
      const actionEpoch = ++evidenceEpoch, ownedSession = sessionId, ownedBinding = binding;
      const actionTarget = structuredClone(target);
      const currentAction = () => evidenceEpoch === actionEpoch && sessionId === ownedSession
        && binding === ownedBinding && provider.available && !closeFailure;
      capture = null;
      let startedAt;
      try { startedAt = monotonicClock(); } catch { startedAt = NaN; }
      let result;
      try { result = await call(4, { sessionId, observationId, action: payload }); }
      catch { return { delivery: 'unknown' }; }
      const value = state(result), recovery = value.error?.recovery;
      const cleanupRequired = value.error?.inputRecoveryRequired === true || value.error?.code === 'input_recovery_required'
        || value.inputRecoveryRequired === true || value.cleanup === 'unknown' || value.error?.cleanup === 'unknown'
        || recovery?.released === false || recovery?.reason === 'process_exit_unconfirmed';
      let resultingObservation = null, postActionEvidence = null;
      if (currentAction() && result.isError !== true && value.outcome === 'completed' && !value.error && !cleanupRequired
        && value.verification === 'fresh_observation' && text(value.actionId) && value.actionId.length <= 256 && !value.actionId.includes('\0')) {
        try {
          resultingObservation = checkedObservation(value.observation, result.content, actionTarget);
          resultingObservation.authority = 'verification-only';
          resultingObservation.sourceCapturedAt = value.observation.observedAt;
          postActionEvidence = createPostActionEvidence({ observation: resultingObservation, actionId: value.actionId,
            beforeObservationId: observationId, startedAt, clock: monotonicClock,
            current: currentAction });
        } catch { resultingObservation = null; }
      }
      return { delivery: value.outcome === 'not_dispatched' ? 'not-delivered'
        : result.isError !== true && value.outcome === 'completed' ? 'delivered' : 'unknown',
        blocked: value.error?.code === 'window_blocked', cleanup: cleanupRequired ? 'unknown' : undefined,
        preparation: value.preparation || value.error?.preparation || value.nativeResult?.preparation || [],
        errorCode: value.error?.code || null, resultingState: resultingObservation?.evidence.state || null,
        resultingObservation, postActionEvidence, recovery: recovery || null };
    },
    async close({ target }) {
      evidenceEpoch++;
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
    ...(typeof recover === 'function' ? { recover: request => { evidenceEpoch++; capture = null; return recover(request); } } : {})
  };
  return provider;
}
module.exports = { createTraceProvider, state, TOOL_NAMES };
