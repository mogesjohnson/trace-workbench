#!/usr/bin/env node
'use strict';

// A real held-input/failure-acknowledgement case. The injected failure occurs only after a separate
// helper verifies native child exit and released input. Importing this module performs no UI work.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { DEFAULT_SUPERVISOR } = require('../src/computer/supervisor.cjs');
const { buildFixture } = require('./smoke-computer-live.cjs');
const { validateDisplay, compareDisplay, stateOf } = require('./accept-supervisor-recovery.cjs');
const { validate: validatePrivateConfiguration } = require('../tests/fixtures/supervised-mcp.cjs');
const ROOT = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const INPUTS = ['mouse', 'chord', 'typing'];
const KEYS = { mouse: [1], chord: [0xA2, 0xA0], typing: [0x43] };
const accessCode = code => /^(?:input_busy|desktop_busy|display_mismatch|input_desktop_unavailable|input_state_unavailable|foreground_[a-z_]+)$/.test(code || '');
const continuation = require('./continuation-adapter.cjs');
const continuationBook = require('./live-acceptance-continuation.cjs');
const TYPING_CASE = 'A32-QUARANTINE-ACK-TYPING';

function plan(options = {}) {
  const input = options.input || 'mouse';
  if (!INPUTS.includes(input)) throw new Error('Input must be mouse, chord or typing.');
  const supplemental = options.continuationAttempt !== undefined ? continuation.options(options, TYPING_CASE) : null;
  if (supplemental && input !== 'typing') throw new Error('Only the exhausted typing ACK case has this supplemental contract.');
  return { schemaVersion: 1, caseId: `A32-QUARANTINE-ACK-${input.toUpperCase()}`, input, attempt: options.attempt ?? 1,
    ...(supplemental ? { attempt: supplemental.lifetimeAttemptOrdinal, historicalAttemptsUsed: 2,
      continuationAttempt: supplemental.continuationAttempt, lifetimeAttemptOrdinal: supplemental.lifetimeAttemptOrdinal,
      contract: supplemental.contract, decisionRef: supplemental.decisionRef ?? null,
      idleReadinessRequiredBeforeClaim: true, stableOwnedForegroundAnchorRequired: true } : {}),
    declaredBeforeUiLaunch: true,
    ...(options.prior ? { prior: path.relative(ROOT, path.resolve(options.prior)).replaceAll(path.sep, '/'), changedPrecondition: options.change } : {}),
    display: options.pinnedDisplay ?? 'Observe and pin the actual single-monitor device, physical bounds and DPI before the live plan/owned UI.',
    target: 'Fresh owned synthetic WinForms fixture, exact discovered HWND/PID/creation time',
    initial: { text: '', count: 0, keysDown: [], recoveryRequired: false },
    phases: ['Focus the observed edit through production MCP/controller/native supervision',
      'Dispatch one labeled source-owned held-input provider through a private test backend; independently observe input held',
      'Cancel with the standard MCP AbortSignal; native kills/drains its job and REALLY balances declared input',
      'Native private checkpoint pauses after actual release; external helper independently verifies child exit and all keys up, and persists proof',
      'Only then a private file acknowledgement requests the deliberate failed-cleanup-ack injection; native retains durable quarantine',
      'Verify same-session mutation blocked, non-clearing recovery checks, and a restarted MCP process with another artifact root blocked',
      'Apply recovery after exact native owner exit, independently verify clear state, then perform exactly one pinned-engine follow-up'],
    cleanup: 'Close native/MCP ownership, inspect input while the owned fixture remains, close the fixture, and persist a terminal receipt even if cleanup fails.',
    substitution: 'Private launch-file testRecovery mode is accepted only with allowControlled; no test tool/action/env parameter is public.',
    budget: 'One attempt plus one corrective retry tied to the same case and changed precondition. Preserve every receipt.',
    limits: ['Failed acknowledgement is deliberately injected AFTER independently proved physical release; it is not a genuine failed SendInput release.',
      'Held provider is controlled; setup and exact follow-up use the pinned engine.', 'No physical Escape or live model-host acceptance is established.'] };
}

function parseArgs(args) {
  if (args.includes('--continuation')) {
    const value = continuation.parse(args, TYPING_CASE, { '--input': 'input' }); value.input ??= 'typing'; plan(value); return value;
  }
  const options = { mode: 'plan', input: 'mouse', attempt: 1 };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--live') options.mode = 'live';
    else if (value === '--plan') options.mode = 'plan';
    else if (value === '--input') options.input = args[++i];
    else if (value === '--attempt') options.attempt = Number(args[++i]);
    else if (value === '--prior') options.prior = args[++i];
    else if (value === '--change') options.change = args[++i];
    else if (!value.startsWith('--') && !options.directory) options.directory = value;
    else throw new Error('Usage: accept-supervisor-quarantine.cjs [new-directory] --plan|--live [--input mouse|chord|typing] [--attempt 2 --prior directory --change description]');
  }
  if (![1, 2].includes(options.attempt) || (options.mode === 'live' && !options.directory)
    || (options.attempt === 2 && (!options.prior || !options.change)) || (options.attempt === 1 && (options.prior || options.change)))
    throw new Error('A corrective retry needs prior evidence and an explicit changed precondition.');
  plan(options); return options;
}
function assertIndependentProof(proof, checkpoint) {
  if (!proof || proof.childPid !== checkpoint.childPid || proof.childExited !== true || !Array.isArray(proof.keysDown)
    || proof.keysDown.length || proof.beforeFailureInjection !== true || !Number.isFinite(Date.parse(proof.verifiedAt))
    || (checkpoint.at && Date.parse(proof.verifiedAt) < Date.parse(checkpoint.at))) {
    throw Object.assign(new Error('A current independent child-exit/all-up proof must precede deliberate failure acknowledgement.'), { code: 'invalid_independent_proof' });
  }
  return proof;
}

async function command(args) {
  try {
    const result = await execFileAsync(DEFAULT_SUPERVISOR, args, { windowsHide: true, timeout: 19000, maxBuffer: 131072 });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    if (error.stdout) { try { return JSON.parse(error.stdout.trim()); } catch { } }
    if (error.stderr) {
      try { const native = JSON.parse(error.stderr.trim()).error; throw Object.assign(new Error(native.message), { code: native.code, win32Error: native.win32Error }); }
      catch (parsed) { if (parsed.code) throw parsed; }
    }
    throw error;
  }
}
async function waitFor(work, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await work(); if (predicate(value)) return value; await delay(20); }
  throw Object.assign(new Error(`Timed out waiting for ${label}.`), { code: 'acceptance_timeout' });
}
async function exited(pid, timeout = 15000) {
  return waitFor(async () => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, Boolean, 'owned process exit', timeout);
}
async function fixtureState(statePath, child, readFile = fs.readFile) {
  const live = () => {
    if (child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error('Owned fixture exited; retained JSON is not live evidence.'), { code: 'fixture_process_exited' });
  };
  live();
  try { const bytes = await readFile(statePath, 'utf8'); live(); return JSON.parse(bytes); }
  catch (error) { live(); if (error.code === 'ENOENT') return null; throw error; }
}
async function exactNativeExit(identity, injected = {}) {
  const deps = { command, waitFor, alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }, ...injected };
  const { assertNativeIdentity } = require('./accept-replacement-recovery.cjs');
  assertNativeIdentity(identity);
  await deps.waitFor(async () => {
    if (!await deps.alive(identity.pid)) return true;
    const current = await deps.command(['identity', String(identity.pid)]); assertNativeIdentity(current, { pid: identity.pid });
    return current.processCreationTime !== identity.processCreationTime;
  }, Boolean, 'exact owned native generation exit', 5000);
  return true;
}
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const assertDisplay = async pinned => compareDisplay(await command(['display']), pinned);

function connectionConfiguration({ directory, privateDirectory, input = 'none', fault = false, operationTimeoutMs = 12000 }) {
  return validatePrivateConfiguration({ mode: input, controlPath: path.join(privateDirectory, 'control.json'), journalPath: path.join(directory, 'events.json'),
    runtimeDirectory: path.join(privateDirectory, 'artifacts'), operationTimeoutMs,
    ...(fault ? { testRecovery: { mode: 'fail-release-ack', token: randomBytes(16).toString('hex') } } : {}) });
}
async function connect(directory, input = 'none', fault = false, options = {}) {
  await fs.mkdir(directory, { recursive: true });
  const privateDirectory = path.join(ROOT, '.runtime', 'quarantine-acceptance', randomUUID());
  await fs.mkdir(privateDirectory, { recursive: true });
  const configPath = path.join(privateDirectory, 'launch.json'), controlPath = path.join(privateDirectory, 'control.json'), journalPath = path.join(directory, 'events.json');
  await writeJson(configPath, connectionConfiguration({ directory, privateDirectory, input, fault, operationTimeoutMs: options.operationTimeoutMs }));
  const client = new Client({ name: 'trace-owned-quarantine-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'tests/fixtures/supervised-mcp.cjs'), configPath], cwd: ROOT, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const common = require('./replacement-acceptance-common.cjs');
  let nodeIdentity, closed;
  const close = () => closed ??= (async () => {
    let error, owned = nodeIdentity ? [nodeIdentity] : [];
    if (nodeIdentity) try { owned = await common.readOwned({ pid: nodeIdentity.pid, nodeIdentity }); } catch (caught) { error = caught; }
    try { await client.close(); } catch (caught) { error = caught; }
    try { await transport.close(); } catch (caught) { error ??= caught; }
    for (const identity of owned) try { assert.equal(await common.waitIdentityExit(identity), true); } catch (caught) { error ??= caught; }
    if (error) throw error;
  })();
  try {
    await client.connect(transport, { timeout: 15000 });
    nodeIdentity = (await common.processList()).find(value => value.pid === transport.pid && value.parent === process.pid && /^node(?:\.exe)?$/i.test(value.name));
    assert.ok(nodeIdentity, 'Exact owned MCP Node generation must be observable.');
  } catch (error) { try { await close(); } catch { } throw error; }
  return { controlPath, client, transport, pid: transport.pid, nodeIdentity,
    journal: async () => { try { return JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { events: [] }; throw error; } },
    call: async (name, args = {}, options = {}) => stateOf(await client.callTool({ name: `trace_computer_${name}`, arguments: args }, { timeout: 30000, ...options })),
    close,
  };
}
async function open(connection, fixture) {
  const listed = await connection.call('list_windows');
  const target = listed.windows.find(window => window.pid === fixture.pid && window.title === fixture.title);
  assert.ok(target?.processCreationTime, 'A current exact process generation is required.');
  const session = await connection.call('open_session', { windowId: target.id });
  assert.ok(session.sessionId, `Owned session rejected: ${session.error?.code || 'unknown'}`);
  return { target, session };
}

async function restartBlocked(directory, fixture) {
  const next = await connect(directory);
  try {
    const doctor = await next.call('doctor');
    assert.equal(doctor.ready, false); assert.equal(doctor.code, 'input_recovery_required');
    const listed = await next.call('list_windows');
    const target = listed.windows.find(window => window.pid === fixture.pid && window.title === fixture.title);
    assert.ok(target);
    const rejected = await next.call('open_session', { windowId: target.id });
    assert.equal(rejected.error?.code, 'input_recovery_required');
    return { doctorCode: doctor.code, openCode: rejected.error.code, newMcpProcess: true, distinctArtifactRoot: true };
  } finally { await next.close(); }
}
async function followup(directory, fixture, pinned, evidence) {
  const next = await connect(directory);
  try {
    const { session, target } = await open(next, fixture);
    const ownership = evidence ? await evidence.followupOpened(next, target) : undefined;
    const frame = await next.call('observe', { sessionId: session.sessionId });
    const button = frame.elements.find(element => element.name === 'Increment counter'); assert.ok(button?.enabled);
    const before = await fixture.state(); assert.equal(before.count, 0); await assertDisplay(pinned);
    const result = await next.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'invoke', elementId: button.id } });
    assert.equal(result.outcome, 'completed');
    const after = await fixture.state(); assert.equal(after.count, 1); assert.equal(after.text, before.text);
    await delay(100); const settled = await fixture.state(); assert.equal(settled.count, 1); assert.equal(settled.text, before.text);
    await next.call('close_session', { sessionId: session.sessionId });
    return { provider: 'pinned-engine', before: before.count, after: after.count, exactIncrement: 1, outcome: result.outcome, text: before.text, stableText: true,
      ...(ownership ? { ownership } : {}) };
  } finally { await next.close(); if (evidence) await evidence.followupClosed(); }
}

async function prepareContinuation(options, injected = {}) {
  const selected = continuation.options(options, TYPING_CASE);
  if (selected.input !== 'typing' || !selected.idleReadinessRef) throw new Error('Typing continuation requires a current direct-owner idle readiness evidence reference.');
  const common = require('./replacement-acceptance-common.cjs');
  const { DesktopLease } = require('../src/computer/lease.cjs');
  const os = require('node:os');
  const deps = { command, bridge: common.bridge, compareDisplay, evidence: continuation.evidence, claimRequest: continuation.claimRequest,
    verify: common.verify, verifyFixture: continuation.preparedFixture,
    claim: request => continuationBook.createBookkeeper().claim(request),
    leaseFree: async () => { const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease')); const id = `typing-ack-preflight-${randomUUID()}`;
      await lease.acquire(id); await lease.release(id); return true; }, ...injected };
  await deps.verify();
  const prepared = await deps.verifyFixture();
  const display = validateDisplay(await deps.command(['display']));
  if (options.pinnedDisplay) compareDisplay(display, options.pinnedDisplay);
  const record = await deps.evidence(selected.idleReadinessRef);
  const request = await deps.claimRequest(selected, TYPING_CASE);
  // Final fresh sample follows all source/manifest/decision I/O and immediately precedes the one claim.
  let claimStarted = false;
  return { selected, display, request, prepared, readiness: record.descriptor, async claim() {
    if (claimStarted) throw new Error('Prepared claim is single-use; obtain fresh preparation/readiness after a block.');
    claimStarted = true;
    const preflight = await continuation.idlePreflight({ record: record.value, caseId: TYPING_CASE, anchor: record.value.anchor, pinnedDisplay: display }, deps);
    return { ...await deps.claim(request), idleReadiness: record.descriptor, preflight };
  } };
}

async function run(options = {}, injected = {}) {
  options = options.continuationAttempt !== undefined
    ? continuation.options({ ...options, input: options.input ?? 'typing' }, TYPING_CASE)
    : { ...options, mode: options.mode ?? 'plan' };
  if (!['plan', 'live'].includes(options.mode)) throw new Error('Mode must be plan or live.');
  if (options.mode === 'plan') return plan(options);
  if (options.input === 'typing' && options.continuationAttempt === undefined)
    throw Object.assign(new Error('Typing ACK historical budget is exhausted; use the actual approved supplemental contract.'), { code: 'invalid_retry' });
  const supplemental = options.continuationAttempt !== undefined ? await prepareContinuation(options, injected) : null;
  const common = require('./replacement-acceptance-common.cjs');
  const exactEvidence = supplemental ? require('./accept-replacement-recovery.cjs').evidenceCallbacks() : null;
  const sourceHashes = async () => {
    const result = await common.sourceHashes('scripts/accept-supervisor-quarantine.cjs');
    for (const name of ['scripts/continuation-adapter.cjs', 'scripts/live-acceptance-continuation.cjs', 'scripts/accept-replacement-recovery.cjs'])
      result.files[name] = sha256(await fs.readFile(path.join(ROOT, name)));
    result.runtimeOutputs = await continuation.runtimeSnapshot();
    return result;
  };
  const display = supplemental?.display ?? validateDisplay(await command(['display'])), declared = plan({ ...options, pinnedDisplay: display });
  if (options.attempt === 2) {
    const prior = JSON.parse(await fs.readFile(path.join(path.resolve(options.prior), 'receipt.json'), 'utf8'));
    assert.equal(prior.caseId, declared.caseId); assert.ok(['fail', 'blocked'].includes(prior.status)); assert.equal(prior.attempt, 1);
  }
  const directory = path.resolve(options.directory); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
  await writeJson(path.join(directory, 'plan.json'), declared);
  const receipt = { schemaVersion: 1, caseId: declared.caseId, attempt: declared.attempt, status: 'running', startedAt: new Date().toISOString(), display, cleanup: {} };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await persist();
  let fixture, connection, controlled, abort, actionSettled;
  try {
    receipt.testedSource = await sourceHashes();
    if (supplemental) {
      // Recheck readiness immediately before the atomic claim; preparation/build never creates idle permission.
      const fresh = await prepareContinuation({ ...options, pinnedDisplay: display }, injected);
      Object.assign(receipt, await fresh.claim(), { attempt: declared.attempt });
      compareDisplay(fresh.display, display);
      receipt.preparedFixture = fresh.prepared.summary;
      await writeJson(path.join(directory, 'claim.json'), { claimId: receipt.claimId, caseId: receipt.caseId,
        continuationAttempt: receipt.continuationAttempt, lifetimeAttemptOrdinal: receipt.lifetimeAttemptOrdinal, decisionId: receipt.decisionId });
      await persist();
    }
    assert.equal((await command(['status'])).recoveryRequired, false);
    const prepared = supplemental ? await continuation.preparedFixture() : null;
    if (prepared) assert.deepEqual(prepared.summary, receipt.preparedFixture, 'Prepared fixture changed after claim.');
    const executable = prepared?.executable ?? await buildFixture(); receipt.fixtureSha256 = sha256(await fs.readFile(executable));
    const runId = `quarantine-${randomUUID()}`, statePath = path.join(directory, 'fixture.json');
    await assertDisplay(display);
    const child = spawn(executable, ['--run-id', runId, '--receipt', statePath, '--commands', path.join(directory, 'fixture-control.json')], { windowsHide: false, stdio: 'ignore' });
    let spawnError; child.once('error', error => { spawnError = error; });
    fixture = { pid: child.pid, child, title: `TRACE Computer Fixture — ${runId}`, state: () => {
      if (spawnError) throw Object.assign(new Error('Owned fixture could not start.'), { code: 'fixture_start_failed' });
      return fixtureState(statePath, child);
    } };
    const initial = await waitFor(fixture.state, Boolean, 'owned fixture launch'); assert.equal(initial.text, ''); assert.equal(initial.count, 0);
    receipt.initialInput = { observedAt: new Date().toISOString(), down: (await command(['keystate', 'all'])).down };
    if (receipt.initialInput.down.length) throw Object.assign(new Error('Input is held before the owned operation; no input was dispatched.'), { code: 'input_busy' });
    connection = await connect(path.join(directory, 'primary'), options.input, true);
    const { target, session } = await open(connection, fixture);
    if (exactEvidence) receipt.ownership = await exactEvidence.opened(connection, target);
    receipt.target = { windowId: target.id, pid: target.pid, processCreationTime: target.processCreationTime, sessionId: target.sessionId };
    const observed = await connection.call('observe', { sessionId: session.sessionId });
    const edit = observed.elements.find(element => element.name === 'TRACE text input'); assert.ok(edit?.enabled);
    await assertDisplay(display);
    const click = await connection.call('act', { sessionId: session.sessionId, observationId: observed.observationId, action: { type: 'click', elementId: edit.id } });
    assert.equal(click.outcome, 'completed'); assert.equal(click.observation.focused?.elementId, edit.id);
    assert.equal((await fixture.state()).focusedControl, 'traceTextInput');
    if (exactEvidence) receipt.focus = await exactEvidence.focus(connection, target, click.observation, await fixture.state());
    const frame = click.observation;
    await fs.writeFile(path.join(directory, 'focused.png'), Buffer.from(frame.screenshot.data, 'base64'));
    const action = options.input === 'typing' ? { type: 'type_text', text: 'abc' }
      : options.input === 'chord' ? { type: 'press_key', key: 'CTRL+SHIFT+A' }
        : { type: 'drag', fromX: frame.bounds.width - 40, fromY: frame.bounds.height - 40, toX: frame.bounds.width - 39, toY: frame.bounds.height - 40 };
    abort = new AbortController(); await assertDisplay(display);
    const pending = connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action }, { signal: abort.signal });
    actionSettled = pending.then(value => ({ value }), error => ({ error: { code: String(error.code || 'cancelled') } }));
    const started = await waitFor(connection.journal, value => value.events.some(event => event.type === 'controlled-dispatch'), 'controlled native dispatch');
    controlled = started.events.find(event => event.type === 'controlled-dispatch'); receipt.controlled = controlled;
    if (exactEvidence) receipt.controlled.identity = await exactEvidence.dispatched(connection, target, controlled);
    receipt.held = await waitFor(async () => (await command(['keystate', KEYS[options.input].join(',')])).keys,
      value => KEYS[options.input].every(key => value[String(key)] === true), 'independently held input', 4000);
    await persist(); abort.abort();
    const ready = await waitFor(connection.journal, value => value.events.some(event => event.type === 'test-release-ready'), 'real-release checkpoint', 3000);
    const checkpoint = ready.events.find(event => event.type === 'test-release-ready'); receipt.nativeReleaseCheckpoint = checkpoint;
    assert.equal(checkpoint.childPid, controlled.pid); assert.equal(checkpoint.physicalReleaseObserved, true);
    // These independent samples, including their durable receipt, MUST precede the failure ACK file.
    if (supplemental) assert.equal(checkpoint.processCreationTime, controlled.processCreationTime);
    const childExited = supplemental ? await exactNativeExit(controlled.identity) : await exited(controlled.pid, 1000);
    const down = (await command(['keystate', 'all'])).down; assert.deepEqual(down, []);
    const independent = { verifiedAt: new Date().toISOString(), childPid: controlled.pid, childExited, keysDown: down,
      source: 'separate native helper and OS process probe outside the tested MCP process', beforeFailureInjection: true };
    assertIndependentProof(independent, checkpoint);
    await writeJson(path.join(directory, 'independent-release-proof.json'), independent);
    receipt.independentReleaseProof = independent; await persist();
    await writeJson(connection.controlPath, { type: 'fail-cleanup-ack', requestId: checkpoint.requestId, independentReleaseVerified: true, verifiedAt: independent.verifiedAt });
    const finished = await waitFor(connection.journal, value => value.events.some(event => event.type === 'controlled-finished'), 'deliberate failed acknowledgement');
    const terminal = finished.events.find(event => event.type === 'controlled-finished'); receipt.injectedFailure = terminal;
    assert.equal(terminal.recovery?.failureInjected, true); assert.equal(terminal.recovery?.independentReleaseVerified, true);
    assert.equal(terminal.recovery?.physicalReleaseObserved, true); assert.equal(terminal.recovery?.released, false);
    assert.equal(terminal.recovery?.reason, 'test_release_ack_failed'); assert.equal(terminal.outcome, 'unknown');
    const effect = await fixture.state(); await delay(100); const stableEffect = await fixture.state();
    assert.equal(effect.count, 0); assert.equal(stableEffect.text, effect.text);
    if (options.input === 'typing') assert.match(effect.text, /^abc+$/); else assert.equal(effect.text, '');
    receipt.effect = { text: effect.text, count: effect.count, unchangedAfterRealRelease: true };
    const button = frame.elements.find(element => element.name === 'Increment counter'); assert.ok(button);
    const blocked = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'invoke', elementId: button.id } });
    assert.ok(['session_stopped', 'indicator_not_active'].includes(blocked.error?.code));
    assert.equal((await fixture.state()).count, 0); receipt.sameSessionBlocked = { code: blocked.error.code, count: 0 };
    const first = await command(['recover', '--check']), second = await command(['recover', '--check']);
    assert.equal(first.recoveryRequired, true); assert.equal(second.recoveryRequired, true);
    receipt.checksDoNotClear = { first, second };
    const denied = await command(['recover', '--apply']); assert.equal(denied.recovered, false); assert.equal(denied.code, 'desktop_busy');
    receipt.applyWhileOwnedRejected = { code: denied.code };
    await persist();
    await connection.close(); assert.equal(await exited(controlled.supervisorPid), true);
    if (exactEvidence) receipt.cleanup.exactOwnedExit = await exactEvidence.closed();
    receipt.restartBlocked = await restartBlocked(path.join(directory, 'restarted-other-artifact-root'), fixture);
    assert.equal((await command(['recover', '--check'])).recoveryRequired, true);
    receipt.apply = await command(['recover', '--apply']);
    assert.equal(receipt.apply.recovered, true); assert.equal(receipt.apply.processExitConfirmed, true); assert.equal(receipt.apply.released, true);
    assert.equal((await command(['status'])).recoveryRequired, false); assert.deepEqual((await command(['keystate', 'all'])).down, []);
    receipt.requestSettlement = await actionSettled;
    receipt.followup = await followup(path.join(directory, 'followup'), fixture, display, exactEvidence);
    receipt.status = 'pass';
  } catch (error) {
    receipt.status = accessCode(error.code) ? 'blocked' : 'fail';
    receipt.error = { code: String(error.code || 'assertion_failed'), message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 500), ...(Number.isInteger(error.win32Error) ? { win32Error: error.win32Error } : {}) };
  } finally {
    if (supplemental) receipt.primaryOutcome = { status: receipt.status, error: receipt.error ?? null };
    abort?.abort();
    try { if (connection) { await connection.close(); receipt.cleanup.connectionClosed = true; } }
    catch (error) { receipt.cleanup.connectionError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    if (actionSettled) try {
      receipt.cleanup.requestSettlement = await Promise.race([actionSettled, delay(5000).then(() => { throw new Error('Request did not settle after native/MCP close.'); })]);
    } catch { receipt.cleanup.requestUnsettled = true; receipt.status = 'fail'; }
    if (exactEvidence) try { receipt.cleanup.exactOwnedExit = await exactEvidence.closed(); receipt.cleanup.followupExactOwnedExit = await exactEvidence.followupClosed(); }
    catch (error) { receipt.cleanup.exactExitError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    if (controlled) {
      try {
        receipt.cleanup.inputChildExited = await exited(controlled.pid);
        if ((await command(['status'])).recoveryRequired) {
          if (supplemental) { receipt.cleanup.retainedRecovery = true; receipt.status = 'fail'; }
          else receipt.cleanup.emergencyRecovery = await command(['recover', '--apply']);
        }
      } catch (error) { receipt.cleanup.inputError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    }
    try {
      receipt.cleanup.inputState = { at: new Date().toISOString(), phase: 'native closed; owned fixture still present', available: true, down: (await command(['keystate', 'all'])).down };
      if (receipt.cleanup.inputState.down.length) receipt.status = 'fail';
    } catch (error) {
      receipt.cleanup.inputState = { available: false, code: String(error.code || 'input_state_unavailable'), win32Error: error.win32Error ?? null };
      if (receipt.status !== 'fail') receipt.status = 'blocked';
    }
    if (fixture) {
      try {
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) assert.equal(fixture.child.kill(), true);
        receipt.cleanup.fixtureExited = await waitFor(async () => fixture.child.exitCode !== null || fixture.child.signalCode !== null, Boolean, 'retained owned fixture exit', 5000);
      }
      catch (error) { receipt.cleanup.fixtureError = String(error.code || 'fixture_exit_unconfirmed'); receipt.status = 'fail'; }
    }
    if (exactEvidence) try { receipt.cleanup.exactFixtureExit = await exactEvidence.fixtureClosed(); }
    catch (error) { receipt.cleanup.fixtureIdentityError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    try { receipt.cleanup.recovery = await command(['status']); if (receipt.cleanup.recovery.recoveryRequired) receipt.status = 'fail'; }
    catch (error) { receipt.cleanup.recovery = { available: false, code: String(error.code || 'recovery_unavailable') }; receipt.status = 'fail'; }
    try {
      const after = await sourceHashes(); receipt.sourcesUnchangedDuringRun = JSON.stringify(after.files) === JSON.stringify(receipt.testedSource?.files)
        && JSON.stringify(after.runtimeOutputs) === JSON.stringify(receipt.testedSource?.runtimeOutputs);
      assert.equal(receipt.sourcesUnchangedDuringRun, true); await common.verify();
      if (supplemental) assert.deepEqual((await continuation.preparedFixture()).summary, receipt.preparedFixture);
    } catch (error) { receipt.cleanup.sourceError = String(error.code || 'source_changed'); receipt.status = 'fail'; }
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).then(receipt => {
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); if (receipt.status && receipt.status !== 'pass') process.exitCode = 1;
}).catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
module.exports = { plan, parseArgs, assertIndependentProof, connectionConfiguration, command, waitFor, exited, exactNativeExit, fixtureState, connect, open, followup, prepareContinuation, run };
