'use strict';

// Production runtime and durable manual command loop for A4-REPLAY. Importing performs no I/O.
// serve() starts effects only for a fresh directory and an owner decision reference, after a
// read-only desktop preflight. Root advances each stage with --advance and supplies actual
// TRACE session IDs; the adapter binds them to the local TRACE journal and independent state.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const flow = require('./accept-replay-workflow.cjs');
const ROOT = path.resolve(__dirname, '..');
const REPLAY_ROOT = path.resolve(ROOT, '../replay-studio');
const PACKAGE_DIRECTORY = 'release/contact-sheet-fix/win-unpacked';
const execFileAsync = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const need = (condition, code) => { if (!condition) throw fail(code); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRAME = Object.freeze({ width: 640, height: 400 });
const AUDIO = Object.freeze({ rate: 48000, before: [0.2, 1.3], during: [1.7, 2.3], after: [2.8, 5.8] });
const MINIMUM_ACTIONS = Object.freeze({ 'fixture-demonstration': flow.DEMONSTRATION.fixtureActions,
  'editor-controls': flow.DEMONSTRATION.editorActions, 'completed-file-playback': flow.DEMONSTRATION.playbackActions });
const TERMINAL_JOB = ['completed', 'failed', 'cancelled', 'interrupted'];

async function poll(read, predicate, timeoutMs, code, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw fail(code);
    await delay(intervalMs);
  }
}
const SHARING = ['EPERM', 'EBUSY', 'EACCES'];
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Polling readers treat a Windows sharing conflict or a foreign partial write as "not yet".
const readSettled = file => readJson(file).catch(error => SHARING.includes(error.code) || error instanceof SyntaxError ? null : Promise.reject(error));
async function writeAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, file); return; } catch (error) {
      if (attempt >= 40 || !SHARING.includes(error.code)) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
      await delay(25);
    }
  }
}
const publicError = error => ({ code: /^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'replay_stage_failed',
  ...(/^[A-Z_]{1,64}$/.test(error?.replayCode || '') ? { replayCode: error.replayCode } : {}) });

function parseJournal(text) {
  // TRACE appends whole lines; an unterminated tail is a write still in progress, not evidence.
  const lines = text.split(/\r?\n/); if (!/\n$/.test(text)) lines.pop();
  return lines.filter(Boolean).map(line => { try { return JSON.parse(line); } catch { throw fail('replay_trace_journal_invalid'); } });
}
// Binds a root-supplied TRACE session to the journal TRACE itself wrote; root prose alone never passes.
function verifyJournal(events, { sessionId, target, since, openedAfter, minimumActions = 1, observationId }) {
  need(UUID.test(sessionId ?? ''), 'replay_trace_session_invalid');
  const time = value => Date.parse(value), own = events.filter(event => event?.sessionId === sessionId);
  const opened = own.filter(event => event.type === 'session_open');
  need(opened.length === 1 && String(opened[0].windowId) === String(target?.windowId) && opened[0].pid === target?.pid, 'replay_trace_target_mismatch');
  need(Number.isFinite(time(openedAfter)) && time(opened[0].at) >= time(openedAfter), 'replay_trace_session_predates_target');
  need(Number.isFinite(time(since)), 'replay_trace_window_invalid');
  const window = own.filter(event => time(event.at) >= time(since));
  const started = new Map(window.filter(event => event.type === 'action_started').map(event => [event.actionId, event]));
  const closed = new Set(window.filter(event => ['action_completed', 'action_not_dispatched'].includes(event.type)).map(event => event.actionId));
  // Unknown or unterminated input makes the evidence uncertain; it is never treated as a pass.
  need(!window.some(event => event.type === 'action_unknown') && [...started.keys()].every(id => closed.has(id)), 'replay_trace_action_uncertain');
  const done = window.filter(event => event.type === 'action_completed' && started.has(event.actionId));
  need(done.length >= minimumActions, 'replay_trace_actions_missing');
  const chosen = observationId ?? done.at(-1)?.observationId;
  // The session itself opened after the target launched, so any of its observations postdates the target.
  const observation = own.find(event => event.type === 'observation' && event.observationId === chosen);
  need(UUID.test(observation?.observationId ?? '') && /^[a-f0-9]{64}$/.test(observation.screenshotSha256 ?? ''), 'replay_trace_observation_missing');
  return { sessionId, openedAt: opened[0].at, actions: done.map(event => ({ actionId: event.actionId, actionType: started.get(event.actionId).actionType, at: event.at })),
    finalObservation: { observationId: observation.observationId, sha256: observation.screenshotSha256 } };
}
function cropRgb(rgb, width, height, region) {
  const x = Math.round(region.x * width), y = Math.round(region.y * height);
  const w = Math.min(width - x, Math.round(region.width * width)), h = Math.min(height - y, Math.round(region.height * height));
  need(rgb?.length === width * height * 3 && w > 2 && h > 2, 'replay_decode_invalid');
  const out = Buffer.alloc(w * h * 3);
  for (let row = 0; row < h; row++) out.set(rgb.subarray(((y + row) * width + x) * 3, ((y + row) * width + x + w) * 3), row * w * 3);
  return { rgb: out, width: w, height: h };
}
function rms(samples, rate, [from, to]) {
  const start = Math.floor(from * rate), end = Math.min(samples.length, Math.floor(to * rate));
  need(end - start >= rate * 0.1, 'replay_audio_window_invalid');
  let sum = 0; for (let i = start; i < end; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / (end - start));
}
const mean = rgb => rgb.reduce((sum, value) => sum + value, 0) / rgb.length;
function reviewCovers(input, measurements) {
  const frames = Object.values(measurements ?? {}).flatMap(value => value?.frames ?? []);
  return input?.pass === true && frames.length > 0 && Array.isArray(input.reviewedFrames) && frames.every(frame => input.reviewedFrames.some(entry =>
    entry?.sha256 === frame.sha256 && typeof entry.observed === 'string' && entry.observed.trim().length >= 10 && entry.observed.length <= 2000));
}
function validCommand(value, lastId) {
  return value?.schemaVersion === 1 && value.id === lastId + 1 && (flow.STAGES.includes(value.stage) || value.stage === 'abort')
    && (value.input === undefined || (value.input !== null && typeof value.input === 'object' && !Array.isArray(value.input)));
}
function defaultJournalRoot() {
  // Mirrors the TRACE controller's runtime directory; the connected MCP host must use the same one.
  const base = process.env.TRACE_COMPUTER_RUNTIME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'TRACE', 'computer');
  return path.join(base, 'sessions');
}

// One stage at a time from <directory>/command.json; each id is consumed once and answered in
// responses/<id>.json. A failed stage, abort, interrupt or idle timeout reconciles read-only
// REPLAY state, then cleans up. Nothing is retried.
async function runLoop({ directory, workflow, record, pollMs = 200, idleMs = 30 * 60000, clock = Date.now, stopRequested = () => false }) {
  const commandPath = path.join(directory, 'command.json'), responses = path.join(directory, 'responses');
  let lastId = 0, idleSince = clock();
  await fs.mkdir(responses);
  const respond = (id, value) => writeAtomic(path.join(responses, `${id}.json`), { id, ...value });
  const terminate = async (reason, error) => {
    const reconciliation = reason === 'completed' ? undefined : await workflow.reconcile().catch(() => []);
    const cleanup = await workflow.cleanup(), state = workflow.state();
    const changed = state.requests.some(request => request.state !== 'not_dispatched') || state.completed.length > 1;
    const status = reason === 'completed' && state.status === 'awaiting_runtime_evidence_audit' ? state.status
      : !cleanup.confirmed || !changed ? 'blocked' : 'fail';
    return record({ status, terminalReason: reason, ...(error ? { error } : {}), ...(reconciliation ? { reconciliation } : {}),
      state, completedAt: new Date().toISOString() });
  };
  for (;;) {
    if (stopRequested()) return terminate('interrupted');
    if (clock() - idleSince > idleMs) return terminate('operator_timeout');
    const value = await readSettled(commandPath);
    if (!value || !Number.isSafeInteger(value.id) || value.id <= lastId) { await delay(pollMs); continue; }
    idleSince = clock();
    const valid = validCommand(value, lastId); lastId = value.id;
    await record({ lastCommandId: lastId });
    if (!valid) { await respond(lastId, { ok: false, error: { code: 'replay_command_invalid' } }); continue; }
    if (value.stage === 'abort') { const receipt = await terminate('aborted'); await respond(lastId, { ok: false, terminal: receipt.status }); return receipt; }
    try {
      const state = await workflow.advance(value.stage, value.input);
      if (value.stage === 'cleanup') { const receipt = await terminate('completed'); await respond(lastId, { ok: receipt.status === 'awaiting_runtime_evidence_audit', terminal: receipt.status, state }); return receipt; }
      await record({ state }); await respond(lastId, { ok: true, state });
    } catch (error) {
      const receipt = await terminate('stage_failed', { stage: value.stage, ...publicError(error) });
      await respond(lastId, { ok: false, error: receipt.error, terminal: receipt.status }); return receipt;
    }
  }
}
async function advance(directory, stage, inputFile, { timeoutMs = 20 * 60000, pollMs = 250 } = {}) {
  const receipt = await poll(() => readSettled(path.join(directory, 'receipt.json')), Boolean, 2000, 'replay_loop_not_running', 50);
  need(receipt.caseId === 'A4-REPLAY' && receipt.status === 'running' && Number.isSafeInteger(receipt.lastCommandId), 'replay_loop_not_running');
  const pending = await readJson(path.join(directory, 'command.json'));
  need(!pending || pending.id <= receipt.lastCommandId, 'replay_command_pending');
  const input = inputFile ? JSON.parse(await fs.readFile(inputFile, 'utf8')) : undefined, id = receipt.lastCommandId + 1;
  await writeAtomic(path.join(directory, 'command.json'), { schemaVersion: 1, id, stage, ...(input === undefined ? {} : { input }) });
  return poll(() => readSettled(path.join(directory, 'responses', `${id}.json`)), Boolean, timeoutMs, 'replay_response_timeout', pollMs);
}

function createDeps({ privateRoot, replayRoot = REPLAY_ROOT, journalRoot = defaultJournalRoot(), common, note, checkpoint }) {
  const fromReplay = createRequire(path.join(replayRoot, 'package.json'));
  const harness = fromReplay('./scripts/media-inspection-smoke.cjs');
  const { _electron: electron } = fromReplay('playwright');
  const { unpackedBinary } = fromReplay('./electron/engine.cjs');
  const ffprobe = unpackedBinary(fromReplay('@ffprobe-installer/ffprobe').path), ffmpeg = harness.ffmpeg;
  const executable = path.join(replayRoot, PACKAGE_DIRECTORY, 'REPLAY Studio.exe');
  const tool = (file, args, options = {}) => execFileAsync(file, args, { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...options });
  const probe = async file => JSON.parse((await tool(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
  const packets = async file => (await tool(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file])).stdout.trim().split(/\r?\n/);
  const decode = async (file, seconds) => {
    const { stdout } = await tool(ffmpeg, ['-v', 'error', '-nostdin', ...(seconds === undefined ? [] : ['-ss', String(seconds)]), '-i', file, '-frames:v', '1',
      '-vf', `scale=${FRAME.width}:${FRAME.height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' });
    need(stdout.length === FRAME.width * FRAME.height * 3, 'replay_decode_invalid'); return stdout;
  };
  const audio = async file => {
    const { stdout } = await tool(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(AUDIO.rate), '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' });
    const copy = new Uint8Array(stdout); return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
  };
  const still = async (file, seconds, name) => {
    const output = path.join(privateRoot, 'review', name); await fs.mkdir(path.dirname(output), { recursive: true });
    await tool(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-ss', String(seconds), '-i', file, '-frames:v', '1', output]);
    return { name, sha256: digest(await fs.readFile(output)) };
  };
  const nativeWindow = async (windowId, pid) => {
    const value = await common.bridge('identity', { id: String(windowId), pid });
    need(String(value.hwnd) === String(windowId) && value.pid === pid, 'replay_identity_unverified');
    return { pid: value.pid, windowId: String(value.hwnd), processCreationTime: String(value.processCreationTime), sessionId: value.sessionId };
  };
  const call = async (client, name, input = {}, revision, requestId) => {
    let envelope;
    try { ({ envelope } = await harness.call(client, name, input, revision, requestId)); }
    catch { throw fail('replay_transport_unknown', { replayOutcome: 'unknown' }); }
    if (envelope?.command !== name) throw fail('replay_envelope_invalid', { replayOutcome: 'unknown' });
    if (envelope.error) {
      const code = String(envelope.error.code ?? '');
      throw fail('replay_command_rejected', { replayCode: /^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN', replayOutcome: code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed' });
    }
    return envelope.result;
  };
  const journal = async sessionId => {
    need(UUID.test(sessionId ?? ''), 'replay_trace_session_invalid');
    const directory = path.join(journalRoot, sessionId);
    return { directory, events: parseJournal(await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8')) };
  };
  const traceEvidence = {};
  const retainObservation = async (directory, observation, name) => {
    const bytes = await fs.readFile(path.join(directory, `${observation.observationId}.png`));
    need(digest(bytes) === observation.sha256, 'replay_trace_observation_changed');
    const target = path.join(privateRoot, 'trace', `${name}.png`); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' }); return target;
  };
  let fixtureState = async () => { throw fail('replay_fixture_not_launched'); };
  const exited = child => child.exitCode !== null || child.signalCode !== null;
  const generationExited = async identity => {
    try { process.kill(identity.pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; if (error.code !== 'EPERM') throw error; }
    try {
      const current = await common.command(['identity', String(identity.pid)]);
      if (current?.pid === identity.pid && /^\d+$/.test(String(current.processCreationTime))) return String(current.processCreationTime) !== identity.processCreationTime;
    } catch {}
    try { process.kill(identity.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  };
  return {
    now: () => new Date().toISOString(),
    checkpoint,
    async verifyPins() {
      const [exe, asar] = await Promise.all([fs.readFile(executable), fs.readFile(path.join(path.dirname(executable), 'resources/app.asar'))]);
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: replayRoot, windowsHide: true });
      return { replayCommit: stdout.trim(), executableSha256: digest(exe), asarSha256: digest(asar) };
    },
    async prepareOfflineAssets() {
      const bootstrapVideo = path.join(privateRoot, 'bootstrap.mp4'), wav = path.join(privateRoot, 'offline-tone.wav');
      await tool(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bootstrapVideo]);
      await tool(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', wav]);
      const duration = Math.round(Number((await probe(wav)).format?.duration) * 1000) / 1000;
      return { bootstrapVideo, wav, wavDuration: duration, wavSha256: digest(await fs.readFile(wav)), paidRequests: 0 };
    },
    async launchApp({ label, args }) {
      await fs.mkdir(path.join(privateRoot, label));
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      return electron.launch({ executablePath: executable, args, env, timeout: 60000 });
    },
    async processIdentity(pid) {
      const value = await common.command(['identity', String(pid)]);
      need(value?.pid === pid, 'replay_identity_unverified');
      return { pid, processCreationTime: String(value.processCreationTime), sessionId: value.session };
    },
    async readyApp(handle) {
      const page = await handle.firstWindow();
      await page.waitForFunction(() => typeof window.replay?.getAgentAccess === 'function', null, { timeout: 30000 });
      return { page, info: await page.evaluate(() => window.replay.getAppInfo()) };
    },
    async editorWindowIdentity(handle) {
      // Fixed read-only lookup, as in the passing feasibility driver; no content-supplied code.
      const found = await handle.evaluate(({ BrowserWindow }) => {
        const visible = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible());
        if (visible.length !== 1) return null;
        const bytes = visible[0].getNativeWindowHandle(); let id = 0n;
        for (let i = 0; i < bytes.length; i++) id += BigInt(bytes[i]) << BigInt(i * 8);
        return { pid: process.pid, windowId: id.toString() };
      });
      need(found, 'replay_editor_window_ambiguous'); return nativeWindow(found.windowId, found.pid);
    },
    createGrant: (page, name) => harness.createGrant(page, name),
    connectMcp: entry => harness.connectMcp(entry),
    command: call,
    waitJob: (client, id) => poll(() => call(client, 'jobs.get', { id }), job => TERMINAL_JOB.includes(job?.state), 15 * 60000, 'replay_job_timeout', 500),
    windowIdentity: target => nativeWindow(target.windowId, target.pid),
    async launchFixture() {
      const { executable: binary } = await require('./continuation-adapter.cjs').preparedFixture();
      const directory = path.join(privateRoot, 'fixture'); await fs.mkdir(directory);
      const runId = `replay-${randomUUID()}`, statePath = path.join(directory, 'fixture.json');
      const child = spawn(binary, ['--run-id', runId, '--receipt', statePath, '--commands', path.join(directory, 'commands.json')], { windowsHide: false, shell: false, stdio: 'ignore' });
      child.once('error', () => {});
      fixtureState = async () => {
        need(!exited(child), 'replay_fixture_exited');
        const value = await readJson(statePath); need(value?.runId === runId, 'replay_fixture_state_missing'); return value;
      };
      return { child, runId };
    },
    async fixtureIdentity(handle) {
      need(Number.isInteger(handle.child.pid), 'replay_fixture_not_ready');
      await poll(() => fixtureState().catch(() => null), Boolean, 15000, 'replay_fixture_not_ready');
      const windowId = await poll(async () => (await tool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${handle.child.pid}).MainWindowHandle.ToInt64()`], { timeout: 15000 })).stdout.trim(),
      value => /^[1-9]\d*$/.test(value), 10000, 'replay_fixture_window_missing', 250);
      return nativeWindow(windowId, handle.child.pid);
    },
    async validateOwnedFixture(input, expected, { openedAfter }) {
      need(UUID.test(input?.observationId ?? ''), 'replay_trace_observation_missing');
      const { directory, events } = await journal(input.traceSessionId);
      const summary = verifyJournal(events, { sessionId: input.traceSessionId, target: expected, since: openedAfter, openedAfter, minimumActions: 0, observationId: input.observationId });
      await fixtureState();
      const crop = cropRgb(await decode(await retainObservation(directory, summary.finalObservation, 'fixture-ready')), FRAME.width, FRAME.height, flow.RECIPE.privacy);
      const energy = flow.gradientEnergy(crop.rgb, crop.width, crop.height);
      traceEvidence['fixture-ready'] = { ...summary, privacyTextureEnergy: energy }; await note('traceEvidence', traceEvidence);
      // Synthetic: the window belongs to the run-launched, hash-verified prepared fixture.
      return { ...(await nativeWindow(expected.windowId, expected.pid)), synthetic: true,
        privacyTextureVerified: energy > flow.DEMONSTRATION.textureMinimum, privacyTextureEnergy: energy };
    },
    async verifyTraceEvidence(kind, input, target, { since, openedAfter }) {
      need(Object.hasOwn(MINIMUM_ACTIONS, kind), 'replay_trace_evidence_missing');
      const { directory, events } = await journal(input?.traceSessionId);
      const summary = verifyJournal(events, { sessionId: input.traceSessionId, target, since, openedAfter, minimumActions: MINIMUM_ACTIONS[kind] });
      if (kind === 'fixture-demonstration') {
        const state = await fixtureState();
        need(state.text === flow.DEMONSTRATION.text && state.count >= flow.DEMONSTRATION.increments, 'replay_fixture_demonstration_unverified');
        summary.fixture = { textMatches: true, count: state.count };
      }
      await retainObservation(directory, summary.finalObservation, kind);
      traceEvidence[kind] = summary; await note('traceEvidence', traceEvidence);
      return true;
    },
    async requireMissing(output) {
      try { await fs.lstat(output); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      throw fail('replay_output_exists');
    },
    async copyOfflineWav(prepared, importRoot) {
      const target = path.join(importRoot, 'offline-tone.wav'); await fs.copyFile(prepared.wav, target, constants.COPYFILE_EXCL); return target;
    },
    async copyCompletedExport(source, importRoot) {
      const target = path.join(importRoot, 'fixture-demo.mp4'); await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      need(digest(await fs.readFile(target)) === digest(await fs.readFile(source)), 'replay_playback_copy_changed'); return target;
    },
    sourceDigest: async file => digest(await fs.readFile(file)),
    verifySavedRecipe: async (current, _recipe, assetId) => flow.recipeMatches(current, assetId),
    async independentMediaVerification(kind, exported, recipe, capture) {
      const bytes = await fs.readFile(exported.output), meta = await probe(exported.output);
      const streams = type => (meta.streams ?? []).filter(stream => stream.codec_type === type), video = streams('video')[0];
      const container = Number(meta.format?.duration);
      const duration = flow.packetDuration(meta.format?.duration, Number.isFinite(container) && container > 0 ? [] : await packets(exported.output));
      const base = { sha256: digest(bytes), bytes: bytes.length, width: video?.width, height: video?.height, videoStreams: streams('video').length,
        audioStreams: streams('audio').length, duration: duration.seconds, durationSource: duration.source };
      if (kind === 'fixture') {
        const output = [], original = [], frames = [];
        for (const seconds of recipe.samples) { output.push(await decode(exported.output, seconds)); original.push(await decode(capture.sourcePath, recipe.sourceStart + seconds)); }
        const region = (rgb, value) => cropRgb(rgb, FRAME.width, FRAME.height, value);
        const callout = [region(output[1], recipe.callout), region(original[1], recipe.callout)];
        const privacy = [region(original[1], recipe.privacy), region(output[1], recipe.privacy)];
        const samples = await audio(exported.output);
        for (const [index, seconds] of recipe.samples.entries()) frames.push(await still(exported.output, seconds, `fixture-output-${index}.png`));
        frames.push(await still(capture.sourcePath, recipe.sourceStart + recipe.samples[1], 'fixture-source-during.png'));
        return { ...base, sourceHashUnchanged: digest(await fs.readFile(capture.sourcePath)) === capture.sourceSha256,
          effectSampleTimes: [...recipe.samples], decodedFrames: output.length, nonblackMean: mean(output[0]),
          beforeEffectDifference: flow.meanDifference(output[0], original[0]), afterEffectDifference: flow.meanDifference(output[2], original[2]),
          calloutDifference: flow.meanDifference(callout[0].rgb, callout[1].rgb),
          privacySourceEnergy: flow.gradientEnergy(privacy[0].rgb, privacy[0].width, privacy[0].height),
          privacyOutputEnergy: flow.gradientEnergy(privacy[1].rgb, privacy[1].width, privacy[1].height),
          audioBeforeRms: rms(samples, AUDIO.rate, AUDIO.before), audioDuringRms: rms(samples, AUDIO.rate, AUDIO.during),
          audioAfterRms: rms(samples, AUDIO.rate, AUDIO.after), frames };
      }
      const end = Math.max(0.6, duration.seconds - 0.5), times = [0.5, (0.5 + end) / 2, end], decoded = [], frames = [];
      for (const [index, seconds] of times.entries()) { decoded.push(await decode(exported.output, seconds)); frames.push(await still(exported.output, seconds, `walkthrough-${index}.png`)); }
      return { ...base, decodedFrames: decoded.length, nonblackMean: mean(decoded[0]), sampleTimes: times,
        decodedFrameDifference: Math.max(flow.meanDifference(decoded[0], decoded[1]), flow.meanDifference(decoded[0], decoded[2])), frames };
    },
    async verifyRootReview(input, measurements) {
      if (!reviewCovers(input, measurements)) return false;
      await note('rootReview', { pass: true, reviewedAt: new Date().toISOString(),
        frames: input.reviewedFrames.map(entry => ({ sha256: entry.sha256, observed: entry.observed.trim() })) });
      return true;
    },
    closeTransport: client => client.close(),
    revokeGrant: app => app.page.evaluate(id => window.replay.revokeAgentGrant(id), app.grantId),
    async grantRevoked(app) {
      const access = await readJson(path.join(path.dirname(app.info.libraryPath), 'Automation', 'access.json'));
      const entry = (access?.grants ?? []).find(grant => grant.id === app.grantId);
      return typeof entry?.revokedAt === 'string' && Number.isFinite(Date.parse(entry.revokedAt));
    },
    async stopApp(handle, page) {
      await harness.stopApp(handle, page);
      await poll(async () => exited(handle.process()), Boolean, 10000, 'replay_app_exit_unconfirmed').catch(() => {});
    },
    async closeFixture(handle) {
      if (!exited(handle.child)) handle.child.kill();
      return poll(async () => exited(handle.child), Boolean, 5000, 'replay_fixture_exit_unconfirmed').catch(() => false);
    },
    waitIdentityExit: identity => poll(() => generationExited(identity), Boolean, 15000, 'replay_exact_exit_unconfirmed').catch(() => false),
  };
}

async function testedSource(replayRoot) {
  const git = async (cwd, args) => (await execFileAsync('git', args, { cwd, windowsHide: true })).stdout.trim();
  const files = {};
  for (const name of ['scripts/accept-replay-workflow.cjs', 'scripts/replay-workflow-runtime.cjs', 'scripts/replacement-acceptance-common.cjs',
    'scripts/continuation-adapter.cjs', 'src/computer/controller.cjs', 'package-lock.json']) files[name] = digest(await fs.readFile(path.join(ROOT, name)));
  return { traceCommit: await git(ROOT, ['rev-parse', 'HEAD']), traceWorkingTreeClean: !(await git(ROOT, ['status', '--porcelain'])),
    replayCommit: await git(replayRoot, ['rev-parse', 'HEAD']), files,
    replayHarnessSha256: digest(await fs.readFile(path.join(replayRoot, 'scripts/media-inspection-smoke.cjs'))) };
}
async function serve(options, { replayRoot = REPLAY_ROOT, journalRoot = defaultJournalRoot() } = {}) {
  const common = require('./replacement-acceptance-common.cjs');
  const prior = await common.checkPrior(options), directory = path.resolve(options.directory);
  // Read-only preflight before the run directory, any UI or any claim exists: a missing helper,
  // fixture build or package leaves no receipt that could be mistaken for a used attempt.
  const display = common.validateDisplay(await common.command(['display']));
  need((await common.command(['status'])).recoveryRequired === false, 'input_recovery_required');
  need((await common.command(['input-access'])).observable === true, 'input_state_unavailable');
  need((await common.command(['keystate', 'all'])).down?.length === 0, 'input_busy');
  await common.verify(); await require('./continuation-adapter.cjs').preparedFixture();
  const privateRoot = path.join(ROOT, '.runtime', 'replay-workflow', randomUUID());
  let workflow, interrupted = false, record;
  const deps = createDeps({ privateRoot, replayRoot, journalRoot, common,
    note: (key, value) => record({ [key]: structuredClone(value) }), checkpoint: () => record({ state: workflow.state() }) });
  const pins = await deps.verifyPins();
  need(Object.keys(flow.PIN).every(key => pins[key] === flow.PIN[key]), 'replay_source_changed');
  const source = await testedSource(replayRoot);
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory); // A used directory is never reused.
  await fs.mkdir(privateRoot, { recursive: true });
  await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify({ ...flow.plan(), status: 'declared', declaredBeforeUi: true,
    attempt: options.attempt, ownerDecision: options.ownerDecision, ...(prior ? { prior } : {}) }, null, 2) + '\n', { flag: 'wx' });
  const receipt = { schemaVersion: 1, caseId: 'A4-REPLAY', requirement: 'APP-01', planContract: 1, attempt: options.attempt,
    ownerDecision: options.ownerDecision, ...(prior ? { prior } : {}), status: 'running', startedAt: new Date().toISOString(),
    paidRequests: 0, lastCommandId: 0, display, testedSource: source };
  record = async update => { Object.assign(receipt, update); await writeAtomic(path.join(directory, 'receipt.json'), receipt); return receipt; };
  await record({});
  workflow = flow.createWorkflow(deps, { privateRoot });
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    const result = await runLoop({ directory, workflow, record, stopRequested: () => interrupted });
    return result.status === 'awaiting_runtime_evidence_audit' ? 0 : 1;
  } catch (error) {
    // The loop itself failed (for example, the receipt became unwritable): still release every owned process.
    await workflow.cleanup().catch(() => {}); throw error;
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
}
async function main(args) {
  if (args[0] === '--advance') {
    const [directory, stage, flag, input, ...extra] = args.slice(1);
    need(directory && stage && !extra.length && (flag === undefined || (flag === '--input' && input)), 'replay_arguments_invalid');
    const response = await advance(path.resolve(directory), stage, input && path.resolve(input));
    process.stdout.write(JSON.stringify(response, null, 2) + '\n'); return response.ok ? 0 : 1;
  }
  if (args[0] === '--status') {
    need(args.length === 2, 'replay_arguments_invalid');
    const receipt = await readJson(path.join(path.resolve(args[1]), 'receipt.json')); need(receipt, 'replay_loop_not_running');
    process.stdout.write(JSON.stringify({ status: receipt.status, lastCommandId: receipt.lastCommandId, next: receipt.state?.next ?? 'provision',
      completed: receipt.state?.completed ?? [], error: receipt.error }, null, 2) + '\n');
    return 0;
  }
  const options = require('./replacement-acceptance-common.cjs').parseArgs(args, 'A4-REPLAY');
  need(options.mode === 'live', 'replay_arguments_invalid');
  return serve(options);
}
module.exports = { FRAME, AUDIO, MINIMUM_ACTIONS, parseJournal, verifyJournal, cropRgb, rms, reviewCovers, validCommand,
  runLoop, advance, createDeps, serve, main };
