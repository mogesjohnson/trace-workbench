#!/usr/bin/env node
'use strict';

// Opt-in acceptance only. Import/--plan never launches a process or reads the clipboard.
// Initial/final clipboard metadata lives only in runCase's closure, never in a receipt.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const { createClipboardProvider, clipboardSourceHashes, DEFAULT_CLIPBOARD, verifyClipboardFiles } = require('../src/method/clipboard-provider.cjs');
const { DEFAULT_SUPERVISOR } = require('../src/computer/supervisor.cjs');
const { buildFixture, stopFixture } = require('./smoke-computer-live.cjs');
const { stateOf, validateDisplay, compareDisplay } = require('./accept-supervisor-recovery.cjs');
const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = 'TRACE clipboard acceptance — café Ελληνικά 日本語 🙂';
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const requireThat = (condition, code) => { if (!condition) throw failure(code); };
const codeOf = error => /^[A-Za-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'acceptance_failed';
const blocked = code => /^(clipboard_|input_|desktop_|foreground_|display_|indicator_)/.test(code);
const CONTINUATION_CASE = 'METHOD-CLIPBOARD-UNICODE-PASTE';
const continuation = require('./continuation-adapter.cjs');
const continuationBook = require('./live-acceptance-continuation.cjs');

async function preparedFixture() {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, '.runtime/computer-fixture/prepared-manifest.json'), 'utf8'));
  const sources = ['tests/fixtures/computer-app/Program.cs', 'tests/fixtures/computer-app/TraceComputerFixture.csproj', 'scripts/smoke-computer-live.cjs'];
  const outputs = ['TraceComputerFixture.exe', 'TraceComputerFixture.dll', 'TraceComputerFixture.runtimeconfig.json', 'TraceComputerFixture.deps.json'];
  requireThat(manifest?.schemaVersion === 1 && manifest.sources && manifest.files
    && JSON.stringify(Object.keys(manifest.sources).sort()) === JSON.stringify([...sources].sort())
    && JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify([...outputs].sort()), 'clipboard_fixture_manifest_invalid');
  for (const file of sources) requireThat(manifest.sources[file] === sha256(await fs.readFile(path.join(ROOT, file))), 'clipboard_fixture_source_changed');
  for (const file of outputs) requireThat(manifest.files[file] === sha256(await fs.readFile(path.join(ROOT, '.runtime/computer-fixture/bin', file))), 'clipboard_fixture_output_changed');
  return path.join(ROOT, '.runtime/computer-fixture/bin/TraceComputerFixture.exe');
}

async function runtimeSnapshot() {
  await verifyClipboardFiles();
  const result = await continuation.runtimeSnapshot();
  const directory = path.dirname(DEFAULT_CLIPBOARD);
  result['clipboard/manifest'] = sha256(await fs.readFile(path.join(path.dirname(directory), 'manifest.json')));
  for (const extension of ['exe', 'dll', 'runtimeconfig.json', 'deps.json'])
    result[`clipboard/TraceClipboard.${extension}`] = sha256(await fs.readFile(path.join(directory, `TraceClipboard.${extension}`)));
  return result;
}

function plan(options = {}) {
  return {
    schemaVersion: 1, caseId: 'METHOD-CLIPBOARD-UNICODE-PASTE', attempt: options.continuationClaim?.lifetimeAttemptOrdinal ?? options.attempt ?? 1,
    ...(options.continuationClaim ? { ...options.continuationClaim, supplemental: true } : {}),
    declaredBeforeSnapshotAndUi: true,
    ...(options.prior ? { prior: path.relative(ROOT, path.resolve(options.prior)).replaceAll(path.sep, '/'), changedPrecondition: options.change } : {}),
    target: 'One fresh owned WinForms fixture; exact discovered HWND/PID/process creation time and observed edit element.',
    initial: { fixtureText: '', fixtureCount: 0, input: 'No physical input held; no native quarantine.', clipboard: 'Existing supported text-only formats; rich or unsupported formats block before mutation or UI launch.' },
    payload: PAYLOAD,
    actions: ['Declare this plan before clipboard snapshot or UI launch.',
      'Snapshot supported clipboard format hashes privately in memory; write synthetic Unicode text once and verify native readback.',
      'Durably defer automatic clipboard restoration before any fixture/native input; require an explicit quiescence acknowledgement to restore.',
      'Launch one owned fixture and use the production stdio MCP six-tool interface to discover it and focus its exact observed edit.',
      'Confirm public and independent fixture focus; recheck clipboard token/sequence/hash; press CTRL+V exactly once.',
      'Independently compare fixture text with the exact synthetic payload, without retaining raw fixture text.',
      'Attempt sequence/owner-guarded restoration; close its helper; snapshot through a fresh helper and compare original supported-byte hashes only in memory.'],
    expected: { pasteDispatches: 1, exactSyntheticText: true, independentSupportedBytesRestored: true, cleanup: 'confirmed' },
    privacy: 'No original clipboard text, bytes, format hashes, sequences, tokens, or unexpected fixture text in receipts/logs/checkpoints. Temporary captures/fixture state stay outside the repo and are removed after owned teardown.',
    cleanup: 'Drain/close the native session and MCP, independently verify released input/no quarantine, and stop the retained owned fixture ChildProcess before acknowledging quiescence and restoring. Close the clipboard helper afterward. Unknown input or a changed clipboard preserves protected recovery; no automatic abandon/reset/replay.',
    budget: options.continuationClaim ? 'Two preserved historical attempts, then one approved supplemental attempt and at most one corrective continuation in a new directory; lifetime ordinals 3 and 4.'
      : 'One attempt and one explicitly documented corrective retry in a new directory; earlier outcomes are preserved.',
    limits: ['Single pinned observed display; this is a synthetic owned-fixture MCP paste, not an application-specific connector or a model-host workflow.',
      'Readback and native paste are separate operations; a human can change the clipboard between them. Any mismatch or ownership uncertainty stops this case and is never replayed.',
      'Rich formats, interrupted prepared writes, clipboard history and original owner identity are outside the supported-byte restoration guarantee.'],
  };
}

function parseArgs(args) {
  const options = { mode: 'plan', attempt: 1 };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--plan') options.mode = 'plan';
    else if (value === '--live') options.mode = 'live';
    else if (value === '--attempt') options.attempt = Number(args[++i]);
    else if (value === '--prior') options.prior = args[++i];
    else if (value === '--change') options.change = args[++i];
    else if (!value.startsWith('--') && !options.directory) options.directory = value;
    else throw failure('invalid_acceptance_arguments');
  }
  requireThat([1, 2].includes(options.attempt) && (options.mode !== 'live' || !!options.directory)
    && (options.attempt === 1 ? !options.prior && !options.change : !!options.prior && !!options.change), 'invalid_acceptance_arguments');
  return options;
}

// Compare only explicit supported-format byte identity, ignoring owner/sequence changes caused
// by our own verified restore. Callers must never persist either argument or this signature.
function sameSupportedBytes(before, after) {
  const signature = value => value.formats.map(({ id, bytes, sha256: hash }) => ({ id, bytes, hash })).sort((a, b) => a.id - b.id);
  return JSON.stringify(signature(before)) === JSON.stringify(signature(after));
}

async function runCase({ clipboard, preparedSnapshot, freshClipboard, connect, launchTarget, preflight = async () => {},
  inspectInput = async () => ({ safe: true }), persist = async () => {}, signal } = {}) {
  const receipt = { schemaVersion: 1, caseId: plan().caseId, status: 'running', startedAt: new Date().toISOString(),
    snapshot: { supported: false, originalMetadataRetained: false }, paste: { attempted: false, requests: 0, dispatches: 0 }, cleanup: {} };
  let original = null, connection, fixture, session, verification, restoreAttempted = false, mutationAttempted = false;
  const checkAbort = () => { if (signal?.aborted) throw failure('acceptance_interrupted'); };
  const save = () => persist(receipt);
  await save();
  try {
    checkAbort();
    await preflight();
    const ready = await clipboard.doctor();
    requireThat(ready.ready === true, ready.code || 'clipboard_provider_unavailable');
    connection = await connect();
    const doctor = await connection.call('doctor');
    requireThat(doctor.ready === true, doctor.code || 'native_provider_unavailable');
    checkAbort();
    original = preparedSnapshot ?? await clipboard.snapshot();
    receipt.snapshot.supported = true;
    await save();
    checkAbort();
    fixture = await launchTarget();
    const before = await fixture.state();
    requireThat(before?.text === '' && before.count === 0, 'fixture_initial_mismatch');
    const discovery = await connection.call('list_windows');
    const matches = discovery.windows?.filter(item => item.pid === fixture.pid && item.title === fixture.title) || [];
    requireThat(matches.length === 1 && !!matches[0].processCreationTime, 'fixture_identity_unavailable');
    const target = matches[0];
    receipt.target = { windowId: target.id, pid: target.pid, processCreationTime: target.processCreationTime };
    session = await connection.call('open_session', { windowId: target.id });
    requireThat(!!session.sessionId, session.error?.code || 'native_session_unavailable');
    let frame = await connection.call('observe', { sessionId: session.sessionId });
    const edits = frame.elements?.filter(item => item.name === 'TRACE text input' && item.enabled) || [];
    requireThat(edits.length === 1, 'fixture_edit_ambiguous');
    checkAbort();
    const focused = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId,
      action: { type: 'click', elementId: edits[0].id } });
    requireThat(focused.outcome === 'completed', focused.error?.code || 'fixture_focus_uncertain');
    frame = focused.observation;
    const state = await fixture.state();
    // Element IDs belong to their observation. Resolve the intended edit again after focus.
    const currentEdits = frame?.elements?.filter(item => item.name === 'TRACE text input' && item.enabled) || [];
    receipt.focus = { publicHasFocus: frame?.focused?.hasFocus === true,
      publicMatchesObservedEdit: currentEdits.length === 1 && frame?.focused?.elementId === currentEdits[0].id,
      independentMatches: state?.focusedControl === 'traceTextInput', textEmpty: state?.text === '' };
    requireThat(Object.values(receipt.focus).every(value => value === true), 'fixture_focus_mismatch');
    checkAbort();
    // Failed target preparation must not dirty the clipboard or arm deferred recovery.
    mutationAttempted = true;
    const written = await clipboard.writeText({ token: original.token, text: PAYLOAD });
    requireThat(written.verified === true, 'clipboard_readback_mismatch');
    requireThat((await clipboard.readback({ token: original.token })).matches === true, 'clipboard_readback_mismatch');
    requireThat((await clipboard.deferAutomaticRestore({ token: original.token })).automaticRestoreDeferred === true, 'clipboard_defer_unverified');
    receipt.syntheticWrite = { attempted: true, verified: true, automaticRestoreDeferred: true, mode: 'text-only' };
    checkAbort();
    requireThat((await clipboard.readback({ token: original.token })).matches === true, 'clipboard_changed');
    // Persist the attempted boundary before dispatch: an exception/lost reply never permits replay.
    receipt.paste.attempted = true; receipt.paste.requests = 1; receipt.paste.dispatches = null;
    await save();
    let pasted;
    try {
      pasted = await connection.call('act', { sessionId: session.sessionId, observationId: frame.observationId,
        action: { type: 'press_key', key: 'CTRL+V' } });
    } catch (error) { pasted = { outcome: 'unknown', error: { code: codeOf(error) } }; }
    receipt.paste.outcome = ['completed', 'not_dispatched', 'unknown'].includes(pasted.outcome) ? pasted.outcome : 'unknown';
    receipt.paste.dispatches = pasted.outcome === 'completed' ? 1 : pasted.outcome === 'not_dispatched' ? 0 : null;
    // Even a lost MCP reply gets one independent inspection, never a repeated paste.
    const actual = await fixture.state();
    receipt.effect = { exactSyntheticText: actual?.text === PAYLOAD, countUnchanged: actual?.count === 0 };
    requireThat((await clipboard.readback({ token: original.token })).matches === true, 'clipboard_changed');
    receipt.paste.clipboardGuardBeforeAndAfter = true;
    requireThat(receipt.effect.exactSyntheticText && receipt.effect.countUnchanged, 'fixture_paste_mismatch');
    requireThat(pasted.outcome === 'completed', pasted.error?.code || 'paste_delivery_unknown');
    receipt.status = 'pass';
  } catch (error) {
    const code = codeOf(error);
    receipt.status = blocked(code) || code === 'acceptance_interrupted' ? 'blocked' : 'fail';
    receipt.error = { code }; // Do not stringify assertions, helper errors or raw target values.
    if (error?.ownedConnectionCleanupUnknown) receipt.cleanup.mcp = { closed: false, code: 'mcp_startup_cleanup_unknown' };
    if (error?.ownedFixtureCleanupUnknown) receipt.cleanup.fixture = { exited: false, code: 'fixture_startup_cleanup_unknown' };
  } finally {
    if (session && connection) {
      try {
        const result = await connection.call('close_session', { sessionId: session.sessionId });
        receipt.cleanup.nativeSession = { closed: result.closed === true, recoveryRequired: result.recoveryRequired === true };
      } catch (error) { receipt.cleanup.nativeSession = { closed: false, code: codeOf(error) }; }
    }
    if (connection) {
      try { receipt.cleanup.mcp = await connection.close(); }
      catch (error) { receipt.cleanup.mcp = { closed: false, code: codeOf(error) }; }
    }
    try { receipt.cleanup.input = await inspectInput(); }
    catch (error) { receipt.cleanup.input = { safe: false, code: codeOf(error) }; }
    if (fixture) {
      try { receipt.cleanup.fixture = await fixture.close(); }
      catch (error) { receipt.cleanup.fixture = { exited: false, code: codeOf(error) }; }
    }
    receipt.cleanup.ownedResourcesClosed = (!session || receipt.cleanup.nativeSession?.closed === true)
      && (!connection || receipt.cleanup.mcp?.closed === true) && (!fixture || receipt.cleanup.fixture?.exited === true)
      && receipt.cleanup.mcp?.closed !== false && receipt.cleanup.fixture?.exited !== false;
    const inputQuiescent = receipt.cleanup.ownedResourcesClosed && receipt.cleanup.input?.safe === true;
    if (original && inputQuiescent) {
      restoreAttempted = true;
      try {
        const result = await clipboard.restore({ token: original.token, inputQuiescent: true });
        receipt.cleanup.restoration = { attempted: true, inputQuiescenceAcknowledged: true,
          verified: result.restored === true && (!mutationAttempted || result.verified === true), exactSupportedBytes: result.exactSupportedBytes === true };
      } catch (error) {
        receipt.cleanup.restoration = { attempted: true, verified: false, code: codeOf(error),
          ...(codeOf(error) === 'clipboard_changed' ? { currentClipboardPreserved: true } : {}),
          protectedRecovery: mutationAttempted ? 'preserved_if_pending' : 'not_written_by_harness' };
      }
    } else if (original) receipt.cleanup.restoration = { attempted: false, verified: false,
      code: 'clipboard_input_quiescence_required', protectedRecovery: 'preserved_if_pending' };
    try { receipt.cleanup.clipboard = await clipboard.close(); }
    catch (error) { receipt.cleanup.clipboard = { cleanup: 'unknown', code: codeOf(error) }; }
    if (restoreAttempted && receipt.cleanup.restoration.verified && receipt.cleanup.clipboard?.cleanup === 'confirmed') {
      try {
        verification = await freshClipboard();
        requireThat((await verification.doctor()).ready === true, 'clipboard_verification_unavailable');
        const restored = await verification.snapshot();
        receipt.cleanup.independentSupportedBytesRestored = sameSupportedBytes(original, restored);
      } catch (error) { receipt.cleanup.independentVerification = { verified: false, code: codeOf(error) }; }
      finally {
        if (verification) {
          try { receipt.cleanup.verifier = await verification.close(); }
          catch (error) { receipt.cleanup.verifier = { cleanup: 'unknown', code: codeOf(error) }; }
        }
      }
    }
    original = null;
    const unknown = receipt.cleanup.clipboard?.cleanup !== 'confirmed'
      || (restoreAttempted && (!receipt.cleanup.restoration.verified || receipt.cleanup.independentSupportedBytesRestored !== true
        || receipt.cleanup.verifier?.cleanup !== 'confirmed'))
      || (session && receipt.cleanup.nativeSession?.closed !== true)
      || (connection && receipt.cleanup.mcp?.closed !== true)
      || (fixture && receipt.cleanup.fixture?.exited !== true)
      || receipt.cleanup.mcp?.closed === false || receipt.cleanup.fixture?.exited === false
      || receipt.cleanup.input?.safe !== true;
    receipt.cleanup.confirmed = !unknown;
    if (unknown) { if (receipt.status !== 'fail') receipt.status = 'blocked'; receipt.cleanup.outcome = 'unknown'; }
    receipt.completedAt = new Date().toISOString();
    await save();
  }
  return receipt;
}

async function command(args) {
  const result = await execFileAsync(DEFAULT_SUPERVISOR, args, { windowsHide: true, timeout: 19000, maxBuffer: 131072 });
  return JSON.parse(result.stdout.trim());
}

async function connectProduction(runtimeDirectory, pinnedDisplay, signal) {
  const common = require('./replacement-acceptance-common.cjs');
  const { Client } = require('@modelcontextprotocol/client');
  const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'trace-clipboard-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/trace.cjs'), 'computer', 'mcp'],
    cwd: ROOT, env: { ...process.env, TRACE_COMPUTER_RUNTIME: runtimeDirectory }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {}); // Untrusted diagnostics may contain target details; do not persist.
  let nodeIdentity, chain, sessionOpened = false;
  const owned = () => ({ pid: transport.pid, nodeIdentity });
  const close = trackedClose({ client, transport,
    identities: async () => chain ? Object.values(chain) : nodeIdentity ? await common.readOwned(owned()) : [],
    waitExit: common.waitIdentityExit, required: () => !!nodeIdentity && (!sessionOpened || !!chain) });
  try {
    await client.connect(transport, { timeout: 15000, signal });
    nodeIdentity = (await common.processList()).find(value => value.pid === transport.pid && value.parent === process.pid && /^node(?:\.exe)?$/i.test(value.name));
    requireThat(!!nodeIdentity, 'clipboard_node_identity_unverified');
    const tools = await client.listTools({}, { timeout: 10000, signal });
    requireThat(JSON.stringify(tools.tools.map(item => item.name).sort()) === JSON.stringify([
      'trace_computer_act', 'trace_computer_close_session', 'trace_computer_doctor',
      'trace_computer_list_windows', 'trace_computer_observe', 'trace_computer_open_session']), 'mcp_tools_mismatch');
    return {
      async call(name, args = {}) {
        if (name === 'act') compareDisplay(await command(['display']), pinnedDisplay);
        const response = await client.callTool({ name: `trace_computer_${name}`, arguments: args },
          { timeout: 30000, ...(name === 'close_session' ? {} : { signal }) });
        const state = stateOf(response);
        if (response.isError) throw failure(codeOf(state.error));
        if (name === 'open_session') {
          sessionOpened = true;
          chain = await common.readChain(owned());
          requireThat([chain.node, chain.supervisor, chain.marker].every(value => value.sessionId === chain.node.sessionId), 'clipboard_owner_session_mismatch');
        }
        return state;
      }, close,
    };
  } catch (error) {
    try { await close(); }
    catch { error.ownedConnectionCleanupUnknown = true; }
    throw error;
  }
}

// Exact-generation exit is a separate oracle from successful transport.close().
function trackedClose({ client, transport, identities, waitExit, required }) {
  let closing;
  return () => closing ??= (async () => {
    let records = [], firstError;
    try { records = await identities(); } catch (error) { firstError = error; }
    try { await client.close(); } catch (error) { firstError ??= error; }
    try { await transport.close(); } catch (error) { firstError ??= error; }
    const exits = [];
    for (const identity of records) {
      try { await waitExit(identity); exits.push({ ...identity, exited: true }); }
      catch (error) { exits.push({ ...identity, exited: false }); firstError ??= error; }
    }
    if (firstError || !required() || !records.length || exits.some(value => !value.exited))
      throw failure('clipboard_native_exit_unconfirmed');
    return { closed: true, exactGenerationExitConfirmed: true, processes: exits };
  })();
}

async function waitForState(file, signal, startupError = () => null) {
  for (let i = 0; i < 100; i++) {
    if (signal?.aborted) throw failure('acceptance_interrupted');
    if (startupError()) throw startupError();
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (!['ENOENT', 'SyntaxError'].includes(error.code || error.name)) throw error; }
    await delay(50);
  }
  throw failure('fixture_start_timeout');
}

async function launchOwnedFixture({ executable, directory, signal, spawnImpl = spawn,
  readState = waitForState, stop = stopFixture }) {
  const runId = `clipboard-${randomUUID()}`, statePath = path.join(directory, 'fixture.json');
  const child = spawnImpl(executable, ['--run-id', runId, '--receipt', statePath, '--commands', path.join(directory, 'commands.json')],
    { windowsHide: false, stdio: 'ignore', shell: false });
  let startupFailure;
  // A failed CreateProcess emits asynchronously; consume it so cleanup and the terminal
  // sanitized receipt still run. Never terminate any process by an unverified cached PID.
  child.on('error', () => { startupFailure = failure('fixture_launch_failed'); });
  try { await readState(statePath, signal, () => startupFailure); }
  catch (error) {
    if (child.pid) {
      try { await stop(child); }
      catch { error.ownedFixtureCleanupUnknown = true; }
    }
    throw error;
  }
  return { pid: child.pid, title: `TRACE Computer Fixture — ${runId}`, state: () => readState(statePath),
    close: async () => { await stop(child); return { exited: true }; } };
}

async function run(options) {
  if (options.mode === 'plan') return plan(options);
  requireThat(!!options.continuationClaim, 'clipboard_historical_budget_exhausted');
  requireThat(process.platform === 'win32', 'input_unsupported_platform');
  const directory = path.resolve(options.directory);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory); // Every attempt retains a distinct immutable directory.
  const declared = plan(options);
  await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(declared, null, 2) + '\n', { flag: 'wx' });
  if (!options.continuationClaim && options.attempt === 2) {
    const prior = JSON.parse(await fs.readFile(path.join(path.resolve(options.prior), 'receipt.json'), 'utf8'));
    requireThat(prior.caseId === declared.caseId && ['fail', 'blocked'].includes(prior.status) && prior.attempt === 1, 'invalid_prior_acceptance');
  }
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  let privateDirectory, finalReceipt, pinnedDisplay, manifest;
  const persist = async receipt => {
    const output = { ...receipt, ...(options.continuationClaim || {}), attempt: options.continuationClaim?.lifetimeAttemptOrdinal ?? options.attempt, ...(manifest ? { testedSource: manifest } : {}),
      runtime: { node: process.version, platform: process.platform, arch: process.arch }, ...(pinnedDisplay ? { display: pinnedDisplay } : {}) };
    const temporary = path.join(directory, 'receipt.json.tmp');
    await fs.writeFile(temporary, JSON.stringify(output, null, 2) + '\n');
    await fs.rename(temporary, path.join(directory, 'receipt.json'));
    finalReceipt = output;
  };
  try {
    const files = { ...(await require('./replacement-acceptance-common.cjs').sourceHashes('scripts/accept-clipboard.cjs')).files, ...await clipboardSourceHashes() };
    for (const file of ['scripts/accept-clipboard.cjs', 'scripts/accept-supervisor-recovery.cjs', 'scripts/smoke-computer-live.cjs',
      'src/method/clipboard-provider.cjs', 'src/computer/controller.cjs', 'src/computer/server.cjs',
      'src/computer/winapp-backend.cjs', 'bin/trace.cjs', 'tests/fixtures/computer-app/Program.cs',
      'tests/fixtures/computer-app/TraceComputerFixture.csproj']) files[file] = sha256(await fs.readFile(path.join(ROOT, file)));
    for (const file of ['scripts/continuation-adapter.cjs', 'scripts/live-acceptance-continuation.cjs']) files[file] = sha256(await fs.readFile(path.join(ROOT, file)));
    manifest = { baseCommit: (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true })).stdout.trim(), workingTreeModified: true, files, runtimeOutputs: await runtimeSnapshot() };
    const executable = options.continuationClaim ? await preparedFixture() : await buildFixture(); // Never rebuild a prepared fixture while its owned anchor is open.
    manifest.fixtureSha256 = sha256(await fs.readFile(executable));
    manifest.preparedFixtureManifestSha256 = sha256(await fs.readFile(path.join(ROOT, '.runtime/computer-fixture/prepared-manifest.json')));
    manifest.fixtureDllSha256 = sha256(await fs.readFile(path.join(path.dirname(executable), 'TraceComputerFixture.dll')));
    privateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-clipboard-acceptance-'));
    const ownedDirectory = privateDirectory;
    const clipboard = options.preparedClipboard?.clipboard ?? createClipboardProvider();
    await runCase({ clipboard, preparedSnapshot: options.preparedClipboard?.original, freshClipboard: async () => createClipboardProvider(), persist, signal: abort.signal,
      preflight: async () => {
        pinnedDisplay = validateDisplay(await command(['display']));
        requireThat((await command(['keystate', 'all'])).down.length === 0, 'input_busy');
        requireThat((await command(['status'])).recoveryRequired === false, 'input_recovery_required');
      },
      inspectInput: async () => {
        const down = (await command(['keystate', 'all'])).down;
        const state = await command(['status']);
        return { safe: down.length === 0 && state.recoveryRequired === false, keysReleased: down.length === 0, recoveryRequired: state.recoveryRequired === true };
      },
      connect: () => connectProduction(path.join(ownedDirectory, 'runtime'), pinnedDisplay, abort.signal),
      launchTarget: () => launchOwnedFixture({ executable, directory: ownedDirectory, signal: abort.signal }),
    });
  } catch (error) {
    await persist({ schemaVersion: 1, caseId: declared.caseId, status: blocked(codeOf(error)) ? 'blocked' : 'fail',
      error: { code: codeOf(error) }, cleanup: { confirmed: !privateDirectory }, completedAt: new Date().toISOString() });
  } finally {
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    if (manifest && finalReceipt) {
      let unchanged = true;
      for (const [file, hash] of Object.entries(manifest.files)) {
        try { if (sha256(await fs.readFile(path.join(ROOT, file))) !== hash) unchanged = false; }
        catch { unchanged = false; }
      }
      try {
        const executable = path.join(ROOT, '.runtime/computer-fixture/bin/TraceComputerFixture.exe');
        if (sha256(await fs.readFile(executable)) !== manifest.fixtureSha256
          || sha256(await fs.readFile(path.join(path.dirname(executable), 'TraceComputerFixture.dll'))) !== manifest.fixtureDllSha256
          || sha256(await fs.readFile(path.join(ROOT, '.runtime/computer-fixture/prepared-manifest.json'))) !== manifest.preparedFixtureManifestSha256) unchanged = false;
        if (JSON.stringify(await runtimeSnapshot()) !== JSON.stringify(manifest.runtimeOutputs)) unchanged = false;
      } catch { unchanged = false; }
      finalReceipt.sourceUnchangedThroughCleanup = unchanged;
      if (!unchanged) { finalReceipt.status = 'fail'; finalReceipt.error = { code: 'clipboard_tested_source_changed' }; }
    }
    if (privateDirectory && finalReceipt?.cleanup?.ownedResourcesClosed) {
      try {
        // Only the absolute directory returned by mkdtemp is removed, after owned teardown.
        requireThat(path.dirname(privateDirectory) === path.resolve(os.tmpdir()) && path.basename(privateDirectory).startsWith('trace-clipboard-acceptance-'), 'private_directory_mismatch');
        const stat = await fs.lstat(privateDirectory);
        requireThat(stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(privateDirectory) === privateDirectory, 'private_directory_mismatch');
        await fs.rm(privateDirectory, { recursive: true });
        finalReceipt.cleanup.privateArtifactsRemoved = true;
      } catch (error) {
        finalReceipt.cleanup.privateArtifactsRemoved = false; finalReceipt.cleanup.privateArtifactsRetained = true;
        finalReceipt.cleanup.privateArtifactCode = codeOf(error); finalReceipt.cleanup.confirmed = false;
        finalReceipt.cleanup.outcome = 'unknown'; finalReceipt.status = 'blocked';
      }
      await persist(finalReceipt);
    } else if (privateDirectory && finalReceipt) {
      finalReceipt.cleanup.privateArtifactsRemoved = false; finalReceipt.cleanup.privateArtifactsRetained = true;
      await persist(finalReceipt);
    }
  }
  return finalReceipt;
}

async function runContinuation(input, injected = {}) {
  const selected = continuation.options(input, CONTINUATION_CASE);
  if (selected.mode === 'plan') return { ...plan(), ...continuationBook.plan(CONTINUATION_CASE), continuationAttempt: selected.continuationAttempt,
    lifetimeAttemptOrdinal: selected.lifetimeAttemptOrdinal, preflight: 'Privately inspect supported formats, verify prepared fixture, direct current owner idle readiness and exact owned foreground anchor before atomic claim.' };
  const deps = {
    command, compareDisplay, bridge: require('./replacement-acceptance-common.cjs').bridge,
    leaseFree: async () => {
      const { DesktopLease } = require('../src/computer/lease.cjs');
      const lease = new DesktopLease(path.join(os.userInfo().homedir, '.trace-desktop-lease'));
      const owner = `clipboard-preclaim-${randomUUID()}`; await lease.acquire(owner); await lease.release(owner); return true;
    },
    evidence: continuation.evidence, verifyFixture: preparedFixture, verifyRuntime: runtimeSnapshot,
    prepareClipboard: async () => {
      const clipboard = createClipboardProvider();
      try {
        requireThat((await clipboard.doctor()).ready === true, 'clipboard_provider_unavailable');
        const original = await clipboard.snapshot(); // Private memory only; no mutation or durable write.
        return { clipboard, original, close: () => clipboard.close() };
      } catch (error) { await clipboard.close(); throw error; }
    },
    validateDestination: async directory => {
      const destination = path.resolve(directory), relative = path.relative(path.join(ROOT, 'evidence'), destination);
      requireThat(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'clipboard_evidence_directory_invalid');
      try { await fs.lstat(destination); throw failure('clipboard_evidence_directory_exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Resolve the nearest existing parent: reject links escaping the evidence tree before claiming.
      let parent = path.dirname(destination);
      while (true) {
        try {
          const actual = await fs.realpath(parent), inside = path.relative(path.join(ROOT, 'evidence'), actual);
          requireThat(!inside.startsWith('..') && !path.isAbsolute(inside), 'clipboard_evidence_directory_invalid'); break;
        } catch (error) { if (error.code !== 'ENOENT') throw error; parent = path.dirname(parent); }
      }
    },
    probeFormats: async () => {
      const provider = createClipboardProvider(); let result, cleanup;
      try { result = await provider.inspectFormats(); } finally { cleanup = await provider.close(); }
      requireThat(cleanup.cleanup === 'confirmed', 'clipboard_preflight_cleanup_unknown'); return result;
    },
    idlePreflight: continuation.idlePreflight, claimRequest: continuation.claimRequest,
    claim: request => continuationBook.createBookkeeper().claim(request), runOriginal: run,
    persistError: async (directory, receipt) => {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'continuation-error.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    }, ...injected,
  };
  await deps.validateDestination(selected.directory);
  await deps.verifyFixture();
  await deps.verifyRuntime();
  const formats = await deps.probeFormats();
  requireThat(formats.ready === true && formats.supported === true && formats.contentsRead === false && formats.contentsChanged === false
    && formats.recoveryWritten === false && formats.recoveryPending === false, formats.code || 'clipboard_format_preflight_failed');
  const readiness = await deps.evidence(selected.idleReadinessRef);
  const request = await deps.claimRequest(selected, CONTINUATION_CASE);
  const preparedClipboard = await deps.prepareClipboard();
  try {
    const pinnedDisplay = validateDisplay(await deps.command(['display']));
    await deps.idlePreflight({ record: readiness.value, caseId: CONTINUATION_CASE, anchor: readiness.value.anchor, pinnedDisplay }, deps);
    const claim = await deps.claim(request); // No clipboard mutation, fixture or input before accounting.
    try { return await deps.runOriginal({ mode: 'live', directory: selected.directory, continuationClaim: claim, preparedClipboard }); }
    catch (error) {
      const receipt = { ...claim, attempt: claim.lifetimeAttemptOrdinal, status: 'blocked', error: { code: codeOf(error) },
        cleanup: { confirmed: false, outcome: 'unknown' }, completedAt: new Date().toISOString() };
      await deps.persistError(selected.directory, receipt); return receipt;
    }
  } finally {
    // Snapshotted-only close clears private memory without writing. After mutation,
    // the provider preserves protected pending recovery when quiescence is unproved.
    await preparedClipboard.close();
  }
}

if (require.main === module) (process.argv.includes('--continuation')
  ? runContinuation(continuation.parse(process.argv.slice(2), CONTINUATION_CASE)) : run(parseArgs(process.argv.slice(2)))).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status && result.status !== 'pass') process.exitCode = 1;
}).catch(error => { process.stderr.write(JSON.stringify({ code: codeOf(error) }) + '\n'); process.exitCode = 1; });
module.exports = { PAYLOAD, plan, parseArgs, sameSupportedBytes, launchOwnedFixture, runCase, run, runContinuation, preparedFixture, trackedClose };
