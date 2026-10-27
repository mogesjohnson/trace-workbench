# Readiness and routing

## Match the operation

Inspect connected tool names, schemas, and current provider diagnostics. Bind each step to a provider that supports the requested operation in the intended application, resource/profile, and environment. A reader is not necessarily an editor/exporter. A remote browser does not inherit local files or signed-in accounts. The user's selected browser/profile/window remains a hard constraint.

Prefer a suitable connected application API, then a structured browser interface for page interactions, then TRACE for native controls and unsupported UI surfaces. Discover app/browser operation names from the host. A declared capability or source module does not establish a ready adapter or authorize a duplicate attempt after uncertain delivery.

When no ready provider implements a requested operation, retain that checklist item as incomplete with its concrete prerequisite. Continue independent supported work. If a provider disappears before dispatch, refresh readiness and route again. After possible dispatch, first reconcile the original effect and cleanup before considering another route.

## TRACE's native boundary

The native MCP interface contains six tools:

| Tool | Purpose |
| --- | --- |
| `trace_computer_doctor` | Checks installed provider readiness without desktop input |
| `trace_computer_list_windows` | Returns exact window IDs and available process/ownership evidence |
| `trace_computer_open_session` | Binds one discovered window and acquires native ownership |
| `trace_computer_observe` | Returns current PNG, accessibility, target/focus evidence, and observation ID |
| `trace_computer_act` | Consumes one observation for one operation, then refreshes state |
| `trace_computer_close_session` | Releases the session without closing the application |

Inspect diagnostics for readiness and the available machine-readable constraints, and consult the current action schema. A changed native helper can need rebuilding/reconnection; verify diagnostics afterward. Standard operations include activation, coordinate/element click, literal text, key chords, vertical scroll, drag, accessibility invocation, and editable values. Current native wheel input uses vertical multiples of 120; horizontal wheel input is unsupported. Keep the strictest provider constraint even when a broader schema accepts a value.

The orchestration library composes providers above this interface; it creates no extra native MCP operations. Application launch/attach recipes, browser navigation, clipboard transactions, and artifact transfer must use an actual connected adapter/host operation. Discover their support rather than inventing `trace_computer_launch`, browser tools, or transfer behavior.

## Transition and ownership

Keep task identity separate from its current window/tab/document. Track target environment, application/resource identity, current generation, provider, and whether the task created the resource. A title or shared PID is insufficient to establish ownership. Use exact discovery and available process-creation/session/owner-window evidence.

Release the native lease before changing windows, entering a dialog, switching providers, or doing lengthy analysis. Discover the receiving target and obtain new evidence; earlier element IDs/coordinates cannot cross that boundary. If input cleanup is unresolved, preserve its recovery obligation instead of transferring ownership around it.

For file handoffs, bind source and receiving environments/paths explicitly. Inspect receiving bytes/hash after a real transfer. A local path string does not establish remote file availability; a hash-comparison helper does not itself upload, paste, or transfer files.
