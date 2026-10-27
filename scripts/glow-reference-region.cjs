'use strict';

// Pure prospective acceptance contract. It performs no observation, tool invocation,
// liveness query, filesystem access or input. The caller must inspect the actual
// referenced Sky receipt and retained owned ChildProcess before relying on its result.
const MAX_CHECKPOINT_MS = 60000;
const COUNTERS = ['count', 'activationCount', 'mouseDownCount', 'mouseUpCount', 'mouseClickCount'];
const fail = () => { throw Object.assign(new Error('Supplied reference evidence does not satisfy the prospective physical-region contract.'), { code: 'glow_reference_region_invalid' }); };
const need = value => { if (!value) fail(); };
const integer = value => Number.isSafeInteger(value);
function time(value) {
  need(typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value));
  const result = Date.parse(value); need(Number.isFinite(result)); return result;
}
function rectangle(value) {
  need(value && ['x', 'y', 'width', 'height'].every(key => integer(value[key])) && value.width > 0 && value.height > 0);
  need(integer(value.x + value.width) && integer(value.y + value.height)); return value;
}
// Rectangles are half-open in independently measured physical screen pixels.
function contains(bounds, point) {
  rectangle(bounds);
  return !!point && integer(point.x) && integer(point.y) && point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}
const equalRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => a?.[key] === b?.[key]);
function identity(value) {
  need(value && typeof value.windowId === 'string' && /^[1-9]\d*$/.test(value.windowId)
    && integer(value.pid) && value.pid > 0 && typeof value.processCreationTime === 'string' && /^\d{1,32}$/.test(value.processCreationTime)
    && integer(value.windowsSessionId) && value.windowsSessionId >= 0);
  return value;
}
function sameIdentity(a, b) {
  identity(a); identity(b);
  need(['windowId', 'pid', 'processCreationTime', 'windowsSessionId'].every(key => a[key] === b[key]));
}
function display(value) {
  need(value && value.monitors === 1 && value.primary === true && typeof value.device === 'string' && value.device.length > 0);
  rectangle(value.bounds);
  need(integer(value.dpiX) && value.dpiX > 0 && integer(value.dpiY) && value.dpiY > 0
    && value.captureWidth === value.bounds.width && value.captureHeight === value.bounds.height);
  return value;
}
function sameDisplay(a, b) {
  display(a); display(b);
  need(['monitors', 'primary', 'device', 'dpiX', 'dpiY', 'captureWidth', 'captureHeight'].every(key => a[key] === b[key]) && equalRect(a.bounds, b.bounds));
}
function boundSample(sample, checkpoint, now, after = false) {
  need(sample); sameIdentity(sample.target, checkpoint.target); sameDisplay(sample.display, checkpoint.display);
  const at = time(sample.sampledAt), start = time(checkpoint.startedAt);
  need(after ? at >= start && at <= now : at <= start && start - at <= MAX_CHECKPOINT_MS);
  return at;
}
function allUp(proof, checkpoint, now, after = false) {
  boundSample(proof, checkpoint, now, after);
  need(proof.source === 'independent-keystate-all' && proof.observable === true && Array.isArray(proof.keysDown) && proof.keysDown.length === 0);
}
function fixture(state, checkpoint, now, count, after = false) {
  const at = boundSample(state, checkpoint, now, after);
  need(state.ready === true && state.alive === true && state.publicationHealthy === true
    && state.countOracle === 'left-button-mouseclick-events' && COUNTERS.every(key => state[key] === count));
  rectangle(state.button); need(equalRect(state.button, checkpoint.button));
  return at;
}

function validateCheckpoint(checkpoint, checkedAt) {
  need(checkpoint && checkpoint.executor === 'Sky' && typeof checkpoint.checkpointId === 'string'
    && checkpoint.checkpointId.length > 0 && checkpoint.checkpointId.length <= 256);
  identity(checkpoint.target); display(checkpoint.display); rectangle(checkpoint.button);
  const now = time(checkedAt), start = time(checkpoint.startedAt);
  need(now >= start && now - start <= MAX_CHECKPOINT_MS);
  const observation = checkpoint.observation;
  boundSample(observation, checkpoint, now);
  need(observation.executor === 'Sky' && observation.unique === true && observation.elementId === 'traceGlowEdgeButton'
    && integer(observation.elementIndex) && observation.elementIndex >= 0);
  fixture(checkpoint.initialFixture, checkpoint, now, 0);
  allUp(checkpoint.initialInput, checkpoint, now);
  const glow = checkpoint.glow;
  boundSample(glow, checkpoint, now); rectangle(glow.bounds);
  need(glow.source === 'safe-pixel-measurement' && glow.coordinateSpace === 'physical-screen' && glow.verified === true
    && glow.leftTintedSamples === 11 && glow.topTintedSamples === 11 && glow.interiorBackgroundVerified === true);
  const bounds = checkpoint.display.bounds;
  need(glow.bounds.x === bounds.x && glow.bounds.y >= bounds.y && glow.bounds.width < bounds.width
    && glow.bounds.y + glow.bounds.height <= bounds.y + bounds.height);
  need(contains(bounds, { x: checkpoint.button.x, y: checkpoint.button.y })
    && checkpoint.button.x + checkpoint.button.width <= bounds.x + bounds.width
    && checkpoint.button.y + checkpoint.button.height <= bounds.y + bounds.height);
  need(Math.max(glow.bounds.x, checkpoint.button.x) < Math.min(glow.bounds.x + glow.bounds.width, checkpoint.button.x + checkpoint.button.width)
    && Math.max(glow.bounds.y, checkpoint.button.y) < Math.min(glow.bounds.y + glow.bounds.height, checkpoint.button.y + checkpoint.button.height));
  return true;
}

function assertReferenceRegion({ checkpoint, proof, finalFixture, finalInput, checkedAt } = {}) {
  validateCheckpoint(checkpoint, checkedAt);
  const now = time(checkedAt), start = time(checkpoint.startedAt);
  need(proof && proof.source === 'external-sky-accessibility' && proof.executor === checkpoint.executor
    && proof.tool === 'sky.click' && proof.operation === 'click' && proof.mechanism === 'accessibility-mouse'
    && proof.completed === true && proof.synthetic === false && proof.noInvoke === true
    && proof.checkpointId === checkpoint.checkpointId && proof.elementId === checkpoint.observation.elementId
    && proof.elementIndex === checkpoint.observation.elementIndex
    && typeof proof.toolReceiptRef === 'string' && /^actual-tool-call:[A-Za-z0-9_-]{1,128}$/.test(proof.toolReceiptRef));
  sameIdentity(proof.target, checkpoint.target); sameDisplay(proof.display, checkpoint.display);
  const toolStart = time(proof.startedAt), toolEnd = time(proof.completedAt);
  need(toolStart >= start && toolEnd >= toolStart && toolEnd <= now);
  // Starting a checkpoint must not extend the lifetime of its underlying samples.
  need([checkpoint.observation, checkpoint.glow, checkpoint.initialFixture, checkpoint.initialInput]
    .every(sample => toolStart - time(sample.sampledAt) <= MAX_CHECKPOINT_MS));
  const sampledAt = fixture(finalFixture, checkpoint, now, 1, true);
  need(sampledAt >= toolEnd);
  const events = ['lastMouseDown', 'lastMouseUp', 'lastMouseClick'].map(key => finalFixture[key]);
  for (const event of events) {
    need(event && event.button === 'Left' && event.clicks === 1 && event.coordinateSpace === 'physical-screen');
    const at = time(event.atUtc);
    need(at >= toolStart && at <= toolEnd && at <= sampledAt);
    need(contains(checkpoint.display.bounds, { x: event.screenX, y: event.screenY }));
  }
  need(time(events[0].atUtc) <= time(events[1].atUtc) && time(events[0].atUtc) <= time(events[2].atUtc));
  const activation = finalFixture.lastActivation;
  need(activation && time(activation.atUtc) >= time(events[0].atUtc) && time(activation.atUtc) <= toolEnd);
  const point = { x: events[2].screenX, y: events[2].screenY };
  need(contains(checkpoint.button, point) && contains(checkpoint.glow.bounds, point));
  allUp(finalInput, checkpoint, now, true);
  need(time(finalInput.sampledAt) >= sampledAt);
  return { accepted: true, executor: 'Sky', tool: 'sky.click', point, rectangleConvention: 'physical-screen-half-open',
    counters: Object.fromEntries(COUNTERS.map(key => [key, 1])),
    scope: 'Supplied-evidence validation only; caller must independently inspect the actual Sky tool receipt and retained owned child liveness. No live action or case completion is established.' };
}

module.exports = { MAX_CHECKPOINT_MS, contains, validateCheckpoint, assertReferenceRegion };
