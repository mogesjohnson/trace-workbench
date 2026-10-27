'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { posix, win32 } = require('node:path');
const { fail, text } = require('./shared.cjs');
const absolute = path => text(path) && (posix.isAbsolute(path) || win32.isAbsolute(path));

function createLocalArtifactProvider({ environment = 'local', id = `filesystem:${environment}` } = {}) {
  return { id, channel: 'app-connector', usesDesktop: false, available: true,
    environments: [environment], apps: ['filesystem'], capabilities: ['file-identity'],
    async fileIdentity({ environment: requested, path }) {
      if (requested !== environment || !absolute(path)) fail('invalid-artifact', 'Use an absolute path in the configured environment.');
      let handle;
      try {
        handle = await fs.open(path, 'r'); const before = await handle.stat({ bigint:true });
        if (!before.isFile()) fail('invalid-artifact', 'The artifact must be a regular file.');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat({ bigint:true }), current = await fs.stat(path,{ bigint:true });
        if (['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]||before[key]!==current[key])) {
          fail('artifact-changed', 'File or named path changed while its identity was read.');
        }
        const bytes=Number(after.size);
        if(!Number.isSafeInteger(bytes))fail('artifact-too-large','Byte count exceeds exact JSON integer range.');
        return { exists: true, sha256: hash.digest('hex'), bytes };
      } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
      finally { await handle?.close(); }
    } };
}
async function verifyArtifactHandoff(registry, { source, destination, expectedSha256, expectedBytes }) {
  if (![source, destination].every(ref => ref && text(ref.environment) && absolute(ref.path))) {
    fail('invalid-artifact', 'Source and receiving artifact need explicit environments and absolute paths.');
  }
  const inspect = async ref => {
    const { provider } = registry.select({ target: { environment: ref.environment, app: 'filesystem', kind: 'app' },
      capability: 'file-identity', lifecycle: false });
    if (typeof provider.fileIdentity !== 'function') fail('identity-unavailable', 'Selected provider cannot inspect file content.');
    const identity = await provider.fileIdentity(ref);
    if (identity?.exists !== true) fail('artifact-missing', 'Artifact does not exist in its named environment.');
    if (!/^[a-f0-9]{64}$/i.test(identity.sha256 || '') || !Number.isSafeInteger(identity.bytes) || identity.bytes < 0) {
      fail('identity-unverified', 'Content identity requires SHA-256 and exact byte count.');
    }
    return { sha256: identity.sha256.toLowerCase(), bytes: identity.bytes };
  };
  const a = await inspect(source), b = await inspect(destination);
  if (a.sha256 !== b.sha256 || a.bytes !== b.bytes || (expectedSha256 && a.sha256 !== expectedSha256.toLowerCase())
    || (expectedBytes !== undefined && a.bytes !== expectedBytes)) fail('artifact-mismatch', 'Receiving bytes differ from the requested artifact.');
  return { source, destination, ...a, verified: true, transferPerformed: false };
}
module.exports = { createLocalArtifactProvider, verifyArtifactHandoff };
