# Installed application discovery and launch — item 16

Use `trace-workbench computer apps list`, then
`trace-workbench computer apps launch <returned-app-ID>`. The CLI rediscovers the
catalog before launch. Library callers can use exported `createInstalledApplications`
with `discover()` and `launch(appId)`. No executable, arguments, script or shell
command is accepted by launch. Existing configured application recipes are retained.

Coverage is [registered local desktop EXEs](INSTALLED_APPS_NATIVE.md), not every
installed app. Results distinguish application identities and current window
relationships. Files are canonical regular EXEs; IDs bind path and file metadata,
not an executable signature or publisher trust. Unverifiable files are skipped
with partial/count metadata. No launch occurs during discovery.

Launch rechecks registration and file identity, claims native desktop ownership,
and spawns the exact executable with empty argv and no shell. It binds the actual
PID/creation/session/executable, discovers windows of that process generation,
and rechecks process/file/window identity before returning `outcome: "launched"`.
Opening an input session still requires fresh native tool discovery/observation.
Multiple verified windows are returned for explicit choice, not title guessing.

An exiting launcher, single-instance forwarding, process substitution, missing
window, cancellation or cleanup failure cannot establish handoff success; after
possible spawn the result remains `unknown`. No auto retry occurs, and an instance
rejects repeated attempts for the same app ID. Inspect actual app state before
deciding any further launch. No existing process is adopted or killed by inference.

The native lease/marker is released after bounded handoff. The launched app stays
open; its independent process is not an input-helper job child and crash cleanup
of that application is not promised. Unknown lease cleanup stays explicit.
This can activate the desktop and requires normal host authorization/readiness.
Installed defaults/settings/registrations are not edited. This library adds no MCP tool.

The [owned-fixture receipt](../evidence/visual-app-handoff/acceptance.json) records
registered discovery/launch/window handoff and two independently decoded MCP
captures with UIA calls disabled. It preserves the original private-driver failure,
one corrected retry, exact cleanup and coverage/display limits. The test used and
removed only its own temporary registration; it establishes no arbitrary-app claim.
