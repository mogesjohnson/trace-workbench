#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { pin, DEFAULT_BINARY, DEFAULT_BRIDGE, verifyFiles, runProcess, bridgeSourceHashes } = require('../src/computer/winapp-backend.cjs');
const { DEFAULT_INDICATOR, OUTPUTS, indicatorSourceHashes, verifyIndicatorFiles } = require('../src/computer/activity-indicator.cjs');
const ROOT = path.resolve(__dirname, '..');

function plan() {
  return {
    engine: 'Microsoft winapp CLI', version: pin.version,
    platform: pin.platform, architecture: pin.architecture,
    source: pin.url, archiveSha256: pin.archiveSha256,
    destination: path.dirname(DEFAULT_BINARY),
    changes: ['Download and verify a pinned release under the ignored .runtime directory.', 'Extract locally; preserve any existing engine runtime.', 'Build the source-owned window bridge under .runtime with the installed .NET 9 SDK.', 'Build the source-owned activity indicator using an empty local package feed; no indicator downloads.'],
    requirements: ['Windows x64', '.NET 9 SDK with Windows Desktop reference pack to build local helpers; .NET 9 Desktop runtime to run the indicator'],
    globalChanges: false
  };
}

async function buildActivityIndicator({ root = ROOT, binaryPath = DEFAULT_INDICATOR, run = runProcess } = {}) {
  const output = path.dirname(binaryPath);
  const parent = path.dirname(output);
  const emptyFeed = path.join(parent, 'empty-package-feed');
  await fs.mkdir(emptyFeed, { recursive: true });
  const sources = await indicatorSourceHashes(root);
  const project = path.join(root, 'native', 'TraceActivityIndicator', 'TraceActivityIndicator.csproj');
  const result = await run('dotnet', ['publish', project, '--configuration', 'Release', '--output', output, '--artifacts-path', path.join(parent, 'artifacts'), '--source', emptyFeed, '--nologo'], { timeoutMs: 120000, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error('Activity indicator build failed. Install the .NET 9 SDK with Windows Desktop reference pack; no packages were downloaded.');
  if (JSON.stringify(sources) !== JSON.stringify(await indicatorSourceHashes(root))) throw new Error('Activity indicator source changed during the build; manifest was not updated.');
  const files = {};
  for (const name of OUTPUTS) files[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(output, name))).digest('hex');
  const manifestPath = path.join(parent, 'manifest.json');
  const stagedManifest = path.join(parent, `manifest-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(stagedManifest, JSON.stringify({ version: 1, sources, files }, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(stagedManifest, manifestPath);
  await verifyIndicatorFiles(binaryPath, root);
  return { built: true, runtime: '.NET 9 Desktop', destination: output, sourceManifest: 'verified', packageDownloads: false };
}

async function download(url, output) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}.`);
  let bytes = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > 110 * 1024 * 1024) callback(new Error('Release archive exceeds the download limit.'));
    else callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(output, { flags: 'wx' }));
}

async function installEngine() {
  if (process.platform !== pin.platform || process.arch !== pin.architecture) throw new Error('The pinned computer backend currently supports Windows x64.');
  const destination = path.dirname(DEFAULT_BINARY);
  try {
    await fs.access(destination);
    await verifyFiles(DEFAULT_BINARY);
    return { ...plan(), installed: true, changed: false, integrity: 'verified' };
  } catch (error) {
    // A present but mismatched runtime belongs to the caller: never overwrite it automatically.
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, 'install-'));
  const archive = path.join(stage, 'winappcli-x64.zip');
  await download(pin.url, archive);
  const digest = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  if (digest !== pin.archiveSha256) throw new Error('Release archive integrity mismatch. Preserved for inspection; nothing installed.');
  const unpacked = path.join(stage, 'bin');
  const extractionScript = path.join(stage, 'extract.ps1');
  await fs.writeFile(extractionScript, 'param([string]$ArchivePath, [string]$DestinationPath)\n$ErrorActionPreference = "Stop"\nExpand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath\n', { flag: 'wx' });
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', extractionScript, '-ArchivePath', archive, '-DestinationPath', unpacked], { timeoutMs: 120000, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error('Release extraction failed. Staging files preserved for inspection.');
  await verifyFiles(path.join(unpacked, 'winapp.exe'));
  await fs.rename(unpacked, destination);
  await fs.writeFile(path.join(parent, 'installation.json'), JSON.stringify({ version: pin.version, archiveSha256: digest, files: pin.files, installedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  return { ...plan(), installed: true, changed: true, integrity: 'verified' };
}

async function install() {
  const engine = await installEngine();
  const output = path.dirname(DEFAULT_BRIDGE);
  const parent = path.dirname(output);
  await fs.mkdir(parent, { recursive: true });
  const project = path.join(ROOT, 'native', 'TraceWindowBridge', 'TraceWindowBridge.csproj');
  const result = await runProcess('dotnet', ['publish', project, '--configuration', 'Release', '--output', output, '--artifacts-path', path.join(parent, 'artifacts'), '--nologo'], { timeoutMs: 120000, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error('Window bridge build failed. Install the .NET 9 SDK; engine files remain preserved.');
  const files = {};
  for (const name of ['TraceWindowBridge.exe', 'TraceWindowBridge.dll', 'TraceWindowBridge.runtimeconfig.json', 'TraceWindowBridge.deps.json']) files[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(output, name))).digest('hex');
  await fs.writeFile(path.join(parent, 'manifest.json'), JSON.stringify({ version: 1, sources: await bridgeSourceHashes(), files }, null, 2) + '\n');
  const activityIndicator = await buildActivityIndicator();
  return { ...engine, bridge: { built: true, runtime: '.NET 9', destination: output, sourceManifest: 'verified' }, activityIndicator };
}

async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args[0] && !['--plan', '--apply'].includes(args[0]))) throw new Error('Usage: node scripts/setup-computer.cjs [--plan|--apply]');
  return args[0] === '--apply' ? install() : plan();
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => { process.stderr.write(`Computer setup failed: ${error.message}\n`); process.exitCode = 1; });
module.exports = { plan, main, buildActivityIndicator };
