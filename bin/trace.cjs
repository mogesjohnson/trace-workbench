#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/integration.cjs');

async function phone(args) {
  const [command, ...extra] = args;
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write('TRACE Phone\n\n  trace-workbench phone mcp  Serve Android phone tools over stdio\n\nBuild the agent first: node scripts/build-phone-agent.cjs\n');
    return 0;
  }
  if (extra.length) throw new Error('Phone commands accept no extra options.');
  if (command === 'mcp') {
    await require('../src/phone/server.cjs').runPhoneServer();
    return 0;
  }
  throw new Error('Unknown phone command. Use phone --help.');
}

async function dispatch(args) {
  if (args[0] === 'phone') return phone(args.slice(1));
  if (args[0] !== 'computer') return runCli(args);
  const [command, ...extra] = args.slice(1);
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write('TRACE Computer Use\n\n  trace-workbench computer mcp     Serve computer tools over stdio\n  trace-workbench computer doctor  Check the pinned Windows engine\n  trace-workbench computer recover --check|--apply  Inspect or verify native cleanup\n\nSetup: node scripts/setup-computer.cjs --plan, then --apply\n');
    return 0;
  }
  if (command === 'recover') {
    if (extra.length !== 1 || !['--check', '--apply'].includes(extra[0])) throw new Error('Use computer recover --check or --apply.');
    const result = await require('../src/computer/supervisor.cjs').recovery(extra[0]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return extra[0] === '--apply' && (result.recovered !== true || result.recoveryRequired === true) ? 1 : 0;
  }
  if (extra.length) throw new Error('Computer commands accept no extra options.');
  if (command === 'mcp') {
    await require('../src/computer/server.cjs').runComputerServer();
    return 0;
  }
  if (command === 'doctor') {
    const controller = require('../src/computer/controller.cjs').createComputerController();
    try { process.stdout.write(`${JSON.stringify(await controller.doctor())}\n`); }
    finally { await controller.close(); }
    return 0;
  }
  throw new Error('Unknown computer command. Use computer --help.');
}

dispatch(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`TRACE failed: ${error.message}\n`);
    process.exitCode = 1;
  },
);
