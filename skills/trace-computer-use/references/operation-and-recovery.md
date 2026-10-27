# Native operation and recovery

## Ground the action

A TRACE observation belongs to one exact session/window, authorizes one action, and expires after 60 seconds. Select elements from that observation. Keep integer window-local physical coordinates distinct from physical screen element bounds, resized image previews, and browser CSS pixels. Measure against the original PNG; changed geometry or identity requires new evidence.

Use an enabled element for suitable `invoke` or `set_value`; otherwise ground a coordinate action in the PNG. When `accessibility.truncated` is true and relevant controls are deeper, request a larger `accessibilityDepth` within 1–32. The server retains that depth for action validation. After a miss, measure the target again; nearby repeated guesses do not repair the evidence.

Before literal text, Ctrl+A, Space, or another shortcut, establish the intended control's focus. Inspect the available `focused` envelope and its provenance/unavailable reason. Foreground-window identity alone cannot prove which field receives input. If focus evidence is unavailable or ambiguous, deliberately focus the intended control and inspect current evidence before typing; gather another structured read if necessary.

Observation can restore a minimized target; activation and native input use the active unlocked desktop. Plan before claiming ownership and keep desktop blocks bounded. A separate account or Task View is not background isolation. Retain observed physical monitor/DPI/capture configuration for coordinate acceptance; topology changes invalidate affected evidence.

## Dispatch, effect, and cleanup

Keep preparatory activation/restoration, primary input, observed effect, and physical cleanup separate.

| Outcome | Continuation |
| --- | --- |
| `not_dispatched` | Resolve the condition, obtain fresh evidence, then permit at most one corrective retry for the same step |
| `completed` with fresh state | Independently inspect the declared effect; delivery alone does not complete the requested result |
| `unknown`, missing receipt, native failure, or failed post-action capture | Reinspect the original target/effect; it may already have happened |
| Recovery required, cleanup uncertain, or native exit unconfirmed | Preserve quarantine; stop affected desktop input until independent recovery verification |

If a fresh read proves the intended effect occurred, continue without replay. If it proves absence and cleanup is safe, changed preconditions/evidence can justify the one corrective retry. Keep unresolved effects pending. A different provider or restarted process cannot clear them.

Known `not_dispatched` `window_blocked` is a targeting condition when physical cleanup is safe. A real modal can disable its parent even when UIA children appear enabled. Release the parent session, discover its exact enabled owned dialog, observe/complete or dismiss it, then rediscover/observe the parent. Keep the same user effect and give each grounded action step its own retry history. A modeless child does not establish modal acceptance.

Physical quarantine follows the affected desktop across controllers/sessions. Independent reads may continue. A ready application API may complete an unrelated effect when it neither activates/sends input to that desktop nor changes or depends on the unresolved effect. Preserve the original uncertainty and cleanup obligation.

## Clipboard transactions

Use an available clipboard adapter only within its declared format support. TRACE's text-only adapter rejects unsupported formats before mutation; a clipboard containing text can also contain rich or application formats. Preserve a rejected clipboard rather than stripping those formats to make a test pass.

Keep original clipboard bytes and metadata private. Verify the synthetic/requested text and current clipboard ownership immediately before paste. Establish exact target focus and send one paste; after an uncertain reply, inspect the original target before considering another action.

Before any native input can use the temporary clipboard, durably defer automatic restoration with the adapter's `deferAutomaticRestore` operation. Restore originals only after owned native work has drained/exited, the session is closed, input is independently released and quarantine is clear. The host's `inputQuiescent` acknowledgement must describe that actual proof. A helper EOF, failed close or a new controller cannot supply it. If the clipboard changed or cleanup remains uncertain, retain protected recovery and do not abandon it automatically. Fresh supported-byte comparison verifies restoration; it does not recreate clipboard history or original ownership.

## Recover and release

Marker loss stops input. Establish delivery/cleanup and close the failed session before reopening; a new capture alone does not restore the marker. Use the installed executor's documented recovery command and current diagnostics. `computer recover --check` is inspection; `--apply`, where implemented, must establish owned-process exit and released input before clearing recovery state. Retain an unresolved result instead of switching servers around it.

Claim native supervision, durable per-user quarantine, keyboard/mouse balancing, or physical Escape only at their actual tested scope. A source implementation, simulated coordinator, or MCP close receipt cannot independently prove physical input release or crash-safe ownership. Physical stop and interruption acceptance remain separate from ordinary successful actions.

Close owned sessions on completion, target transition, or inability to continue. A failed close leaves cleanup unresolved. Close only task-created applications/tabs/profiles; preserve attached user resources. Record human interruption separately from product failure.

For handoff/resume, keep minimal nonsecret structure: requested effects/steps, provider/target binding, retry budget, verification, artifacts, uncertainty, and cleanup obligations. Rebind current identities and reinspect effects, including previously completed ones. Keep credentials, arbitrary provider messages, typed payloads, and screenshot bytes out of generic checkpoints. Checkpoint recovery is not rollback of external service changes.
