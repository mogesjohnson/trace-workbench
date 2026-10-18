'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { plan, apply } = require('../scripts/link-grok-skill.cjs');

function workspace(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-skill-link-'));
  t.after(() => {
    const resolved = fs.realpathSync(home);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('trace-skill-link-')) {
      throw new Error('Refusing cleanup outside the owned temporary directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const source = path.join(home, '.agents/skills/reverse-engineer-anything');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: reverse-engineer-anything\nmetadata:\n  version: "42"\n---\n');
  return { home, source, target: path.join(home, '.grok/skills/reverse-engineer-anything') };
}

test('planning leaves the Grok skill destination untouched', t => {
  const { home, target } = workspace(t);
  assert.equal(plan(home).action, 'create-link');
  assert.equal(fs.existsSync(target), false);
});
test('link resolves the shared skill and a second apply preserves it', t => {
  const { home, source, target } = workspace(t);
  assert.equal(apply(home).action, 'create-link');
  assert.equal(fs.realpathSync(target), fs.realpathSync(source));
  assert.equal(apply(home).action, 'already-linked');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'));
});
test('existing independent skill content is preserved', t => {
  const { home, target } = workspace(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'personal content');
  assert.throws(() => apply(home), /preserved/);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'personal content');
});
test('stale source version never creates a discovery link', t => {
  const { home, source, target } = workspace(t);
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'name: reverse-engineer-anything\nmetadata:\n  version: "23"\n');
  assert.throws(() => apply(home), /v42/);
  assert.equal(fs.existsSync(target), false);
});
