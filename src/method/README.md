# Computer Use method library

`require('./src/method/index.cjs')` exports `ComputerMethod`, `ProviderRegistry`, `createTraceProvider`, `createBrowserProvider`, `createApplicationProvider`, `createClipboardProvider`, `createLocalArtifactProvider`, `verifyArtifactHandoff`, and `mapPoint`. This original library composes available providers above the existing six native tools; it introduces no MCP server or application permission tiers. It is an operational coordination layer. A model still plans actions and interprets application state.

Run the portable simulation with `node examples/method/report.cjs`, or the actual owned non-GUI application example with `node examples/method/application.cjs`. Run the method checks with `node --test tests/method*.test.cjs`. Tests distinguish simulated coordination, real in-memory MCP schema/transport, local filesystem identity, owned child processes and optional actual headless browser execution. Native desktop and model-host acceptance remain separate.

## Goals, effects and steps

```javascript
const { ComputerMethod, createTraceProvider } = require('./src/method/index.cjs');
const native = createTraceProvider({ client: connectedMcpClient,
  environment: 'local', app: 'editor', windowId: exactDiscoveredWindowId,
  accessibilityDepth: 12 });
const readiness = await native.doctor();
if (!readiness.ready) throw new Error(readiness.reason);
const method = new ComputerMethod({ providers: [native],
  verifyStep: async ({ checkId, before, after, receipt }) => inspectStep(checkId, after),
  verifyEffect: async ({ checkId, after, steps }) => inspectSavedArtifact(checkId, after)
});
method.start({ goalId: 'prepare-report', effects: [{ id: 'report', checkId: 'saved-report',
  steps: ['focus', 'type', 'save'].map(id => ({ id, checkId: id,
    capability: 'native-action', target: { environment: 'local', app: 'editor', kind: 'app',
      windowId: exactDiscoveredWindowId } }))
}] });
try {
  for (const [stepId, action] of groundedActions) {
    await method.discover('report', stepId);
    const observation = await method.observe('report', stepId);
    // Derive action fields/element IDs from this current observation.
    await method.execute('report', stepId, action);
    await method.verifyStep('report', stepId);
  }
  const result = await method.verifyEffect('report');
} finally { await method.close(); }
```

Each step owns its initial dispatch and at most one corrective retry. Normal focus, typing and Save steps do not consume one shared effect retry budget. A preceding normal step needs independent verification before the next is dispatched. Verifiers return `confirmed`, `absent`, or `unknown`; exceptions become unknown. An input receipt cannot complete the user effect. The final effect predicate may inspect a separately read file or actual application state, including resolving a Save whose reply was lost, without resubmitting it.

`appendStep(effectId, spec)` supports newly discovered grounded steps. The model must preserve the requested effect rather than replace it with a completed click. `dependsOn: ['other-effect']` requires verified predecessor effects and rejects dependency cycles. A completed effect cannot gain new mutation steps.

## Routing and adapters

A registry provider advertises `{id, channel, available, environments, apps, capabilities, windowIds?}`. Channels are `app-connector`, `browser`, and `desktop`, in that preference order; browser routes require `target.kind: 'web'`. An explicit step `channel` selects one. When a target supplies `windowId`, advertised `windowIds` must contain that exact binding before ranking providers. Native, browser and application providers advertise their exact window, page or recipe-slot identity. Available means the real provider is connected and ready; installing guidance does not register a browser. An attempted step stays pinned to its original provider and target lifetime.

UI providers implement asynchronous `discover(target)`, `observe({target})`, `act({target,observationId,capability,payload})`, and `close({target,releaseOnly:true})`. Discovery returns exactly one exact environment/app/window reference, optionally with `identity: {pid,processName,generation}` and `ownerWindowId`. A capture contains `{id,target,evidenceKey,evidence}`. Capture IDs identify fresh reads; evidence keys identify relevant measured state. An action returns `{delivery:'delivered'|'not-delivered'|'unknown', preparation?, errorCode?, blocked?, cleanup?}`. Close reports `cleanup:'confirmed'` only after owned session release; attached user resources stay open.

`usesDesktop` defaults to true for desktop channels and false otherwise. Other channels that send native input must explicitly set it true. Unknown work blocks related effects and affected desktop input. A distinct effect may declare `independent:true` on a non-desktop API step to continue only if it does not depend on or change unresolved work. The coordinator leaves unresolved desktop ownership untouched in that case. These provider independence declarations and semantic verifiers are trusted integration assertions, not a security boundary.

The native adapter accepts a connected `client`, or injected `callTool` plus `listTools`, or an explicit tool schema snapshot `tools`. `doctor()` checks all six advertised tools and executor readiness. Requested depth is passed only to observation when its live schema advertises `accessibilityDepth`; unsupported custom depth fails visibly. Native actions retain the executor's primary outcome, preparation and recovery independently. Public focus is surfaced with provenance or an unavailable reason. Full native dispatch validation remains in TRACE's executor.

Native `observe()` validates one PNG against its original whole-MCP-content index, canonical bounded base64, PNG signature/IHDR dimensions and SHA-256. It checks exact session, discovered process lifetime (including Windows session metadata when present), owner and observation identity before installing a capture. A complete process creation time is required. Invalid refreshes and repeated IDs invalidate the adapter's previous capture; identical pixels under distinct new IDs remain valid.

Returned `evidence.contentIndexSpace` is `images`: read the validated image as `evidence.images[evidence.state.screenshot.contentIndex]`. That index is remapped to 0; `screenshot.sourceContentIndex` preserves its original MCP position. Returned metadata and the adapter's private capture are separate copies. The internal validator can also accept a nested observation with its original content array; post-action evidence reuse is a separate future change. Header/hash consistency does not decode all pixels, authenticate a producer or prove capture freshness; native fresh-observation authority remains unchanged.

Native `act()` now retains a validated `resultingObservation` only from a non-error completed response declaring `verification: 'fresh_observation'`, a valid action ID and no cleanup uncertainty. It validates the nested observation against the original MCP image array and privately bound target/session. The result is marked `authority: 'verification-only'`; `resultingState` aliases its state for existing integrations. Invalid evidence is discarded without relabeling known delivered input as failed or retrying it. A contradictory MCP error with a completed outcome remains unknown.

The optional `postActionEvidence` token refers to a private process-local snapshot, action/request IDs and original source `observedAt`. Its age is conservatively bounded by adapter-local monotonic elapsed time since the act request began, not time since receipt or a subtraction across clock domains. Lifecycle changes invalidate it; copying/serializing its opaque marker cannot recreate a registered token. It is not an authentication boundary against arbitrary in-process code or a dishonest producer. Post-action frames never install the adapter's private input capture: another mutation requires normal fresh observation. Coordinator reuse is opt-in and described below when enabled.

Optional provider `validateAction(request)` runs before consuming the attempt. The native adapter reuses TRACE's canonical action validator, so unknown fields, stale element IDs, and invalid coordinates fail before dispatch and do not become phantom uncertain inputs.

## Real structured browser adapter

`createBrowserProvider({page,pageId,environment,app:'browser',allowedUrls?,allowedOrigins?,ownership:'attached'|'created',timeoutMs?,generation?})` accepts an actual connected Playwright Page. It imports no browser automation package, launches no browser and downloads no runtime. Supply an explicit existing page, stable tab identity and at least one exact permitted URL or origin, then call `doctor()`. The caller owns browser connection/bootstrap. Provider readiness is established by reading the supplied page; a registry declaration cannot invent it.

The adapter uses public [Playwright page](https://playwright.dev/docs/api/class-page) and [locator](https://playwright.dev/docs/api/class-locator) methods. Observations contain the current URL/origin/title, an ARIA snapshot, PNG screenshot, bounded console/page/network diagnostics and any explicit readback. Operations use exact semantic `{role,name}`, `{label}`, or `{text}` locators. Supported payload types are `fill`, `click`, `press`, `check`, `select`, `navigate`, and `read`; a read declares `property:'text'|'value'|'checked'`. Use `capability:'browser-action'` for mutations/navigation, and `capability:'browser-read'` for reads. Browser step targets use `kind:'web'`.

Control ambiguity, visibility and enabled state are checked before dispatch. Navigating invalidates previous observations, including same-URL document reloads. The adapter rechecks page lifetime and current URL/origin, never extracts state with arbitrary JavaScript evaluation, and never retries an uncertain operation through a fallback URL/provider. The host should reuse the same adapter for a retained page; after reconnect, supply a verified stable `generation` only if it proves the same page lifetime. The default new adapter generation intentionally rejects unsafe checkpoint rebinding.

`method.close()` releases coordinator use while leaving the tab open. Browser `provider.dispose()` removes listeners and closes a page only when it was explicitly declared `ownership:'created'`. Attached pages remain open. The host must call disposal in its final cleanup for pages it created; transitions must retain pages needed later.

Real browser acceptance is in `tests/method-browser.test.cjs`. Set `TRACE_PLAYWRIGHT_MODULE` to an installed Playwright module directory and `TRACE_BROWSER_EXECUTABLE` to a browser executable, then run that test. No dependency is installed by the test. The owned loopback fixture verifies form fill/submission, actual navigation, semantic reads, console diagnostics, one-save reconciliation after a deliberately lost reply, and attached/created tab cleanup. The observed run used headless Edge, so it establishes structured browser execution in an isolated test context and does not establish visible-desktop browser input or a model-host workflow.

## Known-application recipe lifecycle

`createApplicationProvider` executes one trusted host-configured recipe with Node's `spawn` and `shell:false`. Public actions cannot select an executable, environment variables or arbitrary arguments. Configure an exact host environment, application, absolute executable/root/profile directories and absolute document roots before calling `doctor()`:

```javascript
const application = createApplicationProvider({
  hostEnvironment: 'local',
  recipe: {
    id: 'known-editor', app: 'editor', environment: 'local',
    executable: knownExecutable, root: ownedRoot,
    profile: { id: 'isolated-demo', root: ownedProfileRoot },
    documentRoots: [ownedDocuments], extensions: ['.txt'],
    arguments: ['--profile', '{profileRoot}', '{document}']
  },
  inspectOwnership: inspectOwnedProcess
});
if (!(await application.doctor()).ready) throw new Error('Recipe unavailable');
// Register application with ComputerMethod. Each step still needs discover/observe.
// capability: 'application-launch', payload: {type:'launch', documentPath}
// capability: 'application-attach', payload: {type:'attach', pid, generation, documentPath}
// capability: 'application-read', payload: {type:'read'}
```

The flags above illustrate a configured recipe; the host must use that application's actual documented arguments. Whole argument tokens may be `{document}`, `{profileRoot}`, `{profileId}`, `{root}` or `{environment}`. `{document}` is required. Real-path checks require a regular document within the configured roots and optional extension list. Profile and document roots must remain inside the configured root. This allowlist is trusted configuration, not a sandbox or a remote execution service. `usesDesktop` defaults to `true` because application launch may change the desktop; set it `false` only for a known non-GUI recipe. Optional `timeoutMs` is at most 15 seconds; `ipc:true` enables a private child IPC channel for a recipe that actually supports it.

`inspectOwnership({pid,child,environment,app})` is a required actual OS/application inspector, returning `{pid,generation,executable,environment,profileId,profileRoot,root,documentPath}`. A generation must identify that process lifetime; a PID, title or supplied launch argument alone is insufficient. The provider rechecks identity before observations, reads and disposal. Optional `documentProof:{opened:true,sha256,bytes}` is retained only when the inspector actually proves those document bytes were opened. Launch receipt success does not establish editing or saving. A GUI recipe needs its own real inspector; this module does not manufacture one.

Launch and attach are separate operations. Attach requires an already observed PID and generation and never spawns a fallback. A pending or bound process blocks another launch/attach. Post-spawn inspection uncertainty preserves the created child and cleanup quarantine. The logical recipe slot has its own lifetime binding; creating a new adapter does not silently authorize a saved checkpoint to resume against a new process.

`method.close()` releases coordinator use and leaves the application open. The host explicitly calls `application.dispose()` after finishing: it revalidates and terminates only the direct child created by this adapter, awaiting exit. Attached resources are preserved. A changed process generation, unsuccessful termination or uncertain exit retains unknown cleanup and blocks readiness; disposal is not a generic GUI save/quit protocol or an application process-tree manager.

The runnable [application example](../../examples/method/application.cjs) uses the [source-owned IPC fixture](../../examples/method/application-fixture.cjs). [Eight recorded cases](../../evidence/computer-use-method/application/receipt.json) exercised actual non-GUI children, challenged per-instance IPC generation, literal Unicode/space arguments, document-byte readback, exact profile routing and cleanup failure. They do not prove generic Windows creation-time/profile inspection or native GUI application support.

## Text-only clipboard transactions

`createClipboardProvider({environment:'local',helperPath?,transport?,timeoutMs?})` is a direct transaction API over the source-owned Windows helper. Its `app-connector` descriptor advertises `clipboard-text-transaction`; it does not implement the coordinator's UI `discover/observe/act` lifecycle or acquire desktop input ownership. Use its methods directly, with a separately targeted TRACE input session for paste. The default helper is local; an environment label does not create remote clipboard access. `doctor()` verifies helper readiness and reports pending recovery instead of granting fresh access.

`inspectFormats()` is a separate read-only preflight. It enumerates format identifiers without reading data, creating a snapshot/transaction, registering an ownership marker or writing recovery. It returns supported text format IDs, counts, fixed unsupported categories and pending-recovery status; no arbitrary registered names, original bytes, hashes, sequence, owner or token leave the helper. Inspection does not enable transactions or clear recovery. A later snapshot must revalidate support because another app can change the clipboard. Unsupported rich formats remain preserved.

```javascript
const clipboard = createClipboardProvider();
try {
  const formats = await clipboard.inspectFormats();
  if (!formats.ready) throw new Error(formats.code);
  const readiness = await clipboard.doctor();
  if (!readiness.ready) throw new Error(readiness.code);
  const { token } = await clipboard.snapshot();
  await clipboard.writeText({ token, text: syntheticText });
  await clipboard.readback({ token });
  await clipboard.deferAutomaticRestore({ token }); // Await durable acknowledgement.
  await pasteOnceIntoExactObservedTarget();         // Host's actual TRACE workflow.
  await drainAndIndependentlyVerifyOwnedInput();    // Must throw if unresolved.
  await clipboard.restore({ token, inputQuiescent: true });
} finally {
  const cleanup = await clipboard.close();
  // cleanup:'unknown' remains unresolved; never reset, replay or clear it silently.
}
```

The host functions in this sequence are integration obligations, not exports or simulated native proof. Before acknowledging input quiescence, stop/drain the owned native session and MCP client, independently check all declared input is released and native quarantine is clear, and close the owned paste fixture/target when the workflow requires it. The helper cannot perform or infer those checks. Restoring private original clipboard data while an uncertain paste may still execute can expose that data to the target.

`snapshot()` retains original raw bytes only in the helper, returning an opaque token, sequence and supported-format identity metadata. Supported formats are `CF_TEXT`, `CF_OEMTEXT`, `CF_UNICODETEXT` and `CF_LOCALE` (IDs 1, 7, 13 and 16); rich or other unsupported formats are rejected before mutation. `writeText({token,text})` permits one bounded Unicode write per transaction, stores protected recovery intent before mutation, and verifies readback. `readback({token})` verifies sequence, ownership, marker and written bytes without returning text. Keep tokens, original format hashes and snapshot metadata out of logs and checkpoints; the coordinator does not manage them.

**Before any native paste request**, call `deferAutomaticRestore({token})` and wait for `{automaticRestoreDeferred:true,requiresInputQuiescence:true}`. The requirement is durable. An armed transaction never automatically restores on `close()` or helper EOF: it returns unknown cleanup and retains DPAPI-protected recovery state. Once native input is actually quiescent, `restore({token,inputQuiescent:true})` performs the usual guarded restoration. The flag is a trusted host acknowledgement, not an independent OS guarantee. An unarmed direct transaction retains its ordinary guarded close/restore behavior.

After interruption, `recoveryInfo()` reports opaque recovery metadata including `requiresInputQuiescence`; `recover({inputQuiescent:true})` attempts the same guarded recovery after host checks. Changed clipboard ownership/sequence/content prevents restoration and preserves the current clipboard. A closed helper's owner identity may make recovery unverifiable; retained recovery bytes do not guarantee a safe restore. `abandon({token})` explicitly preserves the current clipboard and archives recovery; it is a deliberate resolution API and is never an automatic acceptance fallback.

The helper preserves supported format bytes, not the original clipboard owner, history, rich data or semantic application behavior. Pure injected-provider/native service checks exercise guards and recovery without calling actual clipboard APIs. Live owned Unicode paste and independent original-byte restoration remain a separate acceptance gate; see [gap status](../../docs/GAP_CLOSURE_STATUS.md). No model-host or general application paste claim follows from this API.

## Modal transitions, freshness and recovery

For an owned dialog, set `target.parentStepId` to the parent step in the same effect. Its discovered `ownerWindowId` must match the parent's exact window; same PID or a similar title is insufficient. A known non-dispatched blocked-parent rejection is a targeting condition, so the coordinator can release the parent session and observe the enabled owned dialog. True physical cleanup uncertainty remains quarantine and cannot be cleared by changing windows/providers.

Each capture expires (default 5 seconds), authorizes one action, and is invalidated before a refresh starts, including failed refreshes. Target transitions require new discovery; desktop sessions release before another target in the same environment is observed. Failed release quarantines the old target and stops the transition. Changed evidence plus confirmed absence permits one corrective retry for that step.

`recover(effectId,stepId)` exists only when the provider implements a real recovery operation. It must affirm `{verified:true,inputReleased:true,ownedProcessExited:true}`. This trusted executor proof clears cleanup quarantine for the same bound target; it leaves unknown effects unresolved and forces rediscovery. The six-tool native adapter fabricates no physical proof; a host may inject a verified `recover` callback from its actual supervisor/recovery interface. In-memory method state does not establish durable OS crash recovery.

`mapPoint` converts declared full-frame preview/normalized coordinates. Its default output is TRACE's window-local physical pixels. Screen coordinates require explicit `output:'physical-screen-pixels'`. Current capture identity, dimensions and origin are mandatory. Cropping, CSS pixels and DPI are never inferred.

## Checkpoints and artifacts

`method.checkpoint()` returns a minimal JSON projection with hashed goal/effect/step/provider/target bindings, enum state, counts and uncertainty. It stores no raw identifiers, typed payloads, screenshots, arbitrary provider output or error messages. Protect checkpoint integrity; hashes are equality checks, not encryption or authentication. Keep credentials out of identities and host logs.

`ComputerMethod.resume(snapshot,{goalId,effects,providers,verifyStep,verifyEffect})` requires the exact original descriptor list, including appended steps. It preserves per-step attempts, uncertainty, cleanup and process-generation binding. All effects require fresh discovery and revalidation, even if previously complete. A checkpoint cannot authorize safe replay. Missing original providers or replaced process lifetimes remain blocked. Checkpoint persistence is caller-managed; this library writes no state files automatically.

`createLocalArtifactProvider()` supplies real local regular-file SHA-256 and byte counts, with change-during-read detection. `verifyArtifactHandoff(registry,{source:{environment,path},destination:{environment,path},expectedSha256?,expectedBytes?})` requires absolute paths and checks both named environments independently. Spaces/Unicode are supported. It never assumes a local file exists remotely, never transfers files, and reports `transferPerformed:false`. Remote transfer, application-specific editing, visible native browser operation and model-host workflow acceptance require their own implementation and evidence; a registry entry alone supplies none of them.
