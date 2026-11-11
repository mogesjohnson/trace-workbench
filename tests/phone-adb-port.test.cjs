'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { runPhoneServer } = require('../src/phone/server.cjs');
const { encode } = require('../src/agentic-phone/adb.cjs');
const { createPhoneController } = require('../src/agentic-phone/controller.cjs');
const { fakeAdb } = require('./fixtures/phone-fakes.cjs');

function restorePortAfter(t) {
  const original = process.env.TRACE_PHONE_ADB_PORT;
  t.after(() => {
    if (original === undefined) delete process.env.TRACE_PHONE_ADB_PORT;
    else process.env.TRACE_PHONE_ADB_PORT = original;
  });
}

async function startPhoneClient(t, controller) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await runPhoneServer({ controller, transport: serverTransport });
  const client = new Client({ name: 'trace-phone-adb-port-test', version: '1.0.0' });
  t.after(async () => {
    try { await client.close(); } finally { await server.close(); }
  });
  await client.connect(clientTransport);
  return client;
}

test('phone MCP discovers devices on the configured loopback ADB server and does not fall back', async (t) => {
  restorePortAfter(t);
  const requests = [];
  const adb = net.createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4 || data.length < 4 + parseInt(data.subarray(0, 4), 16)) return;
      requests.push(data.subarray(4).toString());
      socket.end(Buffer.concat([Buffer.from('OKAY'), encode('private-one device\nprivate-two device\n')]));
    });
  });
  adb.listen(0, '127.0.0.1');
  await once(adb, 'listening');
  t.after(() => { if (adb.listening) adb.close(); });
  const { port } = adb.address();
  assert.notEqual(port, 5037);
  process.env.TRACE_PHONE_ADB_PORT = String(port);

  const attempts = [];
  const connect = net.connect;
  t.mock.method(net, 'connect', (options) => {
    attempts.push(options);
    assert.deepEqual(options, { host: '127.0.0.1', port });
    return connect(options);
  });
  const client = await startPhoneClient(t);
  const discovered = await client.callTool({ name: 'phone_connect', arguments: {} });
  assert.equal(discovered.isError, true);
  assert.match(discovered.structuredContent.error.message, /several devices; pass serial \(private-one, private-two\)/);
  assert.deepEqual(requests, ['host:devices-l']);

  const closed = once(adb, 'close');
  adb.close();
  await closed;
  const unreachable = await client.callTool({ name: 'phone_connect', arguments: {} });
  assert.equal(unreachable.isError, true);
  assert.ok(unreachable.structuredContent.error.message.includes(`adb server unreachable at 127.0.0.1:${port}`));
  assert.deepEqual(attempts, [{ host: '127.0.0.1', port }, { host: '127.0.0.1', port }]);
});

test('phone MCP rejects invalid ADB ports before starting its transport', async (t) => {
  restorePortAfter(t);
  const connect = t.mock.method(net, 'connect', () => { throw new Error('unexpected ADB connection'); });
  const transport = { start: t.mock.fn(async () => { throw new Error('unexpected transport start'); }) };
  for (const value of ['', '0', '65536', '-1', '+42', ' 42 ', '42\n', '42.0', '0x2a', '1e3', '127.0.0.1:5037']) {
    process.env.TRACE_PHONE_ADB_PORT = value;
    await assert.rejects(runPhoneServer({ transport }), /TRACE_PHONE_ADB_PORT must be a decimal TCP port from 1 to 65535/);
  }
  assert.equal(transport.start.mock.callCount(), 0);
  assert.equal(connect.mock.callCount(), 0);
});

test('phone MCP uses the default and accepts both inclusive port bounds', async (t) => {
  restorePortAfter(t);
  for (const port of [5037, 1, 65535]) {
    await t.test(`port ${port}`, async (t) => {
      if (port === 5037) delete process.env.TRACE_PHONE_ADB_PORT;
      else process.env.TRACE_PHONE_ADB_PORT = String(port);
      const connect = t.mock.method(net, 'connect', () => { throw new Error('blocked by test'); });
      const client = await startPhoneClient(t);
      const result = await client.callTool({ name: 'phone_connect', arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(connect.mock.callCount(), 1);
      assert.deepEqual(connect.mock.calls[0].arguments, [{ host: '127.0.0.1', port }]);
    });
  }
});

test('phone MCP uses an injected controller independently of ADB port configuration', async (t) => {
  restorePortAfter(t);
  process.env.TRACE_PHONE_ADB_PORT = 'invalid';
  const adb = fakeAdb(null);
  adb.setSerial('R5CW');
  const client = await startPhoneClient(t, createPhoneController({ adb }));
  const result = await client.callTool({ name: 'phone_logcat', arguments: { lines: 5 } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(adb.calls, [['serial', 'R5CW'], ['exec', 'logcat -d -t 5']]);
});
