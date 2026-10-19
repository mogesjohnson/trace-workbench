'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');

const leaseError = (code, message) => Object.assign(new Error(message), { code });

// Windows releases this exclusive named pipe after process termination. The
// endpoint accepts no commands or data; it only arbitrates desktop ownership.
class DesktopLease {
  constructor(directory) {
    const key = createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 32);
    this.address = process.platform === 'win32' ? `\\\\.\\pipe\\trace-computer-${key}` : path.join(os.tmpdir(), `trace-computer-${key}.sock`);
    this.owner = null;
    this.server = null;
  }

  async acquire(sessionId) {
    if (this.owner) throw leaseError('desktop_busy', 'This controller already owns a desktop session. Close it first.');
    const server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      const onError = error => reject(leaseError(['EADDRINUSE', 'EACCES'].includes(error.code) ? 'desktop_busy' : 'lease_unavailable', 'Another TRACE controller owns the desktop, or desktop ownership is unavailable. Close that session first.'));
      server.once('error', onError);
      server.listen({ path: this.address, exclusive: true }, () => { server.removeListener('error', onError); resolve(); });
    });
    this.server = server;
    this.owner = { token: randomUUID(), sessionId };
    server.on('error', () => { this.owner = null; });
  }

  async assert(sessionId) {
    if (!this.owner || this.owner.sessionId !== sessionId || !this.server?.listening) throw leaseError('lease_lost', 'Desktop ownership is unavailable. Open a new session before input.');
  }

  async release(sessionId) {
    if (!this.owner || this.owner.sessionId !== sessionId) return;
    const server = this.server;
    this.owner = null;
    this.server = null;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (process.platform !== 'win32') await fs.unlink(this.address).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

module.exports = { DesktopLease };
