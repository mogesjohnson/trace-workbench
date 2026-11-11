'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdbClient, encode } = require('../src/agentic-phone/adb.cjs');
const { createAgentClient } = require('../src/agentic-phone/agent.cjs');
const { createPhoneController } = require('../src/agentic-phone/controller.cjs');
const { frame, fakeAgent, fakeAdb, tempDir, hello, jpeg } = require('./fixtures/phone-fakes.cjs');


test('adb encode prefixes four hex digits', () => {
  assert.equal(encode('host:version').toString(), '000chost:version');
});

test('adb client parses devices without a selected serial', async () => {
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
  } finally { server.close(); }
});

test('adb guest services require an exact serial before opening a socket', async (t) => {
  const commands = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = parseInt(buffer.subarray(0, 4).toString('ascii'), 16);
      if (buffer.length < 4 + length) return;
      const command = buffer.subarray(4, 4 + length).toString();
      buffer = buffer.subarray(4 + length);
      commands.push(command);
      if (command === 'host:transport:R5CW') socket.write('OKAY');
      else if (command === 'exec:true') socket.end('OKAYselected');
      else socket.end('FAIL000bwrong route');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const adb = createAdbClient({ port: server.address().port });
  const attempts = await Promise.allSettled([
    adb.exec('true'),
    adb.spawn('true'),
    adb.openAbstract('trace-phone'),
    adb.push(Buffer.from('dex'), '/data/local/tmp/trace-phone.dex'),
  ]);
  assert.deepEqual(commands, []);
  assert.equal(connections, 0);
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'rejected');
    assert.match(attempt.reason.message, /select an exact device serial/);
  }

  adb.setSerial('missing-phone');
  await assert.rejects(adb.exec('true'), /adb: wrong route/);
  adb.setSerial('R5CW');
  assert.equal((await adb.exec('true')).toString(), 'selected');
  assert.deepEqual(commands, ['host:transport:missing-phone', 'host:transport:R5CW', 'exec:true']);
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
  adb.setSerial('R5CW');
  const phone = createPhoneController({ adb, dexPath, framesDir: path.join(dir, 'frames') });
  try {
    const first = await phone.screen();
    assert.ok(first.file && fs.readFileSync(first.file).equals(jpeg));
    assert.deepEqual(adb.calls.map((c) => c[0]), ['serial', 'open', 'push', 'spawn', 'open']);
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
  const adb = fakeAdb(fake.port);
  adb.setSerial('R5CW');
  const phone = createPhoneController({ adb, framesDir: dir });
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
  adb.setSerial('R5CW');
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
  adb.setSerial('R5CW');
  const phone = createPhoneController({ adb, framesDir: tempDir() });
  try {
    await phone.ensure();
    assert.deepEqual(await phone.stop(), { stopped: true, pid: 4242 });
    assert.deepEqual(adb.calls.filter((c) => c[0] === 'exec').map((c) => c[1]), ['kill 4242', 'rm -f /data/local/tmp/trace-phone.dex']);
  } finally { fake.server.close(); }
});

test('controller stop with onlyIfUsed skips adb until the agent has been used', async () => {
  const fake = await fakeAgent((r) => (r.op === 'hello' ? hello : { header: {} }));
  const adb = fakeAdb(fake.port);
  const phone = createPhoneController({ adb, framesDir: tempDir() });
  try {
    assert.deepEqual(await phone.stop(), { stopped: false, pid: null });
    assert.deepEqual(adb.calls, []);
    adb.setSerial('R5CW');
    assert.deepEqual(await phone.stop({ onlyIfUsed: true }), { stopped: false, pid: null });
    assert.deepEqual(adb.calls, [['serial', 'R5CW']]);
    await phone.ensure();
    assert.deepEqual(await phone.stop({ onlyIfUsed: true }), { stopped: true, pid: 4242 });
  } finally { fake.server.close(); }
});

test('controller replaces a running version 1 agent with the rebuilt dex', async () => {
  let reply = { header: { version: '1', pid: 7 } };
  const fake = await fakeAgent((r) => (r.op === 'hello' ? reply : { header: {} }));
  const dir = tempDir();
  const dexPath = path.join(dir, 'classes.dex');
  fs.writeFileSync(dexPath, 'dex');
  const adb = fakeAdb(fake.port);
  adb.setSerial('R5CW');
  const realSpawn = adb.spawn;
  adb.spawn = async (command) => { reply = hello; return realSpawn(command); };
  const phone = createPhoneController({ adb, dexPath, framesDir: dir });
  try {
    const info = await phone.ensure();
    assert.equal(info.version, hello.header.version);
    assert.equal(info.pid, hello.header.pid);
    assert.deepEqual(adb.calls.map(([op]) => op), ['serial', 'open', 'exec', 'push', 'spawn', 'open']);
    assert.deepEqual(adb.calls[2], ['exec', 'kill 7']);
  } finally { phone.close(); fake.server.close(); }
});

test('pruneFrames deletes only files older than 7 days', () => {
  const { pruneFrames, FRAME_MAX_AGE_MS } = require('../src/agentic-phone/controller.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-prune-'));
  try {
    const now = Date.now();
    const old = path.join(dir, 'old.jpg');
    const fresh = path.join(dir, 'fresh.jpg');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    const past = new Date(now - FRAME_MAX_AGE_MS - 60_000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(path.join(dir, 'sub'), past, past);
    assert.equal(pruneFrames({ framesDir: dir, now }), 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(path.join(dir, 'sub')), true, 'directories are kept');
    assert.equal(pruneFrames({ framesDir: path.join(dir, 'missing'), now }), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
