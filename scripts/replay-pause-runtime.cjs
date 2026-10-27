'use strict';
// Explicit live entry point; imports and --plan do not touch the desktop.
const fs = require('node:fs/promises');
const path = require('node:path');
const pause = require('./accept-replay-pause.cjs');
const { createRuntime } = require('./replay-pause-adapter.cjs');
const { atomic } = require('./replay-pause-support.cjs');
const ROOT = path.resolve(__dirname, '..');
const plan = () => ({ ...pause.plan(), execution: 'production-cli', liveAcceptance: 'not_run',
  requiredBeforeLive: ['Exact bounded owner decision', 'Fresh idle desktop', 'Root inspection of the pending PNG'] });
async function run({ directory, decision }) {
  const base = await fs.realpath(path.join(ROOT, '.runtime'));
  const destination = path.resolve(directory);
  const parent = await fs.realpath(path.dirname(destination));
  const relative = path.relative(base, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Directory must be inside private runtime');
  const target = path.join(parent, path.basename(destination));
  await fs.mkdir(target);
  const runtime = createRuntime({ directory: target, decision });
  const stop = () => runtime.cancel();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const watchdog = setTimeout(stop, 300000);
  let result;
  try { result = await pause.runInjected(runtime); }
  catch (error) { result = { status: 'fail', error: error.message }; }
  finally {
    clearTimeout(watchdog);
    try {
      const state = await runtime.finish();
      if (result?.cleanup && Object.values(result.cleanup).some(value => value !== true)) state.cleanupUnconfirmed = true;
      state.status = result?.status === 'pass' && !state.cleanupUnconfirmed ? 'pass' : 'fail';
      state.completedAt = new Date().toISOString(); state.workflow = result;
      await atomic(path.join(target, 'receipt.json'), state);
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  return runtime.state;
}
module.exports = { plan, run, createRuntime };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.join(' ') === '--plan') process.stdout.write(JSON.stringify(plan(), null, 2) + '\n');
  else if (args[0] === '--live' && args.length === 4)
    run({ directory: args[1], decision: { ref: args[2], sha256: args[3] } })
      .then(value => { process.stdout.write(JSON.stringify({ status: value.status, directory: args[1] }) + '\n'); if (value.status !== 'pass') process.exitCode = 1; })
      .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  else { process.stderr.write('Use --plan or --live PRIVATE_DIRECTORY DECISION_REF DECISION_SHA256.\n'); process.exitCode = 1; }
}
