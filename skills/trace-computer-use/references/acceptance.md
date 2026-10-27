# Acceptance boundaries

## Prove the requested effect

Record source identity, host/environment, exact target, initial state, intended operations, expected effect/error, independent actual state, artifacts, and owned cleanup. Preserve failed/interrupted attempts. Allow one corrective retry per failing step after changed preconditions or a fix; an unresolved second failure ends that case.

A native task needs actual image inspection and an independently checked final state, not just input dispatch. A multi-step effect such as focus → type → save completes only after the saved result passes its predicate. A genuine dialog workflow must demonstrate parent → exact modal → parent. A file handoff needs correct receiving bytes and environment. Retain each requested privacy/edit/export effect rather than omitting one to finish the demonstration.

For recorded demos, record the intended owned window. Verify creation, all requested edits/effects, and playback in the final export. Decodability or HTTP success alone cannot prove the user result. Keep synthetic acceptance content separate from real user libraries.

## Match the evidence scope

| Evidence | What it establishes |
| --- | --- |
| Guidance or design | Described requirement/workflow |
| Inspected source | Present code path at the named revision |
| Simulation or fake transport | Tested orchestration/provider contract |
| Real tool discovery/diagnostics | Protocol/tool availability and reported readiness |
| Owned live app task | Exact demonstrated behavior in that host/app/environment |
| Separate interruption case | The exercised failure mode and cleanup, not every recovery mode |

Read the checkout's current specification and receipts before reporting a milestone complete. The method library, native executor, browser/application adapters, installation, host-agent behavior, and release gates need their own relevant checks. A fake provider or trivial semantic verifier can misrepresent the world; the coordinator cannot manufacture trustworthy evidence.

## Bundle installation

Keep the canonical skill and its declared references together. The ownership manifest records SHA-256 per file; configuration/synchronization plan/apply validates complete source content and local reference targets. Inspect added/replaced/removed file plans and conflicts. Preserve exact backups and the returned receipt for rollback.

The synchronizer upgrades recognized legacy single-file TRACE instructions and clean manifest-owned bundles. Modified managed files and collisions with user-owned paths remain conflicts. Unrelated files and client settings must survive. Use a saved synchronization/configuration receipt with the synchronizer's `--rollback` operation to restore owned changes; a concurrent edit blocks rollback instead of overwriting the new content.

Source validation and temporary-home installer tests do not establish that each live model host discovered the bundle. Reconnect the host as required and verify its actual discovered instructions and referenced files before claiming live installation acceptance.

## Library use

In a TRACE checkout, `src/method/index.cjs` exports `ComputerMethod`, `ProviderRegistry`, `createTraceProvider`, `createBrowserProvider`, `createApplicationProvider`, `createClipboardProvider`, artifact helpers, and explicit geometry conversion. Read `src/method/README.md` for the public contract. `ComputerMethod.start` accepts a goal with effects containing several grounded steps. `verifyStep` checks a step; `verifyEffect` independently checks the whole requested result. A normal next step is not a retry of the preceding one.

The library is separate from these instructions and composes injected, ready adapters over real tools. A written capability descriptor does not install or activate a provider. Follow the checkout's current method usage documentation for runnable examples and explicit simulation labels; an installed skill must not assume the checkout or optional adapters exist in its host.

`createBrowserProvider` requires an actual supplied Playwright Page, stable tab identity, explicit URL/origin scope, and a successful readiness check. It supplies structured reads/actions and diagnostics without downloading or launching a browser. A headless owned-fixture browser run establishes that tested adapter behavior; visible-desktop and model-host workflows require separate evidence. Release method use before transitions; dispose only task-created tabs during final cleanup, retaining attached tabs.

Application recipes require known executable/profile/document arguments and a real ownership inspector for the exact process generation and resource. Attaching and launching are separate operations; close releases method use, while explicit disposal closes only a task-created resource after revalidation. A child-process fixture proves that recipe, not arbitrary GUI ownership. Clipboard tests must separately prove supported-byte restoration and the exact target's paste effect; pure helper tests do not establish either live result.
