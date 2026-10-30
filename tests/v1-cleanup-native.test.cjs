'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { NativeSupervisor } = require('../src/computer/supervisor.cjs');
const { createComputerController } = require('../src/computer/controller.cjs');
const { createComputerServer } = require('../src/computer/server.cjs');
const { TOOL_NAMES } = require('../src/method/index.cjs');

function owner({ ack = { closed: true, cleanup: 'confirmed' }, destroyed = false, rejection, exit = { code: 0, signal: null } } = {}) {
  const native = new NativeSupervisor();
  native.child = { stdin: { destroyed, end() {} } };
  native.owner = 'session'; native.ready = true;
  native.request = async () => { if (rejection) throw rejection; return ack; };
  native.waitExit = async () => { if (exit instanceof Error) throw exit; return exit; };
  return native;
}

const unknown = error => error.details?.cleanup === 'unknown';
test('native close requires explicit cleanup confirmation and latches uncertain outcomes', async () => {
  await owner().release('session');
  for (const options of [
    { ack: { closed: true } },
    { ack: { closed: true, cleanup: 'unknown' } },
    { ack: { closed: false, cleanup: 'confirmed' } },
    { destroyed: true },
    { rejection: Object.assign(new Error('native refused'), { code: 'native_failed' }) },
    { exit: { code: 1, signal: null } },
    { exit: Object.assign(new Error('exit unknown'), { code: 'exit_failed' }) },
  ]) {
    const native = owner(options);
    await assert.rejects(native.release('session'), unknown);
    await assert.rejects(native.release('session'), unknown);
  }
  const rejection = Object.assign(new Error('native refused'), { code: 'native_failed',
    details: { recovery: { attempted: true, released: false } } });
  const native = owner({ rejection, exit: Object.assign(new Error('exit unknown'), { code: 'exit_failed' }) });
  await assert.rejects(native.release('session'), error => error.code === 'native_failed'
    && error.details.recovery.attempted && error.cleanupCodes.includes('exit_failed'));
});

async function connect(t, controller) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createComputerServer({ controller });
  await server.connect(b);
  const client = new Client({ name: 'cleanup-test', version: '1' });
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close().catch(() => {}); });
  return client;
}

const window = { id: 'window', pid: 7, processName: 'fixture', processCreationTime: '100', bounds: { x: 0, y: 0, width: 1, height: 1 } };
test('controller and MCP retain bounded recovery details when indicator and lease fail', async t => {
  const abort = new AbortController();
  let releaseCalls = 0;
  const lease = {
    async acquire() {}, async assert() {},
    async release() {
      releaseCalls++;
      throw Object.assign(new Error('lease failed'), { code: 'lease_failed', details: { cleanup: 'unknown', inputRecoveryRequired: true,
        recovery: { attempted: true, released: false, processExitConfirmed: false, secret: 'PRIVATE_RECOVERY' } } });
    },
  };
  const indicator = { signal: abort.signal, async start() { return { active: true }; }, assertActive() {},
    async stop() { throw Object.assign(new Error('indicator failed'), { code: 'indicator_failed' }); } };
  const backend = { async doctor() { return { ready: true }; }, async listWindows() { return [window]; } };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-cleanup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const controller = createComputerController({ backend, lease, indicator, runtimeDirectory: directory });
  const client = await connect(t, controller);
  await client.callTool({ name: TOOL_NAMES[1], arguments: {} });
  const opened = await client.callTool({ name: TOOL_NAMES[2], arguments: { windowId: window.id } });
  const result = await client.callTool({ name: TOOL_NAMES[5], arguments: { sessionId: opened.structuredContent.sessionId } });
  assert.equal(result.isError, true);
  const error = result.structuredContent.error;
  assert.equal(error.cleanup, 'unknown');
  assert.equal(error.inputRecoveryRequired, true);
  assert.equal(error.recovery.released, false);
  assert.ok(error.cleanupCodes.includes('indicator_failed'));
  assert.ok(error.cleanupCodes.includes('lease_failed'));
  assert.equal(JSON.stringify(result).includes('PRIVATE_RECOVERY'), false);
  assert.equal(releaseCalls, 1);
  await assert.rejects(controller.close(), unknown);
  await assert.rejects(controller.close(), unknown);
});


test('startup retains original recovery details when lease cleanup fails generically', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-cleanup-startup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recovery = { attempted: true, released: false };
  const indicator = { signal: new AbortController().signal, async start() {
    throw Object.assign(new Error('startup failed'), { code: 'startup_failed', details: { recovery } });
  }, async stop() {} };
  const lease = { async acquire() {}, async release() { throw new Error('cleanup failed'); } };
  const backend = { async listWindows() { return [window]; } };
  const controller = createComputerController({ backend, lease, indicator, runtimeDirectory: directory });
  await controller.listWindows();
  await assert.rejects(controller.openSession({ windowId: window.id }), error =>
    error.code === 'startup_failed' && error.details.recovery.released === false);
});
