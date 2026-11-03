'use strict';

// Client for the on-device trace-phone agent (src/agentic-phone/native).
// Framing: request = u32be length + JSON; reply = u32be length + JSON header,
// then u32be length + binary payload. Requests are answered in order.

const AGENT_VERSION = '1';
const MAX_FRAME = 64 << 20;

function createAgentClient(socket, leftover = Buffer.alloc(0)) {
  let buffer = leftover;
  let closed = null;
  let nextId = 1;
  const waiters = [];

  function fail(error) {
    if (closed) return;
    closed = error;
    while (waiters.length) { const w = waiters.shift(); clearTimeout(w.timer); w.reject(error); }
  }

  function pump() {
    while (waiters.length && buffer.length >= 4) {
      const headerLength = buffer.readUInt32BE(0);
      if (headerLength > MAX_FRAME) { fail(new Error('agent sent an oversized header')); socket.destroy(); return; }
      if (buffer.length < 8 + headerLength) return;
      const payloadLength = buffer.readUInt32BE(4 + headerLength);
      if (payloadLength > MAX_FRAME) { fail(new Error('agent sent an oversized payload')); socket.destroy(); return; }
      if (buffer.length < 8 + headerLength + payloadLength) return;
      let header;
      try { header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8')); }
      catch (error) { fail(new Error(`agent sent bad JSON: ${error.message}`)); socket.destroy(); return; }
      const payload = Buffer.from(buffer.subarray(8 + headerLength, 8 + headerLength + payloadLength));
      buffer = buffer.subarray(8 + headerLength + payloadLength);
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      if (header.ok === false) waiter.reject(Object.assign(new Error(`agent: ${header.error}`), { header }));
      else waiter.resolve({ header, payload });
    }
  }

  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); pump(); });
  socket.on('error', (error) => fail(error));
  socket.on('close', () => fail(new Error('agent connection closed')));

  return {
    get closed() { return Boolean(closed); },
    call(request, { timeoutMs = 30000 } = {}) {
      if (closed) return Promise.reject(closed);
      const body = Buffer.from(JSON.stringify({ id: nextId++, ...request }), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          fail(new Error(`agent did not answer ${request.op} within ${timeoutMs} ms`));
          socket.destroy();
        }, timeoutMs);
        waiters.push(waiter);
        socket.write(Buffer.concat([head, body]));
        pump();
      });
    },
    close() { socket.destroy(); },
  };
}

module.exports = { createAgentClient, AGENT_VERSION };
