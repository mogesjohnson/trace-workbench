'use strict';
const { createHash } = require('node:crypto');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = value => typeof value === 'string' && value.length > 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const targetKey = target => {
  const identity = target.identity || {};
  return JSON.stringify([target.environment, target.app, target.windowId,
    identity.pid ?? null, identity.processName ?? null,
    identity.generation ?? target.generation ?? null, target.ownerWindowId ?? null]);
};
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
module.exports = { fail, text, digest, targetKey, byId };
