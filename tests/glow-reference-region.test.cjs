'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_CHECKPOINT_MS, contains, validateCheckpoint, assertReferenceRegion } = require('../scripts/glow-reference-region.cjs');

const at = milliseconds => new Date(Date.parse('2026-10-22T12:00:00Z') + milliseconds).toISOString();
function evidence() {
  const target = { windowId: '9768766', pid: 200, processCreationTime: '123456789', windowsSessionId: 1 };
  const display = { monitors: 1, primary: true, device: 'synthetic-display', dpiX: 144, dpiY: 144,
    bounds: { x: 0, y: 0, width: 2880, height: 1800 }, captureWidth: 2880, captureHeight: 1800 };
  const button = { x: 1, y: 856, width: 12, height: 88 };
  const sample = sampledAt => ({ target: structuredClone(target), display: structuredClone(display), sampledAt });
  const input = sampledAt => ({ ...sample(sampledAt), source: 'independent-keystate-all', observable: true, keysDown: [] });
  const fixture = (sampledAt, count) => ({ ...sample(sampledAt), ready: true, alive: true, publicationHealthy: true,
    countOracle: 'left-button-mouseclick-events', button: { ...button }, count, activationCount: count,
    mouseDownCount: count, mouseUpCount: count, mouseClickCount: count });
  const checkpoint = { executor: 'Sky', checkpointId: 'PRIVATE_CHECKPOINT', startedAt: at(1000), target, display, button,
    observation: { ...sample(at(900)), executor: 'Sky', unique: true, elementId: 'traceGlowEdgeButton', elementIndex: 1 },
    initialFixture: fixture(at(900), 0), initialInput: input(at(900)),
    glow: { ...sample(at(900)), source: 'safe-pixel-measurement', coordinateSpace: 'physical-screen', verified: true,
      bounds: { x: 0, y: 0, width: 10, height: 1800 }, leftTintedSamples: 11, topTintedSamples: 11, interiorBackgroundVerified: true } };
  const proof = { source: 'external-sky-accessibility', executor: 'Sky', tool: 'sky.click', operation: 'click',
    mechanism: 'accessibility-mouse', completed: true, synthetic: false, noInvoke: true, checkpointId: 'PRIVATE_CHECKPOINT',
    target: structuredClone(target), display: structuredClone(display), elementId: 'traceGlowEdgeButton', elementIndex: 1,
    toolReceiptRef: 'actual-tool-call:synthetic-fixture', startedAt: at(1100), completedAt: at(1500) };
  const finalFixture = fixture(at(1600), 1);
  for (const [key, milliseconds] of [['lastMouseDown', 1200], ['lastMouseUp', 1400], ['lastMouseClick', 1350]]) {
    finalFixture[key] = { button: 'Left', clicks: 1, screenX: 5, screenY: 900, atUtc: at(milliseconds), coordinateSpace: 'physical-screen' };
  }
  finalFixture.lastActivation = { atUtc: at(1300) };
  return { checkpoint, proof, finalFixture, finalInput: input(at(1700)), checkedAt: at(1800) };
}
const rejected = value => assert.throws(() => assertReferenceRegion(value), { code: 'glow_reference_region_invalid' });

test('approved settlement keeps actual resolution and enforces the 1000 ms bound without changing the historical oracle', () => {
  const make = elapsed => { const value = evidence(); value.proof.toolStartedAt = value.proof.startedAt; value.proof.toolResolvedAt = value.proof.completedAt;
    value.finalFixture.lastMouseUp.atUtc = at(1507); value.finalFixture.sampledAt = at(1500 + elapsed);
    value.finalInput.sampledAt = at(1501 + elapsed); value.checkedAt = at(1502 + elapsed); return value; };
  rejected(make(100));
  for (const elapsed of [100, 999, 1000]) {
    const value = make(elapsed), result = assertReferenceRegion({ ...value, settlementMaximumMs: 1000 });
    assert.equal(result.toolResolvedAt, at(1500)); assert.equal(result.settlementObservedAt, at(1500 + elapsed));
    assert.equal(result.timingContract, 'owner-approved-settlement-v2');
  }
  for (const change of [v => { v.finalFixture.sampledAt = at(2501); v.finalInput.sampledAt = at(2502); v.checkedAt = at(2503); },
    v => { v.proof.toolResolvedAt = at(1507); }, v => { v.finalFixture.mouseClickCount = 2; },
    v => { v.finalFixture.lastMouseUp.atUtc = at(1700); }]) {
    const value = make(100); change(value);
    assert.throws(() => assertReferenceRegion({ ...value, settlementMaximumMs: 1000 }), { code: 'glow_reference_region_invalid' });
  }
});

test('prospective point x=5 can pass only with complete new physical evidence, without a center rule or private output', () => {
  const value = evidence(); assert.equal(validateCheckpoint(value.checkpoint, value.checkedAt), true);
  assert.equal(MAX_CHECKPOINT_MS, 60000);
  const before = structuredClone(value), result = assertReferenceRegion(value);
  assert.equal(result.accepted, true); assert.deepEqual(result.point, { x: 5, y: 900 });
  assert.equal(JSON.stringify(result).includes('PRIVATE_CHECKPOINT'), false);
  assert.equal(JSON.stringify(result).includes('actual-tool-call:'), false);
  assert.match(result.scope, /Supplied-evidence validation only/); assert.match(result.scope, /retained owned child/);
  assert.deepEqual(value, before);
});

test('historical missing MouseUp and terminal ready=false cannot be promoted by the new point rule', () => {
  // Historical diagnosis: x=5/y=900, counts 1/1/1/0/1. New evidence above is synthetic prospective data.
  const missingUp = evidence(); missingUp.finalFixture.mouseUpCount = 0; missingUp.finalFixture.lastMouseUp = null; rejected(missingUp);
  const terminal = evidence(); terminal.finalFixture.ready = false; rejected(terminal);
  const historicalOnly = { proof: { tool: 'sky.click', completed: true }, finalFixture: { count: 1, mouseClickCount: 1, screenX: 5, screenY: 900 } };
  rejected(historicalOnly);
});

test('physical rectangles are half-open; actual click must be inside both independently measured regions', () => {
  const rect = { x: -10, y: -5, width: 10, height: 5 };
  assert.equal(contains(rect, { x: -10, y: -5 }), true);
  for (const point of [{ x: 0, y: -5 }, { x: -10, y: 0 }, { x: -11, y: -5 }, { x: -10, y: -6 }, { x: -9.5, y: -3 }]) assert.equal(contains(rect, point), false);
  for (const [x, y, allowed] of [[1, 856, true], [9, 943, true], [0, 900, false], [10, 900, false], [12, 900, false], [13, 900, false], [5, 855, false], [5, 944, false], [5.5, 900, false]]) {
    const value = evidence(); value.finalFixture.lastMouseClick.screenX = x; value.finalFixture.lastMouseClick.screenY = y;
    if (allowed) assert.equal(assertReferenceRegion(value).accepted, true); else rejected(value);
  }
});

test('generation, session, display, geometry, grounding and freshness must stay bound across every supplied sample', () => {
  const changes = [
    v => { v.proof.target.pid++; }, v => { v.proof.target.windowId = '99'; },
    v => { v.finalFixture.target.processCreationTime = '999'; }, v => { v.finalInput.target.windowsSessionId++; },
    v => { v.checkpoint.observation.target.pid++; }, v => { v.checkpoint.glow.target.pid++; },
    v => { v.proof.checkpointId = 'PRIVATE_OTHER'; }, v => { v.proof.elementIndex++; },
    v => { v.checkpoint.observation.unique = false; }, v => { v.checkpoint.observation.elementId = 'other'; },
    v => { v.finalFixture.button.width++; }, v => { v.finalFixture.display.dpiX++; },
    v => { v.finalInput.display.bounds.width++; }, v => { v.checkpoint.display.captureWidth = 1920; },
    v => { v.checkpoint.glow.bounds.width = 1; }, v => { v.checkpoint.glow.bounds.x++; },
    v => { v.checkpoint.glow.verified = false; }, v => { v.checkpoint.glow.leftTintedSamples = 10; },
    v => { v.checkpoint.glow.interiorBackgroundVerified = false; }, v => { v.checkpoint.glow.coordinateSpace = 'scaled-screenshot'; },
    v => { v.checkedAt = at(61001); }, v => { v.checkedAt = at(999); },
    v => { v.checkpoint.observation.sampledAt = at(-60000); }, v => { v.checkpoint.glow.sampledAt = at(1100); },
    v => { v.proof.startedAt = at(999); }, v => { v.proof.completedAt = at(1900); },
    v => { v.finalFixture.sampledAt = at(1400); }, v => { v.finalInput.sampledAt = at(1550); },
  ];
  for (const change of changes) { const value = evidence(); change(value); rejected(value); }
});

test('counts alone, incomplete physical sequence, uncertain liveness/publication/input and substituted proof mechanisms reject', () => {
  const changes = [
    v => { v.proof.source = 'TRACE'; }, v => { v.proof.executor = 'TRACE'; }, v => { v.proof.tool = 'uia.invoke'; },
    v => { v.proof.operation = 'invoke'; }, v => { v.proof.mechanism = 'programmatic-counter'; },
    v => { v.proof.synthetic = true; }, v => { v.proof.noInvoke = false; }, v => { v.proof.completed = false; },
    v => { v.proof.toolReceiptRef = 'C:/PRIVATE/receipt.json'; }, v => { v.proof.toolReceiptRef = ''; },
    v => { v.finalFixture.alive = false; }, v => { delete v.finalFixture.alive; }, v => { v.checkpoint.initialFixture.ready = false; },
    v => { v.finalFixture.publicationHealthy = false; }, v => { v.checkpoint.initialFixture.count = 1; },
    v => { v.finalFixture.activationCount = 2; }, v => { v.finalFixture.mouseDownCount = 0; },
    v => { v.finalFixture.mouseClickCount = 0; }, v => { v.finalFixture.countOracle = 'activation-events'; },
    v => { v.finalInput.observable = false; }, v => { v.finalInput.keysDown = [1]; },
    v => { v.finalInput.source = 'fixture-count'; }, v => { v.checkpoint.initialInput.keysDown = [16]; },
    v => { delete v.finalFixture.lastMouseClick; }, v => { v.finalFixture.lastMouseUp.button = 'Right'; },
    v => { v.finalFixture.lastMouseDown.clicks = 2; }, v => { v.finalFixture.lastMouseClick.coordinateSpace = 'scaled-screenshot'; },
    v => { v.finalFixture.lastMouseUp.atUtc = at(900); }, v => { v.finalFixture.lastMouseDown.atUtc = at(1450); },
    v => { delete v.finalFixture.lastActivation; },
  ];
  for (const change of changes) { const value = evidence(); change(value); rejected(value); }
  rejected(undefined);
});

test('freshness includes the 60-second endpoint but never accepts a later checkpoint result', () => {
  const value = evidence(); value.checkedAt = at(61000);
  assert.equal(assertReferenceRegion(value).accepted, true);
  value.checkedAt = at(61001); rejected(value);
  const staleObservation = evidence();
  staleObservation.checkedAt = at(61000); staleObservation.proof.startedAt = at(60901); staleObservation.proof.completedAt = at(60905);
  staleObservation.finalFixture.lastMouseDown.atUtc = at(60902); staleObservation.finalFixture.lastMouseClick.atUtc = at(60903);
  staleObservation.finalFixture.lastActivation.atUtc = at(60903); staleObservation.finalFixture.lastMouseUp.atUtc = at(60904);
  staleObservation.finalFixture.sampledAt = at(60906); staleObservation.finalInput.sampledAt = at(60907);
  rejected(staleObservation); // Observation age at actual tool start is 60,001 ms, despite an unexpired checkpoint.
});
