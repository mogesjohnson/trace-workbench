# TRACE Workbench 2.3.0

**Published 7 November 2026 with direct owner approval.**
[Download v2.3.0](https://github.com/mogesjohnson/trace-workbench/releases/tag/v2.3.0).
The [publication receipt](../evidence/release-2.3.0/publication.json) binds merged source
`e19717b`, local final-main CI on Node 26, exact archive installation and five
independently downloaded and hash-verified assets. The bundled notes and companion
manifests keep their prepublication snapshot. It moves the native helpers to .NET 10,
which raises the runtime floor, and adds Road V1 item 20: the compatibility and support
contract. Published [2.2.0](RELEASE_2.2.0.md) and its assets remain available.

## Changes

### Compatibility and support contract (Road V1 item 20)

- [COMPATIBILITY.md](COMPATIBILITY.md) is the single source for what TRACE promises: the
  covered surfaces, what each version bump means, identifier lifetimes, error codes,
  deprecation and the support matrix (PRs 142 and 143). The shipped skill and method docs
  list all seven tools (PR 144).
- Doctor reports `versions` (`package`, `contract`, `engine`, `bridge`, `supervisor`,
  `skillBundle`) and an empty `deprecations` list. `trace-workbench --version` prints the
  package version (PR 145). Both doctor fields sit outside `support`, so the descriptor
  digest is unchanged.
- On a support-descriptor digest mismatch, the adapter re-reads doctor with
  `verbose: true` and applies the tolerant full-descriptor match. A digest match still
  needs only one call (PR 146).
- A CI job runs `check`, `test` and `test:computer:mcp` on Node 22 and 24 (PR 147). It
  first passed on GitHub Actions on 4 November 2026. It was not run for 2.3.0; see
  [CI for this release](#ci-for-this-release).

### Live harness fixes

- The supervisor live harnesses request the full act result, match the supervisor-owned
  marker and the compact window listing, and export before they start (PRs 151, 152 and
  154). These are test-only changes.

## Runtime change: .NET 10 is the floor

- TRACE's four native helpers now target `net10.0-windows` instead of `net9.0-windows`:
  the activity indicator, window bridge, clipboard helper and input supervisor.
- Computer setup needs the **.NET 10 SDK with the Windows Desktop reference pack** to
  build the helpers. The helpers and doctor need the **.NET 10 Windows Desktop runtime**.
- A machine with only .NET 9 fails doctor until .NET 10 is installed. Earlier 2.x builds
  needed .NET 9.
- Microsoft lists .NET 9 end of support as 10 November 2026.
- This is a runtime floor change, handled as a contract change. It ships as a Minor
  release with this notice. See the [.NET 10 runtime section](COMPATIBILITY.md#net-10-runtime).

## Helper rebuild required

Existing installs must rebuild the helpers after updating. Install the .NET 10 SDK, run
`npm run computer:setup -- --plan`, review the plan, then run
`npm run computer:setup -- --apply`. Until then doctor is not ready and reports a stale
helper such as `bridge_stale`.

## Doctor size bar raised to 2,750 characters

- The compact ready doctor bar (P2-1 in the
  [token cost incident](OBSERVATION_TOKEN_COST_INCIDENT.md)) rises from 2,500 to 2,750
  characters. A real ready doctor on the .NET 10 build, measured on 6 November 2026 after
  `setup --apply`, was 2,489 characters (verbose 6,235), leaving 11 characters under the
  old bar. The owner chose 2,750 for about 10% headroom.
- The doctor's output is unchanged. Only the test bar moves.

## Live evidence on .NET 10

- Native live evidence recorded on the .NET 9 build does not carry over. The .NET 10
  build was re-checked live on 7 November 2026 at `0a3381b` (Node 26.2.0, SDK 10.0.403,
  Desktop runtime 10.0.14). See the [.NET 10 live evidence](../evidence/dotnet10-live/README.md).
- Passed: live smoke, glow (self-check, start, visible, EOF, parent loss), injected stop,
  all 15 recovery cells, quarantine mouse and chord, and focused typing.

## Not verified on .NET 10

- Physical keyboard and mouse stops: these need a person at the desktop.
- Quarantine typing and clipboard Unicode paste: their historical acceptance budget is
  closed, and they last passed on .NET 9.
- Glow click subcases: these need the coordinated reference executor, as on .NET 9.

## CI for this release

GitHub Actions billing is locked, so CI for 2.3.0 runs locally on Node 26 on the owner's
Windows machine and is recorded as local, with no run URL. Node 22 and 24 were not run
for 2.3.0. They are allowed by `package.json` and last passed on 4 November 2026.

## Known limits

- The limits of [2.2.0](RELEASE_2.2.0.md#known-limits) still apply.
- Windows 11 x64 with one display at 144 DPI, as in the
  [support matrix](COMPATIBILITY.md#support-matrix).
- The live checks ran on one machine. A `GameInputSvc` foreground window can block input
  with `foreground_access_denied` until an ordinary window is clicked. TRACE refuses
  before dispatch, so nothing is sent.
