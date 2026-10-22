#!/usr/bin/env node
'use strict';

// New acceptance identity, private MCP host in mode none, and a genuinely external reference click.
// Import/--plan never opens UI. No source-owned callback synthesizes the reference click in live mode.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const common = require('./replacement-acceptance-common.cjs');
const fixtureTools = require('./smoke-computer-glow.cjs');
const { edgeBands, glowVisible, glowAbsent, decodePng } = require('./accept-glow.cjs');
const continuation = require('./continuation-adapter.cjs');
const book = require('./live-acceptance-continuation.cjs');
const region = require('./glow-reference-region.cjs');
const { DesktopLease } = require('../src/computer/lease.cjs');
const CASE = 'R31-GLOW-NATIVE', DRIVER = 'scripts/accept-replacement-glow.cjs';
const traceExecutor = value => /^(?:trace(?:$|[-_ :])|mcp__trace)/i.test(value || '');

function plan(input = {}) {
  const supplemental = input.continuationAttempt !== undefined;
  const options = supplemental ? continuation.options(input, CASE) : common.optionsFor(input, CASE);
  if (options.referenceExecutor !== undefined && (typeof options.referenceExecutor !== 'string' || !options.referenceExecutor.trim()
    || options.referenceExecutor.length > 256 || /[\x00-\x1f]/.test(options.referenceExecutor) || traceExecutor(options.referenceExecutor)))
    throw common.failure('invalid_plan', 'A bounded separate reference-executor name/reference is required; TRACE cannot supply both clicks.');
  return { schemaVersion: 1, planContract: 1, caseId: CASE, replaces: ['A31-GLOW', 'GLOW-LIVE'], historicalStatus: 'exhausted fail; regression kept separate',
    attempt: options.attempt, ownerDecision: options.ownerDecision ?? null, referenceExecutor: options.referenceExecutor ?? null,
    ...(supplemental ? { attempt: options.lifetimeAttemptOrdinal, historicalAttemptsUsed: 2, continuationAttempt: options.continuationAttempt,
      lifetimeAttemptOrdinal: options.lifetimeAttemptOrdinal, contract: options.contract, decisionRef: options.decisionRef ?? null,
      referenceProof: 'One actual Sky accessibility mouse click; independently recorded physical point inside fresh button and measured glow. TRACE remains exact fresh center.' } : {}),
    executionRequiresExplicitOwnerDecision: true, declaredBeforeUiLaunch: true,
    display: options.pinnedDisplay ?? 'Observe/pin the actual native single-monitor device, bounds and DPI before UI.',
    target: 'Fresh exact owned full-screen non-topmost synthetic glow fixture',
    initial: { count: 0, mouseClickCount: 0, activationCount: 0, mouseDownCount: 0, mouseUpCount: 0, keysDown: [] },
    actions: ['Open actual MCP session; verify Node→detached native supervisor→marker and unchanged focus',
      'Verify actual safe desktop pixels show glow; after actual Sky observation, take a new safe reference frame before validating the click checkpoint', 'One EXTERNAL reference-executor left edge click gives count1',
      'One fresh observed TRACE MCP coordinate edge click gives count2',
      'Ordinary session close: owner/marker exit within5s, absent glow, clear recovery and free lease',
      'Second session: visible glow and unchanged focus; private owned Node self-termination; exact Node/native/marker exit within5s, absent glow and lease handoff'],
    bounds: { referenceWaitMs: 60000, helperExitMs: 5000, captureAttemptsPerFrame: 3, referenceClicks: 1, traceClicks: 1 },
    referenceProof: supplemental ? 'Actual Sky accessibility physical MouseClick point must be inside fresh button and actual measured glow; TRACE remains exact fresh center.'
      : 'Actual external tool receipt must be retained separately; private checkpoint metadata binds its executor, target generation, screen point and time.',
    cleanup: 'Close any remaining owner/MCP; verify exact helper exit and independent all-up while fixture remains; close fixture; persist terminal receipt.',
    budget: 'One attempt plus one matching corrective attempt with changed precondition, no input replay or historical promotion.',
    limits: ['Selected single-monitor mode only', 'Private host mode none supplies ordinary production backend/native ownership; no controlled input replacement',
      'Two TRACE clicks, UIA invocation or synthetic fixture activation cannot replace the external reference click', 'No model-host/release acceptance'] };
}
function parseArgs(args) {
  const options = args.includes('--continuation') ? continuation.parse(args, CASE, { '--reference-executor': 'referenceExecutor' })
    : common.parseArgs(args, CASE, { '--reference-executor': 'referenceExecutor' });
  plan(options); return options;
}

function regionDisplay(native) {
  const monitor = native.displays[0];
  return { monitors: 1, primary: monitor.primary, device: monitor.device, bounds: { ...monitor.bounds }, dpiX: monitor.dpi, dpiY: monitor.dpi,
    captureWidth: monitor.bounds.width, captureHeight: monitor.bounds.height };
}
function regionFixture(state, sample) {
  // Default fixture.state checks its retained ChildProcess before and after reading status;
  // publication failure latches, closes the fixture and is never interpreted as live state.
  const result = { ...sample, ...state, target: sample.target, display: sample.display, sampledAt: sample.sampledAt,
    alive: true, publicationHealthy: state.ready === true };
  for (const key of ['lastMouseDown', 'lastMouseUp', 'lastMouseClick']) if (state[key]) result[key] = { ...state[key], coordinateSpace: 'physical-screen' };
  return result;
}
function measureGlowRegion(baseline, active, button, nativeDisplay) {
  const before = decodePng(baseline), after = decodePng(active), monitor = nativeDisplay.displays[0].bounds;
  assert.equal(before.width, monitor.width); assert.equal(before.height, monitor.height);
  assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  assert.ok(button.y >= monitor.y && button.y + button.height <= monitor.y + monitor.height);
  // Retain the actual per-pixel delta in memory; rectangle membership alone cannot accept an untinted pixel.
  const changed = new Set(); let extent = 0;
  for (let y = button.y - monitor.y; y < button.y - monitor.y + button.height; y++) for (let x = 0; x < 14; x++) {
    if (before.pixel(x, y).some((value, index) => value !== after.pixel(x, y)[index])) { changed.add(`${x},${y}`); extent = Math.max(extent, x + 1); }
  }
  assert.ok(extent > 0 && extent < monitor.width, 'Actual safe before/active pixels must measure glow beside the fresh button.');
  return { bounds: { x: monitor.x, y: button.y, width: extent, height: button.height },
    containsTintedPoint: point => changed.has(`${point.x - monitor.x},${point.y - monitor.y}`) };
}
async function readExternal(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; } }
async function waitSkyObservation(file) { return common.waitFor(() => readExternal(file), Boolean, 'fresh actual Sky accessibility observation', 60000); }
async function waitRegionReference(fixture, checkpoint, proofPath, sampleInput) {
  const value = await common.waitFor(async () => {
    const state = await fixture.state(); if (state.count > 1 || state.mouseClickCount > 1) throw common.failure('reference_extra_click', 'Only one Sky reference click is declared.');
    return { state, proof: await readExternal(proofPath) };
  }, value => value.state.count === 1 && value.state.mouseUpCount === 1 && Boolean(value.proof), 'complete actual Sky click evidence', 60000);
  const sampledAt = new Date().toISOString(), sample = { target: checkpoint.target, display: checkpoint.display, sampledAt };
  const finalInput = { ...sample, sampledAt: new Date().toISOString(), source: 'independent-keystate-all', observable: true, keysDown: await sampleInput() };
  const result = region.assertReferenceRegion({ checkpoint, proof: value.proof, finalFixture: regionFixture(value.state, sample), finalInput, checkedAt: new Date().toISOString() });
  return { ...result, toolReceiptRef: value.proof.toolReceiptRef, completedAt: value.proof.completedAt };
}
function assertFocus(before, after) {
  assert.equal(before.fixtureForeground, true); assert.equal(after.fixtureForeground, true);
  assert.equal(after.foregroundWindowId, before.foregroundWindowId); assert.equal(after.focusedWindowId, before.focusedWindowId);
}
function assertOwnershipSession(chain, target) {
  if (!Number.isInteger(target?.sessionId) || target.sessionId < 0
    || !['node', 'supervisor', 'marker'].every(role => Number.isInteger(chain?.[role]?.sessionId) && chain[role].sessionId === target.sessionId))
    throw common.failure('owner_identity_changed', 'The owned Node, supervisor and marker must have observable Windows sessions matching the exact target.');
  return chain;
}
function assertCounts(state, expected) {
  for (const key of ['count', 'mouseClickCount', 'activationCount', 'mouseDownCount', 'mouseUpCount']) assert.equal(state[key], expected, `${key} must equal ${expected}.`);
  assert.equal(state.input.leftButtonDown, false);
}
function assertClick(state, expected, point, began) {
  assertCounts(state, expected);
  const actual = state.lastMouseClick;
  assert.equal(actual?.button, 'Left'); assert.equal(actual?.clicks, 1);
  assert.equal(actual?.screenX, point.x); assert.equal(actual?.screenY, point.y);
  assert.ok(Number.isFinite(Date.parse(actual?.atUtc)) && Date.parse(actual.atUtc) >= Date.parse(began), 'An independent mouse event must follow this declared click checkpoint.');
}
function referencePoint(state) {
  const button = state.button;
  assert.ok(button && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(button[key])) && button.width > 0 && button.height > 0);
  return { x: button.x + Math.floor(button.width / 2), y: button.y + Math.floor(button.height / 2) };
}
function assertReferenceProof(proof, pending) {
  if (!proof || proof.source !== 'reference-executor' || proof.executor !== pending.executor || traceExecutor(proof.executor) || proof.operation !== 'click'
    || proof.checkpointId !== pending.checkpointId || proof.windowId !== pending.target.id || proof.pid !== pending.target.pid
    || proof.processCreationTime !== pending.target.processCreationTime || proof.screenX !== pending.point.x || proof.screenY !== pending.point.y
    || typeof proof.toolReceiptRef !== 'string' || !proof.toolReceiptRef.trim() || proof.toolReceiptRef.length > 1024
    || /[\x00-\x1f]/.test(proof.toolReceiptRef) || path.win32.isAbsolute(proof.toolReceiptRef) || path.posix.isAbsolute(proof.toolReceiptRef)
    || !Number.isFinite(Date.parse(proof.at)) || Date.parse(proof.at) < Date.parse(pending.startedAt))
    throw common.failure('reference_proof_invalid', 'The actual external reference receipt metadata must match this checkpoint, target generation, point and time.');
  // Omit the private checkpoint token and local paths from shareable evidence.
  return { executor: proof.executor, operation: proof.operation, toolReceiptRef: proof.toolReceiptRef, at: proof.at,
    windowId: proof.windowId, pid: proof.pid, processCreationTime: proof.processCreationTime, point: { x: proof.screenX, y: proof.screenY },
    scope: 'Bound external metadata; the actual referenced tool receipt must also be retained and inspected.' };
}
async function waitReference(fixture, pending, proofPath) {
  await common.waitFor(async () => {
    const state = await fixture.state();
    if (state.count > 1 || state.mouseClickCount > 1) throw common.failure('reference_extra_click', 'More than the one declared reference click arrived.');
    let proof;
    try { proof = JSON.parse(await fs.readFile(proofPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (proof) assertReferenceProof(proof, pending);
    return { state, proof };
  }, value => value.state.count === 1 && Boolean(value.proof), 'one actual external reference click and bound receipt', 60000).catch(error => {
    if (error.code === 'acceptance_timeout') throw common.failure('reference_missing', 'No complete reference click/tool receipt arrived within60s.'); throw error;
  });
  const proof = JSON.parse(await fs.readFile(proofPath, 'utf8')); return assertReferenceProof(proof, pending);
}
async function readFixtureState(directory, child, getSpawnError = () => undefined, readFile = fs.readFile) {
  function assertRunning() {
    if (getSpawnError()) throw common.failure('fixture_start_failed', 'The owned glow fixture could not start.');
    if (child.exitCode !== null || child.signalCode !== null)
      throw common.failure('fixture_process_exited', 'The exact owned glow fixture exited; retained status is not live evidence.');
  }
  assertRunning();
  try {
    const contents = await readFile(path.join(directory, 'status.json'), 'utf8');
    assertRunning(); // Exit during an asynchronous read cannot validate a stale final status.
    return JSON.parse(contents);
  } catch (error) { assertRunning(); if (error.code === 'ENOENT') return null; throw error; }
}
function captureMetadata(value, expected) {
  const known = [24, 28, 40], rgb = value?.sanitizedInteriorRgb;
  const rgbMatches = Array.isArray(rgb) ? rgb.length === 3 && rgb.every((byte, index) => Number.isInteger(byte) && byte === known[index])
    : typeof rgb === 'string' && /^[A-Za-z0-9+/]{4}$/.test(rgb) && Buffer.from(rgb, 'base64').toString('base64') === rgb
      && Buffer.from(rgb, 'base64').equals(Buffer.from(known));
  if (!value || value.file !== expected.filename || value.sha256 !== expected.sha256 || !/^[a-f0-9]{64}$/.test(value.sha256 || '')
    || value.width !== expected.width || value.height !== expected.height || !Number.isInteger(value.width) || value.width < 1
    || !Number.isInteger(value.height) || value.height < 1 || value.method !== 'public-win32-bitblt-captureblt' || value.layeredWindows !== true || !rgbMatches)
    throw common.failure('capture_metadata_invalid', 'Actual capture metadata must bind the image/hash/geometry and exact known interior RGB bytes.');
  const metadata = JSON.parse(JSON.stringify(value));
  return { captureMetadata: metadata, captureMetadataSha256: common.digest(Buffer.from(JSON.stringify(metadata))),
    captureMetadataHashEncoding: 'UTF-8 JSON.stringify of actual capture object', interiorBackgroundVerified: true };
}
async function launchFixture(directory) {
  await fixtureTools.verify();
  const child = spawn(fixtureTools.BINARY, ['--directory', directory, '--parent-pid', String(process.pid), '--lifetime-ms', '300000'], { shell: false, windowsHide: false, stdio: 'ignore' });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const state = () => readFixtureState(directory, child, () => spawnError);
  return { pid: child.pid, sha256: common.digest(await fs.readFile(fixtureTools.BINARY)), state,
    focus: async () => (await fixtureTools.command({ directory, command: 'focus' })).lastCommand.after,
    async capture(filename, indicatorPid) {
      const status = await fixtureTools.command({ directory, command: 'capture-desktop', file: filename, indicatorPid });
      const bytes = await fs.readFile(path.join(directory, filename));
      const bands = edgeBands(bytes);
      return { bytes, bands, ...captureMetadata(status.lastCommand.capture, { filename, sha256: common.digest(bytes), width: bands.width, height: bands.height }) };
    },
    async close() {
      let forced = false;
      if (child.exitCode === null && child.signalCode === null) {
        try { await fixtureTools.command({ directory, command: 'close' }); }
        catch { forced = true; if (!child.kill()) throw common.failure('fixture_exit_unconfirmed', 'The exact glow fixture did not accept termination.'); }
        await common.waitFor(async () => child.exitCode !== null || child.signalCode !== null, Boolean, 'owned glow fixture exit', 5000);
      }
      return { exited: true, forced };
    } };
}
async function leaseFree() {
  const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
  await lease.acquire('replacement-glow-no-input-check'); await lease.release('replacement-glow-no-input-check'); return true;
}
function defaults() {
  return { ...common, verify: async () => { await common.verify(); await fixtureTools.verify(); },
    fixture: launchFixture, leaseFree, waitReference, waitSkyObservation, waitRegionReference, measureGlowRegion,
    claimRequest: continuation.claimRequest, claim: request => book.createBookkeeper().claim(request),
    sourceHashes: async () => { const value = await common.sourceHashes(DRIVER, 'glow-app');
      for (const name of ['scripts/continuation-adapter.cjs', 'scripts/live-acceptance-continuation.cjs', 'scripts/glow-reference-region.cjs']) value.files[name] = common.digest(await fs.readFile(path.join(common.ROOT, name)));
      value.runtimeOutputs = await continuation.runtimeSnapshot();
      value.runtimeOutputs['glow-fixture/manifest'] = common.digest(await fs.readFile(path.join(path.dirname(path.dirname(fixtureTools.BINARY)), 'manifest.json')));
      for (const extension of ['exe', 'dll', 'runtimeconfig.json', 'deps.json']) value.runtimeOutputs[`glow-fixture/TraceGlowFixture.${extension}`] = common.digest(await fs.readFile(path.join(path.dirname(fixtureTools.BINARY), `TraceGlowFixture.${extension}`)));
      return value; },
    notifyReady: value => process.stdout.write(JSON.stringify(value) + '\n'),
    runtimeRoot: path.join(common.ROOT, '.runtime', 'replacement-glow') };
}
async function run(input = {}, injected = {}) {
  const supplemental = input.continuationAttempt !== undefined;
  const options = supplemental ? continuation.options(input, CASE) : common.optionsFor(input, CASE), declaredOptions = plan(options);
  if (options.mode === 'plan') return declaredOptions;
  if (!options.referenceExecutor) throw common.failure('reference_missing', 'Confirm the actual external reference executor before launching this case.');
  if (supplemental && options.referenceExecutor !== 'Sky') throw common.failure('reference_missing', 'The supplemental region contract requires the actual Sky accessibility executor.');
  if (!supplemental && !Object.keys(injected).length) throw common.failure('invalid_retry', 'R31-GLOW-NATIVE historical budget is exhausted; use its actual approved continuation contract.');
  const deps = { ...defaults(), ...injected }, prior = supplemental ? null : await common.checkPrior(options);
  const display = common.validateDisplay(await deps.command(['display']));
  const declared = plan({ ...options, pinnedDisplay: display }), directory = path.resolve(options.directory);
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory); await fs.mkdir(path.join(directory, 'frames'));
  await common.writeJson(path.join(directory, 'plan.json'), declared);
  const receipt = { schemaVersion: 1, planContract: 1, caseId: CASE, replaces: declared.replaces, ownerDecision: options.ownerDecision, attempt: declared.attempt,
    ...(prior ? { prior } : {}), status: 'running', startedAt: new Date().toISOString(), display, phases: {}, frames: [], cleanup: {} };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await persist();
  let fixture, connection, session, chain, privateDirectory, target, abrupt = false;
  const captures = new Map();
  const sampleDisplay = async () => common.compareDisplay(await deps.command(['display']), display);
  async function capture(label, activeChain) {
    await sampleDisplay();
    if (activeChain) assert.deepEqual(await deps.readChain(connection), activeChain, 'Owned native/marker generations changed before capture.');
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const filename = `${label}-${attempt}.png`;
      try {
        const value = await fixture.capture(filename, activeChain?.marker.pid ?? 0);
        assert.equal(value.bands.width, display.displays[0].bounds.width); assert.equal(value.bands.height, display.displays[0].bounds.height);
        const file = `frames/${filename}`; await fs.writeFile(path.join(directory, file), value.bytes);
        receipt.frames.push({ label, path: file, sha256: common.digest(value.bytes), bands: value.bands,
          ...(value.captureMetadata ? { captureMetadata: value.captureMetadata, captureMetadataSha256: value.captureMetadataSha256, captureMetadataHashEncoding: value.captureMetadataHashEncoding } : {}),
          attempts: [...attempts, { attempt, status: 'pass' }] });
        captures.set(label, { bytes: value.bytes, sampledAt: new Date().toISOString(), interiorBackgroundVerified: value.interiorBackgroundVerified === true });
        return value.bands;
      } catch (error) {
        attempts.push({ attempt, code: error.code || /failed: ([a-z_]+)\./.exec(error.message || '')?.[1] || 'capture_refused' });
        receipt.captureRefusals = { ...(receipt.captureRefusals || {}), [label]: attempts }; await persist();
        if (attempt < 3) await deps.delay(100);
      }
    }
    throw common.failure('capture_refused', 'Three safe capture-only measurements were refused; no input was retried.');
  }
  async function keepMcpFrame(frame, label) {
    common.assertIdentity(frame.window, target);
    const bytes = Buffer.from(frame.screenshot.data, 'base64');
    assert.ok(bytes.length >= 24 && bytes.length <= 6 * 1024 * 1024 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(bytes.readUInt32BE(16), frame.bounds.width); assert.equal(bytes.readUInt32BE(20), frame.bounds.height);
    const file = `frames/${label}.png`; await fs.writeFile(path.join(directory, file), bytes, { flag: 'wx' });
    receipt.frames.push({ label, path: file, sha256: common.digest(bytes), observationId: frame.observationId, bounds: frame.bounds });
  }
  async function open(label) {
    connection = await deps.connect(path.join(directory, `mcp-${label}`)); abrupt = false;
    const doctor = await connection.call('doctor'); assert.equal(doctor.ready, true);
    const listed = await connection.call('list_windows'); const selected = listed.windows.find(value => value.pid === target.pid && value.id === target.id);
    assert.ok(selected); common.assertIdentity(selected, target);
    const before = await fixture.focus(); session = await connection.call('open_session', { windowId: target.id });
    if (!session.sessionId) throw common.failure(session.error?.code || 'session_open_failed', 'The exact glow target did not open.');
    assert.equal(session.activityIndicator?.monitors, 1); assert.equal(session.activityIndicator?.owner, 'native-supervisor');
    chain = await deps.readChain(connection); assertOwnershipSession(chain, target);
    const after = await fixture.focus(); assertFocus(before, after);
    return { before, after, ownership: chain };
  }
  async function closeLifecycle() {
    const began = performance.now();
    const closed = await connection.call('close_session', { sessionId: session.sessionId }); assert.equal(closed.closed, true); session = null;
    for (const role of ['supervisor', 'marker']) assert.equal(await deps.waitIdentityExit(chain[role], Math.max(1, 5000 - (performance.now() - began))), true);
    const ownerExitMs = performance.now() - began; assert.ok(ownerExitMs <= 5000);
    const bands = await capture('after-close'); assert.equal(glowAbsent(bands), true);
    await connection.close(); assert.equal(await deps.waitIdentityExit(chain.node), true);
    assert.deepEqual((await deps.command(['keystate', 'all'])).down, []); assert.equal((await deps.command(['status'])).recoveryRequired, false);
    assert.equal(await deps.leaseFree(), true); connection = null; chain = null;
    return { ownerExitMs, bands, helpersExited: true, leaseFree: true };
  }
  try {
    await deps.verify(); receipt.testedSource = await deps.sourceHashes();
    if ((await deps.command(['status'])).recoveryRequired !== false) throw common.failure('input_recovery_required', 'Existing or unavailable durable recovery blocks this replacement.');
    receipt.inputAccess = await deps.command(['input-access']);
    if (receipt.inputAccess.observable !== true) throw common.failure(receipt.inputAccess.code || 'input_state_unavailable', 'Foreground input cannot be independently inspected.');
    receipt.initialKeysDown = (await deps.command(['keystate', 'all'])).down;
    if (!Array.isArray(receipt.initialKeysDown) || receipt.initialKeysDown.length) throw common.failure('input_busy', 'Input was held or unavailable before this case; no fixture was launched.');
    if (supplemental) {
      assert.equal(await deps.leaseFree(), true);
      Object.assign(receipt, await deps.claim(await deps.claimRequest(options, CASE)), { attempt: declared.attempt });
      await persist();
    }
    privateDirectory = path.join(deps.runtimeRoot, randomUUID()); await fs.mkdir(privateDirectory, { recursive: true });
    fixture = await deps.fixture(privateDirectory); receipt.fixtureSha256 = fixture.sha256;
    const initial = await deps.waitFor(fixture.state, value => value?.ready && value.pid === fixture.pid, 'owned glow fixture readiness', 10000); assertCounts(initial, 0);
    receipt.initial = { count: initial.count, mouseClickCount: initial.mouseClickCount, activationCount: initial.activationCount, mouseDownCount: initial.mouseDownCount, mouseUpCount: initial.mouseUpCount };
    const identity = await deps.command(['identity', String(fixture.pid)]);
    target = { id: initial.windowId, pid: fixture.pid, processCreationTime: identity.processCreationTime, sessionId: identity.session }; receipt.target = target;
    assert.deepEqual(initial.monitor, display.displays[0].bounds); assert.equal(initial.dpi, display.displays[0].dpi); await sampleDisplay();
    const activated = await deps.bridge('activate', target); common.assertIdentity(activated, target); assert.equal(activated.foreground, true);
    if (supplemental) await capture('before-glow-reference');
    receipt.phases.start = await open('ordinary-close');
    const active = await capture('glow-active', chain); assert.equal(glowVisible(active), true); receipt.phases.visible = { bands: active };
    let point = referencePoint(await fixture.state()); const checkpointId = randomUUID(), startedAt = new Date().toISOString();
    const proofPath = path.join(privateDirectory, 'reference-proof.json'), pending = { target, point, executor: options.referenceExecutor, checkpointId, startedAt };
    const ready = { phase: 'REFERENCE_READY', caseId: CASE, target, point, executor: options.referenceExecutor, checkpointId, proofPath, waitMs: 60000,
      instruction: 'Send exactly one actual reference-executor left click; atomically write its real tool receipt metadata to proofPath. No TRACE substitute.' };
    if (supplemental) {
      const targetProof = { windowId: target.id, pid: target.pid, processCreationTime: target.processCreationTime, windowsSessionId: target.sessionId }, physicalDisplay = regionDisplay(display);
      const observationPath = path.join(privateDirectory, 'sky-observation.json');
      await persist(); // Publish the exact target before the external observer needs its identity.
      deps.notifyReady({ phase: 'SKY_OBSERVATION_READY', target, observationPath, waitMs: 60000,
        instruction: 'Observe the exact Sky accessibility edge button once without clicking; atomically retain actual observation metadata.' });
      const observation = await deps.waitSkyObservation(observationPath);
      // The initial visibility frame predates the external observation handshake.
      // Take genuinely new pixels here; never give an old capture a newer timestamp.
      const referenceBands = await capture('glow-reference-fresh', chain);
      assert.equal(glowVisible(referenceBands), true);
      const state = await fixture.state(), sample = { target: targetProof, display: physicalDisplay, sampledAt: new Date().toISOString() };
      assertCounts(state, 0); point = referencePoint(state);
      const referenceCapture = captures.get('glow-reference-fresh');
      const measured = deps.measureGlowRegion(captures.get('before-glow-reference').bytes, referenceCapture.bytes, state.button, display);
      const checkpoint = { executor: 'Sky', checkpointId, startedAt: new Date().toISOString(), target: targetProof, display: physicalDisplay, button: state.button,
        observation, initialFixture: regionFixture(state, sample),
        initialInput: { ...sample, sampledAt: new Date().toISOString(), source: 'independent-keystate-all', observable: true, keysDown: (await deps.command(['keystate', 'all'])).down },
        glow: { ...sample, sampledAt: referenceCapture.sampledAt, source: 'safe-pixel-measurement', coordinateSpace: 'physical-screen', verified: true,
          frameLabel: 'glow-reference-fresh', frameSha256: common.digest(referenceCapture.bytes),
          bounds: measured.bounds, leftTintedSamples: referenceBands.tintedLeft, topTintedSamples: referenceBands.tintedTop,
          interiorBackgroundVerified: referenceCapture.interiorBackgroundVerified && captures.get('before-glow-reference').interiorBackgroundVerified } };
      // All samples must precede the actual click checkpoint. Never extend sample age by restarting its clock.
      checkpoint.startedAt = new Date().toISOString();
      // Retain the exact private candidate before validation. Its existence never means that it passed.
      const candidateBytes = Buffer.from(JSON.stringify({ status: 'candidate-not-validated', checkpoint }, null, 2) + '\n');
      await fs.writeFile(path.join(privateDirectory, 'reference-checkpoint-candidate.json'), candidateBytes, { flag: 'wx' });
      receipt.referenceCheckpointCandidate = { status: 'candidate-not-validated', sha256: common.digest(candidateBytes),
        scope: 'Frozen before validation; no reference click or accepted checkpoint is implied.', checkpoint: { ...checkpoint, checkpointId: '<private-checkpoint>' } };
      await persist();
      try {
        region.validateCheckpoint(checkpoint, new Date().toISOString());
        receipt.referenceCheckpointValidation = { status: 'pass', checkedAt: new Date().toISOString() };
      } catch (error) {
        receipt.referenceCheckpointValidation = { status: 'fail', checkedAt: new Date().toISOString(), error: common.publicError(error) };
        await persist(); throw error;
      }
      await persist();
      deps.notifyReady({ ...ready, point, checkpoint, instruction: 'Send exactly one actual Sky accessibility mouse click on the observed element; retain its actual receipt metadata. No Invoke or replay.' });
      receipt.phases.reference = await deps.waitRegionReference(fixture, checkpoint, proofPath, async () => (await deps.command(['keystate', 'all'])).down);
      assert.equal(measured.containsTintedPoint(receipt.phases.reference.point), true, 'Actual reference point must hit a measured changed glow pixel.');
    } else {
      deps.notifyReady(ready); receipt.phases.reference = await deps.waitReference(fixture, pending, proofPath);
    }
    await deps.delay(150); const afterReference = await fixture.state();
    if (supplemental) assertCounts(afterReference, 1); else assertClick(afterReference, 1, point, startedAt);
    receipt.phases.reference.actualCounts = { count: afterReference.count, mouseClickCount: afterReference.mouseClickCount, activationCount: afterReference.activationCount,
      mouseDownCount: afterReference.mouseDownCount, mouseUpCount: afterReference.mouseUpCount };
    assert.deepEqual((await deps.command(['keystate', 'all'])).down, []); await persist();
    await sampleDisplay(); const frame = await connection.call('observe', { sessionId: session.sessionId }); common.assertIdentity(frame.window, target);
    if (supplemental) {
      const current = await fixture.state(); assertCounts(current, 1);
      assert.deepEqual(current.monitor, display.displays[0].bounds); assert.equal(current.dpi, display.displays[0].dpi);
      const geometry = await deps.bridge('bounds', target); common.assertIdentity(geometry, target);
      assert.equal(geometry.foreground, true); assert.deepEqual(geometry.frameBounds, frame.bounds);
      point = referencePoint(current); await sampleDisplay();
      assert.deepEqual((await deps.command(['keystate', 'all'])).down, []);
    }
    await keepMcpFrame(frame, 'mcp-before-click');
    const local = { x: point.x - frame.bounds.x, y: point.y - frame.bounds.y };
    assert.ok(Number.isInteger(local.x) && Number.isInteger(local.y) && local.x >= 0 && local.y >= 0 && local.x < frame.bounds.width && local.y < frame.bounds.height);
    const traceStartedAt = new Date().toISOString();
    const click = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'click', ...local } });
    assert.equal(click.outcome, 'completed'); await keepMcpFrame(click.observation, 'mcp-after-click'); await deps.delay(150); const afterTrace = await fixture.state(); assertClick(afterTrace, 2, point, traceStartedAt);
    receipt.phases.traceClick = { outcome: click.outcome, point: local, count: 2, mouseClickCount: afterTrace.mouseClickCount,
      activationCount: afterTrace.activationCount, mouseDownCount: afterTrace.mouseDownCount, mouseUpCount: afterTrace.mouseUpCount }; await persist();
    receipt.phases.ordinaryClose = await closeLifecycle(); await persist();
    receipt.phases.parentLossStart = await open('parent-loss'); const beforeLoss = await capture('before-parent-loss', chain); assert.equal(glowVisible(beforeLoss), true);
    const began = performance.now(); await connection.killAbruptly(); abrupt = true;
    for (const role of ['node', 'supervisor', 'marker']) assert.equal(await deps.waitIdentityExit(chain[role], Math.max(1, 5000 - (performance.now() - began))), true);
    const lossExitMs = performance.now() - began; assert.ok(lossExitMs <= 5000);
    const afterLoss = await capture('after-parent-loss'); assert.equal(glowAbsent(afterLoss), true); assertCounts(await fixture.state(), 2);
    await connection.close(); connection = null; session = null; chain = null;
    assert.deepEqual((await deps.command(['keystate', 'all'])).down, []); assert.equal((await deps.command(['status'])).recoveryRequired, false); assert.equal(await deps.leaseFree(), true);
    receipt.phases.parentLoss = { lossExitMs, beforeLoss, afterLoss, helpersExited: true, leaseFree: true, count: 2 }; receipt.status = 'pass';
  } catch (error) { receipt.status = common.statusFor(error); receipt.error = common.publicError(error); }
  finally {
    if (supplemental) receipt.primaryOutcome = { status: receipt.status, error: receipt.error ?? null };
    let owned = chain ? [chain.supervisor, chain.marker, chain.node] : [];
    if (connection && !chain) { try { owned = await deps.readOwned(connection); } catch (error) { receipt.cleanup.identityError = common.publicError(error); receipt.status = 'fail'; } }
    if (connection) {
      try { if (session?.sessionId && !abrupt) { const result = await connection.call('close_session', { sessionId: session.sessionId }); assert.equal(result.closed, true); } }
      catch (error) { receipt.cleanup.sessionError = common.publicError(error); receipt.status = 'fail'; }
      try { await connection.close(); receipt.cleanup.connectionClosed = true; } catch (error) { receipt.cleanup.connectionError = common.publicError(error); receipt.status = 'fail'; }
    }
    try { for (const identity of owned) assert.equal(await deps.waitIdentityExit(identity), true); receipt.cleanup.ownedHelpersExited = true; }
    catch (error) { receipt.cleanup.helperError = common.publicError(error); receipt.status = 'fail'; }
    try {
      if (fixture || connection) { receipt.cleanup.keysDown = (await deps.command(['keystate', 'all'])).down; assert.deepEqual(receipt.cleanup.keysDown, []); }
      else receipt.cleanup.noOwnedUiOrInputStarted = true;
    } catch (error) { receipt.cleanup.inputError = common.publicError(error); if (receipt.status !== 'fail') receipt.status = common.statusFor(error); }
    if (fixture) { try { receipt.cleanup.fixture = await fixture.close(); assert.equal(receipt.cleanup.fixture.exited, true); } catch (error) { receipt.cleanup.fixtureError = common.publicError(error); receipt.status = 'fail'; } }
    try { receipt.cleanup.recovery = await deps.command(['status']); if (fixture || connection) assert.equal(receipt.cleanup.recovery.recoveryRequired, false); }
    catch (error) { receipt.cleanup.recoveryError = common.publicError(error); receipt.status = 'fail'; }
    try { const after = await deps.sourceHashes(); receipt.sourcesUnchangedDuringRun = JSON.stringify(after.files) === JSON.stringify(receipt.testedSource?.files)
      && JSON.stringify(after.runtimeOutputs) === JSON.stringify(receipt.testedSource?.runtimeOutputs); if (receipt.testedSource && !receipt.sourcesUnchangedDuringRun) receipt.status = 'fail'; }
    catch (error) { receipt.cleanup.sourceError = common.publicError(error); receipt.status = 'fail'; }
    try { await deps.verify(); receipt.cleanup.outputManifestsVerified = true; }
    catch (error) { receipt.cleanup.outputError = common.publicError(error); receipt.status = 'fail'; }
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}
if (require.main === module) run(parseArgs(process.argv.slice(2))).then(value => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); if (value.status && value.status !== 'pass') process.exitCode = 1; })
  .catch(error => { process.stderr.write(common.publicError(error).message + '\n'); process.exitCode = 1; });
module.exports = { CASE, plan, parseArgs, assertFocus, assertOwnershipSession, assertCounts, assertClick, referencePoint, assertReferenceProof, waitReference,
  regionDisplay, regionFixture, measureGlowRegion, waitRegionReference, readFixtureState, captureMetadata, run };
