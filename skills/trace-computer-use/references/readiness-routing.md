# Readiness and routing

## Match the operation

Inspect connected tool names, schemas, and current provider diagnostics. Bind each step to a provider that supports the requested operation in the intended application, resource/profile, and environment. A reader is not necessarily an editor/exporter. A remote browser does not inherit local files or signed-in accounts. The user's selected browser/profile/window remains a hard constraint.

Prefer a suitable connected application API, then a structured browser interface for page interactions, then TRACE for native controls and unsupported UI surfaces. Discover app/browser operation names from the host. A declared capability or source module does not establish a ready adapter or authorize a duplicate attempt after uncertain delivery.

When no ready provider implements a requested operation, retain that checklist item as incomplete with its concrete prerequisite. Continue independent supported work. If a provider disappears before dispatch, refresh readiness and route again. After possible dispatch, first reconcile the original effect and cleanup before considering another route.

## TRACE's native boundary

The current native MCP interface can expose these seven tools. Use the connected schema to determine what this host exposes.

| Tool | Purpose |
| --- | --- |
| `trace_computer_doctor` | Checks installed provider readiness without desktop input |
| `trace_computer_list_windows` | Returns exact window IDs and available process/ownership evidence |
| `trace_computer_launch` | Starts a registered app, packaged app or allowlisted Settings page with no session open, and returns its windows |
| `trace_computer_open_session` | Binds one discovered window and acquires native ownership |
| `trace_computer_observe` | Returns current target/focus evidence, an observation ID, and accessibility or image evidence according to mode |
| `trace_computer_act` | Consumes one observation for one operation, then refreshes state |
| `trace_computer_close_session` | Releases the session without closing the application |

Inspect diagnostics for readiness and consult the current action schema. A changed native helper can need rebuilding and reconnection. Verify diagnostics afterward. Use `trace_computer_doctor` with `verbose: true` when you need the effective action rules in `support.actions`. Apply the strictest schema, action contract and provider readiness constraint.

For default wheel input, use `deltaX: 0` and nonzero `deltaY` in 120-unit steps. Use `placement: "point"` for wheel at the requested point, including horizontal wheel, only when the connected schema and `support.actions.scroll.point` advertise it and native supervision and source-matched helpers are ready. Follow the advertised bounds and increments and keep at least one delta nonzero.

## Discover or launch a window

Use the listing's exact window ID. The default listing omits tiny, shell and helper windows. Use `verbose: true` when you need those windows or fuller identity evidence.

If the requested app needs starting and the connected schema exposes `trace_computer_launch`, call it with no native session open. Its built-in catalog accepts registered App Paths names such as `notepad`, `settings`, exact packaged AUMIDs and Settings pages on the tool's allowlist. Choose the exact intended window from the returned `windows` and open it by ID without listing again. `handedOff: true` identifies a verified new window hosted by another process. For a packaged app, `already_running` means the existing app was left alone and no window was returned. Discover it by exact ID if attaching is in scope. After an `unknown` launch, list windows to reconcile the outcome and avoid relaunching.

When the task needs an application launch/attach recipe, browser navigation, a clipboard transaction, or artifact transfer, discover a connected adapter or host operation that supports the requested effect.

## Transition and ownership

Keep task identity separate from its current window/tab/document. Track target environment, application/resource identity, current generation, provider, and whether the task created the resource. A title or shared PID is insufficient to establish ownership. Use exact discovery and available process-creation/session/owner-window evidence.

Release the native lease before switching providers, opening a separate target session, or doing lengthy analysis. For a uniquely identified owned modal, follow the [same-lease dialog workflow](operation-and-recovery.md#dispatch-effect-and-cleanup). Ground each action in the receiving target's current evidence. If input cleanup is unresolved, preserve its recovery obligation instead of transferring ownership around it.

For file handoffs, bind source and receiving environments/paths explicitly. Inspect receiving bytes/hash after a real transfer. A local path string does not establish remote file availability; a hash-comparison helper does not itself upload, paste, or transfer files.
