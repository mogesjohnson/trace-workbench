#!/usr/bin/env node
"use strict";

const { CLIENTS, plan, apply } = require("../src/computer/configuration.cjs");

function parseArguments(argv) {
  let mode = "plan";
  let explicitMode = false;
  const clients = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan" || argument === "--apply") {
      if (explicitMode) throw new Error("Choose --plan or --apply once.");
      mode = argument.slice(2);
      explicitMode = true;
    } else if (argument === "--client") {
      const client = argv[++index];
      if (!Object.hasOwn(CLIENTS, client)) throw new Error("Unknown client. Choose codex, claude_code, grok_build, or gemini_cli.");
      clients.push(client);
    } else {
      throw new Error("Usage: node scripts/configure-computer.cjs [--plan|--apply] [--client codex|claude_code|grok_build|gemini_cli]...");
    }
  }
  return { mode, ...(clients.length ? { clients: [...new Set(clients)] } : {}) };
}

async function main(argv = process.argv.slice(2)) {
  const { mode, ...options } = parseArguments(argv);
  const result = await (mode === "apply" ? apply(options) : plan(options));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.conflicts || result.error) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`TRACE configuration failed (${error.code ?? "invalid_arguments"}).\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, main };
