'use strict';
const { createTraceProvider, state, TOOL_NAMES } = require('./trace-adapter.cjs');
const { windowIdentity } = require('./observation-images.cjs');
const { digest, fail, text } = require('./shared.cjs');
const { performance } = require('node:perf_hooks');
const key = window => digest([windowIdentity(window), window.ownerWindowId ?? null]);

// Process-local handles preserve the adapter's private capture and exact target binding.
function createTraceClient({ client, callTool = client?.callTool?.bind(client),
  listTools = client?.listTools?.bind(client), tools, environment = 'local',
  accessibilityDepth = 8, ttlMs = 5000, clock = () => performance.now() } = {}) {
  if (typeof callTool !== 'function' || !text(environment) || typeof clock !== 'function'
    || !Number.isFinite(ttlMs) || ttlMs <= 0) fail('client-config', 'Require transport, environment and a positive local TTL.');
  const handles = new WeakMap(), selections = new WeakMap();
  let active = null, busy = false, closed = false, quarantined = false;
  async function exclusive(work) {
    if (busy) fail('busy', 'Another client operation is in flight.');
    if (closed) fail('client-closed', 'Create a new client and rediscover the exact target.');
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  async function inventory() {
    const result = await callTool({ name: TOOL_NAMES[1], arguments: {} }), value = state(result);
    if (result.isError) fail(value.error?.code || 'discovery-failed', 'Window discovery failed.');
    const rows = Array.isArray(value) ? value : value?.windows;
    if (!Array.isArray(rows)) fail('invalid-response', 'Expected a current window inventory.');
    return rows;
  }
  async function release() {
    if (!active) return { cleanup: quarantined ? 'unknown' : 'confirmed', applicationClosed: false };
    active.observation = null;
    let receipt;
    try { receipt = await active.provider.close({ target: active.target }); }
    catch { receipt = { cleanup: 'unknown', inputRecoveryRequired: true, applicationClosed: false }; }
    if (receipt?.cleanup !== 'confirmed') {
      quarantined = true;
      return { ...receipt, cleanup: 'unknown', inputRecoveryRequired: true, applicationClosed: false };
    }
    active = null;
    return receipt;
  }
  async function bind(app, selected, ownedDialog = false) {
    if (quarantined) fail('input_recovery_required', 'Unconfirmed cleanup blocks rebinding; inspect recovery.');
    if (!text(app)) fail('client-config', 'Supply the exact application label.');
    const expected = key(selected), rows = await inventory();
    const matches = rows.filter(row => (row.id ?? row.windowId) === (selected.id ?? selected.windowId));
    if (matches.length !== 1 || key(matches[0]) !== expected) fail('target-changed', 'Rediscovered window lifetime or owner differs.');
    if (ownedDialog) {
      const parents = rows.filter(row => (row.id ?? row.windowId) === active?.target.windowId);
      if (!active || parents.length !== 1 || key(parents[0]) !== active.key
        || (matches[0].ownerWindowId ?? null) !== active.target.windowId) {
        fail('ownership-unverified', 'Require the current exact parent and its explicitly selected owned dialog.');
      }
    }
    const provider = createTraceProvider({ callTool, listTools, tools, environment, app,
      windowId: matches[0].id ?? matches[0].windowId, accessibilityDepth });
    const readiness = await provider.doctor();
    if (!readiness.ready) fail(readiness.code || 'provider-unavailable', readiness.reason || 'TRACE is unavailable.');
    const targets = await provider.discover({ environment, app });
    const target = targets[0];
    if (targets.length !== 1 || key({ id: target.windowId, ...target.identity,
      processCreationTime: target.identity.generation, ownerWindowId: target.ownerWindowId }) !== expected) {
      fail('target-changed', 'Binding changed during discovery.');
    }
    if ((await release()).cleanup !== 'confirmed') fail('transition-cleanup-unknown', 'Previous session release is unconfirmed.');
    const entry = { provider, target, key: expected, observation: null, capturedAt: null };
    const current = () => {
      if (active !== entry || quarantined) fail('stale-target', 'This handle no longer owns the current binding.');
    };
    const handle = Object.freeze({
      target: Object.freeze({ ...target, identity: Object.freeze({ ...target.identity }) }),
      observe: () => exclusive(async () => {
        current(); entry.observation = null;
        const started = clock();
        const observation = await provider.observe({ target });
        entry.observation = observation.id; entry.capturedAt = started;
        return observation;
      }),
      act: action => exclusive(async () => {
        current();
        const age = clock() - entry.capturedAt;
        if (!entry.observation || !Number.isFinite(age) || age < 0
          || age > Math.min(ttlMs, provider.constraints.observationTtlMs)) {
          fail('stale-observation', 'Observe this exact handle freshly before each action.');
        }
        const payload = provider.validateAction({ observationId: entry.observation, payload: action });
        const observationId = entry.observation;
        entry.observation = null;
        let receipt;
        try { receipt = await provider.act({ target, observationId, capability: 'native-action', payload }); }
        catch { receipt = { delivery: 'unknown', cleanup: 'unknown', inputRecoveryRequired: true }; }
        if (receipt.cleanup === 'unknown') quarantined = true;
        return receipt;
      }),
      close: () => exclusive(async () => { current(); return release(); })
    });
    handles.set(handle, { app, window: structuredClone(matches[0]) });
    active = entry;
    return handle;
  }
  return Object.freeze({
    windows: () => exclusive(async () => (await inventory()).map(row => {
      const selection = Object.freeze(structuredClone(row));
      selections.set(selection, structuredClone(row)); return selection;
    })),
    bind: ({ app, window, ownedDialog = false } = {}) => exclusive(() => {
      if (typeof ownedDialog !== 'boolean') fail('client-config', 'ownedDialog must be boolean.');
      const selected = selections.get(window);
      if (!selected) fail('undiscovered-target', 'Choose a window returned by this client.');
      return bind(app, selected, ownedDialog);
    }),
    rebind: handle => exclusive(() => {
      const saved = handles.get(handle);
      if (!saved) fail('undiscovered-target', 'Rebind a handle returned by this client.');
      return bind(saved.app, saved.window);
    }),
    // A serialized identity is a constraint, never authority: inventory and provider recheck it.
    restore: ({ app, window } = {}) => exclusive(() => bind(app, structuredClone(window))),
    close: () => exclusive(async () => {
      const receipt = await release(); closed = true; return receipt;
    })
  });
}
module.exports = { createTraceClient };
