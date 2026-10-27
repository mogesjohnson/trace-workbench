'use strict';
// File-only preparation utilities. Import performs no native, media or application work.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const common = require('./replacement-acceptance-common.cjs');
const replay = require('./replay-workflow-runtime.cjs');
const flow = require('./accept-replay-workflow.cjs');
const ROOT = path.resolve(__dirname, '..');
const REPLAY_ROOT = path.resolve(ROOT, '../replay-studio');
const SOURCE = path.join(ROOT, 'evidence/live-acceptance-continuation/replay-finish-2/artifacts/fixture-demo.mp4');
const SOURCE_SHA256 = 'f16b79a74950e666b97f865ce4e4949e7e3912f58ea6082379ab5d630f6bbc85';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const need = (condition, message) => { if (!condition) throw new Error(message); };

// File-only setup may finish before claiming the prospective live attempt.
// It creates one new private derivative and never changes the retained source.
async function prepareMedia(privateRoot, { replayRoot = REPLAY_ROOT } = {}) {
  const root = await fs.realpath(path.join(ROOT, '.runtime'));
  const directory = await fs.realpath(privateRoot);
  const relative = path.relative(root, directory);
  need(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Private directory escapes runtime');
  need(digest(await fs.readFile(SOURCE)) === SOURCE_SHA256, 'Retained media hash changed');
  const fromReplay = createRequire(path.join(replayRoot, 'package.json'));
  const harness = fromReplay('./scripts/media-inspection-smoke.cjs');
  const { unpackedBinary } = fromReplay('./electron/engine.cjs');
  const ffprobe = unpackedBinary(fromReplay('@ffprobe-installer/ffprobe').path);
  const output = path.join(directory, 'pause-preview.mp4');
  const tool = (file, args) => exec(file, args, { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  await tool(harness.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-stream_loop', '-1', '-i', SOURCE,
    '-t', '180', '-map', '0:v:0', '-an', '-c', 'copy', output]);
  const result = await tool(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output]);
  const duration = Number(JSON.parse(result.stdout).format?.duration);
  need(Number.isFinite(duration) && duration >= 120, 'Private preview duration invalid');
  need(digest(await fs.readFile(SOURCE)) === SOURCE_SHA256, 'Retained media changed during preparation');
  return { path: output, duration, sha256: digest(await fs.readFile(output)), sourceSha256: SOURCE_SHA256 };
}

// The caller must separately manage acquired handles and terminal cleanup.
async function verifyPins(privateRoot, options = {}) {
  const deps = replay.createDeps({ privateRoot, replayRoot: options.replayRoot ?? REPLAY_ROOT,
    common, note: async () => {}, checkpoint: async () => {} });
  const pins = await deps.verifyPins();
  need(Object.keys(flow.PIN).every(key => pins[key] === flow.PIN[key]), 'REPLAY pin mismatch');
  return { deps, pins };
}
module.exports = { prepareMedia, verifyPins, SOURCE_SHA256 };
