#!/usr/bin/env node
'use strict';

// Runs in the phone's Debian after a reboot (started by the Termux:Boot script that
// install-phone-claude.cjs installs). Shizuku turns Wireless debugging on at boot on a trusted
// Wi-Fi network; this script finds that TLS port on 127.0.0.1 (mDNS does not work inside proot),
// connects Debian's adb (its key is already paired), reopens port 5555 with `adb tcpip 5555`
// and connects to 127.0.0.1:5555, so phone Claude reaches the phone as in task A3.
// Usage: node phone-boot-adb.cjs [--wait-sec 300]
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const TARGET = '127.0.0.1:5555';
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

async function main(argv) {
  const waitIndex = argv.indexOf('--wait-sec');
  const waitSec = waitIndex >= 0 ? Number(argv[waitIndex + 1]) : 300;
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
  log(adb('start-server') || 'adb server running');
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    adb('connect', TARGET);
    if (isDevice(TARGET)) { log(`${TARGET} device (port 5555 already open)`); return 0; }
    adb('disconnect', TARGET);
    const ports = await openPorts();
    const tls = connectFirst(ports);
    if (tls) {
      log(`wireless debugging at ${tls}; reopening 5555`);
      log(adb('-s', tls, 'tcpip', '5555'));
      for (let i = 0; i < 10 && !isDevice(TARGET); i += 1) { await sleep(1000); adb('connect', TARGET); }
      adb('disconnect', tls);
      if (isDevice(TARGET)) { log(`${TARGET} device`); log(adb('devices', '-l')); return 0; }
      log(`${TARGET} not reachable after tcpip`);
    } else {
      log(`no adb port among ${ports.length} open ports; waiting for Wireless debugging`);
    }
    await sleep(10000);
  }
  log(`gave up after ${waitSec}s: is the phone on a trusted Wi-Fi network and Shizuku set to start on boot?`);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { parseDevices, openPorts, TARGET };
