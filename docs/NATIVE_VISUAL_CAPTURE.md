# Native visual capture foundation — item 15

The source-owned bridge adds `capture HWND PID <absolute-new.png>` using public
PrintWindow, a top-down 32-bit DIB and PNG encoding. It never reads UIA, composites
owned windows, captures screen pixels, activates, sends input or falls back.
Public screenshot-only integration is separate; full observations retain UIA.

Exact HWND/PID and DWM/native bounds are checked before and after capture. The
DWM frame must lie inside the window; its physical crop is returned without
scaling. Capture is bounded to 16 million pixels, dimensions 16384 and a 6 MiB PNG.
A preexisting output file is refused. Minimized windows must be restored first.
GDI objects/DCs are released in finally; supervised deadlines bound a hung call.

PrintWindow relies on the target rendering its own pixels. Failure or a uniform
buffer rejects, but nonuniform pixels cannot prove complete or current app content.
GPU/protected/noncooperating apps can remain unsupported. No WGC, secure desktop,
elevation bypass or arbitrary-app acceptance is claimed. The source-matched bridge
and supervisor must be rebuilt; installed defaults are not replaced by this PR.

Compiled selftests check physical/negative-origin crop and invalid bounds without
calling capture or sending input. Actual no-UIA fixture capture is a separate gate.
Based on Microsoft's [PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)
and [CreateDIBSection](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-createdibsection).
