'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerController } = require('../src/computer/controller.cjs');
const { createComputerServer } = require('../src/computer/server.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVdAAAAAASUVORK5CYII=', 'base64');
async function fixture(t, captureKeepLast) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-retention-controller-'));
  const window = { id: '1', pid: 123, processName: 'fixture', bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const control = { failCapture: false, failClose: false }, files = [];
  const backend = { async doctor() { return { ready: true }; }, async listWindows() { return [window]; },
    async observe({ screenshotPath }) {
      files.push(screenshotPath); await fs.writeFile(screenshotPath, png);
      if (control.failCapture) throw Object.assign(new Error('capture failed'), { code: 'capture_failed' });
      return { window, bounds: window.bounds, elements: [], screenshot: { path: screenshotPath } };
    }, async act() { return { performed: true }; },
    async close() { if (control.failClose) throw Object.assign(new Error('uncertain close'), { code: 'cleanup_failed' }); } };
  const indicator = { signal: new AbortController().signal, async start() { return {}; }, assertActive() {}, async stop() {} };
  const lease = { async acquire() {}, async assert() {}, async release() {} };
  const c = createComputerController({ backend, indicator, lease, runtimeDirectory: directory, captureKeepLast });
  t.after(async () => {
    await c.close().catch(() => {});
    const target = path.resolve(directory), base = path.resolve(os.tmpdir());
    assert.equal(path.dirname(target), base); assert.ok(path.basename(target).startsWith('trace-retention-controller-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  await c.listWindows();
  return { c, session: await c.openSession({ windowId: window.id }), control, files };
}
test('preserve option leaves captures after session close', async t => {
  assert.throws(() => createComputerController({ captureKeepLast: null }), { code: 'invalid_capture_retention' });
  const f = await fixture(t, 0);
  assert.equal((await f.c.doctor()).captureRetention.mode, 'preserve');
  await f.c.observe(f.session); await f.c.observe(f.session);
  await f.c.closeSession(f.session);
  assert.equal((await fs.readFile(f.files[0])).length, png.length);
  assert.equal((await fs.readFile(f.files[1])).length, png.length);
});
test('MCP keeps completed action and storage warning separate; confirmed close removes tracked frames', async t => {
  const f = await fixture(t, 1), [a, b] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller: f.c }), client = new Client({ name: 'retention-test', version: '1' });
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const full = await f.c.observe(f.session);
  const mock = t.mock.method(fs, 'unlink', async () => { throw new Error('private path'); });
  let response;
  try { response = await client.callTool({ name: 'trace_computer_act', arguments: {
    sessionId: f.session.sessionId, observationId: full.observationId, action: { type: 'activate' } } }); }
  finally { mock.mock.restore(); }
  const result = response.structuredContent;
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.observation.captureRetention.warnings, ['io_failure']);
  assert.equal(result.observation.captureRetention.status, 'incomplete');
  assert.equal(JSON.stringify(result.observation.captureRetention).includes('private'), false);
  assert.equal((await fs.readFile(f.files[0])).length, png.length);
  const closed = await f.c.closeSession(f.session);
  assert.equal(closed.cleanup, 'confirmed'); assert.equal(closed.captureRetention.tracked, 0);
  for (const file of f.files) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
test('failed capture and uncertain native close retain their files', async t => {
  const failed = await fixture(t, 1);
  failed.control.failCapture = true;
  await assert.rejects(failed.c.observe(failed.session), { code: 'capture_failed' });
  await failed.c.closeSession(failed.session);
  assert.equal((await fs.readFile(failed.files[0])).length, png.length);
  const uncertain = await fixture(t, 1);
  await uncertain.c.observe(uncertain.session); uncertain.control.failClose = true;
  await assert.rejects(uncertain.c.close(), error => error.details.cleanup === 'unknown');
  assert.equal((await fs.readFile(uncertain.files[0])).length, png.length);
});
test('late action journal failure and cancellation leave uncertain frames untracked', async t => {
  const f = await fixture(t, 1), full = await f.c.observe(f.session);
  const append = fs.appendFile;
  let mock = t.mock.method(fs, 'appendFile', async (file, value, ...args) => {
    if (JSON.parse(value).type === 'action_completed') throw Object.assign(new Error('write failed'), { code: 'EIO' });
    return append(file, value, ...args);
  });
  let result;
  try { result = await f.c.act({ ...f.session, observationId: full.observationId, action: { type: 'activate' } }); }
  finally { mock.mock.restore(); }
  assert.equal(result.outcome, 'unknown'); await fs.stat(f.files[0]);
  await f.c.closeSession(f.session); await fs.stat(f.files[1]);
  const late = await fixture(t, 1); await late.c.observe(late.session);
  const abort = new AbortController(), unlink = fs.unlink;
  mock = t.mock.method(fs, 'unlink', async file => { await unlink(file); abort.abort(); });
  try { await assert.rejects(late.c.observe(late.session, { signal: abort.signal }), { name: 'AbortError' }); }
  finally { mock.mock.restore(); }
  await assert.rejects(late.c.act({ ...late.session, observationId: path.basename(late.files[1], '.png'), action: { type: 'activate' } }), { code: 'stale_observation' });
  await late.c.closeSession(late.session); await fs.stat(late.files[1]);
});
