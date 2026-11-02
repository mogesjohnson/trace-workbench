#!/usr/bin/env node
'use strict';

// Installs or updates TRACE in the phone's proot Debian (Termux) from a git ref, in one command.
// PC side: git archive of the ref, build the agent dex from that tree, push the archive, dex and
// an install script to /sdcard/Download/trace-install (adb cannot write Termux's home). Then it
// types one command into the Termux terminal (adb shell lacks Termux's RUN_COMMAND permission),
// which runs the install script in Debian and writes a log the PC reads back.
// Debian side: npm ci --omit=dev into /opt/trace.new, swap with /opt/trace (frames kept), copy
// skills/trace-phone, register the user-level MCP server trace-phone, apply the A2 permission
// profile, delete the staging files, and print `claude mcp list`.
// Precondition: phone unlocked, Termux at a shell prompt (not inside a running program).
// Usage: node scripts/install-phone-claude.cjs [--ref <git ref>] [--serial <id>] [--check] [--print]
//   --check  prints the installed ref and the trace-phone MCP status; installs nothing.
//   --print  stages the files and prints the Termux command instead of typing it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = '/sdcard/Download/trace-install';
const NODE_BIN = '/opt/node22/bin';
const END = 'TRACE-INSTALL-END';
const TERMUX_SHELL = '#!/data/data/com.termux/files/usr/bin/bash';

function parseArgs(argv) {
  const opts = { ref: 'HEAD', serial: null, check: false, print: false, timeoutSec: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--print') opts.print = true;
    else if (arg === '--ref' || arg === '--serial' || arg === '--timeout') {
      const value = argv[i += 1];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === '--ref') opts.ref = value;
      else if (arg === '--serial') opts.serial = value;
      else opts.timeoutSec = Number(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[0-9a-f]{40}$/.test(opts.ref) && !/^[\w./^~-]+$/.test(opts.ref)) throw new Error(`Bad ref: ${opts.ref}`);
  return opts;
}

// The Debian-side install script for commit `sha`. Fails fast; the swap happens only after npm ci.
function installScript(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('installScript needs a full commit sha');
  return [
    'set -eu',
    `S=${STAGE}`,
    `export PATH=${NODE_BIN}:$PATH`,
    'rm -rf /opt/trace.new && mkdir -p /opt/trace.new/.runtime/phone/build',
    'tar -xf "$S/src.tar" -C /opt/trace.new',
    'cp "$S/classes.dex" /opt/trace.new/.runtime/phone/build/classes.dex',
    '(cd /opt/trace.new && npm ci --omit=dev --no-audit --no-fund)',
    `echo ${sha} > /opt/trace.new/.trace-ref`,
    'if [ -d /opt/trace/.runtime/phone/frames ]; then mkdir -p /opt/trace.new/.runtime/phone && mv /opt/trace/.runtime/phone/frames /opt/trace.new/.runtime/phone/frames; fi',
    'rm -rf /opt/trace.old',
    'if [ -d /opt/trace ]; then mv /opt/trace /opt/trace.old; fi',
    'mv /opt/trace.new /opt/trace && rm -rf /opt/trace.old',
    'mkdir -p ~/.claude/skills && rm -rf ~/.claude/skills/trace-phone && cp -r /opt/trace/skills/trace-phone ~/.claude/skills/trace-phone',
    'claude mcp remove --scope user trace-phone >/dev/null 2>&1 || true',
    `claude mcp add --scope user trace-phone -- ${NODE_BIN}/node /opt/trace/bin/trace.cjs phone mcp`,
    'node /opt/trace/scripts/configure-phone-permissions.cjs --apply',
    'rm -f "$S/src.tar" "$S/classes.dex"',
    checkScript().trimEnd(),
  ].join('\n') + '\n';
}

function checkScript() {
  return [
    'echo "installed ref: $(cat /opt/trace/.trace-ref 2>/dev/null || echo none)"',
    'claude mcp list 2>&1 | grep -E "^trace-phone:" || echo "trace-phone: not registered"',
  ].join('\n') + '\n';
}

// Termux-side wrapper: runs the Debian script and appends the end marker with its exit code.
function termuxRunner(script) {
  return [
    TERMUX_SHELL,
    `L=${STAGE}/install.log`,
    `proot-distro login debian -- bash -l ${STAGE}/${script} > "$L" 2>&1`,
    `echo "${END} $?" >> "$L"`,
  ].join('\n') + '\n';
}

const termuxCommand = () => `bash ${STAGE}/run.sh`;

function parseLog(text) {
  const match = /TRACE-INSTALL-END (\d+)/.exec(text || '');
  return match ? { done: true, code: Number(match[1]) } : { done: false, code: null };
}

function run(cmd, args, options = {}) {
  const out = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...options });
  if (out.error) throw out.error;
  if (out.status !== 0 && !options.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${out.status}): ${out.stderr || out.stdout}`);
  return out;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function main(argv) {
  const opts = parseArgs(argv);
  const adb = (...args) => run('adb', [...(opts.serial ? ['-s', opts.serial] : []), ...args]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-phone-install-'));
  try {
    adb('shell', 'mkdir', '-p', STAGE);
    let script = 'check.sh';
    if (opts.check) {
      fs.writeFileSync(path.join(tmp, script), checkScript());
    } else {
      const sha = run('git', ['rev-parse', '--verify', `${opts.ref}^{commit}`], { cwd: ROOT }).stdout.trim();
      const src = path.join(tmp, 'src');
      fs.mkdirSync(src);
      run('git', ['archive', '--format=tar', '-o', path.join(tmp, 'src.tar'), sha], { cwd: ROOT });
      run('tar', ['-xf', path.join(tmp, 'src.tar'), '-C', src]);
      run(process.execPath, [path.join(src, 'scripts', 'build-phone-agent.cjs')], { stdio: 'inherit' });
      script = 'install.sh';
      fs.writeFileSync(path.join(tmp, script), installScript(sha));
      adb('push', path.join(tmp, 'src.tar'), `${STAGE}/src.tar`);
      adb('push', path.join(src, '.runtime', 'phone', 'build', 'classes.dex'), `${STAGE}/classes.dex`);
      console.log(`staged ${sha}`);
    }
    fs.writeFileSync(path.join(tmp, 'run.sh'), termuxRunner(script));
    adb('push', path.join(tmp, script), `${STAGE}/${script}`);
    adb('push', path.join(tmp, 'run.sh'), `${STAGE}/run.sh`);
    adb('shell', 'rm', '-f', `${STAGE}/install.log`);
    if (opts.print) { console.log(`In Termux, run: ${termuxCommand()}`); return 0; }
    adb('shell', 'am', 'start', '-n', 'com.termux/.app.TermuxActivity');
    adb('shell', 'input', 'text', termuxCommand().replace(/ /g, '%s'));
    adb('shell', 'input', 'keyevent', '66');
    const deadline = Date.now() + opts.timeoutSec * 1000;
    let log = '';
    while (Date.now() < deadline) {
      sleep(3000);
      log = run('adb', [...(opts.serial ? ['-s', opts.serial] : []), 'shell', 'cat', `${STAGE}/install.log`], { allowFail: true }).stdout;
      if (parseLog(log).done) break;
    }
    process.stdout.write(log);
    const result = parseLog(log);
    if (!result.done) { console.error(`No ${END} marker after ${opts.timeoutSec}s; is Termux at a shell prompt?`); return 2; }
    return result.code;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, installScript, checkScript, termuxRunner, termuxCommand, parseLog, STAGE, END };
