'use strict';
const { fail } = require('./shared.cjs');
function mapPoint({ point, source, frame, observationId, expectedObservationId, output = 'window-local-physical-pixels' }) {
  if (!observationId || observationId !== expectedObservationId) fail('invalid-geometry', 'Use the current frame identity.');
  if (!point || !source || !frame || ![point.x, point.y].every(Number.isFinite)
    || ![frame.x, frame.y, frame.width, frame.height].every(Number.isSafeInteger) || frame.width < 1 || frame.height < 1) {
    fail('invalid-geometry', 'Use measured physical bounds and finite coordinates.');
  }
  const width = source.kind === 'normalized' ? 1 : source.kind === 'preview-pixels' ? source.width : NaN;
  const height = source.kind === 'normalized' ? 1 : source.kind === 'preview-pixels' ? source.height : NaN;
  if (![width, height].every(n => Number.isFinite(n) && n > 0) || point.x < 0 || point.y < 0
    || point.x > width || point.y > height || (source.kind === 'preview-pixels' && (point.x === width || point.y === height))
    || !['window-local-physical-pixels', 'physical-screen-pixels'].includes(output)) fail('invalid-geometry', 'Declare supported source/output coordinates inside the frame.');
  const x = Math.min(frame.width - 1, Math.floor(point.x / width * frame.width));
  const y = Math.min(frame.height - 1, Math.floor(point.y / height * frame.height));
  return { x: x + (output === 'physical-screen-pixels' ? frame.x : 0),
    y: y + (output === 'physical-screen-pixels' ? frame.y : 0), coordinateSpace: output, observationId };
}
module.exports = { mapPoint };
