'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parse, main } = require('../scripts/smoke-computer-glow.cjs');

test('default glow acceptance plan is read-only and performs no input', async () => {
  assert.equal(parse([]).mode, 'plan');
  const result = await main([]);
  assert.equal(result.physicalInputActions, 0);
  assert.deepEqual(result.commands, ['focus', 'capture-desktop', 'close']);
  assert.equal(Object.keys(result.sources).length, 2);
});
test('fixture live mode needs an owned absolute directory and bounded lifetime', () => {
  assert.throws(() => parse(['--live']), /absolute/);
  assert.throws(() => parse(['--live', '--directory', 'relative']), /absolute/);
  for (const lifetime of ['0', '300001', 'NaN']) assert.throws(() => parse(['--live', '--directory', path.resolve('owned'), '--lifetime-ms', lifetime]), /Lifetime/);
});
test('instrumentation accepts only focus, desktop capture and close; no physical-input command', () => {
  for (const command of ['click', 'type', 'drag', 'activate', 'launch']) assert.throws(() => parse(['--command', command, '--directory', path.resolve('owned')]), /Only focus/);
});
test('desktop capture requires a bounded PNG basename and explicit expected marker PID', () => {
  const prefix = ['--command', 'capture-desktop', '--directory', path.resolve('owned')];
  for (const file of ['../private.png', 'nested/private.png', 'frame.jpg', '']) assert.throws(() => parse([...prefix, '--file', file, '--indicator-pid', '0']), /Capture requires/);
  assert.throws(() => parse([...prefix, '--file', 'frame.png']), /Capture requires/);
  assert.equal(parse([...prefix, '--file', 'before-glow.png', '--indicator-pid', '0']).indicatorPid, 0);
});
