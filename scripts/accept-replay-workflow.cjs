#!/usr/bin/env node
'use strict';

// Preparation module only. Import and CLI planning perform no app/native/media work.
// The adapter is deliberately injected: no arbitrary RPC, renderer JS or live replay.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fail(code); };
const freeze = value => { for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item); return Object.freeze(value); };
const PIN = Object.freeze({ replayCommit: '221502e8c0af25fb1929ff8f200c4774659b7b87',
  executableSha256: '22f35d67d22e00f156b57089e27031b1b033d888fdfd6223183c346f4fc167ec',
  asarSha256: 'd74797f6a2b4cd9d9dbce1ecaff7dc655b0869b3455ac4da604e85403c36b7cc' });
const STAGES = Object.freeze(['provision', 'fixture-ready', 'fixture-record-start', 'fixture-record-stop',
  'walkthrough-record-start', 'edit-fixture', 'trace-editor-controls', 'export-fixture',
  'prepare-completed-playback', 'trace-completed-playback', 'walkthrough-record-stop',
  'export-walkthrough', 'verify-media', 'root-review', 'cleanup']);
const RECIPE = freeze({ sourceStart: 1, sourceEnd: 7, duration: 6, effectStart: 1, effectEnd: 3,
  narrationStart: 1.5, narrationDuration: 1, samples: [0.5, 2, 4],
  callout: { id: 'trace-callout', type: 'text', text: 'TRACE verified synthetic fixture', x: 0.1, y: 0.05, width: 0.6, height: 0.13, start: 1, end: 3 },
  privacy: { id: 'trace-privacy', type: 'blur', x: 0.34, y: 0.25, width: 0.32, height: 0.4, start: 1, end: 3 } });
function plan() {
  return { schemaVersion: 1, caseId: 'A4-REPLAY', requirement: 'APP-01', status: 'preparation_only',
    claimsAttempt: false, package: { ...PIN }, recipe: structuredClone(RECIPE), stages: [...STAGES],
    scope: 'Two isolated packaged REPLAY instances, owned fixture capture, trim/callout/blur/offline WAV placement, separate actual TRACE editor controls, two exports and independent media/cleanup proof.',
    pauses: { 'fixture-ready': 'Root prepares and pins the synthetic fixture HWND/PID/birth/session and stable texture in the declared privacy region; no real data.',
      'fixture-record-stop': 'Root performs the declared fixture demonstration through actual connected TRACE, with at least 8 seconds of recording.',
      'trace-editor-controls': 'While second instance records the exact first editor, root uses actual connected TRACE controls and inspects fresh PNG/accessibility state. Supply correlated native receipts and independent saved state.',
      'trace-completed-playback': 'Root uses actual TRACE controls to play the imported completed fixture-demo.mp4 in the first editor; independent preview clock must advance.',
      'root-review': 'Root inspects actual decoded before/during/after frames, both videos and measured audio. Signal measurements do not prove semantic listening.' },
    outputs: ['fixture-demo.mp4', 'editor-walkthrough.mp4'],
    boundaries: ['No paid provider requests; offline one-second PCM WAV only.', 'API edits are not TRACE native-control evidence.',
      'No Playwright UI clicks, DOM-driven edits or arbitrary renderer/main-process evaluation.',
      'Provision only through existing smoke flags/preload grant APIs; inspect native identities read-only.',
      'Retain app handle before readiness, require exitCode OR signalCode plus exact OS birth exit, revoke grants and close transports.',
      'No automatic retry after mutation uncertainty; preserve request IDs and terminal evidence.'],
    remaining: ['Production runtime adapter and durable manual command-loop wiring are not implemented in this bounded module.',
      'Root must bind actual TRACE receipts and independently decoded media; injected tests establish orchestration only.',
      'No live execution or complete APP-01 claim is provided by this preparation.'] };
}
function inside(root, filename) {
  if (typeof root !== 'string' || typeof filename !== 'string') return false;
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function identity(value) {
  need(Number.isInteger(value?.pid) && value.pid > 0 && typeof value.processCreationTime === 'string'
    && /^\d+$/.test(value.processCreationTime) && Number.isInteger(value.sessionId) && value.sessionId >= 0,
  'replay_identity_unverified');
  return value;
}
function sameIdentity(a, b) {
  return ['pid', 'processCreationTime', 'sessionId'].every(key => a?.[key] === b?.[key])
    && String(a?.windowId ?? a?.hwnd) === String(b?.windowId ?? b?.hwnd);
}
function exactWindowSource(sources, target) {
  identity(target); need(/^\d+$/.test(String(target.windowId)), 'replay_window_unverified');
  const selected = (sources.sources ?? sources).filter(source => typeof source.id === 'string'
    && source.id.startsWith('window:') && source.id.split(':')[1] === String(target.windowId));
  need(selected.length === 1, 'replay_capture_target_ambiguous'); return selected[0].id;
}
function project(value) {
  need(typeof value?.id === 'string' && Number.isSafeInteger(value.revision) && value.revision > 0, 'replay_project_unverified');
  return value;
}
function editOperations(assetId, clipId) {
  return [{ type: 'trim', sourceStart: RECIPE.sourceStart, sourceEnd: RECIPE.sourceEnd },
    { type: 'frame', padding: 0, radius: 0 },
    { type: 'overlay.put', overlay: { ...RECIPE.privacy } }, { type: 'overlay.put', overlay: { ...RECIPE.callout } },
    { type: 'narration.put', clip: { id: clipId, assetId, start: RECIPE.narrationStart, gain: 1, muted: false } },
    { type: 'audio.mix', sourceGain: 1, sourceMuted: true }];
}
function packetDuration(formatDuration, rows) {
  const container = Number(formatDuration);
  if (Number.isFinite(container) && container > 0) return { seconds: container, source: 'container' };
  let end = 0;
  for (const row of rows) {
    const [pts, span] = row.split(',').map(Number);
    if (Number.isFinite(pts)) end = Math.max(end, pts + (Number.isFinite(span) && span > 0 ? span : 1 / 30));
  }
  need(end > 0, 'replay_duration_unverified'); return { seconds: end, source: 'independent_packet_timestamps' };
}
function meanDifference(a, b) {
  need(a?.length > 0 && a.length === b?.length, 'replay_decode_invalid');
  return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
}
function gradientEnergy(rgb, width, height) {
  need(Number.isInteger(width) && Number.isInteger(height) && width > 2 && height > 2 && rgb?.length === width * height * 3, 'replay_decode_invalid');
  const y = offset => rgb[offset] * 0.2126 + rgb[offset + 1] * 0.7152 + rgb[offset + 2] * 0.0722;
  let energy = 0, count = 0;
  for (let row = 1; row < height - 1; row++) for (let col = 1; col < width - 1; col++) {
    const offset = (row * width + col) * 3;
    energy += (y(offset + 3) - y(offset)) ** 2 + (y(offset + width * 3) - y(offset)) ** 2; count += 2;
  }
  return energy / count;
}
function validateMeasurements(value, kind) {
  need(/^[a-f0-9]{64}$/.test(value?.sha256 ?? '') && value.bytes > 0 && value.width >= 400 && value.height >= 300
    && value.videoStreams === 1 && value.decodedFrames >= 3 && value.nonblackMean > 5, 'replay_media_unverified');
  if (kind === 'fixture') {
    need(Math.abs(value.duration - RECIPE.duration) <= 0.15 && value.audioStreams === 1, 'replay_trim_or_audio_unverified');
    need(value.sourceHashUnchanged === true && value.effectSampleTimes?.join(',') === RECIPE.samples.join(',')
      && value.calloutDifference > 8 && value.privacySourceEnergy > 5
      && value.privacyOutputEnergy < value.privacySourceEnergy * 0.8
      && value.beforeEffectDifference < 8 && value.afterEffectDifference < 8, 'replay_effect_timing_unverified');
    need(value.audioBeforeRms < 0.005 && value.audioDuringRms > 0.01 && value.audioAfterRms < 0.005,
      'replay_narration_placement_unverified');
  } else {
    need(value.duration >= 2 && value.decodedFrameDifference > 0.05 && Number.isInteger(value.audioStreams)
      && value.audioStreams >= 0 && value.audioStreams <= 1, 'replay_walkthrough_unverified');
  }
  return true;
}

// All effectful dependencies are supplied by the root's reviewed runtime. Nothing
// in this class accepts a command name, script, tool name or function from content.
function createWorkflow(deps, locations) {
  need(typeof locations?.privateRoot === 'string', 'replay_private_root_required');
  const owned = [], requests = [], completed = [], values = {};
  let next = 0, failed = false, active = false, cleanupPromise;
  const command = async (app, name, input = {}, revision, mutation = false) => {
    const requestId = mutation ? `trace-replay-${randomUUID()}` : undefined;
    if (requestId) requests.push({ command: name, requestId, state: 'pending' });
    // Allocate the request identity before dispatch. A throw never permits replay.
    const result = await deps.command(app.client, name, input, revision, requestId);
    if (requestId) requests.at(-1).state = 'completed'; return result;
  };
  const refresh = async (app, current) => project(await command(app, 'project.get', { id: current.id }));
  const stopCapture = async (app, key) => {
    const stopped = project(await command(app, 'capture.stop', { recordingId: values[key].recordingId }, undefined, true));
    need(inside(app.info.libraryPath, stopped.sourcePath), 'replay_capture_outside_library');
    need(stopped.duration >= 8 || key === 'walkthroughCapture' && stopped.duration >= 2, 'replay_capture_too_short');
    values[key].stopped = true; return stopped;
  };
  const startCapture = async (app, target, key, name) => {
    need(sameIdentity(await deps.windowIdentity(target), target), 'replay_capture_identity_changed');
    const sourceId = exactWindowSource(await command(app, 'capture.sources'), target);
    const result = await command(app, 'capture.start', { sourceId, name }, undefined, true);
    need(result.state === 'recording' && typeof result.recordingId === 'string' && result.sourceId === sourceId, 'replay_capture_not_started');
    values[key] = { recordingId: result.recordingId, sourceId, stopped: false };
  };
  const exportProject = async (app, current, basename) => {
    current = await refresh(app, current);
    const output = path.join(app.exportRoot, basename); need(inside(app.exportRoot, output), 'replay_export_outside_grant');
    await deps.requireMissing(output);
    const started = await command(app, 'export.start', { projectId: current.id, options: { resolution: 'original', quality: 'high' }, output }, current.revision, true);
    const finished = await deps.waitJob(app.client, started.id);
    need(finished.state === 'completed' && finished.output?.path === output && finished.revision === current.revision, 'replay_export_unverified');
    return { project: current, job: finished, output };
  };
  const cleanup = () => cleanupPromise ??= (async () => {
    const outcomes = [];
    for (const app of [...owned].reverse()) {
      const outcome = { label: app.label, transportClosed: !app.client, grantRevoked: !app.grantId, processExited: false };
      try { if (app.client) { await deps.closeTransport(app.client); outcome.transportClosed = true; } } catch {}
      try { if (app.grantId) { await deps.revokeGrant(app); outcome.grantRevoked = await deps.grantRevoked(app); } } catch {}
      try {
        await deps.stopApp(app.handle, app.page);
        const child = app.handle.process();
        outcome.processExited = (child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined)
          && !!app.identity && await deps.waitIdentityExit(app.identity) === true;
      } catch {}
      outcomes.push(outcome);
    }
    const confirmed = outcomes.length === owned.length && outcomes.every(outcome => outcome.transportClosed && outcome.grantRevoked && outcome.processExited);
    values.cleanup = { confirmed, instances: outcomes }; return values.cleanup;
  })();
  const stages = {
    async provision() {
      const pins = await deps.verifyPins();
      need(Object.keys(PIN).every(key => pins[key] === PIN[key]), 'replay_source_changed');
      const prepared = await deps.prepareOfflineAssets();
      need(prepared.wavDuration === 1 && prepared.paidRequests === 0 && inside(locations.privateRoot, prepared.bootstrapVideo), 'replay_offline_assets_invalid');
      values.prepared = prepared;
      for (const label of ['editor', 'recorder']) {
        const root = path.join(locations.privateRoot, label);
        const handle = await deps.launchApp({ label, args: [`--smoke-test=${prepared.bootstrapVideo}`, `--smoke-output=${root}`] });
        const app = { label, handle }; owned.push(app); // Retain before ANY readiness or identity query.
        app.identity = identity(await deps.processIdentity(handle.process().pid));
        const ready = await deps.readyApp(handle); app.page = ready.page; app.info = ready.info;
        need(inside(root, app.info.libraryPath), 'replay_library_not_isolated');
        const window = identity(await deps.editorWindowIdentity(handle));
        need(['pid', 'processCreationTime', 'sessionId'].every(key => window[key] === app.identity[key]), 'replay_identity_changed');
        app.identity = { ...app.identity, ...window };
        const grant = await deps.createGrant(app.page, `TRACE ${label} workflow`); app.grantId = grant.grant.id;
        app.importRoot = grant.grant.importRoots[0]; app.exportRoot = grant.grant.exportRoots[0];
        need(inside(root, app.importRoot) && inside(root, app.exportRoot), 'replay_grants_not_isolated');
        app.client = await deps.connectMcp(grant.setup.mcp.mcpServers.replay);
        need((await command(app, 'app.capabilities')).projectSchemaVersion === 3, 'replay_schema_unsupported');
      }
      need(owned[0].identity.pid !== owned[1].identity.pid && owned[0].identity.windowId !== owned[1].identity.windowId
        && owned[0].info.libraryPath !== owned[1].info.libraryPath, 'replay_instances_not_distinct');
    },
    async 'fixture-ready'(input) {
      values.fixture = identity(await deps.validateOwnedFixture(input));
      need(/^\d+$/.test(String(values.fixture.windowId)) && values.fixture.synthetic === true && values.fixture.privacyTextureVerified === true,
        'replay_fixture_not_ready');
    },
    'fixture-record-start': () => startCapture(owned[0], values.fixture, 'fixtureCapture', 'TRACE owned fixture demonstration'),
    async 'fixture-record-stop'(input) {
      need(await deps.verifyTraceEvidence('fixture-demonstration', input, values.fixture) === true, 'replay_trace_evidence_missing');
      values.fixtureProject = await stopCapture(owned[0], 'fixtureCapture');
    },
    'walkthrough-record-start': () => startCapture(owned[1], owned[0].identity, 'walkthroughCapture', 'TRACE editor walkthrough'),
    async 'edit-fixture'() {
      const app = owned[0], current = await refresh(app, values.fixtureProject);
      need(current.duration >= 8, 'replay_capture_too_short');
      const audio = await deps.copyOfflineWav(values.prepared, app.importRoot); need(inside(app.importRoot, audio), 'replay_audio_outside_grant');
      const imported = await command(app, 'narration.import', { projectId: current.id, path: audio, text: 'Synthetic acceptance tone; no speech.' }, current.revision, true);
      need(Math.abs(imported.asset.duration - 1) < 0.03, 'replay_audio_duration_invalid');
      // Import may advance revision; always fetch the authoritative revision again.
      const fresh = await refresh(app, current);
      values.fixtureProject = project(await command(app, 'project.edit', { projectId: fresh.id,
        operations: editOperations(imported.asset.assetId, randomUUID()) }, fresh.revision, true));
      await command(app, 'preview.open', { projectId: fresh.id, position: 2 }, values.fixtureProject.revision, true);
    },
    async 'trace-editor-controls'(input) {
      need(await deps.verifyTraceEvidence('editor-controls', input, owned[0].identity) === true, 'replay_trace_evidence_missing');
      values.fixtureProject = await refresh(owned[0], values.fixtureProject);
      need(await deps.verifySavedRecipe(values.fixtureProject, RECIPE) === true, 'replay_saved_recipe_mismatch');
    },
    async 'export-fixture'() { values.fixtureExport = await exportProject(owned[0], values.fixtureProject, 'fixture-demo.mp4'); },
    async 'prepare-completed-playback'() {
      const app = owned[0], imported = await deps.copyCompletedExport(values.fixtureExport.output, app.importRoot);
      need(inside(app.importRoot, imported), 'replay_playback_outside_grant');
      values.playbackProject = project(await command(app, 'project.import', { path: imported, name: 'Completed fixture-demo.mp4 playback' }, undefined, true));
      await command(app, 'preview.open', { projectId: values.playbackProject.id, position: 0 }, values.playbackProject.revision, true);
      values.playbackBefore = await command(app, 'preview.get');
    },
    async 'trace-completed-playback'(input) {
      need(await deps.verifyTraceEvidence('completed-file-playback', input, owned[0].identity) === true, 'replay_trace_evidence_missing');
      const after = await command(owned[0], 'preview.get');
      need(after.projectId === values.playbackProject.id && after.position > values.playbackBefore.position + 0.2,
        'replay_completed_playback_unverified');
    },
    async 'walkthrough-record-stop'() { values.walkthroughProject = await stopCapture(owned[1], 'walkthroughCapture'); },
    async 'export-walkthrough'() { values.walkthroughExport = await exportProject(owned[1], values.walkthroughProject, 'editor-walkthrough.mp4'); },
    async 'verify-media'() {
      values.measurements = {};
      for (const kind of ['fixture', 'walkthrough']) {
        const measured = await deps.independentMediaVerification(kind, values[`${kind}Export`], RECIPE);
        validateMeasurements(measured, kind); values.measurements[kind] = measured;
      }
    },
    async 'root-review'(input) {
      need(await deps.verifyRootReview(input, values.measurements) === true, 'replay_root_review_missing');
      values.reviewed = true;
    },
    cleanup,
  };
  return { plan, cleanup,
    state: () => ({ status: failed ? 'blocked' : values.cleanup?.confirmed && values.reviewed ? 'awaiting_runtime_evidence_audit' : 'prepared_or_running',
      next: STAGES[next] ?? null, completed: [...completed], requests: structuredClone(requests), cleanup: values.cleanup,
      limits: plan().remaining }),
    async advance(stage, input) {
      need(!failed && !active && STAGES[next] === stage, 'replay_stage_out_of_order'); active = true;
      try { await stages[stage](input); completed.push(stage); next++; return this.state(); }
      catch (error) { failed = true; throw error; }
      finally { active = false; }
    },
  };
}
if (require.main === module) {
  if (process.argv.length === 2 || process.argv.slice(2).join(' ') === '--plan') process.stdout.write(JSON.stringify(plan(), null, 2) + '\n');
  else { process.stderr.write('replay_production_stage_adapter_not_implemented\n'); process.exitCode = 1; }
}
module.exports = { PIN, STAGES, RECIPE, plan, inside, identity, sameIdentity, exactWindowSource, editOperations,
  packetDuration, meanDifference, gradientEnergy, validateMeasurements, createWorkflow };
