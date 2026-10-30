'use strict';
const { ProviderRegistry, CHANNELS } = require('./capabilities.cjs');
const { fail, text, digest, targetKey } = require('./shared.cjs');
const { readPostActionEvidence, postActionStatus, normalizeVerificationPolicies, hasRequiredEvidence } = require('./post-action-evidence.cjs');
const evidenceTargetKey = target => JSON.stringify([targetKey(target), target.identity?.sessionId ?? null]);
const STEP_STATES = ['pending', 'observed', 'needs-verification', 'unknown', 'retryable', 'target-blocked', 'verified'];
const stepKey = spec => digest(spec);

class ComputerMethod {
  constructor({ providers = [], registry, verifyStep, verifyEffect, clock = Date.now, ttlMs = 5000, verificationPolicies = {} } = {}) {
    if (typeof verifyStep !== 'function' || typeof verifyEffect !== 'function' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      fail('invalid-config', 'Independent step/effect verifiers and a positive observation TTL are required.');
    }
    this.registry = registry || new ProviderRegistry(providers);
    this.checkStep = verifyStep; this.checkEffect = verifyEffect; this.clock = clock; this.ttlMs = ttlMs;
    this.effects = new Map(); this.started = false; this.closed = false; this.busy = false;
    this.epoch = 0; this.seen = new Set();
    this.verificationPolicies = normalizeVerificationPolicies(verificationPolicies);
  }
  start({ goalId, effects }) {
    if (this.started || !text(goalId) || !Array.isArray(effects) || !effects.length) fail('invalid-goal', 'Start once with a goal and effects.');
    this.goalId = goalId;
    for (const effect of effects) {
      if (!text(effect.id) || !text(effect.checkId) || this.effects.has(effect.id)
        || !Array.isArray(effect.steps) || !effect.steps.length
        || (effect.dependsOn && (!Array.isArray(effect.dependsOn) || !effect.dependsOn.every(text)))) {
        fail('invalid-effect', 'Each effect requires unique identity, final check, and grounded steps.');
      }
      const entry = { id: effect.id, checkId: effect.checkId, dependsOn: [...(effect.dependsOn || [])],
        status: 'pending', steps: new Map() };
      this.effects.set(effect.id, entry);
      effect.steps.forEach(step => this._append(entry, step));
    }
    for (const e of this.effects.values()) if (e.dependsOn.some(id => id === e.id || !this.effects.has(id))) {
      fail('invalid-dependency', 'Effect dependencies must name another goal effect.');
    }
    const visited = new Set(), visiting = new Set();
    const visit = id => {
      if (visiting.has(id)) fail('invalid-dependency', 'Effect dependencies cannot contain cycles.');
      if (visited.has(id)) return;
      visiting.add(id); this.effects.get(id).dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
    };
    this.effects.forEach(e => visit(e.id));
    this.started = true;
    return this.status();
  }
  _append(effect, step) {
    const t = step.target;
    if (!text(step.id) || effect.steps.has(step.id) || !text(step.checkId) || !text(step.capability)
      || !t || !text(t.environment) || !text(t.app) || !['app', 'web'].includes(t.kind)
      || (t.windowId !== undefined && !text(t.windowId)) || (step.channel && !CHANNELS.includes(step.channel))) {
      fail('invalid-step', 'Steps need unique IDs, exact host/app/kind, operation and independent check.');
    }
    const spec = { id: step.id, checkId: step.checkId, capability: step.capability,
      independent: step.independent === true, channel: step.channel || null,
      target: { environment: t.environment, app: t.app, kind: t.kind,
        ...(t.windowId ? { windowId: t.windowId } : {}),
        ...(t.parentStepId ? { parentStepId: t.parentStepId } : {}) } };
    effect.steps.set(step.id, { spec, status: 'pending', attempts: 0, retryUsed: false,
      uncertain: false, quarantine: false, needsRevalidation: false, providerId: null,
      providerDigest: null, targetDigest: null, ref: null, observation: null, before: null,
      retryEvidence: null, discoveryEpoch: -1, leaseActive: false, lastReceipt: null, postAction: null });
  }
  appendStep(effectId, step) {
    if (this.busy) fail('busy', 'Wait for the current operation.');
    const effect = this._effect(effectId);
    if (effect.status === 'verified') fail('effect-complete', 'A verified effect cannot gain more mutation steps.');
    this._append(effect, step); return this.status();
  }
  _effect(id) {
    if (!this.started || this.closed) fail('inactive', 'Start or resume an open goal first.');
    const effect = this.effects.get(id); if (!effect) fail('unknown-effect', 'Effect is not part of the goal.'); return effect;
  }
  _step(e, id) { const step = e.steps.get(id); if (!step) fail('unknown-step', 'Step is not part of this effect.'); return step; }
  _all() { return [...this.effects.values()].flatMap(effect => [...effect.steps.values()].map(step => ({ effect, step }))); }
  _invalidatePostActions() { for (const { step } of this._all()) step.postAction = null; }
  _rememberPostAction(step, provider, receipt) {
    if (step.lastReceipt.delivery !== 'delivered' || step.quarantine || provider.channel !== 'desktop'
      || step.spec.capability !== 'native-action') return;
    const data = readPostActionEvidence(receipt?.postActionEvidence), observation = data?.observation;
    if (!observation || observation.authority !== 'verification-only' || data.beforeObservationId !== step.before.id
      || !this._matches(step, observation.target) || evidenceTargetKey(observation.target) !== evidenceTargetKey(step.ref)) return;
    const key = digest([provider.id, observation.id]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    step.postAction = { token: receipt.postActionEvidence, data, provider, epoch: this.epoch, attempt: step.attempts,
      target: evidenceTargetKey(step.ref), beforeId: step.before.id };
  }
  _postActionEligible(step, record, policy) {
    if (!record || policy?.timing !== 'immediate' || step.status !== 'needs-verification'
      || step.uncertain || step.quarantine || step.needsRevalidation || !step.leaseActive
      || record.epoch !== this.epoch || step.discoveryEpoch !== this.epoch || record.attempt !== step.attempts
      || record.beforeId !== step.before?.id || record.provider !== this.registry.get(step.providerId)
      || record.provider.available !== true || record.target !== evidenceTargetKey(step.ref)) return false;
    const status = postActionStatus(record.token);
    const limit = Math.min(policy.maxAgeMs, this.ttlMs, record.provider.constraints?.observationTtlMs ?? this.ttlMs);
    return status?.current === true && Number.isFinite(status.ageMs) && status.ageMs >= 0 && status.ageMs <= limit
      && hasRequiredEvidence(record.data.observation, policy.requiredFields);
  }
  async _exclusive(fn) {
    if (this.busy) fail('busy', 'Another operation is in flight; do not duplicate it.');
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  _route(step) {
    return this.registry.select({ ...step.spec, pinnedId: step.attempts ? step.providerId : null,
      providerDigest: step.attempts ? step.providerDigest : null, digest });
  }
  route(effectId, stepId) {
    const step = this._step(this._effect(effectId), stepId), selected = this._route(step);
    return { providerId: selected.provider.id, channel: selected.provider.channel, reason: selected.reason };
  }
  _guard(effect, step, provider, reconciling = false) {
    for (const dependency of effect.dependsOn) if (this.effects.get(dependency).status !== 'verified') {
      fail('dependency-incomplete', 'A required effect has not been independently verified.');
    }
    for (const { effect: otherEffect, step: other } of this._all()) {
      if (other === step || (!other.uncertain && !other.quarantine)) continue;
      const shared = reconciling && (step.uncertain || step.quarantine) && step.targetDigest
        && other.targetDigest === step.targetDigest && other.providerDigest === step.providerDigest;
      if (shared) continue;
      const sameEnvironment = other.spec.target.environment === step.spec.target.environment;
      const usesDesktop = provider.usesDesktop ?? provider.channel === 'desktop';
      if (otherEffect === effect || (sameEnvironment && usesDesktop) || !step.spec.independent) {
        fail('unresolved-work', 'Unresolved input/effect/cleanup blocks this step; independent unrelated APIs must be declared.');
      }
    }
  }
  _matches(step, ref) {
    const target = step.spec.target;
    return ref && ref.environment === target.environment && ref.app === target.app && text(ref.windowId)
      && (!target.windowId || ref.windowId === target.windowId);
  }
  async _releaseBefore(step, provider, ref) {
    for (const { step: old } of this._all()) {
      if (!old.leaseActive || old.spec.target.environment !== step.spec.target.environment
        || (old.providerId === provider.id && targetKey(old.ref) === targetKey(ref))) continue;
      if (!(provider.usesDesktop ?? provider.channel === 'desktop') && (old.uncertain || old.quarantine)) continue;
      let receipt;
      try { receipt = await this.registry.get(old.providerId).close({ target: old.ref, releaseOnly: true }); }
      catch { receipt = { cleanup: 'unknown' }; }
      for (const { step: owner } of this._all()) if (owner.providerId === old.providerId && owner.ref
        && targetKey(owner.ref) === targetKey(old.ref)) {
        owner.observation = null; owner.discoveryEpoch = -1;
        if (receipt?.cleanup === 'confirmed') owner.leaseActive = false; else owner.quarantine = true;
      }
      if (receipt?.cleanup !== 'confirmed') fail('transition-cleanup-unknown', 'Previous owned session cleanup is unverified; transition stopped.');
    }
  }
  async discover(effectId, stepId) {
    return this._exclusive(async () => {
      const effect = this._effect(effectId), step = this._step(effect, stepId);
      step.observation = null; step.discoveryEpoch = -1;
      this._invalidatePostActions();
      const { provider, reason } = this._route(step);
      this._guard(effect, step, provider, true);
      const refs = await provider.discover({ ...step.spec.target, capability: step.spec.capability });
      if (!Array.isArray(refs) || refs.length !== 1 || !this._matches(step, refs[0])) {
        step.observation = null; step.discoveryEpoch = -1; fail('ambiguous-target', 'Exactly one matching discovered target is required.');
      }
      const ref = refs[0];
      if (step.attempts && step.targetDigest && digest(targetKey(ref)) !== step.targetDigest) {
        step.discoveryEpoch = -1; fail('target-changed', 'The attempted target process/resource identity changed.');
      }
      if (step.spec.target.parentStepId) {
        const parent = this._step(effect, step.spec.target.parentStepId);
        if (!parent.ref || parent.ref.environment !== ref.environment
          || String(ref.ownerWindowId ?? '') !== String(parent.ref.windowId)) {
          fail('ownership-unverified', 'The related dialog must identify its exact observed parent window.');
        }
      }
      await this._releaseBefore(step, provider, ref);
      step.providerId = provider.id; step.providerDigest = digest(provider.id); step.ref = { ...ref };
      step.targetDigest = digest(targetKey(ref)); step.discoveryEpoch = ++this.epoch; step.observation = null;
      return { providerId: provider.id, reason, target: step.ref, requiresObservation: true };
    });
  }
  async _capture(step) {
    this._invalidatePostActions();
    step.observation = null; // Every refresh attempt invalidates older evidence, even readiness rejection.
    if (!step.ref || step.discoveryEpoch !== this.epoch) fail('discover-required', 'Target transitions require fresh discovery.');
    const provider = this.registry.get(step.providerId);
    if (provider?.available !== true) fail('provider-unavailable', 'Observed provider is no longer ready.');
    if (provider.usesDesktop ?? provider.channel === 'desktop') step.leaseActive = true;
    const observation = await provider.observe({ target: step.ref });
    if (!observation || !this._matches(step, observation.target) || targetKey(observation.target) !== targetKey(step.ref)) {
      step.discoveryEpoch = -1; fail('stale-target', 'The capture belongs to another target identity.');
    }
    const key = digest([provider.id, observation.id]);
    if (!text(observation.id) || !text(observation.evidenceKey) || this.seen.has(key)) fail('invalid-observation', 'A new capture and evidence key are required.');
    this.seen.add(key);
    step.observation = { ...observation, capturedAt: this.clock(), epoch: this.epoch, consumed: false };
    return step.observation;
  }
  async observe(effectId, stepId) {
    return this._exclusive(async () => {
      const step = this._step(this._effect(effectId), stepId), observation = await this._capture(step);
      if (step.status === 'pending') step.status = 'observed'; return observation;
    });
  }
  async execute(effectId, stepId, payload) {
    return this._exclusive(async () => {
      const effect = this._effect(effectId), step = this._step(effect, stepId), { provider } = this._route(step);
      this._guard(effect, step, provider);
      for (const prior of effect.steps.values()) {
        if (prior === step) break;
        const ownedDialog = prior.status === 'target-blocked' && step.spec.target.parentStepId === prior.spec.id
          && step.ref && prior.ref && String(step.ref.ownerWindowId ?? '') === String(prior.ref.windowId);
        if (prior.status !== 'verified' && !ownedDialog) {
          fail('step-order', 'Verify preceding grounded steps before dispatching the next normal step.');
        }
      }
      if (effect.status === 'verified' || step.status === 'verified') fail('already-verified', 'This effect/step is already verified.');
      if (step.quarantine) fail('quarantined', 'Physical cleanup remains unverified.');
      if (step.uncertain) fail('delivery-unknown', 'Verify the original step before more input.');
      if (step.needsRevalidation) fail('resume-revalidation', 'A checkpoint never authorizes replay.');
      if (provider.id !== step.providerId) fail('route-changed', 'Rediscover the newly selected provider before input.');
      const observation = step.observation, age = observation && this.clock() - observation.capturedAt;
      if (!observation || observation.consumed || observation.epoch !== this.epoch || age < 0 || age > this.ttlMs) {
        fail('stale-observation', 'Use one fresh unconsumed observation per action step.');
      }
      if (step.attempts && (step.attempts >= 2 || step.retryUsed || step.status !== 'retryable'
        || observation.evidenceKey === step.retryEvidence)) fail('retry-denied', 'A corrective retry requires confirmed absence and changed evidence; allow one.');
      const checkedPayload = typeof provider.validateAction === 'function'
        ? await provider.validateAction({ target: step.ref, observationId: observation.id,
          capability: step.spec.capability, payload }) : payload;
      if (this.clock() < observation.capturedAt || this.clock() - observation.capturedAt > this.ttlMs) {
        fail('stale-observation', 'Observation expired during action validation.');
      }
      this._invalidatePostActions();
      observation.consumed = true; step.before = observation;
      if (step.attempts) step.retryUsed = true; step.attempts++; step.status = 'needs-verification';
      let receipt;
      try { receipt = await provider.act({ target: step.ref, observationId: observation.id,
        capability: step.spec.capability, payload: checkedPayload }); } catch { receipt = { delivery: 'unknown' }; }
      const delivery = ['delivered', 'not-delivered', 'unknown'].includes(receipt?.delivery) ? receipt.delivery : 'unknown';
      step.uncertain = delivery === 'unknown';
      step.quarantine ||= receipt?.cleanup === 'unknown' || receipt?.cleanup === 'blocked';
      step.lastReceipt = { delivery, preparation: receipt?.preparation || [], errorCode: receipt?.errorCode || null };
      try { this._rememberPostAction(step, provider, receipt); } catch { step.postAction = null; }
      if (step.uncertain) step.status = 'unknown';
      else if (delivery === 'not-delivered') {
        step.status = receipt?.blocked ? 'target-blocked' : 'retryable';
        step.retryEvidence = observation.evidenceKey;
      }
      return { ...step.lastReceipt, status: step.status, quarantine: step.quarantine,
        needsIndependentVerification: delivery !== 'not-delivered' };
    });
  }
  async verifyStep(effectId, stepId) {
    return this._exclusive(async () => {
      const effect = this._effect(effectId), step = this._step(effect, stepId);
      if (!step.attempts && !step.needsRevalidation) fail('no-attempt', 'No dispatched or restored step requires verification.');
      if (step.quarantine) fail('quarantined', 'Verify physical recovery before completing this step.');
      const post = step.postAction, policy = this.verificationPolicies.get(step.spec.checkId);
      step.postAction = null;
      let after, verdict, evidenceSource = 'fresh-observation';
      if (this._postActionEligible(step, post, policy)) {
        after = { ...structuredClone(post.data.observation), sourceCapturedAt: post.data.sourceCapturedAt, epoch: post.epoch, consumed: true };
        try { verdict = await this.checkStep({ effectId, stepId, checkId: step.spec.checkId,
          before: step.before, after, receipt: step.lastReceipt, evidenceSource: 'post-action' }); } catch { verdict = 'unknown'; }
        if (verdict === 'confirmed' && this._postActionEligible(step, post, policy)) evidenceSource = 'post-action';
        else { step.uncertain = true; step.status = 'unknown'; }
      }
      if (evidenceSource !== 'post-action') {
        after = await this._capture(step);
        try { verdict = await this.checkStep({ effectId, stepId, checkId: step.spec.checkId,
          before: step.before, after, receipt: step.lastReceipt, evidenceSource }); } catch { verdict = 'unknown'; }
      }
      if (verdict === 'confirmed') { step.status = 'verified'; step.uncertain = false; step.needsRevalidation = false; }
      else if (verdict === 'absent') {
        step.status = step.attempts ? 'retryable' : 'observed'; step.uncertain = false;
        step.needsRevalidation = false; step.retryEvidence = after.evidenceKey;
      } else { verdict = 'unknown'; step.status = 'unknown'; step.uncertain = true; }
      return { verdict, status: step.status, effectComplete: effect.status === 'verified', evidenceSource };
    });
  }
  async verifyEffect(effectId, { stepId } = {}) {
    return this._exclusive(async () => {
      const effect = this._effect(effectId);
      if ([...effect.steps.values()].some(s => s.quarantine)) fail('quarantined', 'Physical cleanup prevents goal completion.');
      const step = stepId ? this._step(effect, stepId) : [...effect.steps.values()].at(-1);
      const after = await this._capture(step);
      let verdict;
      try { verdict = await this.checkEffect({ effectId, checkId: effect.checkId, after,
        steps: this._stepStatus(effect) }); } catch { verdict = 'unknown'; }
      if (verdict === 'confirmed') {
        effect.status = 'verified';
        for (const s of effect.steps.values()) {
          if (s.uncertain || s.status === 'needs-verification') s.status = 'verified';
          s.uncertain = false; s.needsRevalidation = false;
        }
      } else { verdict = verdict === 'absent' ? 'absent' : 'unknown'; effect.status = 'pending'; }
      return { verdict, complete: this.status().lifecycle === 'complete' };
    });
  }
  async recover(effectId, stepId) {
    return this._exclusive(async () => {
      this._invalidatePostActions();
      const step = this._step(this._effect(effectId), stepId), provider = this.registry.get(step.providerId);
      if (!step.ref || typeof provider?.recover !== 'function') fail('recovery-unavailable', 'This adapter has no verified physical recovery operation.');
      const proof = await provider.recover({ target: step.ref });
      if (proof?.verified !== true || proof.inputReleased !== true || proof.ownedProcessExited !== true) {
        fail('recovery-unverified', 'Owned process exit and balanced physical input must both be verified.');
      }
      for (const { step: owner } of this._all()) if (owner.providerDigest === step.providerDigest
        && owner.targetDigest === step.targetDigest) {
        owner.quarantine = false; owner.observation = null; owner.discoveryEpoch = -1;
      }
      return { recovered: true, effectStillUncertain: step.uncertain, requiresDiscovery: true };
    });
  }
  _stepStatus(effect) {
    return [...effect.steps.values()].map(s => ({ id: s.spec.id, status: s.status, attempts: s.attempts,
      retryUsed: s.retryUsed, uncertain: s.uncertain, quarantine: s.quarantine, needsRevalidation: s.needsRevalidation }));
  }
  status() {
    const effects = [...this.effects.values()].map(e => ({ id: e.id, status: e.status, steps: this._stepStatus(e) }));
    const complete = effects.length && effects.every(e => e.status === 'verified' && e.steps.every(s => !s.uncertain && !s.quarantine && !s.needsRevalidation));
    return { goalId: this.goalId, lifecycle: this.closed ? 'closed' : complete ? 'complete' : 'active', effects };
  }
  checkpoint() {
    if (!this.started || this.busy) fail('checkpoint-unavailable', 'Checkpoint only an idle started goal.');
    this._invalidatePostActions();
    return { version: 1, goalKey: digest(this.goalId), effects: [...this.effects.values()].map(e => ({
      effectKey: digest([e.id, e.checkId, e.dependsOn]), status: e.status, steps: [...e.steps.values()].map(s => ({
        stepKey: stepKey(s.spec), status: s.status, attempts: s.attempts, retryUsed: s.retryUsed,
        uncertain: s.uncertain, quarantine: s.quarantine, providerKey: s.providerDigest, targetKey: s.targetDigest })) })) };
  }
  static resume(snapshot, { goalId, effects, ...dependencies }) {
    if (!snapshot || snapshot.version !== 1 || snapshot.goalKey !== digest(goalId) || !Array.isArray(snapshot.effects)
      || snapshot.effects.length !== effects?.length) fail('invalid-checkpoint', 'Bind the original goal/effect/step descriptors.');
    const method = new ComputerMethod(dependencies); method.start({ goalId, effects });
    [...method.effects.values()].forEach((e, i) => {
      const saved = snapshot.effects[i];
      if (!saved || !['pending','verified'].includes(saved.status) || saved.effectKey !== digest([e.id, e.checkId, e.dependsOn])
        || !Array.isArray(saved.steps) || saved.steps.length !== e.steps.size) fail('invalid-checkpoint', 'Effect bindings differ.');
      [...e.steps.values()].forEach((s, j) => {
        const v = saved.steps[j];
        if (!v || v.stepKey !== stepKey(s.spec) || !STEP_STATES.includes(v.status)
          || !Number.isInteger(v.attempts) || v.attempts < 0 || v.attempts > 2
          || !['retryUsed', 'uncertain', 'quarantine'].every(k => typeof v[k] === 'boolean')
          || ![v.providerKey, v.targetKey].every(x => x === null || /^[a-f0-9]{64}$/.test(x))
          || (v.attempts && (!v.providerKey || !v.targetKey))
          || ((v.providerKey === null) !== (v.targetKey === null))
          || v.retryUsed !== (v.attempts === 2) || (v.status === 'verified' && v.uncertain)
          || (!v.attempts && ['needs-verification','retryable','target-blocked'].includes(v.status))) {
          fail('invalid-checkpoint', 'Step checkpoint state is invalid.');
        }
        Object.assign(s, { attempts: v.attempts, retryUsed: v.retryUsed, quarantine: v.quarantine,
          uncertain: v.uncertain || v.status === 'needs-verification' || v.status === 'unknown',
          providerDigest: v.providerKey, targetDigest: v.targetKey, needsRevalidation: true });
        s.providerId = method.registry.values().find(p => digest(p.id) === v.providerKey)?.id || null;
        s.status = s.uncertain ? 'unknown' : 'pending';
      });
    }); return method;
  }
  async close() {
    return this._exclusive(async () => {
      this._invalidatePostActions();
      const receipts = new Map();
      for (const { step } of this._all()) {
        if (!step.ref) continue;
        const p = this.registry.get(step.providerId), usesDesktop = p.usesDesktop ?? p.channel === 'desktop';
        if (usesDesktop && !step.leaseActive) continue;
        const key = digest([p.id, targetKey(step.ref)]);
        if (!receipts.has(key)) {
          try { receipts.set(key, await p.close({ target: step.ref, releaseOnly: true })); }
          catch { receipts.set(key, { cleanup: 'unknown' }); }
        }
        if (receipts.get(key)?.cleanup === 'confirmed') step.leaseActive = false; else step.quarantine = true;
        step.observation = null;
      }
      this.closed = true; return this.status();
    });
  }
}
module.exports = { ComputerMethod };
