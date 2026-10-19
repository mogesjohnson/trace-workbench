#!/usr/bin/env node
'use strict';

// Focused disabled-owner regression. Fixture commands establish/close the modal;
// MCP input requests must be rejected before any mouse, keyboard or UIA mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { buildFixture, createMcpController, sourceHashes, stopFixture } = require('./smoke-computer-live.cjs');
const { runProcess, parseJson, DEFAULT_BRIDGE } = require('../src/computer/winapp-backend.cjs');
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'evidence', '0.1.0-alpha.3', 'modal-guard');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, description) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--live'], 'Explicit --live is required for the owned fixture');
  const executable = await buildFixture();
  const runId = `trace-guard-${randomUUID()}`;
  const runtime = path.join(ROOT, '.runtime', 'computer-live', runId);
  const receipt = path.join(runtime, 'fixture-receipt.json');
  const commands = path.join(runtime, 'commands.json');
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(REPORT, { recursive: true });
  const sources = await sourceHashes();
  sources.push({ path: 'scripts/smoke-computer-modal-guard.cjs', sha256: digest(await fs.readFile(__filename)) });
  const revision = await runProcess('git', ['rev-parse', 'HEAD']);
  const changes = await runProcess('git', ['status', '--porcelain']);
  assert.equal(revision.exitCode, 0);
  assert.equal(changes.exitCode, 0);
  const plan = {
    caseId: 'A3-MODAL-GUARD-REGRESSION', scope: 'Focused guard check; not a third full A3-DIALOG workflow attempt',
    initialState: 'Owned synthetic modal opened by its fixture command channel; native owner disabled',
    actions: ['Read native enabled state', 'Request parent activation, click, invocation and value edit; each must reject before input'],
    expected: { error: 'window_blocked', count: 0, text: '', leftButtonDown: false },
    cleanup: 'Release session; close modal by fixture command; close owned server and fixture', sources,
  };
  const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  await fs.writeFile(path.join(REPORT, 'plan.json'), planBytes);
  const summary = {
    schemaVersion: 1, runId, caseId: plan.caseId, lifecycle: 'running', result: 'running',
    milestoneStatus: 'incomplete', runtime: { node: process.version, platform: process.platform, arch: process.arch },
    plan: { path: 'plan.json', sha256: digest(planBytes) }, testedSource: { baseCommit: revision.stdout.trim(), workingTreeModified: !!changes.stdout.trim(), files: sources },
    expected: plan.expected, requests: [], frames: [],
    scope: plan.scope, limits: ['Does not complete modal confirmation/recovery, full MCP cancellation, or DPI/monitor acceptance.'],
  };
  let controller, fixture, session, failure;
  let commandId = 0;
  async function state() {
    try { return JSON.parse(await fs.readFile(receipt, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function command(op) {
    await fs.writeFile(commands + '.tmp', JSON.stringify({ id: ++commandId, op }));
    await fs.rename(commands + '.tmp', commands);
  }
  const save = () => fs.writeFile(path.join(REPORT, 'receipt.json'), JSON.stringify(summary, null, 2) + '\n');
  await save();
  try {
    controller = await createMcpController(path.join(runtime, 'controller'), runtime);
    assert.equal((await controller.doctor()).ready, true, 'Rebuild the changed native bridge before testing');
    fixture = spawn(executable, ['--run-id', runId, '--receipt', receipt, '--commands', commands], { cwd: ROOT, windowsHide: false, stdio: 'ignore' });
    let spawnError;
    fixture.on('error', error => { spawnError = error; });
    await waitFor(async () => {
      if (spawnError) throw spawnError;
      const value = await state();
      return value?.runId === runId && value.parentEnabled;
    }, 'fixture ready');
    const window = await waitFor(async () => (await controller.listWindows()).windows.find(item => item.pid === fixture.pid && item.title === `TRACE Computer Fixture — ${runId}`), 'exact owned parent');
    await command('open-dialog');
    const opened = await waitFor(async () => {
      const value = await state();
      return value?.dialogOpen && !value.parentEnabled ? value : null;
    }, 'native owner disabled');
    const beforeBytes = Buffer.from(JSON.stringify(opened, null, 2) + '\n');
    await fs.writeFile(path.join(REPORT, 'before.json'), beforeBytes);
    summary.before = { path: 'before.json', sha256: digest(beforeBytes) };
    const bounds = parseJson(...await runProcess(DEFAULT_BRIDGE, ['bounds', window.id, String(window.pid)]).then(value => [value.stdout, value.stderr, value.exitCode]));
    assert.equal(bounds.enabled, false);
    summary.nativeOwner = { enabled: bounds.enabled, method: bounds.method };
    await assert.rejects(async () => {
      const value = await runProcess(DEFAULT_BRIDGE, ['activate', window.id, String(window.pid)]);
      parseJson(value.stdout, value.stderr, value.exitCode);
    }, error => error.code === 'window_blocked');
    summary.nativeActivationRejected = true;
    session = await controller.openSession({ windowId: window.id });
    for (const type of ['click', 'invoke', 'set_value']) {
      const observation = await controller.observe({ sessionId: session.sessionId });
      assert.equal(observation.window.pid, fixture.pid);
      assert.equal(observation.window.id, window.id);
      if (!summary.frames.length) {
        const bytes = Buffer.from(observation.screenshot.data, 'base64');
        assert.equal(bytes.readUInt32BE(16), observation.bounds.width);
        assert.equal(bytes.readUInt32BE(20), observation.bounds.height);
        await fs.writeFile(path.join(REPORT, 'parent.png'), bytes);
        summary.frames.push({ path: 'parent.png', sha256: digest(bytes), width: observation.bounds.width, height: observation.bounds.height });
      }
      const name = type === 'set_value' ? 'TRACE text input' : 'Increment counter';
      const element = observation.elements.find(item => item.name === name);
      assert.ok(element, `Missing ${name}`);
      // Coordinates bypass a provider's disabled descendant flag for the click case;
      // the product's native owner check must still prevent dispatch.
      const action = type === 'click' ? { type, x: Math.round(element.bounds.x + element.bounds.width / 2 - observation.bounds.x), y: Math.round(element.bounds.y + element.bounds.height / 2 - observation.bounds.y) }
        : { type, elementId: element.id, ...(type === 'set_value' ? { value: 'must not be written' } : {}) };
      const result = await controller.act({ sessionId: session.sessionId, observationId: observation.observationId, action });
      assert.equal(result.outcome, 'unknown');
      assert.equal(result.error?.code, 'window_blocked');
      summary.requests.push({ type, outcome: result.outcome, error: result.error.code });
      const after = await state();
      assert.equal(after.count, 0);
      assert.equal(after.text, '');
      assert.equal(after.parentEnabled, false);
      assert.equal(after.leftButtonDown, false);
    }
    await controller.closeSession({ sessionId: session.sessionId });
    session = undefined;
    await command('close-dialog');
    const restored = await waitFor(async () => {
      const value = await state();
      return value && !value.dialogOpen && value.parentEnabled ? value : null;
    }, 'owner restored');
    const afterBytes = Buffer.from(JSON.stringify(restored, null, 2) + '\n');
    await fs.writeFile(path.join(REPORT, 'after.json'), afterBytes);
    summary.after = { path: 'after.json', sha256: digest(afterBytes) };
    summary.actual = { error: 'window_blocked', count: restored.count, text: restored.text, leftButtonDown: restored.leftButtonDown, dispatchedInput: 0 };
  } catch (error) { failure = error; }
  finally {
    if (session) await controller.closeSession({ sessionId: session.sessionId }).catch(error => { failure ??= error; });
    const cleanup = await Promise.allSettled([controller?.close(), stopFixture(fixture)]);
    const failed = cleanup.find(item => item.status === 'rejected');
    if (failed) failure ??= failed.reason;
    summary.cleanup = { server: cleanup[0].status === 'fulfilled' ? cleanup[0].value : null, fixtureExited: !fixture || fixture.exitCode !== null || fixture.signalCode !== null };
    const finalSources = await sourceHashes();
    finalSources.push({ path: 'scripts/smoke-computer-modal-guard.cjs', sha256: digest(await fs.readFile(__filename)) });
    summary.sourcesUnchangedDuringRun = JSON.stringify(sources) === JSON.stringify(finalSources);
    if (!summary.sourcesUnchangedDuringRun) failure ??= new Error('Sources changed during the guard check');
    summary.lifecycle = 'completed';
    summary.result = failure ? 'failed' : 'passed';
    summary.observedAt = new Date().toISOString();
    if (failure) summary.failure = { code: failure.code || 'assertion_failed', message: String(failure.message).replaceAll(ROOT, '<repo>').slice(0, 1500) };
    await save();
  }
  console.log(JSON.stringify({ result: summary.result, report: path.relative(ROOT, path.join(REPORT, 'receipt.json')), inputDispatched: summary.actual?.dispatchedInput ?? null }));
  if (failure) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
