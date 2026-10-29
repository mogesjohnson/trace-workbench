'use strict';
// Tokens are transient process-local capabilities, not serialized freshness claims.
const records = new WeakMap();

function createPostActionEvidence({ observation, actionId, beforeObservationId, startedAt, clock, current }) {
  const sourceCapturedAt = observation.evidence.state.observedAt;
  if (!Number.isFinite(startedAt) || typeof sourceCapturedAt !== 'string'
    || !Number.isFinite(Date.parse(sourceCapturedAt))) return null;
  const token = Object.freeze({ kind: 'validated-native-post-action' });
  records.set(token, { data: { observation: structuredClone(observation), actionId, beforeObservationId, sourceCapturedAt },
    startedAt, clock, current });
  return token;
}

function readPostActionEvidence(token) {
  const record = records.get(token);
  return record ? structuredClone(record.data) : null;
}

function postActionStatus(token) {
  const record = records.get(token);
  if (!record) return null;
  try { return { ageMs: record.clock() - record.startedAt, current: record.current() === true }; }
  catch { return null; }
}

const fields = {
  images: o => o.evidence?.contentIndexSpace === 'images' && o.evidence.images?.length === 1
    && o.evidence.state?.screenshot?.contentIndex === 0,
  elements: o => Array.isArray(o.evidence?.state?.elements) && o.evidence.state.accessibility?.truncated === false,
  accessibility: o => Number.isInteger(o.evidence?.state?.accessibility?.depth)
    && o.evidence.state.accessibility.depth >= 1 && o.evidence.state.accessibility.depth <= 32
    && o.evidence.state.accessibility.truncated === false,
  focus: o => o.evidence?.focus?.available === true && typeof o.evidence.focus.hasFocus === 'boolean'
    && (!o.evidence.focus.hasFocus || typeof o.evidence.focus.elementId === 'string' && o.evidence.focus.elementId.length > 0),
  targetState: o => ['enabled', 'minimized', 'foreground'].every(key => typeof o.evidence?.state?.targetState?.[key] === 'boolean')
    && Object.hasOwn(o.evidence.state.targetState, 'ownerWindowId'),
};

function normalizeVerificationPolicies(policies) {
  const { fail } = require('./shared.cjs');
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) fail('invalid-config', 'Verification policies must be keyed by step checkId.');
  return new Map(Object.entries(policies).map(([id, p]) => {
    if (!p || !['immediate', 'settled'].includes(p.timing)
      || Object.keys(p).some(key => !['timing', 'requiredFields', 'maxAgeMs'].includes(key))) fail('invalid-config', 'Declare immediate or settled verification with supported policy fields.');
    if (p.timing === 'settled') return [id, { timing: 'settled' }];
    if (!Number.isFinite(p.maxAgeMs) || p.maxAgeMs <= 0 || !Array.isArray(p.requiredFields) || !p.requiredFields.length
      || !p.requiredFields.every(key => typeof key === 'string' && Object.hasOwn(fields, key))) fail('invalid-config', 'Immediate verification requires a positive maxAgeMs and known requiredFields.');
    return [id, { timing: p.timing, maxAgeMs: p.maxAgeMs, requiredFields: [...new Set(p.requiredFields)] }];
  }));
}

const hasRequiredEvidence = (observation, required) => required.every(key => fields[key](observation));
module.exports = { createPostActionEvidence, readPostActionEvidence, postActionStatus, normalizeVerificationPolicies, hasRequiredEvidence };
