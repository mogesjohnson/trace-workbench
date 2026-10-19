#!/usr/bin/env node
'use strict';

// Opt-in acceptance against our own desktop fixture. No unrelated app is opened,
// controlled, or captured. Without --live this only builds the fixture.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, '.runtime', 'computer-fixture');
const PROJECT = path.join(ROOT, 'tests', 'fixtures', 'computer-app', 'TraceComputerFixture.csproj');
const EXECUTABLE = path.join(BUILD, 'bin', 'TraceComputerFixture.exe');
const DEFAULT_REPORT = path.join(ROOT, 'evidence', '0.1.0-alpha.3', 'review-run', 'computer-live.json');
const execFileAsync = promisify(execFile);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// These oracles check fixture state, rather than treating delivered input as success.
function assertScroll(receipt, expected) {
  assert.equal(receipt.scrollY, expected, 'The actual viewport offset differs from the declared result');
  assert.equal(receipt.scrollRowOffset, expected, 'The visible first-row position disagrees with the viewport offset');
}

function assertChord(receipt, expectedText) {
  assert.equal(receipt.chord, 'ctrl+d');
  assert.equal(receipt.text, expectedText, 'The chord changed the text');
  assert.equal(receipt.selectionStart, 0);
  assert.equal(receipt.selectionLength, 5);
  assert.equal(receipt.selectedText, 'TRACE');
  assert.equal(receipt.controlPressed, false);
  assert.equal(receipt.shiftPressed, false);
  assert.equal(receipt.altPressed, false);
  assert.equal(receipt.modifiers, 'None');
}

function assertDrag(receipt, expected) {
  assert.equal(receipt.dragX, expected.x, 'The drag ended at the wrong X coordinate');
  assert.equal(receipt.dragY, expected.y, 'The drag ended at the wrong Y coordinate');
  assert.equal(receipt.dragDrops, expected.drops, 'A completed gesture must produce exactly one drop');
  assert.equal(receipt.dragStarts, expected.starts);
  assert.equal(receipt.dragPressed, false);
  assert.equal(receipt.leftButtonDown, false);
}

function resultState(cases, failed = false, completed = true) {
  return {
    result: !completed ? 'running' : failed || cases.some((item) => item.status === 'fail') ? 'failed' : 'passed',
    // A successful scoped run does not discharge required cases that were not exercised.
    milestoneStatus: !completed || failed || cases.some((item) => item.required !== false && item.status !== 'pass') ? 'incomplete' : 'complete',
  };
}

async function rejectedModalParentAction(dispatch) {
  let result;
  try { result = await dispatch(); }
  catch (error) {
    if (error.code !== 'unknown_element') throw error;
    return 'unknown_element'; // Controller validation rejected a provider-reported disabled element.
  }
  assert.equal(result.outcome, 'unknown', 'A modal parent must reject input before dispatch');
  assert.ok(['window_blocked', 'foreground_not_target', 'stale_element'].includes(result.error?.code), 'Unexpected parent-action error; do not treat it as modal safety evidence');
  assert.notEqual(result.error?.inputRecoveryRequired, true, 'Quarantine cannot pass a modal-parent case');
  return result.error.code;
}

async function waitForOwnedProcessExit(pid, { probe = process.kill, timeoutMs = 5000 } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Cannot verify exit without the spawned server PID');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { probe(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return { pid, exited: true, verification: 'ESRCH after transport teardown' };
      throw error; // Permission errors do not prove that the server exited.
    }
    if (Date.now() >= deadline) throw Object.assign(new Error('Owned MCP server exit remains unconfirmed'), { code: 'process_exit_unconfirmed' });
    await delay(25);
  }
}

const SOURCE_FILES = [
  'bin/trace.cjs', 'src/computer/server.cjs', 'src/computer/controller.cjs', 'src/computer/lease.cjs',
  'src/computer/winapp-backend.cjs', 'scripts/smoke-computer-live.cjs',
  'tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj',
  'native/TraceWindowBridge/Program.cs', 'native/TraceWindowBridge/TraceWindowBridge.csproj',
  'package.json', 'package-lock.json', 'src/computer/winapp-pin.json',
];
async function sourceHashes() {
  return Promise.all(SOURCE_FILES.map(async (filename) => ({ path: filename, sha256: sha256(await fs.readFile(path.join(ROOT, filename))) })));
}

function casePlan(id, requirement, initialState, actions, expected, required = true) {
  return { id, requirement, required, status: 'not_run', reason: 'Not reached', plan: {
    target: 'Owned, run-scoped WinForms fixture; exact returned HWND and PID', initialState, actions,
    expected, cleanup: 'Close the current session and owned fixture; verify lease handoff and process exit',
  }, expected, actual: null, artifacts: { frames: [], fixtureStates: [] } };
}

async function buildFixture() {
  assert.equal(process.platform, 'win32', 'The desktop fixture requires Windows');
  await fs.mkdir(BUILD, { recursive: true });
  const { stdout, stderr } = await execFileAsync('dotnet', [
    'build', PROJECT, '--configuration', 'Release', '--output', path.join(BUILD, 'bin'),
    `--property:BaseIntermediateOutputPath=${path.join(BUILD, 'obj')}${path.sep}`, '--nologo',
  ], {
    cwd: ROOT, windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1' },
  });
  await fs.writeFile(path.join(BUILD, 'build.txt'), stdout + stderr);
  await fs.access(EXECUTABLE);
  return EXECUTABLE;
}

async function until(check, description, milliseconds = 12_000) {
  const deadline = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopFixture(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned fixture to exit', 5_000);
}

function target(observation, name) {
  const element = observation.elements.find((item) => item.name === name && item.enabled);
  assert.ok(element, `The owned fixture did not expose an enabled ${name} control`);
  return element;
}

function center(bounds, windowBounds) {
  assert.ok(bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y), 'Control has no usable bounds');
  assert.ok(bounds.width > 0 && bounds.height > 0, 'Control has empty bounds');
  return { x: Math.round(bounds.x + bounds.width / 2 - windowBounds.x), y: Math.round(bounds.y + bounds.height / 2 - windowBounds.y) };
}

function screenshotBytes(screenshot) {
  assert.ok(screenshot && typeof screenshot.data === 'string', 'Observation did not contain screenshot data');
  assert.match(screenshot.mimeType, /^image\/(png|jpeg)$/);
  assert.ok(screenshot.width > 0 && screenshot.height > 0, 'Observation has empty screenshot dimensions');
  const bytes = Buffer.from(screenshot.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
  assert.ok(bytes.length > 100, 'Observation has no usable screenshot bytes');
  return bytes;
}

async function createMcpController(runtimeDirectory, runDirectory) {
  const { Client } = require('@modelcontextprotocol/client');
  const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'trace-computer-live-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'bin', 'trace.cjs'), 'computer', 'mcp'],
    cwd: ROOT, env: { ...process.env, TRACE_COMPUTER_RUNTIME: runtimeDirectory }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384); });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Live computer acceptance exceeded eight minutes')), 480_000);
  let closing;
  let serverPid;
  const close = () => closing ??= (async () => {
    clearTimeout(timer);
    let closeError;
    const ownedPid = serverPid ?? transport.pid;
    let exit;
    try {
      // The SDK retains the exact ChildProcess for its bounded graceful/kill teardown.
      // Never send a termination signal using a cached PID that may have been reused.
      try { await client.close(); } catch (error) { closeError ??= error; }
      try { await transport.close(); } catch (error) { closeError ??= error; }
      if (ownedPid) {
        try { exit = await waitForOwnedProcessExit(ownedPid); } catch (error) { closeError ??= error; }
      }
    }
    finally {
      await fs.writeFile(path.join(runDirectory, 'mcp-stderr.txt'), stderr);
    }
    if (closeError) throw closeError;
    return exit ?? { started: false, exited: true };
  })();

  try {
    await client.connect(transport, { timeout: 15_000, signal: abort.signal });
    serverPid = transport.pid;
    const { tools } = await client.listTools({}, { timeout: 10_000, signal: abort.signal });
    const toolNames = tools.map((item) => item.name).sort();
    assert.deepEqual(toolNames, [
      'trace_computer_act', 'trace_computer_close_session', 'trace_computer_doctor',
      'trace_computer_list_windows', 'trace_computer_observe', 'trace_computer_open_session',
    ]);
    const call = async (name, arguments_ = {}) => {
      const result = await client.callTool({ name, arguments: arguments_ }, { timeout: 45_000, signal: abort.signal });
      const state = result.structuredContent;
      assert.ok(state && typeof state === 'object', `${name} did not return structured state`);
      if (result.isError) throw Object.assign(new Error(state.error?.message || `${name} failed`), { code: state.error?.code });
      const images = result.content.filter((item) => item.type === 'image');
      assert.ok(images.length <= 1, 'Computer response duplicated the screenshot');
      function attach(value) {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(attach);
        const valueWithImages = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, attach(item)]));
        if (valueWithImages.screenshot) {
          const screenshot = valueWithImages.screenshot;
          assert.equal(screenshot.data, undefined, 'Structured state duplicated base64 image data');
          const content = result.content[screenshot.contentIndex];
          assert.equal(content?.type, 'image', 'Screenshot reference did not resolve to MCP image content');
          assert.equal(content.mimeType, screenshot.mimeType);
          valueWithImages.screenshot = { ...screenshot, data: content.data };
        }
        return valueWithImages;
      }
      return attach(state);
    };
    return {
      doctor: () => call('trace_computer_doctor'),
      listWindows: () => call('trace_computer_list_windows'),
      openSession: (args) => call('trace_computer_open_session', args),
      observe: (args) => call('trace_computer_observe', args),
      act: (args) => call('trace_computer_act', args),
      closeSession: (args) => call('trace_computer_close_session', args), close,
      protocol: { transport: 'stdio', server: client.getServerVersion(), toolCount: tools.length, toolNames },
    };
  } catch (error) { await close(); throw error; }
}

async function runLive(reportPath) {
  const { createComputerController } = require('../src/computer/controller.cjs');
  const { runProcess, parseJson, DEFAULT_BINARY, DEFAULT_BRIDGE } = require('../src/computer/winapp-backend.cjs');
  const runId = `trace-${randomUUID()}`;
  const runDirectory = path.join(ROOT, '.runtime', 'computer-live', runId);
  const receiptPath = path.join(runDirectory, 'fixture-receipt.json');
  const commandsPath = path.join(runDirectory, 'commands.json');
  const title = `TRACE Computer Fixture — ${runId}`;
  const dialogTitle = `TRACE dialog — ${runId}`;
  const reportDirectory = path.dirname(reportPath);
  const uiaText = `TRACE accessibility value ${runId}`;
  const frames = [];
  const actions = [];
  const plans = [
    casePlan('A3-BASELINE', 'CU-01/CU-02/CU-03', 'New owned fixture', ['Activate, type, set value, click, invoke, toggle', 'Reject consumed observation; reject competing controller'], { text: uiaText, count: 2, optionChecked: true }),
    casePlan('A3-INPUT-KEY', 'CU-03', 'Text input contains declared text', ['Focus input', 'Press ctrl+d once'], { text: uiaText, selectedText: 'TRACE', selectionStart: 0, selectionLength: 5, modifiers: 'None' }),
    casePlan('A3-INPUT-SCROLL-DOWN', 'CU-03', 'Viewport at zero', ['Send deltaY +240 over panel'], { scrollY: 96, scrollRowOffset: 96 }),
    casePlan('A3-INPUT-SCROLL-UP', 'CU-03', 'Viewport at 96', ['Send deltaY -240 over panel'], { scrollY: 0, scrollRowOffset: 0 }),
    casePlan('A3-INPUT-DRAG', 'CU-03', 'Known target location and client dimensions', ['Drag +90 X, +16 Y; clamp to area'], { endpoint: 'Declared from baseline before input', dropsAdded: 1 }),
    casePlan('A3-RECOVERY-PRIMITIVE-CANCEL', 'CU-04/supporting-only', 'Released button, stationary drag target', ['Start raw native held drag', 'Await actual left-button press', 'Cancel; await native exit and release', 'Reobserve, click counter once'], { released: true, alreadyReleased: false, positionUnchanged: true, dropsAdded: 1, subsequentClickAdded: 1 }),
    casePlan('A3-DIALOG', 'CU-01', 'Enabled parent; no dialog', ['Open modal child once', 'Observe disabled owner and reject parent action', 'Select child explicitly, confirm', 'Close child and reacquire parent'], { parentEnabledWhileOpen: false, parentCountUnchanged: true, dialogConfirmed: true, parentEnabledAfterClose: true }),
    casePlan('A3-WINDOW-MOVE', 'CU-01/CU-02', 'Current observation of parent', ['Move fixture by command', 'Reject old geometry without counter change', 'Fresh capture and one counter click'], { staleOutcome: 'unknown', staleError: 'window_moved', counterAdded: 1 }),
    casePlan('A3-WINDOW-MINIMIZE', 'CU-01/CU-02', 'Current observation of visible parent', ['Minimize by command', 'Reject old geometry without counter change', 'Observe/restore and one counter click'], { staleOutcome: 'unknown', staleError: 'window_moved', counterAdded: 1 }),
    casePlan('A3-DISPLAY-MONITOR', 'CU-01', 'Known topology', ['Move onto a different physical monitor', 'Fresh capture and counter click'], { monitorChanged: true, counterAdded: 1 }),
    casePlan('A3-DISPLAY-DPI', 'CU-01', 'Known initial physical DPI', ['Move to a monitor with a different DPI', 'Fresh capture and counter click'], { twoDistinctDpiScales: true, counterAdded: 1 }),
    ...['MCP-CANCEL', 'TIMEOUT', 'DISCONNECT', 'CRASH', 'FAILED-CLEANUP'].map((name) => casePlan(`A3-RECOVERY-${name}`, 'CU-04', 'Independent owned-process case required', ['Exercise this failure mode through the product MCP/controller', 'Verify process exit, balanced input, quarantine when needed, and lease handoff'], { required: 'Separate end-to-end recovery evidence' })),
    casePlan('A3-LEASE-HANDOFF', 'CU-04', 'First controller owns session', ['Close session', 'Acquire/release from another controller'], { handoff: true }),
    casePlan('A3-CLEANUP', 'CU-04', 'Owned fixture and controllers may be running', ['Close owned controllers and fixture'], { fixtureExited: true, controllersClosed: true }),
  ];
  for (const item of plans.filter((item) => /A3-RECOVERY-(MCP-CANCEL|TIMEOUT|DISCONNECT|CRASH|FAILED-CLEANUP)$/.test(item.id))) {
    item.reason = 'Not exercised by this scoped run. Raw-native cancellation does not establish MCP recovery, timeout, disconnect, crash or failed-cleanup behavior.';
  }
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.mkdir(path.join(reportDirectory, 'frames'), { recursive: true });
  await fs.mkdir(path.join(reportDirectory, 'states'), { recursive: true });
  const [commit, status, files] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: ROOT, windowsHide: true }),
    sourceHashes(),
  ]);
  const testedSource = { baseCommit: commit.stdout.trim(), workingTreeModified: status.stdout.trim().length > 0, files };
  const planBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, runId, testedSource, cases: plans.map((item) => ({ id: item.id, requirement: item.requirement, ...item.plan })) }, null, 2) + '\n');
  await fs.writeFile(path.join(reportDirectory, 'plan.json'), planBytes);
  const summary = {
    schemaVersion: 2, scope: 'Owned-fixture input, modal and geometry acceptance; supporting raw-native cancellation only',
    runId, platform: process.platform, runtime: { node: process.version, architecture: process.arch, platform: process.platform },
    testedSource, fixtureExecutableSha256: sha256(await fs.readFile(EXECUTABLE)),
    plan: { path: 'plan.json', sha256: sha256(planBytes) }, cases: plans, actions, frames,
    rawEvidenceDirectory: path.relative(ROOT, runDirectory).replaceAll(path.sep, '/'),
    limits: ['Fixture-only behavior; no live model host, REPLAY workflow, secure/elevated desktop or complete MCP recovery acceptance.'],
  };
  let controller;
  const competitor = createComputerController({ runtimeDirectory: path.join(runDirectory, 'competitor-controller') });
  let fixture;
  let launchError;
  let session;
  let competitorSession;
  let current;
  let window;
  let failure;
  let finalReceipt;
  let doctor;

  const cleanError = (error) => ({ code: String(error.code || 'assertion_failed'), message: String(error.message || error).replaceAll(ROOT, '<repo>').slice(0, 1500) });
  async function persist(completed = false) {
    Object.assign(summary, resultState(plans, !!failure, completed), { lifecycle: completed ? 'completed' : 'running',
      observedAt: new Date().toISOString(), finalState: finalReceipt ?? null });
    if (controller) summary.protocol = controller.protocol;
    if (doctor) summary.engine = { name: doctor.engine, version: doctor.version, integrity: doctor.integrity };
    if (failure) summary.failure = cleanError(failure);
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2) + '\n');
  }
  async function receiptWhere(predicate, description) {
    return until(async () => {
      if (launchError) throw launchError;
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      assert.equal(receipt.runId, runId);
      assert.equal(receipt.title, title);
      return predicate(receipt) ? receipt : false;
    }, description);
  }
  async function stateArtifact(item, stage) {
    try {
      const state = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      assert.equal(state.runId, runId);
      const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
      const filename = `states/${item.id.toLowerCase()}-${stage}.json`;
      await fs.writeFile(path.join(reportDirectory, filename), bytes);
      item.artifacts.fixtureStates.push({ stage, path: filename, sha256: sha256(bytes) });
      finalReceipt = state;
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    }
  }
  async function runCase(id, expected, work) {
    const item = plans.find((entry) => entry.id === id);
    item.expected = expected;
    item.startedAt = new Date().toISOString();
    item.reason = 'In progress; no pass until independently checked';
    const startFrame = Math.max(0, frames.length - 1);
    await stateArtifact(item, 'before');
    await persist();
    try {
      item.actual = await work();
      item.status = 'pass';
      delete item.reason;
    } catch (error) {
      item.status = 'fail';
      item.actual = { error: cleanError(error) };
      item.reason = 'No automatic input retry; inspect retained fixture state and frames';
      throw error;
    } finally {
      await stateArtifact(item, 'after');
      item.artifacts.frames = frames.slice(startFrame).map((frame) => ({ path: `frames/${frame.filename}`, sha256: frame.sha256, observationId: frame.observationId }));
      item.finishedAt = new Date().toISOString();
      await persist();
    }
  }
  async function keep(observation) {
    assert.equal(observation.sessionId, session.sessionId);
    assert.equal(observation.window.id, session.window.id);
    assert.equal(observation.window.pid, fixture.pid);
    assert.equal(observation.window.title, session.window.title);
    const bytes = screenshotBytes(observation.screenshot);
    assert.equal(observation.screenshot.width, observation.bounds.width);
    assert.equal(observation.screenshot.height, observation.bounds.height);
    const filename = `frame-${String(frames.length + 1).padStart(3, '0')}.png`;
    await fs.writeFile(path.join(runDirectory, filename), bytes);
    await fs.writeFile(path.join(reportDirectory, 'frames', filename), bytes);
    frames.push({ filename, observationId: observation.observationId, bytes: bytes.length, sha256: sha256(bytes),
      width: observation.screenshot.width, height: observation.screenshot.height, bounds: observation.bounds });
    const { screenshot, ...metadata } = observation;
    await fs.writeFile(path.join(runDirectory, `${filename}.json`), JSON.stringify(metadata, null, 2) + '\n');
    current = observation;
    return observation;
  }
  async function dispatch(action) {
    const prior = current.observationId;
    const result = await controller.act({ sessionId: session.sessionId, observationId: prior, action });
    actions.push({ type: action.type, actionId: result.actionId, observationId: prior, outcome: result.outcome,
      ...(result.error ? { error: result.error.code } : {}), nextObservationId: result.observation?.observationId });
    return result;
  }
  async function act(action) {
    const prior = current.observationId;
    const result = await dispatch(action);
    assert.equal(result.outcome, 'completed', `Action ${action.type} did not complete; do not retry unknown outcomes`);
    assert.ok(result.observation, `Action ${action.type} returned no refreshed observation`);
    assert.notEqual(result.observation.observationId, prior, 'Action reused its consumed observation');
    return keep(result.observation);
  }
  let commandId = 0;
  async function command(op, predicate, description) {
    const id = ++commandId;
    const temporary = `${commandsPath}.${id}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ id, op }));
    await fs.rename(temporary, commandsPath);
    return receiptWhere((receipt) => receipt.appliedCommandId === id && predicate(receipt), description);
  }
  async function openOwnedWindow(expectedTitle) {
    if (session) {
      await controller.closeSession({ sessionId: session.sessionId });
      session = undefined;
    }
    const selected = await until(async () => {
      const result = await controller.listWindows();
      return result.windows.find((item) => item.pid === fixture.pid && item.title === expectedTitle);
    }, expectedTitle);
    session = await controller.openSession({ windowId: selected.id });
    assert.equal(session.window.pid, fixture.pid);
    assert.equal(session.window.title, expectedTitle);
    return keep(await controller.observe({ sessionId: session.sessionId }));
  }
  async function blocked(id, prerequisite, actual) {
    Object.assign(plans.find((item) => item.id === id), { status: 'blocked', reason: prerequisite, actual });
    await persist();
  }

  await persist();
  try {
    await runCase('A3-BASELINE', { text: uiaText, count: 2, optionChecked: true, staleError: 'stale_observation', competitorError: 'desktop_busy' }, async () => {
      controller = await createMcpController(path.join(runDirectory, 'controller'), runDirectory);
      fixture = spawn(EXECUTABLE, ['--run-id', runId, '--receipt', receiptPath, '--commands', commandsPath], {
        cwd: ROOT, windowsHide: false, stdio: 'ignore',
      });
      fixture.on('error', (error) => { launchError = error; });
      const initial = await receiptWhere((receipt) => receipt.revision >= 1, 'fixture readiness');
      assert.equal(initial.text, '', 'New fixture contains unexpected text before input');
      assert.equal(initial.count, 0);
      assert.equal(initial.optionChecked, false);
      doctor = await controller.doctor();
      assert.equal(doctor.ready, true, `Computer engine unavailable: ${doctor.reason || doctor.code}`);
      await fs.writeFile(path.join(runDirectory, 'doctor.json'), JSON.stringify(doctor, null, 2) + '\n');
      window = await until(async () => (await controller.listWindows()).windows.find((item) => item.pid === fixture.pid && item.title === title), 'owned fixture window');
      session = await controller.openSession({ windowId: window.id });
      await keep(await controller.observe({ sessionId: session.sessionId }));
      await competitor.listWindows();
      await assert.rejects(competitor.openSession({ windowId: window.id }), (error) => error.code === 'desktop_busy');
      await act({ type: 'activate' });
      const activated = await receiptWhere(() => true, 'state after activation');
      assert.equal(activated.text, '', 'Activation changed fixture text');
      assert.equal(activated.count, 0, 'Activation changed fixture count');
      assert.equal(activated.optionChecked, false);
      await act({ type: 'click', elementId: target(current, 'TRACE text input').id });
      const focused = await receiptWhere(() => true, 'state before typing');
      assert.equal(focused.text, '', 'Unexpected text appeared before the typing action');
      assert.equal(focused.count, 0);
      const physicalText = `TRACE physical typing ${runId}`;
      await act({ type: 'type_text', text: physicalText });
      await receiptWhere((receipt) => receipt.text === physicalText, 'physical typing');
      await act({ type: 'set_value', elementId: target(current, 'TRACE text input').id, value: uiaText });
      await receiptWhere((receipt) => receipt.text === uiaText, 'UIA value');
      const stale = current;
      await act({ type: 'click', ...center(target(current, 'Increment counter').bounds, current.bounds) });
      await receiptWhere((receipt) => receipt.count === 1, 'coordinate click');
      await assert.rejects(controller.act({ sessionId: session.sessionId, observationId: stale.observationId,
        action: { type: 'invoke', elementId: target(stale, 'Increment counter').id } }), (error) => error.code === 'stale_observation');
      assert.equal((await receiptWhere(() => true, 'state after stale rejection')).count, 1);
      await act({ type: 'invoke', elementId: target(current, 'Increment counter').id });
      await receiptWhere((receipt) => receipt.count === 2, 'UIA invoke');
      await act({ type: 'click', elementId: target(current, 'Enable option').id });
      const receipt = await receiptWhere((state) => state.optionChecked && state.count === 2 && state.text === uiaText, 'baseline state');
      return { text: receipt.text, count: receipt.count, optionChecked: receipt.optionChecked, staleError: 'stale_observation', competitorError: 'desktop_busy' };
    });
    await runCase('A3-INPUT-KEY', { text: uiaText, selectedText: 'TRACE', selectionStart: 0, selectionLength: 5, modifiers: 'None' }, async () => {
      await act({ type: 'click', elementId: target(current, 'TRACE text input').id });
      await act({ type: 'press_key', key: 'ctrl+d' });
      const receipt = await receiptWhere((state) => state.chord === 'ctrl+d' && !state.controlPressed, 'released key chord');
      assertChord(receipt, uiaText);
      return { text: receipt.text, selectedText: receipt.selectedText, selectionStart: receipt.selectionStart, selectionLength: receipt.selectionLength, modifiers: receipt.modifiers };
    });
    for (const [id, initial, deltaY, expected] of [['A3-INPUT-SCROLL-DOWN', 0, 240, 96], ['A3-INPUT-SCROLL-UP', 96, -240, 0]]) {
      await runCase(id, { scrollY: expected, scrollRowOffset: expected }, async () => {
        const before = await receiptWhere(() => true, 'scroll baseline');
        assertScroll(before, initial);
        await act({ type: 'scroll', ...center(target(current, 'Scrollable fixture panel').bounds, current.bounds), deltaX: 0, deltaY });
        const receipt = await receiptWhere((state) => state.revision > before.revision, 'wheel receipt');
        assertScroll(receipt, expected);
        return { scrollY: receipt.scrollY, scrollRowOffset: receipt.scrollRowOffset };
      });
    }
    const dragBefore = await receiptWhere(() => true, 'drag baseline');
    const from = center(target(current, 'Draggable target').bounds, current.bounds);
    const to = { x: Math.min(current.bounds.width - 1, from.x + 90), y: Math.min(current.bounds.height - 1, from.y + 16) };
    const dragExpected = {
      x: Math.max(0, Math.min(dragBefore.dragAreaWidth - dragBefore.dragTargetWidth, dragBefore.dragX + to.x - from.x)),
      y: Math.max(0, Math.min(dragBefore.dragAreaHeight - dragBefore.dragTargetHeight, dragBefore.dragY + to.y - from.y)),
      drops: dragBefore.dragDrops + 1, starts: dragBefore.dragStarts + 1,
    };
    await runCase('A3-INPUT-DRAG', dragExpected, async () => {
      await act({ type: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
      const receipt = await receiptWhere((state) => state.dragDrops > dragBefore.dragDrops, 'drag release');
      assertDrag(receipt, dragExpected);
      return { x: receipt.dragX, y: receipt.dragY, drops: receipt.dragDrops, starts: receipt.dragStarts, dragPressed: receipt.dragPressed, leftButtonDown: receipt.leftButtonDown };
    });
    await runCase('A3-RECOVERY-PRIMITIVE-CANCEL', { released: true, alreadyReleased: false, x: dragExpected.x, y: dragExpected.y, drops: dragExpected.drops + 1, counter: 3 }, async () => {
      const baseline = await receiptWhere(() => true, 'held input baseline');
      const holdTarget = target(current, 'Draggable target');
      const holdPoint = `${Math.round(holdTarget.bounds.x + holdTarget.bounds.width / 2)},${Math.round(holdTarget.bounds.y + holdTarget.bounds.height / 2)}`;
      const holdAbort = new AbortController();
      // Handle rejection at launch, so even an immediate engine failure cannot escape cleanup.
      const held = runProcess(DEFAULT_BINARY, ['ui', 'drag', '--json', '-w', String(session.window.id), '--hold-ms', '4000', '--', holdPoint, holdPoint], {
        signal: holdAbort.signal, drainMs: 250, timeoutMs: 20_000,
        interruptionRecovery: async () => {
          const released = await runProcess(DEFAULT_BRIDGE, ['release-left'], { timeoutMs: 1500, maxOutputBytes: 1024 });
          const receipt = parseJson(released.stdout, released.stderr, released.exitCode);
          assert.equal(receipt.released, true);
          assert.equal(receipt.button, 'left');
          return { released: true, button: 'left', method: 'public-win32-sendinput', alreadyReleased: receipt.alreadyReleased === true };
        },
      }).then((value) => ({ value }), (error) => ({ error }));
      let interrupted;
      try {
        await receiptWhere((state) => state.dragPressed && state.leftButtonDown && state.dragStarts === baseline.dragStarts + 1, 'actual held left button');
        holdAbort.abort();
        interrupted = (await held).error;
        assert.equal(interrupted?.code, 'cancelled', 'Held input did not report cancellation');
        assert.equal(interrupted.details?.recovery?.released, true);
        assert.equal(interrupted.details?.recovery?.alreadyReleased, false);
      } finally {
        holdAbort.abort();
        await held;
      }
      const released = await receiptWhere((state) => !state.dragPressed && !state.leftButtonDown && state.dragDrops > baseline.dragDrops, 'fixture release after cancellation');
      assertDrag(released, { x: baseline.dragX, y: baseline.dragY, drops: baseline.dragDrops + 1, starts: baseline.dragStarts + 1 });
      await keep(await controller.observe({ sessionId: session.sessionId }));
      await act({ type: 'click', elementId: target(current, 'Increment counter').id });
      const after = await receiptWhere((state) => state.count === baseline.count + 1, 'click after primitive recovery');
      summary.interruption = { scope: 'Raw-native runProcess primitive; not MCP cancellation', released: true, alreadyReleased: false, ownedNativeExit: 'Confirmed by close before recovery callback' };
      return { released: true, alreadyReleased: false, x: released.dragX, y: released.dragY, drops: released.dragDrops, counter: after.count };
    });
    await runCase('A3-DIALOG', { parentEnabledWhileOpen: false, parentCountUnchanged: true, dialogConfirmed: true, parentEnabledAfterClose: true }, async () => {
      const before = await receiptWhere(() => true, 'pre-dialog count');
      const opening = await dispatch({ type: 'click', elementId: target(current, 'Open dialog').id });
      const opened = await receiptWhere((state) => state.dialogOpen && !state.parentEnabled, 'modal owner disabled');
      assert.equal(opened.count, before.count);
      assert.equal(opened.leftButtonDown, false);
      assert.equal(opened.modifiers, 'None');
      assert.equal(opening.error?.inputRecoveryRequired, undefined);
      await keep(opening.observation ?? await controller.observe({ sessionId: session.sessionId }));
      const disabled = current.elements.find((element) => element.name === 'Increment counter');
      assert.ok(disabled, 'Parent observation omitted the counter control');
      // Descendant UIA enabled flags need not reflect the native modal owner's disabled state.
      // Require an actual product rejection from a known pre-input guard instead.
      const parentGuard = await rejectedModalParentAction(() => dispatch({ type: 'click', elementId: disabled.id }));
      const blockedParent = await receiptWhere(() => true, 'state after disabled-parent rejection');
      assert.equal(blockedParent.count, before.count);
      assert.equal(blockedParent.parentEnabled, false);
      assert.equal(blockedParent.leftButtonDown, false);
      assert.equal(blockedParent.modifiers, 'None');
      await openOwnedWindow(dialogTitle);
      await act({ type: 'click', elementId: target(current, 'Confirm dialog').id });
      const confirmed = await receiptWhere((state) => state.dialogConfirmed && state.dialogOpen, 'modal confirmation');
      assert.equal(confirmed.parentEnabled, false);
      assert.equal(confirmed.count, before.count);
      await controller.closeSession({ sessionId: session.sessionId });
      session = undefined;
      await command('close-dialog', (state) => !state.dialogOpen && state.parentEnabled, 'modal close restores owner');
      await openOwnedWindow(title);
      const after = await receiptWhere(() => true, 'restored parent state');
      assert.equal(after.parentEnabled, true);
      assert.equal(after.count, before.count);
      return { parentEnabledWhileOpen: false, parentCountUnchanged: true, dialogConfirmed: confirmed.dialogConfirmed,
        parentEnabledAfterClose: after.parentEnabled, parentGuard,
        openingOutcome: opening.outcome, uncertaintyResolvedBy: 'Intended dialog visible, owner disabled, input released; no opening input replay' };
    });
    await runCase('A3-WINDOW-MOVE', { staleOutcome: 'unknown', staleError: 'window_moved', counterAdded: 1 }, async () => {
      const before = await receiptWhere(() => true, 'move baseline');
      const stale = current;
      await command('move', (state) => state.windowX !== before.windowX || state.windowY !== before.windowY, 'window moved');
      const rejected = await dispatch({ type: 'click', elementId: target(stale, 'Increment counter').id });
      assert.equal(rejected.outcome, 'unknown');
      assert.equal(rejected.error?.code, 'window_moved');
      assert.equal((await receiptWhere(() => true, 'count after moved rejection')).count, before.count);
      await keep(await controller.observe({ sessionId: session.sessionId }));
      assert.ok(current.bounds.x !== stale.bounds.x || current.bounds.y !== stale.bounds.y);
      await act({ type: 'click', elementId: target(current, 'Increment counter').id });
      const after = await receiptWhere((state) => state.count === before.count + 1, 'fresh click after move');
      return { staleOutcome: rejected.outcome, staleError: rejected.error.code, counterAdded: after.count - before.count };
    });
    await runCase('A3-WINDOW-MINIMIZE', { staleOutcome: 'unknown', staleError: 'window_moved', counterAdded: 1 }, async () => {
      const before = await receiptWhere(() => true, 'minimize baseline');
      await command('minimize', (state) => state.minimized, 'window minimized');
      const rejected = await dispatch({ type: 'click', elementId: target(current, 'Increment counter').id });
      assert.equal(rejected.outcome, 'unknown');
      assert.equal(rejected.error?.code, 'window_moved');
      assert.equal((await receiptWhere(() => true, 'count after minimized rejection')).count, before.count);
      await keep(await controller.observe({ sessionId: session.sessionId }));
      await receiptWhere((state) => !state.minimized, 'window restored by observation');
      await act({ type: 'click', elementId: target(current, 'Increment counter').id });
      const after = await receiptWhere((state) => state.count === before.count + 1, 'fresh click after restore');
      return { staleOutcome: rejected.outcome, staleError: rejected.error.code, counterAdded: after.count - before.count };
    });
    const displayBefore = await receiptWhere(() => true, 'display baseline');
    summary.geometry = { dpiX: displayBefore.dpiX, dpiY: displayBefore.dpiY, monitorCount: displayBefore.monitorCount,
      monitorName: displayBefore.monitorName, monitorBounds: { x: displayBefore.monitorX, y: displayBefore.monitorY, width: displayBefore.monitorWidth, height: displayBefore.monitorHeight } };
    assert.ok(Number.isInteger(displayBefore.dpiX) && displayBefore.dpiX >= 96);
    if (displayBefore.monitorCount > 1) {
      await runCase('A3-DISPLAY-MONITOR', { monitorChanged: true, counterAdded: 1 }, async () => {
        await command('move-monitor', (state) => state.monitorName !== displayBefore.monitorName, 'other monitor');
        await keep(await controller.observe({ sessionId: session.sessionId }));
        await act({ type: 'click', elementId: target(current, 'Increment counter').id });
        const after = await receiptWhere((state) => state.count === displayBefore.count + 1, 'click after monitor transition');
        return { monitorChanged: after.monitorName !== displayBefore.monitorName, counterAdded: after.count - displayBefore.count,
          beforeDpi: displayBefore.dpiX, afterDpi: after.dpiX, beforeMonitor: displayBefore.monitorName, afterMonitor: after.monitorName };
      });
      const monitorCase = plans.find((item) => item.id === 'A3-DISPLAY-MONITOR');
      if (monitorCase.actual.beforeDpi !== monitorCase.actual.afterDpi) {
        const dpiCase = plans.find((item) => item.id === 'A3-DISPLAY-DPI');
        Object.assign(dpiCase, { status: 'pass', actual: { twoDistinctDpiScales: true, counterAdded: 1, ...monitorCase.actual }, artifacts: monitorCase.artifacts });
        delete dpiCase.reason;
      } else await blocked('A3-DISPLAY-DPI', 'Needs a second physical DPI scale; the tested monitor transition retained the same DPI', monitorCase.actual);
    } else {
      await blocked('A3-DISPLAY-MONITOR', 'Needs at least two connected physical monitors; this host exposes one', summary.geometry);
      await blocked('A3-DISPLAY-DPI', 'Needs two physical DPI scales and a transition; this host exposes one monitor at the recorded DPI', summary.geometry);
    }
    await runCase('A3-LEASE-HANDOFF', { handoff: true }, async () => {
      await controller.closeSession({ sessionId: session.sessionId });
      session = undefined;
      competitorSession = await competitor.openSession({ windowId: window.id });
      await competitor.closeSession({ sessionId: competitorSession.sessionId });
      competitorSession = undefined;
      return { handoff: true };
    });
  } catch (error) { failure = error; }
  finally {
    const cleanup = plans.find((item) => item.id === 'A3-CLEANUP');
    cleanup.startedAt = new Date().toISOString();
    const outcomes = await Promise.allSettled([controller?.close(), competitor.close(), stopFixture(fixture)]);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed) {
      cleanup.status = 'fail';
      cleanup.actual = { error: cleanError(failed.reason) };
      failure ??= failed.reason;
    } else {
      cleanup.status = 'pass';
      cleanup.actual = { fixtureExited: !fixture || fixture.exitCode !== null || fixture.signalCode !== null, controllersClosed: true,
        serverExit: outcomes[0].value ?? { started: false } };
      delete cleanup.reason;
    }
    cleanup.finishedAt = new Date().toISOString();
    await stateArtifact(cleanup, 'after');
    const finalSources = await sourceHashes();
    summary.sourcesUnchangedDuringRun = JSON.stringify(finalSources) === JSON.stringify(testedSource.files);
    if (!summary.sourcesUnchangedDuringRun) failure ??= new Error('Relevant source changed during acceptance; evidence cannot establish a pinned result');
    await persist(true);
  }
  return summary;
}
async function main(args) {
  let live = false;
  let reportPath = DEFAULT_REPORT;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--live') live = true;
    else if (args[index] === '--build-only') live = false;
    else if (args[index] === '--report' && args[index + 1]) reportPath = path.resolve(ROOT, args[++index]);
    else throw new Error('Usage: node scripts/smoke-computer-live.cjs [--build-only | --live] [--report evidence/<path>.json]');
  }
  const relativeReport = path.relative(path.join(ROOT, 'evidence'), reportPath);
  assert.ok(relativeReport && !relativeReport.startsWith('..') && !path.isAbsolute(relativeReport) && reportPath.endsWith('.json'), 'A sanitized report must stay inside evidence/');
  await buildFixture();
  if (!live) {
    console.log(JSON.stringify({ result: 'built', executable: path.relative(ROOT, EXECUTABLE), uiLaunched: false }));
    return;
  }
  const summary = await runLive(reportPath);
  console.log(JSON.stringify({ result: summary.result, actions: summary.actions.length, frames: summary.frames.length, report: path.relative(ROOT, reportPath), rawEvidenceDirectory: summary.rawEvidenceDirectory }));
  if (summary.result !== 'passed') process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { buildFixture, main, assertScroll, assertChord, assertDrag, resultState, waitForOwnedProcessExit, rejectedModalParentAction, createMcpController, sourceHashes, stopFixture };
