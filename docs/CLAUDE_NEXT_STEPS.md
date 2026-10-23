# Claude continuation and Codex review handoff

**Current continuation, 23 October 2026 UTC:** Codex owns the remaining work. Draft PR 17 adds archive verification on PR 16; `codex/live-acceptance-results` carries the latest live evidence and Claude forwarding fix. Typing quarantine passed. Claude supplemental attempt 1 discovered both skills and typed correctly but remains blocked on recovery completion and client-state writes. Glow amended budget is exhausted. Clipboard recovery is protected after a guarded restoration refusal. Use [current status](GAP_CLOSURE_STATUS.md) and [the dashboard](GAP_CLOSURE_PROGRESS.html). No new Claude coding session is required. Any optional Claude review should be read-only; concurrent code edits and Claude processes during announced host tests would invalidate the evidence.

The instructions below preserve the historical 22 October pause/upload handoff. That pause was revoked by the owner's later continuation request. This is unfinished work, not a release or full parity claim.

## 1. Start on the uploaded work

Repository: [mogesjohnson/trace-workbench](https://github.com/mogesjohnson/trace-workbench). Starting branch: `feat/computer-use-method-integration`, based on the existing alpha.3.3 targeting branch. The new draft PR depends on [PR #13](https://github.com/mogesjohnson/trace-workbench/pull/13); retain the older stack and evidence.

For a new clone:

```powershell
git clone --branch feat/computer-use-method-integration https://github.com/mogesjohnson/trace-workbench.git
cd trace-workbench
git switch -c claude/gap-closure-next
npm ci
```

For an existing checkout, inspect `git status` and preserve local work first. Fetch the integration branch and create a separate continuation branch or worktree from its remote head. Keep Claude's follow-up PR separate from the uploaded checkpoint; each PR targets two or three commits, maximum four.

Read in order:

1. [Repository instructions](../AGENTS.md), [rules](../RULES.md) and [version control](../VERSION_CONTROL.md).
2. [Current progress plan](GAP_CLOSURE_PLAN.md) and [detailed status](GAP_CLOSURE_STATUS.md).
3. [Acceptance specification](../SPEC.md) and [normal-desktop plan](V0.1-PLAN.md).
4. [Frozen supplemental contract](LIVE_ACCEPTANCE_CONTINUATION.md), [actual owner decision](../evidence/live-acceptance-continuation/owner-decision.json) and the per-case ledger under `evidence/live-acceptance-continuation/ledger/`.
5. [Method API](../src/method/README.md) and [Computer Use operation](COMPUTER_USE.md).

Retrieve the project brief with the installed `second-brain` skill. The local vault is shared context, not a Git dependency. A remote Claude environment may lack that vault; use this handoff and repository evidence and state the context gap. Update the same workstream's second-brain handoff after relevant verified work and before returning control.

## 2. Establish the baseline

The upload checkpoint ran **457 tests: 451 passed, six skipped, zero failed** and passing source checks ([saved receipt](../evidence/computer-use-method/checks-github-handoff-paused.json)). Five skipped checks need an optional real-browser runtime; one needs Windows symlink privilege. These are not live-application passes.

```powershell
npm test
npm run check
```

Run focused checks for the task being changed. Native execution needs Windows x64, the unlocked ordinary desktop, supported Node.js and .NET 9 SDK/Desktop runtime. A Linux/cloud checkout can review code and run compatible tests, but cannot establish Windows focus, input release, physical Escape, actual Codex/Claude GUI behavior or native REPLAY acceptance.

Private `.runtime` builds, personal configuration/authentication and raw host data are intentionally absent from Git. Use the setup plan in [Computer Use](COMPUTER_USE.md) to prepare helpers. Reconnect installed hosts after source changes; the existing connected Codex MCP process still has the pre-fix controller/server modules cached. The [retained fixture preparation script](../evidence/computer-use-method/prepared-fixture-builder.cjs.txt) can be copied to `.runtime/prepare-computer-fixture-manifest.cjs` and run from the repo after setup, with owned fixtures closed. It builds and hashes the synthetic fixture without opening UI. Preserve earlier manifests/receipts rather than overwriting evidence.

## 3. Review the latest product correction first

Review [controller](../src/computer/controller.cjs), [MCP server](../src/computer/server.cjs), and their tests. Consumed/expired observation rejection occurs before native dispatch. Its actual MCP error previously omitted the top-level `not_dispatched` outcome. The correction attaches explicit proof at those guards and preserves it at the MCP boundary. Generic exceptions and failures after successful input remain `unknown`; an error-code string alone is not proof of non-delivery.

```powershell
node --test tests/computer-controller.test.cjs tests/computer-mcp.test.cjs
```

The tests include the actual SDK transport with a real controller and fake backend, plus same-code errors after possible input and capture/projection failures. They establish the protocol correction, not a new live host pass. Review that separation and reconnect hosts before future execution.

## 4. Respect the remaining live budgets

The frozen owner decision adds at most two supplemental attempts per named case, preserving the original two. `SPEC.md` says, “A second failure ends that case.” A new directory, renamed case or new agent cannot reset a consumed budget.

| Case | Supplemental state at handoff | Claude's useful next action |
| --- | --- | --- |
| Codex workflow | **2/2 consumed.** First stopped before input when root's opening observation expired. Second proved exact Unicode and focus, then blocked on the missing stale-error outcome. Both closed safely; count remained 0. | Review the product fix and prepare a bounded future verification plan. An additional real Codex run needs a new direct owner budget decision and reconnected Codex host; Claude cannot supply Codex's tool/image actions. |
| Glow | **1/2 consumed.** First proved visible glow/ownership/focus, then the harness rejected Base64 RGB metadata before either click. | Review the corrected capture boundary and 17 focused checks. One corrective attempt remains, with exact prior reference and changed precondition. Arrange the actual Sky reference executor before launch; the live handshake has a 60-second bound. |
| Typing ACK | **0/2 consumed.** Both older attempts remain blocked. | Prepare and retain an ordinary owned anchor, establish its exact generation/foreground, obtain a fresh direct owner idle statement and final preflight, then claim. Approval alone is not readiness. |
| Claude workflow | **0/2 consumed.** Older host discovery and concurrent-call failures remain blocked. | Review actual installed TRACE and REA discovery, FIFO guard and exact native-exit tracking. Resolve the settings comparison precondition before a claim; inspect every declared setting scope again afterward. |
| Clipboard paste | **0/2 consumed.** Prior attempts rejected unsupported formats before mutation. | Privately verify supported formats and supported snapshot, preserve it in memory, obtain fresh owner idle readiness with an exact owned anchor, then claim. Preserve unsupported/rich data rather than stripping it. |

The current [Codex diagnosis](../evidence/live-acceptance-continuation/codex/attempt-2/diagnosis.json) retains the actual missing-outcome finding. Its [image and tool evidence](../evidence/live-acceptance-continuation/codex/attempt-2/typed.json) and independent fixture check prove `TRACE Codex verified café 日本語` exactly. That partial success does not complete HOST-01.

For glow, [the actual failed receipt](../evidence/live-acceptance-continuation/glow-supplemental-1/receipt.json) remains unchanged. The fixture's C# byte array serializes as canonical `GBwo`; the driver now accepts those exact RGB bytes and retains the actual capture metadata/checkpoint before validation. A reference click must be a real Sky accessibility mouse click; TRACE then uses the fresh exact center. Preserve all five counters, mouse-up, pixel, focus, generation and normal-close/parent-loss cleanup oracles.

Claude's prior four unknown client-state changes cannot be recovered from the sanitized receipt after temporary cleanup. Static writer inspection identified feature/experiment cache writes in the updated host, but cached flags can affect behavior. Generic volatile/cache exemptions, automatic settings restoration and declarations of unchanged settings remain unsupported. A precise prospective handling plan is useful work; an unexplained semantic change remains blocking.

Use each driver's `--plan` and the frozen contract before live execution. Typing/clipboard readiness must be a direct owner statement within 60 seconds, bound to the retained owned anchor; a passing poll or an old statement cannot provide it. Keep the anchor alive through native/input cleanup and record its exact exit separately. Never replay uncertain input.

## 5. Finish REPLAY as the largest independent task

The actual [two-instance feasibility verification](../evidence/computer-use-method/replay-feasibility/verification.json) passes: the second isolated native REPLAY instance recorded the exact first editor for 3.795 seconds, VP9 at 2224 by 1444. Root inspected decoded synthetic content; both exact app generations exited and grants were revoked. Reuse this result. Its original harness failure remains preserved beside the reconciliation; do not record it again to hide that failure.

[The preparation module](../scripts/accept-replay-workflow.cjs) contains fixed ordered stages, typed edits, independent verification predicates and injected tests. **Update, 22 October 2026: Claude added the production runtime adapter and durable manual command loop ([runtime](../scripts/replay-workflow-runtime.cjs), [offline checks](../evidence/computer-use-method/replay-adapter/offline-checks.json)). They have not run live; see [REPLAY production adapter](GAP_CLOSURE_STATUS.md#replay-production-adapter).**

1. Inspect the existing REPLAY automation contract and real MCP schemas in the owner's separate `replay-studio` checkout. The pinned package/build identities are in the preparation plan and feasibility receipt. Obtain the existing package on Windows; this Git repository does not include the app binary.
2. Launch two isolated app instances with both `--smoke-test` and `--smoke-output`. Retain app handles immediately, even if readiness fails. Provision only the required temporary import/export roots and grants through the existing harness/preload API.
3. Prepare a synthetic owned TRACE fixture with a visibly textured privacy region. Bind HWND, PID, birth and Windows session. Record that exact window, perform the declared TRACE demonstration and stop by exact recording ID.
4. Have the second instance record the first editor's exact window while edits are created. Apply the declared trim, timed callout, privacy blur and offline WAV placement through the typed public API. Retain request IDs and expected revisions.
5. Use actual connected TRACE for the declared editor controls and completed-file playback; retain fresh PNG/accessibility and independent preview/state evidence. API edits and injected callback tests cannot substitute for those native actions.
6. Export **`fixture-demo.mp4`** and **`editor-walkthrough.mp4`**. Independently decode and compare frames before/during/after effects, privacy reduction, audio timing/signal, streams, duration and hashes; visually inspect actual outputs. Offline signal checks do not claim semantic listening. Make no paid ElevenLabs request.
7. Revoke owned grants, close transports and verify exact app-generation exits; terminal process evidence includes `exitCode` **or** `signalCode`. Live WebM can lack container duration: use packet timestamps, preserving measured scope. Reconcile original durable jobs/bytes before retrying an uncertain request.

## 6. Close the remaining acceptance and delivery gates

- Review [the recovery map](../evidence/computer-use-method/effective-recovery-map.json): 15 failure/input pairs have compatible scoped coverage. Three older receipts lack later native-owner-exit metadata. Keep those limits explicit.
- Review [the production-owner map](../evidence/computer-use-method/production-owner-map.json): current-source physical/injected stop relevance still needs proof. Historical physical Escape passes and unchanged hook files alone cannot cover later native dispatch/shutdown changes.
- After live work is complete, verify clean Windows installation, configuration preservation and rollback from the exact archive. Keep version `0.1.0-alpha.3.3` unless a separately agreed version change is part of the task.
- Update the requirement-to-evidence checklist and README from verified results. Run required local checks and hosted CI. The last older CI run was unable to start due to GitHub billing; inspect the new PR's real run before claiming current status.
- Open a focused draft follow-up PR against this uploaded checkpoint. State what passes, what remains blocked and what was not run. Preserve all earlier failures and finite ledgers; do not merge, tag or publish a release as part of this handoff.
- Update `gap-progress.json`, regenerate the Markdown/dashboard, and capture the supported second-brain milestone with the stable workstream subject `computer-use-gap-closure-implementation`.

## 7. Return work for Codex review

Provide the follow-up PR URL, commit hashes, changed file list, exact checks and receipts, remaining attempt budgets, unresolved settings/recovery obligations and the newest second-brain note ID. Leave no active test-owned process, grant or native lease without an explicit retained ownership/cleanup handoff.

Codex's next task is review of Claude's actual diff and evidence when the owner resumes that review. The owner requested High effort with bounded lower-effort agents; if a task genuinely requires xhigh, stop and tell the owner before proceeding.
