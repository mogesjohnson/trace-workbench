'use strict';
// M3 (G3): packaged apps launch by AUMID through the window bridge, and Settings pages through an
// exact ms-settings: allowlist. Settings runs in an ApplicationFrameHost frame, so its window is
// accepted only when it is new since the snapshot and hosts a CoreWindow with the activated AUMID.
const test = require('node:test'), assert = require('node:assert/strict');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { createPackagedApplications } = require('../src/method/index.cjs');

const SETTINGS = 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel';
const FRAME_HOST = 'C:\\Windows\\System32\\ApplicationFrameHost.exe';
const owner = { id: '100', pid: 300, processName: 'notepad', title: 'Owner notes', processCreationTime: '90', sessionId: 1, executable: 'C:\\Windows\\notepad.exe' };
const frame = { id: '900', pid: 650, processName: 'ApplicationFrameHost', title: 'Settings', className: 'ApplicationFrameWindow',
  processCreationTime: '80', sessionId: 1, executable: FRAME_HOST };

// scenario: 'frame' (new frame hosting Settings), 'own' (the app's own window), 'running'
// (Settings open before launch), 'other' (new frame hosting another app), 'missing' (not installed).
function fakeDesktop(scenario) {
  const state = { activations: [], started: false, releases: 0, acquired: 0, bridge: [] };
  const own = { ...frame, id: '901', pid: 700, processName: 'SystemSettings', className: 'Window', processCreationTime: '200', executable: 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe' };
  const appears = scenario === 'own' ? own : frame;
  const live = () => [owner, ...(scenario === 'running' || state.started ? [appears] : [])]
    .map(item => ({ ...item, bounds: { x: null, y: null, width: 1000, height: 700 } }));
  const identity = pair => {
    const [hwnd, pid] = pair.split(':'), base = { hwnd, pid: Number(pid), aumid: null, hosted: [] };
    if (hwnd === frame.id) return { ...base, hosted: [{ pid: 700, aumid: scenario === 'other' ? 'Other.App_8wekyb3d8bbwe!App' : SETTINGS }] };
    if (hwnd === own.id) return { ...base, aumid: SETTINGS };
    return base;
  };
  const backend = {
    async listWindows() { return live(); },
    async currentWindow(target) { return { ...target }; },
    async currentVisualWindow(target) { return { ...target }; },
    async targetClosed() { return false; },
    async doctor() { return { ready: true, engine: 'fake' }; },
    async bridge(verb, _window, _signal, args = []) {
      state.bridge.push(verb);
      if (verb === 'packaged') {
        if (scenario === 'missing') throw Object.assign(new Error('missing'), { code: 'unknown_application' });
        return { aumid: args[0].toLowerCase(), family: args[0].split('!')[0] };
      }
      if (verb === 'packaged-identities') return { windows: args.map(identity) };
      assert.equal(verb, 'activate-package');
      state.activations.push(args); state.started = true;
      return { aumid: args[0], pid: 700, protocol: args.length === 2 };
    },
  };
  const lease = { owner: null, signal: new AbortController().signal,
    async acquire(id) { if (this.owner) throw Object.assign(new Error('busy'), { code: 'desktop_busy' }); this.owner = id; state.acquired++; },
    async assert(id) { if (this.owner !== id) throw Object.assign(new Error('lost'), { code: 'lease_lost' }); },
    async release(id) { if (this.owner === id) { this.owner = null; state.releases++; } } };
  const packaged = () => createPackagedApplications({ backend, lease, verify: async () => {}, timeoutMs: 300 });
  return { backend, lease, state, packaged };
}

test('Settings in a new ApplicationFrameHost frame is a handed-off launch; the page travels as a protocol', async () => {
  const d = fakeDesktop('frame');
  const result = await d.packaged().launch({ aumid: SETTINGS, uri: 'ms-settings:display' });
  assert.equal(result.outcome, 'launched', JSON.stringify(result));
  assert.equal(result.ownership, 'handed-off');
  assert.deepEqual(result.windows.map(window => window.id), ['900']);
  assert.equal(result.process.pid, 650); assert.equal(result.activatedPid, 700);
  assert.deepEqual(d.state.activations, [[SETTINGS, 'ms-settings:display']]);
  assert.equal(d.state.releases, 1);
});

test("a packaged app's own new window is a created-process launch", async () => {
  const d = fakeDesktop('own');
  const result = await d.packaged().launch({ aumid: SETTINGS });
  assert.equal(result.outcome, 'launched'); assert.equal(result.ownership, 'created-process');
  assert.deepEqual(result.windows.map(window => window.id), ['901']);
  assert.deepEqual(d.state.activations, [[SETTINGS]]);
});

test('an already open instance is reported and never activated', async () => {
  const d = fakeDesktop('running');
  const result = await d.packaged().launch({ aumid: SETTINGS });
  assert.deepEqual({ outcome: result.outcome, code: result.code, cleanup: result.cleanup }, { outcome: 'not_dispatched', code: 'already_running', cleanup: 'confirmed' });
  assert.deepEqual(d.state.activations, []);
  assert.equal(d.state.releases, 1);
});

test('a new frame hosting another app proves nothing: the launch stays unknown and is not replayed', async () => {
  const d = fakeDesktop('other'), catalog = d.packaged();
  const result = await catalog.launch({ aumid: SETTINGS });
  assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome: 'unknown', code: 'application_timeout' });
  await assert.rejects(catalog.launch({ aumid: SETTINGS }), { code: 'application_already_attempted' });
  assert.equal(d.state.activations.length, 1);
});

test('an AUMID missing from the package catalog is refused before the lease or activation', async () => {
  const d = fakeDesktop('missing');
  const result = await d.packaged().launch({ aumid: 'Missing.App_8wekyb3d8bbwe!App' });
  assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome: 'not_dispatched', code: 'unknown_application' });
  assert.equal(d.state.acquired, 0); assert.deepEqual(d.state.activations, []);
});

async function server(t, scenario) {
  const d = fakeDesktop(scenario);
  const controller = createComputerController({ backend: d.backend, lease: d.lease, observationTtlMs: 60000,
    runtimeDirectory: require('node:os').tmpdir(),
    indicator: { signal: new AbortController().signal, start: async () => ({ active: true }), assertActive() {}, stop: async () => {} },
    createApplications: () => { throw new Error('App Paths must not be consulted for packaged targets.'); },
    createPackagedApplications: d.packaged });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createComputerServer({ controller }); await mcp.connect(serverTransport);
  const client = new Client({ name: 'trace-m3', version: '1.0.0' }); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await mcp.close(); });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name: `trace_computer_${name}`, arguments: args });
    return { result, text: result.content.find(item => item.type === 'text')?.text ?? '' };
  };
  return { call, state: d.state };
}

test('launch settings returns its frame within about 250 characters, and open_session takes it directly', async t => {
  const s = await server(t, 'frame');
  const { result, text } = await s.call('launch', { app: 'Settings' });
  assert.equal(result.structuredContent.outcome, 'launched', text);
  assert.equal(result.structuredContent.handedOff, true);
  assert.deepEqual(result.structuredContent.windows.map(window => window.id), ['900']);
  assert.ok(text.length <= 250, `launch result was ${text.length} chars: ${text}`);
  const opened = await s.call('open_session', { windowId: '900' });
  assert.equal(opened.result.isError, undefined, opened.text);
});

test('only exact allowlisted ms-settings: pages launch; other URIs and paths are refused before the bridge', async t => {
  const s = await server(t, 'frame');
  for (const app of ['ms-settings:', 'ms-settings:Display', 'ms-settings:privacy-webcam', 'ms-settings://display', 'ms-settings:display?x=1', 'http://example.com', 'C:\\Windows\\notepad.exe']) {
    const { result, text } = await s.call('launch', { app });
    assert.equal(JSON.parse(text).error?.code, 'application_unsupported', `${app}: ${text}`);
    assert.equal(result.isError, true);
  }
  assert.deepEqual(s.state.bridge, []);
  const page = await s.call('launch', { app: 'ms-settings:display' });
  assert.equal(page.result.structuredContent.outcome, 'launched', page.text);
  assert.deepEqual(s.state.activations, [[SETTINGS, 'ms-settings:display']]);
});

test('an already open Settings window is reported to the agent and left alone', async t => {
  const s = await server(t, 'running');
  const { result } = await s.call('launch', { app: 'settings' });
  assert.equal(result.structuredContent.outcome, 'not_dispatched'); assert.equal(result.structuredContent.code, 'already_running');
  assert.match(result.structuredContent.nextStep, /not touched/);
  assert.deepEqual(s.state.activations, []);
});

test('doctor reports the packaged catalog and the URI allowlist', async t => {
  const s = await server(t, 'frame');
  const { result } = await s.call('doctor');
  assert.deepEqual(result.structuredContent.launch, { catalog: ['app-paths', 'packaged'], shell: false, uri: 'allowlist' });
});
