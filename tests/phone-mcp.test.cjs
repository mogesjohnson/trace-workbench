'use strict';

// TRACE Phone MCP server and agent build helpers. The server runs on the real
// controller over a fake adb client and a fake agent socket; no device is used.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createPhoneServer, toControllerAction, commandTranscriber, KEYS } = require('../src/phone/server.cjs');
const { createPhoneController } = require('../src/agentic-phone/controller.cjs');
const { newest, compare } = require('../src/agentic-phone/build.cjs');
const { frame, fakeAgent, fakeAdb, tempDir, hello, jpeg } = require('./fixtures/phone-fakes.cjs');

const TOOLS = ['phone_act', 'phone_connect', 'phone_logcat', 'phone_screen', 'phone_transcribe', 'phone_ui', 'phone_wait'];

function agentHandler(waitFor) {
  let hash = 'h1';
  return (r) => {
    if (r.op === 'hello') return hello;
    if (r.op === 'screen') {
      if (r.ifChangedFrom === hash) return { header: { hash, changed: false } };
      return { header: { hash, changed: true, format: 'jpeg', scale: 0.5, regionX: 0, regionY: 0, width: 4, height: 8 }, payload: jpeg };
    }
    if (r.op === 'wait') {
      const header = { hash: 'h2', met: true, frames: 2, width: 4, height: 8, ...waitFor?.(r, hash) };
      header.changed ??= header.hash !== (r.from ?? hash);
      hash = header.hash;
      return r.image
        ? { header: { ...header, format: 'jpeg', scale: 0.5, regionX: 0, regionY: 0 }, payload: jpeg }
        : { header };
    }
    if (r.op === 'ui' || r.op === 'find') return { header: { count: 1 }, payload: Buffer.from('[{"text":"Wi-Fi","cx":10,"cy":20}]') };
    return { header: { done: r.op } };
  };
}

async function connection(t, { adbOptions, transcribe, handler = agentHandler(), hasDex = true, serial } = {}) {
  const fake = await fakeAgent(handler);
  const dir = tempDir();
  const dexPath = path.join(dir, 'classes.dex');
  if (hasDex) fs.writeFileSync(dexPath, 'dex');
  const adb = fakeAdb(fake.port, adbOptions);
  const controller = createPhoneController({ adb, dexPath, framesDir: path.join(dir, 'frames') });
  const server = createPhoneServer({ controller, transcribe, serial });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'trace-phone-test', version: '1.0.0' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); fake.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, server, call, adb, fake, dir };
}

const images = (result) => result.content.filter((c) => c.type === 'image');

test('phone_act can refresh on visible change from a prior observation', async (t) => {
  const { call, fake } = await connection(t);
  await call('phone_connect');
  const action = { type: 'tap', selector: { text: 'Counter' } };
  const rejected = await call('phone_act', { action, until: 'change' });
  assert.equal(rejected.isError, true);
  assert.ok(!fake.requests.some(request => request.op === 'node'));
  await call('phone_screen');
  const result = await call('phone_act', { action, until: 'change' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(fake.requests.slice(-2).map(request => request.op), ['node', 'wait']);
  assert.equal(fake.requests.at(-1).until, 'change');
  assert.equal(fake.requests.at(-1).from, 'h1');
  assert.equal(images(result).length, 1);
});

test('phone server lists exactly the seven phone tools with read-only hints where safe', async (t) => {
  const { client } = await connection(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);
  const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
  assert.deepEqual(hints, { phone_act: false, phone_connect: false, phone_logcat: true, phone_screen: true, phone_transcribe: true, phone_ui: true, phone_wait: true });
});

test('device tools and shutdown leave the guest untouched before phone_connect', async (t) => {
  const { call, adb, fake, server } = await connection(t);
  const results = [];
  for (const [name, args] of [
    ['phone_screen'],
    ['phone_wait'],
    ['phone_ui'],
    ['phone_ui', { selector: { text: 'Wi-Fi' }, release: true }],
    ['phone_act', { action: { type: 'key', key: 'back' } }],
    ['phone_act', { action: { type: 'tap', x: 1, y: 1 } }],
    ['phone_logcat'],
  ]) {
    results.push(await call(name, args));
  }
  await server.close();
  assert.deepEqual(adb.calls, []);
  assert.deepEqual(fake.requests, []);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error.message, /call phone_connect first/);
  }
});

test('pinned phone_screen validates the exact target and reuses one warm agent', async (t) => {
  const serial = '127.0.0.1:5555';
  const devices = [{ serial: 'R5CW', state: 'device' }, { serial, state: 'device' }];
  const { call, adb, fake } = await connection(t, { serial, adbOptions: { devices, running: false } });
  const switched = await call('phone_connect', { serial: 'R5CW' });
  assert.equal(switched.isError, true);
  assert.deepEqual(adb.calls, []);
  const [first, second] = await Promise.all([
    call('phone_screen', { force: true }), call('phone_screen', { force: true }),
  ]);
  for (const result of [first, second]) {
    assert.equal(result.structuredContent.serial, serial);
    assert.equal(images(result).length, 1);
  }
  assert.deepEqual(adb.calls.filter(([op]) => op === 'serial'), [['serial', serial]]);
  assert.equal(adb.calls.filter(([op]) => op === 'spawn').length, 1);
  assert.deepEqual(fake.requests.map(({ op }) => op), ['hello', 'screen', 'screen']);
});

test('pinned phone_screen fails closed when only another target is ready', async (t) => {
  const { call, adb, fake, server } = await connection(t, { serial: '127.0.0.1:5555' });
  const result = await call('phone_screen');
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error.message, /must be in state "device"/);
  await server.close();
  assert.deepEqual(adb.calls, []);
  assert.deepEqual(fake.requests, []);
});

test('pinned phone serializes action and settle while independent work proceeds', async (t) => {
  let beginSettle;
  const settleStarted = new Promise((resolve) => { beginSettle = resolve; });
  const respond = agentHandler();
  const handler = (request, socket) => {
    if (request.op !== 'wait') return respond(request);
    beginSettle(() => {
      const reply = respond(request);
      socket.write(frame({ ok: true, id: request.id, ...reply.header }, reply.payload));
    });
    return undefined;
  };
  const { call, fake } = await connection(t, { serial: 'R5CW', handler, transcribe: async () => ({ text: 'fixture' }) });
  await call('phone_screen');
  const input = call('phone_act', { action: { type: 'tap', x: 1, y: 1 } });
  const finishSettle = await settleStarted;
  const queued = call('phone_screen', { force: true });
  try {
    const overlap = await call('phone_act', { action: { type: 'key', key: 'back' } });
    assert.equal(overlap.isError, true);
    assert.match(overlap.structuredContent.error.message, /not dispatched/);
    const independent = await call('phone_transcribe', { path: '/tmp/fixture.wav' });
    assert.equal(independent.structuredContent.text, 'fixture');
    assert.deepEqual(fake.requests.map(({ op }) => op), ['hello', 'screen', 'tap', 'wait']);
  } finally {
    finishSettle();
  }
  assert.equal(images(await input).length, 1);
  assert.equal(images(await queued).length, 1);
  assert.deepEqual(fake.requests.map(({ op }) => op), ['hello', 'screen', 'tap', 'wait', 'screen']);
});

test('phone_connect picks the only USB device and starts the agent', async (t) => {
  const { call, adb } = await connection(t, { adbOptions: { running: false } });
  const result = await call('phone_connect');
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.serial, 'R5CW');
  assert.equal(result.structuredContent.agent.pid, 4242);
  assert.deepEqual(adb.calls.map((c) => c[0]), ['serial', 'open', 'push', 'spawn', 'open']);
});

test('phone_connect pairs and connects over Wi-Fi, and needs a serial among several', async (t) => {
  const { call, adb } = await connection(t);
  const wifi = await call('phone_connect', { address: '192.0.2.5:5555', pairAddress: '192.0.2.5:37000', pairCode: '123456' });
  assert.notEqual(wifi.isError, true);
  assert.equal(wifi.structuredContent.serial, '192.0.2.5:5555');
  assert.deepEqual(adb.calls.slice(0, 3), [['pair', '192.0.2.5:37000', '123456'], ['connect', '192.0.2.5:5555'], ['serial', '192.0.2.5:5555']]);
  const ambiguous = await call('phone_connect');
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.structuredContent.error.message, /several devices; pass serial \(R5CW, 192\.0\.2\.5:5555\)/);
  const same = await call('phone_connect', { address: '192.0.2.5:5555', serial: '192.0.2.5:5555' });
  assert.equal(same.structuredContent.serial, '192.0.2.5:5555');
  const usb = await call('phone_connect', { serial: 'R5CW' });
  assert.equal(usb.structuredContent.serial, 'R5CW');
  const badCode = await call('phone_connect', { pairCode: '12ab56' });
  assert.equal(badCode.isError, true);
});

test('phone_connect rejects an unavailable Wi-Fi address and preserves an existing connection', async (t) => {
  const { call, adb, fake } = await connection(t, { adbOptions: { running: false } });
  const address = '192.0.2.1:5555';
  adb.connect = async (target) => {
    adb.calls.push(['connect', target]);
    return `failed to connect to ${target}`;
  };

  const failed = await call('phone_connect', { address });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error.message, /192\.0\.2\.1:5555.*state "device"/);
  assert.deepEqual(adb.calls, [['connect', address]]);
  assert.equal(adb.serial, null);
  assert.deepEqual(fake.requests, []);
  const unbound = await call('phone_logcat');
  assert.equal(unbound.isError, true);
  assert.deepEqual(adb.calls, [['connect', address]]);

  const connected = await call('phone_connect');
  assert.equal(connected.structuredContent.serial, 'R5CW');
  const before = await call('phone_screen');
  assert.equal(before.structuredContent.frame.changed, true);
  const callsBefore = adb.calls.slice();
  const reconnect = await call('phone_connect', { address });
  assert.equal(reconnect.isError, true);
  const screen = await call('phone_screen');
  assert.equal(screen.structuredContent.frame.changed, false);
  assert.deepEqual(adb.calls, [...callsBefore, ['connect', address]]);
  assert.equal(adb.serial, 'R5CW');
});

test('phone_connect rejects absent or offline serials without guest side effects', async (t) => {
  const devices = [{ serial: 'R5CW', state: 'device' }, { serial: 'offline-phone', state: 'offline' }];
  const { call, adb, fake, server } = await connection(t, { adbOptions: { devices } });
  for (const serial of ['missing-phone', 'offline-phone']) {
    const failed = await call('phone_connect', { serial });
    assert.equal(failed.isError, true);
    assert.ok(failed.structuredContent.error.message.includes(serial));
  }
  await server.close();
  assert.deepEqual(adb.calls, []);
  assert.equal(adb.serial, null);
  assert.deepEqual(fake.requests, []);
});

test('phone_connect rejects conflicting selectors before pairing or connecting', async (t) => {
  const { call, adb, fake, server } = await connection(t);
  const mismatch = await call('phone_connect', {
    address: '192.0.2.5:5555', serial: 'R5CW', pairAddress: '192.0.2.5:37000', pairCode: '123456',
  });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.structuredContent.error.message, /serial and address.*match/);
  await server.close();
  assert.deepEqual(adb.calls, []);
  assert.equal(adb.serial, null);
  assert.deepEqual(fake.requests, []);
});

test('phone_screen returns the image only when the screen changed, unless forced', async (t) => {
  const { call } = await connection(t);
  await call('phone_connect', { serial: 'R5CW' });
  const first = await call('phone_screen');
  assert.equal(images(first).length, 1);
  assert.equal(images(first)[0].data, jpeg.toString('base64'));
  assert.equal(images(first)[0].mimeType, 'image/jpeg');
  assert.equal(first.structuredContent.frame.imageIncluded, true);
  assert.ok(fs.existsSync(first.structuredContent.frame.file));
  assert.equal('ok' in first.structuredContent.frame, false);
  const same = await call('phone_screen');
  assert.equal(images(same).length, 0);
  assert.equal(same.structuredContent.frame.changed, false);
  assert.equal(same.structuredContent.frame.file, null);
  const forced = await call('phone_screen', { force: true });
  assert.equal(images(forced).length, 1);
});

test('phone_act converts image coordinates, then returns the settled frame in one call', async (t) => {
  const { call, fake } = await connection(t);
  await call('phone_connect');
  const early = await call('phone_act', { action: { type: 'tap', x: 1, y: 1 } });
  assert.equal(early.isError, true);
  assert.match(early.structuredContent.error.message, /no frame yet/);
  await call('phone_screen');
  const result = await call('phone_act', { action: { type: 'tap', x: 10, y: 20 }, stableMs: 200 });
  assert.notEqual(result.isError, true);
  const tap = fake.requests.find((r) => r.op === 'tap');
  assert.deepEqual([tap.x, tap.y], [20, 40]);
  const wait = fake.requests.find((r) => r.op === 'wait');
  assert.deepEqual([wait.until, wait.stableMs, wait.from, wait.image], ['stable', 200, 'h1', true]);
  assert.equal(result.structuredContent.action.done, 'tap');
  assert.equal(result.structuredContent.frame.met, true);
  assert.equal(images(result).length, 1);
  const unknown = await call('phone_act', { action: { type: 'tap' } });
  assert.equal(unknown.isError, true);
});

test('phone_act sends each input once when the acknowledgment is lost', async (t) => {
  const cases = [
    ['key', { type: 'key', key: 'back' }],
    ['text', { type: 'text', text: 'hello' }],
    ['swipe', { type: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, space: 'device' }],
    ['node', { type: 'tap', selector: { text: 'Wi-Fi' } }],
    ['tap', { type: 'tap', x: 1, y: 2, space: 'device' }],
  ];
  for (const [op, action] of cases) {
    await t.test(op, async (t) => {
      let drop = true;
      const reply = agentHandler();
      const { call, fake } = await connection(t, { handler(r, socket) {
        if (r.op === op && drop) {
          drop = false;
          socket.destroy();
          return null;
        }
        return reply(r);
      } });
      await call('phone_connect');
      const failed = await call('phone_act', { action });
      assert.deepEqual(fake.requests.map((r) => r.op), ['hello', op]);
      assert.equal(failed.isError, true);
      assert.match(failed.structuredContent.error.message, /delivery is unknown.*verify the phone state/i);

      const read = await call('phone_screen', { force: true });
      assert.notEqual(read.isError, true);
      assert.deepEqual(fake.requests.map((r) => r.op), ['hello', op, 'hello', 'screen']);
    });
  }
});

test('phone_act distinguishes an agent error from unknown input delivery', async (t) => {
  const reply = agentHandler();
  const { call, fake } = await connection(t, { handler(r) {
    if (r.op === 'node') return { header: { ok: false, error: 'no matching node' } };
    return reply(r);
  } });
  await call('phone_connect');
  const failed = await call('phone_act', { action: { type: 'tap', selector: { text: 'Missing' } } });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.message, 'agent: no matching node');
  assert.deepEqual(fake.requests.map((r) => r.op), ['hello', 'node']);
});

test('phone_act reports setup failure before dispatch', async (t) => {
  const { call, fake, adb } = await connection(t, { adbOptions: { running: false }, hasDex: false });
  adb.setSerial('R5CW');
  const failed = await call('phone_act', { action: { type: 'key', key: 'back' } });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error.message, /before dispatch.*agent dex not built/i);
  assert.deepEqual(fake.requests, []);
});

test('phone_act does not resend input after a protocol failure', async (t) => {
  const reply = agentHandler();
  let corrupt = true;
  const { call, fake } = await connection(t, { handler(r, socket) {
    if (r.op === 'key' && corrupt) {
      corrupt = false;
      const malformed = Buffer.alloc(9);
      malformed.writeUInt32BE(1);
      malformed.write('{', 4);
      socket.write(malformed);
      return null;
    }
    return reply(r);
  } });
  await call('phone_connect');
  assert.equal(images(await call('phone_screen')).length, 1);
  const failed = await call('phone_act', { action: { type: 'key', key: 'back' } });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error.message, /delivery is unknown.*agent sent bad JSON/i);
  const stale = await call('phone_act', { action: { type: 'tap', x: 1, y: 2 } });
  assert.match(stale.structuredContent.error.message, /call screen first/);
  assert.deepEqual(fake.requests.map((r) => r.op), ['hello', 'screen', 'key']);
  const waited = await call('phone_wait', { image: false });
  assert.equal(waited.structuredContent.frame.hash, 'h2');
  assert.equal(fake.requests.at(-1).from, undefined);
});

test('phone_act reports acknowledged input when both settle reads lose their link', async (t) => {
  const reply = agentHandler();
  const { call, fake } = await connection(t, { handler(r, socket) {
    if (r.op === 'wait' && r.image) { socket.destroy(); return null; }
    return reply(r);
  } });
  await call('phone_connect');
  await call('phone_screen');
  const failed = await call('phone_act', { action: { type: 'key', key: 'back' } });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error.message, /agent acknowledged.*settle failed.*verify the phone state/i);
  const stale = await call('phone_act', { action: { type: 'tap', x: 1, y: 2 } });
  assert.match(stale.structuredContent.error.message, /call screen first/);
  assert.deepEqual(fake.requests.map((r) => r.op), ['hello', 'screen', 'key', 'wait', 'hello', 'wait']);
  const waited = await call('phone_wait', { image: false });
  assert.equal(waited.structuredContent.frame.hash, 'h2');
  assert.equal(fake.requests.at(-1).from, undefined);
  assert.equal(images(await call('phone_screen')).length, 1);
});

test('phone_ui reads nodes, finds by selector and can release UiAutomation', async (t) => {
  const { call, fake, adb } = await connection(t);
  adb.setSerial('R5CW'); // An injected controller can already have an exact target.
  const all = await call('phone_ui', { maxNodes: 50 });
  assert.deepEqual(all.structuredContent.nodes, [{ text: 'Wi-Fi', cx: 10, cy: 20 }]);
  await call('phone_ui', { selector: { text: 'wi-fi' }, release: true });
  assert.deepEqual(fake.requests.filter((r) => r.op !== 'hello').map((r) => r.op), ['ui', 'find', 'release']);
  assert.equal(fake.requests.find((r) => r.op === 'find').text, 'wi-fi');
  const empty = await call('phone_ui', { selector: { exact: true } });
  assert.equal(empty.isError, true);
});

test('phone_wait passes until:change and phone_logcat bounds its query', async (t) => {
  const { call, fake, adb } = await connection(t);
  await call('phone_connect');
  await call('phone_screen');
  const waited = await call('phone_wait', { until: 'change', timeoutMs: 500 });
  assert.equal(waited.structuredContent.frame.met, true);
  const wait = fake.requests.find((r) => r.op === 'wait');
  assert.deepEqual([wait.until, wait.image], ['change', true]);
  assert.equal(images(waited).length, 1);
  await call('phone_logcat', { lines: 20, filter: 'ActivityManager:I *:S' });
  assert.ok(adb.calls.some((c) => c[0] === 'exec' && c[1] === 'logcat -d -t 20 ActivityManager:I *:S'));
  const injected = await call('phone_logcat', { filter: 'x; reboot' });
  assert.equal(injected.isError, true);
  assert.equal(adb.calls.some((c) => c[0] === 'exec' && /reboot/.test(c[1])), false);
});

test('metadata-only waits expose metadata without saving an image or enabling image-space input', async (t) => {
  const { call, fake, dir } = await connection(t);
  await call('phone_connect');
  const waited = await call('phone_wait', { image: false });
  assert.deepEqual(waited.structuredContent.frame, {
    hash: 'h2', met: true, frames: 2, changed: true, width: 4, height: 8,
    bytes: 0, file: null, imageIncluded: false,
  });
  assert.deepEqual(waited.content.map((item) => item.type), ['text']);
  assert.equal(fs.existsSync(path.join(dir, 'frames')), false);
  const tap = await call('phone_act', { action: { type: 'tap', x: 1, y: 1 } });
  assert.equal(tap.isError, true);
  assert.match(tap.structuredContent.error.message, /call screen first/);
  assert.equal(fake.requests.some((r) => r.op === 'tap'), false);
  const deviceTap = await call('phone_act', { action: { type: 'tap', x: 3, y: 4, space: 'device' } });
  assert.equal(images(deviceTap).length, 1);
  const deviceRequest = fake.requests.find((r) => r.op === 'tap');
  assert.deepEqual([deviceRequest.x, deviceRequest.y], [3, 4]);

  const imaged = await call('phone_wait', { image: true });
  assert.equal(images(imaged).length, 1);
  assert.ok(fs.existsSync(imaged.structuredContent.frame.file));
  const waits = fake.requests.filter((r) => r.op === 'wait');
  assert.deepEqual(waits.map((r) => [r.image, r.from]), [[false, undefined], [true, 'h2'], [true, 'h2']]);
});

test('metadata-only waits keep matching geometry and invalidate it when the final frame differs', async (t) => {
  const handler = agentHandler((r, hash) => r.timeoutMs === 500
    ? { hash: 'h2', met: false }
    : { hash, changed: !r.image });
  const { call, fake, dir } = await connection(t, { handler });
  const tap = { type: 'tap', x: 1, y: 1 };
  const swipe = { type: 'swipe', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } };
  await call('phone_connect');
  await call('phone_screen');

  const stable = await call('phone_wait', { image: false });
  assert.equal(stable.structuredContent.frame.changed, true);
  assert.equal(stable.structuredContent.frame.hash, 'h1');
  assert.equal(images(await call('phone_screen')).length, 0);
  assert.equal(images(await call('phone_act', { action: tap })).length, 1);

  const timedOut = await call('phone_wait', { image: false, timeoutMs: 500 });
  assert.equal(timedOut.structuredContent.frame.met, false);
  assert.equal(timedOut.structuredContent.frame.hash, 'h2');
  assert.equal(images(timedOut).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'frames')).length, 2);
  const requestCount = fake.requests.length;
  for (const action of [tap, swipe]) {
    const rejected = await call('phone_act', { action });
    assert.equal(rejected.isError, true);
    assert.match(rejected.structuredContent.error.message, /call screen first/);
  }
  assert.equal(fake.requests.length, requestCount);
  await call('phone_wait', { image: false });
  assert.equal(fake.requests.at(-1).from, 'h2');

  const refreshed = await call('phone_screen');
  assert.equal(images(refreshed).length, 1);
  assert.equal(fake.requests.at(-1).ifChangedFrom, undefined);
  assert.equal(images(await call('phone_screen')).length, 0);
});

test('capture fallback sends a fresh image and invalidates old image coordinates', async (t) => {
  let backend = 'compositor';
  const handler = (request) => {
    if (request.op === 'hello') return hello;
    const header = { hash: 'same', width: 4, height: 8, captureBackend: backend };
    if (request.op === 'wait') return { header: { ...header, met: true, changed: false } };
    if (request.ifChangedFrom === header.hash && request.ifChangedFromBackend === backend) {
      return { header: { ...header, changed: false } };
    }
    return { header: { ...header, format: 'jpeg', scale: 0.5, regionX: 0, regionY: 0 }, payload: jpeg };
  };
  const { call, fake } = await connection(t, { handler });
  await call('phone_connect');
  assert.equal(images(await call('phone_screen')).length, 1);
  assert.equal(images(await call('phone_screen')).length, 0);

  backend = 'screencap';
  const fallback = await call('phone_screen');
  assert.equal(fake.requests.at(-1).ifChangedFromBackend, 'compositor');
  assert.equal(fallback.structuredContent.frame.captureBackend, 'screencap');
  assert.equal(images(fallback).length, 1);

  backend = 'compositor';
  await call('phone_screen', { force: true });
  backend = 'screencap';
  const waited = await call('phone_wait', { image: false });
  assert.equal(fake.requests.at(-1).fromBackend, 'compositor');
  assert.equal(waited.structuredContent.frame.captureBackend, 'screencap');
  const tap = await call('phone_act', { action: { type: 'tap', x: 1, y: 1 } });
  assert.match(tap.structuredContent.error.message, /call screen first/);
  assert.equal(fake.requests.some(request => request.op === 'tap'), false);
  await call('phone_wait', { image: false });
  assert.equal(fake.requests.at(-1).fromBackend, 'screencap');
});

test('scaled captures keep the wait baseline and map rounded image axes independently', async (t) => {
  let basis = 'compositor:1440x3088:448x960:0:72';
  const { call, fake } = await connection(t, { handler(request) {
    if (request.op === 'hello') return hello;
    if (request.op === 'tap') return { header: {} };
    const header = { hash: 'same', hashBasis: basis, captureMaxSide: 960, width: 1440, height: 3088,
      captureBackend: 'compositor', format: 'jpeg', scale: 448 / 1440, scaleY: 960 / 3088, regionX: 0, regionY: 0, met: true };
    return { header, payload: jpeg };
  } });
  await call('phone_connect');
  await call('phone_screen', { maxSide: 960 });
  await call('phone_screen', { maxSide: 960 });
  assert.equal(fake.requests.at(-1).ifChangedFromBasis, basis);
  const action = { type: 'tap', x: 200, y: 950 };
  assert.ok(!(await call('phone_act', { action, until: 'change', maxSide: 1280 })).isError);
  assert.equal(fake.requests.find(request => request.op === 'tap').y, 3056);
  assert.equal(fake.requests.at(-1).fromBasis, basis);
  assert.equal(fake.requests.at(-1).fromMaxSide, 960);
  assert.equal(fake.requests.at(-1).maxSide, 1280);
  basis = 'compositor:1440x3088:448x960:2:72';
  await call('phone_wait', { image: false });
  assert.ok((await call('phone_act', { action })).isError);
  assert.equal(fake.requests.filter(request => request.op === 'tap').length, 1);
});

test('image-space input requires a fresh frame after a metadata-only wait fails', async (t) => {
  const received = Promise.withResolvers();
  const defaultHandler = agentHandler();
  const { call, fake } = await connection(t, {
    handler(r, socket) {
      if (r.op === 'wait' && r.image === false) {
        received.resolve(() => socket.write(frame({ id: r.id, ok: false, error: 'capture failed' })));
        return;
      }
      return defaultHandler(r);
    },
  });
  const tap = { type: 'tap', x: 1, y: 1 };
  await call('phone_connect');
  await call('phone_screen');
  const waiting = call('phone_wait', { image: false });
  const failWait = await Promise.race([
    received.promise,
    waiting.then(() => { throw new Error('metadata wait did not reach the agent'); }),
  ]);
  try {
    const rejected = await call('phone_act', { action: tap });
    assert.equal(rejected.isError, true);
    assert.match(rejected.structuredContent.error.message, /metadata-only wait is in progress/);
    assert.equal(fake.requests.some((r) => r.op === 'tap'), false);
  } finally {
    failWait();
  }
  assert.equal((await waiting).isError, true);
  const stale = await call('phone_act', { action: tap });
  assert.equal(stale.isError, true);
  assert.match(stale.structuredContent.error.message, /call screen first/);
  assert.equal(fake.requests.some((r) => r.op === 'tap'), false);
  assert.equal(images(await call('phone_screen')).length, 1);
  assert.equal(images(await call('phone_act', { action: tap })).length, 1);
});

test('closing the server stops the agent and removes its dex', async (t) => {
  const { call, server, adb } = await connection(t);
  await call('phone_connect');
  await server.close();
  assert.deepEqual(adb.calls.filter((c) => c[0] === 'exec').map((c) => c[1]), ['kill 4242', 'rm -f /data/local/tmp/trace-phone.dex']);
});

test('closing a server that never used the agent leaves the phone alone', async (t) => {
  const { server, adb } = await connection(t);
  await server.close();
  assert.deepEqual(adb.calls.filter((c) => c[0] === 'exec'), []);
});

test('toControllerAction maps keys, text, swipes and selectors', () => {
  assert.deepEqual(toControllerAction({ type: 'key', key: 'back' }), { key: KEYS.back });
  assert.deepEqual(toControllerAction({ type: 'key', key: 66 }), { key: 66 });
  assert.deepEqual(toControllerAction({ type: 'text', text: 'hi' }), { action: 'text', value: 'hi' });
  assert.deepEqual(toControllerAction({ type: 'long_press', selector: { text: 'A' } }), { action: 'long_press', target: { selector: { text: 'A' } } });
  assert.deepEqual(toControllerAction({ type: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, space: 'device' }),
    { swipe: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: undefined, space: 'device' } });
});

test('build helpers pick the newest SDK platform and build-tools that contain the file', () => {
  const dir = tempDir();
  try {
    for (const [name, has] of [['android-9', true], ['android-36', true], ['android-37', false], ['android-xyz', true]]) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      if (has) fs.writeFileSync(path.join(dir, name, 'android.jar'), '');
    }
    const key = (name) => { const m = /^android-(\d+)$/.exec(name); return m && [Number(m[1])]; };
    assert.equal(newest(dir, 'android.jar', key), path.join(dir, 'android-36', 'android.jar'));
    assert.throws(() => newest(path.join(dir, 'missing'), 'android.jar', key), /No android\.jar/);
    assert.ok(compare([37, 0, 0], [36, 1]) > 0);
    assert.ok(compare([36], [36, 0, 1]) < 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('phone_transcribe defaults to base.en and reports transcriber failures as tool errors', async (t) => {
  const calls = [];
  const transcribe = async (request) => {
    calls.push(request);
    if (request.path.endsWith('missing.wav')) throw new Error('phone-transcribe failed: no such file');
    return { text: 'open termux and run the phone bench', model: request.model, audioSeconds: 2.86, elapsedSeconds: 3.55 };
  };
  const { call, adb, server } = await connection(t, { transcribe });
  const ok = await call('phone_transcribe', { path: '/root/clip.m4a' });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(ok.structuredContent, { text: 'open termux and run the phone bench', model: 'base.en', audioSeconds: 2.86, elapsedSeconds: 3.55 });
  assert.deepEqual(calls[0], { path: '/root/clip.m4a', model: 'base.en', timeoutMs: 120000 });
  const failed = await call('phone_transcribe', { path: '/root/missing.wav', model: 'small.en' });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error.message, /no such file/);
  const rejected = await call('phone_transcribe', { path: '/root/clip.m4a', model: 'large-v3' });
  assert.equal(rejected.isError, true);
  assert.equal(calls.length, 2);
  await server.close();
  assert.deepEqual(adb.calls, []);
});

test('commandTranscriber passes --json, the model and the path, and reads the last JSON line', async () => {
  const echo = 'const a = process.argv.slice(1); if (a.includes("bad.wav")) { console.error("phone-transcribe: no such file: bad.wav"); process.exit(2); }'
    + ' console.log("log line"); console.log(JSON.stringify({ text: a.join(" "), model: "base.en", audioSeconds: 1, elapsedSeconds: 0.5 }));';
  const transcribe = commandTranscriber({ command: JSON.stringify([process.execPath, '-e', echo, '--']) });
  const out = await transcribe({ path: 'a b.wav', model: 'tiny.en', timeoutMs: 10000 });
  assert.equal(out.text, '--json --model tiny.en -- a b.wav');
  await assert.rejects(transcribe({ path: 'bad.wav', model: 'base.en', timeoutMs: 10000 }), /phone-transcribe failed: phone-transcribe: no such file: bad\.wav/);
  assert.throws(() => commandTranscriber({ command: 'phone-transcribe --json' }), /JSON array/);
  assert.throws(() => commandTranscriber({ command: '[]' }), /JSON array/);
});

test('phone CLI prints help and rejects unknown commands without touching adb', () => {
  const bin = path.join(__dirname, '..', 'bin', 'trace.cjs');
  const help = spawnSync(process.execPath, [bin, 'phone', '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /trace-workbench phone mcp/);
  const bad = spawnSync(process.execPath, [bin, 'phone', 'reboot'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(bad.status, 0);
});

test('trace-phone skill manifest hashes match the bundled files', () => {
  const { createHash } = require('node:crypto');
  const folder = path.join(__dirname, '..', 'skills', 'trace-phone');
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'trace.skill-bundle/1');
  assert.equal(manifest.name, 'trace-phone');
  for (const [file, digest] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(folder, file))).digest('hex'), digest, file);
  }
  assert.match(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8'), /^---\nname: trace-phone\n/);
});
