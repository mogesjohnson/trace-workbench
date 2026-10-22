'use strict';

// Acceptance preparation only: no input, recovery apply, build or attempt claim.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const continuation = require('./continuation-adapter.cjs');
const ROOT = path.resolve(__dirname, '..');
const CASES = ['A32-QUARANTINE-ACK-TYPING', 'METHOD-CLIPBOARD-UNICODE-PASTE'];
const fail = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fail(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const identityFields = ['id', 'pid', 'processCreationTime', 'sessionId'];
const same = (a, b) => identityFields.every(field => a?.[field] === b?.[field]);
function plan() {
  return { preparationOnly: true, claimsAttempt: false, cases: CASES, inputActions: 0,
    foreground: 'Select the ordinary owned anchor manually; this wrapper never activates or injects input.',
    readiness: 'Supply fresh direct-owner evidence after this exact anchor exists; one read-only preflight follows.',
    cleanup: 'Explicit close requires fresh independent downstream cleanup evidence and read-only safety checks. Unknown ownership remains held.' };
}
function parse(args) {
  const options = { mode: 'plan' }, modes = ['--plan', '--start', '--status', '--confirm-ready', '--close'];
  const fields = { '--id': 'id', '--case': 'caseId', '--owner-record': 'ownerRecord', '--cleanup-ref': 'cleanupRef' };
  let selected = false;
  for (let i = 0; i < args.length; i++) {
    if (modes.includes(args[i])) { need(!selected, 'anchor_one_mode_required'); selected = true; options.mode = args[i].slice(2); }
    else { const field = fields[args[i]]; need(field && args[i + 1] && !args[i + 1].startsWith('--'), 'anchor_invalid_argument'); options[field] = args[++i]; }
  }
  if (options.mode !== 'plan') need(CASES.includes(options.caseId), 'anchor_case_required');
  if (!['plan', 'start'].includes(options.mode)) need(/^[a-f0-9-]{36}$/.test(options.id ?? ''), 'anchor_id_required');
  if (options.mode === 'confirm-ready') need(!!options.ownerRecord, 'anchor_owner_record_required');
  if (options.mode === 'close') need(!!options.cleanupRef, 'anchor_cleanup_record_required');
  return options;
}
async function atomic(file, value, io = fs) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await io.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await io.rename(temporary, file);
}
async function waitOwnedExit(identity, { list, now = Date.now, sleep = pause, timeoutMs = 5000 }) {
  const end = now() + timeoutMs;
  do {
    const current = (await list()).find(value => value.pid === identity.pid);
    if (!current || current.created !== identity.created) return true;
    need(current.sessionId === identity.sessionId, 'anchor_cleanup_identity_invalid');
    await sleep(100);
  } while (now() < end);
  return false;
}
function defaults(root) {
  const common = require('./replacement-acceptance-common.cjs');
  const { command } = require('./accept-supervisor-quarantine.cjs');
  const { compareDisplay } = require('./accept-supervisor-recovery.cjs');
  return { now: Date.now, command, compareDisplay, bridge: common.bridge,
    verifyFixture: () => continuation.preparedFixture(root),
    launch: require('./accept-clipboard.cjs').launchOwnedFixture,
    windows: () => new (require('../src/computer/winapp-backend.cjs').WinappBackend)().listWindows(),
    // Cleanup can name input children as well as Node/supervisor/marker processes.
    waitExit: identity => waitOwnedExit(identity, { list: () => common.processList({ all: true }) }),
    leaseFree: async () => {
      const os = require('node:os'), { DesktopLease } = require('../src/computer/lease.cjs');
      const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
      const owner = `anchor-preflight-${randomUUID()}`;
      await lease.acquire(owner); await lease.release(owner); return true;
    } };
}
async function discover(fixture, deps) {
  const candidates = (await deps.windows()).filter(window => window.pid === fixture.pid && window.title === fixture.title);
  need(candidates.length === 1, 'anchor_window_ambiguous');
  const selected = candidates[0], bounds = await deps.bridge('bounds', selected);
  const anchor = { id: String(bounds.hwnd ?? bounds.id), pid: bounds.pid,
    processCreationTime: bounds.processCreationTime, sessionId: bounds.sessionId };
  need(anchor.id === selected.id && anchor.pid === fixture.pid && same(selected, anchor), 'anchor_generation_changed');
  const native = await deps.command(['identity', String(fixture.pid)]);
  need(native.pid === anchor.pid && native.processCreationTime === anchor.processCreationTime && native.session === anchor.sessionId, 'anchor_generation_changed');
  need(/^[1-9]\d*$/.test(anchor.id) && Number.isInteger(anchor.pid) && anchor.pid > 0
    && /^\d+$/.test(anchor.processCreationTime ?? '') && Number.isInteger(anchor.sessionId) && anchor.sessionId >= 0, 'anchor_identity_invalid');
  return anchor;
}
async function createOwner({ id, caseId, directory }, deps) {
  need(CASES.includes(caseId), 'anchor_case_required');
  const prepared = await deps.verifyFixture();
  const pinnedDisplay = await deps.command(['display']);
  const fixture = await deps.launch({ executable: prepared.executable, directory }); // Closure retains the actual ChildProcess.
  let anchor, heldError, closed = false, readiness = null;
  try { anchor = await discover(fixture, deps); } catch (error) { heldError = error.code || 'anchor_identity_unknown'; }
  const createdAt = deps.now();
  const status = () => ({ schemaVersion: 1, id, caseId, state: closed ? 'closed' : heldError ? 'held' : 'open',
    anchor: anchor ?? null, anchorExistsAt: new Date(createdAt).toISOString(), ownerRespondedAt: new Date(deps.now()).toISOString(),
    ...(heldError ? { code: heldError } : {}), readiness: readiness && Date.parse(readiness.confirmedAt) + 60000 >= deps.now() ? readiness : null });
  async function freshIdentity() {
    need(anchor && same(await discover(fixture, deps), anchor), 'anchor_generation_changed');
  }
  return { status,
    async inspect() {
      if (!closed) try { await freshIdentity(); } catch (error) { readiness = null; heldError = error.code || 'anchor_identity_unknown'; }
      return status();
    },
    async confirm(record) {
      need(!closed && !heldError, 'anchor_not_available'); readiness = null;
      need(Date.parse(record?.confirmedAt) >= createdAt, 'anchor_confirmation_predates_window');
      continuation.validateReadiness(record, { caseId, anchor, now: deps.now() });
      await freshIdentity();
      const verified = await continuation.idlePreflight({ record, caseId, anchor, pinnedDisplay }, deps);
      readiness = { confirmedAt: record.confirmedAt, verifiedAt: verified.verifiedAt };
      return { record: { schemaVersion: 1, source: 'direct-owner', caseId, ready: true,
        confirmedAt: record.confirmedAt, anchorOwnership: 'run-owned-child', anchor: { ...anchor } }, verified };
    },
    async close(cleanup) {
      need(!closed, 'anchor_already_closed'); readiness = null;
      const at = Date.parse(cleanup?.verifiedAt), now = deps.now();
      need(cleanup?.schemaVersion === 1 && cleanup.caseId === caseId && same(cleanup.anchor, anchor) && anchor
        && cleanup.source === 'independent-native-cleanup' && cleanup.nativeRequestsSettled === true
        && Number.isFinite(at) && at >= createdAt && at <= now && now - at <= 60000
        && Array.isArray(cleanup.ownedProcesses), 'anchor_cleanup_unconfirmed');
      need(cleanup.downstreamStarted === false || (cleanup.downstreamStarted === true && cleanup.ownedProcesses.length > 0), 'anchor_cleanup_unconfirmed');
      for (const identity of cleanup.ownedProcesses) {
        need(Number.isInteger(identity?.pid) && identity.pid > 0 && identity.pid !== fixture.pid
          && typeof identity.created === 'string' && identity.created.length > 0 && Number.isInteger(identity.sessionId)
          && identity.sessionId === anchor.sessionId, 'anchor_cleanup_identity_invalid');
        need(await deps.waitExit(identity) === true, 'anchor_downstream_exit_unknown');
      }
      await freshIdentity();
      need((await deps.command(['status'])).recoveryRequired === false, 'anchor_recovery_required');
      const keys = await deps.command(['keystate', 'all']);
      need(Array.isArray(keys.down) && keys.down.length === 0, 'anchor_input_unknown');
      need(await deps.leaseFree() === true, 'anchor_desktop_busy');
      const result = await fixture.close(); // Never look up or terminate a cached PID.
      need(result?.exited === true, 'anchor_exit_unknown'); closed = true;
      return status();
    } };
}
function sessionFolder(id, root = ROOT) {
  need(/^[a-f0-9-]{36}$/.test(id ?? ''), 'anchor_id_required');
  return path.join(root, '.runtime/acceptance-anchor', id);
}
async function ordinaryFolder(folder, io = fs) {
  const stat = await io.lstat(folder);
  need(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(await io.realpath(folder)).toLowerCase() === path.resolve(folder).toLowerCase(), 'anchor_channel_redirected');
}
async function request(options, { root = ROOT, io = fs, timeoutMs = 15000, sleep = pause } = {}) {
  const directory = sessionFolder(options.id, root); await ordinaryFolder(directory, io);
  const requestId = randomUUID(), destination = path.join(directory, `request-${requestId}.json`), reply = path.join(directory, `reply-${requestId}.json`);
  await atomic(destination, { requestId, ...options }, io);
  const end = Date.now() + timeoutMs;
  do {
    try { const result = JSON.parse(await io.readFile(reply, 'utf8')); need(result.requestId === requestId, 'anchor_reply_mismatch'); return result; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(100);
  } while (Date.now() < end);
  throw fail('anchor_owner_unresponsive'); // A state file or cached PID never proves ownership after a crash.
}
async function serve(options, { root = ROOT, io = fs, deps = defaults(root), sleep = pause, output = value => process.stdout.write(JSON.stringify(value) + '\n') } = {}) {
  const id = randomUUID(), directory = sessionFolder(id, root);
  await io.mkdir(directory, { recursive: true }); await ordinaryFolder(directory, io);
  await atomic(path.join(directory, 'state.json'), { schemaVersion: 1, id, caseId: options.caseId, state: 'starting', ownerPid: process.pid }, io);
  const owner = await createOwner({ id, caseId: options.caseId, directory }, deps);
  const persist = () => atomic(path.join(directory, 'state.json'), { ...owner.status(), ownerPid: process.pid }, io);
  await persist(); output(owner.status());
  // SIGINT/SIGTERM record a held owner; they do not abandon downstream native work or kill by PID.
  let interrupted = false;
  const hold = () => { interrupted = true; };
  process.on('SIGINT', hold); process.on('SIGTERM', hold);
  try {
    while (owner.status().state !== 'closed') {
      try {
      if (interrupted) { interrupted = false; await atomic(path.join(directory, 'interrupted.json'), { at: new Date(deps.now()).toISOString(), cleanup: 'unknown-owner-retained' }, io); }
      for (const name of (await io.readdir(directory)).filter(value => /^request-[a-f0-9-]{36}\.json$/.test(value)).sort()) {
        const requestId = name.slice(8, -5), reply = path.join(directory, `reply-${requestId}.json`);
        try { await io.access(reply); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        let result;
        try {
          const message = JSON.parse(await io.readFile(path.join(directory, name), 'utf8'));
          need(message.requestId === requestId && message.id === id && message.caseId === options.caseId, 'anchor_request_mismatch');
          if (message.mode === 'status') result = await owner.inspect();
          else if (message.mode === 'confirm-ready') {
            const supplied = await continuation.evidence(message.ownerRecord, root);
            const confirmed = await owner.confirm(supplied.value);
            const ref = `evidence/acceptance-anchor/${id}/readiness-${requestId}.json`;
            await io.mkdir(path.dirname(path.join(root, ref)), { recursive: true });
            const bytes = Buffer.from(JSON.stringify(confirmed.record, null, 2) + '\n');
            await io.writeFile(path.join(root, ref), bytes, { flag: 'wx' });
            result = { ...owner.status(), readinessReference: { ref, sha256: require('./live-acceptance-continuation.cjs').digest(bytes) } };
          } else if (message.mode === 'close') result = await owner.close((await continuation.evidence(message.cleanupRef, root)).value);
          else throw fail('anchor_command_invalid');
          await persist();
          result = { ok: true, value: result };
        } catch (error) { result = { ok: false, code: error.code || 'anchor_command_failed', ownerRetained: owner.status().state !== 'closed' }; }
        await atomic(reply, { requestId, ...result }, io);
      }
      } catch {
        // Channel/storage failure cannot discard the retained fixture closure or authorize cleanup.
        output({ id, caseId: options.caseId, state: 'held', code: 'anchor_channel_unavailable', ownerRetained: true });
      }
      if (owner.status().state !== 'closed') await sleep(100);
    }
  } finally { process.removeListener('SIGINT', hold); process.removeListener('SIGTERM', hold); }
}
async function main(args) { const options = parse(args); return options.mode === 'plan' ? plan() : options.mode === 'start' ? serve(options) : request(options); }
if (require.main === module) main(process.argv.slice(2)).then(value => { if (value) process.stdout.write(JSON.stringify(value, null, 2) + '\n'); if (value?.ok === false) process.exitCode = 1; })
  .catch(error => { process.stderr.write(JSON.stringify({ code: error.code || 'anchor_failed', cleanup: 'unconfirmed-do-not-kill-cached-pids' }) + '\n'); process.exitCode = 1; });
module.exports = { CASES, plan, parse, waitOwnedExit, discover, createOwner, sessionFolder, atomic, request, serve, main };
