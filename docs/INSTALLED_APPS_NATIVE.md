# Installed application evidence — item 16 foundation

The read-only native `apps` command enumerates HKCU/HKLM App Paths in both registry
views, bounded to 2000 scanned registrations. It returns existing local `.exe`
paths plus registration provenance, coverage and partial/issue metadata. Data is
never executed during discovery. Relative paths, network paths, command strings,
scripts and malformed quoting are rejected. No registry writes are made.

This is registered desktop-app coverage, not every installed application. Start
Menu-only, portable/unregistered and packaged/AUMID apps may be absent. Missing
registrations and inaccessible views do not establish that an app is uninstalled.
The separate public catalog must verify canonical regular files before launch.

Native `process PID` reads actual creation time/session/executable. Window identity
batches add an executable path when readable; unavailable paths remain absent
without discarding otherwise usable identity. A path or PID alone is insufficient
for launch handoff. No app launch, session/input claim or recipe change is added
by this foundation. Existing recipes remain available for configured executables.

Compiled selftests check registration parsing without reading the registry or
launching apps. Actual discovery/handoff remains a separate owned-fixture gate.
Based on Microsoft's [App Paths registration](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration).
