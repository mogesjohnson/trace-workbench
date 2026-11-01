'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAdbClient, encode } = require('../src/phone/adb.cjs');
const { createAgentClient } = require('../src/phone/agent.cjs');
const { createPhoneController } = require('../src/phone/controller.cjs');

function frame(header, payload = Buffer.alloc(0)) {
  const h = Buffer.from(JSON.stringify(header));
  const a = Buffer.alloc(4); a.writeUInt32BE(h.length);
  const b = Buffer.alloc(4); b.writeUInt32BE(payload.length);
  return Buffer.concat([a, h, b, payload]);
}

/** Fake agent: answers each framed request through handler(request) -> { header, payload }. */
function fakeAgent(handler) {
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0);
        const request = JSON.parse(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
        requests.push(request);
        const reply = handler(request, socket);
        if (reply) socket.write(frame({ ok: true, id: request.id, ...reply.header }, reply.payload));
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

/** Fake adb client whose abstract socket reaches the fake agent once started. */
function fakeAdb(port, { running = true } = {}) {
  const calls = [];
  return {
    calls,
    get running() { return running; },
    async openAbstract(name) {
      calls.push(['open', name]);
      if (!running) throw new Error('adb: closed');
      const socket = net.connect(port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));
      return { socket, leftover: Buffer.alloc(0) };
    },
    async push(data, remote) { calls.push(['push', remote, data.length]); },
    async spawn(command) {
      calls.push(['spawn', command]);
      running = true;
      const out = new EventEmitter();
      setImmediate(() => out.emit('data', Buffer.from('trace-phone agent 1 listening on @trace-phone\n')));
      return out;
    },
    async exec(command) { calls.push(['exec', command]); return Buffer.from(''); },
  };
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-phone-')); }

const hello = { header: { version: '1', sdk: 37, pid: 4242 } };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test('adb encode prefixes four hex digits', () => {
  assert.equal(encode('host:version').toString(), '000chost:version');
});

test('adb client parses devices and reports FAIL text', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      const command = data.subarray(4).toString();
      if (command === 'host:devices-l') {
        const body = 'R5CW device product:dm3q model:SM_S918U transport_id:1\n';
        socket.end(`OKAY${body.length.toString(16).padStart(4, '0')}${body}`);
      } else {
        socket.end('FAIL000bno devices!');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const adb = createAdbClient({ port: server.address().port });
    assert.deepEqual(await adb.devices(), [{ serial: 'R5CW', state: 'device', product: 'dm3q', model: 'SM_S918U', transport_id: '1' }]);
    await assert.rejects(adb.exec('true'), /adb: no devices!/);
  } finally { server.close(); }
});

test('agent client matches replies in order and surfaces agent errors', async () => {
  const fake = await fakeAgent((r) => (r.op === 'boom' ? null : { header: { echo: r.op }, payload: Buffer.from(r.op) }));
  fake.server.on('connection', (s) => s.on('data', () => {}));
  const socket = net.connect(fake.port, '127.0.0.1');
  const client = createAgentClient(socket);
  try {
    const [a, b] = await Promise.all([client.call({ op: 'one' }), client.call({ op: 'two' })]);
    assert.equal(a.header.echo, 'one');
    assert.equal(b.payload.toString(), 'two');
  } finally { client.close(); fake.server.close(); }
});

test('agent client rejects ok:false replies and times out', async () => {
  const server = net.createServer((s) => s.on('data', () => s.write(frame({ ok: false, error: 'java.lang.IllegalStateException: no node' }))));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createAgentClient(net.connect(server.address().port, '127.0.0.1'));
  try {
    await assert.rejects(client.call({ op: 'node' }), /agent: .*no node/);
  } finally { client.close(); }
  const silent = net.createServer((s) => s.on('data', () => {}));
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const slow = createAgentClient(net.connect(silent.address().port, '127.0.0.1'));
  await assert.rejects(slow.call({ op: 'screen' }, { timeoutMs: 50 }), /did not answer screen/);
  assert.equal(slow.closed, true);
  server.close(); silent.close();
});

test('controller starts the agent when absent, saves frames, skips unchanged ones', async () => {
  const fake = await fakeAgent((r) => {
    if (r.op === 'hello') return hello;
    if (r.op === 'screen') {
      if (r.ifChangedFrom === 'aa') return { header: { hash: 'aa', changed: false } };
      return { header: { hash: 'aa', changed: true, format: 'jpeg', scale: 0.5, regionX: 0, regionY: 0 }, payload: jpeg };
    }
    return { header: {} };
  });
  const dir = tempDir();
  const dexPath = path.join(dir, 'classes.dex');
  fs.writeFileSync(dexPath, 'dex');
  const adb = fakeAdb(fake.port, { running: false });
  const phone = createPhoneController({ adb, dexPath, framesDir: path.join(dir, 'frames') });
  try {
    const first = await phone.screen();
    assert.ok(first.file && fs.readFileSync(first.file).equals(jpeg));
    assert.deepEqual(adb.calls.map((c) => c[0]), ['open', 'push', 'spawn', 'open']);
    const second = await phone.screen();
    assert.equal(second.file, null);
    assert.equal(fake.requests.filter((r) => r.op === 'screen')[1].ifChangedFrom, 'aa');
  } finally { phone.close(); fake.server.close(); }
});

test('controller converts image coordinates, acts, then settles in one call', async () => {
  const fake = await fakeAgent((r) => {
    if (r.op === 'hello') return hello;
    if (r.op === 'screen') return { header: { hash: 'h1', format: 'jpeg', scale: 0.5, regionX: 0, regionY: 100 }, payload: jpeg };
    if (r.op === 'wait') return { header: { hash: 'h2', met: true, format: 'jpeg', scale: 0.5, regionX: 0, regionY: 0 }, payload: jpeg };
    return { header: {} };
  });
  const dir = tempDir();
  const phone = createPhoneController({ adb: fakeAdb(fake.port), framesDir: dir });
  try {
    await assert.rejects(phone.act({ target: { x: 1, y: 1 } }), /no frame yet/);
    await phone.screen();
    const result = await phone.act({ target: { x: 10, y: 20 } });
    const tap = fake.requests.find((r) => r.op === 'tap');
    assert.deepEqual([tap.x, tap.y, tap.holdMs], [20, 140, 40]);
    const wait = fake.requests.find((r) => r.op === 'wait');
    assert.equal(wait.from, 'h1');
    assert.equal(wait.image, true);
    assert.equal(result.after.header.hash, 'h2');
    await phone.act({ action: 'tap', target: { selector: { text: 'Wi-Fi' } } });
    const node = fake.requests.find((r) => r.op === 'node');
    assert.deepEqual([node.text, node.action], ['Wi-Fi', 'click']);
  } finally { phone.close(); fake.server.close(); }
});

test('controller reconnects once after the link drops', async () => {
  let drop = true;
  const fake = await fakeAgent((r, socket) => {
    if (r.op === 'hello') return hello;
    if (r.op === 'ui' && drop) { drop = false; socket.destroy(); return null; }
    return { header: { count: 1 }, payload: Buffer.from('[{"text":"OK"}]') };
  });
  const adb = fakeAdb(fake.port);
  const phone = createPhoneController({ adb, framesDir: tempDir() });
  try {
    const result = await phone.ui();
    assert.deepEqual(result.nodes, [{ text: 'OK' }]);
    assert.equal(adb.calls.filter((c) => c[0] === 'open').length, 2);
  } finally { phone.close(); fake.server.close(); }
});

test('controller stop kills the agent by pid and removes the dex', async () => {
  const fake = await fakeAgent((r) => (r.op === 'hello' ? hello : { header: {} }));
  const adb = fakeAdb(fake.port);
  const phone = createPhoneController({ adb, framesDir: tempDir() });
  try {
    await phone.ensure();
    assert.deepEqual(await phone.stop(), { stopped: true, pid: 4242 });
    assert.deepEqual(adb.calls.filter((c) => c[0] === 'exec').map((c) => c[1]), ['kill 4242', 'rm -f /data/local/tmp/trace-phone.dex']);
  } finally { fake.server.close(); }
});

test('controller refuses a version mismatch by restarting the agent', async () => {
  let version = '0';
  const fake = await fakeAgent((r) => (r.op === 'hello' ? { header: { version, pid: 7 } } : { header: {} }));
  const dir = tempDir();
  const dexPath = path.join(dir, 'classes.dex');
  fs.writeFileSync(dexPath, 'dex');
  const adb = fakeAdb(fake.port);
  const realSpawn = adb.spawn;
  adb.spawn = async (command) => { version = '1'; return realSpawn(command); };
  const phone = createPhoneController({ adb, dexPath, framesDir: dir });
  try {
    const info = await phone.ensure();
    assert.equal(info.version, '1');
    assert.ok(adb.calls.some((c) => c[0] === 'exec' && c[1] === 'kill 7'));
  } finally { phone.close(); fake.server.close(); }
});
