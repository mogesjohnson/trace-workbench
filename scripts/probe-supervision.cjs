#!/usr/bin/env node
'use strict';

// A32 bounded feasibility probe: job ownership, lease exclusion, parent-death detection, held
// mouse/modifier/typing cleanup and Escape detection on this account. Every input targets the owned
// computer fixture; every held key or button is checked by a separate process before and after release.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, '.runtime', 'supervisor-probe');
const EXE = path.join(BUILD, 'bin', 'TraceSupervisor.exe');
const SOURCES = ['native/TraceSupervisor/TraceSupervisor.csproj', 'native/TraceSupervisor/Program.cs', 'native/TraceSupervisor/Native.cs', 'native/TraceSupervisor/InputState.cs', 'native/TraceSupervisor/Probe.cs', 'scripts/probe-supervision.cjs', 'src/computer/lease.cjs', 'tests/fixtures/computer-app/Program.cs'];
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function build() {
  await execFileAsync('dotnet', ['build', path.join(ROOT, 'native', 'TraceSupervisor', 'TraceSupervisor.csproj'), '--configuration', 'Release', '--output', path.dirname(EXE), '--artifacts-path', path.join(BUILD, 'artifacts'), '--nologo'], { cwd: ROOT, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
  return sha256(await fs.readFile(EXE));
}

async function sources() {
  const files = {};
  for (const name of SOURCES) files[name] = sha256(await fs.readFile(path.join(ROOT, name)));
  const [commit, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: ROOT, windowsHide: true }),
  ]);
  return { baseCommit: commit.stdout.trim(), workingTreeModified: status.stdout.trim().length > 0, files };
}

async function supervisor(args, timeout = 15000) {
  try {
    const { stdout } = await execFileAsync(EXE, args, { windowsHide: true, timeout });
    return JSON.parse(stdout.trim().split(/\r?\n/).pop());
  } catch (error) {
    if (error.stdout) { try { return { exitCode: error.code, ...JSON.parse(error.stdout.trim().split(/\r?\n/).pop()) }; } catch {} }
    throw error;
  }
}

const keyState = async keys => (await supervisor(['keystate', keys.join(',')])).keys;
async function untilKeys(keys, down, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await keyState(keys);
    if (keys.every(key => state[String(key)] === down)) return state;
    await delay(50);
  }
  return state;
}

function startLong(args) {
  const child = spawn(EXE, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
  });
  child.stderr.on('data', () => {});
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { child, lines, exited, async line(count = 1, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (lines.length < count && Date.now() < deadline) await delay(25);
    assert.ok(lines.length >= count, 'Supervisor probe did not report in time');
    return lines[count - 1];
  } };
}

async function exitOf(pid, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return { exited: true, afterMs: Date.now() - started }; throw error; }
    await delay(20);
  }
  return { exited: false, afterMs: Date.now() - started };
}

async function runCase(receipt, id, work) {
  const started = Date.now();
  try {
    const actual = await work();
    receipt.cases[id] = { status: actual.pass ? 'pass' : 'fail', actual, durationMs: Date.now() - started };
  } catch (error) {
    receipt.cases[id] = { status: error.blocked ? 'blocked' : 'fail', error: { code: String(error.code || 'assertion_failed'), message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 600) }, durationMs: Date.now() - started };
  }
}

// Holds one declared input inside a kill-on-close job, kills the job owner and releases afterwards.
async function heldInput(providerArgs, keys, fixture) {
  const before = await keyState(keys);
  assert.ok(keys.every(key => before[String(key)] === false), 'Declared keys must be released before the case');
  const host = startLong(['probe', 'job-host', 'provider', ...providerArgs]);
  const report = await host.line();
  const held = await untilKeys(keys, true);
  host.child.kill(); // TerminateProcess on the job owner closes the job.
  await host.exited;
  const childExit = await exitOf(report.child.pid);
  const afterKill = await keyState(keys);
  const release = await supervisor(['probe', 'release', keys.join(',')]);
  const after = await untilKeys(keys, false);
  const foreground = await fixture.foreground();
  return {
    pass: report.jobAssigned === true && report.breakawayDenied === true && report.child.inJob === true && childExit.exited
      && keys.every(key => held[String(key)] === true && afterKill[String(key)] === true && after[String(key)] === false) && release.released === true && foreground,
    job: { assigned: report.jobAssigned, breakawayDenied: report.breakawayDenied, childInJob: report.child.inJob, providerReport: report.child.report },
    heldIndependently: held, childExitAfterOwnerKill: childExit, stillDownAfterKill: afterKill, release, releasedIndependently: after, fixtureForeground: foreground,
  };
}

async function fixtureSession() {
  const live = require('./smoke-computer-live.cjs');
  const { DEFAULT_BINARY, DEFAULT_BRIDGE, runProcess, parseJson } = require('../src/computer/winapp-backend.cjs');
  const executable = await live.buildFixture();
  const runId = `probe-${randomUUID()}`;
  const directory = path.join(ROOT, '.runtime', 'supervisor-probe', runId);
  await fs.mkdir(directory, { recursive: true });
  const receiptPath = path.join(directory, 'fixture.json');
  const child = spawn(executable, ['--run-id', runId, '--receipt', receiptPath, '--commands', path.join(directory, 'commands.json')], { windowsHide: false, stdio: 'ignore' });
  const state = async () => JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const deadline = Date.now() + 15000;
  let ready;
  while (!ready && Date.now() < deadline) { try { ready = await state(); } catch { await delay(100); } }
  assert.ok(ready, 'Owned fixture did not start');
  let window;
  while (!window && Date.now() < deadline + 5000) {
    const windows = JSON.parse((await execFileAsync(DEFAULT_BINARY, ['ui', 'list-windows', '--json'], { windowsHide: true })).stdout);
    window = windows.find(item => item.processId === child.pid);
    if (!window) await delay(200);
  }
  assert.ok(window, 'Owned fixture window was not listed');
  const bridge = async verb => parseJson(...Object.values(await runProcess(DEFAULT_BRIDGE, [verb, String(window.hwnd), String(child.pid)], { timeoutMs: 10000 })));
  const activation = await bridge('activate');
  return {
    pid: child.pid, state, activation,
    // An empty client point near the lower-right corner; clicks there change no fixture state.
    point: { x: ready.windowX + ready.windowWidth - 40, y: ready.windowY + ready.windowHeight - 40 },
    foreground: async () => (await bridge('bounds')).foreground === true,
    async close() { child.kill(); return exitOf(child.pid, 5000); },
  };
}

async function main(args = process.argv.slice(2)) {
  const physical = args.includes('--physical-escape');
  const attempt = args.includes('--attempt') ? Number(args[args.indexOf('--attempt') + 1]) : 1;
  assert.ok(Number.isInteger(attempt) && attempt >= 1 && attempt <= 2, 'One corrective probe attempt is allowed');
  const evidence = path.join(ROOT, 'evidence', '0.1.0-alpha.3.2', attempt > 1 ? `feasibility-attempt-${attempt}` : 'feasibility');
  const receiptPath = path.join(evidence, physical ? 'physical-escape.json' : 'receipt.json');
  await fs.mkdir(evidence, { recursive: true });
  try { await fs.access(receiptPath); throw new Error('A probe receipt already exists; earlier evidence is preserved.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const corrective = attempt > 1 ? { correctiveChanges: ['Native lease pipe allows unlimited instances like libuv, so Node reports desktop_busy', 'Parent-death watcher is spawned detached; attached behavior is recorded as a finding'], priorAttempt: 'evidence/0.1.0-alpha.3.2/feasibility/receipt.json' } : {};
  const receipt = { schemaVersion: 1, caseId: physical ? 'A32-PROBE-PHYSICAL-ESCAPE' : 'A32-PROBE', attempt, ...corrective, observedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, supervisorSha256: await build(), testedSource: await sources(), cases: {} };
  receipt.display = await supervisor(['display']);
  const pinned = receipt.display.monitors === 1 && receipt.display.displays[0].bounds.width === 2880 && receipt.display.displays[0].bounds.height === 1800 && receipt.display.displays[0].dpi === 144;
  receipt.display.pinned = { monitors: 1, width: 2880, height: 1800, dpi: 144, match: pinned };
  const persist = () => fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  await persist();
  let fixture;
  try {
    if (!pinned) throw Object.assign(new Error('Display differs from the pinned mode'), { blocked: true });
    fixture = await fixtureSession();
    receipt.fixture = { activation: { foreground: fixture.activation.foreground }, point: 'empty lower-right client area' };
    if (physical) {
      await runCase(receipt, 'P-ESCAPE-PHYSICAL', async () => {
        const listener = startLong(['probe', 'escape-listen', '60']);
        await listener.line(1);
        process.stdout.write(JSON.stringify({ awaiting: 'physical Escape on the TRACE fixture window', timeoutSeconds: 60 }) + '\n');
        const result = await listener.line(2, 65000);
        await listener.exited;
        return { pass: result.physicalEscape === true, ...result };
      });
    } else {
      await runCase(receipt, 'P-JOB-MOUSE', () => heldInput(['hold-mouse', String(fixture.point.x), String(fixture.point.y)], [1], fixture));
      await runCase(receipt, 'P-JOB-CHORD', () => heldInput(['hold-keys', '0xA2,0xA0'], [0xA2, 0xA0], fixture));
      await runCase(receipt, 'P-JOB-TYPING', async () => {
        const before = await fixture.state();
        const result = await heldInput(['type-hold', 'abc'], [0x43], fixture);
        await delay(200);
        const after = await fixture.state();
        return { ...result, pass: result.pass && after.text === `${before.text}abc`, fixtureTextAdded: after.text.slice(before.text.length) };
      });
      await runCase(receipt, 'P-LEASE-EXCLUSION', async () => {
        const { DesktopLease } = require('../src/computer/lease.cjs');
        const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
        const native = startLong(['probe', 'pipe-hold']);
        const held = await native.line();
        if (held.lease !== 'held') throw Object.assign(new Error('Another controller owns the desktop'), { blocked: true });
        let nodeWhileNative;
        try { await lease.acquire('probe'); nodeWhileNative = 'acquired'; await lease.release('probe'); } catch (error) { nodeWhileNative = error.code; }
        native.child.kill();
        await native.exited;
        await lease.acquire('probe');
        const nodeAfterNativeDeath = 'acquired';
        const nativeWhileNode = await supervisor(['probe', 'pipe-hold']).catch(error => ({ error: error.code }));
        await lease.release('probe');
        const nativeAfterNode = startLong(['probe', 'pipe-hold']);
        const reacquired = await nativeAfterNode.line();
        nativeAfterNode.child.stdin.end();
        await nativeAfterNode.exited;
        return { pass: nodeWhileNative === 'desktop_busy' && nativeWhileNode.lease === 'busy' && reacquired.lease === 'held', pipe: held.pipe, nodeWhileNative, nodeAfterNativeDeath, nativeWhileNode: nativeWhileNode.lease ?? nativeWhileNode.error, nativeAfterNode: reacquired.lease };
      });
      await runCase(receipt, 'P-PARENT-DEATH', async () => {
        // Node's libuv places ordinary children in a kill-on-close job; a supervisor must be detached
        // to outlive the Node server. Record both spawn modes; only the detached watcher can pass.
        async function watch(detached) {
          const output = path.join(BUILD, `parent-watch-${randomUUID()}.json`);
          const script = `const {spawn}=require('child_process'); const c=spawn(${JSON.stringify(EXE)},['probe','parent-watch',String(process.pid),${JSON.stringify(output)}],{windowsHide:true,detached:${detached},stdio:['pipe','pipe','ignore']}); c.stdout.once('data',()=>process.stdout.write(String(c.pid)+'\\n')); setInterval(()=>{},1000);`;
          const parent = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
          const watcherPid = Number(await new Promise(resolve => parent.stdout.once('data', chunk => resolve(String(chunk).trim()))));
          await delay(200);
          const killedAt = Date.now();
          parent.kill();
          let result;
          const deadline = Date.now() + 3000;
          while (!result && Date.now() < deadline) { try { result = JSON.parse(await fs.readFile(output, 'utf8')); } catch { await delay(50); } }
          const watcherExit = await exitOf(watcherPid);
          return result ? { recorded: true, parentExitDetectedMs: result.parentExitAt - killedAt, stdinEofDetectedMs: result.stdinEofAt - killedAt, watcherExit } : { recorded: false, watcherExit };
        }
        const attached = await watch(false);
        const detached = await watch(true);
        const prompt = value => value >= 0 && value < 2000;
        return { pass: detached.recorded && prompt(detached.parentExitDetectedMs) && prompt(detached.stdinEofDetectedMs) && detached.watcherExit.exited,
          attached, detached, finding: 'An attached child is killed with its Node parent; the supervisor must be spawned detached.' };
      });
      await runCase(receipt, 'P-ESCAPE-INJECTED', async () => {
        const result = await supervisor(['probe', 'escape-listen', '2', 'inject'], 10000);
        const injected = (result.events ?? []).filter(event => event.Injected);
        return { pass: result.physicalEscape === false && injected.some(event => event.Down) && injected.some(event => !event.Down), events: result.events, physicalEscape: result.physicalEscape };
      });
      receipt.cases['P-ESCAPE-PHYSICAL'] = { status: 'not_run', reason: 'Needs the owner to press the physical key; run --physical-escape separately' };
    }
  } catch (error) {
    receipt.failure = { code: String(error.code || 'probe_failed'), blocked: !!error.blocked, message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 600) };
  } finally {
    if (fixture) receipt.fixtureExit = await fixture.close();
    receipt.finalKeysDown = (await supervisor(['keystate', 'all'])).down;
    const statuses = Object.entries(receipt.cases).filter(([id]) => physical || id !== 'P-ESCAPE-PHYSICAL').map(([, value]) => value.status);
    receipt.result = receipt.failure ? (receipt.failure.blocked ? 'blocked' : 'fail') : statuses.includes('fail') ? 'fail' : statuses.every(status => status === 'pass') ? 'pass' : 'blocked';
    receipt.completedAt = new Date().toISOString();
    await persist();
  }
  return { result: receipt.result, cases: Object.fromEntries(Object.entries(receipt.cases).map(([id, value]) => [id, value.status])), failure: receipt.failure ?? null, finalKeysDown: receipt.finalKeysDown };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
module.exports = { main };
