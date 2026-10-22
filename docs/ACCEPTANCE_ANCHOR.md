# Owned foreground anchor for acceptance

[The preparation wrapper](../scripts/prepare-acceptance-anchor.cjs) provides the ordinary synthetic window required by the approved typing and clipboard preflight. It sends no input, activates no window, applies no recovery, claims no attempt and never rebuilds the fixture. It verifies the prepared fixture files, retains the actual child-process close handle, and discovers the exact HWND/PID/process creation time/session.

Import and `--plan` are pure. Nine wrapper tests cover readiness, ownership, command messages and conservative cleanup; the continuation adapter has separate checks. This does not establish either downstream case's live acceptance.

## Prepare and confirm

From the repository root:

```powershell
node scripts/prepare-acceptance-anchor.cjs --plan
node scripts/prepare-acceptance-anchor.cjs --start --case A32-QUARANTINE-ACK-TYPING
```

Keep the start process running. It returns a private owner ID and the exact anchor identity. For clipboard use `METHOD-CLIPBOARD-UNICODE-PASTE`. Select the new ordinary fixture manually. Its title currently starts `TRACE Computer Fixture — clipboard-` because it reuses the existing owned fixture launcher; the canonical case and exact identity determine its purpose.

After the human directly confirms this window is foreground and input is idle, record that actual statement's time and exact identity in a new evidence-relative JSON file:

```json
{
  "schemaVersion": 1,
  "source": "direct-owner",
  "caseId": "A32-QUARANTINE-ACK-TYPING",
  "ready": true,
  "confirmedAt": "<actual fresh reply ISO time>",
  "anchorOwnership": "run-owned-child",
  "anchor": {"id":"<returned HWND>","pid":123,"processCreationTime":"<returned creation time>","sessionId":1}
}
```

```powershell
node scripts/prepare-acceptance-anchor.cjs --confirm-ready --case A32-QUARANTINE-ACK-TYPING --id <returned-id> --owner-record evidence/<actual-owner-record>.json
```

This checks the direct-owner record once against the exact discovered anchor and current display, foreground, identity, released input, recovery and free ownership. The confirmation must follow window discovery and be at most 60 seconds old. A successful reply contains a hashed `readinessReference`; pass its `ref` to the downstream driver's `--idle-readiness`. The downstream driver independently repeats the preclaim checks. Polling, an old general go-ahead or an agent-created approval cannot establish readiness. Clipboard additionally verifies supported format identifiers and takes a private preclaim snapshot; readiness never authorizes stripping unsupported formats.

`--status --case <canonical-case> --id <returned-id>` requests a fresh reply from the same retained owner. A saved state file alone does not prove the owner is alive.

## Explicit cleanup

After the downstream case settles, inspect its actual receipt and independently verify native cleanup. Supply a new evidence-relative cleanup record with `schemaVersion:1`, `source:"independent-native-cleanup"`, exact `caseId` and `anchor`, fresh `verifiedAt`, `nativeRequestsSettled:true`, `downstreamStarted:true` and `ownedProcesses:[{pid,created,sessionId}]` for the actual owned generations. Before any downstream launch, `downstreamStarted:false` and an empty list may describe that actual state. Do not use it after work started.

```powershell
node scripts/prepare-acceptance-anchor.cjs --close --case <canonical-case> --id <returned-id> --cleanup-ref evidence/<actual-cleanup-record>.json
```

The retained owner checks those generation exits, its own current anchor identity, recovery, all-up input and free lease before closing its actual child. Unknown exit, held input, stale evidence or ownership uncertainty keeps the anchor open. No command kills a PID recovered from a state file. After an owner crash, retain its private context for manual reconciliation; the wrapper does not implement automatic crash resume.

This preparation implements the existing [continuation contract](LIVE_ACCEPTANCE_CONTINUATION.md); it adds no product permission tier and extends no case budget.
