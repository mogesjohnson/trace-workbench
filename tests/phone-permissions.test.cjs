'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { decide } = require('../scripts/phone-act-hook.cjs');
const { plan, ALLOW } = require('../scripts/configure-phone-permissions.cjs');

const act = (action, tool = 'mcp__trace-phone__phone_act') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { action } });

const verdict = (event) => decide(event)?.hookSpecificOutput.permissionDecision;

test('hook allows only the policy keys home and back and asks for the rest', () => {
  for (const key of ['home', 'back']) assert.equal(verdict(act({ type: 'key', key })), 'allow');
  for (const action of [{ type: 'key', key: 'power' }, { type: 'key', key: 3 }, { type: 'text', text: 'hi' },
    { type: 'tap', x: 1, y: 1 }, { type: 'key', key: 'home', extra: 1 }, undefined]) assert.equal(verdict(act(action)), 'ask', JSON.stringify(action));
  assert.equal(decide(act({ type: 'key', key: 'home' }, 'mcp__other__phone_act')), null);
  assert.equal(decide(null), null);
});

test('hook process prints allow, ask, or nothing for other tools', () => {
  const hook = path.join(__dirname, '..', 'scripts', 'phone-act-hook.cjs');
  const run = (input) => spawnSync(process.execPath, [hook], { input, encoding: 'utf8', windowsHide: true });
  const home = run(JSON.stringify(act({ type: 'key', key: 'home' })));
  assert.equal(home.status, 0);
  assert.equal(JSON.parse(home.stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(JSON.parse(run(JSON.stringify(act({ type: 'text', text: 'x' }))).stdout).hookSpecificOutput.permissionDecision, 'ask');
  for (const input of [JSON.stringify(act({ type: 'key', key: 'home' }, 'Bash')), 'not json']) {
    const out = run(input);
    assert.equal(out.status, 0);
    assert.equal(out.stdout, '');
  }
});

test('profile allows no find or delete', () => {
  assert.deepEqual(ALLOW.filter((rule) => /find|delete|rm /.test(rule)), []);
});

test('plan removes both retired frame-prune rules', () => {
  const old = ['Bash(find .runtime/phone/frames -type f -mtime +7 -delete)',
    'Bash(find /opt/trace/.runtime/phone/frames -type f -mtime +7 -delete)'];
  const { next, changes } = plan({ permissions: { allow: ['Read', ...old] } }, '/h/.claude/hooks/trace-phone-act.cjs');
  for (const rule of old) {
    assert.ok(!next.permissions.allow.includes(rule));
    assert.ok(changes.includes(`permissions.allow -= ${rule}`));
  }
  assert.ok(next.permissions.allow.includes('Read'));
});

test('plan adds the profile, keeps other settings and is idempotent', () => {
  const settings = { theme: 'dark', permissions: { defaultMode: 'auto', allow: ['Read'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
  const first = plan(settings, '/h/.claude/hooks/trace-phone-act.cjs');
  assert.equal(first.next.theme, 'dark');
  assert.equal(first.next.permissions.defaultMode, 'auto');
  assert.deepEqual(first.next.permissions.allow, ['Read', ...ALLOW]);
  assert.equal(first.next.permissions.ask, undefined);
  assert.deepEqual(first.next.hooks.SessionStart, settings.hooks.SessionStart);
  assert.equal(first.next.hooks.PreToolUse[0].matcher, 'mcp__trace-phone__phone_act');
  assert.equal(settings.permissions.allow.length, 1, 'input not mutated');
  const second = plan(first.next, '/h/.claude/hooks/trace-phone-act.cjs');
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.next, first.next);
});
