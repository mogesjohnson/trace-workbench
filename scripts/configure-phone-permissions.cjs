#!/usr/bin/env node
'use strict';

// Plans, then (with --apply) writes the Claude Code permission profile for trace-phone that
// matches docs/PHONE_AUTONOMY_POLICY.md: read-only phone tools and adb probes are allowed, and a
// PreToolUse hook allows phone_act only for the policy's allowed keys and asks for the rest.
// No "ask" rule is written: it would override the hook's allow.
// Only TRACE-owned entries are added; everything else in settings.json is kept, and the
// previous file is copied to settings.json.trace-backup-<ms> before a write.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'mcp__trace-phone__';
const ALLOW = [
  ...['phone_connect', 'phone_screen', 'phone_ui', 'phone_wait', 'phone_logcat'].map((tool) => PREFIX + tool),
  'Bash(adb devices*)', 'Bash(adb shell getprop*)', 'Bash(adb shell pidof*)', 'Bash(adb shell ls /data/local/tmp*)',
];
// TRACE-owned rules from earlier profiles; --apply removes them. The frame-prune rules never took
// effect: auto mode denied the exact command anyway (A7 C4, 2 Nov 2026), so trace-phone now prunes
// its own frames at startup (src/agentic-phone/controller.cjs pruneFrames).
const RETIRED = [
  'Bash(find .runtime/phone/frames -type f -mtime +7 -delete)',
  'Bash(find /opt/trace/.runtime/phone/frames -type f -mtime +7 -delete)',
];
const ACT = PREFIX + 'phone_act';
const HOOK_NAME = 'trace-phone-act.cjs';

const hookCommand = (hookPath) => `node "${hookPath.replace(/\\/g, '/')}"`;

function plan(settings, hookPath) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  const changes = [];
  next.permissions = next.permissions || {};
  next.permissions.allow = next.permissions.allow || [];
  for (const rule of RETIRED) {
    if (next.permissions.allow.includes(rule)) {
      next.permissions.allow = next.permissions.allow.filter((r) => r !== rule);
      changes.push(`permissions.allow -= ${rule}`);
    }
  }
  for (const rule of ALLOW) {
    if (!next.permissions.allow.includes(rule)) { next.permissions.allow.push(rule); changes.push(`permissions.allow += ${rule}`); }
  }
  const command = hookCommand(hookPath);
  next.hooks = next.hooks || {};
  next.hooks.PreToolUse = next.hooks.PreToolUse || [];
  if (!next.hooks.PreToolUse.some((entry) => (entry.hooks || []).some((hook) => hook.command === command))) {
    next.hooks.PreToolUse.push({ matcher: ACT, hooks: [{ type: 'command', command, timeout: 10 }] });
    changes.push(`hooks.PreToolUse += ${ACT} -> ${command}`);
  }
  return { next, changes };
}

function main(argv) {
  const apply = argv.includes('--apply');
  const at = argv.indexOf('--claude-dir');
  const claudeDir = at === -1 ? path.join(os.homedir(), '.claude') : path.resolve(argv[at + 1]);
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hookPath = path.join(claudeDir, 'hooks', HOOK_NAME);
  const current = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  const { next, changes } = plan(current, hookPath);
  const hookSource = fs.readFileSync(path.join(__dirname, 'phone-act-hook.cjs'));
  const hookStale = !fs.existsSync(hookPath) || !fs.readFileSync(hookPath).equals(hookSource);
  if (hookStale) changes.push(`write ${hookPath}`);
  console.log(JSON.stringify({ settings: settingsPath, apply, changes }, null, 2));
  if (!apply || !changes.length) return;
  if (hookStale) { fs.mkdirSync(path.dirname(hookPath), { recursive: true }); fs.writeFileSync(hookPath, hookSource); }
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.trace-backup-${Date.now()}`);
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { plan, hookCommand, ALLOW, ACT, HOOK_NAME };
