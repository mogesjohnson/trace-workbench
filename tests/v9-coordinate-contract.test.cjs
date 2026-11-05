'use strict';
// R22: an observation names every pixel space it returns, and scaled images map back to action points.
const test = require('node:test'), assert = require('node:assert/strict');
const { coordinateContract, actionSupport, compactSupport, effectiveSupport } = require('../src/computer/action-contract.cjs');

const bounds = { x: 300, y: 200, width: 800, height: 600 };

test('a full image maps one to one and reports window DPI', () => {
  const contract = coordinateContract(bounds, 144, { width: 800, height: 600 }, 'per-monitor');
  assert.deepEqual(contract, { actionPoints: 'window-local-physical-pixels', elementBounds: 'physical-screen-pixels',
    windowOrigin: { x: 300, y: 200 }, image: { origin: 'window-top-left', physicalPerImagePixel: 1 },
    logical: { available: true, dpi: 144, physicalPerLogicalPixel: 1.5 } });
});

test('a scaled image carries its factor', () => {
  const contract = coordinateContract(bounds, 96, { width: 400, height: 300, scale: { factor: 2 } }, 'per-monitor');
  assert.equal(contract.image.physicalPerImagePixel, 2);
  assert.equal(contract.logical.physicalPerLogicalPixel, 1);
});

test('unknown DPI stays unavailable and no image means no image mapping', () => {
  for (const dpi of [undefined, 0, 1.5]) assert.deepEqual(coordinateContract(bounds, dpi, undefined, 'per-monitor').logical, { available: false, dpiAwareness: 'per-monitor' });
  assert.equal(Object.hasOwn(coordinateContract(bounds, 96, undefined, 'per-monitor'), 'image'), false);
});

test('a virtualized or unreported DPI awareness never yields a logical scale', () => {
  // GetDpiForWindow returns 96 for an unaware window even on a 144 DPI display.
  assert.deepEqual(coordinateContract(bounds, 96, undefined, 'unaware').logical, { available: false, dpiAwareness: 'unaware' });
  assert.deepEqual(coordinateContract(bounds, 144, undefined, 'system').logical, { available: false, dpiAwareness: 'system' });
  assert.deepEqual(coordinateContract(bounds, 144).logical, { available: false });
});

test('the support descriptor and its digest stay unchanged, so 2.x declarations remain compatible', () => {
  assert.equal(Object.hasOwn(actionSupport(), 'coordinates'), false);
  assert.ok(effectiveSupport(compactSupport()));
});
