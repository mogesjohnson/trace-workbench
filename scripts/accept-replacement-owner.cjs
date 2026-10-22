#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const common = require('./replacement-acceptance-common.cjs');
const os = require('node:os');
const { DesktopLease } = require('../src/computer/lease.cjs');
const CASE = 'R32-PRODUCTION-OWNER';
const DRIVER = 'scripts/accept-replacement-owner.cjs';
function plan(input = {}) {
  const options = common.optionsFor(input, CASE);
  return { schemaVersion: 1, planContract: 1, caseId: CASE, subcase: 'exclusion-handoff', replaces: ['A32-PROBE'],
    historicalStatus: 'exhausted fail; unchanged', attempt: options.attempt, ownerDecision: options.ownerDecision ?? null,
    executionRequiresExplicitOwnerDecision: true, declaredBeforeUiLaunch: true,
    display: options.pinnedDisplay ?? 'Read actual native single-monitor display before the written live plan or UI.',
    target: 'Fresh accessible owned fixture bound to HWND/PID/creation time/Windows session',
    initial: { count: 0, text: '', keysDown: [], recoveryRequired: false },
    actions: ['A opens exact target under root A; verify native-owner readiness and exact Node/supervisor/marker chain',
      'B under distinct root B discovers the same identity; exactly one open returns desktop_busy with no native owner, marker or input child; only the exact OS System32 console host may remain',
      'Close A and verify exact helpers/Node exit; B makes one new session-open request and becomes ready',
      'Close B; verify exact helpers/Node exit, independent all-up, free lease and clear durable recovery'],
    expected: { actCalls: 0, openCallsA: 1, openCallsB: 2, exclusionCode: 'desktop_busy', distinctArtifactRoots: true },
    budget: 'One attempt and at most one corrective attempt with exact matching prior receipt and changed precondition.',
    cleanup: ['Close native sessions and MCP connections sequentially', 'Verify exact owned process exits',
      'Check input while fixture is accessible', 'Close owned fixture', 'Inspect durable status without clearing; persist terminal outcome'],
    limits: ['Exclusion/handoff alone cannot pass the complete production-owner evidence gate',
      'Process snapshots cannot prove absence of a transient child between samples; zero act calls are independently enforced',
      'No live model, physical input, Node-death or supervisor-death recovery coverage'] };
}
function parseArgs(args) { return common.parseArgs(args, CASE); }
function evidenceMap(status = 'not_run') {
  return [
    { invariant: 'exclusive lease across processes/artifact roots', status, scope: 'This no-input exclusion/handoff subcase only' },
    ...['suspended child in Job Object before Resume and pinned dispatch', 'Node-death input cleanup and follow-up',
      'supervisor-death quarantine/restart/recovery and follow-up', 'focused controlled typing delivery',
      'physical stop and ordinary injected Escape relevance review', 'failed acknowledgement quarantine relevance review',
      'concurrent shutdown shared-cleanup source/selftest review'].map(invariant => ({ invariant, status: 'not_run', reason: 'Separate accepted evidence/relevance review required; not inferred from exclusion.' }))
  ];
}
function assertChain(chain, connection, target) {
  common.ownershipChain(Object.values(chain), connection.pid, process.pid, connection.nodeIdentity?.created);
  for (const value of Object.values(chain)) {
    assert.ok(Number.isInteger(value.sessionId), 'Every process requires an independently queried Windows session.');
    assert.equal(value.sessionId, target.sessionId);
  }
}
function assertReady(session, target) {
  assert.ok(typeof session.sessionId === 'string' && session.sessionId);
  common.assertIdentity(session.window, target);
  assert.deepEqual(session.activityIndicator, { active: true, monitors: 1, protocol: 1, owner: 'native-supervisor' });
}
function assertNoChildren(records, connection) {
  const node = records.filter(value => value.pid === connection.pid);
  assert.equal(node.length, 1); assert.equal(node[0].created, connection.nodeIdentity.created);
  assert.equal(node[0].parent, process.pid);
  assert.equal(node[0].sessionId, connection.nodeIdentity.sessionId); assert.ok(Number.isInteger(node[0].sessionId));
  const children = records.filter(value => value.parent === connection.pid);
  assert.ok(children.length <= 1, 'Rejected B may retain at most one ordinary OS console host.');
  const consoleHosts = children.map(child => {
    const systemDirectory = node[0].systemDirectory;
    assert.ok(typeof systemDirectory === 'string' && path.win32.isAbsolute(systemDirectory)
      && path.win32.basename(systemDirectory).toLowerCase() === 'system32', 'OS system directory must be independently returned by the native process inventory.');
    const expectedPath = path.win32.join(systemDirectory, 'conhost.exe');
    assert.ok(typeof child.executablePath === 'string' && child.executablePath.toLowerCase() === expectedPath.toLowerCase()
      && child.name?.toLowerCase() === 'conhost.exe', 'Rejected B must have no native owner, marker, input child or unverified console-host lookalike.');
    assert.ok(Number.isInteger(child.pid) && child.pid > 0 && child.pid !== connection.pid);
    assert.equal(records.filter(value => value.pid === child.pid).length, 1);
    assert.equal(child.parent, connection.pid); assert.equal(child.sessionId, node[0].sessionId);
    assert.ok(typeof child.created === 'string' && Number.isFinite(Date.parse(child.created))
      && Number.isFinite(Date.parse(node[0].created)) && Date.parse(child.created) >= Date.parse(node[0].created),
    'Console host must have a valid generation created after the exact MCP process.');
    assert.deepEqual(records.filter(value => value.parent === child.pid), [], 'An allowed OS console host must not own input/native descendants.');
    return { classification: 'windows-system-console-host', pid: child.pid, parent: child.parent, sessionId: child.sessionId,
      created: child.created, executablePathVerified: true };
  });
  const { pid, parent, name, sessionId, created } = node[0];
  return { node: { pid, parent, name, sessionId, created }, observedChildren: children.length, nativeOwnerMarkerOrInputChildren: 0,
    consoleHosts, snapshotOnly: true };
}
async function leaseCheck() {
  const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
  const id = randomUUID();
  await lease.acquire(id);
  try { await lease.assert(id); return { available: true, method: 'exclusive production lease acquisition and release' }; }
  finally { await lease.release(id); }
}
function defaults() {
  return { ...common, leaseCheck, publishPlan: value => process.stdout.write(JSON.stringify(value, null, 2) + '\n'), sourceHashes: () => common.sourceHashes(DRIVER), fixture: common.launchComputerFixture,
    runtimeRoot: path.join(common.ROOT, '.runtime', 'replacement-owner') };
}
async function run(input = {}, injected = {}) {
  const options = common.optionsFor(input, CASE);
  if (options.mode === 'plan') return plan(options);
  const deps = { ...defaults(), ...injected }, prior = await common.checkPrior(options);
  const display = common.validateDisplay(await deps.command(['display']));
  await deps.verify(); const testedSource = await deps.sourceHashes();
  const declared = { ...plan({ ...options, pinnedDisplay: display }), testedSource };
  const directory = path.resolve(options.directory); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
  await common.writeJson(path.join(directory, 'plan.json'), declared);
  await deps.publishPlan(declared);
  const roots = { A: path.join(directory, 'mcp-A'), B: path.join(directory, 'mcp-B') };
  assert.notEqual(roots.A.toLowerCase(), roots.B.toLowerCase());
  const receipt = { schemaVersion: 1, planContract: 1, caseId: CASE, subcase: declared.subcase, replaces: declared.replaces,
    attempt: options.attempt, ownerDecision: options.ownerDecision, ...(prior ? { prior } : {}), display,
    testedSource, status: 'running', productionOwnerStatus: 'incomplete', evidenceMap: evidenceMap(), artifactRoots: { A: 'mcp-A', B: 'mcp-B' },
    calls: [], cleanup: {}, startedAt: new Date().toISOString() };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  let fixture;
  const owners = [];
  async function call(owner, method, args = {}) {
    assert.ok(['doctor', 'list_windows', 'open_session', 'close_session'].includes(method), 'Input/observation actions are outside this no-input case.');
    receipt.calls.push({ owner: owner.name, method }); return owner.connection.call(method, args);
  }
  async function allUp() { const down = (await deps.command(['keystate', 'all'])).down; if (!Array.isArray(down)) throw common.failure('input_state_unavailable', 'Independent all-input state is unavailable.');
    if (down.length) throw common.failure('input_busy', 'Independent observation found held input.'); return down; }
  async function clear() { const status = await deps.command(['status']); assert.equal(status.recoveryRequired, false); return status; }
  async function closeOwner(owner) {
    if (owner.closed) return;
    let problem;
    if (!owner.chain) {
      try { owner.owned = await deps.readOwned(owner.connection); assert.ok(owner.owned.length, 'Owned Node identity must remain available for exit verification.'); } catch (error) { problem = error; }
    }
    try { if (owner.session) { assert.equal((await call(owner, 'close_session', { sessionId: owner.session.sessionId })).closed, true); owner.session = null; } }
    catch (error) { problem ??= error; }
    try { await owner.connection.close(); owner.connectionClosed = true; } catch (error) { problem ??= error; }
    try { for (const identity of owner.chain ? [owner.chain.supervisor, owner.chain.marker, owner.chain.node] : owner.owned || [])
      assert.equal(await deps.waitIdentityExit(identity, 5000), true); owner.exitsVerified = true; } catch (error) { problem ??= error; }
    owner.closed = !problem;
    if (problem) throw problem;
  }
  try {
    await persist();
    await clear(); receipt.initialLease = await deps.leaseCheck(); const access = await deps.command(['input-access']); receipt.inputAccess = access;
    if (access.observable !== true) throw common.failure(access.code || 'input_state_unavailable', 'Foreground/input unavailable before fixture launch.');
    receipt.initialKeysDown = await allUp();
    const privateDirectory = path.join(deps.runtimeRoot, randomUUID()); await fs.mkdir(privateDirectory, { recursive: true });
    fixture = await deps.fixture(privateDirectory); receipt.fixtureSha256 = fixture.sha256;
    const initial = await deps.waitFor(fixture.state, value => value?.revision > 0, 'owned fixture readiness', 10000);
    assert.equal(initial.count, 0); assert.equal(initial.text, ''); assert.equal(initial.minimized, false);
    common.compareDisplay(await deps.command(['display']), display);
    async function connect(name) {
      const connection = await deps.connect(roots[name]), owner = { name, connection }; owners.push(owner); return owner;
    }
    async function discover(owner, expected) {
      const listed = await call(owner, 'list_windows'), matches = listed.windows.filter(value => value.pid === fixture.pid && value.title === fixture.title);
      assert.equal(matches.length, 1); const target = matches[0];
      assert.match(target.processCreationTime, /^\d+$/); assert.ok(Number.isInteger(target.sessionId));
      const identity = await deps.command(['identity', String(target.pid)]);
      assert.equal(identity.processCreationTime, target.processCreationTime); assert.equal(identity.session, target.sessionId);
      if (expected) common.assertIdentity(target, expected); return target;
    }
    async function ready(owner, target) {
      owner.session = await call(owner, 'open_session', { windowId: target.id });
      if (!owner.session.sessionId) throw common.failure(owner.session.error?.code || 'session_open_failed', 'Owned target failed to open.');
      assertReady(owner.session, target); owner.chain = await deps.readChain(owner.connection); assertChain(owner.chain, owner.connection, target);
      await allUp(); await clear(); return { session: owner.session, chain: owner.chain };
    }
    const a = await connect('A'); assert.equal((await call(a, 'doctor')).ready, true);
    const target = await discover(a); receipt.target = target; receipt.A = await ready(a, target); await persist();
    const b = await connect('B'); await discover(b, target);
    const rejected = await call(b, 'open_session', { windowId: target.id });
    if (rejected.sessionId) b.session = rejected; // Retain any unexpected session for cleanup before asserting exclusion.
    assert.equal(rejected.error?.code, 'desktop_busy'); assert.equal(rejected.sessionId, undefined);
    receipt.exclusion = { code: rejected.error.code, noChild: assertNoChildren(await deps.processList({ all: true }), b.connection) };
    // Read A again so a substituted/restarted native owner cannot satisfy handoff.
    assert.deepEqual(await deps.readChain(a.connection), a.chain); await allUp(); await clear(); await persist();
    await closeOwner(a); receipt.AClosed = { exactExitsVerified: a.exitsVerified, connectionClosed: a.connectionClosed };
    await discover(b, target); receipt.B = await ready(b, target); await persist();
    await closeOwner(b); receipt.BClosed = { exactExitsVerified: b.exitsVerified, connectionClosed: b.connectionClosed };
    const finalState = await fixture.state(); assert.equal(finalState.count, 0); assert.equal(finalState.text, '');
    receipt.finalFixture = { count: finalState.count, text: finalState.text };
    receipt.status = 'pass'; receipt.evidenceMap = evidenceMap('pass');
  } catch (error) { receipt.status = common.statusFor(error); receipt.error = common.publicError(error); }
  finally {
    receipt.primaryStatus = receipt.status;
    for (const owner of owners) try { await closeOwner(owner); } catch (error) { receipt.cleanup[owner.name] = common.publicError(error); receipt.status = 'fail'; }
    try { if (fixture) { receipt.cleanup.keysDown = await allUp(); receipt.cleanup.inputCheckedBeforeFixtureClose = true; } }
    catch (error) { receipt.cleanup.inputError = common.publicError(error); if (receipt.status !== 'fail') receipt.status = common.statusFor(error); }
    if (fixture) try { receipt.cleanup.fixture = await fixture.close(); assert.equal(receipt.cleanup.fixture.exited, true); }
    catch (error) { receipt.cleanup.fixtureError = common.publicError(error); receipt.status = 'fail'; }
    try { receipt.cleanup.recovery = await clear();
      receipt.cleanup.lease = await deps.leaseCheck(); assert.equal(receipt.cleanup.lease.available, true);
    } catch (error) { receipt.cleanup.finalStateError = common.publicError(error); receipt.status = 'fail'; }
    try { if (receipt.testedSource) { receipt.sourcesUnchangedDuringRun = JSON.stringify((await deps.sourceHashes()).files) === JSON.stringify(receipt.testedSource.files); assert.equal(receipt.sourcesUnchangedDuringRun, true); } }
    catch (error) { receipt.cleanup.sourceError = common.publicError(error); receipt.status = 'fail'; }
    if (receipt.status !== 'pass') receipt.evidenceMap = evidenceMap(receipt.status);
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}
if (require.main === module) run(parseArgs(process.argv.slice(2))).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.status && result.status !== 'pass') process.exitCode = 1;
}).catch(error => { process.stderr.write(common.publicError(error).message + '\n'); process.exitCode = 1; });
module.exports = { CASE, plan, parseArgs, evidenceMap, assertChain, assertReady, assertNoChildren, run };




