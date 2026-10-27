#!/usr/bin/env node
'use strict';

// A31-GLOW continuation of GLOW-LIVE attempt 2 against the owned full-screen glow fixture.
// --selfcheck validates harness plumbing without a TRACE session or input.
// --independent runs the subcases that need no reference executor. --coordinated runs the
// 0 -> 1 -> 2 edge-click sequence while a separate reference executor supplies click 1.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const glow = require('./smoke-computer-glow.cjs');

const ROOT = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const BACKGROUND = [24, 28, 40];
const SUBCASES = {
  'A31-GLOW-START': 'Marker readiness for one monitor; fixture stays foreground with the same focused window before and after marker start',
  'A31-GLOW-VISIBLE': 'Desktop capture shows tinted left and top edge bands; the fixture verifies the interior is unchanged background',
  'A31-GLOW-EOF': 'Ordinary session close ends the marker process within 5 s; a later capture has no overlay and background edge bands',
  'A31-GLOW-PARENT-LOSS': 'Abrupt termination of the owning MCP server ends the marker within 5 s; no overlay remains; the desktop lease is free',
  'A31-GLOW-REFERENCE-CLICK': 'Count 0 -> 1 after exactly one reference-executor edge click through the glow',
  'A31-GLOW-TRACE-CLICK': 'Count 1 -> 2 after exactly one TRACE MCP edge click through the glow',
};
const RUNS = {
  independent: ['A31-GLOW-START', 'A31-GLOW-VISIBLE', 'A31-GLOW-EOF', 'A31-GLOW-PARENT-LOSS'],
  coordinated: ['A31-GLOW-START', 'A31-GLOW-VISIBLE', 'A31-GLOW-REFERENCE-CLICK', 'A31-GLOW-TRACE-CLICK', 'A31-GLOW-EOF'],
  selfcheck: [],
  regression: ['A31-GLOW-START', 'A31-GLOW-VISIBLE', 'A31-GLOW-EOF', 'A31-GLOW-PARENT-LOSS'],
};
const SOURCE_FILES = [
  'bin/trace.cjs', 'src/computer/server.cjs', 'src/computer/controller.cjs', 'src/computer/lease.cjs',
  'src/computer/winapp-backend.cjs', 'src/computer/activity-indicator.cjs',
  'native/TraceActivityIndicator/Program.cs', 'native/TraceActivityIndicator/TraceActivityIndicator.csproj',
  'native/TraceWindowBridge/Program.cs', 'native/TraceWindowBridge/TraceWindowBridge.csproj',
  'tests/fixtures/glow-app/Program.cs', 'tests/fixtures/glow-app/TraceGlowFixture.csproj',
  'scripts/smoke-computer-glow.cjs', 'scripts/accept-glow.cjs', 'package.json', 'package-lock.json',
];

function parseArgs(args) {
  const options = { mode: null, evidence: null, expectedWidth: 2880, expectedHeight: 1800, expectedDpi: 144, referenceWaitMs: 180000 };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (['--plan', '--selfcheck', '--independent', '--coordinated', '--regression'].includes(key)) options.mode = key.slice(2);
    else if (key === '--evidence') options.evidence = args[++index];
    else if (key === '--expect-mode') {
      const match = /^(\d+)x(\d+)@(\d+)$/.exec(args[++index] || '');
      if (!match) throw new Error('--expect-mode uses WIDTHxHEIGHT@DPI, for example 2880x1800@144.');
      [options.expectedWidth, options.expectedHeight, options.expectedDpi] = match.slice(1).map(Number);
    } else if (key === '--reference-wait-ms') options.referenceWaitMs = Number(args[++index]);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!options.mode) throw new Error('Usage: node scripts/accept-glow.cjs --plan|--selfcheck|--independent|--coordinated --evidence evidence/<new directory> [--expect-mode 2880x1800@144]');
  if (options.mode !== 'plan') {
    if (!options.evidence) throw new Error('--evidence names a new directory under evidence/.');
    const resolved = path.resolve(ROOT, options.evidence);
    const relative = path.relative(path.join(ROOT, 'evidence'), resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence must stay inside evidence/.');
    options.evidence = resolved;
  }
  if (!Number.isInteger(options.referenceWaitMs) || options.referenceWaitMs < 10000 || options.referenceWaitMs > 600000) throw new Error('Reference wait must be 10000..600000 ms.');
  return options;
}

// Minimal decoder for the fixture's non-interlaced 8-bit RGB/RGBA PNG captures.
function decodePng(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Capture is not a PNG');
  let offset = 8, header;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  assert.ok(header && header.depth === 8 && [2, 6].includes(header.color) && header.interlace === 0, 'Unsupported capture PNG format');
  const channels = header.color === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else assert.equal(filter, 0, 'Unknown PNG filter');
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width: header.width, height: header.height, pixel: (x, y) => [...pixels.subarray(y * stride + x * channels, y * stride + x * channels + 3)] };
}

// Samples the left band at a quarter height and the top band at half width, away from the edge button.
function edgeBands(bytes) {
  const image = decodePng(bytes);
  const row = Math.floor(image.height / 4), column = Math.floor(image.width / 2);
  const isBackground = rgb => rgb.every((value, index) => value === BACKGROUND[index]);
  const left = Array.from({ length: 24 }, (_, x) => isBackground(image.pixel(x, row)));
  const top = Array.from({ length: 24 }, (_, y) => isBackground(image.pixel(column, y)));
  return {
    width: image.width, height: image.height, sampleRow: row, sampleColumn: column,
    tintedLeft: left.slice(2, 13).filter(value => !value).length, tintedTop: top.slice(2, 13).filter(value => !value).length,
    backgroundLeft: left.filter(Boolean).length, backgroundTop: top.filter(Boolean).length,
  };
}
const glowVisible = bands => bands.tintedLeft === 11 && bands.tintedTop === 11;
const glowAbsent = bands => bands.backgroundLeft === 24 && bands.backgroundTop === 24;

async function processList(filter) {
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; created = $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function monitorCount() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Count'], { windowsHide: true, timeout: 20000 });
  return Number(stdout.trim());
}

async function markerOf(serverPid) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const found = await processList(`Name='TraceActivityIndicator.exe' AND ParentProcessId=${Number(serverPid)}`);
    assert.ok(found.length < 2, 'More than one marker belongs to the owned server');
    if (found.length === 1) return found[0];
    await delay(200);
  }
  throw Object.assign(new Error('No running marker process belongs to the owned server'), { code: 'marker_not_found', source: 'trace' });
}

async function waitForExit(identity, timeoutMs = 5000) {
  const started = Date.now();
  while (true) {
    try { process.kill(identity.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error; // EPERM does not prove exit.
      return { pid: identity.pid, exited: true, verification: 'ESRCH', elapsedMs: Date.now() - started };
    }
    if (Date.now() - started > timeoutMs) {
      // A reused PID must not be mistaken for the original process.
      const same = (await processList(`ProcessId=${Number(identity.pid)}`)).some(item => item.created === identity.created);
      if (!same) return { pid: identity.pid, exited: true, verification: 'PID now has another creation time', elapsedMs: Date.now() - started };
      return { pid: identity.pid, exited: false, verification: 'still running after the bound', elapsedMs: Date.now() - started };
    }
    await delay(25);
  }
}

async function startServer(runtimeDirectory, stderrPath) {
  const { Client } = require('@modelcontextprotocol/client');
  const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'trace-glow-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'bin', 'trace.cjs'), 'computer', 'mcp'],
    cwd: ROOT, env: { ...process.env, TRACE_COMPUTER_RUNTIME: runtimeDirectory }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16384); });
  await client.connect(transport, { timeout: 15000 });
  const pid = transport.pid;
  const record = (await processList(`ProcessId=${Number(pid)}`))[0];
  assert.ok(record && record.parent === process.pid && /^node(\.exe)?$/i.test(record.name), 'The MCP server is not a direct owned Node child');
  const identity = { pid, created: record.created, name: record.name };
  const call = async (name, args = {}) => {
    let result;
    try { result = await client.callTool({ name, arguments: args }, { timeout: 45000 }); }
    catch (error) { throw Object.assign(error, { source: 'transport' }); }
    const state = result.structuredContent;
    // Another controller owning the desktop is interference, not a glow failure.
    if (result.isError) throw Object.assign(new Error(state?.error?.message || `${name} failed`), { code: state?.error?.code, source: ['desktop_busy', 'lease_unavailable'].includes(state?.error?.code) ? 'environment' : 'trace' });
    return state;
  };
  const flush = () => fs.writeFile(stderrPath, stderr);
  return {
    pid, identity, call,
    async close() {
      try { await client.close(); } catch {}
      try { await transport.close(); } catch {}
      await flush();
      return waitForExit(identity);
    },
    async killAbruptly() {
      // TerminateProcess: no MCP close, no session close and no marker EOF sent by the server.
      process.kill(pid);
      const exit = await waitForExit(identity);
      try { await client.close(); } catch {}
      await flush();
      return exit;
    },
  };
}

function planDocument(options) {
  const runs = RUNS[options.mode] ?? RUNS.independent;
  return {
    schemaVersion: 1, caseId: options.mode === 'regression' ? 'A31-GLOW-REGRESSION' : 'A31-GLOW', legacyCaseId: 'GLOW-LIVE', attempt: options.mode === 'regression' ? null : 2, continuation: options.mode,
    declaredBeforeUiLaunch: true,
    priorResults: [
      { path: 'evidence/0.1.0-alpha.3.1/glow-attempt-1/receipt.json', status: 'fail' },
      { path: 'evidence/0.1.0-alpha.3.1/glow-retry-plan.json', status: 'declared corrective retry' },
      { path: 'evidence/0.1.0-alpha.3.1/glow-interrupted.json', status: 'blocked by the reference executor physical Escape stop before planned input' },
    ],
    failureBudget: options.mode === 'regression' ? 'Focused regression after the topmost fix. It cannot pass or retry A31-GLOW, which keeps its failed result.' : 'Attempt 1 failed. This continues attempt 2, the one corrective retry. A failed subcase ends A31-GLOW as fail; a blocked subcase keeps it pending. A self-check is harness preparation, not an attempt.',
    display: { pinned: { monitors: 1, width: options.expectedWidth, height: options.expectedHeight, dpi: options.expectedDpi }, mismatch: 'blocks every live subcase in this run' },
    target: 'New owned full-screen synthetic primary-monitor fixture; exact returned HWND and PID',
    initialState: { count: 0, mouseClickCount: 0, activationCount: 0, leftButtonDown: false, privateApplicationContent: false },
    setup: 'Activate the fixture through the source-owned window bridge before any marker starts; this is preparation, not a TRACE action',
    subcases: Object.fromEntries(Object.entries(SUBCASES).map(([id, expected]) => [id, { expected, runInThisMode: runs.includes(id) }])),
    classification: 'A TRACE MCP error or oracle mismatch fails the subcase; harness or environment errors block it with the recorded error',
    measurementRetries: 'A desktop capture may be repeated up to three times; captures dispatch no input',
    inputActions: options.mode === 'coordinated' ? ['One reference-executor edge click (external)', 'One TRACE MCP coordinate click on the edge button'] : [],
    cleanup: 'Close owned sessions and servers, verify marker and server exit by PID, close the fixture through its command file and verify its exit',
    limits: ['One monitor; topology transitions deferred', 'Fixture-only behavior; not host acceptance', 'Glow lifecycle owned by the Node MCP server in this build; alpha.3.2 moves it under the native supervisor'],
  };
}

async function testedSource() {
  const [commit, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: ROOT, windowsHide: true }),
  ]);
  const files = {};
  for (const name of SOURCE_FILES) files[name] = sha256(await fs.readFile(path.join(ROOT, name)));
  return { baseCommit: commit.stdout.trim(), workingTreeModified: status.stdout.trim().length > 0, files };
}

async function run(options) {
  assert.equal(process.platform, 'win32', 'The owned glow fixture requires Windows');
  const { DEFAULT_BRIDGE, runProcess, parseJson } = require('../src/computer/winapp-backend.cjs');
  const { DesktopLease } = require('../src/computer/lease.cjs');
  await fs.mkdir(path.dirname(options.evidence), { recursive: true });
  await fs.mkdir(options.evidence); // EEXIST preserves earlier evidence.
  const runId = randomUUID();
  const raw = path.join(ROOT, '.runtime', 'glow-acceptance', runId);
  const fixtureDirectory = path.join(raw, 'fixture');
  await fs.mkdir(fixtureDirectory, { recursive: true });
  const plan = planDocument(options);
  const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  await fs.writeFile(path.join(options.evidence, 'plan.json'), planBytes);
  const source = await testedSource();
  const receipt = {
    schemaVersion: 1, caseId: { selfcheck: 'A31-GLOW-HARNESS-SELFCHECK', regression: 'A31-GLOW-REGRESSION' }[options.mode] ?? 'A31-GLOW', legacyCaseId: 'GLOW-LIVE',
    attempt: ['selfcheck', 'regression'].includes(options.mode) ? null : 2, continuation: options.mode, runId,
    plan: { path: 'plan.json', sha256: sha256(planBytes) }, testedSource: source,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    lifecycle: 'running', subcases: {}, artifacts: [], cleanup: {},
  };
  const persist = () => fs.writeFile(path.join(options.evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const setCase = async (id, status, actual, reason) => { receipt.subcases[id] = { status, actual, ...(reason ? { reason } : {}) }; await persist(); };
  const artifact = async (name, bytes) => {
    await fs.writeFile(path.join(options.evidence, name), bytes);
    receipt.artifacts.push({ path: name, sha256: sha256(bytes) });
  };
  const blockRemaining = async reason => { for (const id of RUNS[options.mode]) if (!receipt.subcases[id]) await setCase(id, 'blocked', null, reason); };
  await persist();
  await glow.verify();

  let fixture;
  let fixtureExit;
  let server;
  let current = null;
  const fixtureStatus = async () => JSON.parse(await fs.readFile(path.join(fixtureDirectory, 'status.json'), 'utf8'));
  const fixtureCommand = (command, extra = {}) => glow.command({ directory: fixtureDirectory, command, ...extra });
  async function capture(name, indicatorPid) {
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const status = await fixtureCommand('capture-desktop', { file: name, indicatorPid });
        const bytes = await fs.readFile(path.join(fixtureDirectory, name));
        assert.equal(sha256(bytes), status.lastCommand.capture.sha256, 'Capture changed after the fixture hashed it');
        await artifact(name, bytes);
        attempts.push({ attempt, status: 'pass' });
        return { bands: edgeBands(bytes), attempts };
      } catch (error) {
        const code = /failed: ([a-z_]{1,64})\.$/.exec(error.message)?.[1] ?? 'capture_failed';
        attempts.push({ attempt, status: 'refused', code });
        await delay(700);
      }
    }
    throw Object.assign(new Error(`Desktop capture ${name} was refused three times`), { code: 'capture_refused', attempts });
  }
  const focusSnapshot = async () => (await fixtureCommand('focus')).lastCommand.after;
  async function activateFixture(status) {
    try {
      const result = await runProcess(DEFAULT_BRIDGE, ['activate', status.windowId, String(status.pid)], { timeoutMs: 10000 });
      const parsed = parseJson(result.stdout, result.stderr, result.exitCode);
      return { foreground: parsed.foreground === true, enabled: parsed.enabled, method: parsed.method };
    } catch (error) { return { foreground: false, code: error.code || 'activation_failed' }; }
  }
  async function openSession(label) {
    server = await startServer(path.join(raw, `runtime-${label}`), path.join(raw, `server-${label}-stderr.txt`));
    const doctor = await server.call('trace_computer_doctor');
    if (doctor.ready !== true) throw Object.assign(new Error(`TRACE doctor is not ready: ${doctor.code || doctor.reason}`), { code: 'doctor_not_ready', source: 'environment' });
    const windows = await server.call('trace_computer_list_windows');
    const status = await fixtureStatus();
    const window = windows.windows.find(item => item.pid === status.pid && item.id === status.windowId);
    if (!window) throw Object.assign(new Error('The owned fixture window was not discovered'), { code: 'fixture_not_discovered', source: 'trace' });
    const before = await focusSnapshot();
    const session = await server.call('trace_computer_open_session', { windowId: window.id });
    const after = await focusSnapshot();
    const marker = await markerOf(server.pid);
    return { session, before, after, marker, doctor: { ready: doctor.ready, activityIndicator: doctor.activityIndicator } };
  }
  const focusUnchanged = (before, after) => before.fixtureForeground === true && after.fixtureForeground === true
    && before.foregroundWindowId === after.foregroundWindowId && before.focusedWindowId === after.focusedWindowId;

  try {
    fixture = spawn(glow.BINARY, ['--directory', fixtureDirectory, '--parent-pid', String(process.pid), '--lifetime-ms', '240000'], { shell: false, windowsHide: false, stdio: 'ignore' });
    fixtureExit = new Promise(resolve => fixture.once('exit', code => resolve(code)));
    const ready = await glow.waitFor(fixtureDirectory, state => state.ready === true && state.pid === fixture.pid, 10000);
    receipt.display = {
      monitors: await monitorCount(), primary: ready.monitor, dpi: ready.dpi,
      source: 'owned PerMonitorV2 fixture Screen.PrimaryScreen.Bounds and DeviceDpi; monitor count from Screen.AllScreens', pinned: plan.display.pinned,
    };
    receipt.display.match = receipt.display.monitors === plan.display.pinned.monitors && ready.monitor.width === plan.display.pinned.width
      && ready.monitor.height === plan.display.pinned.height && ready.dpi === plan.display.pinned.dpi;
    if (!receipt.display.match) { await blockRemaining('Display mode differs from the pinned mode; replan required'); return receipt; }
    receipt.initial = { count: ready.count, mouseClickCount: ready.mouseClickCount, activationCount: ready.activationCount, leftButtonDown: ready.input.leftButtonDown };
    assert.deepEqual(receipt.initial, { count: 0, mouseClickCount: 0, activationCount: 0, leftButtonDown: false }, 'New fixture did not start at count zero with released input');
    receipt.setup = { activation: await activateFixture(ready) };
    await persist();
    if (!receipt.setup.activation.foreground) { await blockRemaining('Windows refused fixture activation during setup'); return receipt; }

    if (options.mode === 'selfcheck') {
      const capture0 = await capture('selfcheck-no-glow.png', 0);
      const fixtureRecord = (await processList(`ProcessId=${Number(fixture.pid)}`))[0];
      server = await startServer(path.join(raw, 'runtime-selfcheck'), path.join(raw, 'server-selfcheck-stderr.txt'));
      const doctor = await server.call('trace_computer_doctor');
      const windows = await server.call('trace_computer_list_windows');
      const status = await fixtureStatus();
      receipt.selfcheck = {
        captureBands: capture0.bands, glowAbsentOracle: glowAbsent(capture0.bands), fixtureProcessVisible: fixtureRecord?.pid === fixture.pid,
        serverIsDirectNodeChild: true, doctorReady: doctor.ready === true, activityIndicator: doctor.activityIndicator,
        fixtureDiscovered: windows.windows.some(item => item.pid === status.pid && item.id === status.windowId),
        markersOwnedByServer: (await processList(`Name='TraceActivityIndicator.exe' AND ParentProcessId=${Number(server.pid)}`)).length,
        focus: status.focus, sessionOpened: false, inputDispatched: 0,
      };
      receipt.cleanup.server = await server.close();
      server = undefined;
      return receipt;
    }

    // Lifecycle A: session start, visible glow, then ordinary close/EOF.
    current = 'A31-GLOW-START';
    const a = await openSession('close');
    await setCase('A31-GLOW-START', focusUnchanged(a.before, a.after) && a.session.activityIndicator?.monitors === 1 ? 'pass' : 'fail',
      { before: a.before, after: a.after, activityIndicator: a.session.activityIndicator, markerPid: a.marker.pid, doctor: a.doctor });
    current = 'A31-GLOW-VISIBLE';
    const active = await capture('glow-active.png', a.marker.pid);
    await setCase('A31-GLOW-VISIBLE', glowVisible(active.bands) ? 'pass' : 'fail', { bands: active.bands, captureAttempts: active.attempts });

    if (options.mode === 'coordinated') { current = 'A31-GLOW-REFERENCE-CLICK'; await coordinatedClicks(a, server, fixtureStatus, setCase, options); }

    current = 'A31-GLOW-EOF';
    await server.call('trace_computer_close_session', { sessionId: a.session.sessionId });
    const markerExit = await waitForExit(a.marker);
    await delay(300);
    const closed = await capture('glow-after-close.png', 0);
    const serverExitA = await server.close();
    server = undefined;
    await setCase('A31-GLOW-EOF', markerExit.exited && glowAbsent(closed.bands) ? 'pass' : 'fail', { markerExit, bands: closed.bands, captureAttempts: closed.attempts, serverExit: serverExitA });

    if (options.mode === 'independent' || options.mode === 'regression') {
      // Lifecycle B: abrupt owner loss with a live session and no session close.
      current = 'A31-GLOW-PARENT-LOSS';
      const status = await fixtureStatus();
      if (!status.focus.fixtureForeground) {
        receipt.setup.reactivation = await activateFixture(status);
        if (!receipt.setup.reactivation.foreground) throw Object.assign(new Error('Windows refused fixture reactivation'), { code: 'activation_refused', source: 'environment' });
      }
      const b = await openSession('parent-loss');
      const start = { before: b.before, after: b.after, focusUnchanged: focusUnchanged(b.before, b.after), markerPid: b.marker.pid };
      const beforeLoss = await capture('glow-before-parent-loss.png', b.marker.pid);
      const serverExit = await server.killAbruptly();
      server = undefined;
      const markerLoss = await waitForExit(b.marker);
      await delay(300);
      const afterLoss = await capture('glow-after-parent-loss.png', 0);
      const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
      let leaseFree = false;
      try { await lease.acquire('glow-parent-loss-check'); leaseFree = true; }
      catch (error) { if (error.code !== 'desktop_busy') throw error; }
      finally { if (leaseFree) await lease.release('glow-parent-loss-check'); }
      const pass = start.focusUnchanged && glowVisible(beforeLoss.bands) && serverExit.exited && markerLoss.exited && glowAbsent(afterLoss.bands) && leaseFree;
      await setCase('A31-GLOW-PARENT-LOSS', pass ? 'pass' : 'fail', { start, bandsBefore: beforeLoss.bands, serverExit, markerExit: markerLoss, bandsAfter: afterLoss.bands, leaseFree });
      if (options.mode === 'regression') {
        await setCase('A31-GLOW-REFERENCE-CLICK', 'not_run', null, 'Outside the focused regression');
        await setCase('A31-GLOW-TRACE-CLICK', 'not_run', null, 'Outside the focused regression');
      } else {
        await setCase('A31-GLOW-REFERENCE-CLICK', 'blocked', null, 'Requires the separate Codex reference executor with Claude observing; run --coordinated in that session');
        await setCase('A31-GLOW-TRACE-CLICK', 'blocked', null, 'Follows the reference click on the same fixture instance; run --coordinated in that session');
      }
    } else {
      await setCase('A31-GLOW-PARENT-LOSS', 'not_run', null, 'Covered by the independent continuation receipt');
    }
    current = null;
  } catch (error) {
    receipt.failure = { phase: current, source: error.source ?? 'harness', code: String(error.code || 'assertion_failed'), message: String(error.message).replaceAll(ROOT, '<repo>').slice(0, 800), ...(error.attempts ? { attempts: error.attempts } : {}) };
    if (current && !receipt.subcases[current]) {
      if (error.source === 'trace') await setCase(current, 'fail', { error: receipt.failure });
      else await setCase(current, 'blocked', { error: receipt.failure }, 'Harness or environment error before a product result; see failure');
    }
    if (options.mode !== 'selfcheck') for (const id of RUNS[options.mode]) if (!receipt.subcases[id]) await setCase(id, 'not_run', null, 'Not reached after an earlier stop');
  } finally {
    if (server) { try { receipt.cleanup.server = await server.close(); } catch (error) { receipt.cleanup.server = { error: error.code || 'close_failed' }; } }
    if (fixture && fixture.exitCode === null) {
      try { await fixtureCommand('close'); } catch { fixture.kill(); }
      const timer = setTimeout(() => fixture.kill(), 5000);
      receipt.cleanup.fixture = { exitCode: await fixtureExit, pid: fixture.pid };
      clearTimeout(timer);
    }
    receipt.cleanup.indicatorProcessesRemaining = (await processList("Name='TraceActivityIndicator.exe'")).length;
    receipt.sourcesUnchangedDuringRun = JSON.stringify((await testedSource()).files) === JSON.stringify(source.files);
    const statuses = Object.values(receipt.subcases).map(item => item.status);
    receipt.result = statuses.includes('fail') ? 'fail' : receipt.failure || statuses.some(status => status !== 'pass') ? 'pending' : 'pass';
    receipt.lifecycle = 'completed';
    receipt.observedAt = new Date().toISOString();
    await persist();
  }
  return receipt;
}

// Waits for exactly one reference click, then performs exactly one TRACE MCP click on the same fixture.
async function coordinatedClicks(a, server, fixtureStatus, setCase, options) {
  const baseline = await fixtureStatus();
  assert.equal(baseline.count, 0, 'Reference click requires count zero');
  process.stdout.write(JSON.stringify({ awaiting: 'reference-click', target: 'left-edge button under the glow', button: baseline.button, timeoutMs: options.referenceWaitMs }) + '\n');
  const deadline = Date.now() + options.referenceWaitMs;
  let reference;
  while (Date.now() < deadline) {
    const status = await fixtureStatus();
    if (status.count >= 1 || status.mouseDownCount > 0) { reference = status; break; }
    await delay(100);
  }
  if (!reference) {
    await setCase('A31-GLOW-REFERENCE-CLICK', 'blocked', { count: baseline.count }, 'No reference click arrived within the bounded wait');
    await setCase('A31-GLOW-TRACE-CLICK', 'blocked', null, 'Requires the reference click first');
    return;
  }
  await delay(500);
  const settled = await fixtureStatus();
  const referencePass = settled.count === 1 && settled.mouseClickCount === 1 && settled.input.leftButtonDown === false;
  await setCase('A31-GLOW-REFERENCE-CLICK', referencePass ? 'pass' : 'fail', { count: settled.count, mouseClickCount: settled.mouseClickCount, activationCount: settled.activationCount, lastMouseClick: settled.lastMouseClick });
  if (!referencePass) { await setCase('A31-GLOW-TRACE-CLICK', 'not_run', null, 'Reference click did not produce exactly count 1'); return; }
  const observation = await server.call('trace_computer_observe', { sessionId: a.session.sessionId });
  const x = settled.button.x - observation.bounds.x + Math.floor(settled.button.width / 2);
  const y = settled.button.y - observation.bounds.y + Math.floor(settled.button.height / 2);
  const result = await server.call('trace_computer_act', { sessionId: a.session.sessionId, observationId: observation.observationId, action: { type: 'click', x, y } });
  await delay(500);
  const after = await fixtureStatus();
  const tracePass = result.outcome === 'completed' && after.count === 2 && after.mouseClickCount === 2 && after.input.leftButtonDown === false;
  await setCase('A31-GLOW-TRACE-CLICK', tracePass ? 'pass' : 'fail', { outcome: result.outcome, count: after.count, mouseClickCount: after.mouseClickCount, point: { x, y } });
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.mode === 'plan') return planDocument({ ...options, mode: 'independent' });
  const receipt = await run(options);
  return { caseId: receipt.caseId, result: receipt.result, subcases: Object.fromEntries(Object.entries(receipt.subcases).map(([id, value]) => [id, value.status])), selfcheck: receipt.selfcheck ?? undefined, failure: receipt.failure ?? null, evidence: path.relative(ROOT, options.evidence).replaceAll(path.sep, '/') };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { parseArgs, decodePng, edgeBands, glowVisible, glowAbsent, planDocument, main };
