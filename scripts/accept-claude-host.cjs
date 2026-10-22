#!/usr/bin/env node
'use strict';

// Opt-in external-host acceptance. Import/--plan never invokes Claude or desktop APIs.
// The labeled guard keeps the shipped six schemas and forwards to production stdio MCP.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { loadSkillBundle } = require('../src/computer/configuration.cjs');
const { DEFAULT_SUPERVISOR, OUTPUTS: SUPERVISOR_OUTPUTS, supervisorSourceHashes, verifySupervisorFiles, configuration: verifyProviders } = require('../src/computer/supervisor.cjs');
const { buildFixture } = require('./smoke-computer-live.cjs');
const { launchOwnedFixture } = require('./accept-clipboard.cjs');
const { stateOf, validateDisplay, compareDisplay } = require('./accept-supervisor-recovery.cjs');
const continuation = require('./live-acceptance-continuation.cjs');
const ROOT = path.resolve(__dirname, '..');
const CLAUDE = path.join(os.homedir(), '.local/bin/claude.exe');
const SERVER = 'trace-acceptance';
const TOOLS = ['doctor', 'list_windows', 'open_session', 'observe', 'act', 'close_session'];
const hostTool = name => `mcp__${SERVER}__trace_computer_${name}`;
const MCP_TOOLS = TOOLS.map(hostTool);
const REQUIRED_REFERENCES = ['readiness-routing.md', 'operation-and-recovery.md'];
const MINIMUM_HOST_VERSION = [2, 1, 295]; // Fail-closed command hooks require onFailure: block.
const MAX_GUARD_ADMISSIONS = 16; // Includes the executing operation; private acceptance bound.
const HOST_CASE = 'CLAUDE-TRACE-SKILL-NATIVE', HOST_CONTRACT = 'claude-queued-host-settings-v1';
const REA_SKILL = 'reverse-engineer-anything', TRACE_SKILL = 'trace-computer-use';
const fail = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fail(code); };
const codeOf = value => /^[A-Za-z0-9_-]{1,80}$/.test(value?.code || '') ? value.code : 'acceptance_failed';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Installation sync preserves unrelated files, unlike the strict canonical source.
// Only canonical manifest paths enter the returned map (and the host Read policy).
async function loadInstalledBundle(directory, canonicalDirectory) {
  const canonical = await loadSkillBundle(canonicalDirectory);
  directory = path.resolve(directory);
  const root = path.parse(directory).root;
  let ancestor = root;
  for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    const stat = await fs.lstat(ancestor);
    need(!stat.isSymbolicLink() && stat.isDirectory(), 'installed_skill_unsafe');
  }
  const realDirectory = await fs.realpath(directory);
  need(samePath(realDirectory, directory), 'installed_skill_unsafe');
  // Inspect metadata only for unrelated entries; never read their contents.
  const inspect = async folder => {
    for (const name of await fs.readdir(folder)) {
      const target = path.join(folder, name), stat = await fs.lstat(target);
      need(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'installed_skill_unsafe');
      need(samePath(await fs.realpath(target), target), 'installed_skill_unsafe');
      if (stat.isDirectory()) await inspect(target);
    }
  };
  await inspect(directory);
  const files = new Map();
  // Read the manifest first and compare exact bytes, without trusting installed paths.
  for (const relative of ['manifest.json', ...Object.keys(canonical.manifest.files)]) {
    const target = path.resolve(directory, relative);
    const within = path.relative(directory, target);
    need(within && !path.isAbsolute(within) && within !== '..' && !within.startsWith(`..${path.sep}`), 'installed_skill_unsafe');
    const stat = await fs.lstat(target);
    need(!stat.isSymbolicLink() && stat.isFile() && samePath(await fs.realpath(target), target), 'installed_skill_unsafe');
    const bytes = await fs.readFile(target);
    need(relative === 'manifest.json' ? bytes.equals(canonical.files.get(relative))
      : sha(bytes) === canonical.manifest.files[relative], 'installed_skill_differs');
    files.set(relative, bytes);
  }
  return { ...canonical, directory, files };
}

async function ordinaryFile(filename, io = fs) {
  const absolute = path.resolve(filename), root = path.parse(absolute).root;
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]); const stat = await io.lstat(current);
    need(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 'installed_instruction_unsafe');
  }
  need(samePath(await io.realpath(absolute), absolute), 'installed_instruction_unsafe');
  return io.readFile(absolute);
}
async function loadReaInstructions(home = os.homedir(), io = fs) {
  const filename = path.join(home, '.claude/skills', REA_SKILL, 'SKILL.md');
  const bytes = await ordinaryFile(filename, io);
  const header = bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  need(typeof header === 'string' && /^name:[ \t]*reverse-engineer-anything[ \t]*$/m.test(header), 'installed_rea_instruction_invalid');
  return { path: filename, realpath: await io.realpath(filename), sha256: sha(bytes) };
}
async function preparedFixture(root = ROOT, io = fs) {
  const folder = path.join(root, '.runtime/computer-fixture');
  const bytes = await ordinaryFile(path.join(folder, 'prepared-manifest.json'), io), manifest = JSON.parse(bytes.toString('utf8'));
  const sources = ['tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj', 'scripts/smoke-computer-live.cjs'];
  const outputs = ['TraceComputerFixture.exe', 'TraceComputerFixture.dll', 'TraceComputerFixture.runtimeconfig.json', 'TraceComputerFixture.deps.json'];
  need(manifest.schemaVersion === 1 && manifest.uiCreated === 0 && manifest.inputActions === 0
    && JSON.stringify(Object.keys(manifest.sources ?? {}).sort()) === JSON.stringify([...sources].sort())
    && JSON.stringify(Object.keys(manifest.files ?? {}).sort()) === JSON.stringify([...outputs].sort()), 'claude_fixture_setup_invalid');
  for (const relative of sources) need(/^[a-f0-9]{64}$/.test(manifest.sources[relative])
    && sha(await ordinaryFile(path.join(root, relative), io)) === manifest.sources[relative], 'claude_fixture_setup_stale');
  for (const name of outputs) need(/^[a-f0-9]{64}$/.test(manifest.files[name])
    && sha(await ordinaryFile(path.join(folder, 'bin', name), io)) === manifest.files[name], 'claude_fixture_setup_stale');
  return { executable: path.join(folder, 'bin/TraceComputerFixture.exe'), summary: { manifestSha256: sha(bytes), sources: manifest.sources, files: manifest.files } };
}
async function verifyTestedSource(testedSource, root = ROOT, io = fs, executable = CLAUDE) {
  for (const [relative, expected] of Object.entries(testedSource.files)) {
    need(sha(await ordinaryFile(path.join(root, relative), io)) === expected, 'claude_tested_source_changed');
  }
  need(sha(await ordinaryFile(executable, io)) === testedSource.claudeExecutableSha256, 'claude_tested_source_changed');
  return true;
}
async function runtimeIntegrity() {
  await verifySupervisorFiles();
  const { providers } = await verifyProviders();
  return { supervisor: Object.fromEntries(await Promise.all(SUPERVISOR_OUTPUTS.map(async name =>
    [name, sha(await fs.readFile(path.join(path.dirname(DEFAULT_SUPERVISOR), name)))]))),
    providers: Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, value.sha256])) };
}
async function evidenceDescriptor(ref, root = ROOT, io = fs) {
  continuation.reference({ ref, sha256: '0'.repeat(64) });
  const realRoot = await io.realpath(root), filename = path.join(root, ...ref.split('/'));
  const realFile = await io.realpath(filename), relative = path.relative(realRoot, realFile);
  need(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'invalid_continuation');
  return continuation.reference({ ref, sha256: sha(await io.readFile(realFile)) });
}
async function prepareAndClaimContinuation(options, prepare, { root = ROOT, keeper = continuation.createBookkeeper({ root }), io = fs } = {}) {
  need([1, 2].includes(options.continuationAttempt) && options.attempt === undefined, 'invalid_continuation');
  const prepared = await prepare(); // Read-only readiness/bundle/auth/setup checks; never launches a fixture/model.
  const decision = await evidenceDescriptor(options.continuationDecision, root, io);
  const claim = await keeper.claim({ caseId: HOST_CASE, contract: HOST_CONTRACT, decision,
    originals: continuation.plan(HOST_CASE, HOST_CONTRACT).originals, historicalAttemptsUsed: 2,
    continuationAttempt: options.continuationAttempt, lifetimeAttemptOrdinal: options.continuationAttempt + 2,
    ...(options.continuationAttempt === 2 ? { prior: await evidenceDescriptor(options.prior, root, io), changedPrecondition: options.change } : {}) });
  return { prepared, claim };
}

function plan(options = {}) {
  const supplemental = options.continuationAttempt !== undefined;
  return { schemaVersion: 1, caseId: HOST_CASE, host: 'Claude Code', ...(supplemental
    ? { continuation: continuation.plan(HOST_CASE, HOST_CONTRACT), historicalAttemptsUsed: 2,
      continuationAttempt: options.continuationAttempt, lifetimeAttemptOrdinal: options.continuationAttempt + 2, ownerDecisionRef: options.continuationDecision }
    : { attempt: options.attempt ?? 1 }),
    declaredBeforeHostOrUi: true,
    ...(options.prior ? { prior: options.prior, changedPrecondition: options.change } : {}),
    scope: supplemental ? 'HOST-01 partial: actual installed TRACE and REA instruction discovery, scoped production TRACE MCP/images, one owned-fixture effect and stale-observation recovery.'
      : 'HOST-01 partial: actual installed TRACE skill invocation, scoped production MCP/images, one owned-fixture effect and stale-observation recovery.',
    notProven: [supplemental ? 'REA analysis' : 'REA skill discovery or analysis', 'Semantic image comprehension', 'Direct unguarded host connection', 'Real application/REPLAY workflow', 'Physical stop or interruption matrix'],
    target: 'One fresh owned WinForms fixture, exact PID/title/process creation time/HWND; unrelated discovery metadata is filtered before reaching the model.',
    initial: { text: '', count: 0, input: 'Independent all-up/no-quarantine check; one pinned observed display.' },
    actions: ['Check existing subscription authentication and installed TRACE bundle integrity without writing user settings.',
      ...(supplemental ? ['Discover installed reverse-engineer-anything with its exact Skill invocation and read only its validated SKILL.md; do not run analysis, network or REA tools.'] : []),
      'Invoke installed trace-computer-use with the real Skill tool; read its routing/recovery references with scoped Read.',
      'Use the labeled six-tool guard forwarding production bin/trace.cjs computer mcp; diagnose/discover/open/observe the exact fixture.',
      'Click its observed edit and verify focus; type one run-unique synthetic literal once.',
      'Deliberately invoke the counter with the observation consumed by typing; require the real stale_observation rejection and unchanged independent fixture state.',
      'Observe afresh, invoke the counter exactly once, inspect final state and close the native session.'],
    expected: { text: 'Run-unique literal declared privately before launch', count: 1, staleRejection: true, freshRecovery: true, sessionClosedByHost: true },
    guard: 'Acceptance-only target/action restriction; six public schemas and production outcomes/images preserved. No simulated native executor or test tool.',
    privacy: 'Raw stream, model prose/thinking, images, fixture state, credentials and private launch configuration are never copied into evidence. Only whitelist summaries persist.',
    hostConfiguration: 'Claude >=2.1.295; project-only setting source in a fresh workspace, installed skills discovered from the home additional directory, exact Skill/manifest Read pre-execution hook with fail-closed launch/timeout behavior, six explicit MCP permissions, temporary strict MCP profile, no Chrome, no session persistence, no shell/edit/write/web tools; existing Claude subscription only.',
    cleanup: 'Stop retained owned host process if bounded run is interrupted; guard drains production session/MCP on EOF. Independently require owned process exit, released input and no quarantine before fixture/temp cleanup. Uncertainty is retained.',
    budget: supplemental ? 'Two preserved original attempts; one atomically claimed supplemental attempt plus at most one same-decision corrective continuation with terminal prior evidence and actual change; no automatic replay.'
      : 'One attempt plus one explicit corrective retry with prior unfinished receipt and changed precondition; no automatic model/native replay.',
    documentation: ['https://code.claude.com/docs/en/cli-reference', 'https://code.claude.com/docs/en/skills', 'https://code.claude.com/docs/en/hooks'],
  };
}
function parseArgs(args) {
  const options = { mode: 'plan', attempt: 1 };
  let legacyAttemptSpecified = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--plan' || value === '--live') options.mode = value.slice(2);
    else if (value === '--attempt') { options.attempt = Number(args[++i]); legacyAttemptSpecified = true; }
    else if (value === '--continuation-decision') options.continuationDecision = args[++i];
    else if (value === '--continuation-attempt') options.continuationAttempt = Number(args[++i]);
    else if (value === '--prior') options.prior = args[++i];
    else if (value === '--change') options.change = args[++i];
    else if (!value.startsWith('--') && !options.directory) options.directory = value;
    else throw fail('invalid_arguments');
  }
  if (options.continuationDecision !== undefined || options.continuationAttempt !== undefined) {
    need(!legacyAttemptSpecified && [1, 2].includes(options.continuationAttempt) && typeof options.continuationDecision === 'string'
      && (options.mode !== 'live' || !!options.directory)
      && (options.continuationAttempt === 1 ? !options.prior && !options.change : !!options.prior && !!options.change), 'invalid_arguments');
    continuation.reference({ ref: options.continuationDecision, sha256: '0'.repeat(64) });
    if (options.prior) continuation.reference({ ref: options.prior, sha256: '0'.repeat(64) });
    delete options.attempt;
    return options;
  }
  need([1, 2].includes(options.attempt) && (options.mode !== 'live' || !!options.directory)
    && (options.attempt === 1 ? !options.prior && !options.change : !!options.prior && !!options.change), 'invalid_arguments');
  return options;
}

function createGuard({ target, payload, call, readFixture, record = async () => {}, assertDisplay = async () => {}, closeUpstream = async () => {} }) {
  let window, session, sessionOpened = false, sessionValid = false, latest, focusedObservation, typed = false, staleRejected = false, recoveredObservation, incremented = false, unsafe = false, closed = false;
  const frames = new Map();
  const evidence = { scopeViolations: 0, typed: false, staleRejected: false, independentStaleUnchanged: false,
    recovered: false, sessionClosedByHost: false, calls: [], imagesForwarded: 0 };
  const deny = () => { evidence.scopeViolations++; throw fail('acceptance_scope_rejected'); };
  const checkSession = input => { if (!sessionValid || !session || input.sessionId !== session) deny(); };
  const frame = value => {
    need(value && typeof value.observationId === 'string', 'production_observation_missing');
    latest = value.observationId; frames.set(latest, value);
    if (value.screenshot?.data) evidence.imagesForwarded++;
    return value;
  };
  const forward = async (name, input = {}, options) => {
    evidence.calls.push(name);
    const result = await call(name, input, options);
    await record(evidence);
    return result;
  };
  const guard = { evidence,
    doctor: options => forward('doctor', {}, options),
    async listWindows(options) {
      const result = await forward('list_windows', {}, options);
      const matches = result.windows?.filter(item => item.pid === target.pid && item.title === target.title) || [];
      need(matches.length === 1 && !!matches[0].processCreationTime, 'owned_window_unavailable');
      if (window && (matches[0].id !== window.id || matches[0].processCreationTime !== window.processCreationTime)) throw fail('owned_window_changed');
      window ??= matches[0];
      return { ...result, windows: [window] };
    },
    async openSession(input, options) {
      if (!window || input.windowId !== window.id || session || sessionOpened) deny();
      sessionOpened = true;
      const result = await forward('open_session', input, options);
      // Retain ownership before inspecting metadata: a successful upstream open must
      // remain drainable even when its returned target identity cannot be trusted.
      session = typeof result?.sessionId === 'string' ? result.sessionId : null;
      try {
        need(result.window?.id === window.id && result.window?.pid === window.pid
          && result.window?.processCreationTime === window.processCreationTime, 'owned_session_identity_mismatch');
        need(!!session, 'production_session_missing'); sessionValid = true;
      } catch (error) { unsafe = true; throw error; }
      return result;
    },
    async observe(input, options) {
      checkSession(input);
      const result = await forward('observe', input, options); frame(result);
      if (staleRejected) recoveredObservation = latest;
      await record(evidence); return result;
    },
    async act(input, options) {
      checkSession(input); if (unsafe) deny();
      const observed = frames.get(input.observationId), action = input.action;
      if (!observed || !action) deny();
      const element = observed.elements?.find(item => item.id === action.elementId && item.enabled);
      const isFocus = !typed && !focusedObservation && input.observationId === latest && action.type === 'click' && element?.name === 'TRACE text input';
      const isType = !typed && focusedObservation === input.observationId && input.observationId === latest
        && observed.focused?.hasFocus === true && action.type === 'type_text' && action.text === payload;
      const isStale = typed && !staleRejected && input.observationId === focusedObservation && action.type === 'invoke' && element?.name === 'Increment counter';
      const isIncrement = staleRejected && !incremented && input.observationId === recoveredObservation
        && input.observationId === latest && action.type === 'invoke' && element?.name === 'Increment counter';
      if (![isFocus, isType, isStale, isIncrement].some(Boolean)) deny();
      await assertDisplay();
      if (isStale) {
        // A stale error is recoverable only after both independent state reads
        // prove zero effect. Lost verification must never authorize a replay.
        unsafe = true;
        const before = await readFixture(); need(before.text === payload && before.count === 0, 'stale_precondition_mismatch');
        let rejected;
        try { rejected = await forward('act', input, options); }
        catch (error) {
          if (error.code !== 'stale_observation') { unsafe = true; throw error; }
          const after = await readFixture();
          need(after.text === before.text && after.count === before.count, 'stale_effect_changed');
          staleRejected = true; evidence.staleRejected = true; evidence.independentStaleUnchanged = true;
          await record(evidence); unsafe = false; throw error; // Preserve actual production error; invent no outcome.
        }
        unsafe = true; throw fail(rejected.outcome === 'unknown' ? 'native_delivery_unknown' : 'stale_rejection_missing');
      }
      // Consume the one permitted mutation before awaiting a possibly lost reply.
      if (isType) {
        try {
          const state = await readFixture();
          need(state.focusedControl === 'traceTextInput' && state.text === '' && state.count === 0, 'owned_independent_focus_unproven');
        } catch (error) { unsafe = true; throw error; }
      }
      if (isType) typed = true;
      if (isIncrement) incremented = true;
      let result;
      try { result = await forward('act', input, options); }
      catch (error) { unsafe = true; throw error; }
      if (result.outcome !== 'completed') { unsafe = true; return result; }
      try {
        frame(result.observation);
        if (isFocus) {
          const edit = result.observation.elements?.find(item => item.name === 'TRACE text input' && item.enabled);
          need(edit && result.observation.focused?.hasFocus === true && result.observation.focused.elementId === edit.id, 'owned_focus_unproven');
          focusedObservation = latest;
        }
      } catch (error) { unsafe = true; throw error; }
      if (isType) evidence.typed = true;
      if (isIncrement) evidence.recovered = true;
      await record(evidence); return result;
    },
    async closeSession(input, options) {
      checkSession(input); const result = await forward('close_session', input, options);
      need(result.closed === true, 'native_cleanup_unknown'); session = null; sessionValid = false;
      evidence.sessionClosedByHost = true; await record(evidence); return result;
    },
    async close() {
      if (closed) return; closed = true;
      let error;
      if (session) {
        try { const result = await forward('close_session', { sessionId: session }); need(result.closed === true, 'native_cleanup_unknown'); session = null; }
        catch (caught) { error = caught; }
      }
      try { await closeUpstream(); } catch (caught) { error ??= caught; }
      evidence.guardClosed = !error; await record(evidence);
      if (error) throw error;
    },
  };
  let inFlight, closing = false, closePromise;
  const pending = [];
  const dispatchNext = () => {
    if (closing || inFlight || pending.length === 0) return;
    const request = pending.shift();
    const work = Promise.resolve().then(() => {
      // close() can fence an admitted request before its dispatch microtask starts.
      if (closing) throw fail('acceptance_guard_closing');
      return request.operation(...request.args);
    });
    inFlight = work;
    void work.then(request.resolve, request.reject).finally(() => {
      if (inFlight === work) inFlight = null;
      dispatchNext();
    });
  };
  for (const method of ['doctor', 'listWindows', 'openSession', 'observe', 'act', 'closeSession']) {
    const operation = guard[method];
    guard[method] = (...args) => new Promise((resolve, reject) => {
      if (closing || closed) { reject(fail('acceptance_guard_closing')); return; }
      if (pending.length + Number(!!inFlight) >= MAX_GUARD_ADMISSIONS) { reject(fail('acceptance_queue_full')); return; }
      pending.push({ operation, args, resolve, reject });
      dispatchNext();
    });
  }
  const close = guard.close;
  guard.close = () => {
    if (closePromise) return closePromise;
    closing = true;
    for (const request of pending.splice(0)) request.reject(fail('acceptance_guard_closing'));
    closePromise = (async () => { await inFlight?.catch(() => {}); return close(); })();
    return closePromise;
  };
  return guard;
}

function supportedHostVersion(version) {
  const parts = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!parts) return false;
  for (let index = 0; index < MINIMUM_HOST_VERSION.length; index++) {
    if (parts[index] !== MINIMUM_HOST_VERSION[index]) return parts[index] > MINIMUM_HOST_VERSION[index];
  }
  return true;
}
function scopedReadPath(value, allowedReads, pathApi = path) {
  if (typeof value !== 'string' || value.includes('\0') || !pathApi.isAbsolute(value)
    || value.split(/[\\/]+/).includes('..')) return null;
  const normalized = pathApi.resolve(value).toLowerCase();
  return allowedReads.find(file => typeof file === 'string' && pathApi.isAbsolute(file)
    && pathApi.resolve(file).toLowerCase() === normalized) ?? null;
}
async function hostToolAllowed(event, policy, { realpath = fs.realpath, lstat = fs.lstat, readFile = fs.readFile } = {}) {
  if (event?.hook_event_name !== 'PreToolUse' || !Array.isArray(policy?.allowedReads)) return false;
  if (MCP_TOOLS.includes(event.tool_name)) return true; // Native inputs remain gated by createGuard.
  if (event.tool_name === 'Skill') {
    if (!(policy.allowedSkills ?? [TRACE_SKILL]).includes(event.tool_input?.skill) || ![TRACE_SKILL, REA_SKILL].includes(event.tool_input?.skill)
      || event.tool_input.args || !Object.keys(event.tool_input).every(key => ['skill', 'args'].includes(key))) return false;
    const instruction = event.tool_input.skill === REA_SKILL ? policy.reaInstructionPath : policy.traceInstructionPath;
    if (!instruction) return event.tool_input.skill === TRACE_SKILL; // Legacy scoped policy compatibility.
    if (!policy.sha256Reads?.[instruction]) return false;
    return hostToolAllowed({ ...event, tool_name: 'Read', tool_input: { file_path: instruction } }, policy, { realpath, lstat, readFile });
  }
  if (event.tool_name !== 'Read') return false;
  const selected = scopedReadPath(event.tool_input?.file_path, policy.allowedReads);
  if (!selected) return false;
  if (selected === policy.reaInstructionPath && Object.keys(event.tool_input).some(key => key !== 'file_path')) return false;
  try {
    const stat = await lstat(event.tool_input.file_path);
    // Compare with the launch-time real path as well as the exact manifest path.
    // A link/reparse substitution cannot broaden the file allowlist.
    const pinned = policy.realReads?.[selected];
    return stat.isFile() && !stat.isSymbolicLink() && typeof pinned === 'string'
      && samePath(await realpath(event.tool_input.file_path), pinned)
      && (!policy.sha256Reads?.[selected] || sha(await readFile(event.tool_input.file_path)) === policy.sha256Reads[selected]);
  } catch { return false; }
}
function hostSettings(policyPath, requireRea = false) {
  return { ...(requireRea ? { disableSkillShellExecution: true } : {}), hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: process.execPath,
    args: [__filename, '--host-hook', policyPath], timeout: 10, onFailure: 'block' }] }] } };
}
async function runHostHook(policyPath, input = process.stdin, output = process.stdout) {
  let allowed = false;
  try {
    need(path.isAbsolute(policyPath || ''), 'invalid_hook_policy');
    const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
    let raw = '', bytes = 0;
    for await (const chunk of input) {
      bytes += Buffer.byteLength(chunk); need(bytes <= 65536, 'hook_input_limit'); raw += chunk.toString('utf8');
    }
    allowed = await hostToolAllowed(JSON.parse(raw), policy);
  } catch {} // Malformed input/policy and inspection failures always deny before execution.
  output.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: allowed ? 'allow' : 'deny', permissionDecisionReason: allowed
      ? 'Declared TRACE acceptance tool.' : 'Tool is outside the declared TRACE acceptance scope.' } }) + '\n');
}

function streamState({ allowedReads = [], requiredSkills = [TRACE_SKILL], reaInstructionPath } = {}) {
  return { calls: new Map(), results: new Set(), tools: [], receipts: [], violations: 0, parseErrors: 0, images: 0,
    connected: false, skillInvoked: false, skillsInvoked: new Set(), requiredSkills, reaInstructionPath, reaInstructionsRead: false,
    referenceReads: new Set(), toolFailures: [], terminal: null, diagnostic: null, allowedReads };
}
function toolState(block) {
  if (block.structuredContent && typeof block.structuredContent === 'object') return block.structuredContent;
  const content = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content;
  const texts = Array.isArray(content) ? content.filter(item => item.type === 'text' && typeof item.text === 'string') : [];
  if (texts.length !== 1) return null;
  try { const value = JSON.parse(texts[0].text); return value && !Array.isArray(value) && typeof value === 'object' ? value : null; }
  catch { return null; }
}
function observeEvent(event, state) {
  if (event?.type === 'system' && event.subtype === 'init') {
    state.connected ||= event.mcp_servers?.some(server => server.name === SERVER && server.status === 'connected') === true;
  }
  for (const block of event?.message?.content || []) {
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || state.calls.has(block.id)) { state.violations++; continue; }
      let kind = 'unexpected', ref;
      if (MCP_TOOLS.includes(block.name)) {
        kind = 'mcp';
        if (!['doctor', 'list_windows'].map(hostTool).includes(block.name)
          && (!state.requiredSkills.every(skill => state.skillsInvoked.has(skill)) || !REQUIRED_REFERENCES.every(file => state.referenceReads.has(file))
            || (state.requiredSkills.includes(REA_SKILL) && !state.reaInstructionsRead))) state.violations++;
      }
      else if (block.name === 'Skill' && state.requiredSkills.includes(block.input?.skill) && [TRACE_SKILL, REA_SKILL].includes(block.input?.skill)
        && !block.input.args && Object.keys(block.input).every(key => ['skill', 'args'].includes(key))) kind = 'skill';
      else if (block.name === 'Read' && typeof block.input?.file_path === 'string') {
        ref = scopedReadPath(block.input.file_path, state.allowedReads);
        if (ref && !(state.reaInstructionPath && samePath(ref, state.reaInstructionPath)
          && Object.keys(block.input).some(key => key !== 'file_path'))) kind = 'read';
      }
      if (kind === 'unexpected') state.violations++;
      state.calls.set(block.id, { name: kind === 'unexpected' ? 'UNEXPECTED_TOOL' : block.name, kind, ref, ...(kind === 'skill' ? { skill: block.input.skill } : {}) });
      state.tools.push(kind === 'unexpected' ? 'UNEXPECTED_TOOL' : block.name);
    } else if (block.type === 'tool_result') {
      const call = state.calls.get(block.tool_use_id);
      if (!call || state.results.has(block.tool_use_id)) { state.violations++; continue; }
      state.results.add(block.tool_use_id);
      const builtinFailed = block.is_error || (['skill', 'read'].includes(call.kind) && !!toolState(block)?.error);
      if (builtinFailed && ['skill', 'read'].includes(call.kind)) {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? []);
        const text = content.slice(0, 16384);
        const category = /permission|denied|not allowed/i.test(text) ? 'permission_denied'
          : call.kind === 'skill' && /unknown skill|skill.*not found|not found.*skill|not available/i.test(text) ? 'skill_not_found'
          : call.kind === 'skill' && /disabled|cannot.*invoke/i.test(text) ? 'skill_invocation_disabled'
          : call.kind === 'read' && /ENOENT|not found|does not exist/i.test(text) ? 'read_not_found' : 'tool_error_unclassified';
        state.toolFailures.push({ tool: call.kind === 'skill' ? 'Skill' : 'Read', category });
      }
      if (call.kind === 'skill' && !builtinFailed) { state.skillsInvoked.add(call.skill); if (call.skill === TRACE_SKILL) state.skillInvoked = true; }
      if (call.kind === 'read' && !builtinFailed) {
        if (state.reaInstructionPath && samePath(call.ref, state.reaInstructionPath)) state.reaInstructionsRead = true;
        else state.referenceReads.add(path.basename(call.ref));
      }
      if (call.kind === 'mcp') {
        const value = toolState(block);
        const images = Array.isArray(block.content) ? block.content.filter(item => item.type === 'image').length : 0;
        state.images += images;
        state.receipts.push({ tool: call.name, success: !block.is_error && !value?.error,
          ...(value?.outcome && ['completed', 'unknown', 'not_dispatched'].includes(value.outcome) ? { outcome: value.outcome } : {}),
          ...(value?.error ? { code: codeOf(value.error) } : {}), imageBlocks: images, parsedState: !!value });
      }
    }
  }
  if (event?.type === 'result') {
    if (state.terminal) state.violations++;
    state.terminal = { isError: event.is_error !== false, permissionDenials: Array.isArray(event.permission_denials) ? event.permission_denials.length : 0,
      turns: Number.isInteger(event.num_turns) ? event.num_turns : null };
    const text = typeof event.result === 'string' ? event.result : '';
    if (/rate.?limit|usage.?limit|quota|out of.*usage/i.test(text)) state.diagnostic = 'account_usage_limit';
    else if (/not.?logged.?in|authentication|invalid.*oauth|login.*required/i.test(text)) state.diagnostic = 'authentication_required';
  }
}
function summarize(state, exitCode, terminated = false, processExited = true) {
  return { exitCode, terminated, processExited, connected: state.connected, skillInvoked: state.skillInvoked,
    skillsInvoked: [...state.skillsInvoked].sort(), requiredSkills: [...state.requiredSkills], reaInstructionsRead: state.reaInstructionsRead,
    referenceReads: [...state.referenceReads].sort(), tools: state.tools, receipts: state.receipts, toolFailures: state.toolFailures,
    imagesReceived: state.images, semanticImageComprehension: 'not_tested', violations: state.violations,
    parseErrors: state.parseErrors, unmatchedToolResults: state.calls.size - state.results.size,
    terminal: state.terminal, diagnostic: state.diagnostic };
}
function hostArguments(config, home, settings, requiredSkills = [TRACE_SKILL]) {
  need(typeof settings === 'string' && settings.length > 0, 'host_hook_settings_required');
  need(requiredSkills.length > 0 && requiredSkills.every(skill => [TRACE_SKILL, REA_SKILL].includes(skill)), 'host_skill_scope_invalid');
  return ['-p', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', config,
    '--settings', settings,
    '--tools', 'Skill,Read', '--allowedTools', [...requiredSkills.map(skill => `Skill(${skill})`), 'Read', ...MCP_TOOLS].join(','),
    '--add-dir', home, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--no-chrome', '--output-format', 'stream-json', '--verbose', '--effort', 'low'];
}
function hostEnvironment(environment = process.env) {
  const result = { ...environment, CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', ENABLE_TOOL_SEARCH: 'false' };
  for (const key of Object.keys(result)) if (/^ANTHROPIC_|^CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)$/.test(key)
    || ['ELECTRON_RUN_AS_NODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'].includes(key)) delete result[key];
  return result;
}
async function invokeHost({ config, cwd, home = os.homedir(), settings, prompt, allowedReads, requiredSkills = [TRACE_SKILL], reaInstructionPath, signal, spawnImpl = spawn, timeoutMs = 240000 }) {
  const state = streamState({ allowedReads, requiredSkills, reaInstructionPath }), decoder = new StringDecoder('utf8');
  return new Promise((resolve, reject) => {
    const child = spawnImpl(CLAUDE, hostArguments(config, home, settings, requiredSkills), { cwd, env: hostEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, terminated = false, escalation, abandonment, settled = false;
    const finish = (code, exited) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(abandonment); signal?.removeEventListener('abort', stop);
      if (exited) { buffer += decoder.end(); if (buffer.trim()) line(buffer); }
      resolve(summarize(state, code, terminated, exited));
    };
    const stop = () => {
      if (terminated || settled) return;
      terminated = true; child.kill();
      escalation = setTimeout(() => { child.kill('SIGKILL'); abandonment = setTimeout(() => finish(null, false), 3000); }, 3000);
    };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    const line = raw => { if (!raw.trim()) return; try { observeEvent(JSON.parse(raw), state); } catch { state.parseErrors++; } };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 24 * 1024 * 1024) { state.diagnostic = 'host_output_limit'; stop(); return; }
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    });
    child.stderr.on('data', () => {}); // No raw provider diagnostics or transcript persistence.
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(Object.assign(fail('claude_launch_failed'), { hostStarted: !!child.pid })); });
    child.once('close', code => finish(code, true));
    child.stdin.end(prompt);
    if (signal?.aborted) stop();
  });
}

function createOwnershipTracker({ nodeIdentity, guardIdentity, readChain, readOwned, waitIdentityExit }) {
  const valid = value => Number.isInteger(value?.pid) && value.pid > 0 && Number.isInteger(value.parent)
    && typeof value.created === 'string' && Number.isFinite(Date.parse(value.created))
    && Number.isInteger(value.sessionId) && value.sessionId >= 0;
  need(valid(nodeIdentity) && valid(guardIdentity) && /^node(?:\.exe)?$/i.test(nodeIdentity.name)
    && /^node(?:\.exe)?$/i.test(guardIdentity.name) && nodeIdentity.parent === guardIdentity.pid
    && nodeIdentity.sessionId === guardIdentity.sessionId, 'claude_owned_node_unverified');
  const same = (a, b) => ['pid', 'parent', 'created', 'name', 'sessionId'].every(key => a?.[key] === b?.[key]);
  const evidence = { guardNode: { ...guardIdentity }, productionNode: { ...nodeIdentity }, sessionOpened: false,
    helperExitsConfirmed: false, upstreamExitsConfirmed: false };
  let chain;
  const exits = async identities => {
    const results = []; let problem;
    for (const identity of identities) {
      try { need(await waitIdentityExit(identity) === true, 'claude_owned_exit_unconfirmed'); results.push({ ...identity, exited: true }); }
      catch (error) { results.push({ ...identity, exited: false }); problem ??= error; }
    }
    if (problem) { evidence.exitChecks = results; throw fail('claude_owned_exit_unconfirmed'); }
    return results;
  };
  return { evidence,
    async opened(window) {
      evidence.sessionOpened = true;
      chain = await readChain(); evidence.chain = chain;
      need(same(chain.node, nodeIdentity) && [chain.node, chain.supervisor, chain.marker].every(valid)
        && chain.supervisor.name === 'TraceSupervisor.exe' && chain.marker.name === 'TraceActivityIndicator.exe'
        && chain.supervisor.parent === chain.node.pid && chain.marker.parent === chain.supervisor.pid
        && Number.isInteger(window?.sessionId)
        && [guardIdentity, chain.node, chain.supervisor, chain.marker].every(value => value.sessionId === window.sessionId), 'claude_owned_chain_unverified');
      evidence.chainVerified = true;
    },
    async sessionClosed() {
      need(evidence.chainVerified === true, 'claude_owned_chain_unverified');
      evidence.helperExits = await exits([chain.supervisor, chain.marker]); evidence.helperExitsConfirmed = true;
    },
    async finish(closeTransport) {
      let owned = [nodeIdentity], problem;
      try { owned = chain ? [nodeIdentity, chain.supervisor, chain.marker].filter(Boolean) : await readOwned(); }
      catch (error) { problem = error; }
      try { await closeTransport(); } catch (error) { problem ??= error; }
      try { evidence.exitChecks = await exits(owned); } catch (error) { problem ??= error; }
      need(!problem && owned.some(value => same(value, nodeIdentity))
        && (!evidence.sessionOpened || evidence.chainVerified === true), 'claude_owned_exit_unconfirmed');
      evidence.upstreamExitsConfirmed = true;
    },
  };
}
async function verifyOwnershipExit(evidence, waitExit) {
  need(evidence?.upstreamExitsConfirmed === true && (!evidence.sessionOpened
    || (evidence.chainVerified === true && evidence.helperExitsConfirmed === true)),
    'claude_owned_exit_unconfirmed');
  const identities = [evidence.guardNode, evidence.productionNode,
    ...(evidence.sessionOpened ? [evidence.chain?.supervisor, evidence.chain?.marker] : [])];
  for (const identity of identities) {
    need(identity && await waitExit(identity) === true, 'claude_owned_exit_unconfirmed');
  }
  return true;
}
async function serveGuard(configPath) {
  need(path.isAbsolute(configPath || ''), 'invalid_guard_config');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  need(Number.isInteger(config.target?.pid) && typeof config.target.title === 'string' && typeof config.payload === 'string'
    && [config.runtime, config.fixtureState, config.journal].every(file => path.isAbsolute(file)), 'invalid_guard_config');
  const { Client } = require('@modelcontextprotocol/client');
  const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'trace-claude-scoped-acceptance-guard', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/trace.cjs'), 'computer', 'mcp'],
    cwd: ROOT, env: { ...process.env, TRACE_COMPUTER_RUNTIME: config.runtime }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const common = require('./replacement-acceptance-common.cjs');
  let pid, guard, ownership;
  let journalWrite = Promise.resolve();
  const record = evidence => {
    const bytes = JSON.stringify({ ...evidence, nodePid: process.pid, productionMcpPid: pid, ownership: ownership?.evidence });
    const write = journalWrite.catch(() => {}).then(async () => {
      const temporary = config.journal + '.tmp';
      await fs.writeFile(temporary, bytes);
      await fs.rename(temporary, config.journal);
    });
    journalWrite = write;
    return write;
  };
  try {
    await client.connect(transport, { timeout: 15000 }); pid = transport.pid;
    const records = await common.processList(), nodeIdentity = records.find(value => value.pid === pid), guardIdentity = records.find(value => value.pid === process.pid);
    const owned = () => ({ pid, nodeIdentity });
    ownership = createOwnershipTracker({ nodeIdentity, guardIdentity,
      readChain: () => common.readChain(owned()), readOwned: () => common.readOwned(owned()), waitIdentityExit: common.waitIdentityExit });
    guard = createGuard({ ...config, readFixture: async () => JSON.parse(await fs.readFile(config.fixtureState, 'utf8')), record,
      assertDisplay: async () => compareDisplay(await native(['display']), config.display),
      call: async (name, args, options) => {
        const response = await client.callTool({ name: `trace_computer_${name}`, arguments: args }, { timeout: 30000, ...(options?.signal ? { signal: options.signal } : {}) });
        const result = stateOf(response); if (response.isError) throw fail(codeOf(result.error));
        if (name === 'open_session') await ownership.opened(result.window);
        if (name === 'close_session' && result.closed === true) await ownership.sessionClosed();
        return result;
      },
      closeUpstream: async () => {
        await ownership.finish(async () => {
          let error;
          try { await client.close(); } catch (caught) { error = caught; }
          try { await transport.close(); } catch (caught) { error ??= caught; }
          if (error) throw error;
        });
      },
    });
    await record(guard.evidence);
    await require('../src/computer/server.cjs').runComputerServer({ controller: guard, onError: () => {} });
  } catch (error) {
    if (guard) await guard.close().catch(() => {});
    else { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
    throw error;
  }
}
async function native(args) {
  return JSON.parse((await execFileAsync(DEFAULT_SUPERVISOR, args, { windowsHide: true, timeout: 19000, maxBuffer: 131072 })).stdout.trim());
}
function promptFor({ payload, reaInstructionPath }) {
  return ['Run one synthetic TRACE host acceptance. Invoke the Skill tool for trace-computer-use before any MCP mutation. Read its installed readiness-routing.md and operation-and-recovery.md references.',
    ...(reaInstructionPath ? [`Also invoke exactly Skill reverse-engineer-anything and Read its selected installed instruction file ${reaInstructionPath} before any MCP mutation. This proves instruction discovery only: do not execute REA analysis, network requests, scripts or other tools.`] : []),
    reaInstructionPath ? 'Use only those two exact Skills, Read for the declared TRACE manifest files and selected REA instruction file, and the six trace-acceptance MCP tools. No shell, analysis, other server, browser, clipboard, unrelated files/skills, paid provider or extra service.'
      : 'Use only that Skill, Read for its installed bundle, and the six trace-acceptance MCP tools. No shell, other app/server, browser, clipboard, files, unrelated skills, paid provider or extra service.',
    'This is a labeled scoped guard forwarding real production TRACE stdio MCP. Diagnose, list the single owned fixture, open that exact window and observe its PNG and accessibility state.',
    'Click the current enabled TRACE text input. Verify the returned focus selects that exact observed edit before typing.',
    `Type this exact literal once with type_text: ${JSON.stringify(payload)}. Keep the observationId used for typing.`,
    'Deliberate rejection subcase: invoke Increment counter using that now-consumed observationId. Expect stale_observation; do not replay typing or the rejected invocation. This is predeclared failure testing.',
    'After the rejection, observe afresh. Invoke Increment counter exactly once using the new observation. Inspect the resulting text and counter (1), then close_session.',
    'Stop input after any unknown outcome, unexpected error, ownership or cleanup problem. Report it without claiming success, inventing evidence or retrying. Tool images received are not proof of semantic image comprehension.',
    'Finish with one short status sentence. Do not write a transcript, file, setting or memory.'].join('\n');
}
function completed(host, guard, final, payload) {
  return host.exitCode === 0 && host.processExited === true && !host.terminated && host.connected && host.skillInvoked && host.imagesReceived > 0
    && (!host.requiredSkills?.includes(REA_SKILL) || (host.skillsInvoked?.includes(REA_SKILL) && host.reaInstructionsRead === true))
    && host.referenceReads.includes('readiness-routing.md') && host.referenceReads.includes('operation-and-recovery.md')
    && host.terminal?.isError === false && host.terminal.permissionDenials === 0 && host.violations === 0
    && host.parseErrors === 0 && host.unmatchedToolResults === 0 && !host.diagnostic
    && TOOLS.every(name => host.receipts.some(receipt => receipt.tool === hostTool(name) && receipt.success && receipt.parsedState))
    && host.receipts.some(receipt => receipt.tool === hostTool('act') && !receipt.success && receipt.code === 'stale_observation')
    && guard?.scopeViolations === 0 && guard.typed === true && guard.staleRejected === true
    && guard.independentStaleUnchanged === true && guard.recovered === true && guard.sessionClosedByHost === true
    && final?.text === payload && final.count === 1;
}
const SETTING_SOURCES = [['clientState', '.claude.json'], ['userSettings', '.claude/settings.json'], ['userLocalSettings', '.claude/settings.local.json']];
const canonicalJson = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonicalJson(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonicalJson(value[key]))])) : value);
async function fingerprintSettings(home = os.homedir(), io = fs) {
  const result = {};
  for (const [label, relative] of SETTING_SOURCES) {
    try {
      const bytes = await io.readFile(path.join(home, relative));
      let value, valid = false;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); valid = value !== null && typeof value === 'object' && !Array.isArray(value); } catch {}
      result[label] = { bytes, valid, value };
    } catch (error) { if (error.code !== 'ENOENT') throw error; result[label] = null; }
  }
  return result; // Private snapshots only. Never serialize these objects or credential-derived hashes.
}
function compareSettings(before, after) {
  const type = (object, key) => !object || !Object.hasOwn(object, key) ? 'missing' : object[key] === null ? 'null'
    : Array.isArray(object[key]) ? 'array' : typeof object[key];
  const safeKeys = new Set(['projects', 'numStartups', 'lastVersion', 'lastReleaseNotes', 'lastReleaseNotesSeen', 'hasCompletedOnboarding',
    'hooks', 'permissions', 'enabledPlugins', 'env', 'mcpServers', 'model', 'theme', 'oauthAccount', 'installMethod', 'autoUpdates',
    'cachedGrowthBookFeatures', 'cachedGrowthBookFeaturesAt', 'cachedExperimentData', 'cachedExperimentFeatures', 'cachedUsageUtilization', 'cachedArtifactRoster']);
  const changes = [];
  for (const [source] of SETTING_SOURCES) {
    const a = before[source], b = after[source];
    if ((!a && !b) || (a && b && a.bytes.equals(b.bytes))) continue;
    const semantic = !a || !b || !a.valid || !b.valid || canonicalJson(a.value) !== canonicalJson(b.value);
    const keys = semantic && a?.valid && b?.valid ? [...new Set([...Object.keys(a.value), ...Object.keys(b.value)])]
      .filter(key => canonicalJson(a.value[key]) !== canonicalJson(b.value[key]))
      .map(key => ({ key: safeKeys.has(key) ? key : 'unrecognized_key', beforeType: type(a.value, key), afterType: type(b.value, key) })) : [];
    changes.push({ source, kind: semantic ? 'semantic_change' : 'formatting_only', keys,
      before: !a ? 'missing' : a.valid ? 'json_object' : 'unparseable', after: !b ? 'missing' : b.valid ? 'json_object' : 'unparseable' });
  }
  return { preserved: changes.every(change => change.kind === 'formatting_only'), changes };
}
// Private attribution input only: changed key names to depth 2, never values. Nested
// names can be private paths, so this result must stay under ignored .runtime/.
function changedKeyPaths(before, after) {
  const paths = [];
  for (const [source] of SETTING_SOURCES) {
    const a = before[source], b = after[source];
    if ((!a && !b) || (a && b && a.bytes.equals(b.bytes))) continue;
    if (!a?.valid || !b?.valid) { paths.push({ source, path: [], whole: true }); continue; }
    for (const key of [...new Set([...Object.keys(a.value), ...Object.keys(b.value)])].sort()) {
      const x = a.value[key], y = b.value[key];
      if (canonicalJson(x) === canonicalJson(y)) continue;
      const nested = [x, y].every(item => item && typeof item === 'object' && !Array.isArray(item))
        ? [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().filter(child => canonicalJson(x[child]) !== canonicalJson(y[child])) : [];
      if (!nested.length) paths.push({ source, path: [key] });
      for (const child of nested) paths.push({ source, path: [key, child] });
    }
  }
  return paths;
}
// Every Claude Code process can write ~/.claude.json, so a settings difference is
// attributable to the launched host only while no other Claude process runs. Matching
// is by image name, which also covers the desktop app; it fails closed.
async function listClaudeProcesses(exec = execFileAsync) {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
  const text = String(stdout).trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return (Array.isArray(value) ? value : [value]).map(item => {
    need(Number.isInteger(item?.pid) && item.pid > 0 && typeof item.created === 'string' && item.created.length > 0, 'claude_process_enumeration_invalid');
    return { pid: item.pid, created: item.created };
  });
}
// Samples during the host run. The owned host is pinned by PID plus the creation time
// first seen for that PID; a writer that starts and exits between samples is not seen.
function createWriterMonitor({ list = listClaudeProcesses, intervalMs = 2000 } = {}) {
  let owned = null, timer = null, samples = 0, failures = 0, pending = Promise.resolve();
  const unowned = new Set();
  const take = async () => {
    try {
      for (const item of await list()) {
        if (owned && item.pid === owned.pid && (owned.created ??= item.created) === item.created) continue;
        unowned.add(`${item.pid}:${item.created}`);
      }
      samples++;
    } catch { failures++; }
  };
  return {
    // Called inside the spawn path, so it never throws: an unusable identity fails exclusion.
    own(pid) { if (!Number.isInteger(pid) || pid <= 0 || owned) failures++; else owned = { pid, created: undefined }; },
    sample() { pending = pending.then(take); return pending; },
    start() { if (!timer) { timer = setInterval(() => { void this.sample(); }, intervalMs); timer.unref?.(); } },
    async stop() { clearInterval(timer); timer = null; await pending; },
    result() {
      return { exclusive: samples > 0 && failures === 0 && unowned.size === 0, unownedProcesses: unowned.size, samples, sampleFailures: failures,
        scope: `Image-name samples every ${intervalMs} ms while the host runs and once after its exit; a writer between samples is not detected.` };
    },
  };
}
// Shareable receipts keep only this file's hash and the overall changed-path count.
async function writePrivateSettingsDiff(evidence, intervals, root = ROOT, io = fs) {
  const folder = path.join(root, '.runtime', 'claude-host', path.basename(evidence));
  await io.mkdir(folder, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, intervals }, null, 2) + '\n');
  await io.writeFile(path.join(folder, 'private-settings-diff.json'), bytes, { flag: 'wx', mode: 0o600 });
  return { sha256: sha(bytes), count: intervals.overall?.length ?? 0 };
}
async function preflightStartup({ home, cwd, managedFiles = [path.join(process.env.ProgramFiles || 'C:/Program Files', 'ClaudeCode/managed-settings.json')] }, io = fs) {
  need((await io.readdir(cwd)).length === 0, 'claude_workspace_not_empty');
  // User settings (including the authorized second-brain SessionStart hook) are
  // inactive with project-only sources. Added directories do not load settings.
  for (const file of managedFiles) {
    let bytes;
    try { const stat = await io.lstat(file); need(stat.isFile() && !stat.isSymbolicLink(), 'claude_startup_configuration_unsafe'); bytes = await io.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const settings = JSON.parse(bytes.toString('utf8'));
    need(settings && typeof settings === 'object' && !Array.isArray(settings), 'claude_startup_configuration_unsafe');
    need(!settings.hooks || Object.values(settings.hooks).every(value => Array.isArray(value) && value.length === 0), 'claude_unexpected_startup_hooks');
    need(!settings.enabledPlugins || Object.values(settings.enabledPlugins).every(value => value === false), 'claude_unexpected_startup_plugins');
  }
  const skills = path.join(home, '.claude/skills'); let skippedReparseEntries = 0;
  for (const name of await io.readdir(skills)) {
    const folder = path.join(skills, name), stat = await io.lstat(folder);
    if (stat.isSymbolicLink()) { skippedReparseEntries++; continue; } // Never inspect unrelated link targets.
    if (!stat.isDirectory()) continue;
    const markerDirectory = path.join(folder, '.claude-plugin');
    try {
      const markerStat = await io.lstat(markerDirectory);
      need(!markerStat.isSymbolicLink() && markerStat.isDirectory(), 'claude_unexpected_skill_plugin');
      await io.lstat(path.join(markerDirectory, 'plugin.json'));
      throw fail('claude_unexpected_skill_plugin');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { settingSources: ['project'], freshWorkspace: true, ordinarySkillPluginsAbsent: true, skippedReparseEntries,
    managedFileScopeOnly: true };
}
async function run(options) {
  if (options.mode === 'plan') return plan(options);
  const supplemental = options.continuationAttempt !== undefined, declared = plan(options);
  // Both original attempts are terminal. A new output directory cannot reopen them.
  need(supplemental, 'historical_attempt_budget_exhausted');
  need(process.platform === 'win32', 'unsupported_platform');
  const evidence = path.resolve(options.directory); await fs.mkdir(path.dirname(evidence), { recursive: true }); await fs.mkdir(evidence);
  await fs.writeFile(path.join(evidence, 'plan.json'), JSON.stringify(plan(options), null, 2) + '\n', { flag: 'wx' });
  if (!supplemental && options.attempt === 2) {
    const prior = JSON.parse(await fs.readFile(path.join(path.resolve(options.prior), 'receipt.json'), 'utf8'));
    need(prior.caseId === plan().caseId && prior.attempt === 1 && ['blocked', 'fail'].includes(prior.status), 'invalid_prior');
  }
  const receipt = { schemaVersion: 1, caseId: HOST_CASE, host: 'Claude Code', status: 'running', ...(supplemental
    ? { historicalAttemptsUsed: 2, continuationAttempt: options.continuationAttempt, lifetimeAttemptOrdinal: options.continuationAttempt + 2, attemptClaimed: false }
    : { attempt: options.attempt }),
    startedAt: new Date().toISOString(), scope: declared.scope, notProven: declared.notProven, transcriptPersisted: false,
    userSettingsWrittenByHarness: false, cleanup: {} };
  const persist = async () => {
    const temporary = path.join(evidence, 'receipt.json.tmp'); await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n');
    await fs.rename(temporary, path.join(evidence, 'receipt.json'));
  };
  const abort = new AbortController(), interrupt = () => abort.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let directory, fixture, beforeSettings, installed, rea, journal, hostStarted = false, guardClosed = false;
  let probedSettings, hostBeforeSettings, hostAfterSettings, monitor;
  const skillDirectory = path.join(os.homedir(), '.claude/skills/trace-computer-use');
  try {
    await persist();
    const prepare = async () => {
    if (supplemental) { receipt.runtimeIntegrity = await runtimeIntegrity(); receipt.setupIntegrityVerified = true; }
    receipt.display = validateDisplay(await native(['display']));
    need((await native(['keystate', 'all'])).down.length === 0, 'input_busy');
    need((await native(['status'])).recoveryRequired === false, 'input_recovery_required');
    beforeSettings = await fingerprintSettings();
    // These Claude invocations occur only in --live, never during preparation or pure tests.
    const version = await execFileAsync(CLAUDE, ['--version'], { windowsHide: true, timeout: 10000, env: hostEnvironment() });
    receipt.hostVersion = version.stdout.match(/\d+\.\d+\.\d+/)?.[0]; need(!!receipt.hostVersion, 'claude_version_unavailable');
    need(supportedHostVersion(receipt.hostVersion), 'claude_fail_closed_hooks_unavailable');
    const auth = JSON.parse((await execFileAsync(CLAUDE, ['auth', 'status'], { windowsHide: true, timeout: 10000, env: hostEnvironment() })).stdout);
    need(auth.loggedIn === true && auth.authMethod === 'claude.ai', 'existing_subscription_required');
    receipt.existingSubscription = true;
    // Both checks run before claim, so either stop consumes no supplemental attempt.
    probedSettings = await fingerprintSettings();
    receipt.settingsIntervals = { hostProbes: compareSettings(beforeSettings, probedSettings) };
    need(receipt.settingsIntervals.hostProbes.preserved, 'claude_probe_changed_settings');
    need((await listClaudeProcesses()).length === 0, 'claude_concurrent_writer');
    installed = await loadInstalledBundle(skillDirectory);
    receipt.installedSkill = { bundleSha256: installed.bundleSha256, files: installed.manifest.files };
    if (supplemental) { rea = await loadReaInstructions(); receipt.installedReaInstructions = { sha256: rea.sha256, scope: 'Instruction discovery only; no REA analysis.' }; }
    const files = await supervisorSourceHashes();
    for (const file of ['scripts/accept-claude-host.cjs', 'scripts/accept-clipboard.cjs', 'src/computer/server.cjs', 'src/computer/controller.cjs', 'tests/fixtures/computer-app/Program.cs']) files[file] = sha(await fs.readFile(path.join(ROOT, file)));
    receipt.testedSource = { baseCommit: (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true })).stdout.trim(), workingTreeModified: true, files, claudeExecutableSha256: sha(await fs.readFile(CLAUDE)) };
    if (supplemental) for (const file of ['scripts/live-acceptance-continuation.cjs', 'scripts/smoke-computer-live.cjs',
      'scripts/accept-supervisor-recovery.cjs', 'bin/trace.cjs', 'src/computer/configuration.cjs', 'src/computer/supervisor.cjs',
      'src/computer/lease.cjs', 'src/computer/winapp-backend.cjs', 'src/computer/activity-indicator.cjs',
      'scripts/replacement-acceptance-common.cjs', 'package.json', 'package-lock.json']) files[file] = sha(await fs.readFile(path.join(ROOT, file)));
    let executable;
    if (supplemental) { const prepared = await preparedFixture(); executable = prepared.executable; receipt.preparedFixture = prepared.summary; }
    else executable = await buildFixture();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-claude-host-')); await fs.mkdir(path.join(directory, 'workspace'));
    receipt.startupPreflight = await preflightStartup({ home: os.homedir(), cwd: path.join(directory, 'workspace') });
    if (abort.signal.aborted) throw fail('acceptance_interrupted');
    return executable;
    };
    let executable;
    if (supplemental) {
      const result = await prepareAndClaimContinuation(options, prepare);
      executable = result.prepared; Object.assign(receipt, result.claim, { attemptClaimed: true });
      await persist(); // Atomic claim is retained before any owned fixture or model launch.
    } else executable = await prepare();
    const payload = `TRACE Claude verified ${randomUUID()}`;
    fixture = await launchOwnedFixture({ executable, directory, signal: abort.signal });
    const initial = await fixture.state(); need(initial.text === '' && initial.count === 0, 'fixture_initial_mismatch');
    const configPath = path.join(directory, 'guard.json'); journal = path.join(directory, 'guard-receipt.json');
    await fs.writeFile(configPath, JSON.stringify({ target: { pid: fixture.pid, title: fixture.title }, payload,
      runtime: path.join(directory, 'runtime'), fixtureState: path.join(directory, 'fixture.json'), journal, display: receipt.display }), { flag: 'wx', mode: 0o600 });
    const mcp = path.join(directory, 'mcp.json');
    await fs.writeFile(mcp, JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath,
      args: [path.join(ROOT, 'scripts/accept-claude-host.cjs'), '--serve-mcp', configPath] } } }), { flag: 'wx', mode: 0o600 });
    const allowedReads = [...installed.files.keys()].map(relative => path.join(skillDirectory, relative));
    const requiredSkills = supplemental ? [TRACE_SKILL, REA_SKILL] : [TRACE_SKILL];
    if (rea) allowedReads.push(rea.path);
    const policy = path.join(directory, 'host-tool-policy.json'), settings = path.join(directory, 'host-settings.json');
    const realReads = Object.fromEntries(await Promise.all(allowedReads.map(async file => [file, await fs.realpath(file)])));
    const sha256Reads = Object.fromEntries([...installed.files].map(([relative, bytes]) => [path.join(skillDirectory, relative), sha(bytes)]));
    if (rea) sha256Reads[rea.path] = rea.sha256;
    await fs.writeFile(policy, JSON.stringify({ allowedReads, realReads, allowedSkills: requiredSkills, sha256Reads,
      traceInstructionPath: path.join(skillDirectory, 'SKILL.md'), ...(rea ? { reaInstructionPath: rea.path } : {}) }), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(settings, JSON.stringify(hostSettings(policy, supplemental)), { flag: 'wx', mode: 0o600 });
    if (abort.signal.aborted) throw fail('acceptance_interrupted');
    hostBeforeSettings = await fingerprintSettings();
    receipt.settingsIntervals.preHost = compareSettings(probedSettings, hostBeforeSettings);
    need(receipt.settingsIntervals.preHost.preserved, 'claude_settings_changed_before_host');
    monitor = createWriterMonitor();
    hostStarted = true; await persist();
    receipt.hostRun = await invokeHost({ config: mcp, cwd: path.join(directory, 'workspace'), home: os.homedir(), settings,
      allowedReads, requiredSkills, reaInstructionPath: rea?.path, prompt: promptFor({ payload, reaInstructionPath: rea?.path }), signal: abort.signal,
      spawnImpl: (...args) => { const child = spawn(...args); monitor.own(child.pid); monitor.start(); return child; } });
    hostAfterSettings = await fingerprintSettings();
    receipt.settingsIntervals.host = compareSettings(hostBeforeSettings, hostAfterSettings);
    let guard;
    for (let i = 0; i < 700; i++) {
      try { guard = JSON.parse(await fs.readFile(journal, 'utf8')); } catch {}
      if (guard?.guardClosed === true) break; await delay(50);
    }
    receipt.guard = guard ?? { unavailable: true };
    if (guard?.guardClosed === true && guard.nodePid) {
      need(guard.ownership?.guardNode?.pid === guard.nodePid && guard.ownership?.productionNode?.pid === guard.productionMcpPid,
        'claude_owned_node_unverified');
      receipt.cleanup.exactOwnedGenerationExits = await verifyOwnershipExit(guard.ownership,
        require('./replacement-acceptance-common.cjs').waitIdentityExit);
      guardClosed = true;
    }
    const final = await fixture.state();
    await delay(200);
    const settled = await fixture.state();
    receipt.effect = { exactSyntheticText: final.text === payload, exactCounter: final.count === 1,
      stableAfterSettling: settled.text === final.text && settled.count === final.count };
    receipt.status = completed(receipt.hostRun, guard, final, payload) ? 'pass' : 'blocked';
    if (!receipt.effect.stableAfterSettling) receipt.status = 'blocked';
    if (receipt.status !== 'pass') receipt.error = { code: receipt.hostRun.diagnostic || 'host_acceptance_incomplete' };
  } catch (error) {
    receipt.status = /^(input_|desktop_|foreground_|indicator_|claude_|existing_|installed_|acceptance_interrupted)/.test(codeOf(error)) ? 'blocked' : 'fail';
    receipt.error = { code: codeOf(error) };
    if (typeof error?.hostStarted === 'boolean') hostStarted = error.hostStarted;
    if (error?.ownedFixtureCleanupUnknown) receipt.cleanup.fixture = { exited: false };
  } finally {
    try {
      const keys = await native(['keystate', 'all']), state = await native(['status']);
      receipt.cleanup.input = { released: keys.down.length === 0, recoveryRequired: state.recoveryRequired === true };
    } catch (error) { receipt.cleanup.input = { available: false, code: codeOf(error) }; }
    // Missing host/guard teardown proof is never repaired by killing cached PIDs or clearing quarantine.
    receipt.cleanup.hostExited = !hostStarted || receipt.hostRun?.processExited === true;
    receipt.cleanup.guardClosed = (!hostStarted || guardClosed) && receipt.cleanup.hostExited;
    if (fixture && receipt.cleanup.guardClosed && receipt.cleanup.input.released && !receipt.cleanup.input.recoveryRequired) {
      try { receipt.cleanup.fixture = await fixture.close(); } catch (error) { receipt.cleanup.fixture = { exited: false, code: codeOf(error) }; }
    }
    if (monitor) {
      await monitor.sample(); await monitor.stop();
      receipt.settingsWriterExclusion = monitor.result();
    }
    if (beforeSettings) {
      let finalSettings;
      try {
        finalSettings = await fingerprintSettings();
        receipt.settingsComparison = compareSettings(beforeSettings, finalSettings);
        if (hostAfterSettings) receipt.settingsIntervals.postHost = compareSettings(hostAfterSettings, finalSettings);
        receipt.userSettingsUnchanged = receipt.settingsComparison.preserved;
      }
      catch { receipt.userSettingsUnchanged = false; }
      // Attribution never changes a block. A change seen while another Claude process may
      // have written stays contaminated; a single-writer change is only a host-window candidate.
      if (receipt.userSettingsUnchanged === false) {
        receipt.settingsAttribution = receipt.settingsWriterExclusion?.exclusive === true && receipt.settingsIntervals?.host?.preserved === false
          && receipt.settingsIntervals.postHost?.preserved === true ? 'host_window_candidate' : receipt.settingsWriterExclusion ? 'contaminated_or_unattributed' : 'unattributed';
        if (finalSettings) {
          try {
            receipt.privateSettingsDiff = await writePrivateSettingsDiff(evidence, { overall: changedKeyPaths(beforeSettings, finalSettings),
              ...(hostBeforeSettings && hostAfterSettings ? { host: changedKeyPaths(hostBeforeSettings, hostAfterSettings) } : {}),
              ...(hostAfterSettings ? { postHost: changedKeyPaths(hostAfterSettings, finalSettings) } : {}) });
          } catch { receipt.privateSettingsDiff = { written: false }; }
        }
      }
    }
    if (installed) {
      try { receipt.installedSkillUnchanged = (await loadInstalledBundle(installed.directory)).bundleSha256 === installed.bundleSha256; }
      catch { receipt.installedSkillUnchanged = false; }
    }
    if (rea) {
      try { const fresh = await loadReaInstructions(); receipt.reaInstructionsUnchanged = fresh.sha256 === rea.sha256 && samePath(fresh.realpath, rea.realpath); }
      catch { receipt.reaInstructionsUnchanged = false; }
    }
    if (supplemental && receipt.testedSource) {
      try {
        receipt.testedSourceUnchanged = await verifyTestedSource(receipt.testedSource);
        receipt.runtimeIntegrityUnchanged = JSON.stringify(await runtimeIntegrity()) === JSON.stringify(receipt.runtimeIntegrity);
        receipt.preparedFixtureUnchanged = (await preparedFixture()).summary.manifestSha256 === receipt.preparedFixture?.manifestSha256;
      } catch { receipt.testedSourceUnchanged = false; }
    }
    receipt.cleanup.confirmed = receipt.cleanup.guardClosed && (!fixture || receipt.cleanup.fixture?.exited === true)
      && receipt.cleanup.fixture?.exited !== false && receipt.cleanup.input.released === true && receipt.cleanup.input.recoveryRequired === false;
    if (!receipt.cleanup.confirmed || receipt.userSettingsUnchanged === false || receipt.installedSkillUnchanged === false
      || receipt.reaInstructionsUnchanged === false || receipt.testedSourceUnchanged === false || receipt.preparedFixtureUnchanged === false
      || receipt.runtimeIntegrityUnchanged === false) receipt.status = 'blocked';
    if (directory && receipt.cleanup.confirmed) {
      try {
        need(path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('trace-claude-host-')
          && !(await fs.lstat(directory)).isSymbolicLink() && await fs.realpath(directory) === directory, 'unsafe_temp_cleanup');
        await fs.rm(directory, { recursive: true }); receipt.cleanup.privateArtifactsRemoved = true;
      } catch (error) { receipt.cleanup.privateArtifactsRemoved = false; receipt.cleanup.confirmed = false; receipt.status = 'blocked'; }
    } else if (directory) receipt.cleanup.privateArtifactsRetained = true;
    receipt.completedAt = new Date().toISOString(); await persist();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  return receipt;
}

if (require.main === module) {
  const task = process.argv[2] === '--host-hook' ? runHostHook(process.argv[3])
    : process.argv[2] === '--serve-mcp' ? serveGuard(process.argv[3]) : run(parseArgs(process.argv.slice(2)));
  task.then(result => { if (result) process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result?.status && result.status !== 'pass') process.exitCode = 1; })
    .catch(error => { process.stderr.write(JSON.stringify({ code: codeOf(error) }) + '\n'); process.exitCode = 1; });
}
module.exports = { plan, parseArgs, prepareAndClaimContinuation, evidenceDescriptor, preparedFixture, verifyTestedSource, loadReaInstructions,
  createOwnershipTracker, verifyOwnershipExit, createGuard, MAX_GUARD_ADMISSIONS, loadInstalledBundle, fingerprintSettings, compareSettings, changedKeyPaths, listClaudeProcesses, createWriterMonitor, writePrivateSettingsDiff, preflightStartup, supportedHostVersion, scopedReadPath, hostToolAllowed, hostSettings, runHostHook,
  streamState, observeEvent, summarize, hostArguments, hostEnvironment, invokeHost, promptFor, completed, run };
