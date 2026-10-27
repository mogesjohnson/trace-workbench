'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const common = require('./replacement-acceptance-common.cjs');
const continuation = require('./continuation-adapter.cjs');
const { DesktopLease } = require('../src/computer/lease.cjs');
const ROOT = path.resolve(__dirname, '..');
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function leaseFree() {
  const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
  await lease.acquire('replay-pause-check'); await lease.release('replay-pause-check'); return true;
}
async function sourceSnapshot() {
  const source = await common.sourceHashes('scripts/replay-pause-runtime.cjs'), files = { ...source.files };
  for (const name of ['scripts/accept-replay-pause.cjs', 'scripts/replay-pause-runtime.cjs',
    'scripts/replay-pause-adapter.cjs', 'scripts/replay-pause-support.cjs', 'scripts/replay-pause-assets.cjs', 'scripts/narrow-finish-budget.cjs',
    'scripts/replay-workflow-runtime.cjs', 'scripts/accept-replay-workflow.cjs', 'scripts/replacement-acceptance-common.cjs']) {
    files[name] = common.digest(await fs.readFile(path.join(ROOT, name)));
  }
  for (const name of ['scripts/media-inspection-smoke.cjs', 'electron/engine.cjs'])
    files[`replay/${name}`] = common.digest(await fs.readFile(path.resolve(ROOT, '../replay-studio', name)));
  return { ...source, files, native: await continuation.runtimeSnapshot() };
}
async function frame(directory, session, identity, value, label) {
  if (value?.sessionId !== session.sessionId || !/^[a-f0-9-]{36}$/.test(value.observationId ?? '')) throw new Error('TRACE observation mismatch');
  common.assertIdentity(value.window, { ...identity, id: identity.windowId });
  const image = value.screenshot, bytes = Buffer.from(image?.data ?? '', 'base64');
  if (image?.mimeType !== 'image/png' || common.digest(bytes) !== image.sha256 || bytes.length < 24 || bytes.length > 6 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height ||
    image.width !== value.bounds?.width || image.height !== value.bounds?.height) throw new Error('TRACE PNG invalid');
  const filename = `${label}-${value.observationId}.png`;
  await fs.writeFile(path.join(directory, filename), bytes, { flag: 'wx' });
  return { id: value.observationId, sha256: image.sha256, at: Date.parse(value.observedAt), width: image.width, height: image.height, filename };
}
async function closeTrace(trace, chain, deps = { ...common, leaseFree }) {
  const errors = [], check = async work => { try { await work(); } catch (error) { errors.push(error.message); } };
  let owned = chain ? Object.values(chain) : trace.nodeIdentity ? [trace.nodeIdentity] : [];
  if (!chain) await check(async () => { owned = await deps.readOwned(trace); });
  await check(() => trace.close());
  for (const identity of owned) await check(async () => { if (!await deps.waitIdentityExit(identity)) throw Error('Owned TRACE exit unconfirmed'); });
  await check(async () => { if ((await deps.command(['keystate', 'all'])).down?.length !== 0) throw Error('Input release unconfirmed'); });
  await check(async () => { if ((await deps.command(['status'])).recoveryRequired !== false) throw Error('Recovery unconfirmed'); });
  await check(async () => { if (!await deps.leaseFree()) throw Error('Lease not free'); });
  if (errors.length) throw Error(errors.join('; '));
  return true;
}
module.exports = { atomic, leaseFree, sourceSnapshot, frame, closeTrace };
