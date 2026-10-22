#!/usr/bin/env node
'use strict';
// Retains the exact fixture ChildProcess. The connected conversation supplies every MCP action.
// Import and plan are pure; this driver never constructs an MCP client or synthesizes tool results.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const book = require('./live-acceptance-continuation.cjs');
const continuation = require('./continuation-adapter.cjs');
const ROOT = path.resolve(__dirname, '..');
const CASE = 'CODEX-TRACE-SKILL-NATIVE', PAYLOAD = 'TRACE Codex verified café 日本語';
const STEPS = ['discovery', 'opened', 'focused', 'typed', 'stale-rejected', 'fresh-counter', 'closed'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function plan(options = {}) {
  const attempt = options.continuationAttempt ?? 1;
  need([1, 2].includes(attempt) && options.attempt === undefined, 'invalid_continuation');
  const selected = book.plan(CASE, undefined, options.amendment);
  return { ...selected, continuationAttempt: attempt, lifetimeAttemptOrdinal: attempt + selected.historicalAttemptsUsed,
    ownerDecision: options.decisionRef ?? (options.amendment === 2 ? null : continuation.DECISION), host: 'Actual connected Codex conversation', payload: PAYLOAD,
    initial: { text: '', count: 0 }, actions: STEPS, expected: { text: PAYLOAD, count: 1 },
    cleanup: 'Close actual MCP session; independently verify supervisor and marker exit, attached host Node generation remains alive, all-up input and clear recovery while fixture is alive; close retained fixture.',
    evidence: 'Each ordered checkpoint uses an evidence-relative JSON envelope: source actual-connected-codex, step, tools [{name, arguments, result}], images [{ref, sha256}], modelInspection. discovery includes skillReads; opened includes chain. Before focus/type, --refresh records one actual observe without advancing the semantic step; its envelope has step refresh and nextStep focused or typed. An inline actual observe before the action is also supported. No command dispatches tools or extends server freshness.',
    notProven: ['Other hosts', 'REA analysis', 'REPLAY', 'Release readiness'] };
}
function parseArgs(args) {
  const value = { mode: 'plan', continuationAttempt: 1 };
  const fields = { '--directory': 'directory', '--runtime': 'runtime', '--evidence': 'evidence', '--continuation': 'continuationAttempt', '--continuation-prior': 'continuationPrior', '--change': 'change', '--amendment': 'amendment', '--decision-ref': 'decisionRef' };
  for (let i = 0; i < args.length; i++) {
    if (['--plan', '--start', '--checkpoint', '--refresh', '--finalize', '--abort', '--reconcile'].includes(args[i])) value.mode = args[i].slice(2);
    else { need(fields[args[i]] && args[i + 1] && !args[i + 1].startsWith('--'), 'invalid_arguments'); const field = fields[args[i]]; value[field] = ['continuationAttempt', 'amendment'].includes(field) ? Number(args[++i]) : args[++i]; }
  }
  if (value.amendment !== undefined) need(args.includes('--continuation'), 'explicit_continuation_required');
  if (value.amendment === undefined && value.decisionRef === undefined) value.decisionRef = continuation.DECISION;
  if (value.amendment === 2 && value.mode === 'start') need(!!value.decisionRef, 'amendment_decision_required');
  plan(value); return value;
}
async function ordinaryFile(filename) {
  const absolute = path.resolve(filename); let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep)) { current = path.join(current, part); need(!(await fs.lstat(current)).isSymbolicLink(), 'unsafe_file'); }
  need((await fs.stat(absolute)).isFile(), 'unsafe_file'); return fs.readFile(absolute);
}
async function preparedFixture(root = ROOT) {
  const folder = path.join(root, '.runtime/computer-fixture'), bytes = await ordinaryFile(path.join(folder, 'prepared-manifest.json'));
  const value = JSON.parse(bytes), sources = ['tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj', 'scripts/smoke-computer-live.cjs'];
  const outputs = ['TraceComputerFixture.exe', 'TraceComputerFixture.dll', 'TraceComputerFixture.runtimeconfig.json', 'TraceComputerFixture.deps.json'];
  need(value.schemaVersion === 1 && value.uiCreated === 0 && value.inputActions === 0 && JSON.stringify(Object.keys(value.sources ?? {}).sort()) === JSON.stringify(sources.sort()) && JSON.stringify(Object.keys(value.files ?? {}).sort()) === JSON.stringify(outputs.sort()), 'fixture_manifest_invalid');
  for (const relative of sources) need(sha(await ordinaryFile(path.join(root, relative))) === value.sources[relative], 'fixture_manifest_stale');
  for (const name of outputs) need(sha(await ordinaryFile(path.join(folder, 'bin', name))) === value.files[name], 'fixture_manifest_stale');
  return { executable: path.join(folder, 'bin/TraceComputerFixture.exe'), manifestSha256: sha(bytes), sources: value.sources, files: value.files };
}
async function skillManifest(root = ROOT, home = os.homedir()) {
  const canonical = await require('../src/computer/configuration.cjs').loadSkillBundle(path.join(root, 'skills/trace-computer-use'));
  const trace = {};
  for (const [relative, bytes] of canonical.files) {
    const installed = await ordinaryFile(path.join(home, '.agents/skills/trace-computer-use', relative));
    need(installed.equals(bytes), 'installed_skill_differs'); trace[relative] = sha(installed);
  }
  const rea = await ordinaryFile(path.join(home, '.agents/skills/reverse-engineer-anything/SKILL.md'));
  need(/^name:\s*reverse-engineer-anything\s*$/m.test(rea.toString('utf8')), 'rea_skill_invalid');
  return { trace, traceBundleSha256: canonical.bundleSha256, rea: { 'SKILL.md': sha(rea) } };
}
function resultOf(event, suffix) { return event.tools?.find(tool => tool.name === `mcp__trace_computer__trace_computer_${suffix}` || tool.name === `trace_computer_${suffix}`)?.result; }
function observed(event) { return resultOf(event, 'act')?.observation ?? resultOf(event, 'observe') ?? resultOf(event, 'open_session')?.observation; }
function uniqueElement(observation, automationId, name, controlType) {
  const matches = observation?.elements?.filter(element => element.automationId === automationId && element.name === name && element.controlType === controlType && element.enabled !== false) ?? [];
  need(matches.length === 1 && typeof matches[0].id === 'string', 'semantic_element_ambiguous'); return matches[0];
}
function latestPreAction(context, step) {
  const refresh = context.refreshes?.filter(item => item.beforeStep === step && item.afterStepCount === context.events.length).at(-1);
  return refresh ? observed(refresh.host) : observed(context.events.at(-1)?.host ?? {});
}
function assertFrame(frame, event, context, sessionId) {
  need(frame && frame.sessionId === sessionId && frame.window?.pid === context.target.pid && frame.window?.title === context.target.title, 'session_or_target_mismatch');
  for (const key of ['id', 'processCreationTime', 'sessionId']) if (context.target[key] !== undefined) need(frame.window[key] === context.target[key], 'target_generation_mismatch');
  need(typeof event.modelInspection === 'string' && event.modelInspection.trim() && event.images?.some(image => image.sha256 === frame.screenshot?.sha256), 'tool_image_binding_missing');
}
function assertFocus(frame, state) {
  const edit = uniqueElement(frame, 'traceTextInput', 'TRACE text input', 'Edit');
  need(state.focusedControl === 'traceTextInput' && frame.focused?.available === true && frame.focused.hasFocus === true && frame.focused.binding === 'observed-control' && frame.focused.elementId === edit.id && frame.focused.name === edit.name && frame.focused.controlType === edit.controlType, 'focus_unproven');
}
function validateRefresh(event, state, context) {
  const nextStep = STEPS[context.events.length], sessionId = resultOf(context.events.find(item => item.step === 'opened')?.host ?? {}, 'open_session')?.sessionId;
  need(event?.source === 'actual-connected-codex' && event.step === 'refresh' && event.nextStep === nextStep && ['focused', 'typed'].includes(nextStep), 'refresh_order_invalid');
  need(event.tools?.length === 1 && /trace_computer_observe$/.test(event.tools[0].name) && event.tools[0].arguments?.sessionId === sessionId, 'refresh_requires_actual_observe');
  const frame = resultOf(event, 'observe'); assertFrame(frame, event, context, sessionId);
  need(typeof frame.observationId === 'string' && frame.observationId !== latestPreAction(context, nextStep)?.observationId, 'refresh_observation_unchanged');
  need(state.text === '' && state.count === 0, 'refresh_effect_mismatch');
  if (nextStep === 'typed') assertFocus(frame, state);
  return { count: state.count, textEmpty: true, focusedControl: state.focusedControl };
}
function validateCheckpoint(event, state, context) {
  const step = STEPS[context.events.length];
  need(event?.source === 'actual-connected-codex' && event.step === step && Array.isArray(event.tools), 'checkpoint_order_or_source');
  const actions = event.tools.filter(tool => /trace_computer_act$/.test(tool.name));
  need(actions.length === (['focused', 'typed', 'stale-rejected', 'fresh-counter'].includes(step) ? 1 : 0), 'unexpected_action_count');
  const observation = observed(event);
  const inline = resultOf(event, 'observe');
  if (inline && ['focused', 'typed'].includes(step)) {
    need(event.tools.findIndex(tool => /trace_computer_observe$/.test(tool.name)) < event.tools.findIndex(tool => /trace_computer_act$/.test(tool.name)), 'refresh_must_precede_action');
    need(inline.observationId !== latestPreAction(context, step)?.observationId, 'refresh_observation_unchanged');
  }
  const previousObservation = inline && ['focused', 'typed'].includes(step) ? inline : latestPreAction(context, step);
  const sessionId = resultOf(context.events.find(item => item.step === 'opened')?.host ?? {}, 'open_session')?.sessionId ?? resultOf(event, 'open_session')?.sessionId;
  if (step !== 'discovery') for (const tool of event.tools) {
    if (/trace_computer_(?:act|observe|close_session)$/.test(tool.name)) need(typeof sessionId === 'string' && tool.arguments?.sessionId === sessionId && (tool.result?.sessionId === undefined || tool.result.sessionId === sessionId), 'session_mismatch');
    if (tool.result?.observation) need(tool.result.observation.sessionId === sessionId, 'session_mismatch');
  }
  if (['opened', 'focused', 'typed', 'fresh-counter'].includes(step)) {
    need(typeof event.modelInspection === 'string' && event.modelInspection.trim() && event.images?.length > 0 && observation, 'image_inspection_missing');
    need(observation.window?.pid === context.target.pid && observation.window?.title === context.target.title, 'target_mismatch');
    for (const key of ['id', 'processCreationTime', 'sessionId']) if (context.target[key] !== undefined) need(observation.window[key] === context.target[key], 'target_generation_mismatch');
    need(event.images.some(image => image.sha256 === observation.screenshot?.sha256), 'tool_image_binding_missing');
    for (const frame of [resultOf(event, 'observe'), resultOf(event, 'act')?.observation].filter(Boolean)) {
      assertFrame(frame, event, context, sessionId);
    }
  }
  if (step === 'discovery') need(event.skillReads?.trace === true && event.skillReads?.rea === true && event.skillReads?.references?.includes('operation-and-recovery.md') && event.skillReads.references.includes('readiness-routing.md') && resultOf(event, 'doctor')?.ready === true, 'skill_discovery_missing');
  if (step === 'opened') {
    need(resultOf(event, 'open_session')?.sessionId && event.chain?.length >= 3, 'native_chain_missing');
    need(/^[1-9]\d*$/.test(observation.window.id) && /^\d+$/.test(observation.window.processCreationTime) && Number.isInteger(observation.window.sessionId), 'fixture_generation_missing');
    for (const identity of event.chain) need(Number.isInteger(identity.pid) && /^\d+$/.test(identity.processCreationTime) && Number.isInteger(identity.session) && Number.isInteger(identity.parentPid), 'native_identity_missing');
    need(event.chain.length === 3 && event.chain.some(item => item.role === 'supervisor') && event.chain.some(item => item.role === 'marker') && event.chain.some(item => item.role === 'node'), 'native_chain_missing');
    const node = event.chain.find(item => item.role === 'node'), supervisor = event.chain.find(item => item.role === 'supervisor'), marker = event.chain.find(item => item.role === 'marker');
    need(supervisor.parentPid === node.pid && marker.parentPid === supervisor.pid && event.chain.every(item => item.session === node.session), 'native_parent_chain_mismatch');
  }
  if (['discovery', 'opened', 'focused'].includes(step)) need(state.text === '' && state.count === 0, 'initial_effect_mismatch');
  if (step === 'focused') {
    const before = uniqueElement(previousObservation, 'traceTextInput', 'TRACE text input', 'Edit'), after = uniqueElement(observation, 'traceTextInput', 'TRACE text input', 'Edit');
    need(actions[0].arguments?.action?.type === 'click' && actions[0].arguments.action.elementId === before.id && actions[0].arguments.observationId === previousObservation.observationId, 'focus_action_unbound');
    need(state.focusedControl === 'traceTextInput' && observation.focused?.available === true && observation.focused.hasFocus === true && observation.focused.binding === 'observed-control' && observation.focused.elementId === after.id && observation.focused.name === after.name && observation.focused.controlType === after.controlType && resultOf(event, 'act')?.outcome === 'completed', 'focus_unproven');
  }
  if (['typed', 'stale-rejected', 'fresh-counter', 'closed'].includes(step)) need(state.text === PAYLOAD && state.count === (['fresh-counter', 'closed'].includes(step) ? 1 : 0), 'independent_effect_mismatch');
  if (step === 'typed') {
    const tool = event.tools.find(tool => /trace_computer_act$/.test(tool.name));
    need(tool?.arguments?.action?.type === 'type_text' && tool.arguments.action.text === PAYLOAD && tool.result?.outcome === 'completed' && tool.arguments.observationId === previousObservation?.observationId, 'typing_unproven');
    assertFocus(previousObservation, state);
  }
  if (step === 'stale-rejected') {
    const tool = event.tools.find(tool => /trace_computer_act$/.test(tool.name));
    const typed = context.events.find(item => item.step === 'typed').host;
    const previous = typed.tools.find(item => /trace_computer_act$/.test(item.name));
    need(tool?.arguments?.observationId === previous.arguments.observationId && tool.result?.outcome === 'not_dispatched' && (tool.result.code ?? tool.result.error?.code) === 'stale_observation', 'stale_rejection_unproven');
    const frames = [...context.events, ...(context.refreshes ?? [])].flatMap(item => [observed(item.host), resultOf(item.host, 'observe')]).filter(Boolean);
    const consumed = frames.find(frame => frame.observationId === previous.arguments.observationId), counter = uniqueElement(consumed, 'traceIncrement', 'Increment counter', 'Button');
    need(tool.arguments.action?.type === 'invoke' && tool.arguments.action.elementId === counter.id, 'stale_action_unbound');
  }
  if (step === 'fresh-counter') {
    const fresh = resultOf(event, 'observe'), counter = uniqueElement(fresh, 'traceIncrement', 'Increment counter', 'Button');
    need(fresh?.observationId && actions[0].arguments?.observationId === fresh.observationId && actions[0].arguments?.action?.type === 'invoke' && actions[0].arguments.action.elementId === counter.id && resultOf(event, 'act')?.outcome === 'completed', 'fresh_recovery_unproven');
  }
  if (step === 'closed') {
    need(resultOf(event, 'close_session')?.closed === true && event.nativeExits?.length === 2 && event.nativeExits.every(item => ['supervisor', 'marker'].includes(item.role) && item.exited === true), 'native_exit_unproven');
    need(event.adjudication?.by === 'active-codex-model' && event.adjudication.actualConversationEvidenceReviewed === true && event.adjudication.actualImagesInspected === true, 'external_adjudication_missing');
  }
  return { count: state.count, textExact: state.text === PAYLOAD, textEmpty: state.text === '', focusedControl: state.focusedControl };
}
async function integrityManifest(root = ROOT) {
  const files = {}, outputs = {};
  const sourceNames = ['scripts/accept-codex-host.cjs', 'scripts/accept-clipboard.cjs', 'scripts/accept-supervisor-quarantine.cjs', 'scripts/accept-supervisor-recovery.cjs', 'scripts/live-acceptance-continuation.cjs', 'scripts/continuation-adapter.cjs', 'scripts/replacement-acceptance-common.cjs', 'bin/trace.cjs', 'package.json', 'package-lock.json'];
  for (const name of await fs.readdir(path.join(root, 'src/computer'))) if (/\.(cjs|json)$/.test(name)) sourceNames.push(`src/computer/${name}`);
  for (const [role, folder] of [['supervisor', 'supervisor'], ['bridge', 'window-bridge'], ['indicator', 'activity-indicator']]) {
    const bytes = await ordinaryFile(path.join(root, '.runtime', folder, 'manifest.json')), manifest = JSON.parse(bytes);
    need(manifest.version === 1 && manifest.sources && manifest.files, 'native_manifest_invalid');
    outputs[role] = { manifestSha256: sha(bytes), files: {} };
    for (const [relative, expected] of Object.entries(manifest.sources)) {
      need(/^native\/[A-Za-z0-9_/-]+\.(cs|csproj)$/.test(relative) && !relative.split('/').some(part => part.startsWith('.')), 'native_manifest_invalid');
      const actual = sha(await ordinaryFile(path.join(root, relative))); need(actual === expected, 'native_manifest_stale'); files[relative] = actual;
    }
    for (const [name, expected] of Object.entries(manifest.files)) {
      need(/^[A-Za-z0-9_.-]+$/.test(name) && !name.startsWith('.'), 'native_manifest_invalid');
      const actual = sha(await ordinaryFile(path.join(root, '.runtime', folder, 'bin', name))); need(actual === expected, 'native_output_stale'); outputs[role].files[name] = actual;
    }
  }
  const pinBytes = await ordinaryFile(path.join(root, 'src/computer/winapp-pin.json')), pin = JSON.parse(pinBytes);
  need(/^\d+\.\d+\.\d+$/.test(pin.version), 'engine_pin_invalid'); outputs.engine = { version: pin.version, pinSha256: sha(pinBytes), files: {} };
  for (const [name, expected] of Object.entries(pin.files)) {
    need(/^[A-Za-z0-9_.-]+$/.test(name) && !name.startsWith('.'), 'engine_pin_invalid');
    const actual = sha(await ordinaryFile(path.join(root, '.runtime/winapp', `v${pin.version}`, 'bin', name))); need(actual === expected, 'engine_output_stale'); outputs.engine.files[name] = actual;
  }
  for (const relative of sourceNames.sort()) files[relative] = sha(await ordinaryFile(path.join(root, relative)));
  return { files, outputs };
}
async function defaultPrepare(root) {
  const supervisor = require('../src/computer/supervisor.cjs'); await supervisor.verifySupervisorFiles(); await supervisor.configuration();
  const command = require('./accept-supervisor-quarantine.cjs').command;
  const display = require('./accept-supervisor-recovery.cjs').validateDisplay(await command(['display'])), access = await command(['input-access']), status = await command(['status']), keys = await command(['keystate', 'all']);
  need(access.observable === true && status.recoveryRequired === false && !status.ownerAlive && Array.isArray(keys.down) && keys.down.length === 0, 'desktop_preflight_blocked');
  return { fixture: await preparedFixture(root), skills: await skillManifest(root), display, ...await integrityManifest(root) };
}
async function processProbe(identity) {
  need(Number.isInteger(identity.pid) && identity.pid > 0, 'native_identity_missing');
  const { promisify } = require('node:util'), { execFile } = require('node:child_process');
  const script = `$p=Get-Process -Id ${identity.pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { '{"alive":false}' } else { $c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}'; @{alive=$true;pid=$p.Id;processCreationTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();session=$p.SessionId;parentPid=[int]$c.ParentProcessId}|ConvertTo-Json -Compress }`;
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
  return JSON.parse(result.stdout.trim());
}
async function start(options, injected = {}) {
  if (options.amendment === 2) need(!!options.decisionRef, 'amendment_decision_required');
  const root = injected.root ?? ROOT, declared = plan(options);
  const deps = { prepare: () => defaultPrepare(root), probe: processProbe, claim: request => book.createBookkeeper({ root }).claim(request), claimRequest: input => continuation.claimRequest(input, CASE, { root }), launch: input => require('./accept-clipboard.cjs').launchOwnedFixture(input), command: args => require('./accept-supervisor-quarantine.cjs').command(args), ...injected };
  const prepared = await deps.prepare();
  const directory = path.resolve(root, options.directory ?? '');
  need(path.relative(path.join(root, 'evidence'), directory) && !path.relative(path.join(root, 'evidence'), directory).startsWith('..'), 'evidence_directory_required');
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(declared, null, 2));
  const receipt = { schemaVersion: 1, caseId: CASE, status: 'running', startedAt: new Date().toISOString(), prepared: { ...prepared, fixture: { ...prepared.fixture, executable: undefined } }, events: [], refreshes: [], cleanup: {} };
  const persist = () => fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  const runtime = path.join(root, '.runtime/codex-host', randomUUID()); await fs.mkdir(runtime, { recursive: true });
  let fixture, commandIndex = 0;
  let interrupted = false; const interrupt = () => { interrupted = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    Object.assign(receipt, await deps.claim(await deps.claimRequest({ ...options, mode: 'live', decisionRef: options.decisionRef ?? continuation.DECISION })), { attempt: declared.lifetimeAttemptOrdinal }); await persist();
    fixture = await deps.launch({ executable: prepared.fixture.executable, directory: runtime });
    const initial = await fixture.state(); need(initial.text === '' && initial.count === 0, 'initial_mismatch');
    receipt.target = { pid: fixture.pid, title: fixture.title }; await persist();
    await fs.writeFile(path.join(runtime, 'ready.json'), JSON.stringify({ target: receipt.target, evidenceDirectory: directory }));
    receipt.announced = true;
    await (deps.ready ?? (value => console.log(JSON.stringify(value))))({ ready: true, runtime, target: receipt.target, payload: PAYLOAD });
    for (let index = 1; ; index++) {
      let command;
      for (let polls = 0; ; polls++) { need(!interrupted, 'acceptance_interrupted'); try { command = JSON.parse(await fs.readFile(path.join(runtime, `command-${index}.json`), 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; need(polls < 18000, 'checkpoint_timeout'); await delay(100); } }
      commandIndex = index;
      try {
        need(['checkpoint', 'refresh', 'finalize', 'abort'].includes(command.mode), 'invalid_command');
        if (command.mode === 'abort') throw Object.assign(new Error('owner_aborted'), { code: 'owner_aborted' });
        const loaded = await continuation.evidence(command.evidence, root), event = loaded.value;
        const state = await fixture.state(), independent = command.mode === 'refresh' ? validateRefresh(event, state, receipt) : validateCheckpoint(event, state, receipt);
        if (event.step === 'opened') {
          for (const identity of event.chain) {
            const actual = await deps.probe(identity);
            need(actual.alive === true && ['pid', 'processCreationTime', 'session', 'parentPid'].every(key => actual[key] === identity[key]), 'native_identity_mismatch');
          }
          const window = resultOf(event, 'observe')?.window ?? resultOf(event, 'open_session')?.observation?.window;
          const actual = await deps.probe({ pid: fixture.pid });
          need(actual.alive === true && actual.processCreationTime === window.processCreationTime && actual.session === window.sessionId, 'fixture_generation_mismatch');
          receipt.target = { ...receipt.target, id: window.id, processCreationTime: window.processCreationTime, sessionId: window.sessionId };
        }
        for (const image of event.images ?? []) {
          need(/^evidence\/[a-zA-Z0-9_./-]+\.png$/.test(image.ref) && !image.ref.split('/').some(part => part.startsWith('.')), 'unsafe_image_reference');
          need(sha(await ordinaryFile(path.join(root, image.ref))) === image.sha256, 'image_hash_mismatch');
        }
        if (command.mode === 'refresh') {
          const record = { beforeStep: event.nextStep, afterStepCount: receipt.events.length, at: new Date().toISOString(), independent, hostEvidence: loaded.descriptor, host: event };
          await fs.writeFile(path.join(directory, `refresh-${receipt.refreshes.length + 1}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
          receipt.refreshes.push(record); await persist();
          await fs.writeFile(path.join(runtime, `reply-${index}.json`), JSON.stringify({ step: 'refresh', nextStep: event.nextStep, observationId: resultOf(event, 'observe').observationId, independent, status: 'running' })); continue;
        }
        if (event.step === 'closed') {
          need(command.mode === 'finalize', 'finalize_required');
          const frozen = await deps.prepare();
          for (const key of ['fixture', 'skills', 'display', 'files', 'outputs']) need(JSON.stringify(frozen[key]) === JSON.stringify(prepared[key]), 'frozen_sources_or_display_changed');
          await verifyCleanup(receipt, deps);
          receipt.cleanup.fixture = await fixture.close(); fixture = null;
          need(receipt.cleanup.fixture?.exited === true, 'fixture_exit_unconfirmed');
          receipt.status = 'pass';
          receipt.adjudication = { ...event.adjudication, scope: 'Actual connected conversation and image inspection attested by active Codex model; manually supplied envelopes are not authenticated tool provenance.' };
        } else need(command.mode === 'checkpoint', 'checkpoint_required');
        receipt.events.push({ step: event.step, at: new Date().toISOString(), independent, hostEvidence: loaded.descriptor, host: event });
        await persist(); await fs.writeFile(path.join(runtime, `reply-${index}.json`), JSON.stringify({ step: event.step, independent, status: receipt.status }));
        if (receipt.status === 'pass') break;
      } catch (error) { await fs.writeFile(path.join(runtime, `reply-${index}.json`), JSON.stringify({ status: 'blocked', code: error.code ?? 'checkpoint_failure' })); throw error; }
    }
  } catch (error) {
    receipt.status = 'blocked'; receipt.error = { code: /^[a-zA-Z0-9_-]+$/.test(error.code ?? '') ? error.code : 'lifecycle_failure' };
    if (fixture) try { await verifyCleanup(receipt, deps); receipt.cleanup.fixture = await fixture.close(); fixture = null; } catch { receipt.cleanup.blocked = true; }
    if (fixture) {
      receipt.primaryOutcome = { status: receipt.status, error: receipt.error };
      receipt.cleanup.fixtureRetained = true; await persist();
      await (deps.ready ?? (value => console.log(JSON.stringify(value))))({ cleanupPending: true, runtime, target: receipt.target, status: 'blocked', next: 'Explicit --reconcile with actual cleanup-only evidence; no input or MCP operations are performed by reconciliation.' });
      // Keep the owned ChildProcess handle live until a separate explicit cleanup command.
      // A failed reconciliation records its outcome and waits; it never retries any input.
      for (let index = commandIndex + 1; fixture; index++) {
        let request;
        while (!request) { try { request = JSON.parse(await fs.readFile(path.join(runtime, `command-${index}.json`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; await delay(100); } }
        try {
          need(request.mode === 'reconcile' || request.mode === 'finalize', 'cleanup_reconcile_required');
          const loaded = await continuation.evidence(request.evidence, root), record = loaded.value;
          need(record.source === 'actual-connected-codex' && record.step === 'cleanup-only' && record.adjudication?.by === 'active-codex-model' && record.adjudication.actualConversationEvidenceReviewed === true, 'cleanup_evidence_required');
          if (!receipt.events.some(event => event.step === 'opened')) {
            need(record.chain?.length === 3 && ['node', 'supervisor', 'marker'].every(role => record.chain.some(identity => identity.role === role && Number.isInteger(identity.pid) && /^\d+$/.test(identity.processCreationTime) && Number.isInteger(identity.session))), 'native_chain_missing');
            receipt.events.push({ step: 'cleanup-only', host: { chain: record.chain }, hostEvidence: loaded.descriptor });
          }
          await verifyCleanup(receipt, deps); receipt.cleanup.fixture = await fixture.close(); fixture = null;
          receipt.cleanup.blocked = false; receipt.cleanup.fixtureRetained = false; await persist();
          await fs.writeFile(path.join(runtime, `reply-${index}.json`), JSON.stringify({ status: 'blocked', primaryOutcome: receipt.primaryOutcome, cleanup: receipt.cleanup }));
        } catch (cleanupError) {
          receipt.cleanup.lastError = /^[a-zA-Z0-9_-]+$/.test(cleanupError.code ?? '') ? cleanupError.code : 'cleanup_failure'; await persist();
          await fs.writeFile(path.join(runtime, `reply-${index}.json`), JSON.stringify({ status: 'blocked', code: receipt.cleanup.lastError, fixtureRetained: true }));
        }
      }
    }
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); receipt.cleanup.fixtureRetained = !!fixture; receipt.completedAt = new Date().toISOString(); await persist(); }
  return receipt;
}
async function verifyCleanup(receipt, deps) {
  const keys = await deps.command(['keystate', 'all']), status = await deps.command(['status']);
  need(Array.isArray(keys.down) && keys.down.length === 0 && status.recoveryRequired === false && !status.ownerAlive, 'cleanup_unconfirmed');
  receipt.cleanup.input = { keysDown: [], recoveryRequired: false, ownerAlive: false };
  const opened = receipt.events.find(event => ['opened', 'cleanup-only'].includes(event.step))?.host;
  need(opened || !receipt.announced, 'native_cleanup_evidence_missing');
  for (const identity of opened?.chain ?? []) {
    const current = await deps.probe(identity);
    if (identity.role === 'node') need(current.alive === true && current.processCreationTime === identity.processCreationTime && current.session === identity.session, 'persistent_host_identity_changed');
    else need(current.alive === false || current.exited === true || current.processCreationTime && current.processCreationTime !== identity.processCreationTime, 'native_exit_unconfirmed');
  }
  if (opened) receipt.cleanup.hostNode = 'Persistent attached host resource; exact generation remains alive, never terminated by driver.';
  receipt.cleanup.nativeChainVerified = !!opened;
}
async function submit(options, root = ROOT) {
  need(options.runtime, 'runtime_required');
  const runtime = path.resolve(options.runtime), base = path.join(root, '.runtime/codex-host');
  need(!path.relative(base, runtime).startsWith('..') && path.relative(base, runtime), 'runtime_invalid');
  await ordinaryFile(path.join(runtime, 'ready.json'));
  const entries = await fs.readdir(runtime); let index = 1;
  while (entries.includes(`command-${index}.json`)) { need(entries.includes(`reply-${index}.json`), 'command_pending'); index++; }
  await fs.writeFile(path.join(runtime, `command-${index}.json`), JSON.stringify({ mode: options.mode, evidence: options.evidence }), { flag: 'wx' });
  for (let i = 0; i < 600; i++) { try { return JSON.parse(await fs.readFile(path.join(runtime, `reply-${index}.json`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; await delay(100); } }
  throw Object.assign(new Error('reply_timeout'), { code: 'reply_timeout' });
}
module.exports = { CASE, PAYLOAD, STEPS, plan, parseArgs, preparedFixture, skillManifest, integrityManifest, validateCheckpoint, validateRefresh, start, submit, verifyCleanup };
if (require.main === module) {
  Promise.resolve().then(() => { const options = parseArgs(process.argv.slice(2)); return options.mode === 'plan' ? plan(options) : options.mode === 'start' ? start(options) : submit(options); })
    .then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.code ?? 'codex_lifecycle_failure'); process.exitCode = 1; });
}
