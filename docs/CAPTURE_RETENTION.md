# Opt-in capture retention

Development source supports `TRACE_CAPTURE_KEEP_LAST=1` through `100` in the
computer MCP server's environment. Restart that server after changing it.
Unset or `0` preserves captures, matching V1. Invalid values fail startup with
`invalid_capture_retention`. Embedders can pass `captureKeepLast` to
`createComputerController`; an explicit option overrides the environment.
No settings or installed skill copies are changed automatically.

The policy registers only newly validated, journaled UUID PNGs in the current
session. Action refreshes register after the action-completed journal write.
It keeps the newest N registered captures plus the latest actionable frame;
that protected frame can exceed N. Accessibility-only reads create no capture.
Failed, unregistered, historical and crash-left files remain untouched, as do
journals and recovery records. There is no directory scan or recursive delete.

After confirmed session cleanup, a sweep attempts to remove registered captures.
Uncertain indicator, ownership or backend shutdown cleanup prevents that sweep.
Each pass attempts at most 32 deletions; failures and the limit can leave files.
Closing discards the session's tracker, so leftovers require separate handling.
This is a best-effort current-session policy, not a global disk or age limit.

Checks reject links, nonregular files, unexpected paths and changed identities.
They assume a trusted, app-owned runtime without concurrent external mutation.
Path checks and deletion are not atomic and are not a hostile-writer boundary.
If cancellation or marker failure interrupts retention, the new frame becomes
untracked and loses input authority. Earlier eligible deletions are not rolled
back. Filesystem calls are awaited; the attempt cap is not a wall-clock timeout.

`doctor.captureRetention` reports the policy. Enabled observations, action
observations and explicit session closes return `captureRetention` metadata:
`mode`, `keepLast`, `tracked`, `removed`, `status` and fixed `warnings`.
`status` is `applied` or `incomplete`; warnings are `invalid_capture_path`,
`directory_changed`, `capture_changed`, `io_failure` or `pending`, without paths
or raw filesystem errors. Changed files are preserved and dropped from tracking.
Counts describe this tracker, not total files on disk.

Storage warnings do not change a completed action or native cleanup verdict.
Cancellation and marker failures retain their ordinary outcome semantics.
Direct controller shutdown returns storage reports, but MCP transport shutdown
does not deliver that return value. Use explicit close for an observable report.
Observation stage metrics exclude this optional policy; caller elapsed time
includes it. No native behavior, TTL, action schema or release asset changes.
