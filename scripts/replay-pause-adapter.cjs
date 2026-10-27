'use strict';
// Production dependencies for the bounded REPLAY pause supplement. Import is inert.
const fs = require('node:fs/promises');
const path = require('node:path');
const common = require('./replacement-acceptance-common.cjs');
const replay = require('./replay-workflow-runtime.cjs');
const flow = require('./accept-replay-workflow.cjs');
const assets = require('./replay-pause-assets.cjs');
const budget = require('./narrow-finish-budget.cjs');
const { atomic, leaseFree, sourceSnapshot, frame, closeTrace } = require('./replay-pause-support.cjs');
const need = (value, message) => { if (!value) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createRuntime({ directory, decision }) {
  const state = { startedAt: new Date().toISOString(), acquisitions: {}, cleanup: {}, status: 'running', cleanupUnconfirmed: false };
  const abort = new AbortController();
  const active = () => need(!abort.signal.aborted, 'Pause case cancelled; no further dispatch');
  let replayDeps, app, grant, trace, session, chain, projectId, display, snapshot, launchAt;
  const attempted = new Set();
  let nativeStarted = false, nativeSafe = true;
  const receipt = path.join(directory, 'receipt.json');
  const record = async update => { state.workflow = structuredClone(update); await atomic(receipt, state); };
  const mark = async (name, value) => { state.acquisitions[name] = value; await atomic(receipt, state); };
  async function acquire(name, task) {
    await mark(name, 'pending');
    try { const value = await task(); await mark(name, 'acquired'); return value; }
    catch (error) { await mark(name, 'unknown'); state.cleanupUnconfirmed = true; throw error; }
  }
  async function identityCheck() {
    need(app?.identity, 'REPLAY identity unavailable');
    const actual = await replayDeps.windowIdentity(app.identity);
    for (const key of ['windowId', 'pid', 'processCreationTime', 'sessionId']) need(actual[key] === app.identity[key], 'REPLAY window changed');
    return actual;
  }
  async function project(client, id) { return replayDeps.command(client, 'project.get', { id }); }
  async function cleanup(name) {
    attempted.add(name);
    if (state.cleanup[name] === true) return true;
    if (name === 'nativeSession') {
      if (!session) return !nativeStarted;
      const value = await trace.call('close_session', { sessionId: session.sessionId });
      need(value.closed === true, 'Native session close unconfirmed'); return state.cleanup[name] = true;
    }
    if (name === 'trace') {
      if (!trace) return !nativeStarted;
      try {
        await closeTrace(trace, chain);
        nativeSafe = true; return state.cleanup[name] = true;
      } catch (error) { nativeSafe = false; throw error; }
    }
    if (name === 'replay') { if (app?.client) await replayDeps.closeTransport(app.client); return state.cleanup[name] = true; }
    if (name === 'grant') {
      if (!app?.grantId) return false;
      await replayDeps.revokeGrant(app); need(await replayDeps.grantRevoked(app), 'Grant revocation unconfirmed');
      return state.cleanup[name] = true;
    }
    if (name === 'app') {
      need(nativeSafe, 'Native input quiescence unconfirmed; REPLAY retained');
      if (!app?.handle) return false;
      await replayDeps.stopApp(app.handle, app.page, app.child);
      need(app.identity && app.launcherIdentity && await replayDeps.waitIdentityExit(app.identity) &&
        await replayDeps.waitIdentityExit(app.launcherIdentity), 'REPLAY exact exit unconfirmed');
      return state.cleanup[name] = true;
    }
    throw new Error('Unknown cleanup stage');
  }
  return { state, record, cleanup, cancel: () => { state.cancelled = true; abort.abort(); },
    async preflight() {
      active();
      await common.verify(); display = common.validateDisplay(await common.command(['display']));
      need(display.monitors === 1 && (await common.command(['status'])).recoveryRequired === false &&
        (await common.command(['input-access'])).observable === true &&
        (await common.command(['keystate', 'all'])).down?.length === 0 && await leaseFree(), 'Desktop preflight failed');
      ({ deps: replayDeps, pins: state.pins } = await assets.verifyPins(directory));
      snapshot = await sourceSnapshot(); state.testedSource = snapshot; await atomic(receipt, state);
    },
    prepareMedia: () => assets.prepareMedia(directory),
    async claim() { active(); state.claim = await budget.claim({ caseId: 'A4-REPLAY', decision }); await atomic(receipt, state); },
    async launch(media) {
      active();
      need(JSON.stringify(await replayDeps.verifyPins()) === JSON.stringify(state.pins), 'REPLAY pins changed before launch');
      launchAt = new Date().toISOString();
      const root = path.join(directory, 'editor');
      return acquire('app', async () => {
        const handle = await replayDeps.launchApp({ label: 'editor', args: [`--smoke-test=${media.path}`, `--smoke-output=${root}`] });
        app = { handle, root }; app.child = handle.process(); return app;
      });
    },
    async identify() {
      app.launcherIdentity = await replayDeps.processIdentity(app.child.pid);
      app.identity = await replayDeps.applicationIdentity(app.handle, app.launcherIdentity);
      const ready = await replayDeps.readyApp(app.handle); Object.assign(app, ready);
      need(flow.inside(app.root, app.info.libraryPath), 'Library outside isolated profile');
      const window = await replayDeps.editorWindowIdentity(app.handle);
      for (const key of ['pid', 'processCreationTime', 'sessionId']) need(window[key] === app.identity[key], 'REPLAY main/window mismatch');
      app.identity = { ...app.identity, ...window }; return { ...app.identity, launcherIdentity: app.launcherIdentity, appRoot: app.root };
    },
    async grant() {
      active();
      await acquire('grant', async () => {
        grant = await replayDeps.createGrant(app.page, 'TRACE pause supplement');
        app.grantId = grant.grant.id; app.importRoot = grant.grant.importRoots[0]; app.exportRoot = grant.grant.exportRoots[0]; return grant;
      });
      need(app.grantId && flow.inside(app.root, app.importRoot) && flow.inside(app.root, app.exportRoot), 'Grant outside isolated profile');
      return grant;
    },
    async connectReplay() {
      return acquire('replayTransport', async () => { app.client = await replayDeps.connectMcp(grant.setup.mcp.mcpServers.replay); return app.client; });
    },
    async importMedia(media) {
      active();
      const root = await fs.realpath(app.root), importRoot = await fs.realpath(app.importRoot);
      need(flow.inside(root, importRoot), 'Import root escaped profile');
      const target = path.join(importRoot, 'pause-preview.mp4');
      await fs.copyFile(media.path, target, require('node:fs').constants.COPYFILE_EXCL);
      need(common.digest(await fs.readFile(target)) === media.sha256, 'Preview copy changed'); return { path: target };
    },
    async command(client, name, input, revision, requestId) {
      active();
      const value = await replayDeps.command(client, name, input, revision, requestId);
      if (name === 'project.import') projectId = value.id;
      return value;
    },
    async savedRecipe(client, id) { const value = await project(client, id); return { hash: common.digest(Buffer.from(JSON.stringify(value))), revision: value.revision }; },
    async preview(client) {
      const value = await replayDeps.command(client, 'preview.get'); const saved = await project(client, projectId);
      need(value.revision === saved.revision, 'Preview revision differs from saved project');
      return { ...value, duration: saved.duration, recipeHash: common.digest(Buffer.from(JSON.stringify(saved))) };
    },
    delay: () => delay(1000), now: Date.now,
    async connectTrace() {
      active();
      nativeStarted = true; nativeSafe = false;
      return acquire('traceTransport', async () => { trace = await common.connect(path.join(directory, 'trace')); return trace; });
    },
    async openTrace(connection, target) {
      need((await connection.call('doctor')).ready === true, 'TRACE doctor failed');
      const windows = (await connection.call('list_windows')).windows;
      const selected = windows.find(item => String(item.id) === target.windowId && item.pid === target.pid);
      common.assertIdentity(selected, { ...target, id: target.windowId });
      await acquire('nativeSession', async () => { active(); session = await connection.call('open_session', { windowId: target.windowId }, { signal: abort.signal }); return session; });
      need(session.sessionId && session.activityIndicator?.owner === 'native-supervisor' && session.activityIndicator.monitors === 1, 'Native readiness missing');
      chain = await common.readChain(connection);
      state.traceOwnership = chain;
      need(Object.values(chain).every(value => value.sessionId === target.sessionId), 'Native owner belongs to another Windows session');
      return { ...session, openedAfter: launchAt, since: new Date().toISOString() };
    },
    async observe(connection, current) { active(); await identityCheck(); active(); return frame(directory, session, app.identity, await connection.call('observe', { sessionId: current.sessionId }), 'before'); },
    async publishReview(observation) {
      const pending = { ...observation, reviewFile: path.join(directory, 'review.json') };
      await atomic(path.join(directory, 'pending.json'), pending); process.stdout.write(JSON.stringify({ pending }) + '\n');
    },
    async waitReview(timeout) {
      const deadline = Date.now() + Math.min(timeout, 45000);
      while (Date.now() < deadline) {
        active();
        try { return JSON.parse(await fs.readFile(path.join(directory, 'review.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await delay(150);
      }
      throw new Error('Review timed out');
    },
    async clickOnce(connection, current, observation, point) {
      await identityCheck(); common.compareDisplay(await common.command(['display']), display);
      need(JSON.stringify(await sourceSnapshot()) === JSON.stringify(snapshot), 'Source changed before input');
      state.nativeDispatch = { startedAt: new Date().toISOString(), observationId: observation.id, point }; await atomic(receipt, state);
      active();
      const raw = await connection.call('act', { sessionId: current.sessionId, observationId: observation.id, action: { type: 'click', x: point.x, y: point.y } }, { signal: abort.signal });
      state.nativeDispatch.result = raw; await atomic(receipt, state);
      return { outcome: raw.outcome, finalObservation: raw.observation ? await frame(directory, session, app.identity, raw.observation, 'after') : undefined };
    },
    async journal(current) { return replay.parseJournal(await fs.readFile(path.join(trace.journalRoot, current.sessionId, 'events.jsonl'), 'utf8')); },
    async finish() {
      for (const [name, present] of [['nativeSession', session], ['trace', trace], ['replay', app?.client], ['grant', app?.grantId], ['app', app]]) {
        if (!present || attempted.has(name)) continue;
        try { await cleanup(name); } catch (error) { state.cleanup[name] = error.message; state.cleanupUnconfirmed = true; }
      }
      if (snapshot) {
        try { await common.verify(); need(JSON.stringify(await sourceSnapshot()) === JSON.stringify(snapshot), 'Source changed');
          need(JSON.stringify(await replayDeps.verifyPins()) === JSON.stringify(state.pins), 'REPLAY pins changed'); }
        catch (error) { state.cleanupUnconfirmed = true; state.sourceError = error.message; }
      }
      return state;
    },
    async reconcile(client, requests) {
      return Promise.all(requests.filter(item => item.state === 'unknown' || item.state === 'pending').map(async item => {
        const receipt = await replayDeps.readRequestReceipt(app, item.requestId);
        const entry = { command: item.name, requestId: item.requestId, payload: { input: item.input,
          ...(item.expectedRevision === undefined ? {} : { expectedRevision: item.expectedRevision }) } };
        return { requestId: item.requestId, outcome: flow.matchingRequestReceipt(entry, receipt) ? receipt.state : 'unresolved' };
      }));
    }
  };
}
module.exports = { createRuntime };
