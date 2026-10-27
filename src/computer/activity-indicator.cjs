'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_INDICATOR = path.join(ROOT, '.runtime', 'activity-indicator', 'bin', 'TraceActivityIndicator.exe');
const SOURCES = ['native/TraceActivityIndicator/Program.cs', 'native/TraceActivityIndicator/TraceActivityIndicator.csproj'];
const OUTPUTS = ['TraceActivityIndicator.exe', 'TraceActivityIndicator.dll', 'TraceActivityIndicator.runtimeconfig.json', 'TraceActivityIndicator.deps.json'];
const failure = (code, message) => Object.assign(new Error(message), { code });

async function indicatorSourceHashes(root = ROOT) {
  const entries = await Promise.all(SOURCES.map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex')]));
  return Object.fromEntries(entries);
}

async function verifyIndicatorFiles(binaryPath = DEFAULT_INDICATOR, root = ROOT) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(binaryPath)), 'manifest.json'), 'utf8'));
    const sources = await indicatorSourceHashes(root);
    if (manifest.version !== 1 || JSON.stringify(manifest.sources) !== JSON.stringify(sources)) throw failure('indicator_stale', 'Activity indicator source changed; rebuild with computer setup.');
    for (const name of OUTPUTS) {
      const digest = createHash('sha256').update(await fs.readFile(path.join(path.dirname(binaryPath), name))).digest('hex');
      if (digest !== manifest.files?.[name]) throw failure('indicator_integrity', 'Activity indicator build differs from its setup manifest.');
    }
    return { available: true, integrity: 'verified', protocol: 1 };
  } catch (error) {
    if (['indicator_stale', 'indicator_integrity'].includes(error.code)) throw error;
    throw failure('indicator_unavailable', 'Activity indicator is not built. Run computer setup with the .NET 9 SDK.');
  }
}

// Never starts for diagnostics/listing. A session starts the marker after its desktop lease.
class ActivityIndicator {
  constructor({ binaryPath = DEFAULT_INDICATOR, spawnChild = spawn, verify = verifyIndicatorFiles, startupMs = 5000, stopMs = 1500 } = {}) {
    this.binaryPath = binaryPath;
    this.spawnChild = spawnChild;
    this.verify = verify;
    this.startupMs = startupMs;
    this.stopMs = stopMs;
    this.child = null;
    this.stopping = false;
    this.ready = false;
    this.failure = new AbortController();
    this.exit = Promise.resolve();
  }
  get signal() { return this.failure.signal; }
  get pid() { return this.child?.pid ?? null; }
  assertActive() {
    if (!this.ready || !this.child || this.failure.signal.aborted) throw failure('indicator_not_active', 'The visible activity marker is unavailable. Close this session before reopening; no further input is allowed.');
  }
  async start({ signal } = {}) {
    if (this.child) throw failure('indicator_busy', 'The activity indicator already belongs to an open session.');
    signal?.throwIfAborted();
    await this.verify(this.binaryPath);
    signal?.throwIfAborted();
    this.failure = new AbortController();
    this.stopping = false;
    this.ready = false;
    // This WinExe has no console window. SW_HIDE can hide the first overlay ShowWindow;
    // its intentionally visible, nonactivating forms must not inherit that startup flag.
    const child = this.spawnChild(this.binaryPath, ['--parent-pid', String(process.pid)], { shell: false, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let resolveExit;
    this.exit = new Promise(resolve => { resolveExit = resolve; });
    let rejectReady;
    let exited = false;
    const markFailed = error => {
      this.ready = false;
      if (!this.stopping) this.failure.abort(error);
      rejectReady?.(error);
    };
    child.on('error', () => {
      markFailed(failure('indicator_spawn_failed', 'The activity marker failed to start.'));
      // A spawn error can precede close without exit, but it cannot own a native process.
      if (!child.pid) { exited = true; resolveExit(); }
    });
    child.once('exit', () => {
      exited = true;
      resolveExit();
      markFailed(failure('indicator_exited', 'The activity marker exited; input is stopped.'));
    });
    // Keep stdin errors handled when EOF races native shutdown.
    child.stdin.on('error', () => {});
    let output = '', bytes = 0, timer;
    const abort = () => rejectReady(signal.reason ?? failure('indicator_start_cancelled', 'Activity marker startup cancelled.'));
    const readiness = new Promise((resolve, reject) => {
      rejectReady = reject;
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8192) {
          markFailed(failure('indicator_output_limit', 'Activity marker output exceeded its bounded protocol.'));
          child.kill();
          return;
        }
        output += chunk.toString('utf8');
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        try {
          const message = JSON.parse(output.slice(0, newline));
          if (this.ready || message.version !== 1 || message.ready !== true || message.pid !== child.pid || !Number.isInteger(message.monitors) || message.monitors < 1 || message.monitors > 64 || output.slice(newline + 1).trim()) throw new Error();
          this.ready = true;
          output = '';
          resolve({ active: true, monitors: message.monitors, protocol: 1 });
        } catch {
          markFailed(failure('indicator_protocol', 'Activity marker returned invalid readiness.'));
          child.kill();
        }
      });
      // Consume stderr without preserving native contents in receipts or errors.
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) { markFailed(failure('indicator_output_limit', 'Activity marker diagnostics exceeded the output limit.')); child.kill(); } });
      timer = setTimeout(() => reject(failure('indicator_timeout', 'Activity marker did not confirm all-monitor coverage within five seconds.')), this.startupMs);
      if (signal?.aborted) abort();
    });
    try {
      const receipt = await readiness;
      signal?.throwIfAborted();
      if (exited) throw failure('indicator_exited', 'Activity marker exited during startup.');
      this.assertActive();
      return receipt;
    } catch (error) {
      try { await this.stop(); } catch (cleanup) { error.cleanup = cleanup.code; }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      rejectReady = null;
    }
  }
  async stop() {
    const child = this.child;
    if (!child) return { stopped: true };
    this.stopping = true;
    this.ready = false;
    child.stdin.end();
    const wait = async () => {
      let timer;
      try { return await Promise.race([this.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.stopMs); })]); }
      finally { clearTimeout(timer); }
    };
    if (!await wait()) {
      child.kill();
      if (!await wait()) throw failure('indicator_stop_unconfirmed', 'Activity marker process exit could not be confirmed.');
    }
    this.child = null;
    return { stopped: true };
  }
}

module.exports = { ActivityIndicator, DEFAULT_INDICATOR, SOURCES, OUTPUTS, indicatorSourceHashes, verifyIndicatorFiles };
