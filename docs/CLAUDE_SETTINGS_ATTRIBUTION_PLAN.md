# Claude host settings attribution plan

Prepared 22 October 2026 for `CLAUDE-TRACE-SKILL-NATIVE` under contract `claude-queued-host-settings-v1`. The plan changes no budget, adds no exemption and does not reinterpret the [blocked second receipt](../evidence/computer-use-method/claude-host-attempt-2/receipt.json). Updated 23 October UTC: [supplemental attempt 1](../evidence/live-acceptance-continuation/claude-supplemental-1/receipt.json) is now consumed and blocked. Both skills were discovered and exact typing succeeded, but recovery/counter completion and settings preservation did not pass. One corrective supplement remains.

The actual run sampled no unowned Claude process. Probe, pre-host and post-host intervals were preserved; the host interval changed client state. The exact-binary table classified 49 changed paths as routine global keys (47 feature/experiment cache paths), with two unclassified paths. These counts are not permission to exempt writes. The acceptance-only forwarding boundary also dropped upstream `not_dispatched`; its focused correction is verified through two real MCP boundaries. No further live host run is useful until client-state preservation has a concrete resolution or an explicit prospective policy decision.

## What the retained evidence supports

The second receipt records `userSettingsUnchanged: false`: four semantic `clientState` changes, all reported as `unrecognized_key` with types number, object, object and number. The [frozen contract](LIVE_ACCEPTANCE_CONTINUATION.md) requires proved preservation, or precise and supported attribution that still blocks while its effect or source is unresolved.

Source inspection of [the driver](../scripts/accept-claude-host.cjs) (`fingerprintSettings`, `compareSettings`) shows two gaps. Neither can be repaired after the fact.

1. **No writer exclusion.** The comparison takes one snapshot before fixture preparation and one after cleanup. Nothing establishes that the launched host was the only writer of `~/.claude.json` during that window. Every interactive Claude Code session writes that file. On 22 October 2026 at about 11:00 local time, 21 `claude` processes were running on this PC, and `~/.claude.json` was last written at 10:58:41 by sessions unrelated to any acceptance run. A before/after difference therefore cannot attribute changes to the acceptance host.
2. **Key identity is discarded.** Keys outside the named set are reduced to `unrecognized_key` before anything is retained. Without a private record of which key changed, no later review can attribute the change, even with source evidence.

## Prospective handling

These steps tighten the comparison. None of them classifies a change as harmless.

1. **Writer-exclusion precondition.** Immediately before the claim, enumerate every running Claude Code process by PID, process creation time and image path. Require none other than processes the driver itself launches. The driving agent must not be a Claude Code session, because it would write the same file: use Codex or a plain owner terminal, with every Claude Code session closed. Enumerate again after the host's exact exit and again after cleanup. Any unowned Claude process found in the window makes the comparison `contaminated`. A contaminated comparison blocks and attributes nothing.
2. **Bracketed fingerprints.** Take the fingerprint at four points: T0 at preflight, T1 immediately before host spawn, T2 immediately after the host's exact exit, and T3 after cleanup. If T0 differs from T1, stop before claim, because something else is writing. Only T1→T2 changes can be candidate host-origin changes. If T2 differs from T3, record a post-run writer separately; never fold it into the host result.
3. **Private key identity.** Retain the names and nested paths of changed keys (to depth 2) only in an ignored private file under `.runtime/claude-host/<attempt>/`, never in a shareable receipt. Shareable receipts keep the existing sanitized category, type and count, plus that file's hash. Raw values are never retained.
4. **Version-bound attribution.** A changed key counts as attributed only if a reviewed table lists it for the exact installed host binary hash, with source evidence: official documentation or a static writer inspection of that exact binary. Attributed changes are reported as host-origin changes, separately from harness writes. Attribution does not establish preservation. Cached feature or experiment data (`cachedGrowthBookFeatures`, `cachedExperimentFeatures` and similar keys) can change host behavior, so changes to it stay semantic.
5. **Full scope recheck.** After the run, recompare all three declared sources (`.claude.json`, `.claude/settings.json`, `.claude/settings.local.json`), the managed settings file and the installed skill bundles.

## Driver changes

Implemented in [the driver](../scripts/accept-claude-host.cjs) with pure and injected tests in [its test file](../tests/accept-claude-host.test.cjs). No live run has exercised them.

- **Before claim, so no attempt is consumed:** the driver's own `claude --version` and `claude auth status` probes ran inside the old comparison window, which made them candidate writers too. Their interval is now compared on its own, and any change stops the run with `claude_probe_changed_settings`. Any running `claude.exe` process stops it with `claude_concurrent_writer`. That match also covers the Claude desktop app, so the desktop app must be closed too.
- **After claim:** a change between the probes and host spawn stops the run before launch with `claude_settings_changed_before_host`. A writer monitor samples `claude.exe` processes every 2 seconds while the host runs, plus once after it exits. It excludes only the spawned host's PID together with the creation time first observed for it. A writer that starts and exits between samples is not detected, and the receipt states that limit.
- **Receipt:** it records `settingsIntervals` (`hostProbes`, `preHost`, `host`, `postHost`) as sanitized comparisons, along with `settingsWriterExclusion`. When anything changed, it also records `settingsAttribution` (`host_window_candidate`, `contaminated_or_unattributed` or `unattributed`), and `privateSettingsDiff` with only a hash and a count. Changed key paths go only to `.runtime/claude-host/<evidence folder>/private-settings-diff.json`. None of this changes a block: any change still blocks.
- **Key classes:** the private diff now keeps depth-3 names under `projects`, and the host interval is classified against [the attribution table](../evidence/computer-use-method/claude-settings-attribution/table.json). The receipt's `settingsKeyAttribution` holds only counts, the table hash and whether the exact binary is listed. Per-key classes stay in the private file.

## Attribution table

[The table](../evidence/computer-use-method/claude-settings-attribution/table.json) has one entry per exact `claude.exe` SHA-256. It now covers 2.1.306 (`f6bc9de3…`, the binary of both retained attempts) and 2.1.308 (`c9796ba2…`, installed on 22 October 2026). [The extractor](../scripts/claude-settings-attribution.cjs) derives each entry from the binary. Static inspection of both builds found the same structure:

- The global saver (literal `saveGlobalConfig`) and the per-project saver (literal `saveCurrentProjectConfig`, which writes `projects[<current project>]`) each consult a check before skipping an unlocked fallback write after lock contention.
- That check passes only when every changed top-level key is in a routine global set (40 keys: usage counters, tip and notice history, `firstStartTime`, and cached feature, experiment and roster data). Under `projects`, every changed key of each entry must be in a routine project set (29 keys: last-session statistics, graceful-shutdown stamps, onboarding counters).
- Each entry pins the savers, both sets, both checks and both skip sites by byte offset and hash, so a reader can re-check them without copying vendor code. `--verify` re-extracts and compares. A binary missing from the table, an ambiguous anchor or a changed structure fails closed.

Classification is narrow. A change is `routine_global_key` or `routine_project_key` only for the exact listed binary, and a project key counts only under the host's own workspace entry. A new project entry is compared key by key against an empty one, so its non-routine keys stay unclassified. Every other change is `unclassified` with a reason, including other projects, `settings.json` sources and unparseable sources. Keys starting with `cached` are flagged `featureOrExperimentCache`, because they can change host behavior.

A class names the code path that treats a key as routine saved state. It does not prove that a change is harmless or preserved, so it never turns a block into a pass. The four changes in the second receipt still can't be attributed, because that run kept no key identity. Claude Code updates itself, so a live attempt needs its exact binary in the table first. Run the extractor on that binary and review the entry before the claim.

## Owner decisions

- Whether attributed, named host-origin client-state writes can ever satisfy the contract's "proved preservation", or whether only byte-identical sources can pass. Until the owner decides, any change blocks.
- Closing all Claude Code sessions, including this continuation chain, for the duration of a live Claude attempt.
