'use strict';
// Compiles trace.phone.WifiTrust with tests/fixtures/WifiTrustTest.java and runs the checks on the
// host JVM. Needs the JDK and Android SDK that the phone agent build uses; skips without them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveConfig } = require('../src/agentic-phone/build.cjs');

const SOURCE = path.join(__dirname, '..', 'src', 'agentic-phone', 'native', 'src', 'trace', 'phone', 'WifiTrust.java');
const FIXTURE = path.join(__dirname, 'fixtures', 'WifiTrustTest.java');

let config = null;
try { config = resolveConfig(); } catch { config = null; }

test('WifiTrust parses the SDK 37 trusted list, picks the allow signature and logs repeats once', { skip: !config && 'no JDK/Android SDK' }, (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-wifi-trust-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const javac = spawnSync(config.javac, ['--release', '11', '-Xlint:-options', '-nowarn', '-cp', config.androidJar,
    '-d', out, SOURCE, FIXTURE], { encoding: 'utf8' });
  assert.equal(javac.status, 0, javac.stderr || javac.stdout);
  const run = spawnSync(config.java, ['-cp', [out, config.androidJar].join(path.delimiter), 'trace.phone.WifiTrustTest'],
    { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /all passed/);
});
