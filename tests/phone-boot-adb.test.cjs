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
  assert.ok(cmd.endsWith('< /dev/null &'));
});
