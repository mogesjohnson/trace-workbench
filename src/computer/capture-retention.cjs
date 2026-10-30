'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function parseCaptureKeepLast(value) {
  if (value === undefined) return 0;
  if ((typeof value === 'string' && (!value.length || /[^0-9]/.test(value))) ||
      !['string', 'number'].includes(typeof value) || !Number.isInteger(Number(value)) ||
      Number(value) < 0 || Number(value) > 100) {
    throw Object.assign(new Error('Capture retention must be an integer from 0 to 100.'), { code: 'invalid_capture_retention' });
  }
  return Number(value);
}

// This is a best-effort policy for a trusted, app-owned runtime without
// concurrent external mutation. Path checks and unlink are not atomic.
function createCaptureRetention(directory, keepLast, io = fs) {
  const root = path.resolve(directory), entries = new Map();
  const name = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png(?![\s\S])/i;
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const identity = s => [s.dev, s.ino, s.birthtimeMs, s.size, s.mtimeMs];
  let rootIdentity;
  async function rootSafe() {
    const s = await io.lstat(root), real = path.resolve(await io.realpath(root));
    if (!s.isDirectory() || s.isSymbolicLink() || !samePath(root, real)) return false;
    const current = [s.dev, s.ino, s.birthtimeMs];
    if (!rootIdentity) rootIdentity = current;
    return current.every((v, i) => v === rootIdentity[i]);
  }
  async function fileIdentity(file) {
    const s = await io.lstat(file), real = path.resolve(await io.realpath(file));
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || !samePath(file, real)) return null;
    return identity(s);
  }
  async function sweep(protectedFile, closing, warnings) {
    let removed = 0, attempts = 0;
    const retained = new Set(closing ? [] : [...entries.keys()].slice(-keepLast));
    if (!closing && protectedFile) retained.add(path.resolve(protectedFile));
    for (const [file, expected] of entries) {
      if ([...retained].some(value => samePath(value, file))) continue;
      if (attempts >= 32) { warnings.add('pending'); break; }
      attempts++;
      try {
        if (!await rootSafe()) { warnings.add('directory_changed'); break; }
        const actual = await fileIdentity(file);
        if (!actual || !actual.every((v, i) => v === expected[i])) {
          entries.delete(file); warnings.add('capture_changed'); continue;
        }
        await io.unlink(file);
        entries.delete(file); removed++;
      } catch {
        warnings.add('io_failure');
      }
    }
    return removed;
  }
  function report(removed, warnings) {
    return { mode: 'keep-last', keepLast, tracked: entries.size, removed,
      status: warnings.size ? 'incomplete' : 'applied', warnings: [...warnings] };
  }
  return {
    forget(filePath) { entries.delete(path.resolve(filePath)); },
    async remember(filePath, protectedFilePath) {
      const warnings = new Set();
      try {
        const file = path.resolve(filePath);
        if (!samePath(path.dirname(file), root) || !name.test(path.basename(file))) warnings.add('invalid_capture_path');
        else if (!await rootSafe()) warnings.add('directory_changed');
        else {
          const found = await fileIdentity(file);
          if (!found) warnings.add('capture_changed');
          else entries.set(file, found);
        }
      } catch { warnings.add('io_failure'); }
      const removed = warnings.size ? 0 : await sweep(protectedFilePath, false, warnings);
      return report(removed, warnings);
    },
    async close() {
      const warnings = new Set();
      return report(await sweep(null, true, warnings), warnings);
    },
  };
}

module.exports = { parseCaptureKeepLast, createCaptureRetention };
