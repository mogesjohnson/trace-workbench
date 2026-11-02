#!/usr/bin/env node
'use strict';

// Builds native/TracePhoneAgent into .runtime/phone/build/classes.dex.
// javac --release 11 against the newest android.jar, then d8 from the newest build-tools.
// Uses a JDK 11+ (Android Studio's bundled JBR by default), never an older java on PATH.
// Overrides: TRACE_PHONE_JAVA_HOME (JDK root), ANDROID_HOME / ANDROID_SDK_ROOT (SDK root).
// Usage: node scripts/build-phone-agent.cjs [--print-config]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'TracePhoneAgent', 'src');
const OUT = path.join(ROOT, '.runtime', 'phone', 'build');
const exe = process.platform === 'win32' ? '.exe' : '';

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function findJavaHome(env = process.env) {
  const candidates = [env.TRACE_PHONE_JAVA_HOME];
  if (process.platform === 'win32') {
    for (const base of [env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
      if (base) candidates.push(path.join(base, 'Android', 'Android Studio', 'jbr'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
  } else {
    candidates.push('/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr'));
  }
  const home = firstExisting(candidates.filter(Boolean).map((c) => path.join(c, 'bin', `javac${exe}`)));
  if (!home) throw new Error('No JDK 11+ found. Install Android Studio or set TRACE_PHONE_JAVA_HOME to a JDK root.');
  return path.dirname(path.dirname(home));
}

function findSdk(env = process.env) {
  const sdk = firstExisting([
    env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ]);
  if (!sdk) throw new Error('No Android SDK found. Set ANDROID_HOME.');
  return sdk;
}

/** Highest version-named child of dir that contains file. */
function newest(dir, file, parse) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const ranked = entries
    .map((name) => ({ name, key: parse(name) }))
    .filter((e) => e.key && fs.existsSync(path.join(dir, e.name, file)))
    .sort((a, b) => compare(b.key, a.key));
  if (!ranked.length) throw new Error(`No ${file} under ${dir}`);
  return path.join(dir, ranked[0].name, file);
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

const platformKey = (name) => { const m = /^android-(\d+)$/.exec(name); return m && [Number(m[1])]; };
const buildToolsKey = (name) => (/^\d+(\.\d+)*$/.test(name) ? name.split('.').map(Number) : null);

function listFiles(dir, extension) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  });
}

function resolveConfig(env = process.env) {
  const javaHome = findJavaHome(env);
  const sdk = findSdk(env);
  return {
    javaHome,
    javac: path.join(javaHome, 'bin', `javac${exe}`),
    java: path.join(javaHome, 'bin', `java${exe}`),
    androidJar: newest(path.join(sdk, 'platforms'), 'android.jar', platformKey),
    d8Jar: newest(path.join(sdk, 'build-tools'), path.join('lib', 'd8.jar'), buildToolsKey),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
}

function build(config = resolveConfig()) {
  const classes = path.join(OUT, 'classes');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(classes, { recursive: true });
  run(config.javac, ['--release', '11', '-Xlint:-options', '-nowarn', '-cp', config.androidJar,
    '-d', classes, ...listFiles(SOURCE, '.java')]);
  const compiled = listFiles(classes, '.class');
  run(config.java, ['-cp', config.d8Jar, 'com.android.tools.r8.D8', '--release', '--min-api', '26',
    '--lib', config.androidJar, '--output', OUT, ...compiled]);
  const dex = path.join(OUT, 'classes.dex');
  if (!fs.existsSync(dex)) throw new Error(`d8 produced no ${dex}`);
  return { dex, bytes: fs.statSync(dex).size, classes: compiled.length };
}

if (require.main === module) {
  try {
    const config = resolveConfig();
    if (process.argv.includes('--print-config')) {
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    } else {
      const result = build(config);
      process.stdout.write(`built ${path.relative(ROOT, result.dex)} (${result.bytes} bytes, ${result.classes} classes)\n`);
    }
  } catch (error) {
    process.stderr.write(`build-phone-agent: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { resolveConfig, build, newest, compare };
