'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createTraceProvider, TOOL_NAMES } = require('../src/method/index.cjs');
const { readPostActionEvidence, postActionStatus } = require('../src/method/post-action-evidence.cjs');

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const sha256 = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
const window = { id: 'w', pid: 7, processName: 'fixture', processCreationTime: '100', sessionId: 2, ownerWindowId: 'parent' };
const capturedAt = '2026-10-29T12:00:00.000Z';
const image = { type: 'image', mimeType: 'image/png', data };
function observation(id, index = 1) {
  return { sessionId: 's', window: { ...window }, observationId: id, observedAt: capturedAt,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, targetState: { ownerWindowId: 'parent' },
    screenshot: { contentIndex: index, mimeType: 'image/png', width: 1, height: 1, sha256 } };
}
function blocks(index = 1) {
  const result = [{ type: 'text', text: '{}' }];
  if (index === 2) result.push({ type: 'text', text: 'extra' });
  result.push({ ...image }); return result;
}
async function fixture(mutate = () => {}, index = 1) {
  let now = 100, count = 0, acts = 0;
  const tools = TOOL_NAMES.map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));
  const callTool = async ({ name }) => {
    switch (TOOL_NAMES.indexOf(name)) {
      case 0: return { structuredContent: { ready: true } };
      case 1: return { structuredContent: { windows: [window] } };
      case 2: return { structuredContent: { sessionId: 's', window } };
      case 3: return { structuredContent: observation(`before-${++count}`), content: blocks() };
      case 4: {
        acts++; now += 25;
        const value = { actionId: 'action-1', outcome: 'completed', verification: 'fresh_observation', observation: observation('after-1', index) };
        const content = blocks(index); const result = { structuredContent: value, content };
        mutate(value, content, result); return result;
      }
      default: return { structuredContent: { closed: true, cleanup: 'confirmed' } };
    }
  };
  const p = createTraceProvider({ tools, callTool, app: 'fixture', windowId: 'w', monotonicClock: () => now });
  await p.doctor(); const [target] = await p.discover({ environment: 'local', app: 'fixture' });
  const before = await p.observe({ target });
  const act = () => p.act({ target, observationId: before.id, capability: 'native-action', payload: { type: 'activate' } });
  return { p, target, before, act, advance(ms) { now += ms; }, get acts() { return acts; } };
}

test('post-action evidence retains original image and time privately without granting input authority', async () => {
  for (const index of [1, 2]) {
    const f = await fixture(() => {}, index), receipt = await f.act();
    assert.equal(receipt.delivery, 'delivered');
    assert.equal(receipt.resultingObservation.authority, 'verification-only');
    assert.equal(receipt.resultingObservation.sourceCapturedAt, capturedAt);
    assert.equal(receipt.resultingObservation.evidence.state.screenshot.sourceContentIndex, index);
    assert.deepEqual(receipt.resultingObservation.evidence.images, [image]);
    assert.deepEqual(receipt.resultingState, receipt.resultingObservation.evidence.state);
    const token = receipt.postActionEvidence, privateValue = readPostActionEvidence(token);
    assert.equal(privateValue.actionId, 'action-1');
    assert.equal(privateValue.beforeObservationId, f.before.id);
    assert.equal(privateValue.sourceCapturedAt, capturedAt);
    assert.equal(postActionStatus(token).ageMs, 25);
    assert.equal(postActionStatus(token).current, true);
    privateValue.observation.evidence.state.screenshot.sha256 = 'changed';
    assert.equal(readPostActionEvidence(token).observation.evidence.state.screenshot.sha256, sha256);
    assert.equal(readPostActionEvidence(structuredClone(token)), null);
    assert.equal(readPostActionEvidence(JSON.parse(JSON.stringify(token))), null);
    await assert.rejects(f.p.act({ target: f.target, observationId: receipt.resultingObservation.id,
      capability: 'native-action', payload: { type: 'activate' } }), { code: 'stale-target' });
    assert.equal(f.acts, 1);
    f.advance(10); assert.equal(postActionStatus(token).ageMs, 35);
    await f.p.observe({ target: f.target }); assert.equal(postActionStatus(token).current, false);
    await f.p.close({ target: f.target });
  }
});

test('invalid or ineligible nested evidence never changes delivery or yields a token', async () => {
  const cases = [
    (v, c) => c.pop(),
    v => { v.observation.screenshot.contentIndex = 0; },
    v => { v.observation.screenshot.sha256 = '0'.repeat(64); },
    v => { v.observation.sessionId = 'other'; },
    v => { v.observation.observationId = 'before-1'; },
    v => { v.observation.observedAt = 'invalid'; },
    v => { v.actionId = ''; },
    v => { v.verification = 'none'; },
    v => { v.error = { code: 'failure' }; },
    v => { v.outcome = 'unknown'; },
    (v, c, r) => { r.isError = true; },
  ];
  for (const mutate of cases) {
    const f = await fixture(mutate), receipt = await f.act();
    assert.equal(receipt.delivery, [cases[9], cases[10]].includes(mutate) ? 'unknown' : 'delivered');
    assert.equal(receipt.postActionEvidence ?? null, null);
    if (mutate !== cases[5]) assert.equal(receipt.resultingObservation ?? null, null);
    if (mutate !== cases[5]) assert.equal(receipt.resultingState ?? null, null);
    assert.equal(f.acts, 1);
    await f.p.close({ target: f.target });
  }
});

test('closing a session makes retained evidence noncurrent', async () => {
  const f = await fixture(), receipt = await f.act(), token = receipt.postActionEvidence;
  await f.p.close({ target: f.target });
  assert.equal(postActionStatus(token).current, false);
});


test('pending action binds the validated target and discards evidence after close', async () => {
  let f = await fixture(() => { f.target.identity.generation = 'changed'; });
  let receipt = await f.act();
  assert.equal(receipt.resultingObservation.target.identity.generation, '100');
  assert.equal(readPostActionEvidence(receipt.postActionEvidence).observation.target.identity.generation, '100');
  assert.equal(receipt.resultingState.window.processCreationTime, '100');
  f.target.identity.generation = '100';
  await f.p.close({ target: f.target });

  let closing;
  f = await fixture(() => { closing = f.p.close({ target: f.target }); });
  receipt = await f.act(); await closing;
  assert.equal(receipt.delivery, 'delivered');
  assert.equal(receipt.postActionEvidence, null);
  assert.equal(receipt.resultingObservation, null);
  assert.equal(receipt.resultingState, null);
});
