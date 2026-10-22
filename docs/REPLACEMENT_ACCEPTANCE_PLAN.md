# Replacement acceptance cases

Prepared 21 October 2026. **Status: the owner approved the five fixed cases for bounded execution.** The [direct owner-decision record](../evidence/replacement-acceptance/owner-decision.json) retains that choice and its one-plus-one budgets. Individual live receipts govern outcomes; approval does not change an earlier receipt, turn a regression into acceptance, or complete a milestone.

The [specification](../SPEC.md#agent-completion-contract) says, “A second failure ends that case,” and requires preserving failures and reusing compatible passing evidence. Its [glow and window records](../SPEC.md) explicitly require an owner decision on replacements. The owner has now selected the concrete set below. This adds no per-action permission system.

## Historical outcomes remain unchanged

| Historical case | Retained outcome and evidence | Gap the proposed replacement addresses |
| --- | --- | --- |
| `A31-GLOW` / `GLOW-LIVE` | Exhausted `fail`. [Case status](../evidence/0.1.0-alpha.3.1/case-status.json) retains attempt 1, the interrupted attempt-2 preparation and the failed independent continuation. [Focused regression](../evidence/0.1.0-alpha.3.1/glow-regression/receipt.json) passed its narrower scope. | Full current native-owner lifecycle plus the separate reference-executor and TRACE edge clicks. |
| `A3-WINDOW` | Exhausted `fail`: [initial receipt](../evidence/0.1.0-alpha.3.3/targeting/receipt.json), [corrective retry](../evidence/0.1.0-alpha.3.3/window-retry/receipt.json). [Focused regression](../evidence/0.1.0-alpha.3.3/window-regression/receipt.json) remains a regression pass. | Full move/minimize stale-target rejection and a fresh coordinate hit after each transition on the selected display. |
| `A32-PROBE` | Exhausted `fail`; [probe status](../evidence/0.1.0-alpha.3.2/probe-status.json) preserves both attempts. Its job/release, detached-watch, lease-compatibility and injection findings retain their stated scope. | A proposed production-owner acceptance contract, replacing the old feasibility prerequisite rather than rerunning the obsolete whole probe. |
| `A32-PROBE-FOCUSED-TYPING` | Two failed [first](../evidence/0.1.0-alpha.3.2/focused-typing/receipt.json) / [second](../evidence/0.1.0-alpha.3.2/focused-typing-attempt-2/receipt.json) receipts. | Focus verified against both current public observations and the independent owned control before typing. |
| `A32-PROBE-FOCUSED-TYPING-REGRESSION` | Two failed [first](../evidence/0.1.0-alpha.3.2/focused-typing-regression/receipt.json) / [second](../evidence/0.1.0-alpha.3.2/focused-typing-regression-attempt-2/receipt.json) receipts. | Current focus binding and completion sequencing, exercised through real MCP rather than another direct-controller regression. |
| `A32-RECOVERY-CANCEL-MOUSE` | First attempt `fail` at display preflight. The corrective attempt's [running checkpoint](../evidence/0.1.0-alpha.3.2/recovery-cancel-mouse-attempt-2/a32-recovery-cancel-mouse/receipt.json) remains unchanged; its separate [terminal record](../evidence/0.1.0-alpha.3.2/recovery-cancel-mouse-attempt-2/a32-recovery-cancel-mouse/termination.json) is `blocked`. Native release acknowledgement alone did not pass the case. | A complete, terminal MCP cancellation receipt with independent release and exactly one clean follow-up. |
| `A32-RECOVERY-CANCEL-TYPING` | [First](../evidence/0.1.0-alpha.3.2/recovery-cancel-typing/a32-recovery-cancel-typing/receipt.json) and [corrective](../evidence/0.1.0-alpha.3.2/recovery-cancel-typing-attempt-2/a32-recovery-cancel-typing/receipt.json) attempts are `blocked` by inaccessible foreground before input. Both declared attempts were used; these are not delivery failures or passing release observations. | One newly identified, fully preflighted MCP typing-cancellation case. |

The proposed new IDs are `R31-GLOW-NATIVE`, `R3-WINDOW-COORDINATES`, `R32-PRODUCTION-OWNER`, `R32-CANCEL-MOUSE-COMPLETE` and `R32-CANCEL-TYPING-COMPLETE`. The last case also supplies the missing focused controlled-typing delivery evidence; a second new held-typing probe is unnecessary. A future requirement checklist must link the owner decision, replacement receipt and original failures together. It must never rewrite the historical IDs to `pass`.

## Common preflight, evidence and limits

Before UI launch, write a fresh run plan with the selected new ID, the historical IDs it replaces, the recorded owner decision, attempt number, source/binary hashes, target, exact actions and expected result. Each selected replacement receives **one attempt and at most one corrective retry**, with a fresh directory, matching prior-case evidence and an explicit changed precondition or fix. Both `fail` and `blocked` consume a launched attempt for this replacement plan. A missing prerequisite found during read-only preparation stays `not_run`; it must not launch a case under another directory to evade the budget. A second unfinished attempt ends the replacement; no third attempt or automatic continuation is proposed.

For every case:

1. Verify the built supervisor, bridge, marker, pinned engine and synthetic fixture against their source/output manifests. Include the supervisor client, controller, backend, server and actual acceptance driver in the run hashes. Rebuild only helpers whose source changed. Freeze relevant source while the case runs.
2. Read one authoritative native display manifest before the written live plan or any fixture. Pin the complete single-monitor device, primary flag, physical origin/bounds, DPI and capture geometry. Recheck before coordinate input. Neither historical `2880×1800` nor `1920×1080` is an assumed default. A change blocks the run; it is not display-transition acceptance.
3. Require the ordinary unlocked interactive desktop, no existing TRACE owner, clear durable recovery, accessible foreground and an independently observed empty `keystate all`. Do not infer released state from a failed query. `foreground_*`, unavailable desktop/input state and changed topology remain explicit environment blocks.
4. Bind each owned fixture and process to exact HWND, PID, process creation time and Windows session. Titles identify the run for discovery, but do not establish identity alone. Revalidate generation and target state before input; never terminate a process selected only by name or a reused PID.
5. If needed, keep a separate run-owned ordinary anchor window below the active fixture between cases. Its creation/activation is declared setup, uses no injected keys/clicks, elevation or changed guard, and happens with no active operation/lease/recovery. Verify its exact identity, actual foreground and input observability before proceeding. It must have no timer that steals focus. A refused activation stays blocked. This setup is not recovery evidence and cannot clear an unknown prior obligation.
6. Retain sanitized plan, source/fixture hashes, native process identities, independently read fixture state, MCP outcomes, native recovery metadata, exact display manifest, screenshots/hashes and terminal cleanup. Keep executable paths, private control files and fault tokens in ignored `.runtime/` storage. Screenshots contain only the owned fixture; glow desktop captures retain the existing foreign-overlay/interior-color refusal.

Normal cleanup is sequential: settle/cancel the outstanding action, close the native owner and MCP connection, confirm exact owned child/supervisor/marker exit, verify input while the owned fixture or declared anchor remains accessible, then close owned fixtures. Inspect final durable status without clearing it implicitly. Persist a terminal receipt even if any inspection or close fails. An unconfirmed process exit, inaccessible release check or retained record prevents a passing result. Preserve a stale running checkpoint with a separate terminal record if the outer harness itself is terminated.

Every native input operation retains its maximum **15,000 ms** production deadline. Acceptance polling never extends it. Unknown delivery is preserved as `unknown`; do not replay a held action. A clean follow-up is a separately declared different action after independently verified cleanup. These cases do not establish HOST-01, REPLAY editing, rich clipboard support, multi-monitor transitions, clean installation or release/CI readiness.

## R31-GLOW-NATIVE — current lifecycle and two edge clicks

Replaces the open acceptance gap of `A31-GLOW`; requirements CU-01/CU-04. Use one fresh, non-topmost, borderless primary-monitor glow fixture. Initial `count`, `mouseClickCount`, `mouseDownCount`, `mouseUpCount` and `activationCount` are zero; all input is up. The reference executor must actually be available before this case is launched. Its operation receipt is required; a fixture counter change alone cannot attribute a click to that executor.

Exact sequence and pass criteria:

1. Activate the owned fixture as declared setup before starting TRACE ownership. Record native foreground/focused HWND. Open a session through the production MCP server. Identify the actual chain **owned Node MCP → detached TraceSupervisor → TraceActivityIndicator**, checking each process generation and session. Readiness requires one monitor, the native lease and installed physical stop. Foreground/focus must remain unchanged across startup.
2. Save a safe desktop capture while the fixture is foreground. The existing pixel oracle must find all 11 sampled pixels tinted in each top/left band, with the interior matching the known fixture background. Do not replace actual pixels with a visible-style flag or maximum-ever count.
3. Publish the measured left-edge button center, approximately seven physical pixels inside the glow, and wait at most **60 seconds** for exactly one reference-executor left click. Retain that executor's actual tool receipt and point. Independently require `count=1`, `mouseClickCount=1`, `activationCount=1`, one down/up pair and released input. An activation alone cannot substitute for MouseClick. If the executor is absent or sends no click, mark blocked; never substitute a second TRACE click.
4. Take a fresh TRACE observation, map the same measured button center into its physical screenshot coordinates, and send **one** MCP coordinate click. Require `completed`, `count=2`, `mouseClickCount=2`, `activationCount=2`, two total down/up pairs and all-up state. Retain the fresh image and independent fixture state. A miss or unknown result is not retried automatically.
5. Close the session normally. Within **5 seconds** of the close request require the exact native supervisor and marker to exit, no glow pixels in a safe capture, clear recovery and a free desktop lease. Close that MCP process and verify its exit.
6. Open a second fresh MCP/session on the same owned fixture without further clicks. Re-prove unchanged focus and visible glow. Abruptly terminate only that owned Node server after revalidating its creation time. Within **5 seconds** require Node, detached supervisor and marker exit, absent glow, clear recovery and lease handoff. The fixture count remains exactly 2.

All six phases must pass in one replacement attempt. At most three capture-only measurements per planned frame are allowed, using unique filenames; no measurement retry injects input. Any unexpected overlay is a blocked sanitized capture, not permission to capture unrelated desktop contents. The existing focused glow regression is retained as prior evidence; its old Node-owned lifecycle cannot replace this current ownership-chain check.

## R3-WINDOW-COORDINATES — move, minimize, restore and hit

Replaces `A3-WINDOW`; requirements CU-01/CU-02. Use a fresh normal computer fixture, initial counter 0/text empty, its exact public identity, and one production MCP session. Exclude already-passed depth/dialog cases from this driver.

For each transition below, the old observation is used for exactly one deliberately stale invocation. Require top-level `not_dispatched`, `window_moved`, zero primary mutation and an unchanged independent counter. The stale observation is consumed. Then observe again, verify PNG dimensions against current native/capture bounds, compute the center of the newly observed counter element in screenshot coordinates, and perform one coordinate click.

| Transition | Exact setup after the old observation | Fresh-state and effect oracle |
| --- | --- | --- |
| Move | Owned fixture command moves the window once within the pinned monitor; wait for its acknowledged geometry change. | Fresh observation/native and fixture geometry agree; exactly one new coordinate click changes counter `0→1`. |
| Minimize | Owned fixture command minimizes once; independently confirm iconic/minimized state before the stale invocation. Do not pre-restore to make observation pass. | Fresh observation restores the selected window, reports restore preparation, and waits for settled non-iconic positive geometry. One new coordinate click changes counter `1→2`. |

After each successful click, retain its fresh observation and independently stable counter. Text stays empty, no modal appears, and no additional clicks occur during the settle checks. Final state is count 2, restored/enabled target, all input up, native ownership closed and every owned helper exited. Preserve `unknown` if a dispatch/post-action capture fails; independent state may prevent replay but does not silently satisfy this case's required `completed` result.

## R32-PRODUCTION-OWNER — replace the obsolete feasibility prerequisite

Proposes a production acceptance/evidence gate for CU-04 in place of re-executing exhausted `A32-PROBE`. This requires the owner's explicit choice of that replacement contract. It does not relabel the old feasibility receipt or assert that implementation alone passed it.

New bounded exclusion subcase, with **no input actions**:

1. On the accessible owned fixture, start production MCP process A under artifact root A and open its session. Record Node/native/marker identities and readiness. Independently require no held input or durable recovery.
2. Start production MCP process B under distinct root B. Discover the same exact target; opening its session must return `desktop_busy`. B must not obtain a native owner/marker or dispatch an input child. Ordinary discovery/diagnostics are allowed; a changed error or second ready owner fails exclusion.
3. Close A with exact helper-exit verification. Using B, make one newly planned session-open request, require native readiness and close it. Independently verify all-up state, no recovery and a free lease. This is a session handoff, not a replayed input action.

Complete the following evidence map without repeating compatible passed desktop cases:

| Production invariant | Required accepted evidence |
| --- | --- |
| Exclusive lease across processes/artifact roots | The new exclusion/handoff subcase above. Retain the old native/Node pipe compatibility result at its historical scope. |
| Suspended child assigned before Resume; no arbitrary launcher | Current pinned native `OperationProcess`/provider code and a live production dispatch receipt with PID, creation time, `inJob:true`; complete source/output hashes. An arbitrary provider supplied through a public MCP request is never introduced. |
| Ownership survives Node death long enough to clean input | Completed production MCP Node-death recovery cells with independent exact input-child/native-owner exit, release, clear state and one follow-up. A direct watcher probe alone is insufficient. |
| Native owner death kills owned work and keeps unresolved input quarantined | Completed production supervisor-death cells with independent child exit, durable restart block, non-clearing check, verified apply and one follow-up. Do not release/recover while the exact supervisor is still alive. |
| Focused controlled typing reaches the intended control | `R32-CANCEL-TYPING-COMPLETE` below. This fills the earlier missing delivery/focus observation without another direct-controller attempt. |
| Real physical stop versus ordinary injected Escape | Reuse compatible [mouse](../evidence/0.1.0-alpha.3.2/stop-physical-mouse/receipt.json), [keyboard](../evidence/0.1.0-alpha.3.2/stop-physical-keyboard-attempt-2/receipt.json) and [injected Escape](../evidence/0.1.0-alpha.3.2/stop-injected-escape/receipt.json) receipts at their actual tested source/display scope. Retain the blocked first keyboard attempt. A material change to a stop path requires its own relevance review. |
| Failed release acknowledgement cannot clear quarantine | Reuse the compatible [two-phase mouse receipt](../evidence/0.1.0-alpha.3.2/quarantine-ack-mouse/receipt.json), which separately proves actual release before deliberate acknowledgement failure. It does not stand in for a genuine failed physical release or all keyboard cases. |
| Concurrent shutdown callers wait for the same cleanup | Current native shared-cleanup source and its pure concurrency/failure selftests; any affected live lifecycle cells retain their separately tested hashes. |

Publish the new owner-gate result only after the required map is complete. Missing cells remain `not_run`/`blocked`; the map is not an automatic waiver. Complete A32-RECOVERY still requires every separately declared cancellation/timeout/disconnect/Node-death/supervisor-death × mouse/chord/typing cell. This plan does not replace an unfinished cell with a physical-stop pass.

## R32-CANCEL-MOUSE-COMPLETE and R32-CANCEL-TYPING-COMPLETE

These two new CU-04 cases reuse the production MCP recovery driver's controlled-provider path with fixed replacement IDs and explicit links to the exhausted original cells. They are separate attempts with separate receipts. Private injection stays in the source-owned fixture subprocess; no public tool/action/environment test parameter is added.

Each starts with a fresh exact computer fixture, counter 0/text empty, pinned display and fully observable all-up input. Open the production session. Use **one pinned-engine focus click** on the observed text input. Before held input, require both `observation.focused.elementId` bound to that unique observed control and independent `focusedControl === 'traceTextInput'`. A selector-string mismatch must be resolved by the implemented unique AutomationId/geometry/metadata binding, never by dropping focus verification.

| Phase | Mouse replacement | Typing replacement |
| --- | --- | --- |
| Primary request | One MCP `drag` across two predeclared adjacent empty lower-right fixture points. The private backend substitutes one controlled left-button hold at the measured start. | One MCP `type_text` of literal `abc`. The private backend substitutes one controlled `type-hold abc`, leaving C down. |
| Held proof | Independent async state confirms VK 1 down; journal binds the child PID/creation time and job admission. | Independent async state confirms VK 67 down; public and independent focus evidence were already saved. |
| Interruption | Cancel that single outstanding standard MCP request through the SDK `AbortSignal`, only after held proof. | Same standard request cancellation; no custom cancel tool or synthetic Escape. |
| Native result | Original action remains `unknown`; native journal reports `cancelled`, confirmed owned-process exit and declared release. | Same, with declared keyboard/Unicode cleanup retained. |
| Independent target oracle | Count 0 and text empty before follow-up; no drop/click side effect at the empty point. | Count 0; actual text must match `^abc+$` and stop changing after cleanup. Record the exact observed string and repeated-C count. Missing/wrong prefix, another character or continuing growth fails. |
| Recovery/follow-up | Independently confirm exact child exit, all keys/buttons up, clear durable status and closed native owner. A newly planned session under another artifact root performs exactly one pinned-engine counter invocation, producing `0→1`. | Identical cleanup and one counter invocation; the verified text remains stable. |

The typing oracle explicitly accounts for OS autorepeat while the final C is deliberately held. It proves focused interrupted controlled typing, not arbitrary application semantics or exact uninterrupted text entry. The older focused case's exact-`abc` oracle is preserved in its failed receipts. Selecting this replacement contract is an explicit review decision, not a retroactive relaxation of that old oracle. The production pinned engine still supplies the real focus click and clean follow-up; the held provider is labeled controlled in every receipt.

If cancellation happens before confirmed held input, key inspection fails, native release is unconfirmed, the follow-up misses or the terminal receipt is incomplete, the replacement cannot pass. Never re-hold after the deadline to salvage the attempt. Keep the fixture accessible until independent cleanup checks finish, then close it. The newer terminal-finally handling must persist both the primary outcome and any later verification block.

## Implemented harnesses for review

The accepted contracts have separate source-owned entry points. Importing them or selecting `--plan` performs no UI or input. The owner decision authorizes execution; each separate receipt still must prove its declared result. Historical scripts and receipts remain separate.

| New driver | Fixed case and retained boundary |
| --- | --- |
| [Glow](../scripts/accept-replacement-glow.cjs) | `R31-GLOW-NATIVE`: exact native ownership chain/generations/sessions, normal and parent-loss cleanup, safe pixel oracle and a 60-second checkpoint for a real separate reference executor. Its actual click receipt is required. |
| [Window](../scripts/accept-replacement-window.cjs) | `R3-WINDOW-COORDINATES`: stale-before-fresh move/minimize checks, two fresh measured coordinate clicks and sequential terminal cleanup. |
| [Production owner](../scripts/accept-replacement-owner.cjs) | `R32-PRODUCTION-OWNER`: two distinct MCP roots, `desktop_busy`, no input calls and verified handoff. Its evidence map stays incomplete until every separately required receipt/relevance review is supplied. A process snapshot proves only the observed moment. |
| [Cancellation replacements](../scripts/accept-replacement-recovery.cjs) | Only the two declared `R32-CANCEL-*-COMPLETE` IDs: public plus independent focus, native and CIM generations/session/user identity, held-child job evidence, standard request cancellation, exact owner/child exit and a new pinned-engine follow-up. |
| [Shared acceptance helpers](../scripts/replacement-acceptance-common.cjs) | Fixed known providers, actual display manifest, exact prior replacement ID/attempt/decision, managed source/output hashes and private launch configuration. No public tool or action parameter was added. |

Pure/injected tests cover wrong-case retries, missing decision metadata, extra attempts, identity/parent/session substitution, missing focus, stale-before-fresh order, cleanup failure and exclusion/handoff without executing native input. These tests establish harness contracts, not acceptance outcomes.

The following commands are implemented read-only plan entry points:

```text
node scripts/accept-replacement-glow.cjs --plan
node scripts/accept-replacement-window.cjs --plan
node scripts/accept-replacement-owner.cjs --plan
node scripts/accept-replacement-recovery.cjs --plan --case R32-CANCEL-MOUSE-COMPLETE
node scripts/accept-replacement-recovery.cjs --plan --case R32-CANCEL-TYPING-COMPLETE
```

After an actual owner decision, live mode additionally requires a fresh evidence directory, `--live` and `--owner-decision` containing that real decision reference. Glow also requires `--reference-executor` identifying the actual separate executor. An attempt-2 run requires `--attempt 2 --prior <matching-attempt-1-directory> --change <actual-change>`. Never supply invented approval text or launch a third attempt in a fresh directory.

Proposed receipt roots remain `evidence/replacement-acceptance/<new-case-id>/attempt-1/` and, if permitted, `attempt-2/`. Source and output hashes are checked again for each actual run. A source fix requires a relevance review of existing evidence rather than repeating every passed case.

## Review decision and completion rule

The owner selected all five new IDs, the actions/oracles above, the one-plus-one budgets and the evidence mapping for `R32-PRODUCTION-OWNER`. This decision is explicit in the linked record; no combined-evidence waiver or extra attempt was approved.

After a decision, finish and review only the required harness adaptations, then execute selected unfinished cases one at a time on the pinned ordinary desktop. Stop a run at unresolved identity, input, release, display or ownership uncertainty. A replacement result is `pass` only when every declared phase and cleanup oracle passes; otherwise retain `fail`, `blocked` or `not_run` with the exact next prerequisite. Update a new requirement-to-evidence map and the current checkpoint without altering historical statuses. CI, host workflows, REPLAY, installation and release keep their own gates.
