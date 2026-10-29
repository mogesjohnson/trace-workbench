'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateObservationImages } = require('../src/method/observation-images.cjs');
const { createTraceProvider, TOOL_NAMES } = require('../src/method/index.cjs');

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const sha256 = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
const window = { id: 'w', pid: 7, processName: 'fixture', processCreationTime: '100', sessionId: 2, ownerWindowId: 'parent' };
const image = { type: 'image', mimeType: 'image/png', data };
const context = { sessionId: 's', window, ownerWindowId: 'parent' };
function sample() {
  return { sessionId: 's', window: { ...window }, observationId: 'capture-1', bounds: { x: 0, y: 0, width: 1, height: 1 },
    targetState: { ownerWindowId: 'parent' }, screenshot: { contentIndex: 2, mimeType: 'image/png', width: 1, height: 1, sha256 } };
}
function content() { return [{ type: 'text', text: '{}' }, { type: 'text', text: 'extra' }, { ...image }]; }

test('validated image references the full content array and is remapped without mutating source', () => {
  const value = sample(), blocks = content(), original = structuredClone(value);
  const result = validateObservationImages(value, blocks, context);
  assert.equal(result.contentIndexSpace, 'images');
  assert.deepEqual(result.images, [image]);
  assert.equal(result.state.screenshot.contentIndex, 0);
  assert.equal(result.state.screenshot.sourceContentIndex, 2);
  assert.equal(result.state.screenshot.sha256, sha256);
  assert.deepEqual(value, original);
  assert.notEqual(result.state, value);
});

test('malformed or inconsistent image evidence fails closed', () => {
  const mutations = [
    (v, c) => c.pop(),
    (v) => { v.screenshot.contentIndex = 0; },
    (v, c) => c.push({ ...image }),
    (v, c) => { c[2].mimeType = 'image/jpeg'; },
    (v) => { v.screenshot.sha256 = '0'.repeat(64); },
    (v, c) => { c[2].data += '!'; },
    (v, c) => { const b = Buffer.from(data, 'base64'); b.writeUInt32BE(12, 8); c[2].data = b.toString('base64'); v.screenshot.sha256 = createHash('sha256').update(b).digest('hex'); },
    (v, c) => { const b = Buffer.from(data, 'base64'); b.write('NOPE', 12); c[2].data = b.toString('base64'); v.screenshot.sha256 = createHash('sha256').update(b).digest('hex'); },
    (v) => { v.screenshot.width = 2; },
    (v) => { v.bounds.height = 2; },
  ];
  for (const mutate of mutations) {
    const value = sample(), blocks = content(); mutate(value, blocks);
    assert.throws(() => validateObservationImages(value, blocks, context), { code: 'invalid-image-evidence' });
  }
});

test('session, lifetime, OS session and ownership are bound to discovery', () => {
  for (const mutate of [v => { v.sessionId = 'other'; }, v => { v.window.processCreationTime = '101'; },
    v => { v.window.sessionId = 3; }, v => { v.window.pid = 0; }, v => { v.window.processCreationTime = '100\n'; }]) {
    const value = sample(); mutate(value);
    assert.throws(() => validateObservationImages(value, content(), context), { code: 'target-mismatch' });
  }
  const value = sample(); value.targetState.ownerWindowId = 'other';
  assert.throws(() => validateObservationImages(value, content(), context), { code: 'ownership-changed' });
});

function providerFixture() {
  let value = sample(), acts = 0;
  const tools = TOOL_NAMES.map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));
  const callTool = async ({ name }) => {
    const index = TOOL_NAMES.indexOf(name);
    if (index === 0) return { structuredContent: { ready: true } };
    if (index === 1) return { structuredContent: { windows: [window] } };
    if (index === 2) return { structuredContent: { sessionId: 's', window } };
    if (index === 3) return { structuredContent: structuredClone(value), content: content() };
    if (index === 4) { acts++; return { structuredContent: { outcome: 'completed' } }; }
    return { structuredContent: { closed: true, cleanup: 'confirmed' } };
  };
  return { p: createTraceProvider({ tools, callTool, app: 'fixture', windowId: 'w' }),
    setValue(v) { value = v; }, get acts() { return acts; } };
}

test('adapter accepts fresh IDs for identical image bytes and rejects replay before dispatch', async () => {
  const f = providerFixture(); await f.p.doctor();
  const [target] = await f.p.discover({ environment: 'local', app: 'fixture' });
  const first = await f.p.observe({ target });
  assert.deepEqual(first.evidence.images, [image]);
  assert.equal(first.evidence.state.screenshot.contentIndex, 0);
  assert.equal(first.evidence.state.screenshot.sourceContentIndex, 2);
  const next = sample(); next.observationId = 'capture-2'; f.setValue(next);
  const second = await f.p.observe({ target }); assert.equal(second.id, 'capture-2');
  await assert.rejects(f.p.observe({ target }), { code: 'duplicate-observation' });
  await assert.rejects(f.p.act({ target, observationId: second.id, capability: 'native-action', payload: { type: 'activate' } }), { code: 'stale-target' });
  assert.equal(f.acts, 0);
});

test('adapter rejects a changed caller identity or owner', async () => {
  for (const modify of [t => { t.identity.generation = 'other'; }, t => { t.ownerWindowId = 'other'; }]) {
    const f = providerFixture(); await f.p.doctor();
    const [target] = await f.p.discover({ environment: 'local', app: 'fixture' });
    const wrong = structuredClone(target); modify(wrong);
    await assert.rejects(f.p.observe({ target: wrong }), { code: 'target-mismatch' });
    assert.equal(f.acts, 0);
  }
});
