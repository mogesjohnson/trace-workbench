#!/usr/bin/env node
'use strict';

// Opt-in real recovery matrix. The normal test suite imports only its pure plan/parser helpers.
// Every held operation crosses the real stdio MCP/server/controller/backend/native-owner path.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { DEFAULT_SUPERVISOR, supervisorSourceHashes } = require('../src/computer/supervisor.cjs');
const { buildFixture } = require('./smoke-computer-live.cjs');
const ROOT = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const INPUTS = ['mouse', 'chord', 'typing'];
const FAILURES = ['cancel', 'timeout', 'disconnect', 'node-death', 'supervisor-death'];
const CELL_KEYS = { mouse: [1], chord: [0xA2, 0xA0], typing: [0x43] };

function cells() {
  return FAILURES.flatMap(failure => INPUTS.map(input => ({ id: `A32-RECOVERY-${failure.toUpperCase()}-${input.toUpperCase()}`, failure, input })));
}

function plan(options = {}) {
  if (options.prepareForeground !== undefined && typeof options.prepareForeground !== 'function') throw new Error('Foreground preparation must be an explicit private callback.');
  const chosen = options.caseId ? cells().filter(cell => cell.id === options.caseId) : cells();
  if (!chosen.length) throw new Error('Unknown matrix case ID.');
  return {
    schemaVersion: 1, declaredBeforeUiLaunch: true, caseId: 'A32-RECOVERY-MATRIX', attempt: options.attempt ?? 1,
    ...(options.prior ? { prior: path.relative(ROOT, path.resolve(options.prior)).replaceAll(path.sep, '/'), changedPrecondition: options.change } : {}),
    target: 'One fresh owned synthetic WinForms fixture per cell, bound by discovered HWND/PID/creation time',
    initial: { text: '', count: 0, keysDown: [], display: options.pinnedDisplay ?? 'One actual single-monitor mode observed and pinned at live preflight; exact bounds, DPI and device identity must remain unchanged.' },
    capture: { coordinateSpace: 'window-local-physical-pixels', dpiAwareness: 'PER_MONITOR_AWARE_V2', imageDimensions: 'Original observed target-window PNG dimensions; no resizing or guessed scaling.' },
    substitution: 'Private launch-file-selected backend substitutes one final pinned-engine dispatch with the source-owned controlled provider. Public tools/action schemas stay unchanged.',
    expected: ['Physical input is independently observed held before interruption', 'Owned input child exit is independently established before release is accepted',
      'Declared keyboard/buttons are independently all released', 'An ordinary pinned-engine follow-up increments the owned fixture exactly once',
      'Supervisor death retains per-user quarantine; check does not clear it; a competing artifact-root owner is blocked; verified apply clears it'],
    literalEffect: 'Interrupted type-hold produces ab followed by one or more c characters because the deliberately held final key can autorepeat; retain exact observed synthetic text and verify it stops changing after cleanup.',
    cells: chosen, cleanup: 'Close native/MCP ownership before the owned fixture; preserve uncertainty and stop the matrix after a failed or blocked cell.',
    ...(options.prepareForeground ? { betweenCases: 'Optional private preparation of a separately owned ordinary anchor only after independent input-child/native-owner exit, closed MCP, all-up input and clear recovery. Preparation is recorded separately and never substitutes for recovery proof.' } : {}),
    budget: 'One attempt plus one corrective retry, only with explicit prior evidence and a changed precondition. Fresh directories never erase earlier outcomes.',
    outsideScope: { physicalEscape: 'not_run: requires an actual physical key press', failedCleanupAcknowledgement: 'not_run: requires a native two-phase fault seam after independent real-input release confirmation',
      pinnedEngineDispatch: 'Only setup and follow-up use the pinned engine; held input is the labeled controlled provider.', liveModelHosts: 'not_run' },
  };
}

function parseArgs(args) {
  const options = { mode: 'plan', attempt: 1 };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--live') options.mode = 'live';
    else if (value === '--plan') options.mode = 'plan';
    else if (value === '--case') options.caseId = args[++i];
    else if (value === '--attempt') options.attempt = Number(args[++i]);
    else if (value === '--prior') options.prior = args[++i];
    else if (value === '--change') options.change = args[++i];
    else if (!value.startsWith('--') && !options.directory) options.directory = value;
    else throw new Error('Usage: accept-supervisor-recovery.cjs [new-directory] --plan|--live [--case ID] [--attempt 2 --prior directory --change description]');
  }
  if (![1, 2].includes(options.attempt) || (options.mode === 'live' && !options.directory)
    || (options.attempt === 2 && (!options.prior || !options.change)) || (options.attempt === 1 && (options.prior || options.change))) {
    throw new Error('A corrective retry requires prior evidence and an explicit changed precondition.');
  }
  plan(options);
  return options;
}

async function command(args) {
  try {
    const result = await execFileAsync(DEFAULT_SUPERVISOR, args, { windowsHide: true, timeout: 19000, maxBuffer: 131072 });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    if (error.stdout) { try { return JSON.parse(error.stdout.trim()); } catch { } }
    if (error.stderr) {
      let native;
      try { native = JSON.parse(error.stderr.trim()).error; } catch {}
      if (native && typeof native.code === 'string') throw Object.assign(new Error(native.message || 'Native inspection failed.'), { code: native.code });
    }
    throw error;
  }
}
function validateDisplay(display) {
  if (!display || display.monitors !== 1 || !Array.isArray(display.displays) || display.displays.length !== 1
    || typeof display.displays[0].device !== 'string' || !Number.isInteger(display.displays[0].dpi) || display.displays[0].dpi < 1
    || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(display.displays[0].bounds?.[key]))
    || display.displays[0].bounds.width < 1 || display.displays[0].bounds.height < 1) {
    throw Object.assign(new Error('This recovery run requires one observable display with exact physical bounds and DPI.'), { code: 'display_mismatch' });
  }
  return display;
}
function compareDisplay(actual, pinned) {
  validateDisplay(actual);
  if (!isDeepStrictEqual(actual, pinned)) throw Object.assign(new Error('Display identity, topology, physical bounds or DPI changed from this run\'s declared mode; further coordinate input is blocked.'), { code: 'display_mismatch' });
  return actual;
}
const assertDisplay = async pinned => compareDisplay(await command(['display']), pinned);
function stateOf(response) {
  const state = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  function hydrate(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(hydrate);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'screenshot' && item && typeof item === 'object' && Number.isInteger(item.contentIndex)) {
        const image = response.content[item.contentIndex];
        if (image?.type !== 'image' || image.mimeType !== 'image/png' || typeof image.data !== 'string' || !image.data.length) {
          throw Object.assign(new Error('MCP screenshot reference did not resolve to a PNG image.'), { code: 'invalid_mcp_screenshot' });
        }
        result[key] = { ...item, data: image.data };
      } else result[key] = hydrate(item);
    }
    return result;
  }
  return hydrate(state);
}
async function waitFor(work, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await work();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw Object.assign(new Error(`Timed out waiting for ${label}.`), { code: 'acceptance_timeout' });
}
async function exited(pid, timeout = 15000) {
  return waitFor(async () => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, Boolean, 'owned process exit', timeout);
}
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function connectCell(directory, mode, failure) {
  await fs.mkdir(directory, { recursive: true });
  // Launch configuration contains absolute local paths and stays outside shareable evidence.
  const privateDirectory = path.join(ROOT, '.runtime', 'supervised-recovery', randomUUID());
  await fs.mkdir(privateDirectory, { recursive: true });
  const configPath = path.join(privateDirectory, 'launch.json'), journalPath = path.join(directory, 'events.json'), controlPath = path.join(privateDirectory, 'control.json');
  await writeJson(configPath, { mode, journalPath, controlPath, runtimeDirectory: path.join(privateDirectory, 'artifacts'), operationTimeoutMs: failure === 'timeout' ? 1500 : 12000 });
  const client = new Client({ name: 'trace-owned-recovery-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'tests/fixtures/supervised-mcp.cjs'), configPath], cwd: ROOT, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport, { timeout: 15000 });
  return { client, transport, controlPath,
    journal: async () => { try { return JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { events: [] }; throw error; } },
    call: async (name, args = {}, options = {}) => stateOf(await client.callTool({ name: `trace_computer_${name}`, arguments: args }, { timeout: 30000, ...options })),
    async close() { await client.close().catch(() => {}); await transport.close().catch(() => {}); },
  };
}

async function openTarget(connection, fixture) {
  const discovery = await connection.call('list_windows');
  const target = discovery.windows.find(window => window.pid === fixture.pid && window.title === fixture.title);
  assert.ok(target?.processCreationTime, 'Exact discovered process generation is required.');
  const session = await connection.call('open_session', { windowId: target.id });
  if (!session.sessionId) throw Object.assign(new Error('Owned target session did not open.'), { code: session.error?.code || 'session_open_failed' });
  return { target, session };
}

async function followup(directory, fixture, receipt, pinnedDisplay, replacementEvidence) {
  const connection = await connectCell(directory, 'none', 'followup');
  try {
    const { target, session } = await openTarget(connection, fixture);
    if (replacementEvidence) receipt.followupOwnership = await replacementEvidence.followupOpened(connection, target);
    const frame = await connection.call('observe', { sessionId: session.sessionId });
    const increment = frame.elements.find(element => element.name === 'Increment counter');
    assert.ok(increment?.enabled);
    const before = await fixture.state();
    await assertDisplay(pinnedDisplay);
    const result = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'invoke', elementId: increment.id } });
    assert.equal(result.outcome, 'completed');
    const after = await fixture.state();
    assert.equal(after.count - before.count, 1);
    if (replacementEvidence) { assert.equal(before.text, receipt.effect.text); assert.equal(after.text, receipt.effect.text); }
    receipt.followup = { outcome: result.outcome, before: before.count, after: after.count, exactIncrement: 1, provider: 'pinned-engine' };
    await connection.call('close_session', { sessionId: session.sessionId });
  } finally {
    await connection.close();
    if (replacementEvidence) receipt.cleanup.followupExactOwnedExit = await replacementEvidence.followupClosed();
  }
}

async function verifyDurable(directory, fixture, receipt) {
  const first = await command(['recover', '--check']);
  assert.equal(first.recoveryRequired, true);
  const second = await command(['recover', '--check']);
  assert.equal(second.recoveryRequired, true);
  const competitor = await connectCell(path.join(directory, 'competing-artifact-root'), 'none', 'competitor');
  try {
    const doctor = await competitor.call('doctor');
    assert.equal(doctor.ready, false);
    assert.equal(doctor.code, 'input_recovery_required');
    const discovery = await competitor.call('list_windows');
    const target = discovery.windows.find(window => window.pid === fixture.pid && window.title === fixture.title);
    assert.ok(target);
    const blocked = await competitor.call('open_session', { windowId: target.id });
    assert.equal(blocked.error?.code, 'input_recovery_required');
    receipt.quarantine = { survivesReadOnlyChecks: true, separateArtifactRoot: true, blocksNewSession: true, doctorCode: doctor.code, openCode: blocked.error.code };
  } finally { await competitor.close(); }
  const recovered = await command(['recover', '--apply']);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.recoveryRequired, false);
  assert.equal(recovered.processExitConfirmed, true);
  assert.equal(recovered.released, true);
  receipt.recoveryApply = recovered;
}

async function runCell(cell, directory, executable, pinnedDisplay, prepareForeground, replacementEvidence) {
  if (cell.replacement && !replacementEvidence) throw new Error('Replacement cells require explicit independent evidence callbacks.');
  await fs.mkdir(directory);
  const receipt = { caseId: cell.id, input: cell.input, failure: cell.failure, status: 'running', startedAt: new Date().toISOString(), cleanup: {} };
  const receiptPath = path.join(directory, 'receipt.json');
  const persist = () => fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  await persist();
  let fixture, connection, actionSettled, abort, controlled;
  try {
    const display = await assertDisplay(pinnedDisplay);
    receipt.display = display;
    receipt.initialKeys = (await command(['keystate', 'all'])).down;
    if (receipt.initialKeys.length) throw Object.assign(new Error('Input is already held before this case; no takeover started.'), { code: 'input_busy' });
    assert.equal((await command(['status'])).recoveryRequired, false);
    const runId = `recovery-${randomUUID()}`, fixtureState = path.join(directory, 'fixture.json');
    const process = spawn(executable, ['--run-id', runId, '--receipt', fixtureState, '--commands', path.join(directory, 'fixture-commands.json')], { windowsHide: false, stdio: 'ignore' });
    fixture = { pid: process.pid, process, title: `TRACE Computer Fixture — ${runId}`,
      state: async () => { try { return JSON.parse(await fs.readFile(fixtureState, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } } };
    const before = await waitFor(fixture.state, Boolean, 'owned fixture startup');
    assert.equal(before.text, ''); assert.equal(before.count, 0);
    connection = await connectCell(path.join(directory, 'primary'), cell.input, cell.failure);
    const { target, session } = await openTarget(connection, fixture);
    receipt.target = { windowId: target.id, pid: target.pid, processCreationTime: target.processCreationTime };
    if (cell.replacement) {
      receipt.target.sessionId = target.sessionId;
      receipt.ownership = await replacementEvidence.opened(connection, target);
      await persist();
    }
    let frame = await connection.call('observe', { sessionId: session.sessionId });
    const edit = frame.elements.find(element => element.name === 'TRACE text input');
    assert.ok(edit?.enabled);
    await assertDisplay(pinnedDisplay);
    const focused = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action: { type: 'click', elementId: edit.id } });
    assert.equal(focused.outcome, 'completed');
    frame = focused.observation;
    assert.equal(frame.focused?.elementId, edit.id);
    assert.equal((await fixture.state()).focusedControl, 'traceTextInput');
    if (cell.replacement) {
      receipt.focus = await replacementEvidence.focus(connection, target, frame, await fixture.state());
      await persist();
    }
    await fs.writeFile(path.join(directory, 'focused.png'), Buffer.from(frame.screenshot.data, 'base64'));
    const action = cell.input === 'typing' ? { type: 'type_text', text: 'abc' }
      : cell.input === 'chord' ? { type: 'press_key', key: 'CTRL+SHIFT+A' }
        : { type: 'drag', fromX: frame.bounds.width - 40, fromY: frame.bounds.height - 40, toX: frame.bounds.width - 39, toY: frame.bounds.height - 40 };
    await assertDisplay(pinnedDisplay);
    abort = new AbortController();
    const pending = connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId, action }, { signal: abort.signal });
    actionSettled = pending.then(value => ({ value }), error => ({ error: { code: String(error.code || 'transport_closed') } }));
    const started = await waitFor(connection.journal, value => value.events.some(event => event.type === 'controlled-dispatch'), 'controlled job dispatch');
    controlled = started.events.find(event => event.type === 'controlled-dispatch');
    receipt.controlled = { pid: controlled.pid, processCreationTime: controlled.processCreationTime, inJob: controlled.inJob, supervisorPid: controlled.supervisorPid };
    if (cell.replacement) receipt.controlled.identity = await replacementEvidence.dispatched(connection, target, controlled);
    await persist();
    receipt.held = await waitFor(async () => (await command(['keystate', CELL_KEYS[cell.input].join(',')])).keys,
      value => CELL_KEYS[cell.input].every(key => value[String(key)] === true), 'independently held input', 4000);
    await persist();
    receipt.interruptedAt = new Date().toISOString();
    if (cell.failure === 'cancel') abort.abort();
    else if (cell.failure === 'disconnect') await connection.close();
    else if (cell.failure === 'node-death' || cell.failure === 'supervisor-death') await writeJson(connection.controlPath, { type: cell.failure });
    // Timeout dispatch has a declared native deadline and needs no external interruption.
    assert.equal(await exited(controlled.pid), true);
    receipt.childExitIndependently = true;
    await persist();
    if (cell.failure === 'supervisor-death') {
      assert.equal(await exited(controlled.supervisorPid), true);
      await connection.close();
      await verifyDurable(directory, fixture, receipt);
    } else {
      await waitFor(async () => (await command(['keystate', 'all'])).down, value => value.length === 0, 'independently balanced input');
      const events = await waitFor(connection.journal, value => cell.failure === 'node-death' || cell.failure === 'disconnect'
        || value.events.some(event => event.type === 'controlled-finished'), 'native cleanup completion');
      const finished = events.events.find(event => event.type === 'controlled-finished');
      if (finished) {
        receipt.nativeOutcome = { code: finished.code, outcome: finished.outcome, recovery: finished.recovery };
        assert.equal(finished.outcome, 'unknown'); assert.equal(finished.recovery?.released, true); assert.equal(finished.recovery?.processExitConfirmed, true);
        if (cell.failure === 'timeout') assert.equal(finished.code, 'native_timeout');
        await persist();
      }
      assert.equal((await command(['status'])).recoveryRequired, false);
      await connection.close();
      assert.equal(await exited(controlled.supervisorPid), true);
    }
    await actionSettled;
    if (cell.replacement) {
      receipt.cleanup.exactOwnedExit = await replacementEvidence.closed();
      await persist();
    }
    receipt.keysAfter = (await command(['keystate', 'all'])).down; assert.deepEqual(receipt.keysAfter, []);
    const after = await fixture.state(); await delay(150); const settled = await fixture.state();
    assert.equal(after.count, 0); assert.equal(settled.text, after.text);
    if (cell.input === 'typing') assert.match(after.text, /^abc+$/); else assert.equal(after.text, '');
    receipt.effect = { text: after.text, count: after.count, unchangedAfterCleanup: true };
    await persist();
    await followup(path.join(directory, 'followup-artifact-root'), fixture, receipt, pinnedDisplay, cell.replacement ? replacementEvidence : undefined);
    receipt.status = 'pass';
  } catch (error) {
    receipt.status = ['input_busy', 'desktop_busy', 'display_mismatch', 'input_desktop_unavailable', 'input_state_unavailable'].includes(error.code)
      || String(error.code).startsWith('foreground_') ? 'blocked' : 'fail';
    receipt.error = { code: String(error.code || 'assertion_failed'), message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 500) };
  } finally {
    if (cell.replacement) receipt.primaryOutcome = { status: receipt.status, error: receipt.error ?? null, nativeOutcome: receipt.nativeOutcome ?? null };
    abort?.abort();
    if (connection) {
      try { await connection.close(); receipt.cleanup.connectionClosed = true; }
      catch (error) { receipt.cleanup.connectionError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    }
    if (actionSettled) {
      const settled = await actionSettled;
      receipt.requestResult = { outcome: settled.value?.outcome ?? 'unknown',
        code: String(settled.value?.error?.code ?? settled.error?.code ?? 'none') };
    }
    if (controlled) {
      try {
        await exited(controlled.pid);
        receipt.cleanup.supervisorExited = await exited(controlled.supervisorPid);
        const recovery = await command(['status']);
        if (recovery.recoveryRequired && !cell.replacement) receipt.cleanup.recovery = await command(['recover', '--apply']);
        if (recovery.recoveryRequired && cell.replacement) {
          receipt.cleanup.retainedQuarantine = recovery;
          receipt.status = 'fail';
        }
        receipt.cleanup.inputChildExited = true;
      } catch (error) { receipt.cleanup.inputError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    }
    if (cell.replacement) {
      try { receipt.cleanup.exactOwnedExit = await replacementEvidence.closed(); }
      catch (error) { receipt.cleanup.exactOwnedExitError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    }
    // Capture release evidence while the owned fixture still exists. Closing it may expose an
    // unrelated protected foreground process; failure to inspect must be recorded, never all-up.
    try {
      receipt.cleanup.inputState = { available: true, at: new Date().toISOString(), phase: 'native closed; owned fixture not yet closed', down: (await command(['keystate', 'all'])).down };
      if (receipt.cleanup.inputState.down.length && receipt.status !== 'fail') {
        receipt.cleanup.inputState.scope = controlled ? 'Global input is not all released; ownership of newly observed input is unproven.' : 'No controlled input was dispatched; pre-existing input was preserved.';
        receipt.status = 'blocked';
      }
    } catch (error) {
      receipt.cleanup.inputState = { available: false, code: String(error.code || 'input_state_unavailable') };
      if (receipt.status !== 'fail') receipt.status = 'blocked';
    }
    if (prepareForeground && controlled && receipt.cleanup.connectionClosed === true
      && receipt.cleanup.inputChildExited === true && receipt.cleanup.supervisorExited === true
      && receipt.cleanup.inputState?.available === true && receipt.cleanup.inputState.down.length === 0) {
      // This optional caller-owned setup happens before fixture exit, while release can still be
      // independently observed. It cannot clear recovery or count as the tested input effect.
      const recovery = await command(['status']).catch(() => null);
      if (recovery?.recoveryRequired === false) {
        try { receipt.cleanup.foregroundPreparation = await prepareForeground({ inputChildExitVerified: true, nativeOwnerExitVerified: true, mcpClosed: true }); }
        catch { receipt.cleanup.foregroundPreparation = { prepared: false, cleanupConfirmed: false, code: 'preparation_failed' }; }
      }
    }
    if (fixture) { fixture.process.kill(); try { receipt.cleanup.fixtureExited = await exited(fixture.pid, 5000); } catch { receipt.cleanup.fixtureExited = false; receipt.status = 'fail'; } }
    if (cell.replacement) {
      try { receipt.cleanup.exactFixtureExit = await replacementEvidence.fixtureClosed(); }
      catch (error) { receipt.cleanup.exactFixtureExitError = String(error.code || 'cleanup_failed'); receipt.status = 'fail'; }
    }
    try {
      receipt.cleanup.recovery = await command(['status']);
      if (receipt.cleanup.recovery.recoveryRequired) receipt.status = 'fail';
    } catch (error) { receipt.cleanup.recovery = { available: false, code: String(error.code || 'recovery_unavailable') }; receipt.status = 'fail'; }
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}

async function run(options) {
  if (options.mode === 'plan') return plan(options);
  // Read-only display observation precedes the written plan and every fixture/session launch.
  // A changed mode needs a new declared run; this is not display-transition acceptance.
  const pinnedDisplay = validateDisplay(await command(['display']));
  const declared = plan({ ...options, pinnedDisplay });
  const directory = path.resolve(options.directory);
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
  await writeJson(path.join(directory, 'plan.json'), declared);
  await writeJson(path.join(directory, 'display-manifest.json'), { observedAt: new Date().toISOString(), display: pinnedDisplay, capture: declared.capture });
  if (options.attempt === 2) {
    const prior = JSON.parse(await fs.readFile(path.join(path.resolve(options.prior), 'matrix.json'), 'utf8'));
    assert.ok(prior.cases?.some(result => ['fail', 'blocked'].includes(result.status)), 'Prior evidence must contain an unfinished failed/blocked case.');
  }
  const sources = await supervisorSourceHashes();
  for (const name of ['scripts/accept-supervisor-recovery.cjs', 'tests/fixtures/supervised-mcp.cjs', 'src/computer/supervisor.cjs', 'src/computer/controller.cjs', 'src/computer/server.cjs', 'src/computer/winapp-backend.cjs']) sources[name] = sha256(await fs.readFile(path.join(ROOT, name)));
  if (options.prepareForeground) sources['scripts/acceptance-foreground.cjs'] = sha256(await fs.readFile(path.join(ROOT, 'scripts/acceptance-foreground.cjs')));
  const manifest = { ...declared, observedAt: new Date().toISOString(), testedSource: { baseCommit: (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true })).stdout.trim(), workingTreeModified: true, files: sources }, cases: [] };
  const executable = await buildFixture();
  manifest.fixtureSha256 = sha256(await fs.readFile(executable));
  for (const cell of declared.cells) {
    const result = await runCell(cell, path.join(directory, cell.id.toLowerCase()), executable, pinnedDisplay, options.prepareForeground);
    manifest.cases.push({ caseId: cell.id, status: result.status, error: result.error ?? null, receipt: `${cell.id.toLowerCase()}/receipt.json` });
    await fs.writeFile(path.join(directory, 'matrix.json'), JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ caseId: cell.id, status: result.status, error: result.error ?? null }) + '\n');
    if (result.status !== 'pass') break;
  }
  for (const cell of declared.cells) if (!manifest.cases.some(result => result.caseId === cell.id)) manifest.cases.push({ caseId: cell.id, status: 'not_run', reason: 'Matrix stopped after an unresolved case.' });
  manifest.status = manifest.cases.every(result => result.status === 'pass') ? 'pass' : 'incomplete';
  manifest.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'matrix.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status && result.status !== 'pass') process.exitCode = 1;
}).catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
module.exports = { cells, plan, parseArgs, validateDisplay, compareDisplay, stateOf, run, runCell };
