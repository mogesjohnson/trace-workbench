# TRACE text-only clipboard transactions

This source-owned Windows helper handles an explicit text clipboard transaction. It sends no keyboard/mouse input, captures no screen, activates no application, acquires no desktop-input lease, launches no other application, and listens on no network endpoint. Its invisible message-only owner window has a separate message pump so private-stdio waits do not block clipboard ownership messages.

The method adapter uses a long-lived helper through inherited stdin/stdout. Text travels in the private request body, never argv or environment variables. Snapshot contents remain inside the helper. Replies contain opaque transaction identity, sequence, format IDs, byte counts, hashes, and verification outcomes; snapshot/plaintext readback is not returned.

## Explicit supported scope

Snapshots accept only `CF_TEXT` (1), `CF_OEMTEXT` (7), `CF_UNICODETEXT` (13), and `CF_LOCALE` (16), including the text conversions Windows enumerates. All other formats, including rich text, HTML, images, file drops, and unknown registered formats, reject before mutation. Exact allocated bytes are retained/restored for the supported snapshot formats. This is not a lossless rich-clipboard claim: original owner identity, application semantics, and external clipboard history are outside that byte-restoration guarantee.

OpenClipboard contention has an 800 ms bound. Snapshot and write compare the observed sequence/owner. A write first persists protected recovery intent, places its own transaction marker and Unicode text, checks actual readback, then binds the final sequence after closing/reopening the clipboard. Restore holds the Win32 clipboard lock while checking sequence, marker, owner lifetime, and text hash, then restores supported bytes and verifies them. A changed clipboard is preserved, including a human's new copy; no retry overwrites a new owner.

## Private recovery

Recovery intent is encrypted with Windows DPAPI for the current OS user under that user's local application-data TRACE clipboard/session directory. The envelope binds OS user and interactive process session. A per-user/session mutex excludes competing helper transactions. The state file is written and flushed before clipboard mutation; plaintext state and raw source formats never enter method checkpoints or ordinary logs.

`recoveryInfo()` exposes only the opaque pending token/phase; `recover()` attempts sequence/ownership-guarded restoration. A crash in the prepared phase, before a final written sequence was durably committed, remains uncertain and refuses automatic overwrite. A changed clipboard likewise leaves protected recovery pending. An explicit `abandon({token})` preserves the current clipboard and archives the encrypted prior snapshot; it reports `restored:false`. It does not assert that restoration occurred. New transactions remain blocked while unhandled recovery is pending.

Normal explicit `close()` and EOF attempt safe cleanup. A fresh helper that sees protected pending state reports unknown cleanup even if it never instantiated a native clipboard service. Transport timeout ends the helper's stdin, then bounds owned-process termination; pending DPAPI state remains available for explicit recovery. This clipboard mechanism does not establish TRACE's physical input-supervisor guarantees.

Before dispatching native paste/input that might read the clipboard, await `deferAutomaticRestore({token})`. The acknowledged flag is durable and one-way: `close()`, EOF and disposal then retain protected pending state and report unknown cleanup instead of exposing the original clipboard to a late paste. Explicit `restore({token,inputQuiescent:true})` or `recover({inputQuiescent:true})` is required. The host must first establish owned input has drained, processes/session have closed, input is released and quarantine is clear. This boolean is the host's evidence acknowledgement, not an OS guarantee inferred by the clipboard helper. Normal sequence/owner/marker/hash guards still apply; owner-window loss may leave recovery unverifiable and blocked.

## Build and pure verification

Build with the existing .NET 9 SDK and an empty local package feed; no package download is required. Use TRACE's setup integration when available so helper source/output hashes are verified before launch.

`TraceClipboard.exe --self-test` exercises `ClipboardService` using fake clipboard/sequence/storage objects. It never constructs the Win32 backend or DPAPI store and makes zero actual clipboard API calls. The Node test suite uses injected transports and synthetic formats. Live clipboard acceptance is separate and must verify actual supported bytes, guarded refusal after owner changes, and cleanup.

The public method API is `createClipboardProvider`: `doctor`, `snapshot`, `writeText({token,text})`, `readback({token})`, `deferAutomaticRestore({token})`, `restore({token,inputQuiescent?})`, `recoveryInfo`, `recover({inputQuiescent?})`, `abandon`, and `close`. Recovery metadata exposes `requiresInputQuiescence` without plaintext. It is an explicit transaction service, not a UI provider with fictitious discover/act operations; the host retains native paste targeting and independent application-effect verification.

`node scripts/accept-clipboard.cjs --plan` is pure and launches nothing. The separate `--live` harness uses the production stdio MCP, one exact owned fixture edit and one `CTRL+V`; it stores only sanitized outcomes. It drains native work and verifies released input before restoration, then compares a fresh helper's supported-byte hashes only in memory. Actual live acceptance remains separate from the fake tests.

Primary API references: [OpenClipboard](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard), [EnumClipboardFormats](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumclipboardformats), [clipboard formats and synthesis](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats), and [clipboard sequence numbers](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber).
