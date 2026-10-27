# Second amendment execution preparation

This is prepared code and a schema guide, **not owner approval**. The [proposal](LIVE_ACCEPTANCE_AMENDMENT_2.md) remains frozen at SHA-256 `84a4d9df1d91ff28f257b35d0a09d4ce9fc22a159b9a75feaa6480d35061ef90`. It names only glow and Codex, at most one new attempt plus one corrective retry each. No new decision or real claim was created while preparing this implementation.

Only explicit `--amendment 2 --continuation 1` or `2` can select lifetime 5 or 6. The previous five-case defaults retain lifetime 3–4 and their original caps. Claude, typing and clipboard cannot opt into this amendment. An amendment plan with no decision reference shows no approval; a Codex start without the actual new reference fails before preparation or UI.

After an actual direct owner decision, its evidence record must bind `schemaVersion:1`, `source:"direct-owner"`, `status:"approved"`, a distinct `decisionId`, `amendment:2` and `proposal:{ref:"docs/LIVE_ACCEPTANCE_AMENDMENT_2.md",sha256:<the frozen hash>}`. Each selected `cases` entry names the unchanged case/contract, `historicalAttemptsUsed:4`, `continuationMaximum:2` and the four exact history descriptors returned by `book.amendmentHistory(caseId)`. Do not populate an approved record from this template while the human decision remains pending.

The canonical ledger keeps `schemaVersion:1`, its original `selection` and first two supplemental claims. A first amended claim appends `amendments:[{amendment:2,selection:<actual new decision/proposal/history metadata>}]` and lifetime 5. It verifies the frozen proposal, all four receipt hashes, the original owner decision and both original supplemental claim chains under the existing per-case lock. Lifetime 6 requires the exact same amendment metadata, terminal lifetime 5 `fail`/`blocked` receipt and a concrete correction. A pass closes that round. Another directory, decision or agent cannot reset it.

Plan commands, which do not inspect the desktop or claim attempts:

```powershell
node scripts/accept-replacement-glow.cjs --plan --amendment 2 --continuation 1 --reference-executor Sky
node scripts/accept-codex-host.cjs --plan --amendment 2 --continuation 1
```

Once actually approved and preflight is independently satisfied, retain the actual decision reference using `--decision-ref evidence/<actual-new-decision>.json`. Glow uses its existing `--live <new-directory>` form; Codex uses `--start --directory <new-directory>`. A corrective attempt adds `--continuation 2 --continuation-prior <exact terminal lifetime-5 receipt ref> --change <actual correction>`. These examples supply no approval and must not be run as live placeholders.

The unchanged native, display, grounding, cleanup and 60-second freshness contracts still apply. Codex also requires proof that the actual connected server loaded the corrected files; bookkeeping cannot establish that. Fifty-eight focused bookkeeping/adapter/Codex/glow tests pass, covering append-only history, concurrency, malformed histories, proposal changes, missing decisions and budget-reset rejection. This is pure/injected preparation; live acceptance remains incomplete.
