'use strict';

// Acceptance-only helpers. Importing this file never starts a process, observes input or opens UI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const shared = require('./accept-supervisor-quarantine.cjs');
const { validateDisplay, compareDisplay, stateOf } = require('./accept-supervisor-recovery.cjs');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { configuration, verifySupervisorFiles, supervisorSourceHashes } = require('../src/computer/supervisor.cjs');
const { DEFAULT_BRIDGE, runProcess, parseJson } = require('../src/computer/winapp-backend.cjs');
const ROOT = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code });
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function optionsFor(input = {}, caseId) {
  const value = { mode: 'plan', attempt: 1, ...input };
  if (!['plan', 'live'].includes(value.mode) || ![1, 2].includes(value.attempt)) throw failure('invalid_plan', 'Select plan/live and attempt 1 or 2.');
  if (value.mode === 'live' && (!value.directory || typeof value.ownerDecision !== 'string' || !value.ownerDecision.trim()))
    throw failure('owner_decision_required', 'Live replacement acceptance requires a new directory and the explicit owner decision text/reference.');
  if (value.ownerDecision !== undefined && (typeof value.ownerDecision !== 'string' || !value.ownerDecision.trim()
    || value.ownerDecision.length > 2048 || /[\x00-\x1f]/.test(value.ownerDecision))) throw failure('invalid_plan', 'Owner decision metadata must be a bounded single-line reference.');
  if (value.attempt === 2 && (!value.prior || typeof value.change !== 'string' || !value.change.trim()))
    throw failure('invalid_retry', 'Attempt 2 requires its same-case prior receipt and explicit changed precondition.');
  if (value.attempt === 1 && (value.prior || value.change)) throw failure('invalid_retry', 'Attempt 1 cannot claim prior corrective evidence.');
  return { ...value, caseId };
}
function parseArgs(args, caseId, extra = {}) {
  const value = {};
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item === '--plan') value.mode = 'plan';
    else if (item === '--live') value.mode = 'live';
    else if (item === '--owner-decision') value.ownerDecision = args[++i];
    else if (item === '--attempt') value.attempt = Number(args[++i]);
    else if (item === '--prior') value.prior = args[++i];
    else if (item === '--change') value.change = args[++i];
    else if (extra[item]) value[extra[item]] = args[++i];
    else if (!item.startsWith('--') && !value.directory) value.directory = item;
    else throw failure('invalid_plan', 'Unknown replacement option; use --plan or a new directory --live --owner-decision reference.');
  }
  return optionsFor(value, caseId);
}
async function checkPrior(options) {
  if (options.attempt !== 2) return null;
  const previous = JSON.parse(await fs.readFile(path.join(path.resolve(options.prior), 'receipt.json'), 'utf8'));
  if (previous.caseId !== options.caseId || previous.attempt !== 1 || !['fail', 'blocked'].includes(previous.status)
    || previous.ownerDecision !== options.ownerDecision || previous.planContract !== 1)
    throw failure('invalid_retry', 'The prior receipt must be unfinished attempt 1 of this exact replacement and owner decision.');
  return { path: path.relative(ROOT, path.resolve(options.prior)).replaceAll(path.sep, '/'), status: previous.status, changedPrecondition: options.change };
}
async function sourceHashes(driver, fixture = 'computer-app') {
  const files = await supervisorSourceHashes();
  const names = ['src/computer/supervisor.cjs', 'src/computer/controller.cjs', 'src/computer/server.cjs', 'src/computer/winapp-backend.cjs',
    'src/computer/lease.cjs', 'src/computer/activity-indicator.cjs', 'native/TraceWindowBridge/Program.cs', 'native/TraceActivityIndicator/Program.cs', 'tests/fixtures/supervised-mcp.cjs',
    `tests/fixtures/${fixture}/Program.cs`, 'scripts/replacement-acceptance-common.cjs', driver,
    'scripts/accept-supervisor-quarantine.cjs', 'scripts/accept-supervisor-recovery.cjs', 'scripts/smoke-computer-live.cjs',
    ...(fixture === 'glow-app' ? ['scripts/accept-glow.cjs', 'scripts/smoke-computer-glow.cjs'] : []), 'package.json', 'package-lock.json'];
  for (const name of names) files[name] = digest(await fs.readFile(path.join(ROOT, name)));
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true });
  return { baseCommit: stdout.trim(), workingTreeModified: true, files };
}
async function verify() { await verifySupervisorFiles(); await configuration(); }
async function bridge(verb, target) {
  const result = await runProcess(DEFAULT_BRIDGE, [verb, target.id, String(target.pid)], { timeoutMs: 10000 });
  return parseJson(result.stdout, result.stderr, result.exitCode);
}
function publicError(error) {
  return { code: String(error.code || 'assertion_failed'), message: String(error.message || 'Acceptance check failed.')
    .replaceAll(ROOT, '<repo>').replace(/\b[A-Za-z]:[\\/][^\r\n"<>]+/g, '<private-path>').slice(0, 700),
  ...(Number.isInteger(error.win32Error) ? { win32Error: error.win32Error } : {}) };
}
const statusFor = error => /^(?:desktop_busy|input_busy|input_recovery_required|display_mismatch|input_desktop_unavailable|input_state_unavailable|foreground_[a-z_]+|reference_[a-z_]+|capture_[a-z_]+)$/.test(error.code || '') ? 'blocked' : 'fail';
function assertIdentity(target, expected) {
  assert.equal(String(target.id ?? target.hwnd), String(expected.id ?? expected.hwnd));
  assert.equal(target.pid, expected.pid); assert.equal(target.processCreationTime, expected.processCreationTime);
  assert.equal(target.sessionId, expected.sessionId);
}
async function processList({ all = false } = {}) {
  const filter = all ? '' : ' -Filter "Name=\'node.exe\' OR Name=\'TraceSupervisor.exe\' OR Name=\'TraceActivityIndicator.exe\'"';
  const fullMetadata = all ? "; executablePath=$_.ExecutablePath; systemDirectory=[Environment]::GetFolderPath('System')" : '';
  const script = `Get-CimInstance Win32_Process${filter} | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; name=$_.Name; sessionId=$_.SessionId; created=$_.CreationDate.ToUniversalTime().ToString('o')${fullMetadata} } } | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: all ? 2 * 1024 * 1024 : 131072 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}
function ownershipChain(records, nodePid, parentPid = process.pid, expectedCreated) {
  const node = records.find(value => value.pid === nodePid && /^node(?:\.exe)?$/i.test(value.name));
  if (!node || node.parent !== parentPid || typeof node.created !== 'string' || (expectedCreated && node.created !== expectedCreated))
    throw failure('owner_identity_changed', 'The MCP process is not the exact owned Node child.');
  const supervisors = records.filter(value => value.parent === node.pid && value.name === 'TraceSupervisor.exe');
  if (supervisors.length !== 1) throw failure('owner_identity_changed', 'Exactly one native supervisor must belong to the owned MCP process.');
  const markers = records.filter(value => value.parent === supervisors[0].pid && value.name === 'TraceActivityIndicator.exe');
  if (markers.length !== 1 || ![supervisors[0], markers[0]].every(value => Number.isInteger(value.pid) && typeof value.created === 'string'))
    throw failure('owner_identity_changed', 'Exactly one activity marker must belong to the exact native supervisor.');
  return { node, supervisor: supervisors[0], marker: markers[0] };
}
async function readChain(connection) { return ownershipChain(await processList(), connection.pid, process.pid, connection.nodeIdentity?.created); }
async function readOwned(connection) {
  const records = await processList(), node = records.find(value => value.pid === connection.pid && value.parent === process.pid && /^node(?:\.exe)?$/i.test(value.name));
  if (!node || (connection.nodeIdentity && node.created !== connection.nodeIdentity.created)) return connection.nodeIdentity ? [connection.nodeIdentity] : [];
  const owned = [node];
  for (const name of ['TraceSupervisor.exe', 'TraceActivityIndicator.exe']) {
    const parents = new Set(owned.map(value => value.pid));
    owned.push(...records.filter(value => value.name === name && parents.has(value.parent)));
  }
  return owned;
}
async function waitIdentityExit(identity, timeoutMs = 5000) {
  return shared.waitFor(async () => {
    try { process.kill(identity.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    const current = (await processList()).find(value => value.pid === identity.pid);
    return !current || current.created !== identity.created;
  }, Boolean, 'exact owned process exit', timeoutMs);
}
async function connect(directory) {
  await fs.mkdir(directory, { recursive: true });
  const privateDirectory = path.join(ROOT, '.runtime', 'replacement-mcp', randomUUID()); await fs.mkdir(privateDirectory, { recursive: true });
  const config = shared.connectionConfiguration({ directory, privateDirectory, input: 'none', operationTimeoutMs: 15000 });
  const configPath = path.join(privateDirectory, 'launch.json'); await writeJson(configPath, config);
  const client = new Client({ name: 'trace-proposed-replacement-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'tests/fixtures/supervised-mcp.cjs'), configPath], cwd: ROOT, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  let closed;
  const close = () => closed ??= (async () => {
    let error;
    try { await client.close(); } catch (caught) { error = caught; }
    try { await transport.close(); } catch (caught) { error ??= caught; }
    if (error) throw error;
  })();
  let nodeIdentity;
  try {
    await client.connect(transport, { timeout: 15000 });
    nodeIdentity = (await processList()).find(value => value.pid === transport.pid && value.parent === process.pid && /^node(?:\.exe)?$/i.test(value.name));
    if (!nodeIdentity) throw failure('owner_identity_changed', 'The exact owned MCP process could not be established.');
  } catch (error) { try { await close(); } catch { } throw error; }
  return { client, transport, pid: transport.pid, nodeIdentity, close, journalRoot: path.join(config.runtimeDirectory, 'sessions'),
    call: async (name, args = {}, options = {}) => stateOf(await client.callTool({ name: `trace_computer_${name}`, arguments: args }, { timeout: 30000, ...options })),
    async killAbruptly() {
      // The source-owned private host kills itself. No cached PID is used to terminate another process.
      const temporary = `${config.controlPath}.${randomUUID()}.tmp`;
      await writeJson(temporary, { type: 'node-death' }); await fs.rename(temporary, config.controlPath);
    } };
}
async function launchComputerFixture(directory) {
  const { buildFixture } = require('./smoke-computer-live.cjs');
  const binary = await buildFixture(), runId = `replacement-${randomUUID()}`;
  const statePath = path.join(directory, 'fixture.json'), commandsPath = path.join(directory, 'commands.json');
  const child = spawn(binary, ['--run-id', runId, '--receipt', statePath, '--commands', commandsPath], { windowsHide: false, shell: false, stdio: 'ignore' });
  let spawnFailure;
  child.once('error', error => { spawnFailure = error; });
  let commandId = 0;
  const state = async () => { if (spawnFailure) throw failure('fixture_start_failed', 'The owned synthetic fixture could not start.');
    try { return JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  return { pid: child.pid, title: `TRACE Computer Fixture — ${runId}`, sha256: digest(await fs.readFile(binary)), state,
    async command(op, predicate) {
      assert.ok(['move', 'minimize'].includes(op));
      const id = ++commandId, temporary = `${commandsPath}.${id}.tmp`;
      await writeJson(temporary, { id, op }); await fs.rename(temporary, commandsPath);
      return shared.waitFor(state, value => value?.appliedCommandId === id && predicate(value), `fixture ${op}`, 10000);
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return { exited: true };
      if (!child.kill()) throw failure('fixture_exit_unconfirmed', 'The exact owned fixture did not accept termination.');
      await shared.waitFor(async () => child.exitCode !== null || child.signalCode !== null, Boolean, 'owned fixture exit', 5000);
      return { exited: true };
    } };
}

module.exports = { ROOT, digest, delay, failure, writeJson, optionsFor, parseArgs, checkPrior, sourceHashes, verify, bridge, publicError, statusFor,
  assertIdentity, ownershipChain, readChain, readOwned, processList, waitIdentityExit, connect, launchComputerFixture,
  command: shared.command, waitFor: shared.waitFor, validateDisplay, compareDisplay };
