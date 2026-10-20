#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const SOURCES = ['tests/fixtures/glow-app/Program.cs', 'tests/fixtures/glow-app/TraceGlowFixture.csproj'];
const RUNTIME = path.join(ROOT, '.runtime', 'glow-fixture');
const BINARY = path.join(RUNTIME, 'bin', 'TraceGlowFixture.exe');
const OUTPUTS = ['TraceGlowFixture.exe', 'TraceGlowFixture.dll', 'TraceGlowFixture.runtimeconfig.json', 'TraceGlowFixture.deps.json'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parse(args) {
  const result = { mode: 'plan', lifetimeMs: 120000 };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (['--plan', '--build', '--live'].includes(key)) result.mode = key.slice(2);
    else if (key === '--command') { result.mode = 'command'; result.command = args[++index]; }
    else if (key === '--directory') result.directory = args[++index];
    else if (key === '--lifetime-ms') result.lifetimeMs = Number(args[++index]);
    else if (key === '--file') result.file = args[++index];
    else if (key === '--indicator-pid') result.indicatorPid = Number(args[++index]);
    else throw new Error(`Unknown fixture option: ${key}`);
  }
  if (['live', 'command'].includes(result.mode) && (!result.directory || !path.isAbsolute(result.directory))) throw new Error('An absolute owned --directory is required.');
  if (!Number.isInteger(result.lifetimeMs) || result.lifetimeMs < 10000 || result.lifetimeMs > 300000) throw new Error('Lifetime must be 10000..300000 milliseconds.');
  if (result.mode === 'command' && !['focus', 'capture-desktop', 'close'].includes(result.command)) throw new Error('Only focus, capture-desktop and close instrumentation is supported.');
  if (result.command === 'capture-desktop' && (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}\.png$/.test(result.file || '') || !Number.isInteger(result.indicatorPid) || result.indicatorPid < 0)) throw new Error('Capture requires a simple PNG filename and --indicator-pid (0 when absent).');
  return result;
}

async function sourceHashes() {
  const result = {};
  for (const name of SOURCES) result[name] = createHash('sha256').update(await fs.readFile(path.join(ROOT, name))).digest('hex');
  return result;
}

async function waitFor(directory, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
      if (predicate(status)) return status;
    } catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await delay(50);
  }
  throw new Error('Owned glow fixture did not reach the expected state within the bounded wait.');
}

async function build() {
  const feed = path.join(RUNTIME, 'empty-package-feed');
  await fs.mkdir(feed, { recursive: true });
  const before = await sourceHashes();
  const child = spawn('dotnet', ['publish', path.join(ROOT, SOURCES[1]), '--configuration', 'Release', '--output', path.dirname(BINARY), '--artifacts-path', path.join(RUNTIME, 'artifacts'), '--source', feed, '--nologo'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let size = 0;
  const timeout = setTimeout(() => child.kill(), 120000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) child.kill(); });
  let exit;
  try { exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); }); }
  finally { clearTimeout(timeout); }
  if (exit !== 0) throw new Error('Owned glow fixture build failed; local .NET 9 SDK/Desktop reference pack is required.');
  if (JSON.stringify(before) !== JSON.stringify(await sourceHashes())) throw new Error('Fixture source changed during build.');
  const files = {};
  for (const name of OUTPUTS) {
    files[name] = createHash('sha256').update(await fs.readFile(path.join(path.dirname(BINARY), name))).digest('hex');
  }
  const manifest = { version: 1, sources: before, files };
  await fs.writeFile(path.join(RUNTIME, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { built: true, uiLaunched: false, packageDownloads: false, manifest };
}

async function verify() {
  const manifest = JSON.parse(await fs.readFile(path.join(RUNTIME, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || JSON.stringify(manifest.sources) !== JSON.stringify(await sourceHashes())) throw new Error('Owned glow fixture source is stale; rebuild.');
  if (Object.keys(manifest.files || {}).length !== OUTPUTS.length) throw new Error('Incomplete owned fixture output manifest.');
  for (const name of OUTPUTS) {
    const expected = manifest.files[name];
    if (createHash('sha256').update(await fs.readFile(path.join(path.dirname(BINARY), name))).digest('hex') !== expected) throw new Error('Owned fixture output integrity failed.');
  }
}

async function command(options) {
  const request = { id: randomUUID(), type: options.command, ...(options.command === 'capture-desktop' ? { file: options.file, indicatorPid: options.indicatorPid } : {}) };
  const temporary = path.join(options.directory, `command-${request.id}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(request), { flag: 'wx' });
  await fs.rename(temporary, path.join(options.directory, 'commands.json'));
  const status = await waitFor(options.directory, state => state.lastCommand?.id === request.id, 8000);
  if (status.lastCommand.status !== 'pass') throw new Error(`Owned fixture command failed: ${status.lastCommand.code}.`);
  return status;
}

async function live(options) {
  if (process.platform !== 'win32') throw new Error('The owned glow fixture requires an unlocked Windows desktop.');
  await verify();
  await fs.mkdir(options.directory, { recursive: true });
  if ((await fs.readdir(options.directory)).length) throw new Error('Use a new empty owned acceptance directory; existing evidence is preserved.');
  const child = spawn(BINARY, ['--directory', options.directory, '--parent-pid', String(process.pid), '--lifetime-ms', String(options.lifetimeMs)], { shell: false, windowsHide: false, stdio: ['ignore', 'ignore', 'ignore'] });
  let exited = false;
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { exited = true; resolve(code); }); });
  const lifetime = setTimeout(() => { if (!exited) child.kill(); }, options.lifetimeMs + 5000);
  const cleanup = () => { if (!exited) child.kill(); };
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup);
  try {
    const ready = await waitFor(options.directory, state => state.ready === true && state.pid === child.pid, 8000);
    process.stdout.write(JSON.stringify({ fixtureReady: true, ...ready }) + '\n');
    const code = await exit;
    return { fixtureExited: true, exitCode: code, physicalInputActions: 0 };
  } finally { clearTimeout(lifetime); cleanup(); process.removeListener('SIGINT', cleanup); process.removeListener('SIGTERM', cleanup); }
}

async function main(args = process.argv.slice(2)) {
  const options = parse(args);
  if (options.mode === 'plan') return { fixture: 'owned-fullscreen-primary-screen', physicalInputActions: 0, commands: ['focus', 'capture-desktop', 'close'], requirements: ['Windows interactive unlocked desktop', '.NET 9 SDK/Desktop runtime'], sources: await sourceHashes() };
  if (options.mode === 'build') return build();
  if (options.mode === 'command') return command(options);
  return live(options);
}
if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { parse, main, sourceHashes };
