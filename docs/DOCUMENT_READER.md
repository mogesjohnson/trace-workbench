# Bounded native document reader — item 14 foundation

The internal bridge adds a read-only managed UIA TextPattern reader. A public
opt-in observation integration is separate. The Windows Desktop framework
supplies UIAutomationClient; no package or engine upgrade is added.

An observed nonempty AutomationId, type, class and exact physical bounds must
match exactly one control in the selected HWND/PID. Search is bounded to 10000
nodes/depth 32; ambiguity, stale identity or overflow rejects. Runtime identity
and metadata are checked again after reading. This is not an atomic app snapshot.

Password or unknown password status returns unavailable without reading text.
No TextPattern returns unavailable, with no ValuePattern/Name fallback. Document
text requests at most 4097 UTF-16 units and returns at most 4096. Selection reads
at most four ranges, each requesting at most 1025/returning 1024 units. Empty,
unsupported and truncated remain distinct; a split surrogate pair is removed.
These bounds govern requests/results, not a dishonest provider's internal work.

No focus, selection mutation, clipboard operation or native input is performed.
The existing native owner supervises read processes with the operation deadline.
Compiled selftests verify bounds/empty/surrogate behavior without UIA or input;
actual provider document/selection behavior remains a separate live gate.

Based on Microsoft's [TextPattern](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.textpattern?view=windowsdesktop-9.0)
and [bounded GetText](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.text.textpatternrange.gettext?view=windowsdesktop-9.0).
