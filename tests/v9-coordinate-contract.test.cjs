'use strict';
// R22: an observation names every pixel space it returns, and scaled images map back to action points.
const test = require('node:test'), assert = require('node:assert/strict');
const { coordinateContract, actionSupport, compactSupport, effectiveSupport } = require('../src/computer/action-contract.cjs');

const bounds = { x: 300, y: 200, width: 800, height: 600 };

test('a full image maps one to one and reports window DPI', () => {
  const contract = coordinateContract(bounds, 144, { width: 800, height: 600 });
  assert.deepEqual(contract, { actionPoints: 'window-local-physical-pixels', elementBounds: 'physical-screen-pixels',
    windowOrigin: { x: 300, y: 200 }, image: { origin: 'window-top-left', physicalPerImagePixel: 1 },
    logical: { available: true, dpi: 144, physicalPerLogicalPixel: 1.5 } });
});

test('a scaled image carries its factor', () => {
  const contract = coordinateContract(bounds, 96, { width: 400, height: 300, scale: { factor: 2 } });
  assert.equal(contract.image.physicalPerImagePixel, 2);
  assert.equal(contract.logical.physicalPerLogicalPixel, 1);
});

test('unknown DPI stays unavailable and no image means no image mapping', () => {
  for (const dpi of [undefined, 0, 1.5]) assert.deepEqual(coordinateContract(bounds, dpi).logical, { available: false });
  assert.equal(Object.hasOwn(coordinateContract(bounds, 96), 'image'), false);
});

test('the support descriptor and its digest stay unchanged, so 2.x declarations remain compatible', () => {
  assert.equal(Object.hasOwn(actionSupport(), 'coordinates'), false);
  assert.ok(effectiveSupport(compactSupport()));
});
