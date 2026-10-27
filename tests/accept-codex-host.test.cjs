'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const driver = require('../scripts/accept-codex-host.cjs');
const tool = (name, result, args = {}) => ({ name: `trace_computer_${name}`, result, arguments: { ...(!['doctor', 'open_session'].includes(name) ? { sessionId: 'synthetic' } : {}), ...args } });
const target = { pid: 42, title: 'synthetic fixture', id: '123', processCreationTime: '456', sessionId: 1 };
function frame(suffix) {
  const elements = [{ id: `opaque-edit-${suffix}`, automationId: 'traceTextInput', name: 'TRACE text input', controlType: 'Edit', enabled: true }, { id: `opaque-button-${suffix}`, automationId: 'traceIncrement', name: 'Increment counter', controlType: 'Button', enabled: true }];
  return { sessionId: 'synthetic', window: target, observationId: suffix, elements, screenshot: { sha256: 'a'.repeat(64) }, focused: { available: true, hasFocus: true, elementId: elements[0].id, name: elements[0].name, controlType: 'Edit', binding: 'observed-control' } };
}
const obs = frame('focused');
const image = { ref: 'evidence/frame.png', sha256: 'a'.repeat(64) };
const chain = ['node', 'supervisor', 'marker'].map((role, i) => ({ role, pid: 10 + i, processCreationTime: '123', session: 1, parentPid: 9 + i }));
function context(step) { return { target, events: baseline().slice(0, driver.STEPS.indexOf(step)).map(host => ({ step: host.step, host })) }; }
function event(step, tools) { return { source: 'actual-connected-codex', step, tools, images: [image], modelInspection: 'Synthetic injected image inspection for tests only.' }; }
function baseline() { return [
  { ...event('discovery', [tool('doctor', { ready: true })]), skillReads: { trace: true, rea: true, references: ['operation-and-recovery.md', 'readiness-routing.md'] } },
  { ...event('opened', [tool('open_session', { sessionId: 'synthetic', window: target }), tool('observe', frame('opened'))]), chain },
  event('focused', [tool('act', { outcome: 'completed', observation: frame('focused') }, { observationId: 'opened', action: { type: 'click', elementId: 'opaque-edit-opened' } })]),
  event('typed', [tool('act', { outcome: 'completed', observation: frame('typed') }, { observationId: 'focused', action: { type: 'type_text', text: driver.PAYLOAD } })]),
  event('stale-rejected', [tool('act', { outcome: 'not_dispatched', code: 'stale_observation' }, { observationId: 'focused', action: { type: 'invoke', elementId: 'opaque-button-focused' } })]),
  event('fresh-counter', [tool('observe', frame('fresh')), tool('act', { outcome: 'completed', observation: frame('incremented') }, { observationId: 'fresh', action: { type: 'invoke', elementId: 'opaque-button-fresh' } })]),
  { ...event('closed', [tool('close_session', { closed: true })]), nativeExits: [{ role: 'supervisor', exited: true }, { role: 'marker', exited: true }], adjudication: { by: 'active-codex-model', actualConversationEvidenceReviewed: true, actualImagesInspected: true } },
]; }
const empty = { text: '', count: 0, focusedControl: 'traceTextInput' };
const typed = { ...empty, text: driver.PAYLOAD };
test('import and plan never execute a process or claim', () => {
  const script = `const cp=require('node:child_process');cp.spawn=cp.execFile=()=>{throw Error('unexpected execution')}; const m=require('./scripts/accept-codex-host.cjs'); console.log(JSON.stringify(m.plan()))`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).claimsAttempt, false);
});
test('fixed historical budget and original attempt flags fail closed', () => {
  assert.equal(driver.plan({ continuationAttempt: 2 }).lifetimeAttemptOrdinal, 4);
  assert.equal(driver.plan().historicalAttemptsUsed, 2);
  assert.throws(() => driver.plan({ attempt: 3 }));
  assert.throws(() => driver.parseArgs(['--attempt', '3']));
  assert.throws(() => driver.parseArgs(['--continuation', '3']));
});
test('Codex amendment plan and CLI preserve explicit new decision and lifetime 5 or 6', () => {
  const first = driver.parseArgs(['--plan', '--amendment', '2', '--continuation', '1', '--decision-ref', 'evidence/amendment-decision.json']);
  const declared = driver.plan(first); assert.equal(declared.lifetimeAttemptOrdinal, 5); assert.equal(declared.historicalAttemptsUsed, 4);
  assert.equal(declared.ownerDecision, 'evidence/amendment-decision.json'); assert.equal(declared.history.length, 4);
  assert.equal(driver.plan({ amendment: 2, continuationAttempt: 2 }).lifetimeAttemptOrdinal, 6);
  assert.throws(() => driver.plan({ amendment: 3, continuationAttempt: 1 }));
  assert.throws(() => driver.parseArgs(['--amendment', '2']), { code: 'explicit_continuation_required' });
  assert.equal(driver.plan({ continuationAttempt: 2 }).lifetimeAttemptOrdinal, 4);
});
test('amendment CLI never advertises the original approval and requires an explicit decision before start', async () => {
  const options = driver.parseArgs(['--plan', '--amendment', '2', '--continuation', '1']);
  assert.equal(options.decisionRef, undefined); assert.equal(driver.plan(options).ownerDecision, null);
  assert.equal(driver.parseArgs(['--plan']).decisionRef, require('../scripts/continuation-adapter.cjs').DECISION);
  assert.throws(() => driver.parseArgs(['--start', '--amendment', '2', '--continuation', '1']), { code: 'amendment_decision_required' });
  let prepares = 0;
  await assert.rejects(driver.start({ amendment: 2, continuationAttempt: 1 }, { prepare: async () => { prepares++; } }), { code: 'amendment_decision_required' });
  assert.equal(prepares, 0);
});
test('amended Codex start forwards the new actual decision instead of substituting the previous decision', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-codex-amended-forward-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence'));
  let received, launches = 0;
  const receipt = await driver.start({ directory: 'evidence/run', amendment: 2, continuationAttempt: 1, decisionRef: 'evidence/new-actual-decision.json' }, {
    root, prepare: async () => ({ fixture: {} }), claimRequest: async input => { received = input; return {}; },
    claim: async () => { throw Object.assign(new Error(), { code: 'invalid_continuation' }); }, launch: async () => { launches++; } });
  assert.equal(received.amendment, 2); assert.equal(received.decisionRef, 'evidence/new-actual-decision.json');
  assert.equal(launches, 0); assert.equal(receipt.status, 'blocked');
});
test('checkpoint order and actual connected provenance required', () => {
  assert.throws(() => driver.validateCheckpoint(event('typed', []), typed, context('focused')), /checkpoint_order/);
  assert.throws(() => driver.validateCheckpoint({ ...event('discovery', []), source: 'sdk' }, empty, context('discovery')), /checkpoint_order/);
});
test('discovery independently requires TRACE and REA instruction reads', () => {
  const e = event('discovery', [tool('doctor', { ready: true })]);
  e.skillReads = { trace: true, rea: true, references: ['operation-and-recovery.md', 'readiness-routing.md'] };
  assert.equal(driver.validateCheckpoint(e, empty, context('discovery')).count, 0);
  e.skillReads.rea = false; assert.throws(() => driver.validateCheckpoint(e, empty, context('discovery')), /skill_discovery/);
});
test('focus requires public bound focus, independent edit focus, image and exact target', () => {
  const e = baseline()[2];
  assert.equal(driver.validateCheckpoint(e, empty, context('focused')).focusedControl, 'traceTextInput');
  assert.throws(() => driver.validateCheckpoint(e, { ...empty, focusedControl: 'none' }, context('focused')), /focus_unproven/);
  assert.throws(() => driver.validateCheckpoint({ ...e, images: [] }, empty, context('focused')), /image_inspection/);
  assert.throws(() => driver.validateCheckpoint(e, empty, { ...context('focused'), target: { ...target, pid: 43 } }), /target_mismatch/);
});
test('exact Unicode delivery cannot be inferred from completed or escaped log', () => {
  const e = baseline()[3];
  assert.equal(driver.validateCheckpoint(e, typed, context('typed')).textExact, true);
  assert.throws(() => driver.validateCheckpoint(e, { ...typed, text: 'TRACE Codex verified cafÃ©' }, context('typed')), /independent_effect/);
  e.tools.push(e.tools[0]); assert.throws(() => driver.validateCheckpoint(e, typed, context('typed')), /unexpected_action_count/);
});
test('stale invocation uses consumed ID with no dispatch and unchanged independent count', () => {
  const e = baseline()[4];
  assert.equal(driver.validateCheckpoint(e, typed, context('stale-rejected')).count, 0);
  assert.throws(() => driver.validateCheckpoint(e, { ...typed, count: 1 }, context('stale-rejected')), /independent_effect/);
  e.tools[0].arguments.observationId = 'other'; assert.throws(() => driver.validateCheckpoint(e, typed, context('stale-rejected')), /stale_rejection/);
});
test('fresh counter binds the current observation and exact counter element', () => {
  const e = baseline()[5];
  assert.equal(driver.validateCheckpoint(e, { ...typed, count: 1 }, context('fresh-counter')).count, 1);
  e.tools[1].arguments.observationId = 'consumed'; assert.throws(() => driver.validateCheckpoint(e, { ...typed, count: 1 }, context('fresh-counter')), /fresh_recovery/);
});
test('opaque IDs change across observations and never substitute AutomationIds', () => {
  const e = baseline()[2], previous = context('focused');
  assert.notEqual(previous.events.at(-1).host.tools[1].result.elements[0].id, e.tools[0].result.observation.focused.elementId);
  assert.equal(driver.validateCheckpoint(e, empty, previous).focusedControl, 'traceTextInput');
  e.tools[0].arguments.action.elementId = 'traceTextInput';
  assert.throws(() => driver.validateCheckpoint(e, empty, previous), /focus_action_unbound/);
  const badFocus = baseline()[2]; badFocus.tools[0].result.observation.focused.elementId = 'opaque-edit-opened';
  assert.throws(() => driver.validateCheckpoint(badFocus, empty, context('focused')), /focus_unproven/);
  const wrongButton = baseline()[5]; wrongButton.tools[1].arguments.action.elementId = 'traceIncrement';
  assert.throws(() => driver.validateCheckpoint(wrongButton, { ...typed, count: 1 }, context('fresh-counter')), /fresh_recovery/);
});
test('semantic control match must be unique and session/action types remain exact', () => {
  const e = baseline()[2], duplicate = context('focused');
  const priorFrame = duplicate.events.at(-1).host.tools[1].result;
  priorFrame.elements.push({ ...priorFrame.elements[0], id: 'another-opaque-edit' });
  assert.throws(() => driver.validateCheckpoint(e, empty, duplicate), /semantic_element_ambiguous/);
  for (const index of [2, 3, 4, 5]) {
    const wrongSession = baseline()[index]; wrongSession.tools.at(-1).arguments.sessionId = 'other-session';
    assert.throws(() => driver.validateCheckpoint(wrongSession, index === 2 ? empty : index === 5 ? { ...typed, count: 1 } : typed, context(wrongSession.step)), /session_mismatch/);
    const wrongType = baseline()[index]; wrongType.tools.at(-1).arguments.action.type = index === 3 ? 'type' : 'set_value';
    assert.throws(() => driver.validateCheckpoint(wrongType, index === 2 ? empty : index === 5 ? { ...typed, count: 1 } : typed, context(wrongType.step)), /focus_action_unbound|typing_unproven|stale_action_unbound|fresh_recovery_unproven/);
  }
  const badImage = baseline()[5]; badImage.tools[1].result.observation.screenshot.sha256 = 'b'.repeat(64);
  assert.throws(() => driver.validateCheckpoint(badImage, { ...typed, count: 1 }, context('fresh-counter')), /tool_image_binding_missing/);
});
test('explicit refresh preserves semantic sequence and binds a changed fresh focus observation', () => {
  const ctx = context('focused'), fresh = frame('refresh-before-focus');
  const refresh = { ...event('refresh', [tool('observe', fresh)]), nextStep: 'focused' };
  const independent = driver.validateRefresh(refresh, empty, ctx);
  ctx.refreshes = [{ beforeStep: 'focused', afterStepCount: 2, host: refresh, independent }];
  assert.equal(ctx.events.length, 2);
  const oldAction = baseline()[2];
  assert.throws(() => driver.validateCheckpoint(oldAction, empty, ctx), /focus_action_unbound/);
  oldAction.tools[0].arguments.observationId = fresh.observationId; oldAction.tools[0].arguments.action.elementId = fresh.elements[0].id;
  assert.equal(driver.validateCheckpoint(oldAction, empty, ctx).count, 0);
  const fakeRefresh = { ...refresh, tools: [] }; assert.throws(() => driver.validateRefresh(fakeRefresh, empty, ctx), /refresh_requires_actual_observe/);
  assert.throws(() => driver.validateRefresh(refresh, empty, ctx), /refresh_observation_unchanged/);
});
test('typing refresh checks public plus independent focus and preserves consumed frame for stale rejection', () => {
  const ctx = context('typed'), fresh = frame('refresh-before-typing');
  const refresh = { ...event('refresh', [tool('observe', fresh)]), nextStep: 'typed' };
  assert.throws(() => driver.validateRefresh(refresh, { ...empty, focusedControl: 'none' }, ctx), /focus_unproven/);
  const missingPublic = structuredClone(refresh); missingPublic.tools[0].result.focused.hasFocus = false;
  assert.throws(() => driver.validateRefresh(missingPublic, empty, ctx), /focus_unproven/);
  driver.validateRefresh(refresh, empty, ctx);
  ctx.refreshes = [{ beforeStep: 'typed', afterStepCount: 3, host: refresh }];
  const typeEvent = baseline()[3];
  assert.throws(() => driver.validateCheckpoint(typeEvent, typed, ctx), /typing_unproven/);
  typeEvent.tools[0].arguments.observationId = fresh.observationId;
  driver.validateCheckpoint(typeEvent, typed, ctx);
  ctx.events.push({ step: 'typed', host: typeEvent });
  const stale = baseline()[4]; stale.tools[0].arguments.observationId = fresh.observationId; stale.tools[0].arguments.action.elementId = fresh.elements[1].id;
  assert.equal(driver.validateCheckpoint(stale, typed, ctx).count, 0);
  stale.tools[0].arguments.action.elementId = 'opaque-button-focused'; assert.throws(() => driver.validateCheckpoint(stale, typed, ctx), /stale_action_unbound/);
});
test('inline fresh observations bind input while expired MCP rejection stays blocked', () => {
  for (const index of [2, 3]) {
    const e = baseline()[index], fresh = frame(`inline-${index}`), action = e.tools[0];
    action.arguments.observationId = fresh.observationId;
    if (index === 2) action.arguments.action.elementId = fresh.elements[0].id;
    e.tools.unshift(tool('observe', fresh));
    assert.ok(driver.validateCheckpoint(e, index === 2 ? empty : typed, context(e.step)));
    action.result = { outcome: 'not_dispatched', code: 'stale_observation', observation: action.result.observation };
    assert.throws(() => driver.validateCheckpoint(e, index === 2 ? empty : typed, context(e.step)), /focus_unproven|typing_unproven/);
  }
});
test('cleanup does not infer process exit from clear recovery and all-up alone', async () => {
  const receipt = { events: [{ step: 'opened', host: { chain } }], cleanup: {} };
  const command = async args => args[0] === 'keystate' ? { down: [] } : { recoveryRequired: false };
  await assert.rejects(driver.verifyCleanup(receipt, { command, probe: async () => ({ alive: true, processCreationTime: '123', session: 1 }) }), /native_exit_unconfirmed/);
  await driver.verifyCleanup(receipt, { command, probe: async identity => identity.role === 'node' ? { alive: true, processCreationTime: '123', session: 1 } : { alive: false } });
  assert.equal(receipt.cleanup.nativeChainVerified, true);
  await assert.rejects(driver.verifyCleanup(receipt, { command: async () => ({ down: [1], recoveryRequired: false }) }), /cleanup_unconfirmed/);
});
test('failed claim never launches a fixture; terminal receipt preserves block', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-driver-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence')); let launches = 0;
  const receipt = await driver.start({ directory: 'evidence/run', continuationAttempt: 1 }, { root, prepare: async () => ({ fixture: {} }), claimRequest: async () => ({}), claim: async () => { throw Object.assign(new Error(), { code: 'invalid_continuation' }); }, launch: async () => { launches++; } });
  assert.equal(launches, 0); assert.equal(receipt.status, 'blocked'); assert.equal(receipt.error.code, 'invalid_continuation');
});
test('atomic claim precedes launch and launch failure has a retained terminal receipt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-driver-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence')); const order = [];
  const receipt = await driver.start({ directory: 'evidence/run', continuationAttempt: 1 }, { root, prepare: async () => ({ fixture: {} }), claimRequest: async () => ({}), claim: async () => { order.push('claim'); return { claimId: 'synthetic-test-only' }; }, launch: async () => { order.push('launch'); throw Object.assign(new Error(), { code: 'fixture_launch_failed' }); } });
  assert.deepEqual(order, ['claim', 'launch']); assert.equal(receipt.claimId, 'synthetic-test-only'); assert.equal(receipt.status, 'blocked'); assert.ok(receipt.completedAt);
});
test('injected full lifecycle retains exact fixture until native exits and preserves live scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-driver-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence')); const bytes = Buffer.from('injected synthetic PNG stand-in; no native capture');
  const digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(root, 'evidence/frame.png'), bytes);
  const semantic = baseline(), focusRefresh = frame('full-focus-refresh'), typingRefresh = frame('full-typing-refresh');
  semantic[2].tools[0].arguments.observationId = focusRefresh.observationId; semantic[2].tools[0].arguments.action.elementId = focusRefresh.elements[0].id;
  semantic[3].tools[0].arguments.observationId = typingRefresh.observationId;
  semantic[4].tools[0].arguments.observationId = typingRefresh.observationId; semantic[4].tools[0].arguments.action.elementId = typingRefresh.elements[1].id;
  const events = [semantic[0], semantic[1], { ...event('refresh', [tool('observe', focusRefresh)]), nextStep: 'focused' }, semantic[2], { ...event('refresh', [tool('observe', typingRefresh)]), nextStep: 'typed' }, ...semantic.slice(3)].map(e => {
    for (const item of e.tools) { if (item.result?.screenshot) item.result.screenshot.sha256 = digest; if (item.result?.observation) item.result.observation.screenshot.sha256 = digest; }
    return { ...e, images: [{ ref: 'evidence/frame.png', sha256: digest }] };
  });
  let states = 0, closed = 0, probes = 0;
  const receipt = await driver.start({ directory: 'evidence/run', continuationAttempt: 1 }, {
    root, prepare: async () => ({ fixture: { executable: 'synthetic-test-only' } }), claimRequest: async () => ({}), claim: async () => ({ claimId: 'synthetic-test-only' }),
    launch: async () => ({ ...target, state: async () => { const n = states++; return n < 6 ? empty : n < 8 ? typed : { ...typed, count: 1 }; }, close: async () => { assert.ok(probes >= 6); closed++; return { exited: true }; } }),
    probe: async identity => { probes++; return identity.pid === 42 ? { alive: true, processCreationTime: '456', session: 1 } : probes <= 3 || identity.role === 'node' ? { ...identity, alive: true } : { alive: false }; },
    command: async args => args[0] === 'keystate' ? { down: [] } : { recoveryRequired: false },
    ready: async ({ runtime }) => { for (let i = 0; i < events.length; i++) { const ref = `evidence/step-${i}.json`; await fs.writeFile(path.join(root, ref), JSON.stringify(events[i])); await fs.writeFile(path.join(runtime, `command-${i + 1}.json`), JSON.stringify({ mode: events[i].step === 'closed' ? 'finalize' : events[i].step === 'refresh' ? 'refresh' : 'checkpoint', evidence: ref })); } },
  });
  assert.equal(receipt.status, 'pass', JSON.stringify(receipt.error)); assert.equal(closed, 1); assert.equal(receipt.events.length, 7); assert.equal(receipt.cleanup.fixtureRetained, false);
  assert.equal(receipt.refreshes.length, 2); assert.equal(JSON.parse(await fs.readFile(path.join(root, 'evidence/run/refresh-2.json'))).beforeStep, 'typed');
});
test('prepared fixture validates every source and output without rebuilding', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-prepared-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, '.runtime/computer-fixture'); await fs.mkdir(path.join(folder, 'bin'), { recursive: true });
  const sources = ['tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj', 'scripts/smoke-computer-live.cjs'];
  const outputs = ['TraceComputerFixture.exe', 'TraceComputerFixture.dll', 'TraceComputerFixture.runtimeconfig.json', 'TraceComputerFixture.deps.json'];
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const manifest = { schemaVersion: 1, uiCreated: 0, inputActions: 0, sources: {}, files: {} };
  for (const file of sources) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), file); manifest.sources[file] = hash(file); }
  for (const file of outputs) { await fs.writeFile(path.join(folder, 'bin', file), file); manifest.files[file] = hash(file); }
  await fs.writeFile(path.join(folder, 'prepared-manifest.json'), JSON.stringify(manifest));
  assert.ok((await driver.preparedFixture(root)).executable.endsWith('TraceComputerFixture.exe'));
  await fs.writeFile(path.join(folder, 'bin/TraceComputerFixture.dll'), 'stale');
  await assert.rejects(driver.preparedFixture(root), /fixture_manifest_stale/);
});
test('unknown cleanup retains ChildProcess authority until explicit reconciliation without replay', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retention-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence')); let closed = 0, cleanupPending = false, launched = 0;
  const receipt = await driver.start({ directory: 'evidence/run', continuationAttempt: 1 }, {
    root, prepare: async () => ({ fixture: {} }), claimRequest: async () => ({}), claim: async () => ({ claimId: 'synthetic' }),
    launch: async () => { launched++; return { ...target, state: async () => empty, close: async () => { assert.equal(cleanupPending, true); closed++; return { exited: true }; } }; },
    command: async args => args[0] === 'keystate' ? { down: [] } : { recoveryRequired: false },
    probe: async identity => identity.role === 'node' ? { alive: true, processCreationTime: identity.processCreationTime, session: identity.session } : { alive: false },
    ready: async ({ runtime, cleanupPending: pending }) => {
      assert.equal(closed, 0);
      if (!pending) await fs.writeFile(path.join(runtime, 'command-1.json'), JSON.stringify({ mode: 'abort' }));
      else {
        cleanupPending = true;
        const evidence = 'evidence/cleanup.json';
        await fs.writeFile(path.join(root, evidence), JSON.stringify({ source: 'actual-connected-codex', step: 'cleanup-only', chain, adjudication: { by: 'active-codex-model', actualConversationEvidenceReviewed: true } }));
        await fs.writeFile(path.join(runtime, 'command-2.json'), JSON.stringify({ mode: 'reconcile', evidence }));
      }
    },
  });
  assert.equal(launched, 1); assert.equal(closed, 1); assert.equal(receipt.status, 'blocked'); assert.equal(receipt.error.code, 'owner_aborted'); assert.equal(receipt.cleanup.fixtureRetained, false);
});
