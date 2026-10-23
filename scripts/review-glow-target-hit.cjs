'use strict';
// Offline evidence review only. No live driver, native process or attempt ledger is invoked.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { assertTargetHit } = require('./accept-replacement-glow.cjs');
const ROOT = path.resolve(__dirname, '..');
const PINS = Object.freeze({
  decision: { ref: 'evidence/live-acceptance-continuation/owner-glow-target-hit-decision.json', sha256: '6c40fa480a51d798d0af218ec7859c7aab46cfdd28c17b0c296cac7fa0801b30' },
  receipt: { ref: 'evidence/live-acceptance-continuation/glow-finish-2/receipt.json', sha256: '5a87c5a2eac19d45256ea8cc62245566dd2e7ab489fe3ac526cff7689672c3c5' },
  diagnosis: { ref: 'evidence/live-acceptance-continuation/glow-finish-2/diagnosis.json', sha256: 'aad70d8a81925cd1ac0931bdca64bbb7ab45b7265601090b8ee82fda089be3e9' }
});
async function readPinned(pin) {
  const bytes = await fs.readFile(path.join(ROOT, pin.ref));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, `Retained evidence changed: ${pin.ref}`);
  return JSON.parse(bytes.toString('utf8'));
}
async function review() {
  const [decision, receipt, diagnosis] = await Promise.all(Object.values(PINS).map(readPinned));
  assert.equal(decision.selectedOption, 1); assert.equal(decision.preserveOriginalFailedResult, true);
  assert.equal(receipt.status, 'fail'); assert.deepEqual(diagnosis.receipt, PINS.receipt);
  assert.equal(diagnosis.trace.exactCenterAssertionPassed, false);
  const trace = diagnosis.trace;
  const targetHit = assertTargetHit({ ...trace.counters, button: trace.button, input: trace.lastMouseClick.input,
    lastMouseClick: trace.lastMouseClick }, 2, trace.requestedPhysicalPoint, receipt.phases.reference.completedAt);
  const missing = ['ordinaryClose', 'parentLoss'].filter(phase => !receipt.phases[phase]);
  return { schemaVersion: 1, reviewedAt: new Date().toISOString(),
    scope: 'Offline validation of pinned retained evidence under the owner-selected criterion; no new live evidence or attempt.',
    inputs: PINS, targetHit: { status: 'pass', ...targetHit, counters: trace.counters },
    timeBoundary: { source: 'retained-reference-completion', at: receipt.phases.reference.completedAt,
      scope: 'The retained event follows reference completion. The precise TRACE dispatch-start checkpoint was not retained in this receipt.' },
    originalStatus: receipt.status, originalReceiptUnchanged: true,
    lifecycle: { status: missing.length ? 'not_run' : 'requires_separate_review', missing },
    fullGlowCase: 'incomplete', newLiveAttemptAuthorized: false };
}
if (require.main === module) review().then(value => console.log(JSON.stringify(value, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { PINS, review };
