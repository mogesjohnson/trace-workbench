'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PIN, STAGES, RECIPE, plan, exactWindowSource, editOperations, packetDuration,
  gradientEnergy, meanDifference, validateMeasurements, createWorkflow } = require('../scripts/accept-replay-workflow.cjs');
const root = path.resolve('synthetic-private-replay');
const id = index => `ac01e6f2-1234-4567-8901-${String(index).padStart(12, '0')}`;
const nativeIdentity = (pid, windowId) => ({ pid, windowId: String(windowId), processCreationTime: `1340000000000${pid}`, sessionId: 1 });
const fixtureIdentity = { ...nativeIdentity(900, 901), synthetic: true, privacyTextureVerified: true };
function measurements(kind) {
  return { sha256: 'a'.repeat(64), bytes: 1024, width: 960, height: 600, videoStreams: 1,
    decodedFrames: 3, nonblackMean: 30, audioStreams: kind === 'fixture' ? 1 : 0,
    duration: kind === 'fixture' ? 6 : 20, sourceHashUnchanged: true, effectSampleTimes: [0.5, 2, 4],
    calloutDifference: 20, privacySourceEnergy: 100, privacyOutputEnergy: 20,
    beforeEffectDifference: 1, afterEffectDifference: 1, audioBeforeRms: 0.001, audioDuringRms: 0.08,
    audioAfterRms: 0.001, decodedFrameDifference: 4 };
}
function injectedRuntime(options = {}) {
  const events = [], calls = [], apps = [], projects = new Map(), jobs = new Map();
  let pid = 10, previewReads = 0, projectIndex = 0, previewProject;
  const deps = {
    verifyPins: async () => { events.push('verify-pins'); await options.beforePins?.(); return options.pins ?? { ...PIN }; },
    prepareOfflineAssets: async () => ({ bootstrapVideo: path.join(root, 'bootstrap.mp4'), wavDuration: 1, paidRequests: 0 }),
    launchApp: async input => {
      const child = { pid: ++pid, exitCode: null, signalCode: null }, app = { label: input.label, process: () => child };
      apps.push(app); events.push(`launch:${input.label}`);
      assert.deepEqual(input.args, [`--smoke-test=${path.join(root, 'bootstrap.mp4')}`, `--smoke-output=${path.join(root, input.label)}`]);
      return app;
    },
    processIdentity: async appPid => nativeIdentity(appPid, appPid + 100),
    readyApp: async app => { if (options.readinessFails && app.label === 'editor') throw Object.assign(new Error(), { code: 'readiness_failed' });
      return { page: { label: app.label }, info: { libraryPath: path.join(root, app.label, '.replay-smoke/Library') } }; },
    editorWindowIdentity: async app => nativeIdentity(app.process().pid, app.process().pid + 100),
    createGrant: async page => ({ grant: { id: id(page.label === 'editor' ? 1 : 2),
      importRoots: [path.join(root, page.label, 'agent-imports')], exportRoots: [path.join(root, page.label, 'agent-exports')] },
      setup: { mcp: { mcpServers: { replay: { label: page.label } } } } }),
    connectMcp: async entry => ({ label: entry.label }),
    command: async (client, name, input, revision, requestId) => {
      calls.push({ label: client.label, name, input: structuredClone(input), revision, requestId });
      if (options.failCommand === name) throw Object.assign(new Error(), { code: 'injected_transport_unknown' });
      if (name === 'app.capabilities') return { projectSchemaVersion: 3 };
      if (name === 'capture.sources') return { sources: [{ id: 'screen:1:0' }, { id: 'window:901:0' }, { id: 'window:111:0' }] };
      if (name === 'capture.start') return { state: 'recording', recordingId: id(50), sourceId: input.sourceId };
      if (name === 'capture.stop' || name === 'project.import') {
        const current = { id: id(++projectIndex + 10), revision: 1, duration: client.label === 'editor' ? 9 : 20,
          sourcePath: path.join(root, client.label, '.replay-smoke/Library', `source-${projectIndex}.webm`) };
        projects.set(current.id, current); return structuredClone(current);
      }
      if (name === 'project.get') return structuredClone(projects.get(input.id));
      if (name === 'narration.import') return { asset: { assetId: id(80), duration: 1 } };
      if (name === 'project.edit') { const current = projects.get(input.projectId); assert.equal(revision, current.revision); current.revision++; return structuredClone(current); }
      if (name === 'preview.open') { previewProject = input.projectId; return { ready: true, projectId: input.projectId, position: input.position }; }
      if (name === 'preview.get') return { projectId: previewProject, position: previewReads++ ? 1 : 0, ready: true };
      if (name === 'export.start') {
        const job = { id: id(100 + jobs.size), revision, state: 'completed', output: { path: input.output } };
        jobs.set(job.id, job); return { id: job.id };
      }
      throw new Error(`Unexpected typed command ${name}`);
    },
    waitJob: async (_client, jobId) => jobs.get(jobId),
    windowIdentity: async target => options.changedIdentity ? { ...target, processCreationTime: '999999' } : target,
    validateOwnedFixture: async () => fixtureIdentity,
    verifyTraceEvidence: async (kind, input, target) => { events.push(`trace-evidence:${kind}:${target.pid}`); return input?.actualTraceReceipt === true; },
    copyOfflineWav: async (_prepared, importRoot) => path.join(importRoot, 'offline.wav'),
    verifySavedRecipe: async () => true,
    requireMissing: async output => { if (options.outputExists) throw Object.assign(new Error(), { code: 'output_exists' }); events.push(`missing:${path.basename(output)}`); },
    copyCompletedExport: async (_source, importRoot) => path.join(importRoot, 'fixture-demo.mp4'),
    independentMediaVerification: async kind => measurements(kind),
    verifyRootReview: async input => input?.actualRootReview === true,
    closeTransport: async client => { events.push(`close-transport:${client.label}`); if (options.closeFails) throw new Error(); },
    revokeGrant: async app => { events.push(`revoke:${app.label}`); },
    grantRevoked: async () => !options.revokeFails,
    stopApp: async app => { events.push(`stop:${app.label}`); if (options.signalExit) app.process().signalCode = 'SIGTERM'; else app.process().exitCode = 0; },
    waitIdentityExit: async value => { events.push(`exact-exit:${value.pid}:${value.processCreationTime}`); return !options.exactExitFails; },
  };
  return { deps, calls, apps, events, workflow: createWorkflow(deps, { privateRoot: root }) };
}
async function through(f, last) {
  for (const stage of STAGES) {
    await f.workflow.advance(stage, { actualTraceReceipt: true, actualRootReview: true });
    if (stage === last) break;
  }
}

test('planning is pure, preserves full APP-01 scope and explicitly identifies unfinished runtime wiring', () => {
  const declared = plan();
  assert.equal(declared.claimsAttempt, false); assert.equal(declared.status, 'preparation_only');
  assert.deepEqual(declared.outputs, ['fixture-demo.mp4', 'editor-walkthrough.mp4']);
  assert.equal(declared.stages.length, 15); assert.ok(declared.remaining.some(value => value.includes('adapter')));
  declared.recipe.callout.text = 'changed'; assert.notEqual(RECIPE.callout.text, 'changed');
  assert.throws(() => { RECIPE.privacy.x = 0; }, TypeError);
});

test('exact capture source requires one precise owned HWND and never silently selects a display or similarly named window', () => {
  assert.equal(exactWindowSource({ sources: [{ id: 'screen:901:0' }, { id: 'window:901:0' }, { id: 'window:1901:0' }] }, fixtureIdentity), 'window:901:0');
  for (const sources of [[], [{ id: 'window:1901:0' }], [{ id: 'window:901:0' }, { id: 'window:901:1' }]]) {
    assert.throws(() => exactWindowSource({ sources }, fixtureIdentity), { code: 'replay_capture_target_ambiguous' });
  }
});

test('typed recipe uses source trim then composition annotation/narration placement and mutes original audio without provider calls', () => {
  const operations = editOperations(id(80), id(81));
  assert.deepEqual(operations.map(value => value.type), ['trim', 'frame', 'overlay.put', 'overlay.put', 'narration.put', 'audio.mix']);
  assert.deepEqual(operations[0], { type: 'trim', sourceStart: 1, sourceEnd: 7 });
  assert.equal(operations[2].overlay.start, 1); assert.equal(operations[4].clip.start, 1.5);
  assert.equal(operations[4].clip.assetId, id(80)); assert.equal(operations[5].sourceMuted, true);
});

test('injected complete stage sequence preserves capture ordering, revisions, two fixed exports and native evidence pauses', async () => {
  const f = injectedRuntime(); await through(f, 'cleanup');
  const names = f.calls.map(call => call.name);
  assert.equal(names.filter(name => name === 'capture.start').length, 2);
  assert.ok(names.lastIndexOf('capture.start') < names.indexOf('project.edit'));
  assert.ok(names.lastIndexOf('capture.stop') > names.indexOf('project.import'));
  assert.deepEqual(f.calls.filter(call => call.name === 'export.start').map(call => path.basename(call.input.output)), ['fixture-demo.mp4', 'editor-walkthrough.mp4']);
  for (const call of f.calls.filter(call => ['project.edit', 'export.start', 'preview.open', 'narration.import'].includes(call.name))) {
    assert.ok(Number.isInteger(call.revision)); assert.ok(call.requestId);
  }
  assert.equal(new Set(f.calls.filter(call => call.requestId).map(call => call.requestId)).size, f.calls.filter(call => call.requestId).length);
  assert.equal(f.events.filter(value => value.startsWith('trace-evidence:')).length, 3);
  assert.equal(f.workflow.state().cleanup.confirmed, true);
  assert.equal(f.workflow.state().status, 'awaiting_runtime_evidence_audit'); // Synthetic success cannot claim live APP-01.
});

test('readiness failure still retains and closes the exact returned app handle before any grant or command', async () => {
  const f = injectedRuntime({ readinessFails: true });
  await assert.rejects(f.workflow.advance('provision'), { code: 'readiness_failed' });
  assert.equal(f.apps.length, 1); assert.equal(f.calls.length, 0);
  const closed = await f.workflow.cleanup(); assert.equal(closed.confirmed, true);
  assert.ok(f.events.includes('stop:editor')); assert.ok(f.events.some(value => value.startsWith('exact-exit:11:')));
});

test('package/source mismatch stops before launch and out-of-order or concurrent stages dispatch nothing', async () => {
  const wrong = injectedRuntime({ pins: { ...PIN, asarSha256: '0'.repeat(64) } });
  await assert.rejects(wrong.workflow.advance('provision'), { code: 'replay_source_changed' }); assert.equal(wrong.apps.length, 0);
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const f = injectedRuntime({ beforePins: () => waiting });
  await assert.rejects(f.workflow.advance('fixture-record-start'), { code: 'replay_stage_out_of_order' });
  const pending = f.workflow.advance('provision');
  await assert.rejects(f.workflow.advance('provision'), { code: 'replay_stage_out_of_order' });
  release(); await pending; await f.workflow.cleanup();
});

test('changed native generation blocks capture before mutation; missing root TRACE evidence prevents progressing to edits', async () => {
  const f = injectedRuntime({ changedIdentity: true }); await through(f, 'fixture-ready');
  await assert.rejects(f.workflow.advance('fixture-record-start'), { code: 'replay_capture_identity_changed' });
  assert.equal(f.calls.some(call => call.name === 'capture.start'), false); await f.workflow.cleanup();
  const missing = injectedRuntime(); await through(missing, 'fixture-record-start');
  await assert.rejects(missing.workflow.advance('fixture-record-stop', {}), { code: 'replay_trace_evidence_missing' });
  assert.equal(missing.calls.some(call => call.name === 'project.edit'), false); await missing.workflow.cleanup();
});

test('unknown mutation retains its pending request ID and never permits automatic retry or later stage', async () => {
  const f = injectedRuntime({ failCommand: 'capture.start' }); await through(f, 'fixture-ready');
  await assert.rejects(f.workflow.advance('fixture-record-start'), { code: 'injected_transport_unknown' });
  const pending = f.workflow.state().requests.find(value => value.command === 'capture.start');
  assert.equal(pending.state, 'pending'); assert.ok(pending.requestId);
  await assert.rejects(f.workflow.advance('fixture-record-start'), { code: 'replay_stage_out_of_order' });
  assert.equal(f.calls.filter(call => call.name === 'capture.start').length, 1); await f.workflow.cleanup();
});

test('existing export destination is preserved without dispatching export', async () => {
  const f = injectedRuntime({ outputExists: true }); await through(f, 'trace-editor-controls');
  await assert.rejects(f.workflow.advance('export-fixture'), { code: 'output_exists' });
  assert.equal(f.calls.some(call => call.name === 'export.start'), false); await f.workflow.cleanup();
});

test('cleanup is idempotent, recognizes signal termination, and requires exact OS birth exit plus durable grant revocation', async () => {
  for (const options of [{ signalExit: true }, { revokeFails: true }, { exactExitFails: true }, { closeFails: true }]) {
    const f = injectedRuntime(options); await through(f, 'provision');
    const a = f.workflow.cleanup(), b = f.workflow.cleanup(); assert.equal(a, b);
    const result = await a; assert.equal(result.confirmed, !!options.signalExit);
    assert.equal(f.events.filter(value => value.startsWith('stop:')).length, 2);
    assert.equal(f.events.filter(value => value.startsWith('revoke:')).length, 2);
  }
});

test('WebM duration fallback uses packet ends; missing or malformed duration cannot pass', () => {
  assert.deepEqual(packetDuration('N/A', ['0.000,0.033', '3.760,0.035']), { seconds: 3.795, source: 'independent_packet_timestamps' });
  assert.equal(packetDuration('6.00', []).source, 'container');
  assert.throws(() => packetDuration('N/A', ['N/A,N/A']), { code: 'replay_duration_unverified' });
});

test('independent decode measurements require effect timing, actual blur detail reduction, narration placement and both stream contracts', () => {
  assert.equal(validateMeasurements(measurements('fixture'), 'fixture'), true);
  for (const patch of [{ duration: 8 }, { audioStreams: 0 }, { sourceHashUnchanged: false }, { calloutDifference: 0 },
    { privacyOutputEnergy: 100 }, { beforeEffectDifference: 20 }, { afterEffectDifference: 20 },
    { audioDuringRms: 0 }, { audioBeforeRms: 0.2 }, { effectSampleTimes: [1, 2, 4] }]) {
    assert.throws(() => validateMeasurements({ ...measurements('fixture'), ...patch }, 'fixture'));
  }
  assert.equal(validateMeasurements(measurements('walkthrough'), 'walkthrough'), true);
  assert.throws(() => validateMeasurements({ ...measurements('walkthrough'), decodedFrameDifference: 0 }, 'walkthrough'));
  const texture = Buffer.alloc(8 * 8 * 3);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) texture.fill((x + y) % 2 ? 255 : 0, (y * 8 + x) * 3, (y * 8 + x + 1) * 3);
  const smooth = Buffer.alloc(texture.length, 127);
  assert.ok(gradientEnergy(texture, 8, 8) > gradientEnergy(smooth, 8, 8) * 100);
  assert.ok(meanDifference(texture, smooth) > 100);
  assert.throws(() => gradientEnergy(Buffer.alloc(1), 8, 8), { code: 'replay_decode_invalid' });
});
