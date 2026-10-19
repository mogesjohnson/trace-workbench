#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/integration.cjs');

runCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`TRACE failed: ${error.message}\n`);
    process.exitCode = 1;
  },
);
