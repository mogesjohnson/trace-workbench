#!/usr/bin/env node
'use strict';

// Runs in the phone's Debian after a reboot (started by the Termux:Boot script that
// install-phone-claude.cjs installs). Shizuku turns Wireless debugging on at boot on a trusted
// Wi-Fi network; this script finds that TLS port on 127.0.0.1 (mDNS does not work inside proot),
// connects Debian's adb (its key is already paired), reopens port 5555 with `adb tcpip 5555`
// and connects to 127.0.0.1:5555, so phone Claude reaches the phone as in task A3. Then it starts
// the Wi-Fi trust watcher (trace.phone.WifiTrust in the agent dex), which marks each newly joined
// network "always allow" for Wireless debugging (owner decision, 2 Nov 2026).
// With --keep-alive (started in the background by the boot script) it instead checks every 30 s
// that 127.0.0.1:5555 is a device and the watcher runs, reconnecting and restarting it after an
// adbd restart, which kills the watcher.
// Usage: node phone-boot-adb.cjs [--wait-sec 300] | --keep-alive [--interval-sec 30]
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const TARGET = '127.0.0.1:5555';
const DEX = '/opt/trace/.runtime/phone/build/classes.dex';
const REMOTE_DEX = '/data/local/tmp/trace-wifi.dex';
const WATCH_LOG = '/data/local/tmp/trace-wifi.log';
const WATCH_NAME = 'tracewifitrust';
const LOCK = '/tmp/trace-keepalive.pid';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function adb(...args) {
  const out = spawnSync('adb', args, { encoding: 'utf8', timeout: 15000 });
  return `${out.stdout || ''}${out.stderr || ''}`.trim();
}

// `adb devices` output -> { serial: state }
function parseDevices(text) {
  const map = {};
  for (const line of String(text).split('\n').slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state) map[serial] = state;
  }
  return map;
}

const isDevice = (serial) => parseDevices(adb('devices'))[serial] === 'device';

// Open TCP ports on 127.0.0.1 in [from, to], checked `concurrency` at a time.
async function openPorts({ from = 30000, to = 65535, skip = [5555], concurrency = 400, timeoutMs = 300 } = {}) {
  const found = [];
  let next = from;
  const probe = (port) => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  async function worker() {
    while (next <= to) {
      const port = next++;
      if (!skip.includes(port) && await probe(port)) found.push(port);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found.sort((a, b) => a - b);
}

// Tries each candidate port; returns the serial that adb accepted as a device, or null.
// A port that is not adbd leaves an `offline` entry, which is disconnected again.
function connectFirst(ports) {
  for (const port of ports) {
    const serial = `127.0.0.1:${port}`;
    adb('connect', serial);
    if (isDevice(serial)) return serial;
    adb('disconnect', serial);
  }
  return null;
}

// Shell command that (re)starts the trust watcher detached from the adb session. The process is
// named WATCH_NAME, matched as the whole command line (an unanchored -f also matches this command's own shell).
function watcherCommand() {
  return `pkill -f '^${WATCH_NAME}$'; CLASSPATH=${REMOTE_DEX} nohup app_process / --nice-name=${WATCH_NAME} trace.phone.WifiTrust`
    + ` > ${WATCH_LOG} 2>&1 < /dev/null &`;
}

function startWatcher(log, serial = TARGET) {
  log(adb('-s', serial, 'push', DEX, REMOTE_DEX));
  adb('-s', serial, 'shell', watcherCommand());
  log(`trust watcher: ${adb('-s', serial, 'shell', `pgrep -f '^${WATCH_NAME}$'`) || 'not running'}`);
}

// One attempt to reach TARGET: port 5555 directly, else the Wireless debugging TLS port on
// 127.0.0.1, reopened as 5555 with `adb tcpip 5555`. Returns how it connected, or null.
async function connectOnce(log) {
  adb('connect', TARGET);
  if (isDevice(TARGET)) return 'port 5555 already open';
  adb('disconnect', TARGET);
  const ports = await openPorts();
  const tls = connectFirst(ports);
  if (!tls) { log(`no adb port among ${ports.length} open ports; waiting for Wireless debugging`); return null; }
  log(`wireless debugging at ${tls}; reopening 5555`);
  log(adb('-s', tls, 'tcpip', '5555'));
  for (let i = 0; i < 10 && !isDevice(TARGET); i += 1) { await sleep(1000); adb('connect', TARGET); }
  adb('disconnect', tls);
  if (isDevice(TARGET)) return 'reopened 5555';
  log(`${TARGET} not reachable after tcpip`);
  return null;
}

const watcherRunning = (serial = TARGET) => /^\d+$/m.test(adb('-s', serial, 'shell', `pgrep -f '^${WATCH_NAME}$'`));

// One keep-alive round. Android kills everything adbd started (its cgroup) when adbd restarts, so
// the watcher cannot outlive adbd on the phone; this Debian-side loop starts it again.
// Returns ok | adb_down | restarted | reconnected | reconnected+restarted.
async function keepAliveRound({ isUp, connect, running, start }) {
  let reconnected = false;
  if (!isUp()) {
    if (!await connect()) return 'adb_down';
    reconnected = true;
  }
  if (running()) return reconnected ? 'reconnected' : 'ok';
  start();
  return reconnected ? 'reconnected+restarted' : 'restarted';
}

// Keeps one keep-alive per Debian: the pid file names a live phone-boot-adb process -> false.
function claimLock(file, pid = process.pid, cmdline = (p) => fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')) {
  try {
    const old = Number(fs.readFileSync(file, 'utf8').trim());
    if (old && old !== pid && cmdline(old).includes('phone-boot-adb')) return false;
  } catch { /* no pid file, or the old process is gone */ }
  fs.writeFileSync(file, `${pid}\n`);
  return true;
}

async function keepAlive(log, intervalSec) {
  if (!claimLock(LOCK)) { log(`keep-alive already running (${LOCK})`); return 0; }
  log(`keep-alive started, every ${intervalSec} s`);
  let last = null;
  for (;;) {
    let result;
    try {
      result = await keepAliveRound({
        isUp: () => isDevice(TARGET),
        connect: () => connectOnce(log),
        running: () => watcherRunning(),
        start: () => startWatcher(log),
      });
    } catch (error) {
      result = `error: ${error.message}`;
    }
    if (result !== last) log(`keep-alive: ${result}`);
    last = result;
    await sleep(intervalSec * 1000);
  }
}

async function main(argv) {
  const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : fallback; };
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
  log(adb('start-server') || 'adb server running');
  if (argv.includes('--keep-alive')) return keepAlive(log, option('--interval-sec', 30));
  const deadline = Date.now() + option('--wait-sec', 300) * 1000;
  while (Date.now() < deadline) {
    const how = await connectOnce(log);
    if (how) { log(`${TARGET} device (${how})`); log(adb('devices', '-l')); startWatcher(log); return 0; }
    await sleep(10000);
  }
  log(`gave up after ${option('--wait-sec', 300)}s: is the phone on a trusted Wi-Fi network and Shizuku set to start on boot?`);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { parseDevices, openPorts, watcherCommand, keepAliveRound, claimLock, TARGET };
