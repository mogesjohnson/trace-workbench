# Proposed .NET 10 re-verification: quarantine typing and clipboard paste

Prepared 7 November 2026. **Proposal only.** This file approves nothing, claims no attempt
and adds no code. A live run needs the owner's direct decision on the text at the end,
then a separate code PR, its tests and a ready check at the desktop.

## Why a new contract is needed

TRACE 2.3.0 moved the native helpers from .NET 9 to .NET 10. Live evidence from the .NET 9
build does not carry over. The [.NET 10 live evidence](../evidence/dotnet10-live/README.md)
re-proved everything else in scope. These two cases were not run:

| Case | Last result on .NET 9 | Why the current drivers refuse it |
|---|---|---|
| `A32-QUARANTINE-ACK-TYPING` | Pass at lifetime attempt 3 ([verification](../evidence/live-acceptance-continuation/typing-supplemental-1/verification.json); the receipt is kept untracked, sha256 `c21cf82c…483d`) | Without a continuation claim, `accept-supervisor-quarantine.cjs` stops typing with `invalid_retry`. The [ledger](../evidence/live-acceptance-continuation/ledger/A32-QUARANTINE-ACK-TYPING.json) holds one claim, and its one remaining claim is only for a corrective retry after a failure. |
| `METHOD-CLIPBOARD-UNICODE-PASTE` | Pass at lifetime attempt 4 ([receipt](../evidence/live-acceptance-continuation/clipboard-supplemental-2/receipt.json), sha256 `5ada7901…e7cc3`) | Without a continuation claim, `accept-clipboard.cjs` stops with `clipboard_historical_budget_exhausted`. The [ledger](../evidence/live-acceptance-continuation/ledger/METHOD-CLIPBOARD-UNICODE-PASTE.json) has used both claims. |

Both cases passed, and a pass ends a case. So this is not a retry of a failed case, and it
must not reopen or extend the [historical continuation](LIVE_ACCEPTANCE_CONTINUATION.md).
It is a re-verification of the same cases on a new runtime. The other .NET 10 cases were
handled the same way.

## Proposed scope: `dotnet10-reverify-v1`

- **Cases:** the same two case IDs. No new case ID, and the oracles do not change.
- **Budget:** per case, one attempt plus at most one corrective retry, as for every other
  .NET 10 case. The retry needs the first attempt's terminal `fail` or `blocked` receipt and
  a stated, real changed precondition or fix. A launched `fail` or `blocked` uses its
  attempt. A pass ends the case. No automatic retry or replay.
- **History:** the historical ledger files, owner decisions and receipts stay byte for byte
  unchanged, and nothing is appended to them. The .NET 10 claims go in a new append-only
  ledger, `evidence/dotnet10-live/ledger/<case>.json`. It is keyed to the new decision and
  pins the .NET 9 pass receipt above by hash.
- **Evidence:** `evidence/dotnet10-live/quarantine-ack-typing/` and
  `evidence/dotnet10-live/clipboard-unicode-paste/`, plus an `-attempt-2` directory for a
  retry. Results go in `postPublication` in [summary.json](../evidence/dotnet10-live/summary.json),
  the evidence README and a post-publication note in [RELEASE_2.3.0.md](RELEASE_2.3.0.md).
  This is not a new release.

## Oracles kept unchanged

**Typing ACK** keeps the `typing-ack-idle-anchor-v1` contract from the
[continuation](LIVE_ACCEPTANCE_CONTINUATION.md#typing-ack-owner-readiness-and-foreground-preparation-before-the-case)
and the .NET 9 pass. That means a separately owned ordinary anchor, focus from the pinned
engine with public and independent checks, and one controlled `type-hold abc` with C held
independently. Then come MCP cancellation, the owned child's exit and all keys up before
the private failed-release ack is injected. Quarantine must stay durable: the same session
is rejected, two read-only recovery checks do not clear it, and a separate artifact root's
session is blocked. After that, one planned recovery apply runs, clear status is verified,
and exactly one fresh counter follow-up takes the count from 0 to 1 with stable text.

**Clipboard** keeps the `clipboard-supported-snapshot-v1` contract from the
[continuation](LIVE_ACCEPTANCE_CONTINUATION.md#clipboard-supported-private-snapshot-and-idle-readiness-before-claim).
The supported formats are checked privately before the claim, and the snapshot is held only
in private memory. The exact synthetic Unicode payload is written once and read back, and
automatic restore is deferred durably. Then come focus through production MCP and one
`CTRL+V` with independently exact text. Restore waits for input to go quiet, is guarded by
sequence and owner, and a fresh helper compares the supported bytes in private memory.
Unsupported formats stay outside the claim and are never stripped. The owner may choose to
copy plain text from Notepad as a separate action.

The 15,000 ms native operation deadline, no replay of unknown delivery and every cleanup
oracle stay as they are.

## Extra .NET 10 preconditions

Checked before the claim and recorded in each receipt:

1. The native sources hash the same as `supervisorSourceSha256` in summary.json. For
   clipboard, the `native/TraceClipboard` sources and project also hash the same as at
   `f2153fc`. Helpers target `net10.0-windows`, and doctor is ready on the .NET 10 runtime.
2. The owner has run `/mcp` to reconnect `trace-computer` and `rea`.
3. The foreground belongs to an ordinary window. If `GameInputSvc`
   (`GameInputServiceWindow`) holds it, the owner clicks an ordinary window first. TRACE
   correctly refuses input there with `foreground_access_denied`. A refusal before the
   claim uses no attempt. After the claim, it uses one.
4. One question to the owner gives the step-by-step instructions and asks Ready or Not
   ready. Only a fresh Ready answer counts as the direct idle-readiness statement for the
   [anchor record](ACCEPTANCE_ANCHOR.md), and it must be at most 60 seconds old at
   `--confirm-ready`. Silence, polling or an earlier go-ahead do not count. Neither case
   needs an owner action during the run; the owner keeps their hands off the keyboard and
   mouse until it finishes.

## Code needed after approval (separate PR)

The current drivers accept typing and clipboard only through the historical continuation
claim. The follow-up PR would:

- Add a `dotnet10-reverify-v1` selection that validates the new owner decision record and
  claims in the new ledger. It must refuse any write to the historical ledger.
- Pass that claim into the existing typing and clipboard run paths, which keep their
  idle-readiness, anchor and supported-snapshot checks.
- Add pure and injected tests: historical ledger untouched, a third claim refused, a retry
  without a prior failed or blocked receipt refused, the wrong decision or case refused, and
  plan mode doing no I/O.

Budget: at most 400 lines and 6 files for the PR, and 200 lines and 4 files per commit.
Local CI on Node 26 as before. The live run follows only after that PR is merged with the
owner's approval.

## Proposed direct owner decision

> Approve `dotnet10-reverify-v1` for `A32-QUARANTINE-ACK-TYPING` and
> `METHOD-CLIPBOARD-UNICODE-PASTE` on the .NET 10 build: one attempt plus at most one
> corrective retry each, in a new .NET 10 ledger, with the unchanged oracles and extra
> preconditions above. The historical continuation ledger, decisions and receipts stay
> unchanged. No other case budget changes.

The decision record would be saved as `evidence/dotnet10-live/owner-decision.json` with the
owner's actual reply and this file's sha256. A proposal or an agent-written approval is not
a decision.
