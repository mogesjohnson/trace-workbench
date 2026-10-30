'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const context = new AsyncLocalStorage();
const STAGES = new Set(['observation', 'backend', 'identity', 'uia', 'geometry', 'restore', 'settle', 'capture',
  'backendPngRead', 'fileStat', 'fileRead', 'pngHeader', 'hashEncode', 'journal', 'focus', 'provider']);
const COUNTS = new Set(['providerRequests', 'supervisedRequests', 'directRequests', 'captureRequests', 'elements', 'invalidTimingSamples']);
const BYTES = new Set(['backendPngRead', 'controllerPngRead', 'base64']);
const bounded = value => Math.min(Number.MAX_SAFE_INTEGER, value);

function count(name, amount = 1) {
  const scope = context.getStore();
  if (!scope || !Number.isSafeInteger(amount) || amount < 0) return;
  const values = COUNTS.has(name) ? scope.counts : BYTES.has(name) ? scope.bytes : null;
  if (values) values[name] = bounded((values[name] || 0) + amount);
}

function measure(stage, work) {
  const scope = context.getStore();
  if (!scope || !STAGES.has(stage)) return work();
  const started = scope.clock();
  const finish = failed => {
    const elapsed = scope.clock() - started;
    const entry = scope.stages[stage] ??= { calls: 0, failures: 0, durationMs: 0 };
    entry.calls = bounded(entry.calls + 1);
    entry.failures = bounded(entry.failures + Number(failed));
    if (Number.isFinite(elapsed) && elapsed >= 0) entry.durationMs = bounded(entry.durationMs + elapsed);
    else count('invalidTimingSamples');
  };
  let result;
  try { result = work(); } catch (error) { finish(true); throw error; }
  if (result && typeof result.then === 'function') return Promise.resolve(result).then(
    value => { finish(false); return value; }, error => { finish(true); throw error; });
  finish(false);
  return result;
}

function providerRequest(supervised, work) {
  count('providerRequests');
  count(supervised ? 'supervisedRequests' : 'directRequests');
  return measure('provider', work);
}

function createObservationMetrics({ sample, clock = () => performance.now() } = {}) {
  const scope = { clock, stages: {}, counts: {}, bytes: {} };
  return {
    run: work => context.run(scope, work),
    snapshot: () => ({ version: 1, clock: 'process-monotonic',
      sample: sample === 'first-controller-attempt' ? sample : 'later-controller-attempt',
      stages: Object.fromEntries(Object.entries(scope.stages).map(([key, value]) => [key,
        { ...value, durationMs: Math.round(value.durationMs * 1000) / 1000 }])),
      counts: { ...scope.counts }, bytes: { ...scope.bytes },
      unavailable: ['helperStartup', 'providerExecution', 'wireTransport', 'clientLatency', 'modelTime'],
    }),
  };
}

module.exports = { createObservationMetrics, measure, count, providerRequest };
