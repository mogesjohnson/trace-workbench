'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const driver = require('../scripts/accept-replacement-owner.cjs');
const common = require('../scripts/replacement-acceptance-common.cjs');
const display = { monitors: 1, displays: [{ device: 'synthetic', primary: true, dpi: 144, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] };
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-owner-test-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'trace-owner-test-'))); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
function simulation(root, options = {}) {
  const events = [], connections = [], target = { id: '10', pid: 123, processCreationTime: '1001', sessionId: 1, title: 'owned-fixture' };
  let fixtureClosed = false, aClosed = false, hashes = 0, statusChecks = 0;
  const chainFor = pid => ({ node: { pid, parent: process.pid, name: 'node.exe', created: `2026-10-22T03:21:${pid === 300 ? '12' : '09'}.0000000Z`, sessionId: 1 },
    supervisor: { pid: pid + 1, parent: pid, name: 'TraceSupervisor.exe', created: `native-${pid}`, sessionId: options.wrongSession ? 2 : 1 },
    marker: { pid: pid + 2, parent: pid + 1, name: 'TraceActivityIndicator.exe', created: `marker-${pid}`, sessionId: 1 } });
  const deps = { publishPlan: async value => { events.push('plan-published'); assert.ok(value.testedSource); }, runtimeRoot: path.join(root, 'private'), verify: async () => {}, delay: async () => {},
    sourceHashes: async () => ({ files: { source: options.changedSource && hashes++ ? 'changed' : 'same' } }),
    leaseCheck: async () => { events.push('lease'); return { available: true }; },
    command: async args => {
      events.push(args[0]);
      if (args[0] === 'display') return display;
      if (args[0] === 'status') return { recoveryRequired: options.finalRecovery && ++statusChecks > 3 ? true : false };
      if (args[0] === 'input-access') return { observable: true };
      if (args[0] === 'keystate') { assert.equal(fixtureClosed, false); return { down: options.held ? [32] : [] }; }
      if (args[0] === 'identity') return { processCreationTime: '1001', session: 1 };
      throw new Error('Unexpected native command');
    },
    fixture: async () => { events.push('fixture'); return { pid: target.pid, title: target.title, sha256: 'fixture-hash',
      state: async () => ({ revision: 1, count: 0, text: '', minimized: false }),
      close: async () => { events.push('fixture-close'); fixtureClosed = true; return { exited: true }; } }; },
    waitFor: async (work, predicate) => { const value = await work(); assert.ok(predicate(value)); return value; },
    connect: async directory => {
      const index = connections.length, pid = index ? 300 : 200, name = index ? 'B' : 'A'; let opened = 0;
      events.push(`connect-${name}`);
      const connection = { pid, nodeIdentity: chainFor(pid).node,
        call: async (method, args) => {
          events.push(`${name}-${method}`); assert.notEqual(method, 'act');
          if (method === 'doctor') return { ready: true };
          if (method === 'list_windows') return { windows: [{ ...target, ...(index && options.wrongTarget ? { id: '11' } : {}) }] };
          if (method === 'open_session') {
            assert.deepEqual(args, { windowId: '10' }); opened++;
            if (index && opened === 1) return options.secondOwner ? { sessionId: 'unexpected' } : { error: { code: options.wrongBusy ? 'other_error' : 'desktop_busy' } };
            if (index) assert.equal(aClosed, true);
            return { sessionId: `${name}-session`, window: target, activityIndicator: { active: !options.notReady, monitors: 1, protocol: 1, owner: 'native-supervisor' } };
          }
          if (method === 'close_session') return { closed: true };
          throw new Error('Unexpected MCP call');
        },
        close: async () => { events.push(`${name}-connection-close`); if (!index) aClosed = true; if (options.closeFailure) throw new Error('Injected close failure'); }
      };
      connections.push({ connection, directory }); return connection;
    },
    processList: async options_ => { assert.deepEqual(options_, { all: true }); const node = { ...chainFor(300).node, systemDirectory: 'C:\\Windows\\System32' };
      const consoleHost = { pid: 399, parent: 300, name: 'conhost.exe', sessionId: 1, created: '2026-10-22T03:21:12.1000000Z', executablePath: 'C:\\Windows\\System32\\conhost.exe' };
      return [node, ...(options.consoleHost ? [consoleHost] : []), ...(options.child ? [{ pid: 399, parent: 300, name: 'input.exe', created: 'child' }] : [])]; },
    readChain: async connection => chainFor(connection.pid),
    readOwned: async connection => [chainFor(connection.pid).node],
    waitIdentityExit: async identity => { events.push(`exit-${identity.pid}`); if (options.exitFailure) throw new Error('Unconfirmed exit'); return true; }
  };
  return { deps, events, connections };
}
const live = directory => ({ mode: 'live', directory, ownerDecision: 'explicit synthetic decision reference' });
test('plan is pure, fixed, zero-input and does not promote the complete gate', async () => {
  const result = await driver.run({}, { command() { throw new Error('Native work forbidden'); }, fixture() { throw new Error('UI forbidden'); } });
  assert.equal(result.caseId, 'R32-PRODUCTION-OWNER'); assert.equal(result.expected.actCalls, 0); assert.equal(result.ownerDecision, null);
  assert.equal(driver.evidenceMap().filter(value => value.status === 'not_run').length, 8);
  assert.throws(() => driver.parseArgs(['x', '--live']), { code: 'owner_decision_required' });
  for (const attempt of ['0', '3', 'NaN']) assert.throws(() => driver.parseArgs(['--plan', '--attempt', attempt]), { code: 'invalid_plan' });
  assert.throws(() => driver.parseArgs(['--plan', '--case-id', 'other']), { code: 'invalid_plan' });
});
test('same-case finite retry evidence is required before native preparation', async t => {
  const root = await workspace(t), prior = path.join(root, 'prior'); await fs.mkdir(prior);
  const valid = { caseId: driver.CASE, attempt: 1, status: 'blocked', planContract: 1, ownerDecision: 'reference' };
  for (const bad of [{ ...valid, caseId: 'A32-PROBE' }, { ...valid, attempt: 2 }, { ...valid, status: 'pass' }, { ...valid, ownerDecision: 'other' }]) {
    await fs.writeFile(path.join(prior, 'receipt.json'), JSON.stringify(bad));
    await assert.rejects(driver.run({ ...live(path.join(root, 'out')), ownerDecision: 'reference', attempt: 2, prior, change: 'source fix' }), { code: 'invalid_retry' });
  }
  await fs.writeFile(path.join(prior, 'receipt.json'), JSON.stringify(valid));
  assert.equal((await common.checkPrior({ ...valid, attempt: 2, prior, change: 'fix' })).status, 'blocked');
});
test('injected MCP exclusion and handoff retain separate roots, no input, and serialized verified cleanup', async t => {
  const root = await workspace(t), sim = simulation(root), result = await driver.run(live(path.join(root, 'out')), sim.deps);
  assert.equal(result.status, 'pass', JSON.stringify(result.error)); assert.equal(result.productionOwnerStatus, 'incomplete');
  assert.equal(result.evidenceMap.filter(value => value.status === 'pass').length, 1);
  assert.notEqual(sim.connections[0].directory, sim.connections[1].directory);
  assert.equal(result.calls.filter(value => value.method === 'act').length, 0);
  assert.equal(result.calls.filter(value => value.owner === 'B' && value.method === 'open_session').length, 2);
  assert.ok(sim.events.indexOf('display') < sim.events.indexOf('plan-published'));
  assert.ok(sim.events.indexOf('plan-published') < sim.events.indexOf('fixture'));
  assert.ok(sim.events.lastIndexOf('keystate') < sim.events.indexOf('fixture-close'));
  assert.ok(sim.events.indexOf('exit-200') < sim.events.lastIndexOf('B-open_session'));
  assert.equal(result.cleanup.inputCheckedBeforeFixtureClose, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'out', 'receipt.json'))).status, 'pass');
});
for (const setting of ['wrongSession', 'wrongTarget', 'child', 'wrongBusy', 'secondOwner', 'notReady', 'closeFailure', 'exitFailure', 'changedSource', 'finalRecovery']) {
  test(`injected ${setting} cannot pass and persists terminal cleanup`, async t => {
    const root = await workspace(t), sim = simulation(root, { [setting]: true }), result = await driver.run(live(path.join(root, 'out')), sim.deps);
    assert.notEqual(result.status, 'pass'); assert.ok(result.completedAt);
    assert.equal(result.productionOwnerStatus, 'incomplete');
    assert.ok(sim.events.includes('fixture-close'));
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'out', 'receipt.json'))).status, result.status);
    assert.equal(result.calls.some(value => value.method === 'act'), false);
  });
}
test('held input blocks before fixture and native ownership launch', async t => {
  const root = await workspace(t), sim = simulation(root, { held: true }), result = await driver.run(live(path.join(root, 'out')), sim.deps);
  assert.equal(result.status, 'blocked'); assert.equal(sim.connections.length, 0); assert.equal(sim.events.includes('fixture'), false);
});

test('injected handoff tolerates only the exact OS System32 console host and sanitizes its evidence', async t => {
  const root = await workspace(t), sim = simulation(root, { consoleHost: true });
  const result = await driver.run(live(path.join(root, 'out')), sim.deps);
  assert.equal(result.status, 'pass', JSON.stringify(result.error));
  const classification = result.exclusion.noChild;
  assert.equal(classification.observedChildren, 1); assert.equal(classification.nativeOwnerMarkerOrInputChildren, 0);
  assert.equal(classification.consoleHosts[0].classification, 'windows-system-console-host');
  assert.equal(classification.consoleHosts[0].executablePathVerified, true); assert.equal(classification.snapshotOnly, true);
  assert.equal(JSON.stringify(classification).includes('C:'), false);
  assert.equal(result.calls.some(value => value.method === 'act'), false);
});

test('console-host exception rejects lookalike paths, missing paths, invalid generations/session, and descendants', () => {
  const node = { pid: 300, parent: process.pid, name: 'node.exe', sessionId: 1,
    created: '2026-10-22T03:21:12.0000000Z', systemDirectory: 'C:\\Windows\\System32' };
  const connection = { pid: node.pid, nodeIdentity: node };
  const host = { pid: 399, parent: node.pid, name: 'conhost.exe', sessionId: node.sessionId,
    created: '2026-10-22T03:21:12.1000000Z', executablePath: 'C:\\Windows\\System32\\conhost.exe' };
  assert.equal(driver.assertNoChildren([node, host], connection).consoleHosts.length, 1);
  for (const altered of [
    { executablePath: 'C:\\Temp\\conhost.exe' }, { executablePath: 'C:\\Windows\\System32evil\\conhost.exe' },
    { executablePath: 'C:\\Windows\\SysWOW64\\conhost.exe' }, { executablePath: undefined },
    { name: 'TraceSupervisor.exe' }, { name: 'TraceActivityIndicator.exe' }, { name: 'input.exe' },
    { executablePath: 'C:\\Windows\\System32\\input.exe' }, { sessionId: 2 }, { sessionId: undefined },
    { pid: 0 }, { created: undefined }, { created: 'invalid' }, { created: '2026-10-22T03:21:11.0000000Z' }
  ]) assert.throws(() => driver.assertNoChildren([node, { ...host, ...altered }], connection));
  assert.throws(() => driver.assertNoChildren([{ ...node, systemDirectory: undefined }, host], connection));
  assert.throws(() => driver.assertNoChildren([node, host, { pid: 400, parent: host.pid, name: 'input.exe' }], connection));
  assert.throws(() => driver.assertNoChildren([node, host, { ...host, pid: 400 }], connection));
});

