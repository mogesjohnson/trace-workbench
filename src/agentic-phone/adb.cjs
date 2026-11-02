'use strict';

// Minimal client for the adb server's smart-socket protocol (127.0.0.1:5037).
// Each request is a 4-hex-digit length plus the command; the server answers
// OKAY or FAIL<len><message>. Talking to the server directly avoids spawning
// adb.exe per call. Protocol: AOSP packages/modules/adb/SERVICES.TXT, SYNC.TXT.

const net = require('node:net');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5037;

function encode(command) {
  const body = Buffer.from(command, 'utf8');
  if (body.length > 0xffff) throw new Error('adb command too long');
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** Buffered reader over a socket: read(n) resolves with exactly n bytes. */
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.error = null;
    this.waiter = null;
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake(); });
    socket.on('end', () => { this.ended = true; this.wake(); });
    socket.on('close', () => { this.ended = true; this.wake(); });
    socket.on('error', (error) => { this.error = error; this.wake(); });
  }

  wake() { const w = this.waiter; this.waiter = null; if (w) w(); }

  async read(n) {
    while (this.buffer.length < n) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error(`adb connection closed (wanted ${n} bytes, had ${this.buffer.length})`);
      await new Promise((resolve) => { this.waiter = resolve; });
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async readAll() {
    while (!this.ended) {
      if (this.error) throw this.error;
      await new Promise((resolve) => { this.waiter = resolve; });
    }
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }

  /** Hand the remaining stream to a new owner (an agent client). */
  detach() {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('end');
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('error');
    return this.buffer;
  }
}

async function status(reader) {
  const word = (await reader.read(4)).toString('ascii');
  if (word === 'OKAY') return;
  if (word === 'FAIL') {
    const length = parseInt((await reader.read(4)).toString('ascii'), 16);
    throw new Error(`adb: ${(await reader.read(length)).toString('utf8')}`);
  }
  throw new Error(`adb: unexpected reply ${JSON.stringify(word)}`);
}

async function lengthPrefixed(reader) {
  const length = parseInt((await reader.read(4)).toString('ascii'), 16);
  return (await reader.read(length)).toString('utf8');
}

function createAdbClient({ host = DEFAULT_HOST, port = DEFAULT_PORT, serial = null, timeoutMs = 10000 } = {}) {
  function open() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('adb server connect timed out')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); socket.setNoDelay(true); resolve({ socket, reader: new Reader(socket) }); });
      socket.once('error', (error) => { clearTimeout(timer); reject(new Error(`adb server unreachable at ${host}:${port}: ${error.message}`)); });
    });
  }

  /** Host request answered by OKAY + length-prefixed text. */
  async function hostQuery(command) {
    const { socket, reader } = await open();
    try {
      socket.write(encode(command));
      await status(reader);
      return await lengthPrefixed(reader);
    } finally { socket.destroy(); }
  }

  /** Switch a fresh connection to the device transport, then open a service on it. */
  async function service(name) {
    const { socket, reader } = await open();
    try {
      socket.write(encode(serial ? `host:transport:${serial}` : 'host:transport-any'));
      await status(reader);
      socket.write(encode(name));
      await status(reader);
      return { socket, reader };
    } catch (error) { socket.destroy(); throw error; }
  }

  return {
    get serial() { return serial; },
    setSerial(value) { serial = value || null; },
    async version() { return parseInt(await hostQuery('host:version'), 16); },
    async devices() {
      const text = await hostQuery('host:devices-l');
      return text.split('\n').filter(Boolean).map((line) => {
        const [id, state, ...rest] = line.trim().split(/\s+/);
        const info = { serial: id, state };
        for (const part of rest) { const i = part.indexOf(':'); if (i > 0) info[part.slice(0, i)] = part.slice(i + 1); }
        return info;
      });
    },
    async connect(address) { return hostQuery(`host:connect:${address}`); },
    async pair(address, code) { return hostQuery(`host:pair:${code}:${address}`); },
    async mdnsServices() { return hostQuery('host:mdns:services'); },
    /** Run a command and return stdout (exec: is binary-safe, no pty). */
    async exec(command) {
      const { socket, reader } = await service(`exec:${command}`);
      try { return await reader.readAll(); } finally { socket.destroy(); }
    },
    /** Start a command that keeps running; resolves once adbd accepted it. */
    async spawn(command) {
      const { socket } = await service(`exec:${command}`);
      return socket;
    },
    /** Open a raw stream to a device-local abstract socket (no TCP forward needed). */
    async openAbstract(name) {
      const { socket, reader } = await service(`localabstract:${name}`);
      const leftover = reader.detach();
      return { socket, leftover };
    },
    /** Push bytes to a device path with the sync protocol. */
    async push(data, remotePath, mode = 0o644) {
      const { socket, reader } = await service('sync:');
      try {
        const header = (id, length) => { const b = Buffer.alloc(8); b.write(id, 0, 'ascii'); b.writeUInt32LE(length, 4); return b; };
        const spec = Buffer.from(`${remotePath},${0o100000 | mode}`, 'utf8');
        socket.write(Buffer.concat([header('SEND', spec.length), spec]));
        for (let offset = 0; offset < data.length; offset += 64 * 1024) {
          const chunk = data.subarray(offset, offset + 64 * 1024);
          socket.write(Buffer.concat([header('DATA', chunk.length), chunk]));
        }
        socket.write(header('DONE', Math.floor(Date.now() / 1000)));
        const reply = await reader.read(8);
        const id = reply.toString('ascii', 0, 4);
        if (id === 'FAIL') throw new Error(`adb push: ${(await reader.read(reply.readUInt32LE(4))).toString('utf8')}`);
        if (id !== 'OKAY') throw new Error(`adb push: unexpected reply ${id}`);
        socket.write(header('QUIT', 0));
      } finally { socket.destroy(); }
    },
  };
}

module.exports = { createAdbClient, encode, DEFAULT_PORT };
