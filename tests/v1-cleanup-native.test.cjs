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

