'use strict';

// src/agentic-phone/ is the phone link (adb, on-device agent, build). It must stay
// splittable into its own repo: only Node built-ins and files inside the folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src', 'agentic-phone');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(c|m)?js$/.test(entry.name) ? [full] : [];
  });
}

function specifiers(text) {
  const found = [];
  const pattern = /\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) found.push(match[1] ?? match[2]);
  return found;
}

test('agentic-phone imports only Node built-ins and its own files', () => {
  const files = sources(ROOT);
  assert.ok(files.length >= 5, `expected the phone link sources, found ${files.length}`);
  const violations = [];
  for (const file of files) {
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      const inside = spec.startsWith('.') && !path.relative(ROOT, path.resolve(path.dirname(file), spec)).startsWith('..');
      if (!inside) violations.push(`${path.relative(ROOT, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the boundary check catches an import that leaves the folder', () => {
  assert.deepEqual(specifiers("const a = require('../phone/server.cjs'); import b from 'zod';"), ['../phone/server.cjs', 'zod']);
});
