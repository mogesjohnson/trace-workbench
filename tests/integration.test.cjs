'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { resolve } = require('node:path');
const test = require('node:test');
const {
  DEFAULT_CLIENTS,
  createInvocation,
  parseArguments,
  runCli,
} = require('../src/integration.cjs');

function fakeRuntime() {
  const child = new EventEmitter();
  const signalSource = new EventEmitter();
  const calls = [];
  const kills = [];
  const output = { stdout: '', stderr: '' };
  child.kill = (signal) => { kills.push(signal); return true; };
  return {
    child, signalSource, calls, kills, output,
    options: {
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
      signalSource,
      stdout: { write(value) { output.stdout += value; } },
      stderr: { write(value) { output.stderr += value; } },
      repositoryRoot: resolve('a repository with spaces'),
      execPath: resolve('node path with spaces', 'node.exe'),
      env: { HOME: 'isolated-test-home', USERPROFILE: 'isolated-test-profile' },
    },
  };
}

test('plan selects exactly four integrations and all corresponding skill destinations', () => {
  const invocation = createInvocation(parseArguments(['plan']));
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], resolve(__dirname, '../node_modules/rea-agents/scripts/rea.mjs'));
  assert.deepEqual(invocation.args.slice(1), [
    'setup',
    ...DEFAULT_CLIENTS.flatMap((client) => ['--client', client]),
    ...DEFAULT_CLIENTS.flatMap((client) => ['--skill-client', client]),
    '--dry-run', '--json',
  ]);
  assert.equal(invocation.args.includes('--yes'), false);
});

test('apply authorizes only scoped integration writes, never provider installation', () => {
  const invocation = createInvocation(parseArguments(['apply', '--client', 'codex']));
  assert.deepEqual(invocation.args.slice(1), [
    'setup', '--client', 'codex', '--skill-client', 'codex', '--yes', '--json',
  ]);
  for (const flag of ['--install-hopper', '--all-detected', '--provider', '--dry-run']) {
    assert.equal(invocation.args.includes(flag), false, flag);
  }
});

test('explicit client selection is repeatable, deduplicated, and does not broaden scope', () => {
  const parsed = parseArguments(['plan', '--client=gemini_cli', '--client', 'codex', '--client', 'codex']);
  assert.deepEqual(parsed.clients, ['gemini_cli', 'codex']);
  assert.deepEqual(parsed.skillClients, ['gemini_cli', 'codex']);
  const grok = parseArguments(['apply', '--client=grok_build', '--skill-client', 'grok_build']);
  assert.deepEqual(grok.clients, ['grok_build']);
  assert.deepEqual(grok.skillClients, ['grok_build']);
});

test('additional skill destinations retain selected clients without broadening MCP scope', () => {
  const invocation = createInvocation(parseArguments([
    'plan', '--client', 'codex', '--skill-client', 'claude_code', '--skill-client=gemini_cli',
  ]));
  assert.deepEqual(invocation.args.slice(1), [
    'setup', '--client', 'codex', '--skill-client', 'codex', '--skill-client', 'claude_code',
    '--skill-client', 'gemini_cli', '--dry-run', '--json',
  ]);
});

test('Codex plus an extra Claude skill keeps canonical and Claude destinations', () => {
  const parsed = parseArguments(['apply', '--client', 'codex', '--skill-client', 'claude_code']);
  assert.deepEqual(parsed.clients, ['codex']);
  assert.deepEqual(parsed.skillClients, ['codex', 'claude_code']);
  assert.deepEqual(createInvocation(parsed).args.slice(1), [
    'setup', '--client', 'codex', '--skill-client', 'codex',
    '--skill-client', 'claude_code', '--yes', '--json',
  ]);
});

test('skill union is stable and deduplicated across repeated invocation validation', () => {
  const parsed = parseArguments([
    'plan', '--client', 'claude_code', '--client', 'codex',
    '--skill-client', 'codex', '--skill-client', 'claude_code',
    '--skill-client', 'gemini_cli', '--skill-client', 'gemini_cli',
  ]);
  assert.deepEqual(parsed.clients, ['claude_code', 'codex']);
  assert.deepEqual(parsed.skillClients, ['claude_code', 'codex', 'gemini_cli']);
  assert.deepEqual(createInvocation(parsed), createInvocation(parseArguments([
    'plan', '--client', 'claude_code', '--client', 'codex', '--skill-client', 'gemini_cli',
  ])));
});

test('doctor is scoped JSON diagnostics without provider or inference flags', () => {
  assert.deepEqual(parseArguments(['doctor']).skillClients, []);
  const invocation = createInvocation(parseArguments(['doctor', '--client', 'claude_code']));
  assert.deepEqual(invocation.args.slice(1), ['doctor', '--client', 'claude_code', '--json']);
});

test('MCP forwards only the exact upstream production stdio command', () => {
  const invocation = createInvocation(parseArguments(['mcp']));
  assert.deepEqual(invocation.args.slice(1), ['mcp']);
});

for (const args of [
  ['setup'], ['apply', '--all-detected'], ['apply', '--install-hopper'],
  ['doctor', '--provider', 'hopper'], ['plan', '--client', 'claude_desktop'],
  ['plan', '--client'], ['plan', '--client='], ['plan', '--client', '--yes'],
  ['plan', '--skill-client', 'shared'], ['doctor', '--skill-client', 'grok_build'],
  ['mcp', '--client', 'codex'], ['mcp', '--yes'], ['mcp', '--json'],
  ['plan', '; touch dangerous'], ['plan', '--', 'apply'],
  ['--help', '--install-hopper'], ['plan', '--help', '--install-hopper'],
]) {
  test(`rejects unsupported or unsafe scope before spawning: ${JSON.stringify(args)}`, async () => {
    const runtime = fakeRuntime();
    assert.equal(await runCli(args, runtime.options), 2);
    assert.equal(runtime.calls.length, 0);
    assert.match(runtime.output.stderr, /^TRACE: /);
    assert.equal(runtime.output.stdout, '');
  });
}

test('invocation validation prevents bypassing the parser through its exported API', () => {
  assert.throws(() => createInvocation({ command: 'apply', clients: ['--install-hopper'] }), /requires a supported client/);
  assert.throws(() => createInvocation({ command: 'uninstall', clients: [] }), /Unknown command/);
});

test('plan delegates via argument array with shell disabled and isolated home preserved', async () => {
  const runtime = fakeRuntime();
  const promise = runCli(['plan', '--client', 'codex'], runtime.options);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].command, runtime.options.execPath);
  assert.deepEqual(runtime.calls[0].args, [
    resolve(runtime.options.repositoryRoot, 'node_modules/rea-agents/scripts/rea.mjs'),
    'setup', '--client', 'codex', '--skill-client', 'codex', '--dry-run', '--json',
  ]);
  assert.deepEqual(runtime.calls[0].options, {
    shell: false, windowsHide: true, stdio: 'inherit', env: runtime.options.env,
  });
  runtime.child.emit('close', 0, null);
  assert.equal(await promise, 0);
  assert.equal(runtime.output.stdout, '');
  assert.equal(runtime.output.stderr, '');
});

test('MCP does not write a banner or transform protocol output', async () => {
  const runtime = fakeRuntime();
  const promise = runCli(['mcp'], runtime.options);
  assert.equal(runtime.calls[0].options.stdio, 'inherit');
  runtime.child.emit('close', 0, null);
  assert.equal(await promise, 0);
  assert.deepEqual(runtime.output, { stdout: '', stderr: '' });
});

test('help exits successfully without starting REA or touching setup', async () => {
  for (const args of [[], ['--help'], ['help'], ['apply', '--help']]) {
    const runtime = fakeRuntime();
    assert.equal(await runCli(args, runtime.options), 0);
    assert.equal(runtime.calls.length, 0);
    assert.match(runtime.output.stdout, /explicit command authorizes/);
  }
});

test('child failure propagates and removes all process signal handlers', async () => {
  const runtime = fakeRuntime();
  const promise = runCli(['doctor'], runtime.options);
  assert.equal(runtime.signalSource.listenerCount('SIGINT'), 1);
  assert.equal(runtime.signalSource.listenerCount('SIGTERM'), 1);
  runtime.child.emit('close', 7, null);
  assert.equal(await promise, 7);
  assert.equal(runtime.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(runtime.signalSource.listenerCount('SIGTERM'), 0);
  assert.equal(runtime.signalSource.listenerCount('exit'), 0);
  assert.equal(runtime.child.listenerCount('close'), 0);
  assert.equal(runtime.child.listenerCount('error'), 0);
});

test('interrupt is forwarded to child and signal termination is reported', async () => {
  const runtime = fakeRuntime();
  const promise = runCli(['mcp'], runtime.options);
  runtime.signalSource.emit('SIGTERM');
  assert.deepEqual(runtime.kills, ['SIGTERM']);
  runtime.child.emit('close', null, 'SIGTERM');
  assert.equal(await promise, 143);
  assert.equal(runtime.signalSource.listenerCount('SIGTERM'), 0);
});

test('spawn errors are reported once and handlers are cleaned', async () => {
  const runtime = fakeRuntime();
  const promise = runCli(['doctor'], runtime.options);
  runtime.child.emit('error', new Error('test executable unavailable'));
  runtime.child.emit('close', -1, null);
  assert.equal(await promise, 1);
  assert.equal(runtime.signalSource.listenerCount('SIGINT'), 0);
  assert.match(runtime.output.stderr, /could not start REA: test executable unavailable/);
});

test('parent exit requests child shutdown rather than abandoning the MCP server', async () => {
  const runtime = fakeRuntime();
  const promise = runCli(['mcp'], runtime.options);
  runtime.signalSource.emit('exit', 1);
  assert.deepEqual(runtime.kills, [undefined]);
  runtime.child.emit('close', null, 'SIGTERM');
  assert.equal(await promise, 143);
  assert.equal(runtime.signalSource.listenerCount('exit'), 0);
});

test('synchronous spawn errors return failure without installing signal handlers', async () => {
  const runtime = fakeRuntime();
  runtime.options.spawn = () => { throw new Error('test spawn rejected'); };
  assert.equal(await runCli(['plan'], runtime.options), 1);
  assert.equal(runtime.signalSource.listenerCount('SIGINT'), 0);
  assert.match(runtime.output.stderr, /test spawn rejected/);
});
