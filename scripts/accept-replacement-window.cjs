#!/usr/bin/env node
'use strict';

// A proposed replacement case. It cannot retry/promote A3-WINDOW, and never runs on import/--plan.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const common = require('./replacement-acceptance-common.cjs');
const CASE = 'R3-WINDOW-COORDINATES';
const DRIVER = 'scripts/accept-replacement-window.cjs';

function plan(input = {}) {
  const options = common.optionsFor(input, CASE);
  return { schemaVersion: 1, planContract: 1, caseId: CASE, replaces: ['A3-WINDOW'], historicalStatus: 'exhausted fail; focused regression kept separate',
    attempt: options.attempt, ownerDecision: options.ownerDecision ?? null, executionRequiresExplicitOwnerDecision: true, declaredBeforeUiLaunch: true,
    display: options.pinnedDisplay ?? 'Observe/pin the actual native single-monitor device, primary flag, physical bounds, DPI and capture geometry before UI.',
    target: 'Fresh owned synthetic WinForms fixture, exact HWND/PID/creation time/session', initial: { count: 0, text: '', keysDown: [], recoveryRequired: false },
    actions: ['Observe target; command one move; stale invoke must be not_dispatched/window_moved with count0',
      'Fresh observation; one measured coordinate counter click gives count1',
      'Observe target; command one minimize; stale invoke must be not_dispatched/window_moved with count1',
      'Fresh observation restores/settles target; one measured coordinate counter click gives count2'],
    expected: { finalCount: 2, text: '', maximumPrimaryClicks: 2, staleRejections: 2, released: true },
    cleanup: ['Settle native work, close session and MCP', 'Verify exact native owner/marker/Node exit',
      'Independently verify all input up while fixture remains accessible', 'Close exact owned fixture', 'Persist terminal receipt even on cleanup failure'],
    budget: 'One attempt plus one same-case corrective attempt with prior evidence and explicit changed precondition; no automatic replay.',
    limits: ['Selected single-monitor mode only', 'Owned fixture via actual MCP; no host/release acceptance', 'No rerun of depth/dialog or exhausted historical IDs'] };
}
function parseArgs(args) { return common.parseArgs(args, CASE); }
function counter(frame) {
  const matches = frame.elements.filter(value => value.name === 'Increment counter' && value.enabled);
  assert.equal(matches.length, 1, 'A unique enabled counter must be observed.'); return matches[0];
}
function center(frame, element = counter(frame)) {
  const bounds = element.bounds, area = frame.bounds;
  assert.ok(bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0);
  const point = { x: Math.floor(bounds.x + bounds.width / 2 - area.x), y: Math.floor(bounds.y + bounds.height / 2 - area.y) };
  assert.ok(point.x >= 0 && point.y >= 0 && point.x < area.width && point.y < area.height, 'Counter center must be inside current screenshot pixels.');
  return point;
}
function assertStale(result, before, after) {
  assert.equal(result.outcome, 'not_dispatched'); assert.equal(result.error?.code, 'window_moved');
  assert.equal(after.count, before.count); assert.equal(after.text, before.text); assert.equal(after.dialogOpen, before.dialogOpen);
}
function assertOwnershipSession(chain, target) {
  if (!Number.isInteger(target?.sessionId) || target.sessionId < 0
    || !['node', 'supervisor', 'marker'].every(role => Number.isInteger(chain?.[role]?.sessionId) && chain[role].sessionId === target.sessionId))
    throw common.failure('owner_identity_changed', 'The owned Node, supervisor and marker must have observable Windows sessions matching the exact target.');
  return chain;
}
function assertGeometry(frame, native, independent, target) {
  common.assertIdentity(frame.window, target); common.assertIdentity(native, target);
  assert.equal(native.minimized, false); assert.equal(independent.minimized, false);
  assert.equal(frame.screenshot.width, frame.bounds.width); assert.equal(frame.screenshot.height, frame.bounds.height);
  const outer = native.windowBounds;
  assert.deepEqual(outer, { x: independent.windowX, y: independent.windowY, width: independent.windowWidth, height: independent.windowHeight });
  const capture = frame.bounds, available = native.frameBounds;
  assert.ok(capture.width > 0 && capture.height > 0 && capture.x >= available.x && capture.y >= available.y
    && capture.x + capture.width <= available.x + available.width && capture.y + capture.height <= available.y + available.height,
  'PNG geometry must stay inside independently queried native frame bounds.');
  center(frame);
}
function defaults() {
  return { ...common, sourceHashes: () => common.sourceHashes(DRIVER), fixture: common.launchComputerFixture,
    runtimeRoot: path.join(common.ROOT, '.runtime', 'replacement-window') };
}

async function run(input = {}, injected = {}) {
  const options = common.optionsFor(input, CASE);
  if (options.mode === 'plan') return plan(options);
  const deps = { ...defaults(), ...injected };
  const prior = await common.checkPrior(options);
  const display = common.validateDisplay(await deps.command(['display']));
  const declared = plan({ ...options, pinnedDisplay: display });
  const directory = path.resolve(options.directory); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
  await common.writeJson(path.join(directory, 'plan.json'), declared); await fs.mkdir(path.join(directory, 'frames'));
  const receipt = { schemaVersion: 1, planContract: 1, caseId: CASE, replaces: declared.replaces, ownerDecision: options.ownerDecision,
    attempt: options.attempt, ...(prior ? { prior } : {}), status: 'running', startedAt: new Date().toISOString(), display, transitions: [], frames: [], cleanup: {} };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await persist();
  let fixture, connection, session, chain;
  const sampleDisplay = async () => common.compareDisplay(await deps.command(['display']), display);
  async function keep(frame, label) {
    const bytes = Buffer.from(frame.screenshot.data, 'base64');
    assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(bytes.readUInt32BE(16), frame.screenshot.width); assert.equal(bytes.readUInt32BE(20), frame.screenshot.height);
    assert.ok(bytes.length <= 6 * 1024 * 1024);
    const file = `frames/frame-${String(receipt.frames.length + 1).padStart(2, '0')}.png`;
    await fs.writeFile(path.join(directory, file), bytes);
    receipt.frames.push({ label, path: file, sha256: common.digest(bytes), observationId: frame.observationId, bounds: frame.bounds });
    return frame;
  }
  try {
    await deps.verify(); receipt.testedSource = await deps.sourceHashes();
    if ((await deps.command(['status'])).recoveryRequired) throw common.failure('input_recovery_required', 'Existing durable recovery blocks this replacement; it was not cleared.');
    receipt.inputAccess = await deps.command(['input-access']);
    if (receipt.inputAccess.observable !== true) throw common.failure(receipt.inputAccess.code || 'input_state_unavailable', 'Foreground input state is inaccessible; no fixture/input was started.');
    receipt.initialKeysDown = (await deps.command(['keystate', 'all'])).down;
    if (receipt.initialKeysDown.length) throw common.failure('input_busy', 'Input was held before fixture creation; no takeover started.');
    const privateDirectory = path.join(deps.runtimeRoot, randomUUID()); await fs.mkdir(privateDirectory, { recursive: true });
    fixture = await deps.fixture(privateDirectory); receipt.fixtureSha256 = fixture.sha256;
    const initial = await deps.waitFor(fixture.state, value => value?.revision > 0, 'owned fixture readiness', 15000);
    assert.equal(initial.count, 0); assert.equal(initial.text, ''); assert.equal(initial.minimized, false);
    await sampleDisplay();
    connection = await deps.connect(path.join(directory, 'mcp'));
    const doctor = await connection.call('doctor'); assert.equal(doctor.ready, true);
    const listed = await connection.call('list_windows');
    const matches = listed.windows.filter(value => value.pid === fixture.pid && value.title === fixture.title);
    assert.equal(matches.length, 1); const target = matches[0];
    assert.match(target.processCreationTime, /^\d+$/); assert.ok(Number.isInteger(target.sessionId));
    const identity = await deps.command(['identity', String(fixture.pid)]);
    assert.equal(target.processCreationTime, identity.processCreationTime); assert.equal(target.sessionId, identity.session);
    receipt.target = { id: target.id, pid: target.pid, processCreationTime: target.processCreationTime, sessionId: target.sessionId };
    session = await connection.call('open_session', { windowId: target.id });
    if (!session.sessionId) throw common.failure(session.error?.code || 'session_open_failed', 'The exact owned target did not open.');
    chain = await deps.readChain(connection); receipt.ownership = chain;
    assertOwnershipSession(chain, target);
    for (const op of ['move', 'minimize']) {
      await sampleDisplay();
      const old = await keep(await connection.call('observe', { sessionId: session.sessionId }), `before ${op}`);
      const before = await fixture.state(); assert.equal(before.count, op === 'move' ? 0 : 1); assert.equal(before.text, '');
      await fixture.command(op, value => op === 'minimize' ? value.minimized : !value.minimized && (value.windowX !== before.windowX || value.windowY !== before.windowY));
      const stale = await connection.call('act', { sessionId: session.sessionId, observationId: old.observationId, action: { type: 'invoke', elementId: counter(old).id } });
      await deps.delay(150); const rejectedState = await fixture.state(); assertStale(stale, before, rejectedState);
      const fresh = await keep(await connection.call('observe', { sessionId: session.sessionId }), `fresh after ${op}`);
      const independent = await fixture.state();
      assertGeometry(fresh, await deps.bridge('bounds', target), independent, target);
      if (op === 'minimize') assert.equal(fresh.preparation?.some(value => value.step === 'restore' && value.status === 'restored'), true);
      await sampleDisplay(); const point = center(fresh);
      const hit = await connection.call('act', { sessionId: session.sessionId, observationId: fresh.observationId, action: { type: 'click', ...point } });
      assert.equal(hit.outcome, 'completed'); await keep(hit.observation, `counter hit after ${op}`);
      const after = await deps.waitFor(fixture.state, value => value?.count === before.count + 1, 'exact counter increment', 4000);
      await deps.delay(150); const settled = await fixture.state();
      assert.equal(settled.count, before.count + 1); assert.equal(settled.text, ''); assert.equal(settled.minimized, false);
      assert.deepEqual((await deps.command(['keystate', 'all'])).down, []);
      receipt.transitions.push({ op, before: { count: before.count, minimized: before.minimized }, stale: { outcome: stale.outcome, code: stale.error.code, count: rejectedState.count },
        freshBounds: fresh.bounds, restoredByObservation: op === 'minimize', point, hitOutcome: hit.outcome, countAfter: after.count, stableCount: settled.count });
      await persist();
    }
    receipt.status = 'pass';
  } catch (error) { receipt.status = common.statusFor(error); receipt.error = common.publicError(error); }
  finally {
    // Keep the owned foreground fixture alive until native teardown and independent input checks finish.
    let owned = chain ? [chain.supervisor, chain.marker, chain.node] : [];
    if (connection && !chain) {
      try { owned = await deps.readOwned(connection); }
      catch (error) { receipt.cleanup.identityError = common.publicError(error); receipt.status = 'fail'; }
    }
    if (connection) {
      try {
        if (session?.sessionId) { const result = await connection.call('close_session', { sessionId: session.sessionId }); assert.equal(result.closed, true); }
      } catch (error) { receipt.cleanup.sessionError = common.publicError(error); receipt.status = 'fail'; }
      try { await connection.close(); receipt.cleanup.connectionClosed = true; }
      catch (error) { receipt.cleanup.connectionError = common.publicError(error); receipt.status = 'fail'; }
    }
    if (owned.length) {
      try { for (const identity of owned) assert.equal(await deps.waitIdentityExit(identity), true); receipt.cleanup.ownedHelpersExited = true; }
      catch (error) { receipt.cleanup.helperError = common.publicError(error); receipt.status = 'fail'; }
    }
    try {
      if (fixture || connection) { receipt.cleanup.keysDown = (await deps.command(['keystate', 'all'])).down; assert.deepEqual(receipt.cleanup.keysDown, []); }
      else receipt.cleanup.noOwnedUiOrInputStarted = true;
    }
    catch (error) { receipt.cleanup.inputError = common.publicError(error); if (receipt.status !== 'fail') receipt.status = common.statusFor(error); }
    if (fixture) {
      try { receipt.cleanup.fixture = await fixture.close(); assert.equal(receipt.cleanup.fixture.exited, true); }
      catch (error) { receipt.cleanup.fixtureError = common.publicError(error); receipt.status = 'fail'; }
    }
    try { receipt.cleanup.recovery = await deps.command(['status']); if (fixture || connection) assert.equal(receipt.cleanup.recovery.recoveryRequired, false); }
    catch (error) { receipt.cleanup.recoveryError = common.publicError(error); receipt.status = 'fail'; }
    try { const after = await deps.sourceHashes(); receipt.sourcesUnchangedDuringRun = JSON.stringify(after.files) === JSON.stringify(receipt.testedSource?.files); if (receipt.testedSource && !receipt.sourcesUnchangedDuringRun) receipt.status = 'fail'; }
    catch (error) { receipt.cleanup.sourceError = common.publicError(error); receipt.status = 'fail'; }
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}
if (require.main === module) run(parseArgs(process.argv.slice(2))).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.status && result.status !== 'pass') process.exitCode = 1;
}).catch(error => { process.stderr.write(common.publicError(error).message + '\n'); process.exitCode = 1; });
module.exports = { CASE, plan, parseArgs, center, assertStale, assertGeometry, assertOwnershipSession, run };
