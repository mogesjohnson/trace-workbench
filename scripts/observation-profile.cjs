'use strict';
const fs = require('node:fs');
const stages = ['observation', 'backend', 'identity', 'uia', 'geometry', 'restore', 'settle', 'capture',
  'backendPngRead', 'fileStat', 'fileRead', 'pngHeader', 'hashEncode', 'journal', 'focus', 'provider'];
const counts = ['providerRequests', 'supervisedRequests', 'directRequests', 'captureRequests', 'elements', 'invalidTimingSamples'];
const byteNames = ['backendPngRead', 'controllerPngRead', 'base64'];
const unavailable = ['helperStartup', 'providerExecution', 'wireTransport', 'clientLatency', 'modelTime'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('Invalid observation profile samples.'); };
function numeric(value, integer = false) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) fail();
  return value;
}
function summarize(samples) {
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 1000) fail();
  const groups = { first: { samples: 0, metrics: {} }, later: { samples: 0, metrics: {} } };
  let failedSamples = 0;
  for (const sample of samples) {
    if (!object(sample) || !['completed', 'failed'].includes(sample.status)) fail();
    if (sample.status === 'failed') { failedSamples++; continue; }
    const m = sample.observation;
    if (!object(m) || m.version !== 1 || m.clock !== 'process-monotonic'
      || !['first-controller-attempt', 'later-controller-attempt'].includes(m.sample)
      || ![m.stages, m.counts, m.bytes].every(object)) fail();
    if (m.counts.invalidTimingSamples !== undefined && numeric(m.counts.invalidTimingSamples, true) !== 0) fail();
    const group = groups[m.sample === 'first-controller-attempt' ? 'first' : 'later'];
    group.samples++;
    const add = (name, value, integer = false) => {
      if (value !== undefined) (group.metrics[name] ??= []).push(numeric(value, integer));
    };
    for (const name of stages) {
      const stage = m.stages[name];
      if (stage === undefined) continue;
      if (!object(stage)) fail();
      numeric(stage.calls, true); numeric(stage.failures, true); numeric(stage.durationMs);
      if (stage.failures > stage.calls) fail();
      for (const field of ['calls', 'failures', 'durationMs']) add(`stages.${name}.${field}`, stage[field], field !== 'durationMs');
    }
    for (const name of counts) add(`counts.${name}`, m.counts[name], true);
    for (const name of byteNames) add(`bytes.${name}`, m.bytes[name], true);
    add('clientRoundTripMs', sample.clientRoundTripMs);
    if (sample.projection !== undefined && sample.projection !== null) {
      const p = sample.projection;
      if (!object(p) || p.version !== 1 || p.clock !== 'process-monotonic') fail();
      for (const name of ['durationMs', 'jsonTextBytes', 'imageBase64Bytes', 'imageCount'])
        add(`projection.${name}`, p[name], name !== 'durationMs');
    }
  }
  for (const group of Object.values(groups)) {
    for (const [name, values] of Object.entries(group.metrics)) {
      values.sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      const median = values.length % 2 ? values[middle] : values[middle - 1] + (values[middle] - values[middle - 1]) / 2;
      group.metrics[name] = { samples: values.length, min: values[0], median, max: values.at(-1) };
    }
  }
  return { version: 1, scope: 'provided-numeric-samples', failedSamples, groups, unavailable: [...unavailable] };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) fail();
    process.stdout.write(`${JSON.stringify(summarize(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))), null, 2)}\n`);
  } catch {
    process.stderr.write('Cannot summarize observation profile: expected valid numeric samples JSON.\n');
    process.exitCode = 1;
  }
}
module.exports = { summarize };
