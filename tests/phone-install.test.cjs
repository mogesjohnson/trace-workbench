'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { remoteControlCommand, keepAliveCommand, RC_DIR, parseArgs, installScript, checkScript, bootScript, termuxRunner, termuxCommand, parseLog, STAGE } = require('../scripts/install-phone-claude.cjs');

const SHA = 'a'.repeat(40);

test('parseArgs reads ref, serial, check, print and rejects unknown or unsafe input', () => {
  assert.deepEqual(parseArgs([]), { ref: 'HEAD', serial: null, check: false, print: false, timeoutSec: 900 });
  const opts = parseArgs(['--ref', 'origin/main', '--serial', 'R5', '--check', '--print', '--timeout', '60']);
  assert.deepEqual(opts, { ref: 'origin/main', serial: 'R5', check: true, print: true, timeoutSec: 60 });
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
  assert.throws(() => parseArgs(['--ref']), /needs a value/);
  assert.throws(() => parseArgs(['--ref', 'main;rm -rf /']), /Bad ref/);
});

test('install script swaps only after npm ci, records the ref, keeps frames and cleans staging', () => {
  const lines = installScript(SHA).split('\n');
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));
  assert.equal(lines[0], 'set -eu');
  assert.ok(at(/npm ci --omit=dev/) < at(/mv \/opt\/trace \/opt\/trace\.old/));
  assert.ok(at(/frames/) < at(/mv \/opt\/trace \/opt\/trace\.old/), 'frames move before the old tree is removed');
  assert.ok(at(new RegExp(`echo ${SHA} > /opt/trace.new/.trace-ref`)) >= 0);
  assert.ok(at(/claude mcp add --scope user trace-phone -- \/opt\/node22\/bin\/node \/opt\/trace\/bin\/trace\.cjs phone mcp/) >= 0);
  assert.ok(at(/configure-phone-permissions\.cjs --apply/) >= 0);
  assert.ok(at(/rm -f "\$S\/src\.tar" "\$S\/classes\.dex"/) > at(/mv \/opt\/trace\.new \/opt\/trace/));
  assert.ok(installScript(SHA).endsWith(checkScript()));
  assert.throws(() => installScript('HEAD'), /full commit sha/);
});

test('termux runner logs to staging and appends the end marker; log parser reads the exit code', () => {
  const runner = termuxRunner('install.sh');
  assert.match(runner, /^#!\/data\/data\/com\.termux\/files\/usr\/bin\/bash\n/);
  assert.ok(runner.includes(`proot-distro login debian -- bash -l ${STAGE}/install.sh > "$L" 2>&1`));
  assert.equal(termuxCommand(), `bash ${STAGE}/run.sh`);
  assert.deepEqual(parseLog('npm ok\nTRACE-INSTALL-END 0\n'), { done: true, code: 0 });
  assert.deepEqual(parseLog('TRACE-INSTALL-END 3'), { done: true, code: 3 });
  assert.deepEqual(parseLog('still running'), { done: false, code: null });
  assert.deepEqual(parseLog(undefined), { done: false, code: null });
});

test('install puts the A4 boot script in ~/.termux/boot; a check does not', () => {
  const boot = bootScript();
  assert.match(boot, /^#!\/data\/data\/com\.termux\/files\/usr\/bin\/sh\n/);
  assert.ok(boot.includes('termux-wake-lock'));
  assert.ok(boot.includes('proot-distro login debian -- /opt/node22/bin/node /opt/trace/scripts/phone-boot-adb.cjs'));
  const rc = remoteControlCommand();
  assert.ok(boot.includes(rc), 'boot script starts Remote Control');
  assert.ok(boot.indexOf(rc) > boot.indexOf('phone-boot-adb.cjs'), 'after port 5555 is reopened');
  assert.ok(rc.startsWith("nohup proot-distro login debian -- bash -lc '"));
  assert.ok(rc.includes('adb start-server; adb connect 127.0.0.1:5555; cd /root/phone-work && exec claude remote-control --name s23-trace'));
  assert.ok(rc.endsWith(`' > "$HOME/.trace-rc.log" 2>&1 < /dev/null &`));
  const keep = keepAliveCommand();
  assert.ok(boot.includes(keep), 'boot script starts the watcher keep-alive');
  assert.ok(boot.indexOf(keep) > boot.indexOf(rc), 'after Remote Control');
  assert.equal(keep, 'nohup proot-distro login debian -- /opt/node22/bin/node /opt/trace/scripts/phone-boot-adb.cjs --keep-alive'
    + ' > "$HOME/.trace-keepalive.log" 2>&1 < /dev/null &');
  assert.ok(installScript(SHA).includes(`mkdir -p ${RC_DIR}`));
  assert.ok(installScript(SHA).includes('hasTrustDialogAccepted:true'));
  assert.ok(termuxRunner('install.sh').includes(`cp ${STAGE}/trace-adb ~/.termux/boot/trace-adb`));
  assert.ok(!termuxRunner('check.sh').includes('.termux/boot'));
});
