'use strict';

// Private acceptance subprocess. Its launch-file configuration and controlled provider never enter
// the public MCP schema, a production environment variable, or the normal TRACE CLI.
const fs = require('node:fs');
const path = require('node:path');
const { NativeSupervisor, configuration } = require('../../src/computer/supervisor.cjs');
const { WinappBackend, parseJson } = require('../../src/computer/winapp-backend.cjs');
const { createComputerController } = require('../../src/computer/controller.cjs');
const { runComputerServer } = require('../../src/computer/server.cjs');

const MODES = ['none', 'mouse', 'chord', 'typing'];
// Windows readers/antivirus can briefly deny replacement of an open journal. Retry only that
// publication, never the controlled input operation. The native owner's stop hook is independent
// of this bounded (at most 126 ms) private acceptance-process wait.
function publishJournal(journalPath, state, { write = fs.writeFileSync, rename = fs.renameSync,
  pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const temporary = `${journalPath}.tmp`;
  write(temporary, JSON.stringify(state));
  for (let attempt = 0; ; attempt++) {
    try { rename(temporary, journalPath); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
      pause(2 ** (attempt + 1));
    }
  }
}
function validate(config) {
  if (!config || !MODES.includes(config.mode) || !path.isAbsolute(config.runtimeDirectory || '')
    || !path.isAbsolute(config.journalPath || '') || !path.isAbsolute(config.controlPath || '') || !Number.isInteger(config.operationTimeoutMs)
    || config.operationTimeoutMs < 100 || config.operationTimeoutMs > 15000) {
    throw Object.assign(new Error('Invalid private acceptance configuration.'), { code: 'invalid_fixture_config' });
  }
  if (config.testRecovery !== undefined && (config.mode === 'none' || config.testRecovery?.mode !== 'fail-release-ack'
    || !/^[a-f0-9]{32}$/.test(config.testRecovery?.token || ''))) {
    throw Object.assign(new Error('Private cleanup fault injection requires a controlled provider and checkpoint token.'), { code: 'invalid_fixture_config' });
  }
  return config;
}

function replacement(mode, verb, args) {
  if (mode === 'mouse' && verb === 'drag' && !args.includes('--hold-ms')) {
    const separator = args.indexOf('--');
    const first = args[separator + 1];
    if (separator < 0 || !/^-?\d+,-?\d+$/.test(first || '')) throw new Error('Expected a measured physical drag point.');
    return ['provider', 'hold-mouse', ...first.split(',')];
  }
  if (mode === 'chord' && verb === 'send-keys' && !args.includes('--verbatim')) return ['provider', 'hold-keys', '0xA2,0xA0'];
  if (mode === 'typing' && verb === 'send-keys' && args.includes('--verbatim')) return ['provider', 'type-hold', 'abc'];
  return null;
}

function publicReleaseCheckpoint(receipt) {
  return { requestId: receipt.id, childPid: receipt.childPid, processCreationTime: receipt.processCreationTime,
    processExitConfirmed: receipt.processExitConfirmed, physicalReleaseObserved: receipt.physicalReleaseObserved,
    declaredKeys: receipt.declaredKeys, remainingDown: receipt.remainingDown };
}
function privateAcknowledgement(config, pending, message) {
  if (!config.testRecovery || !pending || message.requestId !== pending.id || message.independentReleaseVerified !== true
    || typeof message.verifiedAt !== 'string' || !Number.isFinite(Date.parse(message.verifiedAt))) return null;
  return { targetId: pending.id, token: config.testRecovery.token, independentReleaseVerified: true };
}

class ControlledBackend extends WinappBackend {
  constructor({ config, native, record, ...dependencies }) {
    super({ ...dependencies, supervisor: native });
    this.privateConfig = validate(config);
    this.recordAcceptance = record;
    this.controlledIssued = false;
    this.controlledInFlight = false;
  }
  async command(verb, args, signal) {
    const controlled = !this.controlledIssued && replacement(this.privateConfig.mode, verb, args);
    if (!controlled) return super.command(verb, args, signal);
    this.controlledIssued = true;
    this.controlledInFlight = true;
    this.recordAcceptance('controlled-start', { mode: this.privateConfig.mode, supervisorPid: this.supervisor.child?.pid });
    try {
      const result = await this.supervisor.run('controlled', controlled, { signal, mutating: true, timeoutMs: this.privateConfig.operationTimeoutMs });
      this.recordAcceptance('controlled-finished', { outcome: 'completed' });
      return parseJson(result.stdout, result.stderr, result.exitCode);
    } catch (error) {
      this.recordAcceptance('controlled-finished', { code: error.code, outcome: error.details?.outcome,
        recovery: error.details?.recovery ?? null });
      throw error;
    } finally { this.controlledInFlight = false; }
  }
}

async function main(configPath) {
  if (!path.isAbsolute(configPath || '')) throw new Error('An absolute private launch-file path is required.');
  const config = validate(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const state = { schemaVersion: 1, nodePid: process.pid, mode: config.mode, events: [] };
  const record = (type, details) => {
    state.events.push({ at: new Date().toISOString(), type, ...details });
    if (state.events.length > 80) state.events.shift();
    publishJournal(config.journalPath, state);
  };
  let backend;
  let pendingRelease = null;
  const native = new NativeSupervisor({
    configure: async () => ({ ...await configuration(), allowControlled: config.mode !== 'none',
      ...(config.testRecovery ? { testRecovery: config.testRecovery } : {}) }),
    onDispatch: receipt => {
      record('native-dispatch', { ...receipt, supervisorPid: native.child?.pid });
      if (backend?.controlledInFlight) record('controlled-dispatch', { ...receipt, supervisorPid: native.child?.pid });
    },
    onStopped: receipt => record('native-stopped', { code: receipt.code, physical: receipt.physical,
      stopLatencyMs: receipt.stopLatencyMs, dispatchCount: receipt.dispatchCount }),
    onTestReleaseReady: receipt => {
      if (!config.testRecovery || !backend?.controlledInFlight) return;
      pendingRelease = receipt;
      // The checkpoint token remains in the private launch file and is never copied into evidence.
      record('test-release-ready', publicReleaseCheckpoint(receipt));
    },
  });
  backend = new ControlledBackend({ config, native, record });
  const controller = createComputerController({ backend, runtimeDirectory: config.runtimeDirectory });
  let controlHandled = false;
  const control = setInterval(() => {
    if (controlHandled || !fs.existsSync(config.controlPath)) return;
    let message;
    try { message = JSON.parse(fs.readFileSync(config.controlPath, 'utf8')); } catch { return; }
    if (message?.type === 'fail-cleanup-ack') {
      const acknowledgement = privateAcknowledgement(config, pendingRelease, message);
      if (!acknowledgement) return;
      controlHandled = true;
      record('external-release-verified', { requestId: pendingRelease.id, verifiedAt: message.verifiedAt });
      void native.request('test_cleanup_ack', acknowledgement, { deadlineMs: 4500 }).then(
        result => record('private-ack-accepted', { accepted: result.accepted === true }),
        error => record('private-ack-rejected', { code: error.code || 'ack_failed' }));
      return;
    }
    if (!['node-death', 'supervisor-death'].includes(message?.type)) return;
    controlHandled = true;
    record('private-failure-trigger', { cause: message.type, supervisorPid: native.child?.pid ?? null });
    if (message.type === 'node-death') process.kill(process.pid, 'SIGKILL');
    else native.child?.kill();
  }, 25);
  control.unref();
  record('server-created', {});
  await runComputerServer({ controller, onError: () => record('server-error', { code: 'mcp_server_error' }) });
}

if (require.main === module) main(process.argv[2]).catch(error => {
  process.stderr.write(JSON.stringify({ code: error.code || 'acceptance_subprocess_failed' }) + '\n');
  process.exitCode = 1;
});
module.exports = { ControlledBackend, replacement, validate, publicReleaseCheckpoint, privateAcknowledgement, publishJournal, main };
