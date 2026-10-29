'use strict';
const { createHash } = require('node:crypto');
const { fail, text } = require('./shared.cjs');
const MAX_BYTES = 6 * 1024 * 1024;
const owner = value => value == null ? null : String(value);

function windowIdentity(window = {}) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) fail('target-mismatch', 'Window identity is unavailable.');
  const id = window.id ?? window.windowId, pid = window.pid ?? window.processId;
  if (!text(id) || id.length > 256 || id.includes('\0') || !Number.isSafeInteger(pid) || pid <= 0
    || !text(window.processName) || typeof window.processCreationTime !== 'string' || !/^\d{1,32}(?![\s\S])/.test(window.processCreationTime)
    || (window.sessionId != null && (!Number.isSafeInteger(window.sessionId) || window.sessionId < 0))) {
    fail('target-mismatch', 'A complete window process lifetime is required for image evidence.');
  }
  return [id, pid, window.processName, window.processCreationTime, window.sessionId ?? null];
}

// Validate the original MCP envelope before filtering/remapping its content indexes.
// This checks image association and PNG metadata, not a full pixel decode or capture freshness.
function validateObservationImages(value, content, expected) {
  if (!expected || !text(expected.sessionId) || !value || !text(value.observationId) || value.observationId.length > 256 || value.observationId.includes('\0')
    || value.sessionId !== expected.sessionId
    || JSON.stringify(windowIdentity(value.window)) !== JSON.stringify(windowIdentity(expected.window))) {
    fail('target-mismatch', 'The image observation does not match the exact bound session and process lifetime.');
  }
  const observedOwner = (Object.hasOwn(value.targetState || {}, 'ownerWindowId')
    ? value.targetState.ownerWindowId : value.window?.ownerWindowId) ?? null;
  if (owner(observedOwner) !== owner(expected.ownerWindowId)) fail('ownership-changed', 'Observed window ownership differs from discovery.');
  const invalid = () => fail('invalid-image-evidence', 'Require one correctly indexed PNG with matching dimensions and SHA-256.');
  const metadata = value.screenshot, index = metadata?.contentIndex;
  if (!Array.isArray(content) || !Number.isSafeInteger(index) || index < 0 || index >= content.length
    || content.filter(item => item?.type === 'image').length !== 1) invalid();
  const image = content[index], bounds = value.bounds;
  if (image?.type !== 'image' || image.mimeType !== 'image/png' || metadata.mimeType !== 'image/png'
    || typeof image.data !== 'string' || image.data.length > 4 * Math.ceil(MAX_BYTES / 3)
    || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    || !bounds || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key]))
    || bounds.width < 1 || bounds.height < 1 || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '')) invalid();
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length < 33 || bytes.length > MAX_BYTES || bytes.toString('base64') !== image.data
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff
    || width !== metadata.width || height !== metadata.height || width !== bounds.width || height !== bounds.height
    || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) invalid();
  const state = structuredClone(value);
  state.screenshot = { ...state.screenshot, contentIndex: 0, sourceContentIndex: index };
  return { state, images: [{ type: 'image', mimeType: 'image/png', data: image.data }], contentIndexSpace: 'images' };
}

module.exports = { validateObservationImages, windowIdentity };
