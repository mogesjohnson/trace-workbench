'use strict';
// Live 2026-11-02: Notepad 11 and a running Firefox start through a process that hands the start
// to another process. A handoff is accepted only for a window that is new since the pre-launch
// snapshot and whose executable resolves to the registered EXE.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createInstalledApplications } = require('../src/method/index.cjs');

async function fixture(t, scenario) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-app-handoff-'));
  const executable = path.join(directory, 'app.exe'), other = path.join(directory, 'other.exe');
  await fs.writeFile(executable, 'synthetic registered executable'); await fs.writeFile(other, 'synthetic other executable');
  const state = { started: false, releases: 0 };
  const existing = { id: '100', pid: 300, processCreationTime: '90', sessionId: 2, executable };
  const handed = { id: '777', pid: 500, processCreationTime: '200', sessionId: 2, executable: scenario === 'other-exe' ? other : executable };
  const backend = {
    async bridge(verb, _window, _signal, args) {
      if (verb === 'apps') return { applications: [{ name: 'App', executable, registration: 'synthetic/App Paths/app.exe' }], coverage: 'synthetic', partial: false, issues: [] };
      assert.equal(verb, 'process'); assert.deepEqual(args, ['400']);
      if (['exited', 'unreadable-alive', 'other-exe'].includes(scenario)) throw Object.assign(Error('gone'), { code: 'window_bridge_failed' });
      return { pid: 400, processCreationTime: '150', sessionId: 2, executable };
    },
    async listWindows() {
      if (!state.started || scenario === 'preexisting-only') return [existing];
      return [existing, handed];
    },
    async currentVisualWindow(value) { return value; }
  };
  const lease = { signal: new AbortController().signal, async acquire() {}, async assert() {}, async release() { state.releases++; } };
  const catalog = createInstalledApplications({ backend, lease, verify: async () => {}, timeoutMs: 1500, spawnImpl: () => {
    state.started = true; const child = new EventEmitter(); child.pid = 400; child.unref = () => {};
    queueMicrotask(() => { child.emit('spawn'); if (scenario !== 'unreadable-alive' && scenario !== 'alive') setTimeout(() => child.emit('exit', 0), 5); });
    return child;
  } });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const app = (await catalog.discover()).applications[0];
  return { catalog, app, state };
}

for (const scenario of ['exited', 'alive'])
test(`a new window of the registered EXE in another process is a handed-off launch (${scenario} spawner)`, async t => {
  const { catalog, app, state } = await fixture(t, scenario);
  const result = await catalog.launch(app.appId);
  assert.equal(result.outcome, 'launched');
  assert.equal(result.ownership, 'handed-off');
  assert.deepEqual(result.windows.map(window => window.id), ['777']);
  assert.equal(result.process.pid, 500);
  assert.equal(result.spawnedPid, 400);
  assert.equal(state.releases, 1);
});

for (const [scenario, code] of [['other-exe', 'application_timeout'], ['preexisting-only', 'application_timeout'], ['unreadable-alive', 'window_bridge_failed']])
test(`launch stays unknown when the handoff cannot be proven (${scenario})`, async t => {
  const { catalog, app, state } = await fixture(t, scenario);
  const result = await catalog.launch(app.appId);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.code, code);
  assert.equal(state.releases, 1);
  await assert.rejects(catalog.launch(app.appId), { code: 'application_already_attempted' });
});
