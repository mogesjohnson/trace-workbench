'use strict';
// Pure orchestration contract only. No production runtime is connected to this module.
const { randomUUID } = require('node:crypto');
const { verifyJournal } = require('./replay-workflow-runtime.cjs');
const budget = require('./narrow-finish-budget.cjs');
const need = (condition, message) => { if (!condition) throw new Error(message); };

function plan() {
  return { ...budget.plan('A4-REPLAY'), mode: 'plan', claimsAttempt: false, productionRuntimeAvailable: false,
    reviewDeadlineMs: 45000, minimumPreviewSeconds: 120, minimumRemainingSeconds: 30, nativeClicks: 1 };
}
function playing(state, project, recipe) {
  need(state?.projectId === project && state.playing === true && Number.isFinite(state.position) &&
    Number.isFinite(state.duration) && state.duration >= 120 && state.duration - state.position >= 30 &&
    state.position >= 0 && state.recipeHash === recipe.hash && state.revision === recipe.revision, 'playing state invalid');
}
function paused(state, before, project, recipe) {
  need(state?.projectId === project && state.playing === false && Number.isFinite(state.position) &&
    state.position >= before.position && state.position < state.duration && state.duration === before.duration &&
    state.recipeHash === recipe.hash && state.revision === recipe.revision, 'paused state invalid');
}
function reviewMatches(review, observation, now) {
  const time = Date.parse(review?.reviewedAt);
  return review?.observationId === observation.id && review.screenshotSha256 === observation.sha256 &&
    Number.isFinite(time) && time >= observation.at && time <= now && now - observation.at <= 45000 &&
    Number.isSafeInteger(review.point?.x) && Number.isSafeInteger(review.point?.y) &&
    review.point.x >= 0 && review.point.y >= 0 && review.point.x < observation.width && review.point.y < observation.height;
}
function journalMatches(events, context) {
  const summary = verifyJournal(events, { sessionId: context.sessionId, target: context.target,
    since: context.since, openedAfter: context.openedAfter, observationId: context.observationId });
  need(summary.actions.length === 1 && summary.actions[0].actionType === 'click', 'journal action mismatch');
  const complete = events.find(event => event.type === 'action_completed' && event.actionId === summary.actions[0].actionId);
  need(complete?.observationId === context.observationId, 'journal observation mismatch');
  return summary;
}

// All dependencies are injected; this function has no live CLI or default adapter.
// Each acquisition must return its handle before any later acquisition begins.
async function runInjected(deps) {
  const result = { status: 'running', requests: [], cleanup: {} };
  let app, grant, replay, trace, session;
  async function request(name, args, expectedRevision) {
    const requestId = `trace-replay-${randomUUID()}`;
    const record = { name, requestId, input: structuredClone(args),
      ...(expectedRevision === undefined ? {} : { expectedRevision }), state: 'pending' };
    result.requests.push(record);
    await deps.record(result);
    try {
      const value = await deps.command(replay, name, args, expectedRevision, requestId);
      record.state = 'completed';
      await deps.record(result);
      return value;
    } catch (error) {
      record.state = error.replayOutcome === 'failed' ? 'failed' : 'unknown';
      await deps.record(result);
      throw error;
    }
  }
  try {
    await deps.preflight();
    const media = await deps.prepareMedia();
    await deps.claim();
    app = await deps.launch(media);
    const target = await deps.identify(app);
    grant = await deps.grant(app);
    replay = await deps.connectReplay(grant);
    const imported = await deps.importMedia(media, grant);
    const project = await request('project.import', { path: imported.path });
    need(project && typeof project.id === 'string' && project.id && Number.isSafeInteger(project.revision) && project.revision > 0, 'project invalid');
    await request('preview.open', { projectId: project.id, position: 0 }, project.revision);
    await request('preview.play', { projectId: project.id }, project.revision);
    const recipe = await deps.savedRecipe(replay, project.id);
    const first = await deps.preview(replay);
    await deps.delay();
    const advancing = await deps.preview(replay);
    playing(first, project.id, recipe); playing(advancing, project.id, recipe);
    need(advancing.position > first.position, 'preview did not advance');
    result.preview = { first, advancing }; result.savedRecipe = recipe;
    trace = await deps.connectTrace();
    session = await deps.openTrace(trace, target);
    const observation = await deps.observe(trace, session);
    await deps.publishReview(observation);
    const review = await deps.waitReview(45000);
    need(reviewMatches(review, observation, deps.now()), 'review invalid or stale');
    const before = await deps.preview(replay);
    playing(before, project.id, recipe);
    need(before.position >= advancing.position, 'preview regressed');
    result.preview.before = before;
    result.nativeInput = { state: 'pending', observationId: observation.id, point: structuredClone(review.point) };
    await deps.record(result);
    let click;
    try { click = await deps.clickOnce(trace, session, observation, review.point); }
    catch (error) { result.nativeInput.state = 'unknown'; await deps.record(result); throw error; }
    result.nativeInput.state = click?.outcome ?? 'unknown';
    await deps.record(result);
    need(click?.outcome === 'completed', 'native delivery unknown');
    need(click.finalObservation?.id && click.finalObservation.id !== observation.id &&
      /^[a-f0-9]{64}$/.test(click.finalObservation.sha256 ?? ''), 'final observation invalid');
    const after = await deps.preview(replay);
    await deps.delay();
    const stable = await deps.preview(replay);
    Object.assign(result.preview, { after, stable });
    paused(after, before, project.id, recipe); paused(stable, before, project.id, recipe);
    need(Math.abs(stable.position - after.position) < 0.05, 'pause not stable');
    need(JSON.stringify(await deps.savedRecipe(replay, project.id)) === JSON.stringify(recipe), 'recipe changed');
    result.journal = journalMatches(await deps.journal(session), { ...session, target, observationId: click.finalObservation.id });
    need(result.journal.finalObservation.sha256 === click.finalObservation.sha256, 'final observation hash mismatch');
    result.finalObservation = click.finalObservation;
    result.status = 'pass';
  } catch (error) {
    result.status = 'fail'; result.error = error.message;
    if (replay) result.reconciliation = await deps.reconcile(replay, result.requests).catch(() => 'unresolved');
  } finally {
    for (const [name, handle] of [['nativeSession', session], ['trace', trace], ['replay', replay], ['grant', grant], ['app', app]]) {
      if (!handle) continue;
      try { need(await deps.cleanup(name, handle) === true, `${name} cleanup unconfirmed`); result.cleanup[name] = true; }
      catch (error) { result.status = 'fail'; result.cleanup[name] = error.message; }
    }
    await deps.record(result);
  }
  return result;
}
module.exports = { plan, playing, paused, reviewMatches, journalMatches, runInjected };
