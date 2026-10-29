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

module.exports = { createPostActionEvidence, readPostActionEvidence, postActionStatus };
