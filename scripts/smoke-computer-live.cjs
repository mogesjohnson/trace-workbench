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
const DEFAULT_REPORT = path.join(ROOT, 'evidence', '0.1.0-alpha.3', 'computer-live.json');
const execFileAsync = promisify(execFile);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
    const killer = setTimeout(() => {
      const ownedPid = serverPid ?? transport.pid;
      if (ownedPid) {
        try { process.kill(ownedPid); }
        catch (error) { if (error.code !== 'ESRCH') closeError ??= error; }
      }
    }, 5_000);
    try {
      try { await client.close(); } catch (error) { closeError ??= error; }
      try { await transport.close(); } catch (error) { closeError ??= error; }
    }
    finally {
      clearTimeout(killer);
      await fs.writeFile(path.join(runDirectory, 'mcp-stderr.txt'), stderr);
    }
    if (closeError) throw closeError;
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
  // Lazy import keeps --build-only independent of the computer backend.
  const { createComputerController } = require('../src/computer/controller.cjs');
  const { runProcess, parseJson, DEFAULT_BINARY, DEFAULT_BRIDGE } = require('../src/computer/winapp-backend.cjs');
  const runId = `trace-${randomUUID()}`;
  const runDirectory = path.join(ROOT, '.runtime', 'computer-live', runId);
  const controllerDirectory = path.join(runDirectory, 'controller');
  const receiptPath = path.join(runDirectory, 'fixture-receipt.json');
  const commandsPath = path.join(runDirectory, 'commands.json');
  const title = `TRACE Computer Fixture — ${runId}`;
  const dialogTitle = `TRACE dialog — ${runId}`;
  await fs.mkdir(runDirectory, { recursive: true });
  const controller = await createMcpController(controllerDirectory, runDirectory);
  const competitor = createComputerController({ runtimeDirectory: path.join(runDirectory, 'competitor-controller') });
  const fixture = spawn(EXECUTABLE, ['--run-id', runId, '--receipt', receiptPath, '--commands', commandsPath], {
    // This is the explicitly requested interactive test window, not a helper.
    cwd: ROOT, windowsHide: false, stdio: 'ignore',
  });
  let launchError;
  fixture.on('error', (error) => { launchError = error; });
  const frames = [];
  const actions = [];
  let current;
  let session;
  let competitorSession;
  let finalReceipt;
  let doctor;
  let interruption;
  let geometry;

  async function receiptWhere(predicate, description) {
    return until(async () => {
      if (launchError) throw launchError;
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      assert.equal(receipt.runId, runId);
      assert.equal(receipt.title, title);
      return predicate(receipt) ? receipt : false;
    }, description);
  }

  async function keep(observation) {
    assert.equal(observation.sessionId, session.sessionId);
    assert.equal(observation.window.id, session.window.id);
    assert.equal(observation.window.pid, fixture.pid);
    assert.equal(observation.window.title, session.window.title);
    const bytes = screenshotBytes(observation.screenshot);
    const filename = `frame-${String(frames.length + 1).padStart(3, '0')}.${observation.screenshot.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    await fs.writeFile(path.join(runDirectory, filename), bytes);
    frames.push({
      filename, observationId: observation.observationId, bytes: bytes.length, sha256: sha256(bytes),
      width: observation.screenshot.width, height: observation.screenshot.height,
    });
    const { screenshot, ...metadata } = observation;
    await fs.writeFile(path.join(runDirectory, `${filename}.json`), JSON.stringify(metadata, null, 2) + '\n');
    current = observation;
    return observation;
  }

  async function act(action) {
    const prior = current.observationId;
    const result = await controller.act({ sessionId: session.sessionId, observationId: prior, action });
    assert.equal(result.outcome, 'completed', `Action ${action.type} did not complete; do not retry unknown outcomes`);
    assert.ok(result.observation, `Action ${action.type} returned no refreshed observation`);
    assert.notEqual(result.observation.observationId, prior, 'Action reused its consumed observation');
    actions.push({ type: action.type, actionId: result.actionId, observationId: prior, nextObservationId: result.observation.observationId });
    return keep(result.observation);
  }

  let commandId = 0;
  async function command(op, predicate, description) {
    commandId += 1;
    const id = commandId;
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
    const window = await until(async () => {
      const result = await controller.listWindows();
      return result.windows.find((item) => item.pid === fixture.pid && item.title === expectedTitle);
    }, expectedTitle);
    session = await controller.openSession({ windowId: window.id });
    assert.equal(session.window.pid, fixture.pid);
    assert.equal(session.window.title, expectedTitle);
    return keep(await controller.observe({ sessionId: session.sessionId }));
  }

  try {
    await receiptWhere((receipt) => receipt.revision >= 1, 'fixture readiness');
    doctor = await controller.doctor();
    await fs.writeFile(path.join(runDirectory, 'doctor.json'), JSON.stringify(doctor, null, 2) + '\n');
    assert.equal(doctor.ready, true, `Computer engine is unavailable: ${doctor.reason || doctor.code || 'doctor failed'}`);
    const window = await until(async () => {
      const result = await controller.listWindows();
      return result.windows.find((item) => item.pid === fixture.pid && item.title === title);
    }, 'owned fixture window');
    session = await controller.openSession({ windowId: window.id });
    assert.equal(session.window.pid, fixture.pid);
    assert.equal(session.window.title, title);
    await keep(await controller.observe({ sessionId: session.sessionId }));
    target(current, 'TRACE text input');
    target(current, 'Increment counter');
    target(current, 'Enable option');

    await competitor.listWindows();
    await assert.rejects(
      competitor.openSession({ windowId: window.id }),
      (error) => error.code === 'desktop_busy',
      'A second controller should not acquire the occupied desktop lease',
    );

    await act({ type: 'activate' });
    await act({ type: 'click', elementId: target(current, 'TRACE text input').id });
    const physicalText = `TRACE physical typing ${runId}`;
    await act({ type: 'type_text', text: physicalText });
    await receiptWhere((receipt) => receipt.text === physicalText, 'physical typing receipt');

    const uiaText = `TRACE accessibility value ${runId}`;
    await act({ type: 'set_value', elementId: target(current, 'TRACE text input').id, value: uiaText });
    await receiptWhere((receipt) => receipt.text === uiaText, 'UIA value receipt');

    const stale = current;
    const increment = target(current, 'Increment counter');
    await act({ type: 'click', ...center(increment.bounds, current.bounds) });
    await receiptWhere((receipt) => receipt.count === 1, 'physical button click receipt');
    await assert.rejects(
      controller.act({ sessionId: session.sessionId, observationId: stale.observationId, action: { type: 'invoke', elementId: target(stale, 'Increment counter').id } }),
      (error) => error.code === 'stale_observation',
      'A consumed observation should not authorize another input',
    );
    assert.equal((await receiptWhere(() => true, 'receipt after stale rejection')).count, 1);

    await act({ type: 'invoke', elementId: target(current, 'Increment counter').id });
    await receiptWhere((receipt) => receipt.count === 2, 'UIA invoke receipt');
    await act({ type: 'click', elementId: target(current, 'Enable option').id });
    await receiptWhere((receipt) => receipt.optionChecked && receipt.count === 2 && receipt.text === uiaText, 'checkbox fixture state');

    await act({ type: 'click', elementId: target(current, 'TRACE text input').id });
    await act({ type: 'press_key', key: 'ctrl+d' });
    await receiptWhere((receipt) => receipt.chord === 'ctrl+d' && receipt.text === uiaText, 'key chord receipt');

    const scrollBefore = await receiptWhere(() => true, 'scroll baseline');
    const panel = target(current, 'Scrollable fixture panel');
    await act({ type: 'scroll', ...center(panel.bounds, current.bounds), deltaX: 0, deltaY: 240 });
    await receiptWhere((receipt) => receipt.scrollY >= scrollBefore.scrollY + 48, 'vertical scroll receipt');

    const dragBefore = await receiptWhere(() => true, 'drag baseline');
    const dragTarget = target(current, 'Draggable target');
    const from = center(dragTarget.bounds, current.bounds);
    const to = {
      x: Math.min(current.bounds.width - 1, from.x + 90),
      y: Math.min(current.bounds.height - 1, from.y + 16),
    };
    assert.ok(to.x > from.x, 'Drag destination must move within the observed window');
    await act({ type: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
    const dragAfter = await receiptWhere((receipt) => receipt.dragX >= dragBefore.dragX + 50, 'drag receipt');

    const holdTarget = target(current, 'Draggable target');
    assert.ok(holdTarget.bounds, 'Drag target has no physical bounds for the interrupted hold');
    const holdX = Math.round(holdTarget.bounds.x + holdTarget.bounds.width / 2);
    const holdY = Math.round(holdTarget.bounds.y + holdTarget.bounds.height / 2);
    const holdAbort = new AbortController();
    const held = runProcess(DEFAULT_BINARY, [
      'ui', 'drag', '--json', '-w', String(session.window.id), '--hold-ms', '4000', '--', `${holdX},${holdY}`, `${holdX},${holdY}`,
    ], {
      signal: holdAbort.signal, drainMs: 250, timeoutMs: 20_000,
      interruptionRecovery: async () => {
        const released = await runProcess(DEFAULT_BRIDGE, ['release-left'], { timeoutMs: 1500, maxOutputBytes: 1024 });
        const receipt = parseJson(released.stdout, released.stderr, released.exitCode);
        assert.equal(receipt.released, true, 'Bridge did not confirm the left-button release');
        assert.equal(receipt.button, 'left');
        return { released: true, button: 'left', method: 'public-win32-sendinput', alreadyReleased: receipt.alreadyReleased === true };
      },
    });
    await delay(1500);
    holdAbort.abort();
    const interrupted = await held.then(() => { throw new Error('The held drag finished before interruption'); }, (error) => error);
    assert.equal(interrupted.code, 'cancelled', interrupted.message);
    assert.equal(interrupted.details?.recovery?.released, true);
    assert.equal(interrupted.details?.recovery?.alreadyReleased, false, 'The left button was not down during the held drag');
    const holdAfter = await receiptWhere(() => true, 'position after interrupted hold');
    assert.ok(Math.abs(holdAfter.dragX - dragAfter.dragX) <= 8 && Math.abs(holdAfter.dragY - dragAfter.dragY) <= 8, 'The interrupted hold moved the drag target');
    interruption = { released: true, button: 'left', method: 'public-win32-sendinput', alreadyReleased: false };
    await keep(await controller.observe({ sessionId: session.sessionId }));
    await act({ type: 'click', elementId: target(current, 'Increment counter').id });
    await receiptWhere((receipt) => receipt.count === dragAfter.count + 1, 'click after interrupted hold');

    await act({ type: 'click', elementId: target(current, 'Open dialog').id });
    await receiptWhere((receipt) => receipt.dialogOpen === true, 'dialog opened');
    await openOwnedWindow(dialogTitle);
    target(current, 'Confirm dialog');
    await act({ type: 'click', elementId: target(current, 'Confirm dialog').id });
    await receiptWhere((receipt) => receipt.dialogConfirmed === true && receipt.dialogOpen === true, 'dialog confirmed');
    await controller.closeSession({ sessionId: session.sessionId });
    session = undefined;
    await command('close-dialog', (receipt) => receipt.dialogOpen === false, 'dialog closed');
    await openOwnedWindow(title);

    const origin = await receiptWhere(() => true, 'window origin');
    const staleMove = current;
    await command('move', (receipt) => receipt.windowX !== origin.windowX || receipt.windowY !== origin.windowY, 'window moved');
    await delay(300);
    const rejectedMove = await controller.act({
      sessionId: session.sessionId, observationId: staleMove.observationId,
      action: { type: 'click', elementId: target(staleMove, 'Increment counter').id },
    });
    assert.equal(rejectedMove.outcome, 'unknown');
    assert.equal(rejectedMove.error?.code, 'window_moved');
    assert.equal((await receiptWhere(() => true, 'count after rejected move')).count, origin.count);
    await keep(await controller.observe({ sessionId: session.sessionId }));
    assert.ok(current.bounds.x !== staleMove.bounds.x || current.bounds.y !== staleMove.bounds.y, 'Fresh observation kept the pre-move capture origin');
    await act({ type: 'click', elementId: target(current, 'Increment counter').id });
    const moved = await receiptWhere((receipt) => receipt.count === origin.count + 1, 'click after the window moved');

    const staleMinimize = current;
    await command('minimize', (receipt) => receipt.minimized === true, 'window minimized');
    const rejectedMinimize = await controller.act({
      sessionId: session.sessionId, observationId: staleMinimize.observationId,
      action: { type: 'click', elementId: target(staleMinimize, 'Increment counter').id },
    });
    assert.equal(rejectedMinimize.outcome, 'unknown');
    assert.equal(rejectedMinimize.error?.code, 'window_moved');
    assert.equal((await receiptWhere(() => true, 'count after rejected minimize')).count, moved.count);
    await keep(await controller.observe({ sessionId: session.sessionId }));
    const restored = await receiptWhere((receipt) => receipt.minimized === false, 'observation restored the minimized window');
    await act({ type: 'click', elementId: target(current, 'Increment counter').id });
    const afterRestore = await receiptWhere((receipt) => receipt.count === restored.count + 1, 'click after restore');

    let monitorChange = 'not_available_single_display';
    let dpiChange = 'not_available_single_dpi';
    if (afterRestore.monitorCount > 1) {
      const monitorBefore = afterRestore.monitorName;
      const dpiBefore = afterRestore.dpiX;
      await command('move-monitor', (receipt) => receipt.monitorName !== monitorBefore, 'window moved to another monitor');
      await delay(300);
      await keep(await controller.observe({ sessionId: session.sessionId }));
      await act({ type: 'click', elementId: target(current, 'Increment counter').id });
      const relocated = await receiptWhere((receipt) => receipt.count === afterRestore.count + 1, 'click after monitor change');
      monitorChange = 'verified';
      if (relocated.dpiX !== dpiBefore) dpiChange = 'verified';
      finalReceipt = relocated;
    } else {
      finalReceipt = afterRestore;
    }
    geometry = {
      dpiX: finalReceipt.dpiX, dpiY: finalReceipt.dpiY, monitorCount: finalReceipt.monitorCount,
      monitorName: finalReceipt.monitorName,
      monitorBounds: { x: finalReceipt.monitorX, y: finalReceipt.monitorY, width: finalReceipt.monitorWidth, height: finalReceipt.monitorHeight },
      window: { x: finalReceipt.windowX, y: finalReceipt.windowY, width: finalReceipt.windowWidth, height: finalReceipt.windowHeight },
      monitorChange, dpiChange,
    };
    assert.ok(Number.isInteger(geometry.dpiX) && geometry.dpiX >= 96, 'Fixture did not report a usable monitor DPI');
    assert.equal(geometry.dpiX, geometry.dpiY);

    await controller.closeSession({ sessionId: session.sessionId });
    session = undefined;
    competitorSession = await competitor.openSession({ windowId: window.id });
    await competitor.closeSession({ sessionId: competitorSession.sessionId });
    competitorSession = undefined;
  } finally {
    if (session) await controller.closeSession({ sessionId: session.sessionId }).catch(() => {});
    if (competitorSession) await competitor.closeSession({ sessionId: competitorSession.sessionId }).catch(() => {});
    const cleanup = await Promise.allSettled([controller.close(), competitor.close()]);
    await stopFixture(fixture);
    const failedCleanup = cleanup.find((result) => result.status === 'rejected');
    if (failedCleanup) throw failedCleanup.reason;
  }

  const sources = [];
  for (const filename of ['TraceComputerFixture.csproj', 'Program.cs']) {
    const bytes = await fs.readFile(path.join(path.dirname(PROJECT), filename));
    sources.push({ path: `tests/fixtures/computer-app/${filename}`, sha256: sha256(bytes) });
  }
  const summary = {
    schemaVersion: 1, result: 'passed', observedAt: new Date().toISOString(), platform: 'win32', runId,
    engine: { name: doctor.engine, version: doctor.version, integrity: doctor.integrity },
    protocol: controller.protocol,
    target: 'Owned WinForms desktop fixture', fixtureSources: sources,
    fixtureExecutableSha256: sha256(await fs.readFile(EXECUTABLE)),
    checks: {
      physicalTyping: true, accessibilityValue: true, coordinateClick: true,
      accessibilityInvoke: true, checkboxClick: true, keyChord: true, verticalScroll: true, drag: true,
      physicalInterruptionReleased: interruption.released === true, inputAfterInterruption: true,
      dialogConfirmed: true, movedWindowRejected: true, movedWindowRetargeted: true,
      minimizedWindowRejected: true, minimizedWindowRestored: true,
      dpiRecorded: true, monitorChange: geometry.monitorChange, dpiChange: geometry.dpiChange,
      freshObservationAfterEveryAction: true,
      staleObservationRejected: true, competingControllerRejected: true, crossProcessDesktopLease: true,
      leaseSharedAcrossDifferentArtifactDirectories: true,
      leaseReleasedForNextController: true, screenshotsReturnedOnceAsMcpImage: true,
      fixtureClosed: true,
    },
    interruption, geometry,
    finalState: {
      text: finalReceipt.text, count: finalReceipt.count, optionChecked: finalReceipt.optionChecked,
      chord: finalReceipt.chord, scrollY: finalReceipt.scrollY, dragX: finalReceipt.dragX, dragY: finalReceipt.dragY,
      dialogConfirmed: finalReceipt.dialogConfirmed, revision: finalReceipt.revision,
    },
    actions, frames,
    rawEvidenceDirectory: path.relative(ROOT, runDirectory).replaceAll(path.sep, '/'),
    limits: [
      'Only the owned synthetic fixture was controlled. This does not establish compatibility with every Windows application.',
      geometry.monitorChange === 'verified'
        ? 'The owned window was moved to another monitor on this host and a later click still hit it.'
        : 'This host had one display, so a second-monitor relocation was not available.',
      geometry.dpiChange === 'verified'
        ? 'The owned window changed DPI when it changed monitors.'
        : `Monitor DPI was recorded at ${geometry.dpiX}. This host did not present a DPI change.`,
      'Secure desktop, elevated applications, and a live model-host session were not tested.',
    ],
  };
  const frameDirectory = path.join(path.dirname(reportPath), 'frames');
  await fs.mkdir(frameDirectory, { recursive: true });
  for (const frame of frames) await fs.copyFile(path.join(runDirectory, frame.filename), path.join(frameDirectory, frame.filename));
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(summary, null, 2) + '\n');
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
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { buildFixture, main };
