# Observation cost measurements (V1 development)

Since 2.0.0, metrics are opt-in: pass `metrics: true` to `trace_computer_observe`. Successful native observations then expose `metrics`, and an action refresh exposes the same object under `observation.metrics` only when the consumed observation asked for them. Without the flag an observation omits `metrics` and `_meta['trace/projection']` (about 700 characters less in the 2.0 test). These are diagnostics, never observation authority, effect proof or an input retry decision. Observation timestamps, TTL, identity/geometry checks and native supervision remain unchanged.

## What is measured

- Version 1 uses process-local monotonic elapsed milliseconds, rounded to three decimals. `stages` has fixed labels with `calls`, `failures` and inclusive `durationMs`.
- Controller stages cover observation, current identity, backend work, file stat/read, hash/base64 encoding and journal write. Provider instrumentation adds identity, UIA, geometry, restore/settle, screenshot request, PNG read/header, focus and related-window lookup where those operations occur.
- Stages nest: provider time overlaps identity/UIA/capture, which overlap backend and observation. **Do not sum stage durations.** Geometry settlement includes intentional waits. A missing stage is not a measured zero.
- `counts` records provider request attempts, supervised/direct routes, capture requests and element count. These are not confirmed process launches or successful captures. No helper-startup or isolated native-execution timing is inferred from round trips.
- `bytes` counts existing backend/controller PNG reads, optional related-window PNG reads and base64 output. Instrumentation adds no capture or file read.
- `sample` distinguishes first and later controller observation attempts, including failed first attempts. It does not prove OS caches, application state or providers are cold/warm. Model time is excluded.
- Helper startup, isolated provider execution, wire transport, client latency and model time are explicitly unavailable in observation metrics. Ignore timing samples with `counts.invalidTimingSamples`; nonfinite/backward injected clock values cannot be treated as real zero-duration work.
- A failed full observation retains its existing error rather than publishing partial metrics. A caught optional-focus failure can appear as a failed nested span in an otherwise successful observation.

MCP observations that request metrics also provide `_meta['trace/projection']` when projection instrumentation is present. Its duration covers server projection and the one existing text serialization. `jsonTextBytes` measures that text; `imageBase64Bytes` measures the image strings. They exclude metadata/envelope overhead and duplicated structured serialization, so they are not total wire bytes. Text/structured state and image indexes are unchanged. Client/network/model time is outside this boundary.

Metrics accept only fixed labels and finite bounded numbers. They record no arguments, paths, window inventory, titles, typed text, clipboard data, errors, image contents or hashes. Source PNGs and ordinary observation state retain their existing separate privacy obligations. Metrics are not automatically written to a new log or uploaded.

## Fixed measurement recipe

Actual desktop measurement needs a separately scheduled owned-window slot; preparing this guide does not run one.

1. Pass `metrics: true` on every measured observation (2.0.0 and later). Record exact source/runtime/engine versions, fixture state, display geometry/DPI/topology and observation depth in a sanitized manifest. Pin these for all comparisons. Distinguish built/pinned source from the source actually loaded by the client server.
2. Use one owned synthetic fixture already foreground, restored and idle. Keep its content, size and focus unchanged. Do not reuse unrelated app inventories or private screenshots as benchmark artifacts.
3. Start a fresh controller, open its exact target once, and collect one first observation plus three later observations at the same depth. No mutation, export, recovery test or old acceptance rerun is required. Stop on targeting, capture or cleanup uncertainty; record the failed prerequisite instead of expanding the campaign.
4. Store only each result's numeric metrics, projection metadata, sample label and pass/fail status. Do not save the full tool result, screenshot, title or target/session IDs into the performance report. Record actual cache/app initialization conditions separately; do not relabel first/later as cold/warm proof.
5. Compare first observations separately from later observations. Report sample count and later min/median/p95/max. Use stage counts and bytes to identify a measured candidate. Fewer operations alone cannot establish a wall-clock speedup.
6. Close the owned session using its existing cleanup contract. Native input/recovery acceptance stays at its compatible recorded scope. A changed display, depth, fixture or runtime needs a new labeled measurement group, not an unlabeled retest.

An existing connected MCP client can extract a numeric sample from a full no-image observation:

```javascript
const started = performance.now();
const result = await client.callTool({
  name: 'trace_computer_observe',
  arguments: { sessionId, mode: 'full', screenshot: 'none', relatedImages: false, accessibilityDepth: 8, metrics: true },
});
const clientRoundTripMs = performance.now() - started;
const sample = {
  status: result.isError ? 'failed' : 'completed',
  clientRoundTripMs,
  observation: result.structuredContent?.metrics ?? null,
  projection: result._meta?.['trace/projection'] ?? null,
};
// Persist only sample, not result. Caller round trip is distinct from server spans.
```

The caller measurement includes client processing and transport; it cannot isolate either. It does not include model thinking unless the caller explicitly measures that separately. No comparative latency result is claimed by this instrumentation change.

## Repeated no-image observations and process attribution

Use the same owned-fixture and cleanup requirements for a separately scheduled experiment.

1. Pin the full no-image request shown above, with related images off, and keep the fixture restored, foreground and idle. Collect one first attempt and 20 later attempts serially on the same controller with no input or concurrent TRACE calls. Keep failed attempts and verify zero image blocks in each successful response. Repeat the whole run under the same conditions if comparing first attempts.
2. Collect Windows ETW process start/exit events independently around the observation run. Use the supervisor's existing `onDispatch` callback to associate dispatch receipts with the in-flight observation. Match ETW lifetimes by child PID, child creation time and supervisor parent identity, aligning clocks before comparing times. Read the child PID from the event payload and exclude process rundown. Attribute only uniquely matched start/exit pairs. Report missing, ambiguous or dropped events and keep raw traces and process identities outside the numeric samples. [Windows kernel process events](https://learn.microsoft.com/en-us/windows/win32/etw/process-v2)
3. Report caller and stage timing, request counts, confirmed launches and process lifetimes separately, alongside failures and verified cleanup. ETW start-to-exit measures process lifetime. The dispatch receipt follows resume. Isolating startup would require explicit launch and provider-ready boundaries on a common or calibrated clock. Keep startup unavailable without those boundaries.

## Summarize existing numeric samples

Save an array of the `sample` objects above for one pinned source/runtime/display/depth/mode group, then run `node scripts/observation-profile.cjs samples.json > profile.json`. This offline command does not connect to a server, capture pixels or control the desktop. Keep the source manifest separately; the report cannot verify that samples came from equivalent environments or real captures.

The report separates first/later attempts and gives per-metric sample count, minimum, median, p95 and maximum. P95 is the value at one-based rank `ceil(0.95 * n)` among the sorted values present for that metric. With fewer than 20 values it equals the maximum. Missing stages stay absent. Failed samples are counted and excluded from aggregates. Observation and supplied projection metadata must declare version 1 and `process-monotonic` clock. Version/clock mismatches, invalid numeric fields and invalid timing samples reject the input. The report emits only fixed numeric stage/count/byte/caller/projection fields and ignores arbitrary fields and labels. CLI errors omit input contents and paths. Caller round trip remains separate from nested stage timings, which must not be summed. The output summarizes diagnostic samples. Benchmark conclusions, provider startup, cold caches and model speed require separate evidence.

## Adjacent identity consolidation (V2 development)

Initial observation validates engine status first, then obtains bounds and checks the pinned process lifetime/session from that same native receipt. The backend also reuses the immediately preceding bounds receipt at the pre-capture identity check. The independent native identity read after capture and all status/UIA/geometry/focus/restore checks remain. A malformed or mismatched pinned receipt rejects without retrying another identity request or publishing a capture. This is transient receipt reuse within one observation, not an identity cache across captures.

The non-minimized synthetic pinned-window path now makes 11 backend provider requests (12 after the first consolidation, 13 originally): three status, one independent native identity, three bounds, two UIA, one screenshot and one focus request. Unpinned paths retain 10 requests. Controller/discovery/session calls and restoration branches are separate. The initial native identity sample follows its status read; the later pre-capture bounds sample precedes its adjacent status read. These checks are not atomic. This request-count result is not a measured wall-clock speedup; native providers, input dispatch and recovery are unchanged.

The initial identity timing now includes the nested geometry/provider timing. Those inclusive stage durations overlap and must not be summed. A lazy bounds read is scoped to one observation; an injected identity override that ignores it retains the original identity-then-bounds sequence. Read failures and cancellation propagate without a fallback retry; observing an abandoned promise rejection does not turn its failure into success.

## Bounded backend PNG read (V2 development)

The backend now reads at most 33 bytes from each regular capture file for its existing signature/IHDR/dimension checks, handling short reads and closing the descriptor before continuing. `backendPngRead` keeps its stage/byte labels but reports the bytes actually returned, rather than the entire PNG size. Provider requests remain 11 on the normal pinned path. The controller still independently stats and reads the full file, checks its signature/dimensions and size limit, hashes it and encodes it; neither layer claims complete PNG decoding or integrity validation.

No native, input, geometry, recovery or retention behavior changes. The optimization does not make the two reads atomic, preserve errors in unread trailing data, or establish a wall-clock speedup. Special files and concurrent external mutation are outside the regular capture-file claim.

## Internal selective capture (V2 development)

The backend's internal `includeScreenshot:false` option omits screenshot capture, PNG reads and pixel-provenance fields, retaining initial/adjacent bounds identity checks, independent final identity, UIA, geometry, restore and focus checks. Full capture remains the default and uses the bounded header read above. Public selective modes and their evidence-only authority contract are a separate dependent change; this internal option alone does not expose them through MCP or permit image-free input.

## Controlled diagnostic profile, 31 October 2026

At source `593e309`, [four owned-fixture observations](../evidence/v2-observation-profile/completed-2026-10-31.json) completed at full depth 8 on one 1920×1080/144-DPI display. Caller first was 2939.721 ms; later minimum/median/maximum were 3061.396/3206.032/3457.710 ms. Each used 13 supervised provider attempts: the documented 11-request backend path plus the controller's current-window status and native identity pair. Each made one capture request, read 33 backend PNG bytes and 31444 controller PNG bytes. Effective retention was preserve/0. Cleanup was confirmed; no input actions were sent.

The two earlier precondition stops remain [blocked evidence](../evidence/v2-observation-profile/blocked-2026-10-31.json). After explicit renewed owner readiness, one preparatory fixture activation established foreground for the completed run. No accepted desktop workflow was repeated.

For 1.1.0, retain the remaining independent controller/backend status and identity checks. Provider time dominates this small sample, but inclusive aggregate spans do not isolate status or startup savings, nor prove a safe shared receipt lifetime. Additional consolidation needs a separate freshness design and targeted measurement. These four observations close the diagnostic selection gate; they are not comparative speedup, isolated helper-startup, cold/warm or model-latency evidence.
