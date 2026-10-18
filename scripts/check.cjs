'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const skipped = new Set(['.git', '.runtime', 'node_modules']);
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (skipped.has(entry.name) || entry.isSymbolicLink()) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}
let checked = 0;
for (const file of files(root)) {
  if (/\.(cjs|mjs|js)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || `Invalid JavaScript: ${path.relative(root, file)}`);
    checked++;
  }
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file.endsWith('.md')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const destination = match[1].split('#')[0];
      if (!destination || /^[a-z]+:|^\//i.test(destination)) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(destination));
      if (!fs.existsSync(target)) throw new Error(`Broken local link in ${path.relative(root, file)}: ${destination}`);
    }
    if (/C:[/\\]Users[/\\]/i.test(source)) throw new Error(`Personal absolute path in ${path.relative(root, file)}`);
  }
}
const manifest = require('../package.json');
const lock = require('../package-lock.json');
if (manifest.version !== lock.version || manifest.version !== lock.packages[''].version) throw new Error('Package version and lockfile disagree');
if (manifest.dependencies['rea-agents'] !== lock.packages['node_modules/rea-agents'].version) throw new Error('REA pin and lockfile disagree');
console.log(`Syntax, JSON, local documentation links, and dependency pins passed (${checked} JavaScript files).`);
