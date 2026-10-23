'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable, Writable } = require('node:stream');
const { plan, parseArgs, createGuard, streamState, observeEvent, summarize, hostArguments,
  hostEnvironment, invokeHost, completed, run, supportedHostVersion, scopedReadPath,
  hostToolAllowed, hostSettings, runHostHook, loadInstalledBundle, fingerprintSettings, compareSettings, preflightStartup, MAX_GUARD_ADMISSIONS,
  changedKeyPaths, privateSettingsIntervals, terminalHostStatus, listClaudeProcesses, createWriterMonitor, writePrivateSettingsDiff,
  prepareAndClaimContinuation, preparedFixture, verifyTestedSource, loadReaInstructions,
  createOwnershipTracker, verifyOwnershipExit } = require('../scripts/accept-claude-host.cjs');
const { loadSkillBundle } = require('../src/computer/configuration.cjs');
const tool = name => `mcp__trace-acceptance__trace_computer_${name}`;
const error = code => Object.assign(new Error('PRIVATE_ERROR_BODY'), { code });
const payload = 'Owned synthetic literal';

async function bundleFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-installed-bundle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), installed = path.join(directory, 'installed');
  await fs.cp(path.resolve(__dirname, '../skills/trace-computer-use'), source, { recursive: true });
  await fs.cp(source, installed, { recursive: true });
  return { directory, source, installed };
}

test('installed bundle tolerates preserved files without reading them or allowing host access', async t => {
  const { source, installed } = await bundleFixture(t);
  const backup = path.join(installed, 'SKILL.md.trace.backup.synthetic');
  const unrelated = path.join(installed, 'unrelated', 'private.txt');
  await fs.mkdir(path.dirname(unrelated));
  await fs.writeFile(backup, 'PRIVATE_BACKUP'); await fs.writeFile(unrelated, 'PRIVATE_UNRELATED');
  const readFile = fs.readFile, readPaths = [];
  fs.readFile = async (file, ...args) => {
    readPaths.push(path.resolve(file));
    assert.notEqual(path.resolve(file), backup); assert.notEqual(path.resolve(file), unrelated);
    return readFile(file, ...args);
  };
  let actual;
  try { actual = await loadInstalledBundle(installed, source); } finally { fs.readFile = readFile; }
  const canonical = await loadSkillBundle(source);
  assert.equal(actual.bundleSha256, canonical.bundleSha256);
  assert.deepEqual([...actual.files.keys()].sort(), [...canonical.files.keys()].sort());
  assert.ok(readPaths.includes(path.join(installed, 'manifest.json')));
  const allowedReads = [...actual.files.keys()].map(relative => path.join(installed, relative));
  assert.equal(scopedReadPath(backup, allowedReads), null);
  assert.equal(await hostToolAllowed({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: backup } }, { allowedReads }), false);
  assert.equal(await readFile(backup, 'utf8'), 'PRIVATE_BACKUP');
  await assert.rejects(loadSkillBundle(installed), { code: 'invalid_skill_source' });
});

test('installed bundle requires strict canonical source before inspecting installation', async t => {
  const { source, directory } = await bundleFixture(t);
  await fs.writeFile(path.join(source, 'undeclared.txt'), 'synthetic');
  await assert.rejects(loadInstalledBundle(path.join(directory, 'absent'), source), { code: 'invalid_skill_source' });
});

test('installed manifest must match exact canonical bytes and every managed file must exist and match', async t => {
  for (const change of ['manifest-format', 'manifest-path', 'file-content', 'missing', 'directory']) {
    await t.test(change, async t => {
      const { source, installed } = await bundleFixture(t);
      const manifest = path.join(installed, 'manifest.json'), skill = path.join(installed, 'SKILL.md');
      if (change === 'manifest-format') await fs.appendFile(manifest, '\n');
      if (change === 'manifest-path') {
        const value = JSON.parse(await fs.readFile(manifest, 'utf8'));
        value.files['../outside.md'] = '0'.repeat(64); await fs.writeFile(manifest, JSON.stringify(value));
      }
      if (change === 'file-content') await fs.appendFile(skill, '\nchanged');
      if (change === 'missing' || change === 'directory') await fs.unlink(skill);
      if (change === 'directory') await fs.mkdir(skill);
      await assert.rejects(loadInstalledBundle(installed, source), change === 'missing'
        ? { code: 'ENOENT' } : { code: change === 'directory' ? 'installed_skill_unsafe' : 'installed_skill_differs' });
    });
  }
});

test('installed bundle rejects linked roots, managed ancestors and unrelated links without reading targets', async t => {
  for (const change of ['root', 'ancestor', 'managed-directory', 'unrelated']) {
    await t.test(change, async t => {
      const { directory, source, installed } = await bundleFixture(t);
      const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
      let target = installed;
      if (change === 'root') {
        target = path.join(directory, 'linked'); await fs.symlink(installed, target, 'junction');
      } else if (change === 'ancestor') {
        const linked = path.join(directory, 'linked'); await fs.symlink(directory, linked, 'junction');
        target = path.join(linked, 'installed');
      } else if (change === 'managed-directory') {
        await fs.rename(path.join(installed, 'references'), path.join(outside, 'references'));
        await fs.symlink(path.join(outside, 'references'), path.join(installed, 'references'), 'junction');
      } else await fs.symlink(outside, path.join(installed, 'unrelated-link'), 'junction');
      await assert.rejects(loadInstalledBundle(target, source), { code: 'installed_skill_unsafe' });
    });
  }
});

function syntheticGuard(options = {}) {
  const calls = [], records = [], app = { text: '', count: 0 }, target = { id: 'owned', pid: 123, title: 'owned-title', processCreationTime: 'generation-1' };
  let sequence = 0, latest, fixtureReads = 0;
  const frame = focused => { latest = `observation-${++sequence}`; return { observationId: latest,
    elements: [{ id: 'edit', name: 'TRACE text input', enabled: true }, { id: 'increment', name: 'Increment counter', enabled: true }],
    focused: { hasFocus: focused, elementId: focused ? 'edit' : null }, screenshot: { data: 'synthetic-png' } }; };
  const guard = createGuard({ target, payload, readFixture: async () => {
    if (options.staleReadFails && ++fixtureReads > 2) throw error('stale_read_unavailable');
    return { ...app, focusedControl: options.independentFocusWrong ? 'otherControl' : 'traceTextInput' };
  },
    record: async value => { await options.beforeRecord?.(value); records.push(JSON.parse(JSON.stringify(value))); }, assertDisplay: async () => {},
    closeUpstream: async () => { calls.push('upstream-close'); if (options.closeUnknown) throw error('cleanup_unknown'); },
    call: async (name, input) => {
      calls.push({ name, input });
      await options.beforeCall?.(name, input);
      if (name === 'doctor') return { ready: true };
      if (name === 'list_windows') return { windows: [structuredClone(target), { id: 'private', pid: 999, title: 'PRIVATE_UNRELATED_TITLE' }] };
      if (name === 'open_session') return { sessionId: 'session', window: { ...target, ...(options.wrongGeneration ? { processCreationTime: 'other' } : {}) } };
      if (name === 'observe') return frame(true);
      if (name === 'close_session') return { closed: true };
      if (name === 'act') {
        if (input.observationId !== latest) {
          if (options.staleMutates) app.count++;
          throw error(options.staleOtherError || 'stale_observation');
        }
        if (input.action.type === 'type_text') {
          app.text = input.action.text;
          if (options.unknownType) return { outcome: 'unknown', error: { code: 'synthetic_unknown' } };
          if (options.lostType) throw error('transport_uncertain');
        }
        if (input.action.type === 'invoke') app.count++;
        return { outcome: 'completed', observation: frame(!options.wrongFocus) };
      }
      throw new Error(name);
    },
  });
  return { guard, target, app, calls, records };
}
async function open(f) {
  await f.guard.listWindows(); await f.guard.openSession({ windowId: 'owned' });
  const a = await f.guard.observe({ sessionId: 'session' });
  const b = await f.guard.act({ sessionId: 'session', observationId: a.observationId, action: { type: 'click', elementId: 'edit' } });
  return b.observation;
}
async function type(f) {
  const focused = await open(f);
  const result = await f.guard.act({ sessionId: 'session', observationId: focused.observationId, action: { type: 'type_text', text: payload } });
  return { focused, result };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('concurrent doctor/discovery/session requests dispatch once in FIFO order and await serialized evidence writes', async () => {
  const writing = deferred(), release = deferred(); let activeWrites = 0, maximumWrites = 0, writes = 0;
  const f = syntheticGuard({ beforeRecord: async () => {
    activeWrites++; maximumWrites = Math.max(maximumWrites, activeWrites);
    if (++writes === 1) { writing.resolve(); await release.promise; }
    await Promise.resolve(); activeWrites--;
  } });
  const doctor = f.guard.doctor(), list = f.guard.listWindows(), session = f.guard.openSession({ windowId: 'owned' });
  await writing.promise;
  assert.deepEqual(f.calls.map(call => call.name), ['doctor']);
  release.resolve();
  const results = await Promise.all([doctor, list, session]);
  assert.equal(results[0].ready, true); assert.equal(results[1].windows.length, 1); assert.equal(results[2].sessionId, 'session');
  assert.deepEqual(f.calls.map(call => call.name), ['doctor', 'list_windows', 'open_session']);
  assert.equal(maximumWrites, 1); assert.equal(f.guard.evidence.scopeViolations, 0);
  await f.guard.close();
});

test('queued mutation validates after the preceding operation and preserves the one real stale error without retry', async () => {
  const typing = deferred(), release = deferred();
  const f = syntheticGuard({ beforeCall: async (name, input) => {
    if (name === 'act' && input.action.type === 'type_text') { typing.resolve(); await release.promise; }
  } });
  const focused = await open(f);
  const typed = f.guard.act({ sessionId: 'session', observationId: focused.observationId, action: { type: 'type_text', text: payload } });
  await typing.promise;
  const stale = assert.rejects(f.guard.act({ sessionId: 'session', observationId: focused.observationId, action: { type: 'invoke', elementId: 'increment' } }), { code: 'stale_observation' });
  release.resolve(); await typed; await stale;
  assert.equal(f.guard.evidence.staleRejected, true); assert.equal(f.guard.evidence.independentStaleUnchanged, true);
  assert.equal(f.calls.filter(call => call.name === 'act').length, 3); // Focus, type, stale; no replay.
  assert.equal(f.app.count, 0); await f.guard.close();
});

test('unknown input completion blocks an already-queued mutator before another production dispatch', async () => {
  const f = syntheticGuard({ unknownType: true }), focused = await open(f);
  const input = { sessionId: 'session', observationId: focused.observationId, action: { type: 'type_text', text: payload } };
  const typed = f.guard.act(input), next = assert.rejects(f.guard.act(input), { code: 'acceptance_scope_rejected' });
  assert.equal((await typed).outcome, 'unknown'); await next;
  assert.equal(f.calls.filter(call => call.name === 'act').length, 2); await f.guard.close();
});

test('close fences queued input immediately, drains the actual operation and closes owned resources once', async () => {
  const started = deferred(), release = deferred();
  const f = syntheticGuard({ beforeCall: async name => { if (name === 'doctor') { started.resolve(); await release.promise; } } });
  const focused = await open(f), before = f.calls.length;
  const doctor = f.guard.doctor(); await started.promise;
  const input = { sessionId: 'session', observationId: focused.observationId, action: { type: 'type_text', text: payload } };
  const queued = assert.rejects(f.guard.act(input), { code: 'acceptance_guard_closing' });
  const observation = assert.rejects(f.guard.observe({ sessionId: 'session' }), { code: 'acceptance_guard_closing' });
  const close = f.guard.close(); assert.equal(f.guard.close(), close);
  await Promise.all([queued, observation]);
  await assert.rejects(f.guard.act(input), { code: 'acceptance_guard_closing' });
  assert.deepEqual(f.calls.slice(before).map(call => call.name), ['doctor']);
  release.resolve(); await doctor; await close;
  assert.deepEqual(f.calls.slice(before), [{ name: 'doctor', input: {} }, { name: 'close_session', input: { sessionId: 'session' } }, 'upstream-close']);
  assert.equal(f.app.text, ''); assert.equal(f.guard.evidence.guardClosed, true);
});

test('close before the dispatch microtask prevents the first admitted operation from starting', async () => {
  const f = syntheticGuard();
  const doctor = assert.rejects(f.guard.doctor(), { code: 'acceptance_guard_closing' });
  await f.guard.close(); await doctor;
  assert.deepEqual(f.calls, ['upstream-close']);
});

test('admission bound rejects overflow without dispatch or retry and releases slots after completion', async () => {
  const started = deferred(), release = deferred();
  const f = syntheticGuard({ beforeCall: async name => { if (name === 'doctor') { started.resolve(); await release.promise; } } });
  const admitted = [f.guard.doctor()]; await started.promise;
  for (let i = 1; i < MAX_GUARD_ADMISSIONS; i++) admitted.push(f.guard.listWindows());
  await assert.rejects(f.guard.listWindows(), { code: 'acceptance_queue_full' });
  assert.deepEqual(f.calls.map(call => call.name), ['doctor']);
  release.resolve(); await Promise.all(admitted);
  assert.equal(f.calls.filter(call => call.name === 'list_windows').length, MAX_GUARD_ADMISSIONS - 1);
  assert.equal(f.guard.evidence.scopeViolations, 0);
  await f.guard.listWindows(); assert.equal(f.calls.length, MAX_GUARD_ADMISSIONS + 1); await f.guard.close();
});

test('host plan is pure and explicitly partial; a corrective retry requires prior evidence and a change', async () => {
  assert.deepEqual(await run(parseArgs(['--plan'])), plan());
  assert.equal(plan().declaredBeforeHostOrUi, true); assert.match(plan().scope, /partial/);
  assert.ok(plan().notProven.includes('Semantic image comprehension'));
  for (const args of [['--live'], ['out', '--live', '--attempt', '2'], ['out', '--live', '--prior', 'old'], ['out', '--live', '--attempt', '3']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['out', '--live', '--attempt', '2', '--prior', 'old', '--change', 'Known prerequisite fixed']).attempt, 2);
});
test('guard filters unrelated windows and rejects all out-of-target/session actions before production input', async () => {
  const f = syntheticGuard(); const result = await f.guard.listWindows();
  assert.equal(result.windows.length, 1); assert.equal(JSON.stringify(result).includes('PRIVATE_UNRELATED_TITLE'), false);
  await assert.rejects(f.guard.openSession({ windowId: 'private' }), { code: 'acceptance_scope_rejected' });
  await f.guard.openSession({ windowId: 'owned' });
  await assert.rejects(f.guard.observe({ sessionId: 'other' }), { code: 'acceptance_scope_rejected' });
  assert.equal(f.calls.filter(c => c.name === 'observe').length, 0);
});
test('guard binds process lifetime and rejects mismatched generation before exposing a usable session', async () => {
  const f = syntheticGuard({ wrongGeneration: true }); await f.guard.listWindows();
  await assert.rejects(f.guard.openSession({ windowId: 'owned' }), { code: 'owned_session_identity_mismatch' });
  await assert.rejects(f.guard.observe({ sessionId: 'session' }), { code: 'acceptance_scope_rejected' });
  await assert.rejects(f.guard.act({ sessionId: 'session', observationId: 'anything', action: { type: 'type_text', text: payload } }), { code: 'acceptance_scope_rejected' });
  await f.guard.close();
  assert.ok(f.calls.some(call => call.name === 'close_session' && call.input.sessionId === 'session'));
  assert.equal(f.calls.some(call => call.name === 'observe' || call.name === 'act'), false);
  assert.equal(f.guard.evidence.guardClosed, true);
  const g = syntheticGuard(); await g.guard.listWindows(); g.target.processCreationTime = 'replacement-generation';
  await assert.rejects(g.guard.listWindows(), { code: 'owned_window_changed' });
});
test('guard preserves production frames and stale error, independently verifies no stale effect, then permits one fresh recovery', async () => {
  const f = syntheticGuard(); const { focused } = await type(f);
  await assert.rejects(f.guard.act({ sessionId: 'session', observationId: focused.observationId, action: { type: 'invoke', elementId: 'increment' } }), { code: 'stale_observation' });
  assert.equal(f.app.count, 0); assert.equal(f.guard.evidence.independentStaleUnchanged, true);
  const fresh = await f.guard.observe({ sessionId: 'session' });
  const invoked = await f.guard.act({ sessionId: 'session', observationId: fresh.observationId, action: { type: 'invoke', elementId: 'increment' } });
  assert.equal(invoked.observation.screenshot.data, 'synthetic-png'); assert.equal(f.app.count, 1);
  await f.guard.closeSession({ sessionId: 'session' }); await f.guard.close();
  assert.equal(f.guard.evidence.recovered, true); assert.equal(f.guard.evidence.sessionClosedByHost, true);
  assert.equal(f.guard.evidence.guardClosed, true); assert.equal(JSON.stringify(f.records).includes(payload), false);
});
test('guard prevents clipboard/coordinate/other literal/counter-before-stale and cross-session bypasses', async () => {
  const f = syntheticGuard(), focused = await open(f), before = f.calls.length;
  for (const action of [{ type: 'type_text', text: 'other' }, { type: 'press_key', key: 'CTRL+V' }, { type: 'click', x: 1, y: 2 }, { type: 'invoke', elementId: 'increment' }]) {
    await assert.rejects(f.guard.act({ sessionId: 'session', observationId: focused.observationId, action }), { code: 'acceptance_scope_rejected' });
  }
  assert.equal(f.calls.length, before);
});
test('unknown or lost production input is preserved and never permits another mutation', async () => {
  for (const options of [{ unknownType: true }, { lostType: true }]) {
    const f = syntheticGuard(options), focused = await open(f);
    const input = { sessionId: 'session', observationId: focused.observationId, action: { type: 'type_text', text: payload } };
    if (options.lostType) await assert.rejects(f.guard.act(input), { code: 'transport_uncertain' });
    else assert.equal((await f.guard.act(input)).outcome, 'unknown');
    const count = f.calls.length;
    await assert.rejects(f.guard.act(input), { code: 'acceptance_scope_rejected' }); assert.equal(f.calls.length, count);
    await f.guard.observe({ sessionId: 'session' }); await f.guard.close();
  }
});
test('focus ambiguity and unexpected stale errors stop mutation; mutated stale effect cannot be accepted', async () => {
  const focus = syntheticGuard({ wrongFocus: true }); await assert.rejects(open(focus), { code: 'owned_focus_unproven' });
  for (const options of [{ staleOtherError: 'native_timeout' }, { staleMutates: true }, { staleReadFails: true }]) {
    const f = syntheticGuard(options), { focused } = await type(f);
    const input = { sessionId: 'session', observationId: focused.observationId, action: { type: 'invoke', elementId: 'increment' } };
    await assert.rejects(f.guard.act(input), { code: options.staleMutates ? 'stale_effect_changed' : options.staleReadFails ? 'stale_read_unavailable' : 'native_timeout' });
    assert.equal(f.guard.evidence.staleRejected, false);
    const calls = f.calls.length;
    await assert.rejects(f.guard.act(input), { code: 'acceptance_scope_rejected' });
    assert.equal(f.calls.length, calls);
    await f.guard.close();
  }
});
test('guard drains upstream even if cleanup is uncertain and never changes unknown cleanup into success', async () => {
  const f = syntheticGuard({ closeUnknown: true }); await open(f);
  const close = f.guard.close(); assert.equal(f.guard.close(), close);
  await assert.rejects(close, { code: 'cleanup_unknown' });
  await assert.rejects(f.guard.close(), { code: 'cleanup_unknown' });
  assert.equal(f.calls.filter(call => call === 'upstream-close').length, 1); assert.equal(f.guard.evidence.guardClosed, false);
});

const reads = [path.resolve('synthetic-installed/references/readiness-routing.md'), path.resolve('synthetic-installed/references/operation-and-recovery.md')];
function event(block) { return { type: 'assistant', message: { content: [block] } }; }
function addCall(state, id, name, input, value = {}, content) {
  observeEvent(event({ type: 'tool_use', id, name, input }), state);
  observeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
    ...(value.error ? { is_error: true } : {}), content: content ?? [{ type: 'text', text: JSON.stringify(value) }] }] } }, state);
}
function hostEvidence() {
  const state = streamState({ allowedReads: reads });
  observeEvent({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'trace-acceptance', status: 'connected' }] }, state);
  addCall(state, 'skill', 'Skill', { skill: 'trace-computer-use' });
  reads.forEach((file, i) => addCall(state, `read-${i}`, 'Read', { file_path: file }));
  for (const name of ['doctor', 'list_windows', 'open_session', 'observe', 'act', 'close_session']) addCall(state, name, tool(name), {}, {},
    name === 'observe' ? [{ type: 'text', text: '{}' }, { type: 'image', source: { data: 'PRIVATE_SYNTHETIC_IMAGE' } }] : undefined);
  addCall(state, 'stale', tool('act'), {}, { error: { code: 'stale_observation', message: 'PRIVATE_ERROR_BODY' } });
  observeEvent({ type: 'result', is_error: false, num_turns: 12, permission_denials: [], result: 'PRIVATE_MODEL_PROSE' }, state);
  return summarize(state, 0);
}
test('host parser requires actual exact Skill invocation and scoped reads, correlated receipts and terminal result', () => {
  const host = hostEvidence();
  assert.equal(host.skillInvoked, true); assert.equal(host.connected, true); assert.equal(host.imagesReceived, 1);
  assert.deepEqual(host.referenceReads, ['operation-and-recovery.md', 'readiness-routing.md']);
  assert.equal(host.unmatchedToolResults, 0); assert.equal(host.violations, 0);
  for (const secret of ['PRIVATE_SYNTHETIC_IMAGE', 'PRIVATE_ERROR_BODY', 'PRIVATE_MODEL_PROSE']) assert.equal(JSON.stringify(host).includes(secret), false);
});
test('host parser rejects duplicate/unmatched IDs, wrong skills, out-of-bundle reads and unexpected tools', () => {
  const state = streamState({ allowedReads: reads });
  observeEvent(event({ type: 'tool_use', id: 'same', name: 'Skill', input: { skill: 'other' } }), state);
  observeEvent(event({ type: 'tool_use', id: 'same', name: 'Skill', input: { skill: 'trace-computer-use' } }), state);
  addCall(state, 'outside', 'Read', { file_path: path.resolve('private-credentials.json') });
  addCall(state, 'shell', 'Bash', { command: 'PRIVATE_COMMAND' });
  observeEvent(event({ type: 'tool_result', tool_use_id: 'unmatched', content: [] }), state);
  const result = summarize(state, 0);
  assert.ok(result.violations >= 5); assert.equal(result.skillInvoked, false); assert.equal(JSON.stringify(result).includes('PRIVATE_COMMAND'), false);
});
test('host parser rejects native mutation before successful Skill and both routing/recovery reads', () => {
  for (const early of ['open_session', 'observe', 'act', 'close_session']) {
    const state = streamState({ allowedReads: reads });
    addCall(state, 'doctor', tool('doctor'), {});
    addCall(state, 'discover', tool('list_windows'), {});
    assert.equal(state.violations, 0);
    addCall(state, 'early', tool(early), {});
    addCall(state, 'skill', 'Skill', { skill: 'trace-computer-use' });
    reads.forEach((file, index) => addCall(state, `late-read-${index}`, 'Read', { file_path: file }));
    assert.equal(state.violations, 1);
  }
  const pending = streamState({ allowedReads: reads });
  observeEvent(event({ type: 'tool_use', id: 'skill-pending', name: 'Skill', input: { skill: 'trace-computer-use' } }), pending);
  reads.forEach((file, index) => addCall(pending, `read-${index}`, 'Read', { file_path: file }));
  addCall(pending, 'open-before-skill-result', tool('open_session'), {});
  assert.equal(pending.violations, 1);
});
test('host cannot pass on prose, exit zero, nested unrelated envelopes, absent image or missing terminal result', () => {
  const host = hostEvidence(), guard = { scopeViolations: 0, typed: true, staleRejected: true, independentStaleUnchanged: true, recovered: true, sessionClosedByHost: true };
  assert.equal(completed(host, guard, { text: payload, count: 1 }, payload), true);
  for (const patch of [{ terminal: null }, { imagesReceived: 0 }, { skillInvoked: false }, { violations: 1 }, { receipts: [] }, { connected: false }]) assert.equal(completed({ ...host, ...patch }, guard, { text: payload, count: 1 }, payload), false);
  assert.equal(completed(host, { ...guard, independentStaleUnchanged: false }, { text: payload, count: 1 }, payload), false);
  assert.equal(completed(host, guard, { text: 'wrong', count: 1 }, payload), false);
  const state = streamState(); addCall(state, 'nested', tool('doctor'), {}, { unrelated: { error: { code: 'stale_observation' } } });
  assert.equal(summarize(state, 0).receipts[0].code, undefined);
});
test('CLI contract enables skill use, confines builtins, keeps exact MCP allowlist and strips API/provider overrides', () => {
  const home = path.resolve('synthetic-home'), args = hostArguments('private-config.json', home, 'private-settings.json');
  assert.equal(args[args.indexOf('--settings') + 1], 'private-settings.json');
  assert.throws(() => hostArguments('config', 'skill'), { code: 'host_hook_settings_required' });
  assert.equal(args[args.indexOf('--tools') + 1], 'Skill,Read'); assert.equal(args.includes('--disable-slash-commands'), false);
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--no-chrome']) assert.equal(args.includes(flag), true);
  assert.equal(args.includes('--restricted'), false);
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.equal(args[args.indexOf('--add-dir') + 1], home);
  assert.equal(args.includes('--dangerously-skip-permissions'), false); assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  const env = hostEnvironment({ ANTHROPIC_API_KEY: 'PRIVATE', ANTHROPIC_BASE_URL: 'PRIVATE', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: 'other', CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1', SAFE: 'yes' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined); assert.equal(env.CLAUDE_CONFIG_DIR, undefined); assert.equal(env.SAFE, 'yes');
  assert.equal(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, undefined);
  const isolated = path.resolve('synthetic-private-claude-config');
  assert.equal(hostEnvironment({ CLAUDE_CONFIG_DIR: 'inherited' }, { configDirectory: isolated }).CLAUDE_CONFIG_DIR, isolated);
  for (const directory of ['relative', path.parse(os.homedir()).root, os.homedir(), path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude/nested')]) {
    assert.throws(() => hostEnvironment({}, { configDirectory: directory }), { code: 'claude_configuration_directory_invalid' });
  }
});

test('private settings snapshots distinguish JSON formatting, semantic changes, unknown keys and missing files without leaking values', async () => {
  let values = { '.claude.json': '{"projects":{"PRIVATE_PATH":{"lastCost":3}},"model":"PRIVATE_MODEL"}', '.claude/settings.json': '{"env":{"PRIVATE_SECRET":"SECRET_VALUE"}}' };
  const io = { readFile: async file => {
    const relative = path.relative(path.resolve('synthetic-home'), file).replaceAll('\\', '/');
    if (!Object.hasOwn(values, relative)) throw Object.assign(new Error(), { code: 'ENOENT' });
    return Buffer.from(values[relative]);
  } };
  const before = await fingerprintSettings(path.resolve('synthetic-home'), io);
  values['.claude.json'] = '{ "model": "PRIVATE_MODEL", "projects": { "PRIVATE_PATH": { "lastCost": 3 } } }';
  let result = compareSettings(before, await fingerprintSettings(path.resolve('synthetic-home'), io));
  assert.equal(result.preserved, true); assert.equal(result.changes[0].kind, 'formatting_only');
  values['.claude.json'] = '{"projects":{"PRIVATE_PATH":{"lastCost":4}},"model":"PRIVATE_MODEL","PRIVATE_KEY":"PRIVATE_VALUE"}';
  result = compareSettings(before, await fingerprintSettings(path.resolve('synthetic-home'), io));
  assert.equal(result.preserved, false);
  assert.deepEqual(result.changes[0].keys, [{ key: 'projects', beforeType: 'object', afterType: 'object' }, { key: 'unrecognized_key', beforeType: 'missing', afterType: 'string' }]);
  for (const secret of ['PRIVATE_PATH', 'PRIVATE_MODEL', 'PRIVATE_SECRET', 'SECRET_VALUE', 'PRIVATE_KEY', 'PRIVATE_VALUE', 'lastCost']) assert.equal(JSON.stringify(result).includes(secret), false);
  values['.claude/settings.json'] = 'malformed PRIVATE';
  result = compareSettings(before, await fingerprintSettings(path.resolve('synthetic-home'), io));
  assert.equal(result.preserved, false); assert.equal(result.changes[1].after, 'unparseable');
  delete values['.claude/settings.json'];
  assert.equal(compareSettings(before, await fingerprintSettings(path.resolve('synthetic-home'), io)).changes[1].after, 'missing');
  values['.claude/settings.json'] = Buffer.from([0x7B, 0x22, 0x61, 0x22, 0x3A, 0x22, 0xC3, 0x22, 0x7D]);
  assert.equal(compareSettings(before, await fingerprintSettings(path.resolve('synthetic-home'), io)).changes[1].after, 'unparseable');
});

test('private changed-key paths keep depth-2 (depth-3 under projects) names without values and skip formatting-only sources', async () => {
  let values = { '.claude.json': '{"projects":{"PATH_A":{"n":1},"PATH_B":{"n":1}},"numStartups":1,"keep":"SECRET_VALUE"}', '.claude/settings.json': '{"a":1}' };
  const io = { readFile: async file => {
    const relative = path.relative(path.resolve('synthetic-home'), file).replaceAll('\\', '/');
    if (!Object.hasOwn(values, relative)) throw Object.assign(new Error(), { code: 'ENOENT' });
    return Buffer.from(values[relative]);
  } };
  const before = await fingerprintSettings(path.resolve('synthetic-home'), io);
  values = { '.claude.json': '{"projects":{"PATH_A":{"n":2},"PATH_B":{"n":1}},"numStartups":2,"keep":"SECRET_VALUE","added":{"x":"NEW_VALUE"}}', '.claude/settings.json': '{ "a": 1 }' };
  const paths = changedKeyPaths(before, await fingerprintSettings(path.resolve('synthetic-home'), io));
  assert.deepEqual(paths, [{ source: 'clientState', path: ['added'] }, { source: 'clientState', path: ['numStartups'] }, { source: 'clientState', path: ['projects', 'PATH_A', 'n'] }]);
  for (const value of ['SECRET_VALUE', 'NEW_VALUE', 'PATH_B']) assert.equal(JSON.stringify(paths).includes(value), false);
  // A new project entry is compared against an empty one; a non-object project value stays at depth 2.
  values['.claude.json'] = '{"projects":{"PATH_A":{"n":1},"PATH_B":{"n":1},"PATH_C":{"lastCost":1,"m":{"deep":"DEEP_VALUE"}},"PATH_D":5},"numStartups":1,"keep":"SECRET_VALUE"}';
  const added = changedKeyPaths(before, await fingerprintSettings(path.resolve('synthetic-home'), io));
  assert.deepEqual(added, [{ source: 'clientState', path: ['projects', 'PATH_C', 'lastCost'] }, { source: 'clientState', path: ['projects', 'PATH_C', 'm'] },
    { source: 'clientState', path: ['projects', 'PATH_D'] }]);
  assert.equal(JSON.stringify(added).includes('DEEP_VALUE'), false);
  values['.claude/settings.json'] = 'malformed';
  assert.deepEqual(changedKeyPaths(before, await fingerprintSettings(path.resolve('synthetic-home'), io)).at(-1), { source: 'userSettings', path: [], whole: true });
});

test('Claude process enumeration parses one, many or none and rejects malformed identities', async () => {
  const exec = stdout => async (file, args) => { assert.equal(file, 'powershell.exe'); assert.ok(args.includes('-NonInteractive')); return { stdout }; };
  assert.deepEqual(await listClaudeProcesses(exec('')), []);
  assert.deepEqual(await listClaudeProcesses(exec('{"pid":7,"created":"2026-10-22T10:00:00.0000000Z"}')), [{ pid: 7, created: '2026-10-22T10:00:00.0000000Z' }]);
  assert.equal((await listClaudeProcesses(exec('[{"pid":7,"created":"a"},{"pid":8,"created":"b"}]'))).length, 2);
  await assert.rejects(listClaudeProcesses(exec('[{"pid":0,"created":"a"}]')), { code: 'claude_process_enumeration_invalid' });
  await assert.rejects(listClaudeProcesses(exec('{"pid":7}')), { code: 'claude_process_enumeration_invalid' });
});

test('empty project additions and deletions retain private project identity without values', async () => {
  let value = { projects: {} };
  const io = { readFile: async file => {
    if (path.basename(file) !== '.claude.json') throw Object.assign(new Error(), { code: 'ENOENT' });
    return Buffer.from(JSON.stringify(value));
  } };
  const before = await fingerprintSettings(path.resolve('synthetic-home'), io);
  value = { projects: { PRIVATE_PROJECT: {} } };
  const after = await fingerprintSettings(path.resolve('synthetic-home'), io);
  const expected = [{ source: 'clientState', path: ['projects', 'PRIVATE_PROJECT'] }];
  assert.deepEqual(changedKeyPaths(before, after), expected);
  assert.deepEqual(changedKeyPaths(after, before), expected);
  assert.equal(compareSettings(before, after).preserved, false);
  assert.equal(JSON.stringify(compareSettings(before, after)).includes('PRIVATE_PROJECT'), false);
});

function cleanTerminalReceipt() {
  return { status: 'pass', cleanup: { confirmed: true }, userSettingsUnchanged: true,
    settingsComparison: { preserved: true },
    settingsIntervals: Object.fromEntries(['hostProbes', 'preHost', 'host', 'postHost'].map(name => [name, { preserved: true }])),
    settingsWriterExclusion: { exclusive: true, samples: 2, sampleFailures: 0, unownedProcesses: 0 } };
}

test('terminal oracle blocks writer contamination, unavailable enumeration and missing interval evidence', () => {
  assert.equal(terminalHostStatus(cleanTerminalReceipt()), 'pass');
  for (const writer of [undefined, { exclusive: false, samples: 2, sampleFailures: 0, unownedProcesses: 1 },
    { exclusive: false, samples: 1, sampleFailures: 1, unownedProcesses: 0 },
    { exclusive: true, samples: 0, sampleFailures: 0, unownedProcesses: 0 },
    { exclusive: true, samples: 2, sampleFailures: 1, unownedProcesses: 0 },
    { exclusive: true, samples: 2, sampleFailures: 0, unownedProcesses: 1 }]) {
    const receipt = cleanTerminalReceipt(); receipt.settingsWriterExclusion = writer;
    assert.equal(terminalHostStatus(receipt), 'blocked');
  }
  for (const name of ['hostProbes', 'preHost', 'host', 'postHost']) {
    const receipt = cleanTerminalReceipt(); delete receipt.settingsIntervals[name];
    assert.equal(terminalHostStatus(receipt), 'blocked');
    receipt.settingsIntervals[name] = { preserved: false };
    assert.equal(terminalHostStatus(receipt), 'blocked');
  }
  const unknownCleanup = cleanTerminalReceipt(); unknownCleanup.cleanup.confirmed = false;
  assert.equal(terminalHostStatus(unknownCleanup), 'blocked');
  const historicalBlock = cleanTerminalReceipt(); historicalBlock.status = 'blocked';
  assert.equal(terminalHostStatus(historicalBlock), 'blocked');
});

test('reverted semantic writes remain blocking and retain all private interval paths', async t => {
  let value = { numStartups: 1, PRIVATE_KEY: 'SECRET_VALUE' };
  const io = { readFile: async file => {
    if (path.basename(file) !== '.claude.json') throw Object.assign(new Error(), { code: 'ENOENT' });
    return Buffer.from(JSON.stringify(value));
  } };
  const before = await fingerprintSettings(path.resolve('synthetic-home'), io);
  value = { numStartups: 2, PRIVATE_KEY: 'OTHER_SECRET' };
  const hostAfter = await fingerprintSettings(path.resolve('synthetic-home'), io);
  const final = before;
  const receipt = cleanTerminalReceipt();
  receipt.settingsComparison = compareSettings(before, final);
  receipt.settingsIntervals.host = compareSettings(before, hostAfter);
  receipt.settingsIntervals.postHost = compareSettings(hostAfter, final);
  assert.equal(receipt.settingsComparison.preserved, true);
  assert.equal(terminalHostStatus(receipt), 'blocked');
  const intervals = privateSettingsIntervals({ before, probed: before, hostBefore: before, hostAfter, final });
  assert.deepEqual(intervals.overall, []);
  for (const name of ['host', 'postHost']) assert.ok(intervals[name].some(item => item.path[0] === 'PRIVATE_KEY'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-reverted-diff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await writePrivateSettingsDiff(path.join(root, 'evidence/attempt'), intervals, root);
  assert.equal(result.count, 4);
  const bytes = await fs.readFile(path.join(root, '.runtime/claude-host/attempt/private-settings-diff.json'), 'utf8');
  assert.ok(bytes.includes('PRIVATE_KEY'));
  for (const secret of ['SECRET_VALUE', 'OTHER_SECRET']) assert.equal(bytes.includes(secret), false);
  assert.equal(JSON.stringify({ result, receipt }).includes('PRIVATE_KEY'), false);
  // Even if the terminal read fails, already observed changes remain available privately.
  assert.deepEqual(privateSettingsIntervals({ before, probed: before, hostBefore: before, hostAfter }).host, intervals.host);
});

test('managed settings join every fingerprint and semantic changes block without leaking private names or values', async () => {
  const home = path.resolve('synthetic-home'), managed = path.resolve('synthetic-policy/managed-settings.json');
  let bytes = Buffer.from('{"PRIVATE_POLICY":"SECRET_VALUE"}');
  const io = { readFile: async file => {
    if (file !== managed) throw Object.assign(new Error(), { code: 'ENOENT' });
    if (bytes === null) throw Object.assign(new Error(), { code: 'ENOENT' });
    return bytes;
  } };
  const before = await fingerprintSettings(home, io, managed);
  bytes = Buffer.from('{ "PRIVATE_POLICY": "SECRET_VALUE" }');
  assert.equal(compareSettings(before, await fingerprintSettings(home, io, managed)).preserved, true);
  bytes = Buffer.from('{"PRIVATE_POLICY":"CHANGED_SECRET"}');
  const after = await fingerprintSettings(home, io, managed), comparison = compareSettings(before, after);
  assert.equal(comparison.preserved, false); assert.equal(comparison.changes[0].source, 'managedSettings');
  assert.deepEqual(changedKeyPaths(before, after), [{ source: 'managedSettings', path: ['PRIVATE_POLICY'] }]);
  const receipt = cleanTerminalReceipt(); receipt.settingsIntervals.host = comparison;
  assert.equal(terminalHostStatus(receipt), 'blocked');
  for (const secret of ['PRIVATE_POLICY', 'SECRET_VALUE', 'CHANGED_SECRET']) assert.equal(JSON.stringify(comparison).includes(secret), false);
  bytes = null;
  assert.equal(compareSettings(before, await fingerprintSettings(home, io, managed)).changes[0].after, 'missing');
  bytes = Buffer.from('invalid');
  assert.equal(compareSettings(before, await fingerprintSettings(home, io, managed)).changes[0].after, 'unparseable');
});

test('writer monitor excludes only the pinned host generation and fails closed on others, errors or no samples', async () => {
  const monitorWith = sequence => { let index = 0; return createWriterMonitor({ list: async () => { const next = sequence[Math.min(index++, sequence.length - 1)]; if (next instanceof Error) throw next; return next; } }); };
  assert.equal(createWriterMonitor({ list: async () => [] }).result().exclusive, false); // No sample is no proof.
  let monitor = monitorWith([[{ pid: 9, created: 'h' }], []]);
  monitor.own(9); await monitor.sample(); await monitor.sample();
  assert.deepEqual({ ...monitor.result(), scope: undefined }, { exclusive: true, unownedProcesses: 0, samples: 2, sampleFailures: 0, scope: undefined });
  monitor = monitorWith([[{ pid: 9, created: 'h' }], [{ pid: 9, created: 'reused' }]]);
  monitor.own(9); await monitor.sample(); await monitor.sample();
  assert.equal(monitor.result().exclusive, false); assert.equal(monitor.result().unownedProcesses, 1);
  monitor = monitorWith([[{ pid: 9, created: 'h' }, { pid: 4, created: 'other' }]]);
  monitor.own(9); await monitor.sample();
  assert.equal(monitor.result().exclusive, false);
  monitor = monitorWith([[], new Error('query failed')]);
  monitor.own(9); await monitor.sample(); await monitor.sample();
  assert.equal(monitor.result().exclusive, false); assert.equal(monitor.result().sampleFailures, 1);
  monitor = monitorWith([[]]);
  monitor.own(undefined); await monitor.sample();
  assert.equal(monitor.result().exclusive, false); // Missing host identity is a failure, not an exclusion.
  monitor = monitorWith([[]]); monitor.own(9); monitor.own(10); await monitor.sample();
  assert.equal(monitor.result().exclusive, false);
  monitor = createWriterMonitor({ list: async () => [], intervalMs: 5 });
  monitor.own(9); monitor.start(); await new Promise(resolve => setTimeout(resolve, 30)); await monitor.stop();
  const samples = monitor.result().samples; assert.ok(samples > 0);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(monitor.result().samples, samples); // Stopped means stopped.
});

test('private settings diff lands only under ignored .runtime with exclusive create, and returns hash and count', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-private-diff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const intervals = { overall: [{ source: 'clientState', path: ['PRIVATE_KEY'] }], host: [] };
  const result = await writePrivateSettingsDiff(path.join(root, 'evidence', 'attempt-3'), intervals, root);
  const bytes = await fs.readFile(path.join(root, '.runtime', 'claude-host', 'attempt-3', 'private-settings-diff.json'));
  assert.deepEqual(result, { sha256: createHash('sha256').update(bytes).digest('hex'), count: 1 });
  assert.equal(JSON.stringify(result).includes('PRIVATE_KEY'), false);
  await assert.rejects(writePrivateSettingsDiff(path.join(root, 'evidence', 'attempt-3'), intervals, root), { code: 'EEXIST' });
});

test('startup preflight inspects ordinary plugin metadata, skips unrelated links and blocks unexpected managed hooks/plugins', async t => {
  const { directory, installed } = await bundleFixture(t), home = path.join(directory, 'home'), cwd = path.join(directory, 'workspace');
  await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true }); await fs.mkdir(cwd);
  await fs.cp(installed, path.join(home, '.claude/skills/trace-computer-use'), { recursive: true });
  await fs.symlink(path.join(directory, 'absent-target'), path.join(home, '.claude/skills/unrelated'), 'junction');
  // Ignored user source may contain the already-authorized second-brain hook.
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'PRIVATE_SECOND_BRAIN' }] }] } }));
  const io = { ...fs, lstat: async file => { assert.equal(file.includes('absent-target'), false); return fs.lstat(file); }, readFile: async file => {
    assert.notEqual(file, path.join(home, '.claude/settings.json')); return fs.readFile(file);
  } };
  const options = { home, cwd, managedFiles: [] };
  assert.equal((await preflightStartup(options, io)).skippedReparseEntries, 1);
  const configDirectory = path.join(directory, 'isolated-config'); await fs.mkdir(configDirectory);
  assert.equal((await preflightStartup({ ...options, configDirectory }, io)).isolatedConfiguration, true);
  await fs.mkdir(path.join(configDirectory, 'skills'));
  await fs.writeFile(path.join(configDirectory, 'skills/shadow.md'), 'unexpected');
  await assert.rejects(preflightStartup({ ...options, configDirectory }, io), { code: 'claude_isolated_startup_content' });
  const linkedConfig = path.join(directory, 'linked-config'); await fs.symlink(configDirectory, linkedConfig, 'junction');
  await assert.rejects(preflightStartup({ ...options, configDirectory: linkedConfig }, io), { code: 'claude_configuration_directory_unsafe' });
  const managed = path.join(directory, 'managed.json');
  for (const value of [{ hooks: { SessionStart: [{}] } }, { enabledPlugins: { private: true } }]) {
    await fs.writeFile(managed, JSON.stringify(value));
    await assert.rejects(preflightStartup({ ...options, managedFiles: [managed] }, io), { code: value.hooks ? 'claude_unexpected_startup_hooks' : 'claude_unexpected_startup_plugins' });
  }
  await fs.mkdir(path.join(home, '.claude/skills/trace-computer-use/.claude-plugin'));
  await fs.writeFile(path.join(home, '.claude/skills/trace-computer-use/.claude-plugin/plugin.json'), '{}');
  await assert.rejects(preflightStartup(options, io), { code: 'claude_unexpected_skill_plugin' });
  await fs.writeFile(path.join(cwd, 'unexpected.json'), '{}');
  await assert.rejects(preflightStartup(options, io), { code: 'claude_workspace_not_empty' });
});

test('failed Skill and Read receipts retain fixed diagnostic categories without raw content or model prose', () => {
  const state = streamState({ allowedReads: reads });
  for (const [id, name, input, message] of [
    ['missing', 'Skill', { skill: 'trace-computer-use' }, 'Unknown skill PRIVATE_NAME'],
    ['denied', 'Read', { file_path: reads[0] }, 'Permission denied PRIVATE_PATH'],
    ['absent', 'Read', { file_path: reads[0] }, 'ENOENT PRIVATE_PATH'],
    ['other', 'Skill', { skill: 'trace-computer-use' }, 'PRIVATE_UNCLASSIFIED'],
  ]) {
    observeEvent(event({ type: 'tool_use', id, name, input }), state);
    observeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: message }] } }, state);
  }
  const result = summarize(state, 0);
  assert.deepEqual(result.toolFailures.map(item => item.category), ['skill_not_found', 'permission_denied', 'read_not_found', 'tool_error_unclassified']);
  assert.equal(result.skillInvoked, false); assert.deepEqual(result.referenceReads, []); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  // A structured error must not become a successful invocation if is_error is absent.
  const noFlag = streamState({ allowedReads: reads });
  observeEvent(event({ type: 'tool_use', id: 'no-flag', name: 'Skill', input: { skill: 'trace-computer-use' } }), noFlag);
  observeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'no-flag', structuredContent: { error: { code: 'PRIVATE' } } }] } }, noFlag);
  assert.equal(summarize(noFlag, 0).skillInvoked, false);
  assert.deepEqual(summarize(noFlag, 0).toolFailures, [{ tool: 'Skill', category: 'tool_error_unclassified' }]);
});
test('private pre-execution hook denies unexpected tools, sibling/traversal reads and changed file identities before dispatch', async () => {
  const selected = reads[0], policy = { allowedReads: reads, realReads: Object.fromEntries(reads.map(file => [file, file])) };
  let inspections = 0, dispatches = 0;
  const inspect = { lstat: async () => { inspections++; return { isFile: () => true, isSymbolicLink: () => false }; }, realpath: async file => file };
  const check = async (name, input, options = inspect) => {
    const allowed = await hostToolAllowed({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input }, policy, options);
    if (allowed) dispatches++;
    return allowed;
  };
  for (const [name, input] of [
    ['Bash', { command: 'PRIVATE_COMMAND' }], ['Skill', { skill: 'other' }], ['Skill', { skill: 'trace-computer-use', args: 'extra' }],
    ['Read', { file_path: path.join(path.dirname(selected), 'private.md') }],
    ['Read', { file_path: path.dirname(selected) + '/../references/' + path.basename(selected) }],
    ['Read', { file_path: path.join(path.dirname(selected), 'PRIVATE.md').toUpperCase() }],
    ['Read', { file_path: path.basename(selected) }], ['mcp__other__trace_computer_act', {}],
  ]) assert.equal(await check(name, input), false);
  assert.equal(inspections, 0); assert.equal(dispatches, 0);
  assert.equal(await check('Read', { file_path: selected }, { ...inspect, realpath: async () => path.join(os.tmpdir(), 'other-file') }), false);
  assert.equal(await check('Read', { file_path: selected }, { ...inspect, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }) }), false);
  assert.equal(dispatches, 0);
  assert.equal(await check('Read', { file_path: selected }), true);
  assert.equal(await check('Read', { file_path: selected.toUpperCase() }), true);
  assert.equal(await check('Skill', { skill: 'trace-computer-use' }), true);
  assert.equal(await check(tool('observe'), { sessionId: 'owned' }), true);
  assert.equal(dispatches, 4);
  const windowsPath = 'C:\\Owned\\Skill\\references\\readiness-routing.md';
  assert.equal(scopedReadPath(windowsPath.toUpperCase(), [windowsPath], path.win32), windowsPath);
  for (const value of ['C:\\Owned\\Skill-private\\references\\readiness-routing.md',
    'C:\\Owned\\Skill\\references\\..\\references\\readiness-routing.md', 'C:readiness-routing.md']) {
    assert.equal(scopedReadPath(value, [windowsPath], path.win32), null);
  }
});
test('hook entry returns only sanitized allow/deny and malformed policy/input cannot authorize a tool', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-host-hook-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const policyFile = path.join(directory, 'policy.json'), allowed = path.join(directory, 'allowed.md');
  await fs.writeFile(allowed, 'synthetic');
  await fs.writeFile(policyFile, JSON.stringify({ allowedReads: [allowed], realReads: { [allowed]: await fs.realpath(allowed) } }));
  const result = async (raw, policy = policyFile) => {
    let output = '';
    await runHostHook(policy, Readable.from([raw]), { write: value => { output += value; } });
    assert.equal(output.includes('PRIVATE'), false);
    return JSON.parse(output).hookSpecificOutput.permissionDecision;
  };
  assert.equal(await result(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: allowed } })), 'allow');
  assert.equal(await result(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'PRIVATE_COMMAND' } })), 'deny');
  assert.equal(await result('PRIVATE_MALFORMED_JSON'), 'deny');
  assert.equal(await result('x'.repeat(65537)), 'deny');
  assert.equal(await result('{}', path.join(directory, 'missing-policy.json')), 'deny');
  const hook = hostSettings(policyFile).hooks.PreToolUse[0];
  assert.equal(hook.matcher, '*'); assert.equal(hook.hooks[0].onFailure, 'block');
  assert.equal(hook.hooks[0].command, process.execPath);
  assert.deepEqual(hook.hooks[0].args.slice(1), ['--host-hook', policyFile]);
  assert.equal(hook.hooks[0].timeout, 10);
  for (const version of ['2.1.295', '2.1.300', '2.2.0', '3.0.0']) assert.equal(supportedHostVersion(version), true);
  for (const version of ['2.1.294', '2.0.999', '1.99.999', 'bad']) assert.equal(supportedHostVersion(version), false);
});
test('host runner uses a retained child handle, stdin prompt and bounded in-memory stream with no actual Claude call', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 42;
  let prompt, killed = false, captured;
  child.stdin = new Writable({ write(chunk, _encoding, done) { prompt = chunk.toString(); done(); }, final(done) {
    queueMicrotask(() => { child.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'PRIVATE_MODEL_PROSE' }) + '\n'); child.emit('close', 0); }); done(); } });
  child.kill = () => { killed = true; child.emit('close', 1); };
  const configDirectory = path.resolve('synthetic-private-claude-config');
  const output = await invokeHost({ config: 'config', cwd: 'empty-workspace', skillDirectory: 'installed-skill', settings: 'private-settings', configDirectory, prompt: 'PRIVATE_PROMPT',
    allowedReads: reads, spawnImpl: (exe, args, options) => { captured = { exe, args, options }; return child; } });
  assert.equal(captured.options.env.CLAUDE_CONFIG_DIR, configDirectory);
  assert.equal(prompt, 'PRIVATE_PROMPT'); assert.equal(JSON.stringify(captured).includes('PRIVATE_PROMPT'), false);
  assert.equal(captured.options.shell, false); assert.equal(killed, false); assert.equal(output.connected, false);
  assert.equal(JSON.stringify(output).includes('PRIVATE_MODEL_PROSE'), false);
});

const hash = value => createHash('sha256').update(value).digest('hex');
const continuationDecision = 'evidence/live-acceptance-continuation/owner-decision.json';
const supplementalArgs = ['--continuation-decision', continuationDecision, '--continuation-attempt', '1'];

test('supplemental CLI preserves original identity and ordinals; exhausted legacy live runs stop before I/O', async () => {
  const options = parseArgs(['--plan', ...supplementalArgs]);
  assert.equal(options.attempt, undefined);
  const declared = await run(options);
  assert.equal(declared.caseId, 'CLAUDE-TRACE-SKILL-NATIVE');
  assert.equal(declared.continuation.contract, 'claude-queued-host-settings-v1');
  assert.equal(declared.historicalAttemptsUsed, 2); assert.equal(declared.lifetimeAttemptOrdinal, 3);
  assert.equal(declared.continuation.originals.length, 2);
  for (const args of [ [...supplementalArgs, '--attempt', '1'], [...supplementalArgs, '--prior', 'evidence/old.json'],
    ['--continuation-decision', continuationDecision, '--continuation-attempt', '3'],
    ['--continuation-decision', continuationDecision, '--continuation-attempt', '2'] ]) {
    assert.throws(() => parseArgs(args));
  }
  const correction = parseArgs(['--live', 'unused-output', '--continuation-decision', continuationDecision,
    '--continuation-attempt', '2', '--prior', 'evidence/claude-supplemental-1/receipt.json', '--change', 'Reviewed queue correction']);
  assert.equal(plan(correction).lifetimeAttemptOrdinal, 4);
  await assert.rejects(run({ mode: 'live', attempt: 1 }), { code: 'historical_attempt_budget_exhausted' });
  await assert.rejects(run({ mode: 'live', attempt: 2 }), { code: 'historical_attempt_budget_exhausted' });
});

test('continuation adapter performs readiness before its injected claim and forwards exact bounded identity', async () => {
  const root = path.resolve('synthetic-root'), events = [], claims = [];
  const io = { realpath: async file => file, readFile: async () => Buffer.from('synthetic decision') };
  const keeper = { claim: async value => { events.push('claim'); claims.push(value); return { claimId: 'synthetic-claim' }; } };
  const options = parseArgs(supplementalArgs);
  const result = await prepareAndClaimContinuation(options, async () => { events.push('preflight'); return 'prepared-executable'; }, { root, io, keeper });
  assert.deepEqual(events, ['preflight', 'claim']); assert.equal(result.prepared, 'prepared-executable');
  assert.equal(claims[0].contract, 'claude-queued-host-settings-v1'); assert.equal(claims[0].lifetimeAttemptOrdinal, 3);
  assert.equal(claims[0].decision.sha256, hash('synthetic decision')); assert.equal(claims[0].originals.length, 2);
  assert.equal(claims[0].continuationAttempt, 1); assert.equal(claims[0].historicalAttemptsUsed, 2);
  await assert.rejects(prepareAndClaimContinuation(options, async () => { throw error('readiness_failed'); }, { root, io, keeper }), { code: 'readiness_failed' });
  assert.equal(claims.length, 1);
  const rejectingKeeper = { claim: async () => { throw error('budget_exhausted'); } };
  await assert.rejects(prepareAndClaimContinuation(options, async () => 'ready', { root, io, keeper: rejectingKeeper }), { code: 'budget_exhausted' });
  const corrective = { ...options, continuationAttempt: 2, prior: 'evidence/claude-supplemental-1/receipt.json', change: 'Reviewed queue correction' };
  await prepareAndClaimContinuation(corrective, async () => 'ready', { root, io, keeper });
  assert.equal(claims[1].lifetimeAttemptOrdinal, 4); assert.equal(claims[1].changedPrecondition, corrective.change);
  assert.equal(claims[1].prior.ref, corrective.prior);
});

function ordinaryMemoryFiles(files) {
  return { realpath: async file => file, lstat: async file => ({ isSymbolicLink: () => false,
    isDirectory: () => !files.has(file), isFile: () => files.has(file) }),
    readFile: async file => { assert.ok(files.has(file), 'only explicitly prepared files may be read'); return files.get(file); } };
}

test('prepared fixture is read-only and pins every source/output without rebuilding the live anchor', async () => {
  const root = path.resolve('synthetic-fixture-root'), folder = path.join(root, '.runtime/computer-fixture'), files = new Map();
  const manifest = { schemaVersion: 1, uiCreated: 0, inputActions: 0, sources: {}, files: {} };
  for (const relative of ['tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj', 'scripts/smoke-computer-live.cjs']) {
    files.set(path.join(root, relative), Buffer.from(relative)); manifest.sources[relative] = hash(relative);
  }
  for (const name of ['TraceComputerFixture.exe', 'TraceComputerFixture.dll', 'TraceComputerFixture.runtimeconfig.json', 'TraceComputerFixture.deps.json']) {
    files.set(path.join(folder, 'bin', name), Buffer.from(name)); manifest.files[name] = hash(name);
  }
  const manifestFile = path.join(folder, 'prepared-manifest.json');
  files.set(manifestFile, Buffer.from(JSON.stringify(manifest)));
  const io = ordinaryMemoryFiles(files), prepared = await preparedFixture(root, io);
  assert.equal(prepared.executable, path.join(folder, 'bin/TraceComputerFixture.exe'));
  files.set(prepared.executable, Buffer.from('changed-output'));
  await assert.rejects(preparedFixture(root, io), { code: 'claude_fixture_setup_stale' });
  manifest.uiCreated = 1; files.set(manifestFile, Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(preparedFixture(root, io), { code: 'claude_fixture_setup_invalid' });
});

test('installed REA instruction validates exact name and hash and scoped hooks reject instruction drift', async () => {
  const home = path.resolve('synthetic-home'), selected = path.join(home, '.claude/skills/reverse-engineer-anything/SKILL.md');
  const bytes = Buffer.from('---\nname: reverse-engineer-anything\n---\nInstruction discovery only.');
  const files = new Map([[selected, bytes]]), io = ordinaryMemoryFiles(files);
  const rea = await loadReaInstructions(home, io);
  assert.equal(rea.sha256, hash(bytes)); assert.equal(rea.path, selected);
  const policy = { allowedReads: [selected], realReads: { [selected]: selected }, allowedSkills: ['trace-computer-use', 'reverse-engineer-anything'],
    reaInstructionPath: selected, sha256Reads: { [selected]: rea.sha256 } };
  const skill = { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'reverse-engineer-anything' } };
  assert.equal(await hostToolAllowed(skill, policy, io), true);
  assert.equal(await hostToolAllowed({ ...skill, tool_name: 'Read', tool_input: { file_path: selected, offset: 99999 } }, policy, io), false);
  assert.equal(await hostToolAllowed({ ...skill, tool_name: 'mcp__rea__analyze' }, policy, io), false);
  files.set(selected, Buffer.from('---\nname: other\n---\nChanged'));
  assert.equal(await hostToolAllowed(skill, policy, io), false);
  await assert.rejects(loadReaInstructions(home, io), { code: 'installed_rea_instruction_invalid' });
  assert.equal(hostSettings('private-policy', true).disableSkillShellExecution, true);
  const args = hostArguments('config', home, 'settings', policy.allowedSkills);
  assert.ok(args[args.indexOf('--allowedTools') + 1].includes('Skill(reverse-engineer-anything)'));
  const tracePolicy = { ...policy, traceInstructionPath: selected };
  assert.equal(await hostToolAllowed({ ...skill, tool_input: { skill: 'trace-computer-use' } }, tracePolicy, io), false);
});

test('actual successful REA Skill and exact instruction Read are independently required before supplemental mutation', () => {
  const rea = path.resolve('synthetic-home/.claude/skills/reverse-engineer-anything/SKILL.md');
  const config = { allowedReads: [...reads, rea], requiredSkills: ['trace-computer-use', 'reverse-engineer-anything'], reaInstructionPath: rea };
  for (const missing of ['skill', 'read', 'none']) {
    const state = streamState(config);
    addCall(state, 'trace', 'Skill', { skill: 'trace-computer-use' });
    reads.forEach((file, index) => addCall(state, `read-${index}`, 'Read', { file_path: file }));
    if (missing !== 'skill') addCall(state, 'rea', 'Skill', { skill: 'reverse-engineer-anything' });
    if (missing !== 'read') addCall(state, 'rea-read', 'Read', { file_path: rea });
    addCall(state, 'open', tool('open_session'), {});
    assert.equal(state.violations, missing === 'none' ? 0 : 1);
    assert.equal(summarize(state, 0).reaInstructionsRead, missing !== 'read');
  }
  const truncated = streamState(config);
  addCall(truncated, 'offset', 'Read', { file_path: rea, offset: 99999 });
  assert.equal(truncated.reaInstructionsRead, false); assert.equal(truncated.violations, 1);
});

test('independent focus mismatch blocks typing before production and fences already queued input', async () => {
  const f = syntheticGuard({ independentFocusWrong: true }), observation = await open(f);
  const before = f.calls.length;
  const input = { sessionId: 'session', observationId: observation.observationId, action: { type: 'type_text', text: payload } };
  const results = await Promise.allSettled([f.guard.act(input), f.guard.act(input)]);
  assert.deepEqual(results.map(result => result.reason.code), ['owned_independent_focus_unproven', 'acceptance_scope_rejected']);
  assert.equal(f.calls.length, before); assert.equal(f.app.text, '');
  await f.guard.close();
});

test('terminal source verification detects source or host executable drift with read-only injected I/O', async () => {
  const root = path.resolve('synthetic-root'), executable = path.resolve('synthetic-claude.exe'), relative = 'scripts/accept-claude-host.cjs';
  const files = new Map([[path.join(root, relative), Buffer.from('driver')], [executable, Buffer.from('host')]]), io = ordinaryMemoryFiles(files);
  const source = { files: { [relative]: hash('driver') }, claudeExecutableSha256: hash('host') };
  assert.equal(await verifyTestedSource(source, root, io, executable), true);
  files.set(path.join(root, relative), Buffer.from('changed-driver'));
  await assert.rejects(verifyTestedSource(source, root, io, executable), { code: 'claude_tested_source_changed' });
  files.set(path.join(root, relative), Buffer.from('driver')); files.set(executable, Buffer.from('changed-host'));
  await assert.rejects(verifyTestedSource(source, root, io, executable), { code: 'claude_tested_source_changed' });
});

function ownedIdentities() {
  const identity = (pid, parent, name) => ({ pid, parent, name, created: `2026-10-22T00:00:${String(pid % 60).padStart(2, '0')}.000Z`, sessionId: 1 });
  const guardNode = identity(10, 5, 'node.exe'), node = identity(20, 10, 'node.exe');
  return { guardNode, node, supervisor: identity(30, 20, 'TraceSupervisor.exe'), marker: identity(40, 30, 'TraceActivityIndicator.exe') };
}
function ownershipFixture(options = {}) {
  const identities = ownedIdentities(), events = [], chain = { node: identities.node, supervisor: identities.supervisor, marker: identities.marker };
  const wait = async identity => { events.push(`exit:${identity.pid}:${identity.created}`); if (identity.pid === options.failedPid) throw error('still_running'); return true; };
  const tracker = createOwnershipTracker({ nodeIdentity: identities.node, guardIdentity: identities.guardNode,
    readChain: async () => { events.push('chain'); return options.chain ?? chain; }, readOwned: async () => [identities.node], waitIdentityExit: wait });
  return { tracker, identities, events, wait };
}

test('production ownership captures exact guard and Node generations, native parents and Windows session; close proves each exit', async () => {
  const f = ownershipFixture();
  await f.tracker.opened({ sessionId: 1 });
  assert.deepEqual(f.tracker.evidence.chain, { node: f.identities.node, supervisor: f.identities.supervisor, marker: f.identities.marker });
  await f.tracker.sessionClosed();
  assert.equal(f.tracker.evidence.helperExitsConfirmed, true);
  await f.tracker.finish(async () => f.events.push('transport-close'));
  assert.equal(f.tracker.evidence.upstreamExitsConfirmed, true);
  const closeIndex = f.events.indexOf('transport-close');
  assert.ok(f.events.slice(closeIndex + 1).some(value => value.startsWith('exit:20:')));
  assert.equal(await verifyOwnershipExit(f.tracker.evidence, f.wait), true);
  assert.ok(f.events.some(value => value.startsWith('exit:10:')));
  assert.ok(f.tracker.evidence.exitChecks.every(value => value.exited === true && value.created && value.sessionId === 1));
});

test('wrong owned generation, parent or session blocks chain acceptance and remains uncertain after transport drains', async () => {
  for (const mutation of [chain => { chain.node.created = '2026-10-23T00:00:00Z'; },
    chain => { chain.supervisor.parent = 999; }, chain => { chain.marker.parent = 999; },
    chain => { chain.marker.sessionId = 2; }, chain => { chain.supervisor.created = 'unknown'; }]) {
    const identities = ownedIdentities(), chain = structuredClone({ node: identities.node, supervisor: identities.supervisor, marker: identities.marker });
    mutation(chain);
    const f = ownershipFixture({ chain });
    await assert.rejects(f.tracker.opened({ sessionId: 1 }), { code: 'claude_owned_chain_unverified' });
    let drained = false;
    await assert.rejects(f.tracker.finish(async () => { drained = true; }), { code: 'claude_owned_exit_unconfirmed' });
    assert.equal(drained, true); assert.equal(f.tracker.evidence.upstreamExitsConfirmed, false);
  }
  const ids = ownedIdentities();
  assert.throws(() => createOwnershipTracker({ nodeIdentity: { ...ids.node, parent: 999 }, guardIdentity: ids.guardNode }), { code: 'claude_owned_node_unverified' });
});

test('missing chain and failed helper exit cannot be replaced by guardClosed or transport success', async () => {
  const missing = ownershipFixture();
  await assert.rejects(verifyOwnershipExit({ guardClosed: true }, missing.wait), { code: 'claude_owned_exit_unconfirmed' });
  const failed = ownershipFixture({ failedPid: 30 }); await failed.tracker.opened({ sessionId: 1 });
  await assert.rejects(failed.tracker.sessionClosed(), { code: 'claude_owned_exit_unconfirmed' });
  assert.equal(failed.tracker.evidence.helperExitsConfirmed, false);
  let drained = false;
  await assert.rejects(failed.tracker.finish(async () => { drained = true; }), { code: 'claude_owned_exit_unconfirmed' });
  assert.equal(drained, true); assert.ok(failed.events.some(value => value.startsWith('exit:40:')));
  assert.equal(failed.tracker.evidence.upstreamExitsConfirmed, false);
});

test('EOF without a session independently proves Node and guard exit; transport failure still checks all native identities', async () => {
  const unopened = ownershipFixture(); await unopened.tracker.finish(async () => {});
  assert.equal(await verifyOwnershipExit(unopened.tracker.evidence, unopened.wait), true);
  const f = ownershipFixture(); await f.tracker.opened({ sessionId: 1 }); await f.tracker.sessionClosed();
  await assert.rejects(f.tracker.finish(async () => { throw error('transport_failure'); }), { code: 'claude_owned_exit_unconfirmed' });
  for (const pid of [20, 30, 40]) assert.ok(f.events.some(value => value.startsWith(`exit:${pid}:`)));
  await assert.rejects(verifyOwnershipExit(f.tracker.evidence, f.wait), { code: 'claude_owned_exit_unconfirmed' });
});
