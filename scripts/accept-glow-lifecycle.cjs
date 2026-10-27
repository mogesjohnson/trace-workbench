'use strict';
// Preparation/import is inert. Only a new, bounded owner decision can claim live work.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const glow = require('./accept-replacement-glow.cjs');
const pixels = require('./accept-glow.cjs');
const budget = require('./narrow-finish-budget.cjs');
const common = require('./replacement-acceptance-common.cjs');
const CASE = 'R31-GLOW-NATIVE';
function plan() {
  return { ...budget.plan(CASE), mode: 'plan', claimsAttempt: false, inputActions: 0,
    phases: ['ordinary-close', 'owned-parent-loss'], helperAndAbsenceDeadlineMs: 5000,
    captureMeasurementsPerFrame: 3, reuse: 'Retained target-hit and physical-stop evidence; no clicks or keys.' };
}
async function run(options = {}, overrides = {}) {
  if (options.mode !== 'live') return plan();
  const deps = { ...glow.lifecycleDependencies(), claim: budget.claim, ...overrides };
  const directory = path.resolve(options.directory);
  const base = path.join(common.ROOT, '.runtime');
  const relative = path.relative(base, directory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Use a fresh private runtime directory.');
  const parent = path.relative(await fs.realpath(base), await fs.realpath(path.dirname(directory)));
  assert.ok(!parent.startsWith('..') && !path.isAbsolute(parent), 'The real parent must stay in private runtime storage.');
  await fs.mkdir(directory, { recursive: false });
  const receipt = { ...plan(), mode: 'live', status: 'running', startedAt: new Date().toISOString(), phases: [], frames: [], cleanup: {} };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  let fixture, connection, session, chain, target;
  const clock = overrides.clock ?? (() => performance.now());
  const snapshot = async () => {
    const value = await deps.sourceHashes();
    for (const file of ['scripts/accept-glow-lifecycle.cjs', 'scripts/narrow-finish-budget.cjs'])
      value.files[file] = common.digest(await fs.readFile(path.join(common.ROOT, file)));
    return value;
  };
  async function capture(label, owned) {
    common.compareDisplay(await deps.command(['display']), receipt.display);
    if (owned) assert.deepEqual(await deps.readChain(connection), owned);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const filename = `${label}-${attempt}.png`, frame = await fixture.capture(filename, owned?.marker.pid ?? 0);
        assert.equal(frame.bands.width, receipt.display.displays[0].bounds.width);
        assert.equal(frame.bands.height, receipt.display.displays[0].bounds.height);
        assert.equal(frame.interiorBackgroundVerified, true);
        await fs.writeFile(path.join(directory, filename), frame.bytes, { flag: 'wx' });
        receipt.frames.push({ label, filename, sha256: common.digest(frame.bytes), bands: frame.bands,
          captureMetadata: frame.captureMetadata, captureMetadataSha256: frame.captureMetadataSha256 });
        return frame.bands;
      } catch (error) {
        receipt.captureRefusals ??= [];
        receipt.captureRefusals.push({ label, attempt, error: common.publicError(error) });
        if (attempt === 3) throw error;
        await deps.delay(100);
      }
    }
  }
  try {
    await deps.verify(); receipt.testedSource = await snapshot();
    receipt.display = common.validateDisplay(await deps.command(['display']));
    assert.equal((await deps.command(['status'])).recoveryRequired, false);
    assert.equal((await deps.command(['input-access'])).observable, true);
    assert.deepEqual((await deps.command(['keystate', 'all'])).down, []);
    assert.equal(await deps.leaseFree(), true);
    receipt.claim = await deps.claim({ caseId: CASE, decision: options.decision });
    receipt.claimsAttempt = true; await persist();
    const fixtureDirectory = path.join(directory, `fixture-${randomUUID()}`);
    await fs.mkdir(fixtureDirectory); fixture = await deps.fixture(fixtureDirectory);
    const initial = await deps.waitFor(fixture.state, value => value?.ready && value.pid === fixture.pid, 'owned glow readiness', 10000);
    glow.assertCounts(initial, 0);
    const identity = await deps.command(['identity', String(fixture.pid)]);
    target = { id: initial.windowId, pid: fixture.pid, processCreationTime: identity.processCreationTime, sessionId: identity.session };
    receipt.target = target; receipt.fixtureSha256 = fixture.sha256;
    assert.deepEqual(initial.monitor, receipt.display.displays[0].bounds);
    assert.equal(initial.dpi, receipt.display.displays[0].dpi);
    const activated = await deps.bridge('activate', target);
    common.assertIdentity(activated, target); assert.equal(activated.foreground, true);
    assert.equal(pixels.glowAbsent(await capture('baseline')), true);
    for (const label of plan().phases) {
      connection = await deps.connect(path.join(directory, `mcp-${label}`));
      assert.equal((await connection.call('doctor')).ready, true);
      const selected = (await connection.call('list_windows')).windows.find(value => value.id === target.id && value.pid === target.pid);
      common.assertIdentity(selected, target);
      const before = await fixture.focus();
      session = await connection.call('open_session', { windowId: target.id });
      assert.ok(session.sessionId); assert.equal(session.activityIndicator?.owner, 'native-supervisor');
      assert.equal(session.activityIndicator.monitors, 1);
      chain = await deps.readChain(connection); glow.assertOwnershipSession(chain, target);
      const after = await fixture.focus(); glow.assertFocus(before, after);
      const phase = { label, ownership: chain, before, after }; receipt.phases.push(phase); await persist();
      assert.equal(pixels.glowVisible(await capture(`${label}-active`, chain)), true);
      assert.deepEqual(await deps.readChain(connection), chain);
      const began = clock();
      if (label === 'ordinary-close') assert.equal((await connection.call('close_session', { sessionId: session.sessionId })).closed, true);
      else await connection.killAbruptly();
      session = null;
      for (const role of label === 'ordinary-close' ? ['supervisor', 'marker'] : ['node', 'supervisor', 'marker'])
        assert.equal(await deps.waitIdentityExit(chain[role], Math.max(1, 5000 - (clock() - began))), true);
      assert.equal(pixels.glowAbsent(await capture(`${label}-absent`)), true);
      phase.helperAndAbsenceMs = clock() - began;
      assert.ok(phase.helperAndAbsenceMs <= 5000, 'Helper exit AND measured absence must meet five seconds.');
      await connection.close(); assert.equal(await deps.waitIdentityExit(chain.node), true);
      connection = null; chain = null;
      assert.deepEqual((await deps.command(['keystate', 'all'])).down, []);
      assert.equal((await deps.command(['status'])).recoveryRequired, false);
      assert.equal(await deps.leaseFree(), true); glow.assertCounts(await fixture.state(), 0);
      phase.status = 'pass'; await persist();
    }
    receipt.status = 'pass';
  } catch (error) { receipt.status = common.statusFor(error); receipt.error = common.publicError(error); }
  finally {
    const failed = async (label, work) => {
      try { receipt.cleanup[label] = await work(); }
      catch (error) { receipt.status = 'fail'; receipt.cleanup[label] = common.publicError(error); }
    };
    if (connection) {
      let owned = chain ? Object.values(chain) : [];
      if (!chain) await failed('ownedIdentityRead', async () => { owned = await deps.readOwned(connection); return true; });
      if (session?.sessionId) await failed('sessionClosed', () => connection.call('close_session', { sessionId: session.sessionId }));
      await failed('connectionClosed', () => connection.close());
      await failed('remainingOwned', async () => {
        for (const identity of owned) assert.equal(await deps.waitIdentityExit(identity), true);
        return { exited: true };
      });
    }
    if (fixture) {
      await failed('inputReleased', async () => { assert.deepEqual((await deps.command(['keystate', 'all'])).down, []); return true; });
      await failed('fixture', async () => { const result = await fixture.close(); assert.equal(result.exited, true); return result; });
    }
    await failed('recoveryClear', async () => { assert.equal((await deps.command(['status'])).recoveryRequired, false); return true; });
    await failed('leaseFree', async () => { assert.equal(await deps.leaseFree(), true); return true; });
    await failed('sourcesUnchanged', async () => { if (receipt.testedSource) assert.deepEqual(await snapshot(), receipt.testedSource); await deps.verify(); return true; });
    receipt.completedAt = new Date().toISOString(); await persist();
  }
  return receipt;
}
module.exports = { plan, run };
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = args.length === 0 || args.join(' ') === '--plan' ? {} : {
    mode: args[0] === '--live' ? 'live' : 'invalid', directory: args[1], decision: { ref: args[2], sha256: args[3] } };
  assert.ok(options.mode === undefined || options.mode === 'live' && args.length === 4, 'Use --plan or --live PRIVATE_DIRECTORY DECISION_REF DECISION_SHA256.');
  run(options).then(result => { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.mode === 'live' && result.status !== 'pass') process.exitCode = 1; })
    .catch(error => { process.stderr.write(common.publicError(error).message + '\n'); process.exitCode = 1; });
}
