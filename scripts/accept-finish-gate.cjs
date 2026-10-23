#!/usr/bin/env node
'use strict';
const finish = require('./finish-acceptance-amendment.cjs');
const CASES = { glow: 'R31-GLOW-NATIVE', mouse: 'A32-STOP-MOUSE', keyboard: 'A32-STOP-KEYBOARD', injected: 'A32-STOP-INJECTED', replay: 'A4-REPLAY' };
async function main(args) {
  const audiblePrompt = args.includes('--audible');
  if (args.filter(arg => arg === '--audible').length > 1) throw Error('Select the audible cue once.');
  args = args.filter(arg => arg !== '--audible');
  const [name, mode, directory, continuationText, prior, change, ...extra] = args;
  if (audiblePrompt && !['mouse', 'keyboard'].includes(name)) throw Error('Audible cues are only for physical Escape cases.');
  if (!Object.hasOwn(CASES, name) || !['--plan', '--live'].includes(mode) || extra.length) throw Error('Use accept-finish-gate.cjs glow|mouse|keyboard|injected|replay --plan OR --live new-directory 1|2 [prior-receipt-ref change].');
  if (mode === '--plan') { if (directory) throw Error('Planning accepts no execution arguments.'); return finish.plan(CASES[name]); }
  const continuationAttempt = Number(continuationText);
  if (!directory || ![1, 2].includes(continuationAttempt)) throw Error('Use one approved continuation ordinal.');
  const input = { mode: 'live', directory, continuationAttempt, ...(prior ? { continuationPrior: prior, change } : {}) };
  if (name === 'glow') return require('./accept-replacement-glow.cjs').run({ ...input, amendment: 3, decisionRef: finish.DECISION.ref, referenceExecutor: 'Sky' });
  const finishClaim = await finish.request(input, CASES[name]);
  const options = { mode: 'live', directory, caseId: CASES[name], attempt: continuationAttempt, ownerDecision: finish.DECISION.ref, finishClaim };
  if (name === 'replay') return require('./replay-workflow-runtime.cjs').serve(options);
  return require('./accept-supervisor-stop.cjs').run({ ...options, caseName: name, audiblePrompt });
}
if (require.main === module) main(process.argv.slice(2)).then(value => { console.log(JSON.stringify(value, null, 2)); if (value?.status && !['pass'].includes(value.status)) process.exitCode = 1; }).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { main };
