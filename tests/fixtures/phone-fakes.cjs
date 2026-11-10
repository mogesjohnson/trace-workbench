'use strict';

// Fakes for TRACE Phone tests: a framed agent socket and an adb client whose
// abstract socket reaches it. No device or adb server is touched.

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AGENT_VERSION } = require('../../src/agentic-phone/agent.cjs');

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
function fakeAdb(port, { running = true, devices = [{ serial: 'R5CW', state: 'device' }] } = {}) {
  const calls = [];
  let serial = null;
  return {
    calls,
    get running() { return running; },
    get serial() { return serial; },
    setSerial(value) { calls.push(['serial', value]); serial = value; },
    async devices() { return devices; },
    async connect(address) {
      calls.push(['connect', address]);
      devices = [...devices, { serial: address, state: 'device' }];
      return `connected to ${address}`;
    },
    async pair(address, code) { calls.push(['pair', address, code]); return `Successfully paired to ${address}`; },
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
      setImmediate(() => out.emit('data', Buffer.from(`trace-phone agent ${AGENT_VERSION} listening on @trace-phone\n`)));
      return out;
    },
    async exec(command) { calls.push(['exec', command]); return Buffer.from(''); },
  };
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-phone-')); }

const hello = { header: { version: AGENT_VERSION, sdk: 37, pid: 4242 } };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

module.exports = { frame, fakeAgent, fakeAdb, tempDir, hello, jpeg };
