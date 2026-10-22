#!/usr/bin/env node
'use strict';

// Orchestration module. Import and CLI planning perform no app/native/media work; the
// production runtime (scripts/replay-workflow-runtime.cjs) loads only for --live/--advance.
// The adapter is deliberately injected: no arbitrary RPC, renderer JS or live replay.
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fail(code); };
const freeze = value => { for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item); return Object.freeze(value); };
const PIN = Object.freeze({ replayCommit: '221502e8c0af25fb1929ff8f200c4774659b7b87',
  executableSha256: '22f35d67d22e00f156b57089e27031b1b033d888fdfd6223183c346f4fc167ec',
  asarSha256: 'd74797f6a2b4cd9d9dbce1ecaff7dc655b0869b3455ac4da604e85403c36b7cc' });
const STAGES = Object.freeze(['provision', 'fixture-ready', 'fixture-record-start', 'fixture-record-stop',
  'prepare-source-review', 'confirm-source-review',
  'walkthrough-record-start', 'edit-fixture', 'trace-editor-controls', 'export-fixture',
  'prepare-completed-playback', 'trace-completed-playback', 'walkthrough-record-stop',
  'export-walkthrough', 'verify-media', 'root-review', 'cleanup']);
const RECIPE = freeze({ duration: 6, sourceSelection: 'root-reviewed-six-second-captured-segment-before-edits', effectStart: 1, effectEnd: 3,
  narrationStart: 1.5, narrationDuration: 1, samples: [0.5, 2, 4],
  callout: { id: 'trace-callout', type: 'text', text: 'TRACE verified synthetic fixture', x: 0.1, y: 0.05, width: 0.6, height: 0.13, start: 1, end: 3 },
  privacy: { id: 'trace-privacy', type: 'blur', x: 0.34, y: 0.25, width: 0.32, height: 0.4, start: 1, end: 3 } });
// Declared before execution: what root does through actual connected TRACE and what independent state must show.
const DEMONSTRATION = freeze({ text: 'TRACE REPLAY demo', increments: 2, fixtureActions: 3, editorActions: 2, playbackActions: 1,
  editorPosition: 2, editorMinimumAdvance: 0.2, playbackMinimumAdvance: 0.2, textureMinimum: 5 });
const EVIDENCE_INPUTS = freeze({
  'fixture-ready': '{ traceSessionId, observationId }: a TRACE session opened on the run-owned fixture after launch and a fresh observation of it.',
  'fixture-record-stop': '{ traceSessionId }: at least 3 completed TRACE actions on the fixture after recording starts.',
  'prepare-source-review': '{ sourceStart }: explicit nonnegative source-media seconds; root selects a six-second interval containing a useful action and the completed synthetic result.',
  'confirm-source-review': '{ pass:true, reviewedEntireSegment:true, sourceSha256, sourceStart, sourceEnd, segmentSha256, reviewedFrames:[{sha256,observed}], observedAction:{from,to,description}, observedResult:{frameSha256,text,count} }: review the entire retained segment and all frames; action offsets are segment seconds, result must show the exact expected text and Count:2.',
  'trace-editor-controls': '{ traceSessionId }: at least 2 completed TRACE actions on the first editor after its preview opens at position 2.',
  'trace-completed-playback': '{ traceSessionId }: at least 1 completed TRACE action on the first editor after the completed export opens.',
  'root-review': '{ pass: true, reviewedFrames: [{ sha256, observed }] }: one entry per produced review frame.' });
function plan() {
  return { schemaVersion: 1, caseId: 'A4-REPLAY', requirement: 'APP-01', status: 'adapter_ready_not_run',
    claimsAttempt: false, package: { ...PIN }, recipe: structuredClone(RECIPE), demonstration: structuredClone(DEMONSTRATION),
    stages: [...STAGES], evidenceInputs: structuredClone(EVIDENCE_INPUTS),
    scope: 'Two isolated packaged REPLAY instances, owned fixture capture, trim/callout/blur/offline WAV placement, separate actual TRACE editor controls, two exports and independent media/cleanup proof.',
    pauses: { 'fixture-ready': 'The adapter launches the prepared synthetic fixture during provision. Root opens a TRACE session on that exact window and observes it; the adapter measures texture in the declared privacy region from that observation.',
      'fixture-record-stop': `Root types "${DEMONSTRATION.text}" and increments twice through actual connected TRACE. Retain recording around the final increment, including at least six seconds afterward, so a reviewed six-second segment can show a useful action and its completed result. Minimum total recording is eight seconds.`,
      'prepare-source-review': 'Inspect the retained captured source to select sourceStart. The runtime renders that six-second source interval and hashes source, review segment and decoded frames. No wall-clock mapping is inferred from a late command response.',
      'confirm-source-review': 'Root reviews the entire actual retained segment and every source frame before any edit/export. Bind an observed useful action and the exact synthetic text/Count:2 result to that interval and its hashes. Final fixture state alone cannot pass.',
      'trace-editor-controls': 'While the second instance records the exact first editor, root uses actual connected TRACE to start and then pause its preview. The preview must end paused past position 2.2 with the saved recipe unchanged.',
      'trace-completed-playback': 'Root uses actual TRACE controls to play the imported completed fixture-demo.mp4 in the first editor; independent preview clock must advance.',
      'root-review': 'Root inspects actual decoded before/during/after frames, both videos and measured audio. Signal measurements do not prove semantic listening.' },
    outputs: ['fixture-demo.mp4', 'editor-walkthrough.mp4'],
    boundaries: ['No paid provider requests; offline one-second PCM WAV only.', 'API edits are not TRACE native-control evidence.',
      'No Playwright UI clicks, DOM-driven edits or arbitrary renderer/main-process evaluation.',
      'Provision only through existing smoke flags/preload grant APIs; inspect native identities read-only.',
      'Retain app handle before readiness, require exitCode OR signalCode plus exact OS birth exit, revoke grants and close transports.',
      'No automatic retry after mutation uncertainty; preserve request IDs and terminal evidence.'],
    remaining: ['Live execution needs an explicit owner go-ahead and a fresh directory; preparing the adapter ran nothing live.',
      'TRACE evidence is bound to the local TRACE journal, fixture state and REPLAY state; it cannot prove semantic intent.',
      'No complete APP-01 claim until a live run, root visual review, confirmed cleanup and Codex review.'] };
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
function selectedRecipe(sourceStart) {
  need(typeof sourceStart === 'number' && Number.isFinite(sourceStart) && sourceStart >= 0, 'replay_source_window_invalid');
  return { ...structuredClone(RECIPE), sourceStart, sourceEnd: sourceStart + RECIPE.duration };
}
function editOperations(assetId, clipId, recipe) {
  need(recipe && recipe.sourceEnd - recipe.sourceStart === RECIPE.duration, 'replay_source_window_unreviewed');
  return [{ type: 'trim', sourceStart: recipe.sourceStart, sourceEnd: recipe.sourceEnd },
    { type: 'frame', padding: 0, radius: 0 },
    { type: 'overlay.put', overlay: { ...RECIPE.privacy } }, { type: 'overlay.put', overlay: { ...RECIPE.callout } },
    { type: 'narration.put', clip: { id: clipId, assetId, start: RECIPE.narrationStart, gain: 1, muted: false } },
    { type: 'audio.mix', sourceGain: 1, sourceMuted: true }];
}
// The saved project must hold exactly the declared recipe. Overlays are stored in source time.
function recipeMatches(value, assetId, recipe) {
  if (!recipe || recipe.sourceEnd - recipe.sourceStart !== RECIPE.duration) return false;
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;
  const overlay = expected => {
    const found = (value?.overlays ?? []).filter(item => item?.id === expected.id);
    return found.length === 1 && Object.entries(expected).every(([key, wanted]) => ['start', 'end'].includes(key)
      ? near(found[0][key], wanted + recipe.sourceStart) : typeof wanted === 'number' ? near(found[0][key], wanted) : found[0][key] === wanted);
  };
  const clips = value?.narration?.clips;
  return near(value?.trimStart, recipe.sourceStart) && near(value?.trimEnd, recipe.sourceEnd) && value.padding === 0 && value.radius === 0
    && value.overlays?.length === 2 && overlay(RECIPE.privacy) && overlay(RECIPE.callout)
    && Array.isArray(clips) && clips.length === 1 && clips[0].assetId === assetId && near(clips[0].start, RECIPE.narrationStart)
    && clips[0].gain === 1 && clips[0].muted === false && value.narration.sourceMuted === true && near(value.narration.sourceGain, 1);
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function matchingRequestReceipt(entry, receipt) {
  if (receipt?.schemaVersion !== 1 || receipt.requestId !== entry.requestId || receipt.command !== entry.command) return false;
  const payload = canonical(entry.payload);
  return JSON.stringify(canonical(receipt.payload)) === JSON.stringify(payload)
    && receipt.fingerprint === createHash('sha256').update(JSON.stringify({ command: entry.command, payload })).digest('hex')
    && (receipt.state !== 'completed' || Object.hasOwn(receipt, 'result'));
}
// All effectful dependencies are supplied by the root's reviewed runtime. Nothing
// in this class accepts a command name, script, tool name or function from content.
function createWorkflow(deps, locations) {
  need(typeof locations?.privateRoot === 'string', 'replay_private_root_required');
  const owned = [], requests = [], completed = [], values = {};
  let next = 0, failed = false, active = false, cleanupPromise, fixture;
  const now = () => deps.now?.() ?? new Date().toISOString();
  const checkpoint = async () => deps.checkpoint?.();
  const command = async (app, name, input = {}, revision, mutation = false) => {
    const entry = mutation ? { app: app.label, command: name, requestId: `trace-replay-${randomUUID()}`, state: 'pending',
      payload: { input: structuredClone(input), ...(revision === undefined ? {} : { expectedRevision: revision }) }, createdAt: now() } : undefined;
    if (entry) {
      requests.push(entry);
      // Persist the request identity before dispatch. A failed checkpoint means nothing was sent.
      try { await deps.checkpoint?.(); } catch (error) { entry.state = 'not_dispatched'; throw error; }
    }
    try {
      const result = await deps.command(app.client, name, input, revision, entry?.requestId);
      if (entry) { entry.state = 'completed'; entry.result = structuredClone(result); } return result;
    } catch (error) {
      // A typed REPLAY rejection is durable; anything else is unknown. Neither permits replay.
      if (entry) entry.state = error.replayOutcome === 'failed' ? 'failed' : 'unknown';
      throw error;
    } finally { if (entry) await checkpoint(); }
  };
  const refresh = async (app, current) => project(await command(app, 'project.get', { id: current.id }));
  const stopCapture = async (app, key) => {
    const stopped = project(await command(app, 'capture.stop', { recordingId: values[key].recordingId }, undefined, true));
    need(inside(app.info.libraryPath, stopped.sourcePath), 'replay_capture_outside_library');
    need(stopped.duration >= 8 || key === 'walkthroughCapture' && stopped.duration >= 2, 'replay_capture_too_short');
    values[key].stopped = true; values[key].sourcePath = stopped.sourcePath;
    values[key].sourceSha256 = await deps.sourceDigest(stopped.sourcePath); return stopped;
  };
  const startCapture = async (app, target, key, name) => {
    need(sameIdentity(await deps.windowIdentity(target), target), 'replay_capture_identity_changed');
    const sourceId = exactWindowSource(await command(app, 'capture.sources'), target);
    const result = await command(app, 'capture.start', { sourceId, name }, undefined, true);
    need(result.state === 'recording' && typeof result.recordingId === 'string' && result.sourceId === sourceId, 'replay_capture_not_started');
    values[key] = { recordingId: result.recordingId, sourceId, stopped: false, startedAt: now() };
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
  const traceEvidence = async (kind, input, target, since) =>
    need(await deps.verifyTraceEvidence(kind, input, target, { since, openedAfter: values.launchStartedAt }) === true, 'replay_trace_evidence_missing');
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
    if (fixture) {
      const outcome = { label: 'fixture', transportClosed: true, grantRevoked: true, processExited: false };
      try { outcome.processExited = await deps.closeFixture(fixture.handle) === true && !!fixture.identity && await deps.waitIdentityExit(fixture.identity) === true; } catch {}
      outcomes.push(outcome);
    }
    const confirmed = outcomes.length === owned.length + (fixture ? 1 : 0)
      && outcomes.every(outcome => outcome.transportClosed && outcome.grantRevoked && outcome.processExited);
    values.cleanup = { confirmed, instances: outcomes }; return values.cleanup;
  })();
  const stages = {
    async provision() {
      const pins = await deps.verifyPins();
      need(Object.keys(PIN).every(key => pins[key] === PIN[key]), 'replay_source_changed');
      const prepared = await deps.prepareOfflineAssets();
      need(prepared.wavDuration === 1 && prepared.paidRequests === 0 && inside(locations.privateRoot, prepared.bootstrapVideo), 'replay_offline_assets_invalid');
      values.prepared = prepared; values.launchStartedAt = now();
      for (const label of ['editor', 'recorder']) {
        const root = path.join(locations.privateRoot, label);
        const handle = await deps.launchApp({ label, args: [`--smoke-test=${prepared.bootstrapVideo}`, `--smoke-output=${root}`] });
        const app = { label, handle, root, launchedPid: handle.process().pid }; owned.push(app); // Retain before ANY readiness or identity query.
        await checkpoint();
        app.identity = identity(await deps.processIdentity(handle.process().pid));
        await checkpoint();
        const ready = await deps.readyApp(handle); app.page = ready.page; app.info = ready.info;
        await checkpoint();
        need(inside(root, app.info.libraryPath), 'replay_library_not_isolated');
        const window = identity(await deps.editorWindowIdentity(handle));
        need(['pid', 'processCreationTime', 'sessionId'].every(key => window[key] === app.identity[key]), 'replay_identity_changed');
        app.identity = { ...app.identity, ...window };
        await checkpoint();
        const grant = await deps.createGrant(app.page, `TRACE ${label} workflow`); app.grantId = grant.grant.id;
        app.importRoot = grant.grant.importRoots[0]; app.exportRoot = grant.grant.exportRoots[0];
        await checkpoint();
        need(inside(root, app.importRoot) && inside(root, app.exportRoot), 'replay_grants_not_isolated');
        app.client = await deps.connectMcp(grant.setup.mcp.mcpServers.replay);
        need((await command(app, 'app.capabilities')).projectSchemaVersion === 3, 'replay_schema_unsupported');
      }
      need(owned[0].identity.pid !== owned[1].identity.pid && owned[0].identity.windowId !== owned[1].identity.windowId
        && owned[0].info.libraryPath !== owned[1].info.libraryPath, 'replay_instances_not_distinct');
      fixture = { handle: await deps.launchFixture() }; // Retained before its identity is read.
      await checkpoint();
      fixture.identity = identity(await deps.fixtureIdentity(fixture.handle));
      await checkpoint();
      need(/^\d+$/.test(String(fixture.identity.windowId)) && owned.every(app => app.identity.pid !== fixture.identity.pid), 'replay_fixture_not_ready');
    },
    async 'fixture-ready'(input) {
      need(fixture?.identity, 'replay_fixture_not_ready');
      values.fixture = identity(await deps.validateOwnedFixture(input, fixture.identity, { openedAfter: values.launchStartedAt }));
      need(sameIdentity(values.fixture, fixture.identity) && values.fixture.synthetic === true && values.fixture.privacyTextureVerified === true,
        'replay_fixture_not_ready');
    },
    'fixture-record-start': () => startCapture(owned[0], values.fixture, 'fixtureCapture', 'TRACE owned fixture demonstration'),
    async 'fixture-record-stop'(input) {
      await traceEvidence('fixture-demonstration', input, values.fixture, values.fixtureCapture.startedAt);
      values.fixtureProject = await stopCapture(owned[0], 'fixtureCapture');
    },
    async 'prepare-source-review'(input) {
      const recipe = selectedRecipe(input?.sourceStart);
      need(recipe.sourceEnd <= values.fixtureProject.duration, 'replay_source_window_outside_capture');
      values.sourceReview = await deps.prepareSourceReview(values.fixtureCapture, recipe);
      need(values.sourceReview.sourceSha256 === values.fixtureCapture.sourceSha256
        && values.sourceReview.sourceStart === recipe.sourceStart && values.sourceReview.sourceEnd === recipe.sourceEnd,
      'replay_source_review_mismatch');
      values.selectedRecipe = recipe;
    },
    async 'confirm-source-review'(input) {
      need(await deps.verifySourceReview(input, values.sourceReview, values.fixtureCapture) === true, 'replay_source_content_unverified');
      values.sourceContentReview = structuredClone(input); values.sourceContentVerified = true;
    },
    'walkthrough-record-start': () => startCapture(owned[1], owned[0].identity, 'walkthroughCapture', 'TRACE editor walkthrough'),
    async 'edit-fixture'() {
      need(values.sourceContentVerified === true, 'replay_source_window_unreviewed');
      need(await deps.sourceDigest(values.fixtureCapture.sourcePath) === values.sourceReview.sourceSha256, 'replay_source_changed');
      const app = owned[0], current = await refresh(app, values.fixtureProject);
      need(current.duration >= 8, 'replay_capture_too_short');
      const audio = await deps.copyOfflineWav(values.prepared, app.importRoot); need(inside(app.importRoot, audio), 'replay_audio_outside_grant');
      const imported = await command(app, 'narration.import', { projectId: current.id, path: audio, text: 'Synthetic acceptance tone; no speech.' }, current.revision, true);
      need(Math.abs(imported.asset.duration - 1) < 0.03, 'replay_audio_duration_invalid');
      values.narrationAssetId = imported.asset.assetId;
      // Import may advance revision; always fetch the authoritative revision again.
      const fresh = await refresh(app, current);
      values.fixtureProject = project(await command(app, 'project.edit', { projectId: fresh.id,
        operations: editOperations(imported.asset.assetId, randomUUID(), values.selectedRecipe) }, fresh.revision, true));
      await command(app, 'preview.open', { projectId: fresh.id, position: DEMONSTRATION.editorPosition }, values.fixtureProject.revision, true);
      values.editorPreviewOpenedAt = now();
    },
    async 'trace-editor-controls'(input) {
      await traceEvidence('editor-controls', input, owned[0].identity, values.editorPreviewOpenedAt);
      const preview = await command(owned[0], 'preview.get');
      need(preview.projectId === values.fixtureProject.id && preview.playing === false
        && preview.position >= DEMONSTRATION.editorPosition + DEMONSTRATION.editorMinimumAdvance, 'replay_editor_controls_unverified');
      values.fixtureProject = await refresh(owned[0], values.fixtureProject);
      need(await deps.verifySavedRecipe(values.fixtureProject, values.selectedRecipe, values.narrationAssetId) === true, 'replay_saved_recipe_mismatch');
    },
    async 'export-fixture'() {
      need(values.sourceContentVerified === true && await deps.sourceDigest(values.fixtureCapture.sourcePath) === values.sourceReview.sourceSha256, 'replay_source_changed');
      values.fixtureProject = await refresh(owned[0], values.fixtureProject);
      need(await deps.verifySavedRecipe(values.fixtureProject, values.selectedRecipe, values.narrationAssetId) === true, 'replay_saved_recipe_mismatch');
      values.fixtureExport = await exportProject(owned[0], values.fixtureProject, 'fixture-demo.mp4');
    },
    async 'prepare-completed-playback'() {
      const app = owned[0], imported = await deps.copyCompletedExport(values.fixtureExport.output, app.importRoot);
      need(inside(app.importRoot, imported), 'replay_playback_outside_grant');
      values.playbackProject = project(await command(app, 'project.import', { path: imported, name: 'Completed fixture-demo.mp4 playback' }, undefined, true));
      await command(app, 'preview.open', { projectId: values.playbackProject.id, position: 0 }, values.playbackProject.revision, true);
      values.playbackBefore = await command(app, 'preview.get'); values.playbackOpenedAt = now();
    },
    async 'trace-completed-playback'(input) {
      await traceEvidence('completed-file-playback', input, owned[0].identity, values.playbackOpenedAt);
      const after = await command(owned[0], 'preview.get');
      need(after.projectId === values.playbackProject.id && after.position > values.playbackBefore.position + DEMONSTRATION.playbackMinimumAdvance,
        'replay_completed_playback_unverified');
    },
    async 'walkthrough-record-stop'() { values.walkthroughProject = await stopCapture(owned[1], 'walkthroughCapture'); },
    async 'export-walkthrough'() { values.walkthroughExport = await exportProject(owned[1], values.walkthroughProject, 'editor-walkthrough.mp4'); },
    async 'verify-media'() {
      values.measurements = {};
      for (const kind of ['fixture', 'walkthrough']) {
        const measured = await deps.independentMediaVerification(kind, values[`${kind}Export`], values.selectedRecipe, values[`${kind}Capture`]);
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
    // Read-only REPLAY state for each connected instance, captured before cleanup after a failure.
    async reconcile() {
      const result = [];
      for (const app of owned) {
        if (!app.client) { result.push({ label: app.label, connected: false }); continue; }
        const read = async name => { try { return await deps.command(app.client, name, {}); } catch (error) { return { error: String(error.code || 'read_failed') }; } };
        const summary = { label: app.label, connected: true, jobs: await read('jobs.list'), capture: await read('capture.status'), requests: [] };
        for (const entry of requests.filter(value => value.app === app.label && ['pending', 'unknown'].includes(value.state))) {
          const evidence = { requestId: entry.requestId, command: entry.command, outcome: 'unresolved' };
          try {
            const receipt = await deps.readRequestReceipt?.(app, entry.requestId);
            if (matchingRequestReceipt(entry, receipt)) {
              evidence.durableState = receipt.state;
              if (['completed', 'failed'].includes(receipt.state)) {
                entry.state = receipt.state; entry.reconciledBy = 'matching_durable_request';
                if (receipt.state === 'completed') entry.result = structuredClone(receipt.result);
                evidence.outcome = receipt.state;
              }
            }
          } catch { evidence.receiptError = 'request_receipt_unavailable'; }
          // Diagnostics never infer delivery from an unrelated current project or preview.
          const projectId = entry.payload.input.projectId;
          if (projectId) {
            try { evidence.project = await deps.command(app.client, 'project.get', { id: projectId }); } catch { evidence.projectError = 'project_read_failed'; }
          }
          if (entry.command.startsWith('preview.')) evidence.preview = await read('preview.get');
          if (entry.command === 'export.start' && typeof entry.result?.id === 'string') {
            try { evidence.job = await deps.command(app.client, 'jobs.get', { id: entry.result.id }); } catch { evidence.jobError = 'job_read_failed'; }
          }
          entry.reconciliation = { outcome: evidence.outcome, ...(evidence.durableState ? { durableState: evidence.durableState } : {}) };
          summary.requests.push(evidence);
        }
        result.push(summary);
      }
      values.reconciliation = structuredClone(result);
      await checkpoint();
      return result;
    },
    // Private, noncredential recovery data; never expose handles, grants, setup or transports.
    recovery: () => ({ schemaVersion: 1, privateRoot: locations.privateRoot, capturedAt: now(),
      instances: owned.map(app => ({ label: app.label, root: app.root, launchedPid: app.launchedPid, identity: app.identity,
        libraryPath: app.info?.libraryPath, importRoot: app.importRoot, exportRoot: app.exportRoot })),
      fixture: fixture ? { launchedPid: fixture.handle.child?.pid, runId: fixture.handle.runId, statePath: fixture.handle.statePath,
        identity: fixture.identity } : undefined,
      values: structuredClone(values), requests: structuredClone(requests), completed: [...completed], next: STAGES[next] ?? null,
      limits: ['Observation only: no automatic restart, cached PID termination or mutation resubmission.',
        'An acquisition checkpoint may contain only a PID if identity collection did not finish; verify the generation independently before recovery.'] }),
    state: () => ({ status: failed ? 'blocked' : values.cleanup?.confirmed && values.reviewed ? 'awaiting_runtime_evidence_audit' : 'prepared_or_running',
      next: STAGES[next] ?? null, completed: [...completed], requests: requests.map(({ app, command, requestId, state, reconciliation, reconciledBy }) =>
        ({ app, command, requestId, state, ...(reconciliation ? { reconciliation } : {}), ...(reconciledBy ? { reconciledBy } : {}) })), cleanup: values.cleanup,
      sourceReview: values.sourceReview, sourceContentVerified: values.sourceContentVerified ?? false,
      selectedRecipe: values.selectedRecipe, measurements: values.measurements, limits: plan().remaining }),
    async advance(stage, input) {
      need(!failed && !active && STAGES[next] === stage, 'replay_stage_out_of_order'); active = true;
      try { await stages[stage](input); completed.push(stage); next++; await checkpoint(); return this.state(); }
      catch (error) { failed = true; throw error; }
      finally { active = false; }
    },
  };
}
// Exported before the CLI runs: the runtime requires this module back while it loads.
module.exports = { PIN, STAGES, RECIPE, DEMONSTRATION, EVIDENCE_INPUTS, plan, inside, identity, sameIdentity, exactWindowSource, editOperations,
  selectedRecipe, recipeMatches, packetDuration, meanDifference, gradientEnergy, validateMeasurements, matchingRequestReceipt, createWorkflow };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length || args.join(' ') === '--plan') process.stdout.write(JSON.stringify(plan(), null, 2) + '\n');
  else require('./replay-workflow-runtime.cjs').main(args).then(code => { process.exitCode = code; },
    error => { process.stderr.write(`${/^[a-z_]{1,80}$/.test(error.code || '') ? error.code : 'replay_workflow_failed'}\n`); process.exitCode = 1; });
}
