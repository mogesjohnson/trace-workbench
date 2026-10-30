# Observation cost measurements (V1 development)

Successful native observations expose `metrics`; action refreshes expose the same object under `observation.metrics`. These are diagnostics, never observation authority, effect proof or an input retry decision. Observation timestamps, TTL, identity/geometry checks and native supervision remain unchanged.

## What is measured

- Version 1 uses process-local monotonic elapsed milliseconds, rounded to three decimals. `stages` has fixed labels with `calls`, `failures` and inclusive `durationMs`.
- Controller stages cover observation, current identity, backend work, file stat/read, hash/base64 encoding and journal write. Provider instrumentation adds identity, UIA, geometry, restore/settle, screenshot request, PNG read/header and focus where those operations occur.
- Stages nest: provider time overlaps identity/UIA/capture, which overlap backend and observation. **Do not sum stage durations.** Geometry settlement includes intentional waits. A missing stage is not a measured zero.
- `counts` records provider request attempts, supervised/direct routes, capture requests and element count. These are not confirmed process launches or successful captures. No helper-startup or isolated native-execution timing is inferred from round trips.
- `bytes` counts existing backend/controller PNG reads and base64 output. The two PNG read counts describe the current separate reads; instrumentation adds no capture or file read.
- `sample` distinguishes first and later controller observation attempts, including failed first attempts. It does not prove OS caches, application state or providers are cold/warm. Model time is excluded.
- Helper startup, isolated provider execution, wire transport, client latency and model time are explicitly unavailable in observation metrics. Ignore timing samples with `counts.invalidTimingSamples`; nonfinite/backward injected clock values cannot be treated as real zero-duration work.
- A failed full observation retains its existing error rather than publishing partial metrics. A caught optional-focus failure can appear as a failed nested span in an otherwise successful observation.

MCP observations also provide `_meta['trace/projection']` when projection instrumentation is present. Its duration covers server projection and the one existing text serialization. `jsonTextBytes` measures that text; `imageBase64Bytes` measures the image strings. They exclude metadata/envelope overhead and duplicated structured serialization, so they are not total wire bytes. Text/structured state and image indexes are unchanged. Client/network/model time is outside this boundary.

Metrics accept only fixed labels and finite bounded numbers. They record no arguments, paths, window inventory, titles, typed text, clipboard data, errors, image contents or hashes. Source PNGs and ordinary observation state retain their existing separate privacy obligations. Metrics are not automatically written to a new log or uploaded.

## Fixed measurement recipe

Actual desktop measurement needs a separately scheduled owned-window slot; preparing this guide does not run one.

1. Record exact source/runtime/engine versions, fixture state, display geometry/DPI/topology and observation depth in a sanitized manifest. Pin these for all comparisons. Distinguish built/pinned source from the source actually loaded by the client server.
2. Use one owned synthetic fixture already foreground, restored and idle. Keep its content, size and focus unchanged. Do not reuse unrelated app inventories or private screenshots as benchmark artifacts.
3. Start a fresh controller, open its exact target once, and collect one first observation plus three later observations at the same depth. No mutation, export, recovery test or old acceptance rerun is required. Stop on targeting, capture or cleanup uncertainty; record the failed prerequisite instead of expanding the campaign.
4. Store only each result's numeric metrics, projection metadata, sample label and pass/fail status. Do not save the full tool result, screenshot, title or target/session IDs into the performance report. Record actual cache/app initialization conditions separately; do not relabel first/later as cold/warm proof.
5. Compare first observations separately from later observations. Report sample count and later min/median/max. Use stage counts and bytes to identify a measured candidate; do not claim a wall-clock speedup from fewer operations alone.
6. Close the owned session using its existing cleanup contract. Native input/recovery acceptance stays at its compatible recorded scope. A changed display, depth, fixture or runtime needs a new labeled measurement group, not an unlabeled retest.

An existing connected MCP client can extract a planned observation without retaining its pixels:

```javascript
const started = performance.now();
const result = await client.callTool({ name: 'trace_computer_observe', arguments: { sessionId, accessibilityDepth: 8 } });
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

## Adjacent identity consolidation (V2 development)

Initial observation validates engine status first, then obtains bounds and checks the pinned process lifetime/session from that same native receipt. The backend also reuses the immediately preceding bounds receipt at the pre-capture identity check. The independent native identity read after capture and all status/UIA/geometry/focus/restore checks remain. A malformed or mismatched pinned receipt rejects without retrying another identity request or publishing a capture. This is transient receipt reuse within one observation, not an identity cache across captures.

The non-minimized synthetic pinned-window path now makes 11 backend provider requests (12 after the first consolidation, 13 originally): three status, one independent native identity, three bounds, two UIA, one screenshot and one focus request. Unpinned paths retain 10 requests. Controller/discovery/session calls and restoration branches are separate. The initial native identity sample follows its status read; the later pre-capture bounds sample precedes its adjacent status read. These checks are not atomic. This request-count result is not a measured wall-clock speedup; native providers, input dispatch and recovery are unchanged.

The initial identity timing now includes the nested geometry/provider timing. Those inclusive stage durations overlap and must not be summed. A lazy bounds read is scoped to one observation; an injected identity override that ignores it retains the original identity-then-bounds sequence. Read failures and cancellation propagate without a fallback retry; observing an abandoned promise rejection does not turn its failure into success.

## Bounded backend PNG read (V2 development)

The backend now reads at most 33 bytes from each regular capture file for its existing signature/IHDR/dimension checks, handling short reads and closing the descriptor before continuing. `backendPngRead` keeps its stage/byte labels but reports the bytes actually returned, rather than the entire PNG size. Provider requests remain 11 on the normal pinned path. The controller still independently stats and reads the full file, checks its signature/dimensions and size limit, hashes it and encodes it; neither layer claims complete PNG decoding or integrity validation.

No native, input, geometry, recovery or retention behavior changes. The optimization does not make the two reads atomic, preserve errors in unread trailing data, or establish a wall-clock speedup. Special files and concurrent external mutation are outside the regular capture-file claim.
