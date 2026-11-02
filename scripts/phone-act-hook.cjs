#!/usr/bin/env node
'use strict';

// Claude Code PreToolUse hook for trace-phone's phone_act. It allows the keys that
// docs/PHONE_AUTONOMY_POLICY.md puts in the "allowed" tier and returns "ask" for every other
// phone_act call, so those prompt even in auto mode. It never denies. A settings "ask" rule
// would override this hook's allow (seen 1 Nov 2026), so the profile relies on the hook alone.
const ALLOWED_KEYS = new Set(['home', 'back']);

const output = (permissionDecision, permissionDecisionReason) =>
  ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });

function decide(event) {
  if (!event || event.tool_name !== 'mcp__trace-phone__phone_act') return null;
  const action = event.tool_input && event.tool_input.action;
  const allowed = action && action.type === 'key' && typeof action.key === 'string' && ALLOWED_KEYS.has(action.key)
    && Object.keys(action).every((name) => name === 'type' || name === 'key');
  return allowed
    ? output('allow', `phone autonomy policy: key ${action.key} is in the allowed tier`)
    : output('ask', "phone autonomy policy: this phone_act needs the owner's OK");
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let event = null;
  try { event = JSON.parse(input); } catch { event = null; }
  const out = decide(event);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (require.main === module) main().catch(() => process.exit(0));
module.exports = { decide, ALLOWED_KEYS };
