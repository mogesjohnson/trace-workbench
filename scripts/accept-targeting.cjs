#!/usr/bin/env node
'use strict';

// Focused alpha.3.3 acceptance on the owned computer fixture through the production stdio MCP server:
// A33-DEPTH, A33-OUTCOME and the focused A3-WINDOW and A3-DIALOG continuations. Every rejection is
// checked against independent fixture state; no case retries input automatically.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const live = require('./smoke-computer-live.cjs');

const ROOT = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PIN = { monitors: 1, width: 2880, height: 1800, dpi: 144 };
const SOURCE_FILES = [
  'bin/trace.cjs', 'src/computer/server.cjs', 'src/computer/controller.cjs', 'src/computer/lease.cjs', 'src/computer/winapp-backend.cjs',
  'src/computer/activity-indicator.cjs', 'native/TraceActivityIndicator/Program.cs', 'native/TraceWindowBridge/Program.cs',
  'tests/fixtures/computer-app/Program.cs', 'scripts/accept-targeting.cjs', 'scripts/smoke-computer-live.cjs', 'package.json', 'package-lock.json',
];

const PLAN = {
  'A33-DEPTH': { requirement: 'CU-01/CU-02', budget: 'New case: one attempt plus one corrective retry', actions: ['Observe at default depth: the deep counter is absent and the tree is truncated', 'Observe at depth 16 and invoke the deep counter once', 'Disable, then move, then remove it; each stale action is rejected before dispatch', 'An action carrying accessibilityDepth is refused by the schema'], expected: { defaultDepthFindsDeep: false, deepCountAfterInvoke: 1, rejections: ['stale_element', 'stale_element', 'stale_element'], deepCountFinal: 1, forgedDepthRejected: true } },
  'A33-OUTCOME': { requirement: 'CU-02', budget: 'New case: one attempt plus one corrective retry', actions: ['Moved window, blocked window, unsupported scroll and changed focus each rejected', 'Stale-element rejections come from A33-DEPTH'], expected: { outcome: 'not_dispatched', fixtureStateUnchanged: true, focusPreparationRecorded: true } },
  'A3-WINDOW': { requirement: 'CU-01/CU-02', budget: 'Focused continuation; original run retained; one corrective retry', actions: ['Move between observation and action: stale action rejected; fresh observation hits the counter once', 'Minimize: stale action rejected; observation restores; one counter hit'], expected: { staleOutcome: 'not_dispatched', staleError: 'window_moved', counterAddedPerTransition: 1 } },
  'A3-DIALOG': { requirement: 'CU-01', budget: 'Focused continuation after two failed full-harness attempts; final permitted attempt, no retry', actions: ['Open the modal through TRACE', 'Parent invoke, element click and value are rejected with window_blocked', 'Hand off to the exact dialog: confirm, then close it through TRACE', 'Return to the parent: enabled, one counter hit'], expected: { parentEnabledWhileOpen: false, parentRejections: 3, dialogConfirmed: true, parentEnabledAfterClose: true, counterAdded: 1 } },
};

async function testedSource() {
  const files = {};
  for (const name of SOURCE_FILES) files[name] = sha256(await fs.readFile(path.join(ROOT, name)));
  const [commit, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: ROOT, windowsHide: true }),
  ]);
  return { baseCommit: commit.stdout.trim(), workingTreeModified: status.stdout.trim().length > 0, files };
}

async function run(evidence, only, regression = false) {
  // A focused regression keeps a separate case ID and can never pass or retry the original case.
  const key = id => (regression ? `${id}-REGRESSION` : id);
  assert.equal(process.platform, 'win32', 'The owned fixture requires Windows');
  await fs.mkdir(path.dirname(evidence), { recursive: true });
  await fs.mkdir(evidence);
  await fs.mkdir(path.join(evidence, 'frames'));
  const runId = `targeting-${randomUUID()}`;
  const raw = path.join(ROOT, '.runtime', 'targeting', runId);
  await fs.mkdir(raw, { recursive: true });
  const receiptPath = path.join(raw, 'fixture.json');
  const commandsPath = path.join(raw, 'commands.json');
  const title = `TRACE Computer Fixture — ${runId}`;
  const dialogTitle = `TRACE dialog — ${runId}`;
  const cases = Object.keys(PLAN).filter(id => !only || only.includes(id));
  const planBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, runId, declaredBeforeUiLaunch: true, display: { pinned: PIN, mismatch: 'blocks every case' }, target: 'Owned run-scoped WinForms fixture; exact returned HWND and PID', cases: Object.fromEntries(cases.map(id => [key(id), regression ? { ...PLAN[id], budget: 'Focused regression after a fix; cannot promote or retry the original case' } : PLAN[id]])), cleanup: 'Close sessions, the MCP server and the fixture; verify server and fixture exit' }, null, 2) + '\n');
  await fs.writeFile(path.join(evidence, 'plan.json'), planBytes);
  const receipt = { schemaVersion: 1, runId, plan: { path: 'plan.json', sha256: sha256(planBytes) }, testedSource: await testedSource(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, cases: {}, actions: [], frames: [], cleanup: {} };
  const persist = () => fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await persist();

  const executable = await live.buildFixture();
  receipt.fixtureExecutableSha256 = sha256(await fs.readFile(executable));
  const fixture = spawn(executable, ['--run-id', runId, '--receipt', receiptPath, '--commands', commandsPath], { cwd: ROOT, windowsHide: false, stdio: 'ignore' });
  const state = async () => JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  async function until(predicate, label, ms = 10000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { try { const value = await state(); if (predicate(value)) return value; } catch {} await delay(80); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  let commandId = 0;
  async function command(op, predicate = () => true) {
    const id = ++commandId;
    await fs.writeFile(`${commandsPath}.${id}.tmp`, JSON.stringify({ id, op }));
    await fs.rename(`${commandsPath}.${id}.tmp`, commandsPath);
    return until(value => value.appliedCommandId === id && predicate(value), `fixture command ${op}`);
  }
  let controller;
  let session;
  let current;
  async function keep(observation, label) {
    const bytes = Buffer.from(observation.screenshot.data, 'base64');
    const filename = `frame-${String(receipt.frames.length + 1).padStart(3, '0')}.png`;
    await fs.writeFile(path.join(evidence, 'frames', filename), bytes);
    receipt.frames.push({ path: `frames/${filename}`, sha256: sha256(bytes), label, observationId: observation.observationId, depth: observation.accessibility?.depth, truncated: observation.accessibility?.truncated });
    current = observation;
    return observation;
  }
  const element = (observation, name) => observation.elements.find(item => item.name === name);
  async function act(action, label) {
    const result = await controller.act({ sessionId: session.sessionId, observationId: current.observationId, action });
    receipt.actions.push({ label, type: action.type, outcome: result.outcome, error: result.error?.code ?? null, preparation: result.error?.preparation ?? null });
    if (result.observation) await keep(result.observation, `after ${label}`);
    return result;
  }
  async function openWindow(expectedTitle) {
    if (session) { await controller.closeSession({ sessionId: session.sessionId }); session = undefined; }
    const deadline = Date.now() + 10000;
    let window;
    while (!window && Date.now() < deadline) { window = (await controller.listWindows()).windows.find(item => item.pid === fixture.pid && item.title === expectedTitle); if (!window) await delay(150); }
    assert.ok(window, `Window not found: ${expectedTitle}`);
    session = await controller.openSession({ windowId: window.id });
    return keep(await controller.observe({ sessionId: session.sessionId }), `session ${expectedTitle === title ? 'parent' : 'dialog'}`);
  }
  async function runCase(id, work) {
    if (!cases.includes(id)) return;
    const before = await state();
    try {
      const actual = await work(before);
      receipt.cases[key(id)] = { status: actual.pass ? 'pass' : 'fail', actual };
    } catch (error) {
      receipt.cases[key(id)] = { status: 'fail', error: { code: String(error.code || 'assertion_failed'), message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 600) } };
    }
    receipt.cases[key(id)].fixtureBefore = pick(before);
    receipt.cases[key(id)].fixtureAfter = pick(await state());
    await persist();
  }
  const pick = value => ({ count: value.count, deepCount: value.deepCount, deepEnabled: value.deepEnabled, deepPresent: value.deepPresent, text: value.text, scrollY: value.scrollY, dialogOpen: value.dialogOpen, dialogConfirmed: value.dialogConfirmed, parentEnabled: value.parentEnabled, minimized: value.minimized, focusedControl: value.focusedControl, leftButtonDown: value.leftButtonDown, modifiers: value.modifiers });
  // A rejection passes only if no primary input happened and the fixture state is unchanged.
  async function rejection(action, label, code, keys) {
    const before = await state();
    const result = await act(action, label);
    await delay(400);
    const after = await state();
    const unchanged = keys.every(key => JSON.stringify(after[key]) === JSON.stringify(before[key]));
    return { outcome: result.outcome, code: result.error?.code, preparation: result.error?.preparation ?? [], unchanged, pass: result.outcome === 'not_dispatched' && result.error?.code === code && unchanged };
  }

  try {
    const ready = await until(value => value.revision >= 1, 'fixture readiness', 15000);
    receipt.display = { monitors: ready.monitorCount, width: ready.monitorWidth, height: ready.monitorHeight, dpi: ready.dpiX, pinned: PIN };
    receipt.display.match = ready.monitorCount === PIN.monitors && ready.monitorWidth === PIN.width && ready.monitorHeight === PIN.height && ready.dpiX === PIN.dpi;
    if (!receipt.display.match) { for (const id of cases) receipt.cases[key(id)] = { status: 'blocked', reason: 'Display differs from the pinned mode' }; return receipt; }
    controller = await live.createMcpController(path.join(raw, 'runtime'), raw);
    const doctor = await controller.doctor();
    assert.equal(doctor.ready, true, 'TRACE doctor is not ready');
    receipt.protocol = controller.protocol;
    await openWindow(title);

    await runCase('A33-DEPTH', async () => {
      const shallow = await keep(await controller.observe({ sessionId: session.sessionId }), 'default depth');
      const deep = await keep(await controller.observe({ sessionId: session.sessionId, accessibilityDepth: 16 }), 'depth 16');
      const target = element(deep, 'Deep counter');
      assert.ok(target?.enabled, 'Depth 16 did not expose an enabled deep counter');
      const invoked = await act({ type: 'invoke', elementId: target.id }, 'invoke deep counter');
      const counted = await until(value => value.deepCount >= 1, 'deep counter');
      await delay(300);
      const afterInvoke = await state();
      const rejections = {};
      for (const [change, restore] of [['deep-disable', 'deep-enable'], ['deep-move', null], ['deep-remove', null]]) {
        const fresh = await keep(await controller.observe({ sessionId: session.sessionId, accessibilityDepth: 16 }), `before ${change}`);
        const id = element(fresh, 'Deep counter')?.id;
        assert.ok(id, `Deep counter missing before ${change}`);
        await command(change);
        rejections[change] = await rejection({ type: 'invoke', elementId: id }, `stale deep after ${change}`, 'stale_element', ['deepCount']);
        if (restore) await command(restore);
      }
      const probe = await keep(await controller.observe({ sessionId: session.sessionId }), 'before forged depth');
      let forged;
      try { await controller.act({ sessionId: session.sessionId, observationId: probe.observationId, action: { type: 'activate', accessibilityDepth: 32 } }); forged = 'accepted'; }
      catch (error) { forged = error.code ?? 'rejected'; }
      const final = await state();
      return { pass: element(shallow, 'Deep counter') === undefined && shallow.accessibility.depth === 8 && deep.accessibility.depth === 16 && invoked.outcome === 'completed' && invoked.observation?.accessibility?.depth === 16
          && afterInvoke.deepCount === 1 && Object.values(rejections).every(item => item.pass) && forged !== 'accepted' && final.deepCount === 1,
        defaultDepth: shallow.accessibility, deepDepth: deep.accessibility, deepCountAfterInvoke: afterInvoke.deepCount, invokeOutcome: invoked.outcome, postActionDepth: invoked.observation?.accessibility?.depth, rejections, forgedDepth: forged, deepCountFinal: final.deepCount, counted: counted.deepCount };
    });

    await runCase('A33-OUTCOME', async () => {
      const results = {};
      await keep(await controller.observe({ sessionId: session.sessionId }), 'before move');
      await command('move');
      results.movedWindow = await rejection({ type: 'invoke', elementId: element(current, 'Increment counter').id }, 'stale geometry', 'window_moved', ['count']);
      await keep(await controller.observe({ sessionId: session.sessionId }), 'before scroll');
      const panel = element(current, 'Scrollable fixture panel');
      const point = { x: Math.round(panel.bounds.x + panel.bounds.width / 2 - current.bounds.x), y: Math.round(panel.bounds.y + panel.bounds.height / 2 - current.bounds.y) };
      results.unsupportedScroll = await rejection({ type: 'scroll', ...point, deltaX: 120, deltaY: 0 }, 'horizontal scroll', 'unsupported_action', ['scrollY']);
      await keep(await controller.observe({ sessionId: session.sessionId }), 'before focus');
      const focusedInput = await act({ type: 'click', elementId: element(current, 'TRACE text input').id }, 'focus text input');
      assert.equal(focusedInput.outcome, 'completed');
      await command('focus-option', value => value.focusedControl === 'traceOption');
      results.focusChanged = await rejection({ type: 'type_text', text: 'must not appear' }, 'type after focus moved', 'focus_changed', ['text']);
      results.focusChanged.pass = results.focusChanged.pass && results.focusChanged.preparation.some(item => item.step === 'activation');
      await keep(await controller.observe({ sessionId: session.sessionId }), 'before blocked parent');
      await command('open-dialog', value => value.dialogOpen && !value.parentEnabled);
      results.blockedWindow = await rejection({ type: 'invoke', elementId: element(current, 'Increment counter').id }, 'blocked parent', 'window_blocked', ['count']);
      await command('close-dialog', value => !value.dialogOpen && value.parentEnabled);
      results.staleElement = { reference: 'A33-DEPTH rejections', pass: receipt.cases['A33-DEPTH'] ? Object.values(receipt.cases['A33-DEPTH'].actual?.rejections ?? {}).every(item => item.pass) : false };
      await keep(await controller.observe({ sessionId: session.sessionId }), 'after outcome cases');
      return { pass: Object.values(results).every(item => item.pass), results };
    });

    await runCase('A3-WINDOW', async () => {
      const transitions = {};
      for (const op of ['move', 'minimize']) {
        await keep(await controller.observe({ sessionId: session.sessionId }), `before ${op}`);
        const before = await state();
        await command(op, value => op === 'minimize' ? value.minimized : value.windowX !== before.windowX || value.windowY !== before.windowY);
        const stale = await rejection({ type: 'invoke', elementId: element(current, 'Increment counter').id }, `stale after ${op}`, 'window_moved', ['count']);
        const fresh = await keep(await controller.observe({ sessionId: session.sessionId }), `fresh after ${op}`);
        const restored = await state();
        const hit = await act({ type: 'invoke', elementId: element(current, 'Increment counter').id }, `counter after ${op}`);
        const after = await until(value => value.count === before.count + 1, `counter after ${op}`);
        await delay(300);
        const settled = await state();
        transitions[op] = { stale, freshBounds: fresh.bounds, restoredByObservation: op === 'minimize' ? !restored.minimized && fresh.preparation?.some(item => item.step === 'restore') === true : undefined, hitOutcome: hit.outcome, counterAdded: settled.count - before.count, pass: stale.pass && hit.outcome === 'completed' && settled.count - before.count === 1 && (op !== 'minimize' || !restored.minimized) && after.count === before.count + 1 };
      }
      return { pass: Object.values(transitions).every(item => item.pass), transitions };
    });

    await runCase('A3-DIALOG', async () => {
      await keep(await controller.observe({ sessionId: session.sessionId }), 'before dialog');
      const before = await state();
      const opening = await act({ type: 'click', elementId: element(current, 'Open dialog').id }, 'open dialog');
      const opened = await until(value => value.dialogOpen && !value.parentEnabled, 'modal owner disabled');
      if (!opening.observation) await keep(await controller.observe({ sessionId: session.sessionId }), 'parent while modal');
      const counter = element(current, 'Increment counter');
      const center = { x: Math.round(counter.bounds.x + counter.bounds.width / 2 - current.bounds.x), y: Math.round(counter.bounds.y + counter.bounds.height / 2 - current.bounds.y) };
      const parent = {};
      parent.invoke = await rejection({ type: 'invoke', elementId: counter.id }, 'parent invoke while modal', 'window_blocked', ['count']);
      await keep(await controller.observe({ sessionId: session.sessionId }), 'parent after invoke rejection');
      parent.click = await rejection({ type: 'click', ...center }, 'parent click while modal', 'window_blocked', ['count']);
      await keep(await controller.observe({ sessionId: session.sessionId }), 'parent after click rejection');
      parent.value = await rejection({ type: 'set_value', elementId: element(current, 'TRACE text input').id, value: 'must not be written' }, 'parent value while modal', 'window_blocked', ['text']);
      await openWindow(dialogTitle);
      const confirm = await act({ type: 'invoke', elementId: element(current, 'Confirm dialog').id }, 'confirm dialog');
      const confirmed = await until(value => value.dialogConfirmed && value.dialogOpen, 'dialog confirmation');
      const closing = await act({ type: 'invoke', elementId: element(current, 'Close dialog').id }, 'close dialog');
      // Closing the observed window can make the post-action capture fail; the fixture state resolves it.
      const closed = await until(value => !value.dialogOpen && value.parentEnabled, 'dialog closed and owner enabled');
      await controller.closeSession({ sessionId: session.sessionId });
      session = undefined;
      await openWindow(title);
      const hit = await act({ type: 'invoke', elementId: element(current, 'Increment counter').id }, 'parent counter after dialog');
      const after = await until(value => value.count === before.count + 1, 'parent counter after dialog');
      return { pass: opened.parentEnabled === false && Object.values(parent).every(item => item.pass) && confirm.outcome === 'completed' && confirmed.dialogConfirmed && closed.parentEnabled && hit.outcome === 'completed' && after.count - before.count === 1,
        openingOutcome: opening.outcome, parentEnabledWhileOpen: opened.parentEnabled, parent, confirmOutcome: confirm.outcome, closeOutcome: closing.outcome, closeResolvedBy: closing.outcome === 'completed' ? null : 'Fixture reported dialog closed and owner enabled; no replay', parentEnabledAfterClose: closed.parentEnabled, counterAdded: after.count - before.count };
    });
  } catch (error) {
    receipt.failure = { code: String(error.code || 'harness_error'), message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 600) };
    for (const id of cases) if (!receipt.cases[key(id)]) receipt.cases[key(id)] = { status: 'not_run', reason: 'Not reached after an earlier stop' };
  } finally {
    const outcomes = await Promise.allSettled([controller?.close(), live.stopFixture(fixture)]);
    receipt.cleanup = { server: outcomes[0].status === 'fulfilled' ? outcomes[0].value ?? null : { error: String(outcomes[0].reason?.code || 'close_failed') }, fixtureExited: fixture.exitCode !== null || fixture.signalCode !== null, finalState: pick(await state().catch(() => ({}))) };
    receipt.sourcesUnchangedDuringRun = JSON.stringify((await testedSource()).files) === JSON.stringify(receipt.testedSource.files);
    const statuses = cases.map(id => receipt.cases[key(id)]?.status);
    receipt.result = statuses.includes('fail') ? 'fail' : statuses.every(status => status === 'pass') ? 'pass' : 'pending';
    receipt.observedAt = new Date().toISOString();
    await persist();
  }
  return receipt;
}

async function main(args = process.argv.slice(2)) {
  if (!args.includes('--live') || args.indexOf('--evidence') < 0) throw new Error('Usage: node scripts/accept-targeting.cjs --live --evidence evidence/<new directory> [--only A33-DEPTH,...] [--regression]');
  const evidence = path.resolve(ROOT, args[args.indexOf('--evidence') + 1]);
  const relative = path.relative(path.join(ROOT, 'evidence'), evidence);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Evidence must stay inside evidence/');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
  const receipt = await run(evidence, only, args.includes('--regression'));
  return { result: receipt.result, cases: Object.fromEntries(Object.entries(receipt.cases).map(([id, value]) => [id, value.status])), failure: receipt.failure ?? null };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
module.exports = { main, PLAN };
