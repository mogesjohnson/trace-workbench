#!/usr/bin/env node
'use strict';

// Proposal-only acceptance entry point. Import/--plan do not inspect desktop state or launch UI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const common = require('./replacement-acceptance-common.cjs');
const DRIVER = 'scripts/accept-replacement-recovery.cjs';
const REGISTRY = Object.freeze({
  'R32-CANCEL-MOUSE-COMPLETE': Object.freeze({ input: 'mouse', replaces: Object.freeze(['A32-RECOVERY-CANCEL-MOUSE']), historicalStatus: 'Original fail and corrective blocked terminal record retained unchanged.' }),
  'R32-CANCEL-TYPING-COMPLETE': Object.freeze({ input: 'typing', replaces: Object.freeze(['A32-RECOVERY-CANCEL-TYPING', 'A32-PROBE-FOCUSED-TYPING', 'A32-PROBE-FOCUSED-TYPING-REGRESSION']), historicalStatus: 'Original two blocked cancellation attempts and exhausted focused-typing failures retained unchanged.' }),
});

function optionsFor(input = {}) {
  if (!Object.hasOwn(REGISTRY, input.caseId)) throw common.failure('invalid_plan', 'Select exactly R32-CANCEL-MOUSE-COMPLETE or R32-CANCEL-TYPING-COMPLETE.');
  return common.optionsFor(input, input.caseId);
}
function parseArgs(args) {
  const options = {};
  const flags = { '--case': 'caseId', '--owner-decision': 'ownerDecision', '--attempt': 'attempt', '--prior': 'prior', '--change': 'change' };
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item === '--plan' || item === '--live') options.mode = item.slice(2);
    else if (flags[item]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw common.failure('invalid_plan', `Missing value for ${item}.`);
      options[flags[item]] = item === '--attempt' ? Number(args[++i]) : args[++i];
    } else if (!item.startsWith('--') && !options.directory) options.directory = item;
    else throw common.failure('invalid_plan', 'Unknown replacement recovery option.');
  }
  return optionsFor(options);
}
function plan(input = {}) {
  const options = optionsFor(input), selected = REGISTRY[options.caseId];
  return { schemaVersion: 1, planContract: 1, caseId: options.caseId, replaces: [...selected.replaces], historicalStatus: selected.historicalStatus,
    acceptancePlan: 'docs/REPLACEMENT_ACCEPTANCE_PLAN.md', ownerDecision: options.ownerDecision ?? null,
    executionRequiresExplicitOwnerDecision: true, attempt: options.attempt, declaredBeforeUiLaunch: true,
    ...(options.prior ? { prior: options.prior, changedPrecondition: options.change } : {}),
    display: options.pinnedDisplay ?? 'Pin the actual authoritative single-monitor native manifest before UI; recheck before coordinate input.',
    target: 'One fresh exact synthetic computer fixture through the production MCP/controller/native supervisor controlled-provider path.',
    initial: { count: 0, text: '', keysDown: [], recoveryRequired: false },
    actions: ['One pinned-engine focus click on the uniquely observed text input; require public bound focus and independent traceTextInput focus',
      selected.input === 'mouse' ? 'One MCP drag between adjacent empty lower-right points; private controlled left-button hold at measured start' : 'One MCP type_text literal abc; private controlled type-hold abc with C down',
      'Independently prove held input/job dispatch, then cancel this one request via standard SDK AbortSignal',
      'Require unknown delivery, native cancelled, exact owned input exit and independently all-up input, clear recovery and native-owner exit',
      'After cleanup, one newly declared pinned-engine counter invocation under a distinct artifact root; count 0 to 1'],
    expected: { nativeCode: 'cancelled', primaryOutcome: 'unknown', countBeforeFollowup: 0, countAfterFollowup: 1,
      text: selected.input === 'typing' ? '^abc+$; exact string retained, repeated C count recorded, stable after cleanup' : '', provider: 'controlled; setup/followup pinned-engine' },
    cleanup: 'Settle/cancel the one request; close native/MCP; prove process exit and input release while fixture accessible; close owned fixture; persist terminal outcome.',
    budget: 'One attempt plus at most one exact same replacement attempt-1 fail/blocked corrective retry with explicit change. No third attempt or replay.',
    limits: ['Owner decision reference is required metadata, never inferred approval.', 'No historical outcome is modified.', 'No public MCP schema/provider behavior changes.', 'No host/release/physical-stop acceptance.'] };
}

function assertNativeIdentity(value, expected = {}) {
  assert.ok(Number.isInteger(value?.pid) && value.pid > 0);
  assert.match(value.processCreationTime, /^\d+$/);
  assert.ok(Number.isInteger(value.session) && value.session >= 0);
  assert.ok(typeof value.user === 'string' && value.user.length > 0);
  for (const field of ['pid', 'processCreationTime', 'session', 'user']) if (expected[field] !== undefined) assert.equal(value[field], expected[field], `Owned process ${field} changed.`);
  return value;
}
function validateOwnership(value, target) {
  assert.ok(Number.isInteger(target?.sessionId));
  const names = ['node', 'supervisor', 'marker'];
  for (const name of names) {
    const identity = value?.[name];
    assertNativeIdentity(identity, { session: target.sessionId });
    assert.ok(typeof identity.created === 'string' && identity.created.length > 0);
  }
  assert.equal(value.node.user, value.supervisor.user); assert.equal(value.node.user, value.marker.user);
  assertNativeIdentity(value.fixture, { pid: target.pid, processCreationTime: target.processCreationTime, session: target.sessionId, user: value.node.user });
  assert.equal(value.supervisor.parent, value.node.pid); assert.equal(value.marker.parent, value.supervisor.pid);
  assert.equal(new Set(names.map(name => value[name].pid)).size, 3);
  return value;
}
function validateFocus(value) {
  assert.equal(value?.public?.available, true); assert.equal(value.public.hasFocus, true);
  assert.equal(value.public.elementId, value.element?.id);
  assert.equal(value.element?.name, 'TRACE text input'); assert.equal(value.element.enabled, true);
  assert.equal(value.independent?.focusedControl, 'traceTextInput');
  assert.equal(value.independent.text, ''); assert.equal(value.independent.count, 0);
  assert.equal(value.boundObservedMatches, 1); assert.ok(typeof value.observationId === 'string' && value.observationId.length > 0);
  return value;
}
function validateExits(value, ownership, child) {
  for (const name of ['node', 'supervisor', 'marker', ...(child ? ['inputChild'] : [])]) {
    const expected = name === 'inputChild' ? child : ownership[name];
    assert.equal(value?.[name]?.exited, true);
    assertNativeIdentity(value[name].identity, expected);
  }
}

// Dependency injection keeps process-identity failures testable without invoking any helper.
function evidenceCallbacks(injected = {}) {
  const deps = { readChain: common.readChain, bridge: common.bridge, command: common.command, waitFor: common.waitFor,
    alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }, ...injected };
  let ownership, inputChild, ownedTarget, followupOwnership;
  async function chain(connection, target) {
    const nativeTarget = await deps.bridge('identity', target); common.assertIdentity(nativeTarget, target);
    const selected = { pid: connection.transport.pid };
    const before = await deps.readChain(selected), result = {};
    for (const name of ['node', 'supervisor', 'marker']) {
      const observed = await deps.command(['identity', String(before[name].pid)]);
      assertNativeIdentity(observed, { pid: before[name].pid, session: target.sessionId });
      result[name] = { ...before[name], ...observed };
    }
    assert.deepEqual(await deps.readChain(selected), before, 'Ownership generation changed during identity inspection.');
    result.fixture = await deps.command(['identity', String(target.pid)]);
    return validateOwnership(result, target);
  }
  async function exit(identity) {
    await deps.waitFor(async () => {
      if (!await deps.alive(identity.pid)) return true;
      // A reused PID means the recorded generation exited; an unavailable query is never exit.
      const current = await deps.command(['identity', String(identity.pid)]);
      assertNativeIdentity(current, { pid: identity.pid });
      return current.processCreationTime !== identity.processCreationTime;
    }, Boolean, 'exact owned process generation exit', 5000);
    return { identity, exited: true };
  }
  async function exits(value, child) {
    if (!value) return {};
    const result = {};
    for (const name of ['node', 'supervisor', 'marker']) result[name] = await exit(value[name]);
    if (child) result.inputChild = await exit(child);
    validateExits(result, value, child); return result;
  }
  return {
    async opened(connection, target) {
      ownedTarget = { ...target }; ownership = await chain(connection, target); return ownership;
    },
    async focus(connection, target, frame, independent) {
      common.assertIdentity(frame.window, target);
      assert.deepEqual(await chain(connection, target), ownership, 'Owner changed before held input.');
      const matches = frame.elements.filter(element => element.id === frame.focused?.elementId);
      return validateFocus({ public: { ...frame.focused }, element: matches[0] ? { ...matches[0] } : null,
        independent: { focusedControl: independent.focusedControl, text: independent.text, count: independent.count },
        observationId: frame.observationId, boundObservedMatches: matches.length });
    },
    async dispatched(connection, target, controlled) {
      assert.equal(controlled.inJob, true); assert.equal(controlled.supervisorPid, ownership.supervisor.pid);
      assert.deepEqual(await chain(connection, target), ownership, 'Owner changed across held dispatch.');
      inputChild = assertNativeIdentity(await deps.command(['identity', String(controlled.pid)]), {
        pid: controlled.pid, processCreationTime: controlled.processCreationTime, session: ownedTarget.sessionId, user: ownership.node.user });
      return inputChild;
    },
    closed: () => exits(ownership, inputChild),
    async followupOpened(connection, target) {
      common.assertIdentity(target, ownedTarget); followupOwnership = await chain(connection, target);
      assert.notDeepEqual([followupOwnership.node.pid, followupOwnership.node.processCreationTime], [ownership.node.pid, ownership.node.processCreationTime], 'Followup requires a newly owned MCP process.');
      return followupOwnership;
    },
    followupClosed: () => exits(followupOwnership),
    fixtureClosed: async () => ownership ? exit(ownership.fixture) : null,
  };
}

function validateResult(primary, options) {
  assert.equal(primary.caseId, options.caseId, 'The replacement ID must have been selected before UI.');
  assert.equal(primary.status, 'pass');
  assert.equal(primary.input, REGISTRY[options.caseId].input); assert.equal(primary.failure, 'cancel');
  assert.equal(primary.controlled?.inJob, true);
  validateOwnership(primary.ownership, primary.target); validateFocus(primary.focus);
  assertNativeIdentity(primary.controlled?.identity, { pid: primary.controlled.pid, processCreationTime: primary.controlled.processCreationTime,
    session: primary.target.sessionId, user: primary.ownership.node.user });
  assert.equal(primary.controlled.supervisorPid, primary.ownership.supervisor.pid);
  assert.equal(primary.nativeOutcome?.outcome, 'unknown'); assert.equal(primary.nativeOutcome?.code, 'cancelled');
  assert.equal(primary.nativeOutcome?.recovery?.released, true); assert.equal(primary.nativeOutcome?.recovery?.processExitConfirmed, true);
  assert.equal(primary.childExitIndependently, true); assert.deepEqual(primary.keysAfter, []);
  assert.equal(primary.effect?.count, 0); assert.equal(primary.effect?.unchangedAfterCleanup, true);
  const text = primary.effect.text;
  if (primary.input === 'typing') assert.match(text, /^abc+$/); else assert.equal(text, '');
  assert.equal(primary.followup?.before, 0); assert.equal(primary.followup?.after, 1);
  assert.equal(primary.followup?.exactIncrement, 1); assert.equal(primary.followup?.provider, 'pinned-engine');
  assert.equal(primary.cleanup?.connectionClosed, true); assert.equal(primary.cleanup?.inputChildExited, true);
  assert.equal(primary.cleanup?.supervisorExited, true); assert.equal(primary.cleanup?.fixtureExited, true);
  assert.equal(primary.cleanup?.inputState?.available, true); assert.deepEqual(primary.cleanup.inputState.down, []);
  assert.equal(primary.cleanup?.recovery?.recoveryRequired, false);
  assert.equal(primary.cleanup.retainedQuarantine, undefined);
  validateExits(primary.cleanup.exactOwnedExit, primary.ownership, primary.controlled.identity);
  validateOwnership(primary.followupOwnership, primary.target);
  assert.notDeepEqual([primary.followupOwnership.node.pid, primary.followupOwnership.node.processCreationTime],
    [primary.ownership.node.pid, primary.ownership.node.processCreationTime]);
  validateExits(primary.cleanup.followupExactOwnedExit, primary.followupOwnership);
  assert.equal(primary.cleanup.exactFixtureExit?.exited, true);
  assertNativeIdentity(primary.cleanup.exactFixtureExit.identity, primary.ownership.fixture);
  return { text, repeatedCCount: primary.input === 'typing' ? text.length - 3 : 0 };
}

async function run(input = {}) {
  const options = optionsFor(input);
  if (options.mode === 'plan') return plan(options);
  // Prior evidence is checked before any native helper, build or fixture launch.
  const prior = await common.checkPrior(options);
  const display = common.validateDisplay(await common.command(['display']));
  const declared = plan({ ...options, pinnedDisplay: display });
  const directory = path.resolve(options.directory);
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
  await common.writeJson(path.join(directory, 'plan.json'), declared);
  const receipt = { ...declared, ...(prior ? { prior } : {}), status: 'not_run', launched: false, startedAt: new Date().toISOString() };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await persist();
  try {
    await common.verify();
    const { buildFixture } = require('./smoke-computer-live.cjs');
    const executable = await buildFixture();
    receipt.fixtureSha256 = common.digest(await fs.readFile(executable));
    receipt.testedSource = await common.sourceHashes(DRIVER);
    await persist();
    const { runCell } = require('./accept-supervisor-recovery.cjs');
    if (typeof runCell !== 'function') throw common.failure('driver_unavailable', 'Shared recovery driver has not exposed its source-owned cell runner.');
    receipt.launched = true; receipt.status = 'running'; await persist();
    // The new fixed ID is the inner runner identity from the first checkpoint, never relabeled.
    const primary = await runCell({ id: options.caseId, input: REGISTRY[options.caseId].input, failure: 'cancel', replacement: true },
      path.join(directory, 'controlled-recovery'), executable, display, undefined, evidenceCallbacks());
    receipt.primary = { caseId: primary.caseId, status: primary.status, error: primary.error ?? null, receipt: 'controlled-recovery/receipt.json' };
    if (primary.status !== 'pass') { receipt.status = primary.status; return receipt; }
    receipt.effect = validateResult(primary, options);
    assert.deepEqual((await common.sourceHashes(DRIVER)).files, receipt.testedSource.files, 'Acceptance source changed during the run.');
    receipt.status = 'pass';
  } catch (error) {
    receipt.status = receipt.launched ? common.statusFor(error) : 'not_run'; receipt.error = common.publicError(error);
  } finally {
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.status && result.status !== 'pass') process.exitCode = 1;
}).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { REGISTRY, optionsFor, parseArgs, plan, validateResult, assertNativeIdentity, validateOwnership, validateFocus, validateExits, evidenceCallbacks, run };
