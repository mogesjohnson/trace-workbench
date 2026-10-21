'use strict';
const { fail, text, byId } = require('./shared.cjs');
const CHANNELS = ['app-connector', 'browser', 'desktop'];

class ProviderRegistry {
  constructor(providers = []) { this.providers = new Map(); providers.forEach(p => this.register(p)); }
  register(provider) {
    if (!provider || !text(provider.id) || this.providers.has(provider.id)
      || !CHANNELS.includes(provider.channel)
      || !['environments', 'apps', 'capabilities'].every(k => Array.isArray(provider[k]))
      || (provider.windowIds !== undefined && (!Array.isArray(provider.windowIds) || !provider.windowIds.every(text)))) {
      fail('invalid-provider', 'A provider needs unique identity, channel, environments, apps and capabilities.');
    }
    this.providers.set(provider.id, provider);
    return this;
  }
  get(id) { return this.providers.get(id); }
  values() { return [...this.providers.values()]; }
  select({ target, capability, channel, pinnedId, providerDigest, digest, lifecycle = true }) {
    const candidates = this.values().filter(p => p.available === true
      && p.environments.includes(target.environment) && p.apps.includes(target.app)
      && (!target.windowId || !p.windowIds || p.windowIds.includes(target.windowId))
      && p.capabilities.includes(capability) && (!channel || p.channel === channel)
      && (p.channel !== 'browser' || target.kind === 'web')
      && (!lifecycle || ['discover', 'observe', 'act', 'close'].every(k => typeof p[k] === 'function')))
      .sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel) || byId(a, b));
    const pinned = pinnedId || providerDigest;
    const provider = pinned ? candidates.find(p => providerDigest ? digest(p.id) === providerDigest : p.id === pinnedId) : candidates[0];
    if (!provider) fail('no-route', pinned ? 'The original provider is unavailable; attempted work cannot change route.'
      : 'No ready advertised provider matches the exact environment, app and operation.');
    return { provider, reason: pinned ? 'Original dispatch provider retained.'
      : `${provider.channel} is the highest ranked ready provider supporting this exact operation.` };
  }
}
module.exports = { ProviderRegistry, CHANNELS };
