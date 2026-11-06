# TRACE Workbench 2.3.0 (draft, unreleased)

**Not published.** This draft holds the release-notes notice for the .NET 10 retarget. It
is not a release, and nothing here is a publication receipt. The version, notes and
evidence are set when the owner approves publication.

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

## Not yet verified

- Native live evidence recorded on the .NET 9 build does not carry over. Live desktop
  checks on the .NET 10 build are not yet recorded and need a desktop session.
