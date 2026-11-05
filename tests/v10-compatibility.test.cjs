'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { createComputerServer } = require('../src/computer/server.cjs');
const { actionSupport, compactSupport } = require('../src/computer/action-contract.cjs');
const { createTraceProvider } = require('../src/method/index.cjs');

const stubController = doctor => ({
  doctor, async listWindows() { return { windows: [] }; }, async launch() {}, async openSession() {},
  async observe() {}, async act() {}, async closeSession() {}, async close() {},
});

async function connect(t, doctor) {
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createComputerServer({ controller: stubController(doctor) });
  await server.connect(b);
  const client = new Client({ name: 'v10-compatibility-test', version: '1' }); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

// A server whose compact digest differs from this adapter's, as after an additive descriptor change.
function changedServer(full) {
  const calls = [];
  return { calls, async doctor({ verbose } = {}) {
    calls.push(verbose === true);
    return verbose ? { ready: true, ...full } : { ready: true, support: { ...compactSupport(), sha256: '0'.repeat(64) } };
  } };
}

async function doctorThrough(t, doctor) {
  const client = await connect(t, doctor);
  return createTraceProvider({ client, app: 'fixture', windowId: 'parent' }).doctor();
}

test('item 20: the adapter reads the full descriptor only when the compact digest differs', async t => {
  const calls = [];
  const matching = await doctorThrough(t, async ({ verbose } = {}) => { calls.push(verbose === true); return { ready: true, support: compactSupport() }; });
  assert.equal(matching.ready, true);
  assert.deepEqual(calls, [false]);

  const additive = changedServer({ support: { ...actionSupport(), futureField: true } });
  const accepted = await doctorThrough(t, additive.doctor);
  assert.equal(accepted.ready, true);
  assert.deepEqual(additive.calls, [false, true]);
  assert.deepEqual(accepted.support, actionSupport());
});

test('item 20: the digest fallback never accepts what the full match refuses', async t => {
  const pinned = actionSupport().engine;
  for (const full of [
    { support: { ...actionSupport(), limits: { ...actionSupport().limits, text: 100 } } },
    { support: { ...actionSupport(), engine: { ...pinned, version: `${pinned.version}.1` } } },
    { support: { ...actionSupport(), contractVersion: 2 } },
    { support: { ...compactSupport(), sha256: '0'.repeat(64) } },
    {},
  ]) {
    const result = await doctorThrough(t, changedServer(full).doctor);
    assert.equal(result.ready, false);
    assert.equal(result.code, 'support-unsupported');
  }
});

test('item 20: the contract lists exactly the registered tools', async t => {
  const client = await connect(t, async () => ({ ready: true }));
  const registered = (await client.listTools()).tools.map(tool => tool.name).sort();
  const contract = fs.readFileSync(path.join(__dirname, '..', 'docs', 'COMPATIBILITY.md'), 'utf8');
  const sentence = contract.split('\n').find(line => line.startsWith('The seven tools are '));
  assert.deepEqual(sentence.match(/trace_computer_[a-z_]+/g).sort(), registered);
});
