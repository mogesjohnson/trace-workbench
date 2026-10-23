# REPLAY live acceptance run

`A4-REPLAY` is **blocked during provision**. Both authorized attempts are consumed: [attempt 1](../evidence/computer-use-method/replay-workflow/attempt-1/receipt.json) found no unique visible editor at its first lookup; [attempt 2](../evidence/computer-use-method/replay-workflow/attempt-2/receipt.json) passed visibility but rejected process/window identity equality. No grant, recording, fixture or TRACE input was started. The second run confirmed exact editor cleanup. The first run's later independent exit reconciliation remains separate from its original incomplete cleanup result.

The visibility lookup now waits for the actual visible window, and cleanup retains the original child-process handle across Playwright teardown. Identity rejection remains enforced; the second run did not retain the rejected window identity, so its precise mismatching field and cause are unproved. A further full run requires an explicit owner extension under SPEC.md's retry cap. The command below is historical usage, not authorization for another attempt. Keep current package pins, original receipts and the actual prepared fixture.

```powershell
node scripts/accept-replay-workflow.cjs --plan
node scripts/accept-replay-workflow.cjs evidence/computer-use-method/replay-workflow/attempt-1 --live --owner-decision <actual-owner-instruction-reference> --attempt 1
```

Keep that process running; advance one stage at a time with `node scripts/accept-replay-workflow.cjs --advance <run-directory> <stage> [--input <actual-evidence-file>]`. Every response must settle before the next stage. A status file, invented approval reference or previous agent's prose cannot establish an actual tool call or source review.

| Stage, in order | Required action/evidence |
| --- | --- |
| `provision` | Two isolated pinned REPLAY instances and owned fixture; retain exact native generations/HWNDs from the private recovery checkpoint. |
| `fixture-ready` | Actual connected TRACE session opened after fixture launch and fresh inspected PNG/accessibility; input `{traceSessionId, observationId}`. |
| `fixture-record-start` | Starts capture of the exact fixture window. |
| `fixture-record-stop` | First use actual TRACE to type `TRACE REPLAY demo` and increment twice; retain at least three completed actions and exact final text/count 2. Keep recording at least eight seconds and long enough after the final increment for a useful six-second cut. Supply `{traceSessionId}`. Close the fixture TRACE session before switching targets. |
| `prepare-source-review` | Inspect the actual original capture; select source-media seconds using `{sourceStart}`. Renders the selected six-second segment and five bound source PNGs. Do not infer source seconds from model/tool wall-clock latency. |
| `confirm-source-review` | Inspect the entire segment and all generated frames. Bind source/segment/frame hashes and source bounds; describe a visible useful action with segment-relative times and a later frame showing exact expected text and count 2. Final live fixture state alone is insufficient. |
| `walkthrough-record-start` | Second instance records the exact first-editor window. |
| `edit-fixture` | Apply selected source trim, composition-time callout/blur 1–3 seconds and one-second offline WAV at 1.5 seconds. No paid provider calls. |
| `trace-editor-controls` | Actual TRACE starts and pauses editor preview; at least two actions, independent paused position ≥2.2 seconds and unchanged recipe. Supply `{traceSessionId}`. |
| `export-fixture` | Export `fixture-demo.mp4`, with authoritative revision, job and output identity. |
| `prepare-completed-playback` | Import exact completed export and open preview at zero. |
| `trace-completed-playback` | Actual TRACE starts completed-file playback; independent clock advances >0.2 seconds. Supply `{traceSessionId}`, then close TRACE ownership. |
| `walkthrough-record-stop` | Stop the retained exact recording ID. |
| `export-walkthrough` | Export `editor-walkthrough.mp4`. |
| `verify-media` | Independent decode, duration, effect timing, blur/callout differences, audio placement and original source hash checks. |
| `root-review` | Inspect both videos and every decoded review frame; supply `{pass:true, reviewedFrames:[{sha256, observed}]}`. Audio measurements establish signal, not semantic listening. |
| `cleanup` | Revoke grants, close transports and verify exact-generation app/fixture exits. A good result still requires the final root audit before APP-01 promotion. |

The source review input names `reviewedEntireSegment`, `sourceSha256`, `sourceStart`, `sourceEnd`, `segmentSha256`, all `reviewedFrames`, `observedAction:{from,to,description}` and `observedResult:{frameSha256,text,count}`. Use actual hashes and observations from `receipt.state.sourceReview`; no illustrative values establish a review. The result frame must follow the visible action in the selected segment. Composition duration stays six seconds regardless of selected source offset.

`--status <run-directory>` is read-only. `--advance <run-directory> abort` reconciles read-only and cleans up. A failed stage stops progression; unknown or pending delivery stays blocked even after process cleanup. The private recovery checkpoint retains ownership, inputs, revisions and request IDs, but authorizes neither cached-PID termination nor automatic restart/replay. No Playwright UI clicks or renderer-driven edits can substitute for the declared actual TRACE controls.
