'use strict';

const { spawn: spawnChild } = require('node:child_process');
const { resolve } = require('node:path');

const DEFAULT_CLIENTS = Object.freeze([
  'codex',
  'claude_code',
  'grok_build',
  'gemini_cli',
]);
const SUPPORTED_CLIENTS = DEFAULT_CLIENTS;
const COMMANDS = new Set(['plan', 'apply', 'doctor', 'mcp']);

const HELP = `TRACE Workbench — pinned local REA integration

Usage:
  trace-workbench plan   [--client NAME ...] [--skill-client NAME ...]
  trace-workbench apply  [--client NAME ...] [--skill-client NAME ...]
  trace-workbench doctor [--client NAME ...]
  trace-workbench mcp
  trace-workbench --help

Clients: codex, claude_code, grok_build, gemini_cli
Without --client, all four clients are selected. Repeating --client narrows
the selection. Setup always includes those clients' bundled skill
destinations; --skill-client adds destinations without adding MCP clients.
REA uses the shared canonical skill for Grok; its personal discovery link
is managed separately.

plan    Print REA's scoped setup plan as JSON; do not apply it.
apply   Apply the scoped setup and bundled skill installation as JSON.
        Running this explicit command authorizes those configuration writes.
doctor  Check the selected registrations and report JSON diagnostics.
mcp     Serve the pinned REA MCP server over stdio. Supply no extra options.

Uses this repository's rea-agents package, never npx or a global executable.
No command selects native analysis-provider installation, changes PATH, or
automatically requests paid model inference. Existing home environment
variables pass through unchanged. Restart agent clients after applying
registration changes.
`;

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgumentError';
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw new ArgumentError('Arguments must be strings.');
  }
  if (argv.length === 0) return { help: true };
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length > 1) throw new ArgumentError('Help accepts no additional arguments.');
    return { help: true };
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) {
    throw new ArgumentError(`Unknown command: ${command}. Use --help.`);
  }
  const clients = [];
  const skillClients = [];
  let help = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    const separator = argument.indexOf('=');
    const option = separator === -1 ? argument : argument.slice(0, separator);
    if (option !== '--client' && option !== '--skill-client') {
      throw new ArgumentError(`Unknown argument: ${argument}. Use --help.`);
    }
    if (command === 'mcp') {
      throw new ArgumentError('mcp accepts no client or skill options.');
    }
    if (option === '--skill-client' && command === 'doctor') {
      throw new ArgumentError('doctor accepts --client only; skill destinations are setup options.');
    }
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith('-')) {
      throw new ArgumentError(`${option} requires a supported client name.`);
    }
    if (!SUPPORTED_CLIENTS.includes(value)) {
      throw new ArgumentError(`Unsupported client: ${value}. Supported: ${SUPPORTED_CLIENTS.join(', ')}.`);
    }
    const selected = option === '--client' ? clients : skillClients;
    if (!selected.includes(value)) selected.push(value);
  }
  if (help) return { help: true };
  if (command === 'mcp') return { command, clients: [], skillClients: [] };
  const resolvedClients = clients.length === 0 ? [...DEFAULT_CLIENTS] : clients;
  // REA treats --skill-client as an override, rather than adding it to the
  // destinations implied by --client. Preserve every selected client's skill
  // destination when the caller adds another destination.
  const resolvedSkillClients = command === 'plan' || command === 'apply'
    ? [...new Set([...resolvedClients, ...skillClients])]
    : [];
  return { command, clients: resolvedClients, skillClients: resolvedSkillClients };
}

function createInvocation(parsed, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? resolve(__dirname, '..');
  const dispatcher = resolve(repositoryRoot, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
  if (parsed.help) throw new ArgumentError('Help has no REA invocation.');
  // Only argv produced by our parser is accepted; upstream flags cannot be
  // smuggled through an exported API or a shell command string.
  const sourceArguments = [parsed.command];
  for (const client of parsed.clients ?? []) sourceArguments.push('--client', client);
  for (const client of parsed.skillClients ?? []) sourceArguments.push('--skill-client', client);
  const checked = parseArguments(sourceArguments);
  const args = [dispatcher];
  if (checked.command === 'mcp') {
    args.push('mcp');
  } else {
    args.push(checked.command === 'doctor' ? 'doctor' : 'setup');
    for (const client of checked.clients) args.push('--client', client);
    if (checked.command !== 'doctor') {
      for (const client of checked.skillClients) args.push('--skill-client', client);
      args.push(checked.command === 'plan' ? '--dry-run' : '--yes');
    }
    args.push('--json');
  }
  return { command: options.execPath ?? process.execPath, args };
}

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 };
  return numbers[signal] === undefined ? 1 : 128 + numbers[signal];
}

function runInvocation(invocation, options = {}) {
  const spawn = options.spawn ?? spawnChild;
  const signalSource = options.signalSource ?? process;
  const environment = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  return new Promise((resolveExit) => {
    let child;
    let settled = false;
    const handlers = new Map();
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
      if (child) {
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      }
      resolveExit(code);
    };
    const onError = (error) => {
      stderr.write(`TRACE could not start REA: ${error.message}\n`);
      finish(1);
    };
    const onClose = (code, signal) => finish(Number.isInteger(code) ? code : signalExitCode(signal));
    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: 'inherit',
        env: environment,
      });
      child.once('error', onError);
      child.once('close', onClose);
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => {
          try {
            child.kill(signal);
          } catch (error) {
            // ESRCH means that the child already finished; its close event owns
            // completion. Other failures are reported without leaking env data.
            if (error.code !== 'ESRCH') stderr.write(`TRACE could not forward ${signal}: ${error.message}\n`);
          }
        };
        handlers.set(signal, handler);
        signalSource.on(signal, handler);
      }
      const onParentExit = () => {
        try { child.kill(); } catch { /* The process is already exiting. */ }
      };
      handlers.set('exit', onParentExit);
      signalSource.on('exit', onParentExit);
    } catch (error) {
      onError(error);
    }
  });
}

async function runCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error;
    stderr.write(`TRACE: ${error.message}\n`);
    return 2;
  }
  if (parsed.help) {
    stdout.write(HELP);
    return 0;
  }
  return runInvocation(createInvocation(parsed, options), options);
}

module.exports = {
  ArgumentError,
  DEFAULT_CLIENTS,
  HELP,
  SUPPORTED_CLIENTS,
  createInvocation,
  parseArguments,
  runCli,
  runInvocation,
};
