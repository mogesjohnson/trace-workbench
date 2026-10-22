'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PIN, STAGES, RECIPE, EVIDENCE_INPUTS, plan, exactWindowSource, editOperations, recipeMatches, packetDuration,
  gradientEnergy, meanDifference, validateMeasurements, createWorkflow } = require('../scripts/accept-replay-workflow.cjs');
const root = path.resolve('synthetic-private-replay');
const id = index => `ac01e6f2-1234-4567-8901-${String(index).padStart(12, '0')}`;
const nativeIdentity = (pid, windowId) => ({ pid, windowId: String(windowId), processCreationTime: `1340000000000${pid}`, sessionId: 1 });
function measurements(kind) {
  return { sha256: 'a'.repeat(64), bytes: 1024, width: 960, height: 600, videoStreams: 1,
    decodedFrames: 3, nonblackMean: 30, audioStreams: kind === 'fixture' ? 1 : 0,
    duration: kind === 'fixture' ? 6 : 20, sourceHashUnchanged: true, effectSampleTimes: [0.5, 2, 4],
    calloutDifference: 20, privacySourceEnergy: 100, privacyOutputEnergy: 20,
    beforeEffectDifference: 1, afterEffectDifference: 1, audioBeforeRms: 0.001, audioDuringRms: 0.08,
    audioAfterRms: 0.001, decodedFrameDifference: 4 };
}
function injectedRuntime(options = {}) {
  const events = [], calls = [], apps = [], projects = new Map(), jobs = new Map(), checkpoints = [];
  let pid = 10, projectIndex = 0, preview = { projectId: null, position: 0, playing: false }, fixtureChild;
  const deps = {
    checkpoint: async () => { if (options.checkpointFails) throw Object.assign(new Error(), { code: 'checkpoint_failed' });
      checkpoints.push(structuredClone(workflow.state().requests)); },
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
      if (options.failCommand === name) throw Object.assign(new Error(), { code: 'injected_transport_unknown', replayOutcome: options.failOutcome });
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
      if (name === 'preview.open') { preview = { projectId: input.projectId, position: input.position, playing: false }; return { ready: true, ...preview }; }
      if (name === 'preview.get') return { ready: true, ...preview };
      if (name === 'export.start') {
        const job = { id: id(100 + jobs.size), revision, state: 'completed', output: { path: input.output } };
        jobs.set(job.id, job); return { id: job.id };
      }
      if (name === 'jobs.list') return { jobs: [...jobs.values()].map(job => ({ id: job.id, state: job.state })) };
      if (name === 'capture.status') return { state: 'idle' };
      throw new Error(`Unexpected typed command ${name}`);
    },
    waitJob: async (_client, jobId) => jobs.get(jobId),
    windowIdentity: async target => options.changedIdentity ? { ...target, processCreationTime: '999999' } : target,
    launchFixture: async () => { fixtureChild = { pid: 900 }; events.push('launch:fixture'); return { child: fixtureChild }; },
    fixtureIdentity: async () => nativeIdentity(900, 901),
    validateOwnedFixture: async (input, expected, window) => { events.push(`fixture-ready:${window.openedAfter ? 'bound' : 'unbound'}`);
      return { ...expected, synthetic: true, privacyTextureVerified: options.textureMissing ? false : input?.observationId === 'observed' }; },
    verifyTraceEvidence: async (kind, input, target, window) => {
      events.push(`trace-evidence:${kind}:${target.pid}:${window.since ? 'since' : 'none'}`);
      if (input?.actualTraceReceipt !== true) return false;
      // The injected TRACE effect stands in for root's actual editor actions.
      if (kind === 'editor-controls') preview = { ...preview, position: preview.position + 1, playing: !!options.editorStillPlaying };
      if (kind === 'completed-file-playback') preview = { ...preview, position: preview.position + 1 };
      return true;
    },
    copyOfflineWav: async (_prepared, importRoot) => path.join(importRoot, 'offline.wav'),
    sourceDigest: async file => `digest:${path.basename(file)}`,
    verifySavedRecipe: async (_project, _recipe, assetId) => assetId === id(80),
    requireMissing: async output => { if (options.outputExists) throw Object.assign(new Error(), { code: 'output_exists' }); events.push(`missing:${path.basename(output)}`); },
    copyCompletedExport: async (_source, importRoot) => path.join(importRoot, 'fixture-demo.mp4'),
    independentMediaVerification: async (kind, _exported, _recipe, capture) => { events.push(`measure:${kind}:${capture.sourceSha256}`); return measurements(kind); },
    verifyRootReview: async input => input?.actualRootReview === true,
    closeTransport: async client => { events.push(`close-transport:${client.label}`); if (options.closeFails) throw new Error(); },
    revokeGrant: async app => { events.push(`revoke:${app.label}`); },
    grantRevoked: async () => !options.revokeFails,
    stopApp: async app => { events.push(`stop:${app.label}`); if (options.signalExit) app.process().signalCode = 'SIGTERM'; else app.process().exitCode = 0; },
    closeFixture: async () => { events.push('close-fixture'); return !options.fixtureExitFails; },
    waitIdentityExit: async value => { events.push(`exact-exit:${value.pid}:${value.processCreationTime}`); return !options.exactExitFails; },
  };
  const workflow = createWorkflow(deps, { privateRoot: root });
  return { deps, calls, apps, events, checkpoints, workflow };
}
const evidence = { actualTraceReceipt: true, actualRootReview: true, observationId: 'observed' };
async function through(f, last) {
  for (const stage of STAGES) {
    await f.workflow.advance(stage, evidence);
    if (stage === last) break;
  }
}

test('planning is pure, preserves full APP-01 scope, declares evidence inputs and claims no live run', () => {
  const declared = plan();
  assert.equal(declared.claimsAttempt, false); assert.equal(declared.status, 'adapter_ready_not_run');
  assert.deepEqual(declared.outputs, ['fixture-demo.mp4', 'editor-walkthrough.mp4']);
  assert.equal(declared.stages.length, 15); assert.ok(declared.remaining.some(value => value.includes('owner go-ahead')));
  assert.deepEqual(Object.keys(declared.evidenceInputs).sort(), Object.keys(declared.pauses).sort());
  assert.deepEqual(Object.keys(EVIDENCE_INPUTS).every(stage => STAGES.includes(stage)), true);
  declared.recipe.callout.text = 'changed'; assert.notEqual(RECIPE.callout.text, 'changed');
  assert.throws(() => { RECIPE.privacy.x = 0; }, TypeError);
});

test('exact capture source requires one precise owned HWND and never silently selects a display or similarly named window', () => {
  const fixture = { ...nativeIdentity(900, 901) };
  assert.equal(exactWindowSource({ sources: [{ id: 'screen:901:0' }, { id: 'window:901:0' }, { id: 'window:1901:0' }] }, fixture), 'window:901:0');
  for (const sources of [[], [{ id: 'window:1901:0' }], [{ id: 'window:901:0' }, { id: 'window:901:1' }]]) {
    assert.throws(() => exactWindowSource({ sources }, fixture), { code: 'replay_capture_target_ambiguous' });
  }
});

test('typed recipe uses source trim then composition annotation/narration placement and mutes original audio without provider calls', () => {
  const operations = editOperations(id(80), id(81));
  assert.deepEqual(operations.map(value => value.type), ['trim', 'frame', 'overlay.put', 'overlay.put', 'narration.put', 'audio.mix']);
  assert.deepEqual(operations[0], { type: 'trim', sourceStart: 1, sourceEnd: 7 });
  assert.equal(operations[2].overlay.start, 1); assert.equal(operations[4].clip.start, 1.5);
  assert.equal(operations[4].clip.assetId, id(80)); assert.equal(operations[5].sourceMuted, true);
});

test('saved recipe check requires the exact stored trim, source-time overlays, one placed clip and muted source', () => {
  const saved = { trimStart: 1, trimEnd: 7, padding: 0, radius: 0,
    overlays: [{ ...RECIPE.privacy, start: 2, end: 4 }, { ...RECIPE.callout, start: 2, end: 4 }],
    narration: { clips: [{ id: id(81), assetId: id(80), start: 1.5, gain: 1, muted: false }], sourceGain: 1, sourceMuted: true } };
  assert.equal(recipeMatches(saved, id(80)), true);
  assert.equal(recipeMatches(saved, id(79)), false);
  for (const change of [value => { value.trimEnd = 8; }, value => { value.overlays[0].start = 1; }, value => { value.overlays[1].text = 'other'; },
    value => { value.overlays.push({ id: 'extra' }); }, value => { value.narration.clips[0].start = 2; }, value => { value.narration.sourceMuted = false; },
    value => { value.padding = 56; }]) {
    const copy = structuredClone(saved); change(copy); assert.equal(recipeMatches(copy, id(80)), false);
  }
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
  assert.deepEqual(f.events.filter(value => value.startsWith('trace-evidence:')).map(value => value.split(':').slice(1).join(':')),
    ['fixture-demonstration:900:since', 'editor-controls:11:since', 'completed-file-playback:11:since']);
  assert.ok(f.events.includes('fixture-ready:bound')); assert.ok(f.events.includes('measure:fixture:digest:source-1.webm'));
  assert.ok(f.events.indexOf('launch:fixture') > f.events.indexOf('launch:recorder'));
  assert.equal(f.workflow.state().cleanup.confirmed, true);
  assert.deepEqual(f.workflow.state().cleanup.instances.map(value => value.label), ['recorder', 'editor', 'fixture']);
  assert.equal(f.workflow.state().status, 'awaiting_runtime_evidence_audit'); // Synthetic success cannot claim live APP-01.
});

test('every mutation request identity is checkpointed as pending before dispatch; a failed checkpoint dispatches nothing', async () => {
  const f = injectedRuntime(); await through(f, 'fixture-record-start');
  const start = f.calls.find(call => call.name === 'capture.start');
  assert.ok(f.checkpoints.some(snapshot => snapshot.some(value => value.requestId === start.requestId && value.state === 'pending')));
  assert.equal(f.workflow.state().requests.find(value => value.requestId === start.requestId).state, 'completed');
  await f.workflow.cleanup();
  const blocked = injectedRuntime({ checkpointFails: true }); await through(blocked, 'fixture-ready');
  await assert.rejects(blocked.workflow.advance('fixture-record-start'), { code: 'checkpoint_failed' });
  assert.equal(blocked.calls.some(call => call.name === 'capture.start'), false);
  assert.equal(blocked.workflow.state().requests.at(-1).state, 'not_dispatched'); await blocked.workflow.cleanup();
});

test('readiness failure still retains and closes the exact returned app handle before any grant, command or fixture', async () => {
  const f = injectedRuntime({ readinessFails: true });
  await assert.rejects(f.workflow.advance('provision'), { code: 'readiness_failed' });
  assert.equal(f.apps.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.events.includes('launch:fixture'), false);
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

test('fixture without measured privacy texture, changed native generation or missing TRACE evidence blocks before mutation', async () => {
  const flat = injectedRuntime({ textureMissing: true }); await through(flat, 'provision');
  await assert.rejects(flat.workflow.advance('fixture-ready', evidence), { code: 'replay_fixture_not_ready' }); await flat.workflow.cleanup();
  const f = injectedRuntime({ changedIdentity: true }); await through(f, 'fixture-ready');
  await assert.rejects(f.workflow.advance('fixture-record-start'), { code: 'replay_capture_identity_changed' });
  assert.equal(f.calls.some(call => call.name === 'capture.start'), false); await f.workflow.cleanup();
  const missing = injectedRuntime(); await through(missing, 'fixture-record-start');
  await assert.rejects(missing.workflow.advance('fixture-record-stop', {}), { code: 'replay_trace_evidence_missing' });
  assert.equal(missing.calls.some(call => call.name === 'project.edit'), false); await missing.workflow.cleanup();
});

test('editor controls require the independent preview to end paused past the opened position', async () => {
  const f = injectedRuntime({ editorStillPlaying: true }); await through(f, 'edit-fixture');
  await assert.rejects(f.workflow.advance('trace-editor-controls', evidence), { code: 'replay_editor_controls_unverified' });
  assert.equal(f.calls.some(call => call.name === 'export.start'), false); await f.workflow.cleanup();
});

test('unknown mutation retains its request ID as unknown, typed rejection as failed, and neither permits retry or reconciliation writes', async () => {
  const f = injectedRuntime({ failCommand: 'capture.start' }); await through(f, 'fixture-ready');
  await assert.rejects(f.workflow.advance('fixture-record-start'), { code: 'injected_transport_unknown' });
  const pending = f.workflow.state().requests.find(value => value.command === 'capture.start');
  assert.equal(pending.state, 'unknown'); assert.ok(pending.requestId);
  await assert.rejects(f.workflow.advance('fixture-record-start'), { code: 'replay_stage_out_of_order' });
  const before = f.calls.length, reconciled = await f.workflow.reconcile();
  assert.deepEqual(f.calls.slice(before).map(call => [call.name, call.requestId]), [['jobs.list', undefined], ['capture.status', undefined],
    ['jobs.list', undefined], ['capture.status', undefined]]);
  assert.deepEqual(reconciled.map(value => value.label), ['editor', 'recorder']);
  assert.equal(f.calls.filter(call => call.name === 'capture.start').length, 1); await f.workflow.cleanup();
  const rejected = injectedRuntime({ failCommand: 'capture.start', failOutcome: 'failed' }); await through(rejected, 'fixture-ready');
  await assert.rejects(rejected.workflow.advance('fixture-record-start'));
  assert.equal(rejected.workflow.state().requests.at(-1).state, 'failed'); await rejected.workflow.cleanup();
});

test('existing export destination is preserved without dispatching export', async () => {
  const f = injectedRuntime({ outputExists: true }); await through(f, 'trace-editor-controls');
  await assert.rejects(f.workflow.advance('export-fixture'), { code: 'output_exists' });
  assert.equal(f.calls.some(call => call.name === 'export.start'), false); await f.workflow.cleanup();
});

test('cleanup is idempotent, recognizes signal termination, and requires exact OS birth exit, durable grant revocation and fixture exit', async () => {
  for (const options of [{ signalExit: true }, { revokeFails: true }, { exactExitFails: true }, { closeFails: true }, { fixtureExitFails: true }]) {
    const f = injectedRuntime(options); await through(f, 'provision');
    const a = f.workflow.cleanup(), b = f.workflow.cleanup(); assert.equal(a, b);
    const result = await a; assert.equal(result.confirmed, !!options.signalExit);
    assert.equal(f.events.filter(value => value.startsWith('stop:')).length, 2);
    assert.equal(f.events.filter(value => value.startsWith('revoke:')).length, 2);
    assert.equal(f.events.filter(value => value === 'close-fixture').length, 1);
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
