'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WinappBackend, BackendError, runProcess, parseJson, pngSize, pin } = require('../src/computer/winapp-backend.cjs');
const { plan, main } = require('../scripts/setup-computer.cjs');

const rect = { x: 100, y: 200, width: 300, height: 400 };
const window = { id: '1234', pid: 456, processName: 'TraceFixture', title: 'TRACE fixture', bounds: rect };
const element = { selector: 'calculate', name: 'Calculate', type: 'Button', isEnabled: true, isOffscreen: false, x: 140, y: 260, width: 80, height: 30 };
const root = () => ({ selector: 'win-tracefixture-a1b2', name: 'TRACE fixture', type: 'Window', isEnabled: true, ...rect, children: [{ ...element }] });
const inspect = () => ({ windows: [{ hwnd: 1234, coordinateSpace: 'physical-screen-pixels', elements: [root()] }] });
const status = () => ({ hwnd: 1234, processId: 456, processName: 'TraceFixture', windowTitle: 'TRACE fixture', coordinateSpace: 'physical-screen-pixels' });
const canonical = () => ({ window: { ...window }, bounds: { ...rect }, uiaBounds: { ...rect }, frameBounds: { ...rect }, nativeWindowBounds: { ...rect }, focused: { available: true, hasFocus: true, elementId: 'calculate' }, rootSelector: root().selector, elements: [
  { id: root().selector, name: 'TRACE fixture', controlType: 'Window', enabled: true, offscreen: false, bounds: { ...rect } },
  { id: element.selector, name: element.name, controlType: element.type, enabled: true, offscreen: false, bounds: { x: 140, y: 260, width: 80, height: 30 } }
] });
const json = data => ({ stdout: JSON.stringify(data), stderr: '', exitCode: 0 });
function mock(handler) {
  const calls = [];
  const backend = new WinappBackend({ platform: 'win32', arch: 'x64', verify: async () => {}, verifyBridge: async () => {}, verifyIndicator: async () => ({ available: true, integrity: 'verified', protocol: 1 }), run: async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args[0] === '--list-runtimes') return { stdout: 'Microsoft.WindowsDesktop.App 9.0.10 [synthetic-runtime]\n', stderr: '', exitCode: 0 };
    if (args[0] === '--version') return { stdout: pin.version + '\n', stderr: '', exitCode: 0 };
    if (handler) {
      const override = await handler(args, calls);
      if (override !== undefined) return json(override);
    }
    if (args[0] === 'info') return json({ version: 1 });
    if (args[0] === 'identities') return json({ windows: args.slice(1).map(pair => { const [hwnd, pid] = pair.split(':'); return { hwnd, pid: Number(pid) }; }) });
    if (args[0] === 'identity' || args[0] === 'bounds' || args[0] === 'activate') return json({ hwnd: '1234', pid: 456, frameBounds: { ...rect }, windowBounds: { ...rect }, foreground: true, minimized: false });
    if (args[1] === 'status') return json(status());
    if (args[1] === 'inspect') return json(inspect());
    if (args[1] === 'get-focused') return json({ hasFocus: true, element: { selector: 'calculate', name: 'Calculate', type: 'Button' } });
    return json({ hwnd: 1234 });
  } });
  return { backend, calls };
}
function fakePng(width = 300, height = 400) {
  const result = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(result);
  result.write('IHDR', 12, 'ascii'); result.writeUInt32BE(width, 16); result.writeUInt32BE(height, 20);
  return result;
}

test('doctor checks actual integrity and version; unsupported host remains unavailable', async () => {
  const { backend } = mock();
  assert.equal((await backend.doctor()).ready, true);
  assert.equal((await new WinappBackend({ platform: 'linux' }).doctor()).ready, false);
  const bad = new WinappBackend({ platform: 'win32', arch: 'x64', verify: async () => { throw new BackendError('engine_integrity', 'Changed.'); } });
  assert.equal((await bad.doctor()).code, 'engine_integrity');
});

test('doctor verifies activity source/output manifest without launching visible UI', async () => {
  const { backend, calls } = mock();
  let markerChecks = 0;
  backend.verifyIndicator = async binaryPath => {
    markerChecks++;
    assert.equal(binaryPath, backend.indicatorPath);
    return { available: true, integrity: 'verified', protocol: 1 };
  };
  const result = await backend.doctor();
  assert.deepEqual(result.activityIndicator, { available: true, integrity: 'verified', protocol: 1 });
  assert.equal(markerChecks, 1);
  assert.ok(calls.every(call => call.executable !== backend.indicatorPath));
});

for (const code of ['indicator_unavailable', 'indicator_stale', 'indicator_integrity'])
test(`doctor reports ${code} honestly while window discovery remains available`, async () => {
  const { backend, calls } = mock(args => args[1] === 'list-windows' ? [{ hwnd: 1234, processId: 456, processName: 'TraceFixture', width: 300, height: 400 }] : undefined);
  backend.verifyIndicator = async () => { throw Object.assign(new Error('Marker unavailable.'), { code }); };
  const result = await backend.doctor();
  assert.equal(result.ready, false);
  assert.equal(result.code, code);
  assert.equal(calls.length, 0);
  assert.equal((await backend.listWindows()).length, 1);
  assert.ok(calls.every(call => call.executable !== backend.indicatorPath));
});

test('doctor refuses to claim a marker is usable when the .NET Desktop runtime is missing', async () => {
  const { backend } = mock();
  const run = backend.run;
  backend.run = (executable, args, options) => args[0] === '--list-runtimes'
    ? Promise.resolve({ stdout: 'Microsoft.NETCore.App 9.0.10 [synthetic-runtime]\n', stderr: '', exitCode: 0 })
    : run(executable, args, options);
  const result = await backend.doctor();
  assert.equal(result.ready, false);
  assert.equal(result.code, 'indicator_runtime');
});

test('discovery preserves PID and dimensions without inventing unknown x/y', async () => {
  const { backend } = mock(args => args[1] === 'list-windows' ? [{ hwnd: 1234, processId: 456, processName: 'TraceFixture', title: 'TRACE fixture', width: 300, height: 400 }] : undefined);
  assert.deepEqual(await backend.listWindows(), [{ ...window, bounds: { x: null, y: null, width: 300, height: 400 } }]);
});

test('discovery reads owner and creation identity without requiring capturable window geometry', async () => {
  const { backend, calls } = mock(args => {
    if (args[1] === 'list-windows') return [{ hwnd: 1234, processId: 456, processName: 'TraceFixture', width: 0, height: 0 }];
    if (args[0] === 'identities') return { windows: [{ hwnd: '1234', pid: 456, processCreationTime: '123456789012345678', sessionId: 2, ownerWindowId: '1000' }] };
    if (args[0] === 'bounds') throw new BackendError('invalid_bounds', 'Not capturable.');
  });
  const result = await backend.listWindows();
  assert.equal(result[0].ownerWindowId, '1000');
  assert.equal(result[0].processCreationTime, '123456789012345678');
  assert.ok(calls.every(call => call.args[0] !== 'bounds'));
});

test('window identities use one bounded batch and reject substituted or duplicate targets', async () => {
  const nativeWindows = Array.from({ length: 101 }, (_, i) => ({ hwnd: 1000 + i, processId: 2000 + i, processName: 'Fixture', width: 10, height: 20 }));
  const { backend, calls } = mock(args => args[1] === 'list-windows' ? nativeWindows : undefined);
  assert.equal((await backend.listWindows()).length, 101);
  assert.equal(calls.filter(call => call.args[0] === 'identities').length, 2);
  assert.ok(calls.filter(call => call.args[0] === 'identities').every(call => call.args.length <= 101));
  const bad = mock(args => args[1] === 'list-windows' ? [nativeWindows[0]] : args[0] === 'identities' ? { windows: [{ hwnd: '999', pid: 2000 }] } : undefined);
  await assert.rejects(bad.backend.listWindows(), { code: 'window_identity_changed' });
});

test('focus binds transient selectors by unique AutomationId, exact bounds and control metadata', async () => {
  const { backend } = mock(args => args[1] === 'get-focused' ? { hasFocus: true, element: { selector: 'txt-transient-1234', automationId: 'input', name: 'Report', type: 'Edit', className: 'NativeEdit', x: 10, y: 20, width: 30, height: 40 } } : undefined);
  const edit = { id: 'input', automationId: 'input', name: 'Report', controlType: 'Edit', className: 'NativeEdit', bounds: { x: 10, y: 20, width: 30, height: 40 } };
  const focused = await backend.focused(window, undefined, [edit]);
  assert.equal(focused.elementId, 'input');
  assert.equal(focused.nativeSelector, 'txt-transient-1234');
  assert.equal(focused.binding, 'observed-control');
  assert.equal((await backend.focused(window, undefined, [edit, { ...edit, id: 'duplicate' }])).elementId, null);
  assert.equal((await backend.focused(window, undefined, [{ ...edit, automationId: 'different' }])).elementId, null);
  assert.equal((await backend.focused(window, undefined, [{ ...edit, bounds: { ...edit.bounds, x: 11 } }])).elementId, null);
});

test('observation pins HWND/PID, selects one root, derives PNG dimensions and revalidates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-backend-'));
  const screenshotPath = path.join(dir, 'frame.png');
  try {
    const { backend, calls } = mock(async args => {
      if (args[1] !== 'screenshot') return;
      await fs.writeFile(screenshotPath, fakePng());
      return { hwnd: 1234, processId: 456, filePath: screenshotPath, width: 300, height: 400 };
    });
    const result = await backend.observe({ window, screenshotPath });
    assert.deepEqual(result.bounds, rect);
    assert.deepEqual(result.screenshot, { path: screenshotPath, mimeType: 'image/png', width: 300, height: 400 });
    assert.equal(result.elements[1].id, 'calculate');
    assert.equal(result.captureMethod, 'window-capture-dwm-bounds');
    const captureArgs = calls.find(call => call.args[1] === 'screenshot').args;
    assert.deepEqual(captureArgs.slice(-2), ['--', root().selector]);
    assert.equal(captureArgs.includes('--capture-screen'), false);
    assert.equal(calls.filter(call => call.args[1] === 'status').length, 3);
  } finally {
    // Remove only files in the owned, checked temporary directory; no recursive deletion.
    assert.equal(path.dirname(screenshotPath), dir);
    await fs.unlink(screenshotPath).catch(() => {}); await fs.rmdir(dir);
  }
});

test('observation rejects mismatched screenshot identity before consuming pixels', async () => {
  const { backend } = mock(args => args[1] === 'screenshot' ? { hwnd: 5555, processId: 456, filePath: path.resolve('frame.png'), width: 300, height: 400 } : undefined);
  await assert.rejects(backend.observe({ window, screenshotPath: path.resolve('frame.png') }), { code: 'invalid_screenshot' });
});

test('observation refuses ambiguous WGC-style dimensions rather than scaling coordinates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-backend-'));
  const screenshotPath = path.join(dir, 'frame.png');
  try {
    const { backend } = mock(async args => {
      if (args[1] !== 'screenshot') return;
      await fs.writeFile(screenshotPath, fakePng(282, 391));
      return { hwnd: 1234, processId: 456, filePath: screenshotPath, width: 282, height: 391 };
    });
    await assert.rejects(backend.observe({ window, screenshotPath }), { code: 'coordinate_space' });
  } finally { await fs.unlink(screenshotPath).catch(() => {}); await fs.rmdir(dir); }
});

test('reused window handle cannot reach mutation', async () => {
  const { backend, calls } = mock(args => args[1] === 'status' ? { ...status(), processId: 999 } : undefined);
  await assert.rejects(backend.act({ window, observation: canonical(), action: { type: 'click', elementId: 'calculate' } }), { code: 'window_identity_changed' });
  assert.equal(calls.some(call => call.args[1] === 'click'), false);
});

test('moved window and replaced element cannot reach mutation', async () => {
  const { backend, calls } = mock(args => {
    if (args[1] === 'inspect') { const result = inspect(); result.windows[0].elements[0].x++; return result; }
  });
  await assert.rejects(backend.act({ window, observation: canonical(), action: { type: 'click', x: 50, y: 70 } }), { code: 'window_moved' });
  assert.equal(calls.some(call => call.args[1] === 'drag'), false);
  const other = mock(args => {
    if (args[1] === 'inspect') { const result = inspect(); result.windows[0].elements[0].children[0].name = 'New control'; return result; }
  });
  await assert.rejects(other.backend.act({ window, observation: canonical(), action: { type: 'invoke', elementId: 'calculate' } }), { code: 'stale_element' });
});

test('activation uses only the pinned source-owned public Win32 bridge', async () => {
  const { backend, calls } = mock();
  const result = await backend.act({ window, observation: canonical(), action: { type: 'activate' } });
  assert.equal(result.performed, true);
  assert.deepEqual(calls.at(-1).args, ['activate', '1234', '456']);
});

test('bridge PID mismatch and frame movement fail before native input', async () => {
  const otherPid = mock(args => args[0] === 'bounds' ? { hwnd: '1234', pid: 999 } : undefined);
  await assert.rejects(otherPid.backend.act({ window, observation: canonical(), action: { type: 'click', x: 50, y: 70 } }), { code: 'window_identity_changed' });
  const movedFrame = mock(args => args[0] === 'bounds' ? { hwnd: '1234', pid: 456, frameBounds: { ...rect, x: 109, width: 282 }, windowBounds: rect } : undefined);
  await assert.rejects(movedFrame.backend.act({ window, observation: canonical(), action: { type: 'click', x: 50, y: 70 } }), { code: 'window_moved' });
});

for (const action of [
  { type: 'click', elementId: 'calculate' },
  { type: 'invoke', elementId: 'calculate' },
  { type: 'set_value', elementId: 'calculate', value: 'must not change' },
]) test(`disabled native owner blocks ${action.type} even when UIA reports an enabled descendant`, async () => {
  const { backend, calls } = mock(args => args[0] === 'bounds' ? {
    hwnd: '1234', pid: 456, frameBounds: rect, windowBounds: rect, enabled: false, minimized: false,
  } : undefined);
  await assert.rejects(backend.act({ window, observation: canonical(), action }), (error) => error.code === 'window_blocked' && error.details.outcome === 'not_dispatched');
  assert.equal(calls.some(call => call.args[0] === 'activate'), false, 'A disabled owner must not reach foreground mutation');
  assert.equal(calls.some(call => ['click', 'drag', 'invoke', 'set-value', 'send-keys', 'scroll'].includes(call.args[1])), false, 'Disabled-owner validation must prevent the mutating native command');
});

for (const action of [{ type: 'click', elementId: 'calculate' }, { type: 'invoke', elementId: 'calculate' }, { type: 'activate' }])
test(`late native disabling blocks ${action.type} even if activation reports foreground`, async () => {
  const { backend, calls } = mock(args => args[0] === 'activate' ? {
    hwnd: '1234', pid: 456, frameBounds: rect, windowBounds: rect, enabled: false, foreground: true, minimized: false,
  } : undefined);
  await assert.rejects(backend.act({ window, observation: canonical(), action }), { code: 'window_blocked' });
  assert.equal(calls.some(call => ['click', 'drag', 'invoke', 'set-value', 'send-keys', 'scroll'].includes(call.args[1])), false);
});

test('a UIA value cannot dispatch if the owner becomes disabled after initial validation', async () => {
  let reads = 0;
  const { backend, calls } = mock(args => args[0] === 'bounds' ? {
    hwnd: '1234', pid: 456, frameBounds: rect, windowBounds: rect, enabled: ++reads === 1, minimized: false,
  } : undefined);
  await assert.rejects(backend.act({ window, observation: canonical(), action: { type: 'set_value', elementId: 'calculate', value: 'must not change' } }), { code: 'window_blocked' });
  assert.equal(reads, 2);
  assert.equal(calls.some(call => call.args[1] === 'set-value'), false);
});

test('coordinate input uses exact DWM capture origin rather than invisible UIA resize borders', async () => {
  const frame = { x: 109, y: 200, width: 282, height: 391 };
  const { backend, calls } = mock(args => ['bounds', 'activate'].includes(args[0]) ? { hwnd: '1234', pid: 456, frameBounds: frame, windowBounds: rect, foreground: true, minimized: false } : undefined);
  const observation = canonical();
  observation.bounds = frame; observation.window.bounds = frame; observation.frameBounds = frame;
  await backend.act({ window, observation, action: { type: 'click', x: 50, y: 70 } });
  assert.deepEqual(calls.at(-1).args.slice(-2), ['159,270', '159,270']);
});

test('keyboard dispatch requires focus in exact selected window and unchanged focused element', async () => {
  const noFocus = mock(args => args[1] === 'get-focused' ? { hasFocus: false } : undefined);
  await assert.rejects(noFocus.backend.act({ window, observation: canonical(), action: { type: 'type_text', text: 'hello' } }), { code: 'focus_not_acquired' });
  const changed = mock(args => args[1] === 'get-focused' ? { hasFocus: true, element: { selector: 'other-control' } } : undefined);
  await assert.rejects(changed.backend.act({ window, observation: canonical(), action: { type: 'press_key', key: 'enter' } }), { code: 'focus_changed' });
});

for (const [action, verb, expectedTail] of [
  [{ type: 'click', elementId: 'calculate' }, 'click', ['calculate']],
  [{ type: 'click', x: 50, y: 70 }, 'drag', ['150,270', '150,270']],
  [{ type: 'type_text', text: '--help $() `hello` ctrl+a' }, 'send-keys', ['--help $() `hello` ctrl+a']],
  [{ type: 'press_key', key: 'ctrl+a' }, 'send-keys', ['ctrl+a']],
  [{ type: 'press_key', key: 'CONTROL+RETURN' }, 'send-keys', ['ctrl+enter']],
  [{ type: 'drag', fromX: 50, fromY: 70, toX: 150, toY: 150 }, 'drag', ['150,270', '250,350']],
  [{ type: 'scroll', x: 50, y: 70, deltaX: 0, deltaY: 240 }, 'scroll', ['calculate']],
  [{ type: 'invoke', elementId: 'calculate' }, 'invoke', ['calculate']],
  [{ type: 'set_value', elementId: 'calculate', value: '--help $()' }, 'set-value', ['calculate', '--help $()']]
]) test(`${action.type} maps typed arguments to pinned native verb ${verb}`, async () => {
  const { backend, calls } = mock();
  const result = await backend.act({ window, observation: canonical(), action });
  assert.equal(result.performed, true);
  const call = calls.at(-1);
  assert.equal(call.args[1], verb);
  assert.deepEqual(call.args.slice(call.args.indexOf('--') + 1), expectedTail);
  assert.equal(call.args[call.args.indexOf('-w') + 1], '1234');
  assert.ok(calls.some(call => call.args[1] === 'status'));
});

test('wheel transport reports actual element-center placement and rejects horizontal/non-notch scroll', async () => {
  const { backend, calls } = mock();
  const result = await backend.act({ window, observation: canonical(), action: { type: 'scroll', x: 50, y: 70, deltaX: 0, deltaY: 240 } });
  assert.equal(result.transport, 'wheel-at-element-center');
  assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('--wheel') + 1], '-2');
  for (const delta of [{ deltaX: 1, deltaY: 120 }, { deltaX: 0, deltaY: 2 }]) {
    await assert.rejects(backend.act({ window, observation: canonical(), action: { type: 'scroll', x: 50, y: 70, ...delta } }), { code: 'unsupported_action' });
  }
});

test('unobserved elements, bad coordinates, multi-key scripts and NUL text reject', async () => {
  const { backend } = mock();
  for (const [action, code] of [
    [{ type: 'invoke', elementId: '--help' }, 'stale_element'],
    [{ type: 'click', x: 999, y: 270 }, 'invalid_coordinates'],
    [{ type: 'press_key', key: 'ctrl+a enter' }, 'invalid_action'],
    [{ type: 'type_text', text: '\0' }, 'invalid_action'],
    [{ type: 'launch_shell', command: 'cmd' }, 'unsupported_action']
  ]) await assert.rejects(backend.act({ window, observation: canonical(), action }), { code });
});

test('native JSON errors preserve code and structured error without printing private raw output', () => {
  assert.throws(() => parseJson('', '{"error":{"code":"foreground_not_target","message":"Refused.","target":"1234"}}', 1), error => error.code === 'foreground_not_target' && error.details.native.target === '1234');
  assert.throws(() => parseJson('private non-json output', '', 0), { code: 'invalid_native_response' });
  assert.throws(() => pngSize(Buffer.from('not PNG')), { code: 'invalid_screenshot' });
});

function fakeSpawn({ neverEnds = false, output } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 9876;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
    calls.push({ child, file, args, options });
    if (!neverEnds) setImmediate(() => { if (output) child.stdout.write(output); child.emit('close', 0, null); });
    return child;
  };
  return { spawnImpl, calls };
}

test('spawn uses no shell, hides windows and overrides inherited workflow/telemetry', async () => {
  const fake = fakeSpawn({ output: 'ok' });
  const result = await runProcess('pinned.exe', ['--help'], { spawnImpl: fake.spawnImpl, env: { WINAPP_UI_WORKFLOW_ID: 'unrelated' } });
  assert.equal(result.stdout, 'ok');
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.windowsHide, true);
  assert.equal(fake.calls[0].options.env.WINAPP_CLI_TELEMETRY_OPTOUT, '1');
  assert.equal(fake.calls[0].options.env.WINAPP_UI_WORKFLOW_ID, undefined);
});

test('timeout and cancellation kill only owned native process, preserving unknown outcome', async () => {
  for (const cancel of [false, true]) {
    const fake = fakeSpawn({ neverEnds: true });
    const controller = new AbortController();
    const running = runProcess('pinned.exe', [], { spawnImpl: fake.spawnImpl, timeoutMs: 15, signal: controller.signal });
    if (cancel) controller.abort();
    // Keep this test alive: the production timeout is intentionally unref'd.
    const hold = setTimeout(() => {}, 1000);
    try { await assert.rejects(running, error => error.code === (cancel ? 'cancelled' : 'native_timeout') && error.details.outcome === 'unknown'); }
    finally { clearTimeout(hold); }
    assert.equal(fake.calls[0].child.killed, true);
  }
});

test('oversized native output is terminated and reported, pre-aborted calls never spawn', async () => {
  const fake = fakeSpawn({ output: 'oversized' });
  await assert.rejects(runProcess('pinned.exe', [], { spawnImpl: fake.spawnImpl, maxOutputBytes: 3 }), { code: 'native_output_limit' });
  const controller = new AbortController(); controller.abort();
  const other = fakeSpawn();
  await assert.rejects(runProcess('pinned.exe', [], { spawnImpl: other.spawnImpl, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(other.calls.length, 0);
});

test('interrupted mouse gestures drain before termination and recover only after owned process exit', async () => {
  for (const cancel of [false, true]) {
    const fake = fakeSpawn({ neverEnds: true });
    const controller = new AbortController();
    let closed = false, recovered = 0;
    const running = runProcess('pinned.exe', ['ui', 'drag'], {
      spawnImpl: fake.spawnImpl, signal: controller.signal, timeoutMs: 15, drainMs: 20,
      interruptionRecovery: async () => {
        assert.equal(closed, true);
        assert.equal(fake.calls[0].child.killed, true);
        recovered++;
        return { released: true, button: 'left' };
      }
    });
    fake.calls[0].child.once('close', () => { closed = true; });
    if (cancel) controller.abort();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fake.calls[0].child.killed, undefined);
    assert.equal(recovered, 0);
    const hold = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(running, error => {
        assert.equal(error.code, cancel ? 'cancelled' : 'native_timeout');
        assert.equal(error.details.outcome, 'unknown');
        assert.deepEqual(error.details.recovery, { attempted: true, released: true, button: 'left' });
        return true;
      });
    } finally { clearTimeout(hold); }
    assert.equal(recovered, 1);
  }
});

test('mouse gesture finishing during drain is not killed or given an extra button release', async () => {
  const fake = fakeSpawn({ neverEnds: true });
  const controller = new AbortController();
  let recovered = 0;
  const running = runProcess('pinned.exe', [], { spawnImpl: fake.spawnImpl, signal: controller.signal, drainMs: 50, interruptionRecovery: async () => { recovered++; } });
  controller.abort();
  setTimeout(() => fake.calls[0].child.emit('close', 0, null), 10);
  await assert.rejects(running, error => error.code === 'cancelled' && error.details.outcome === 'unknown' && error.details.recovery.reason === 'native_drained');
  assert.equal(fake.calls[0].child.killed, undefined);
  assert.equal(recovered, 0);
});

test('pre-dispatch cancellation and spawn failure never emit a recovery button release', async () => {
  const controller = new AbortController(); controller.abort();
  const fake = fakeSpawn();
  let recovered = 0;
  const interruptionRecovery = async () => { recovered++; };
  await assert.rejects(runProcess('pinned.exe', [], { spawnImpl: fake.spawnImpl, signal: controller.signal, interruptionRecovery }), error => error.code === 'cancelled' && error.details.outcome === 'not_dispatched');
  assert.equal(fake.calls.length, 0);
  const spawnFailure = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => child.emit('error', Object.assign(new Error('Unavailable'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(runProcess('missing.exe', [], { spawnImpl: spawnFailure, interruptionRecovery }), { code: 'engine_unavailable' });
  assert.equal(recovered, 0);
});

test('failed emergency mouse release retains cancellation and reports unknown input outcome', async () => {
  const fake = fakeSpawn({ neverEnds: true });
  const controller = new AbortController();
  const running = runProcess('pinned.exe', [], { spawnImpl: fake.spawnImpl, signal: controller.signal, interruptionRecovery: async () => { throw new BackendError('input_recovery_failed', 'Release refused.'); } });
  controller.abort();
  await assert.rejects(running, error => error.code === 'cancelled' && error.details.outcome === 'unknown' && error.details.recovery.attempted === true && error.details.recovery.released === false && error.details.recovery.code === 'input_recovery_failed');
});

test('unconfirmed process exit is bounded and never releases while the input child may still run', async () => {
  const fake = fakeSpawn({ neverEnds: true });
  let recovered = 0;
  const controller = new AbortController();
  const running = runProcess('pinned.exe', [], { spawnImpl: fake.spawnImpl, signal: controller.signal, interruptionRecovery: async () => { recovered++; } });
  fake.calls[0].child.kill = () => { fake.calls[0].child.emit('error', Object.assign(new Error('Could not terminate'), { code: 'EACCES' })); return false; };
  controller.abort();
  await assert.rejects(running, error => error.code === 'cancelled' && error.details.outcome === 'unknown' && error.details.terminationCode === 'EACCES' && error.details.recovery.reason === 'process_exit_unconfirmed');
  assert.equal(recovered, 0);
  fake.calls[0].child.emit('close', 1, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recovered, 0);
});

test('click and drag wire bounded source-owned mouse release without the aborted signal', async () => {
  for (const verb of ['click', 'drag']) {
    const { backend, calls } = mock(args => args[0] === 'release-left' ? { released: true, button: 'left' } : undefined);
    const controller = new AbortController();
    await backend.command(verb, [], controller.signal);
    const gesture = calls.at(-1);
    assert.equal(gesture.options.drainMs, 250);
    controller.abort();
    assert.deepEqual(await gesture.options.interruptionRecovery(), { released: true, button: 'left', method: 'public-win32-sendinput' });
    const cleanup = calls.at(-1);
    assert.deepEqual(cleanup.args, ['release-left']);
    assert.equal(cleanup.executable, backend.bridgePath);
    assert.equal(cleanup.options.signal, undefined);
    assert.equal(cleanup.options.timeoutMs, 1500);
    assert.equal(cleanup.options.maxOutputBytes, 1024);
  }
  const { backend, calls } = mock();
  await backend.command('inspect', [], undefined);
  assert.equal(calls.at(-1).options.interruptionRecovery, undefined);
});

test('source-owned release must return a matching accepted left-button receipt', async () => {
  const { backend, calls } = mock(args => args[0] === 'release-left' ? { released: true, button: 'right' } : undefined);
  await backend.command('drag', []);
  await assert.rejects(calls.at(-1).options.interruptionRecovery(), { code: 'input_recovery_failed' });
});

test('failed release or unconfirmed process exit quarantines further input across sessions', async () => {
  for (const recovery of [{ attempted: true, released: false, code: 'input_recovery_failed' }, { attempted: false, reason: 'process_exit_unconfirmed' }]) {
    const { backend, calls } = mock(args => {
      if (args[1] === 'drag') throw new BackendError('cancelled', 'Interrupted.', { outcome: 'unknown', recovery });
    });
    await assert.rejects(backend.act({ window, observation: canonical(), action: { type: 'click', x: 50, y: 70 } }), { code: 'cancelled' });
    const before = calls.length;
    await assert.rejects(backend.act({ window, observation: canonical(), action: { type: 'press_key', key: 'enter' } }), error => error.code === 'input_recovery_required' && error.details.outcome === 'not_dispatched');
    assert.equal(calls.length, before);
    assert.equal((await backend.doctor()).ready, false);
    assert.equal((await backend.doctor()).code, 'input_recovery_required');
  }
});

test('successful mouse release and native drain do not quarantine retry after a fresh observation', async () => {
  for (const recovery of [{ attempted: true, released: true, button: 'left' }, { attempted: false, reason: 'native_drained' }]) {
    const { backend } = mock(args => {
      if (args[1] === 'drag') throw new BackendError('cancelled', 'Interrupted.', { outcome: 'unknown', recovery });
    });
    await assert.rejects(backend.act({ window, observation: canonical(), action: { type: 'click', x: 50, y: 70 } }), { code: 'cancelled' });
    assert.equal((await backend.act({ window, observation: canonical(), action: { type: 'press_key', key: 'enter' } })).performed, true);
    assert.equal((await backend.doctor()).ready, true);
  }
});

test('setup plan pins official release and has no global changes; unknown flags reject', async () => {
  assert.equal(plan().archiveSha256.length, 64);
  assert.equal(plan().globalChanges, false);
  assert.match(plan().source, /^https:\/\/github.com\/microsoft\/winappCli\/releases\/download\/v0\.7\.1\//);
  await assert.rejects(main(['--unknown']), /Usage/);
});
