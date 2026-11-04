'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { parseDevices, openPorts } = require('../scripts/phone-boot-adb.cjs');

test('parseDevices maps serials to states and skips the header', () => {
  const text = 'List of devices attached\n127.0.0.1:5555\tdevice\n127.0.0.1:34453\toffline\nemulator-5554\tdevice\n\n';
  assert.deepEqual(parseDevices(text), { '127.0.0.1:5555': 'device', '127.0.0.1:34453': 'offline', 'emulator-5554': 'device' });
  assert.deepEqual(parseDevices('List of devices attached\n'), {});
});

test('openPorts finds a listening localhost port and honours skip', async (t) => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.deepEqual(await openPorts({ from: port - 2, to: port + 2 }), [port]);
  assert.deepEqual(await openPorts({ from: port, to: port, skip: [port] }), []);
});

test('watcherCommand restarts one detached (exact name, not its own shell) trust watcher from the pushed dex', () => {
  const { watcherCommand } = require('../scripts/phone-boot-adb.cjs');
  const cmd = watcherCommand();
  assert.ok(cmd.startsWith("pkill -f '^tracewifitrust$'; "));
  assert.ok(cmd.includes('CLASSPATH=/data/local/tmp/trace-wifi.dex nohup app_process / --nice-name=tracewifitrust trace.phone.WifiTrust'));
  assert.ok(cmd.endsWith(' >> /data/local/tmp/trace-wifi.log 2>&1 < /dev/null &'), 'appends, so a restart keeps earlier events');
  assert.ok(cmd.includes('-gt 65536 ]; then mv -f /data/local/tmp/trace-wifi.log /data/local/tmp/trace-wifi.log.1; fi; '));
});

test('keepAliveRound restarts the watcher after adbd restarts, reconnecting first when adb is gone', async () => {
  const { keepAliveRound } = require('../scripts/phone-boot-adb.cjs');
  const round = async (state) => {
    const calls = [];
    const result = await keepAliveRound({
      isUp: () => state.up,
      connect: async () => { calls.push('connect'); return state.connects ? 'reopened 5555' : null; },
      running: () => state.running,
      start: () => calls.push('start'),
    });
    return [result, calls.join(',')];
  };
  assert.deepEqual(await round({ up: true, running: true }), ['ok', '']);
  assert.deepEqual(await round({ up: true, running: false }), ['restarted', 'start']);
  assert.deepEqual(await round({ up: false, connects: true, running: false }), ['reconnected+restarted', 'connect,start']);
  assert.deepEqual(await round({ up: false, connects: true, running: true }), ['reconnected', 'connect']);
  assert.deepEqual(await round({ up: false, connects: false, running: false }), ['adb_down', 'connect']);
});

test('claimLock keeps one keep-alive: a live phone-boot-adb pid blocks, a stale or reused pid does not', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { claimLock } = require('../scripts/phone-boot-adb.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-keepalive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pid');
  const procs = { 100: 'node\0/opt/trace/scripts/phone-boot-adb.cjs\0--keep-alive\0', 300: 'bash\0' };
  const cmdline = (pid) => { if (!(pid in procs)) throw new Error('ENOENT'); return procs[pid]; };
  assert.equal(claimLock(file, 100, cmdline), true, 'no pid file');
  assert.equal(fs.readFileSync(file, 'utf8'), '100\n');
  assert.equal(claimLock(file, 200, cmdline), false, 'pid 100 is a live keep-alive');
  assert.equal(claimLock(file, 100, cmdline), true, 'its own pid');
  fs.writeFileSync(file, '300\n');
  assert.equal(claimLock(file, 200, cmdline), true, 'pid reused by another program');
  fs.writeFileSync(file, '999\n');
  assert.equal(claimLock(file, 200, cmdline), true, 'process gone');
  assert.equal(fs.readFileSync(file, 'utf8'), '200\n');
});
