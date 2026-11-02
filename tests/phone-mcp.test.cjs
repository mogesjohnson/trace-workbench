'use strict';

// TRACE Phone MCP server and agent build helpers. The server runs on the real
// controller over a fake adb client and a fake agent socket; no device is used.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createPhoneServer, toControllerAction, KEYS } = require('../src/phone/server.cjs');
const { createPhoneController } = require('../src/agentic-phone/controller.cjs');
const { newest, compare } = require('../src/agentic-phone/build.cjs');
const { fakeAgent, fakeAdb, tempDir, hello, jpeg } = require('./fixtures/phone-fakes.cjs');

const TOOLS = ['phone_act', 'phone_connect', 'phone_logcat', 'phone_screen', 'phone_ui', 'phone_wait'];

function agentHandler() {
  let hash = 'h1';
  return (r) => {
    if (r.op === 'hello') return hello;
    if (r.op === 'screen') {
      if (r.ifChangedFrom === hash) return { header: { hash, changed: false } };
      return { header: { hash, changed: true, format: 'jpeg', scale: 0.5, regionX: 0, regionY: 0, width: 4, height: 8 }, payload: jpeg };
    }
    if (r.op === 'wait') { hash = 'h2'; return { header: { hash, met: true, format: 'jpeg', scale: 0.5, regionX: 0, regionY: 0 }, payload: jpeg }; }
    if (r.op === 'ui' || r.op === 'find') return { header: { count: 1 }, payload: Buffer.from('[{"text":"Wi-Fi","cx":10,"cy":20}]') };
    return { header: { done: r.op } };
  };
}

async function connection(t, { adbOptions } = {}) {
  const fake = await fakeAgent(agentHandler());
  const dir = tempDir();
  const dexPath = path.join(dir, 'classes.dex');
  fs.writeFileSync(dexPath, 'dex');
  const adb = fakeAdb(fake.port, adbOptions);
  const controller = createPhoneController({ adb, dexPath, framesDir: path.join(dir, 'frames') });
  const server = createPhoneServer({ controller });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'trace-phone-test', version: '1.0.0' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); fake.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, server, call, adb, fake, dir };
}

const images = (result) => result.content.filter((c) => c.type === 'image');

test('phone server lists exactly the six phone tools with read-only hints where safe', async (t) => {
  const { client } = await connection(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);
  const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
  assert.deepEqual(hints, { phone_act: false, phone_connect: false, phone_logcat: true, phone_screen: true, phone_ui: true, phone_wait: true });
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
  const badCode = await call('phone_connect', { pairCode: '12ab56' });
  assert.equal(badCode.isError, true);
});

test('phone_screen returns the image only when the screen changed, unless forced', async (t) => {
  const { call } = await connection(t);
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
  const early = await call('phone_act', { action: { type: 'tap', x: 1, y: 1 } });
  assert.equal(early.isError, true);
  assert.match(early.structuredContent.error.message, /no frame yet/);
  await call('phone_screen');
  const result = await call('phone_act', { action: { type: 'tap', x: 10, y: 20 }, stableMs: 200 });
  assert.notEqual(result.isError, true);
  const tap = fake.requests.find((r) => r.op === 'tap');
  assert.deepEqual([tap.x, tap.y], [20, 40]);
  const wait = fake.requests.find((r) => r.op === 'wait');
  assert.deepEqual([wait.until, wait.stableMs, wait.from], ['stable', 200, 'h1']);
  assert.equal(result.structuredContent.action.done, 'tap');
  assert.equal(result.structuredContent.frame.met, true);
  assert.equal(images(result).length, 1);
  const unknown = await call('phone_act', { action: { type: 'tap' } });
  assert.equal(unknown.isError, true);
});

test('phone_ui reads nodes, finds by selector and can release UiAutomation', async (t) => {
  const { call, fake } = await connection(t);
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
  await call('phone_screen');
  const waited = await call('phone_wait', { until: 'change', timeoutMs: 500 });
  assert.equal(waited.structuredContent.frame.met, true);
  assert.deepEqual(fake.requests.find((r) => r.op === 'wait').until, 'change');
  await call('phone_logcat', { lines: 20, filter: 'ActivityManager:I *:S' });
  assert.ok(adb.calls.some((c) => c[0] === 'exec' && c[1] === 'logcat -d -t 20 ActivityManager:I *:S'));
  const injected = await call('phone_logcat', { filter: 'x; reboot' });
  assert.equal(injected.isError, true);
  assert.equal(adb.calls.some((c) => c[0] === 'exec' && /reboot/.test(c[1])), false);
});

test('closing the server stops the agent and removes its dex', async (t) => {
  const { call, server, adb } = await connection(t);
  await call('phone_screen');
  await server.close();
  assert.deepEqual(adb.calls.filter((c) => c[0] === 'exec').map((c) => c[1]), ['kill 4242', 'rm -f /data/local/tmp/trace-phone.dex']);
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
