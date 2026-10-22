#!/usr/bin/env node
'use strict';

// A new focused case preserving both failed A32-PROBE attempts. This checks the missing focused
// typing precondition and the production native owner; it does not pass the full recovery matrix.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { NativeSupervisor, configuration, DEFAULT_SUPERVISOR, supervisorSourceHashes } = require('../src/computer/supervisor.cjs');
const { WinappBackend } = require('../src/computer/winapp-backend.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { buildFixture } = require('./smoke-computer-live.cjs');
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function run(reportDirectory, { regression = false } = {}) {
  const evidence = path.resolve(reportDirectory);
  await fs.mkdir(path.dirname(evidence), { recursive: true });
  await fs.mkdir(evidence); // No overwrite or silent extra attempts.
  const plan = {
    caseId: regression ? 'A32-PROBE-FOCUSED-TYPING-REGRESSION' : 'A32-PROBE-FOCUSED-TYPING', declaredBeforeUiLaunch: true,
    ...(regression ? { priorCase: 'A32-PROBE-FOCUSED-TYPING', promotion: 'This regression cannot promote or retry the failed acceptance case.', changedPrecondition: 'Window discovery reads exact process/owner identity separately from capture bounds; unrelated zero-frame windows no longer block discovery.' } : {}),
    authorization: 'Owner resumed close-the-gap implementation on 20 October 2026; earlier exhausted cases stay failed.',
    target: 'Fresh run-scoped owned synthetic WinForms fixture, exact discovered PID and title',
    initial: { text: '', keysDown: [], display: { monitors: 1, width: 2880, height: 1800, dpi: 144 } },
    actions: ['Activate and click the observed text input through the production controller/native owner', 'Verify public focus selector equals the observed text input and independent fixture focus is traceTextInput', 'Run source-owned controlled type-hold abc in the production supervisor job', 'Independently observe held C, cancel the operation, independently verify child exit and all keys released'],
    expected: { text: 'abc', count: 0, recovery: 'process exit confirmed and declared input released', quarantine: false },
    cleanup: 'Close native/controller session then owned fixture; independently verify process exit and global key state',
    limits: 'Direct controller and native controlled provider. This is not MCP cancellation, a model-host workflow, physical Escape, or the complete A32 recovery matrix.',
    budget: 'One attempt plus one corrective retry after a documented changed precondition; use a new report directory and preserve prior results.',
  };
  await fs.writeFile(path.join(evidence, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  const files = await supervisorSourceHashes();
  for (const name of ['src/computer/supervisor.cjs', 'src/computer/controller.cjs', 'src/computer/winapp-backend.cjs', 'native/TraceWindowBridge/Program.cs', 'tests/fixtures/computer-app/Program.cs', 'scripts/accept-supervised-typing.cjs']) files[name] = sha256(await fs.readFile(path.join(ROOT, name)));
  const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true })).stdout.trim();
  const receipt = { schemaVersion: 1, caseId: plan.caseId, observedAt: new Date().toISOString(), testedSource: { baseCommit: commit, workingTreeModified: true, files }, runtime: { node: process.version, platform: process.platform, arch: process.arch }, status: 'not_run', cleanup: {} };
  const persist = () => fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const command = async args => JSON.parse((await execFileAsync(DEFAULT_SUPERVISOR, args, { windowsHide: true, timeout: 10000, maxBuffer: 65536 })).stdout.trim());
  let fixture, controller, session, abort;
  try {
    const display = await command(['display']);
    receipt.display = display;
    assert.equal(display.monitors, 1);
    assert.equal(display.displays[0].bounds.width, 2880);
    assert.equal(display.displays[0].bounds.height, 1800);
    assert.equal(display.displays[0].dpi, 144);
    receipt.initialKeySamples = [];
    // Initial key activity blocks dispatch. Require three released samples so starting while a
    // navigation key is being released cannot consume the input test's only corrective attempt.
    for (let i = 0; i < 3; i++) {
      const down = (await command(['keystate', 'all'])).down;
      receipt.initialKeySamples.push(down);
      if (down.length) throw Object.assign(new Error('Input is already held; no fixture or input provider was started.'), { code: 'input_busy' });
      await delay(150);
    }
    const directory = path.join(ROOT, '.runtime', 'supervised-typing', randomUUID());
    await fs.mkdir(directory, { recursive: true });
    const receiptPath = path.join(directory, 'fixture.json');
    const runId = `supervised-typing-${randomUUID()}`;
    const executable = await buildFixture();
    receipt.fixtureSha256 = sha256(await fs.readFile(executable));
    fixture = spawn(executable, ['--run-id', runId, '--receipt', receiptPath, '--commands', path.join(directory, 'commands.json')], { windowsHide: false, stdio: 'ignore' });
    const state = async () => JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    let before;
    for (let i = 0; i < 100 && !before; i++) { try { before = await state(); } catch { await delay(100); } }
    assert.ok(before);
    assert.equal(before.text, '');
    const dispatches = [];
    const native = new NativeSupervisor({ configure: async () => ({ ...await configuration(), allowControlled: true }), onDispatch: item => dispatches.push(item) });
    controller = createComputerController({ backend: new WinappBackend({ supervisor: native }), runtimeDirectory: path.join(directory, 'runtime') });
    assert.equal((await controller.doctor()).ready, true);
    const windows = await controller.listWindows();
    const target = windows.windows.find(item => item.pid === fixture.pid && item.title === `TRACE Computer Fixture — ${runId}`);
    assert.ok(target);
    session = await controller.openSession({ windowId: target.id });
    const frame = await controller.observe(session);
    const edit = frame.elements.find(item => item.name === 'TRACE text input');
    assert.ok(edit?.enabled);
    const click = await controller.act({ ...session, observationId: frame.observationId, action: { type: 'click', elementId: edit.id } });
    receipt.focusClick = { outcome: click.outcome, error: click.error ?? null };
    assert.equal(click.outcome, 'completed');
    assert.equal(click.observation.focused?.hasFocus, true);
    assert.equal(click.observation.focused.elementId, edit.id);
    const independent = await state();
    assert.equal(independent.focusedControl, 'traceTextInput');
    receipt.focus = { publicMatchesObservedEdit: true, independentControl: independent.focusedControl, provenance: click.observation.focused.provenance };
    await fs.writeFile(path.join(evidence, 'focused.png'), Buffer.from(click.observation.screenshot.data, 'base64'));
    abort = new AbortController();
    const held = native.run('controlled', ['provider', 'type-hold', 'abc'], { signal: abort.signal, mutating: true });
    // Attach the rejection handler before cancellation so it cannot become an unhandled rejection.
    const completed = held.then(value => ({ value }), error => ({ error }));
    let key;
    for (let i = 0; i < 25; i++) { key = (await command(['keystate', '67'])).keys; if (key['67'] === true) break; await delay(20); }
    receipt.heldIndependently = key;
    abort.abort();
    const outcome = await completed;
    assert.equal(key['67'], true);
    assert.ok(outcome.error);
    receipt.operation = { code: outcome.error.code, outcome: outcome.error.details?.outcome, recovery: outcome.error.details?.recovery };
    assert.equal(receipt.operation.outcome, 'unknown');
    assert.equal(receipt.operation.recovery?.released, true);
    assert.equal(receipt.operation.recovery?.processExitConfirmed, true);
    const childPid = receipt.operation.recovery.childPid;
    assert.ok(Number.isInteger(childPid));
    let childExited = false;
    try { process.kill(childPid, 0); } catch (error) { if (error.code === 'ESRCH') childExited = true; else throw error; }
    receipt.childExitIndependently = childExited;
    assert.equal(childExited, true);
    receipt.keysAfter = (await command(['keystate', 'all'])).down;
    assert.deepEqual(receipt.keysAfter, []);
    const after = await state();
    receipt.target = { text: after.text, count: after.count, focusedControl: after.focusedControl };
    assert.equal(after.text, 'abc');
    assert.equal(after.count, 0);
    receipt.recoveryCheck = await command(['status']);
    assert.equal(receipt.recoveryCheck.recoveryRequired, false);
    receipt.status = 'pass';
  } catch (error) {
    receipt.status = error.code === 'desktop_busy' || error.code === 'input_busy' ? 'blocked' : 'fail';
    receipt.error = { code: error.code ?? 'assertion_failed', message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 500) };
  } finally {
    abort?.abort();
    if (controller) { try { await controller.close(); receipt.cleanup.controllerClosed = true; } catch (error) { receipt.cleanup.controllerError = error.code ?? 'cleanup_failed'; receipt.status = 'fail'; } }
    if (fixture) {
      fixture.kill();
      for (let i = 0; i < 50; i++) { try { process.kill(fixture.pid, 0); } catch (error) { if (error.code === 'ESRCH') { receipt.cleanup.fixtureExited = true; break; } } await delay(50); }
    }
    receipt.cleanup.finalKeysDown = (await command(['keystate', 'all'])).down;
    receipt.cleanup.recovery = await command(['status']);
    if (receipt.cleanup.finalKeysDown.length || receipt.cleanup.recovery.recoveryRequired || (fixture && !receipt.cleanup.fixtureExited)) receipt.status = 'fail';
    receipt.completedAt = new Date().toISOString();
    await persist();
  }
  return receipt;
}

if (require.main === module) {
  if (process.argv.length < 3 || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--regression')) throw new Error('Usage: node scripts/accept-supervised-typing.cjs <new-report-directory> [--regression]');
  run(process.argv[2], { regression: process.argv[3] === '--regression' }).then(result => { process.stdout.write(JSON.stringify({ status: result.status, error: result.error, focus: result.focus, target: result.target, cleanup: result.cleanup }) + '\n'); if (result.status !== 'pass') process.exitCode = 1; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
module.exports = { run };
