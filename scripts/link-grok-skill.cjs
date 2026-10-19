#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function plan(home = os.homedir()) {
  const source = path.resolve(home, '.agents/skills/reverse-engineer-anything');
  const target = path.resolve(home, '.grok/skills/reverse-engineer-anything');
  const skill = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
  if (!/^name: reverse-engineer-anything$/m.test(skill) || !/^\s+version: ["']?42["']?$/m.test(skill)) {
    throw new Error('Install the pinned REA v42 skill before linking Grok discovery.');
  }
  let existing;
  try { existing = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!existing) return { source, target, action: 'create-link' };
  if (existing.isSymbolicLink() && fs.realpathSync(target) === fs.realpathSync(source)) {
    return { source, target, action: 'already-linked' };
  }
  throw new Error('Grok already has a different skill destination. It was preserved; review it before replacing it.');
}

function apply(home = os.homedir()) {
  const planned = plan(home);
  if (planned.action === 'create-link') {
    fs.mkdirSync(path.dirname(planned.target), { recursive: true });
    // Creating the link is atomic; an intervening existing path is never removed.
    fs.symlinkSync(planned.source, planned.target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { ...planned, applied: true };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--plan', '--apply'].includes(args[0])) {
      throw new Error('Usage: node scripts/link-grok-skill.cjs --plan|--apply');
    }
    console.log(JSON.stringify(args[0] === '--apply' ? apply() : plan(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { plan, apply };
