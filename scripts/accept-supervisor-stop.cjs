#!/usr/bin/env node
'use strict';

// Requires a real physical Escape for MOUSE/KEYBOARD. It never synthesizes the event used to pass
// those cases. The separate INJECTED case exercises an ordinary pinned-engine Escape action.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { supervisorSourceHashes } = require('../src/computer/supervisor.cjs');
const { buildFixture } = require('./smoke-computer-live.cjs');
const { validateDisplay, compareDisplay } = require('./accept-supervisor-recovery.cjs');
const { command, waitFor, exited, connect, open, followup } = require('./accept-supervisor-quarantine.cjs');
const ROOT = path.resolve(__dirname, '..'), execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const CASES = ['mouse', 'keyboard', 'injected'];
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const isAccess = code => /^(?:input_busy|desktop_busy|display_mismatch|input_desktop_unavailable|input_state_unavailable|foreground_[a-z_]+|physical_tap_[a-z_]+)$/.test(code || '');

function plan(options = {}) {
  const selected = options.caseName || 'mouse';
  if (!CASES.includes(selected)) throw new Error('Select mouse, keyboard or injected.');
  return { schemaVersion: 1, caseId: `A32-STOP-${selected.toUpperCase()}`, caseName: selected, attempt: options.attempt ?? 1,
    declaredBeforeUiLaunch: true,
    ...(options.prior ? { prior: path.relative(ROOT, path.resolve(options.prior)).replaceAll(path.sep, '/'), changedPrecondition: options.change } : {}),
    display: options.pinnedDisplay ?? 'Actual single-monitor device/bounds/DPI pinned at live preflight.',
    target: 'Fresh exact owned synthetic WinForms fixture; public focus identity independently checked',
    physicalRequired: selected !== 'injected', preparationWaitSeconds: 60, physicalObservationWaitSeconds: 60,
    inputOperationDeadlineMs: 15000, input: selected === 'keyboard' ? 'Source-owned type-hold abc; final C held, no Ctrl/Alt/Shift+Escape OS shortcut' : selected === 'mouse' ? 'Source-owned left-button hold at a measured empty fixture point' : 'Pinned engine press_key ESCAPE',
    phases: selected === 'injected' ? ['Focus owned edit', 'Send one ordinary MCP ESCAPE through the pinned engine', 'Verify completed result, no physical stop, balanced input and exactly one usable counter follow-up']
      : ['Prepare owned fixture/session/focus; publish private PREPARED start/ready paths before any held input',
        'Wait at most 60 seconds for root to create the start file; rediscover fresh target evidence',
        'Start one controlled held-input operation, independently confirm held state, publish READY file',
        'Request one actual physical Escape immediately; the 15-second production operation deadline remains unchanged',
        'Verify native physical metadata/latency <=1000ms, actual child exit and all-up within 15000ms, and no later dispatch admission',
        'Verify the stopped session rejects a later action until explicitly closed; a new planned session performs one different counter action'],
    lateTap: 'If native timeout releases input before the actual key arrives, stop this case as blocked; never re-hold or replay automatically.',
    expected: { physical: selected !== 'injected', exactFollowupIncrement: 1, cleanupKeysDown: [], cleanupRecoveryRequired: false },
    limits: ['MOUSE/KEYBOARD pass only from a real non-injected low-level hook event. Synthetic events cannot pass them.',
      'Held provider is controlled; focus setup, injected Escape case and counter follow-up use the pinned engine.',
      'Literal held C may autorepeat in the synthetic edit; exact text is retained and must stop changing after cleanup.'],
    budget: 'One attempt plus one corrective retry with matching previous case and explicit changed precondition; preserve every outcome.' };
}
function parseArgs(args) {
  const options = { mode: 'plan', caseName: 'mouse', attempt: 1 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--plan') options.mode = 'plan';
    else if (arg === '--live') options.mode = 'live';
    else if (arg === '--case') options.caseName = args[++i];
    else if (arg === '--attempt') options.attempt = Number(args[++i]);
    else if (arg === '--prior') options.prior = args[++i];
    else if (arg === '--change') options.change = args[++i];
    else if (!arg.startsWith('--') && !options.directory) options.directory = arg;
    else throw new Error('Usage: accept-supervisor-stop.cjs [new-directory] --plan|--live --case mouse|keyboard|injected [--attempt 2 --prior directory --change description]');
  }
  if (![1, 2].includes(options.attempt) || (options.mode === 'live' && !options.directory)
    || (options.attempt === 2 && (!options.prior || !options.change)) || (options.attempt === 1 && (options.prior || options.change))) throw new Error('A corrective retry requires previous evidence and a changed precondition.');
  plan(options); return options;
}
function assertStopMetadata(event) {
  assert.equal(event.code, 'physical_escape'); assert.equal(event.physical, true);
  assert.ok(Number.isFinite(event.stopLatencyMs) && event.stopLatencyMs >= 0 && event.stopLatencyMs <= 1000, 'Native physical-stop latency must be at most one second.');
  assert.ok(Number.isSafeInteger(event.dispatchCount) && event.dispatchCount >= 1, 'Native dispatch count is required.');
  return event;
}
function assertNoNewDispatch(events, stopped) {
  assertStopMetadata(stopped);
  for (const event of events.filter(value => value.type === 'native-dispatch')) {
    assert.ok(Number.isSafeInteger(event.dispatchCount), 'Every native admission needs its counter.');
    assert.ok(event.dispatchCount <= stopped.dispatchCount, 'A native dispatch was admitted after the stop snapshot.');
  }
}
function assertCleanupMetadata(finished) {
  assert.equal(finished.code, 'physical_escape'); assert.equal(finished.outcome, 'unknown');
  const recovery = finished.recovery;
  assert.equal(recovery?.released, true); assert.equal(recovery?.processExitConfirmed, true); assert.equal(recovery?.reason, 'physical_escape');
  assert.ok(Number.isFinite(recovery?.stopCleanupMs) && recovery.stopCleanupMs >= 0 && recovery.stopCleanupMs <= 15000,
    'Native hook timestamp to verified release must remain within the operation deadline.');
  return recovery;
}
async function freshFrame(connection, session, display) {
  compareDisplay(await command(['display']), display);
  return connection.call('observe', { sessionId: session.sessionId });
}

async function run(options = {}) {
  options = { mode: 'plan', caseName: 'mouse', attempt: 1, ...options };
  if (options.mode === 'plan') return plan(options);
  const display = validateDisplay(await command(['display'])), declared = plan({ ...options, pinnedDisplay: display });
  if (options.attempt === 2) {
    const previous = JSON.parse(await fs.readFile(path.join(path.resolve(options.prior), 'receipt.json'), 'utf8'));
    assert.equal(previous.caseId, declared.caseId); assert.equal(previous.attempt, 1); assert.ok(['fail', 'blocked'].includes(previous.status));
  }
  const directory = path.resolve(options.directory); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
  await writeJson(path.join(directory, 'plan.json'), declared);
  const receipt = { schemaVersion: 1, caseId: declared.caseId, attempt: declared.attempt, status: 'running', display, startedAt: new Date().toISOString(), cleanup: {} };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await persist();
  let fixture, connection, abort, controlled, pendingOutcome;
  try {
    const files = await supervisorSourceHashes();
    for (const name of ['scripts/accept-supervisor-stop.cjs', 'scripts/accept-supervisor-quarantine.cjs', 'tests/fixtures/supervised-mcp.cjs', 'src/computer/supervisor.cjs', 'src/computer/controller.cjs', 'src/computer/server.cjs', 'src/computer/winapp-backend.cjs']) files[name] = sha256(await fs.readFile(path.join(ROOT, name)));
    receipt.testedSource = { baseCommit: (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true })).stdout.trim(), workingTreeModified: true, files };
    assert.equal((await command(['status'])).recoveryRequired, false);
    const executable = await buildFixture(), runId = `stop-${randomUUID()}`, statePath = path.join(directory, 'fixture.json');
    receipt.fixtureSha256 = sha256(await fs.readFile(executable));
    compareDisplay(await command(['display']), display);
    const child = spawn(executable, ['--run-id', runId, '--receipt', statePath, '--commands', path.join(directory, 'fixture-commands.json')], { windowsHide: false, stdio: 'ignore' });
    fixture = { pid: child.pid, child, title: `TRACE Computer Fixture — ${runId}`,
      state: async () => { try { return JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } } };
    const initial = await waitFor(fixture.state, Boolean, 'owned fixture'); assert.equal(initial.count, 0); assert.equal(initial.text, '');
    receipt.initialKeysDown = (await command(['keystate', 'all'])).down;
    if (receipt.initialKeysDown.length) throw Object.assign(new Error('Input was held before this case; no input dispatched.'), { code: 'input_busy' });
    const mode = options.caseName === 'keyboard' ? 'typing' : options.caseName === 'mouse' ? 'mouse' : 'none';
    connection = await connect(path.join(directory, 'primary'), mode, false, { operationTimeoutMs: declared.inputOperationDeadlineMs });
    const { target, session } = await open(connection, fixture);
    receipt.target = { pid: target.pid, processCreationTime: target.processCreationTime, windowId: target.id };
    let frame = await freshFrame(connection, session, display);
    const edit = frame.elements.find(element => element.name === 'TRACE text input'); assert.ok(edit?.enabled);
    const focus = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'click', elementId: edit.id } });
    assert.equal(focus.outcome, 'completed'); assert.equal(focus.observation.focused?.elementId, edit.id);
    assert.equal((await fixture.state()).focusedControl, 'traceTextInput'); frame = focus.observation;
    await fs.writeFile(path.join(directory, 'focused.png'), Buffer.from(frame.screenshot.data, 'base64'));
    if (options.caseName === 'injected') {
      const escape = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'press_key', key: 'ESCAPE' } });
      assert.equal(escape.outcome, 'completed'); await delay(200);
      const journal = await connection.journal();
      assert.equal(journal.events.some(event => event.type === 'native-stopped'), false);
      assert.deepEqual((await command(['keystate', 'all'])).down, []);
      receipt.injectedEscape = { outcome: escape.outcome, physicalStopSeen: false, provider: 'pinned-engine' };
      await connection.call('close_session', { sessionId: session.sessionId }); await connection.close();
    } else {
      const privateDirectory = path.join(ROOT, '.runtime', 'physical-stop', randomUUID()); await fs.mkdir(privateDirectory, { recursive: true });
      const startPath = path.join(privateDirectory, 'start.json'), readyPath = path.join(privateDirectory, 'ready.json');
      receipt.prepared = { at: new Date().toISOString(), source: 'owned fixture/session/focus ready; no held operation started', preparationWaitSeconds: 60 }; await persist();
      process.stdout.write(JSON.stringify({ phase: 'PREPARED', caseId: declared.caseId, startPath, readyPath, preparationWaitSeconds: 60, instruction: 'Root may now arm one actual physical-key case by writing {"start":true} to startPath.' }) + '\n');
      await waitFor(async () => { try { return JSON.parse(await fs.readFile(startPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, value => value?.start === true, 'root start gate', 60000);
      frame = await freshFrame(connection, session, display);
      assert.equal(frame.focused?.elementId, edit.id); assert.equal((await fixture.state()).focusedControl, 'traceTextInput');
      assert.deepEqual((await command(['keystate', 'all'])).down, []);
      const action = options.caseName === 'keyboard' ? { type: 'type_text', text: 'abc' }
        : { type: 'drag', fromX: frame.bounds.width - 40, fromY: frame.bounds.height - 40, toX: frame.bounds.width - 39, toY: frame.bounds.height - 40 };
      abort = new AbortController();
      const pending = connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action }, { signal: abort.signal });
      pendingOutcome = pending.then(value => ({ value }), error => ({ error: { code: String(error.code || 'transport_error') } }));
      const journal = await waitFor(connection.journal, value => value.events.some(event => event.type === 'controlled-dispatch'), 'controlled held dispatch');
      controlled = journal.events.find(event => event.type === 'controlled-dispatch'); receipt.controlled = controlled;
      const keys = options.caseName === 'keyboard' ? [67] : [1];
      receipt.held = await waitFor(async () => (await command(['keystate', keys.join(',')])).keys, value => keys.every(key => value[String(key)] === true), 'independently held input', 4000);
      const ready = { phase: 'READY', caseId: declared.caseId, at: new Date().toISOString(), actualPhysicalTapRequired: true,
        instruction: 'Press physical Escape now once.', heldOperationDeadlineMs: 15000, observationWaitSeconds: 60, inputChildPid: controlled.pid };
      await writeJson(readyPath, ready); receipt.ready = { ...ready, readyFilePublished: true }; await persist();
      process.stdout.write(JSON.stringify(ready) + '\n');
      const physical = await waitFor(connection.journal, value => {
        if (value.events.some(event => event.type === 'native-stopped' && event.code === 'physical_escape')) return true;
        if (value.events.some(event => event.type === 'controlled-finished' && event.code === 'native_timeout'))
          throw Object.assign(new Error('The production deadline released held input before the actual physical tap; no replay.'), { code: 'physical_tap_late' });
        return false;
      }, 'actual physical Escape', 60000);
      const stopped = physical.events.find(event => event.type === 'native-stopped' && event.code === 'physical_escape'); assertStopMetadata(stopped);
      receipt.stop = stopped; const cleanupStarted = performance.now(); await persist();
      receipt.childExitIndependently = await exited(controlled.pid, 15000);
      await waitFor(async () => (await command(['keystate', 'all'])).down, value => value.length === 0, 'independently balanced physical stop', 15000);
      // This independent observation starts when the journal stop is read. Only the native receipt
      // below measures from the actual hook timestamp; do not imply cross-process clock precision.
      receipt.independentCleanupAfterStopObservedMs = Math.round(performance.now() - cleanupStarted);
      assert.ok(receipt.independentCleanupAfterStopObservedMs <= 15000);
      const finishedJournal = await waitFor(connection.journal, value => value.events.some(event => event.type === 'controlled-finished'), 'physical-stop cleanup receipt');
      const finished = finishedJournal.events.find(event => event.type === 'controlled-finished');
      receipt.nativeCleanupAfterPhysicalHookMs = assertCleanupMetadata(finished).stopCleanupMs;
      receipt.operation = finished;
      const after = await fixture.state(); await delay(100); const stable = await fixture.state(); assert.equal(after.count, 0); assert.equal(stable.text, after.text);
      if (options.caseName === 'keyboard') assert.match(after.text, /^abc+$/); else assert.equal(after.text, '');
      receipt.effect = { text: after.text, count: after.count, stableAfterStop: true };
      const button = frame.elements.find(element => element.name === 'Increment counter'); assert.ok(button);
      const blocked = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'invoke', elementId: button.id } });
      assert.ok(['session_stopped', 'indicator_not_active'].includes(blocked.error?.code)); assert.equal((await fixture.state()).count, 0);
      const last = await connection.journal(); assertNoNewDispatch(last.events, stopped);
      receipt.subsequentAction = { code: blocked.error.code, admittedAfterStop: 0, dispatchCountAtStop: stopped.dispatchCount };
      assert.equal((await command(['status'])).recoveryRequired, false);
      await connection.call('close_session', { sessionId: session.sessionId }); await connection.close();
      assert.equal(await exited(controlled.supervisorPid), true); await pendingOutcome;
    }
    receipt.followup = await followup(path.join(directory, 'planned-new-session-followup'), fixture, display);
    receipt.status = 'pass';
  } catch (error) {
    receipt.status = isAccess(error.code) ? 'blocked' : 'fail';
    receipt.error = { code: String(error.code || 'assertion_failed'), message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 500), win32Error: error.win32Error ?? null };
  } finally {
    abort?.abort();
    try { if (connection) { await connection.close(); receipt.cleanup.connectionClosed = true; } }
    catch (error) { receipt.cleanup.connectionError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    if (controlled) {
      try { receipt.cleanup.childExited = await exited(controlled.pid); if ((await command(['status'])).recoveryRequired) receipt.cleanup.recoveryApply = await command(['recover', '--apply']); }
      catch (error) { receipt.cleanup.inputError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    }
    try { receipt.cleanup.inputState = { available: true, phase: 'native closed; fixture remains', down: (await command(['keystate', 'all'])).down }; if (receipt.cleanup.inputState.down.length) receipt.status = 'fail'; }
    catch (error) { receipt.cleanup.inputState = { available: false, code: String(error.code || 'input_state_unavailable'), win32Error: error.win32Error ?? null }; if (receipt.status !== 'fail') receipt.status = 'blocked'; }
    if (fixture) { try { fixture.child.kill(); receipt.cleanup.fixtureExited = await exited(fixture.pid, 5000); } catch (error) { receipt.cleanup.fixtureError = String(error.code || 'fixture_exit_unconfirmed'); receipt.status = 'fail'; } }
    try { receipt.cleanup.recovery = await command(['status']); if (receipt.cleanup.recovery.recoveryRequired) receipt.status = 'fail'; }
    catch (error) { receipt.cleanup.recovery = { available: false, code: String(error.code || 'recovery_unavailable') }; receipt.status = 'fail'; }
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).then(receipt => {
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); if (receipt.status && receipt.status !== 'pass') process.exitCode = 1;
}).catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
module.exports = { plan, parseArgs, assertStopMetadata, assertNoNewDispatch, assertCleanupMetadata, run };
