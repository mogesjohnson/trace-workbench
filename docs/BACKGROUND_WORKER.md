# Background desktop worker

Status: research and proposed acceptance, reviewed 19 October 2026. No background worker is implemented or verified; no VM, account, RDP setting or host configuration was provisioned.

## Current limit

- Current TRACE combines fresh PNG observations with physical input on the active, unlocked desktop. A second account can contain background commands; it does not alone supply another input/capture environment. Fast User Switching or Task View does not establish concurrent TRACE Computer Use.
- Windows permits one active input desktop per interactive window station. Some underlying UIA operations can run without foreground input; that does not establish background support for TRACE's complete capture/input workflow. See Microsoft's [desktop model](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops) and [UI Automation requirements](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation).
- Current Microsoft documentation describes newer engine features; availability in TRACE's pinned `0.7.1` engine is unverified. Documentation alone does not authorize a pin change.
- The researched host runs Windows 11 Home. The full built-in Hyper-V role [cannot be installed on Home](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/Install-Hyper-V); a Home-compatible VM host would need separate evaluation.

## Muse Code findings

- Local read-only inventory confirmed enabled `muse-sbx-r1` and `muse-sbx-u1` accounts. Installed Muse Code `1.4.4-R5419.1` reports its Windows sandbox `ready`, with sandbox users, capabilities and WFP ready. These checks do not audit its security or prove independent GUI operation.
- Meta documents [filesystem and network containment for shell commands](https://dev.meta.ai/docs/muse-code/permissions). Public primary docs reviewed do not identify the two accounts' individual roles or guarantee inactive-desktop Computer Use. Keep those unknowns explicit.
- Meta's [SDK MCP guide](https://meta-models.github.io/muse-code-sdk/next/guides/extend/mcp-servers/) says configured MCP servers run outside the shell sandbox; its examples were produced with Muse 1.3.0. Connecting TRACE does not automatically put its tools inside those sandbox accounts.
- Meta's [computer-use protocol](https://dev.meta.ai/docs/computer-use) requires the caller to supply execution and capture. Its [isolated desktop recipe](https://dev.meta.ai/docs/cookbook/computer-use) uses a Linux desktop in Docker/Cua; it is not evidence of native Windows REPLAY compatibility.

## Proposed architecture

| Candidate | Scope and next proof |
| --- | --- |
| Restricted account | Useful for shell/build workers with explicit file/network access. Add a separate GUI backend before claiming full Computer Use. Preserve Muse-owned accounts; TRACE would own its own worker identity. |
| Hidden Win32 desktop | Research a UIA-only worker. Prove fresh captures and application compatibility without switching the user's desktop; physical input cannot simply target an inactive desktop. |
| Windows Child Session | Same-PC GUI architecture worth evaluating on a supported edition. Microsoft [documents loopback child sessions](https://learn.microsoft.com/en-us/windows/win32/termserv/child-sessions); [Power Automate PiP](https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-desktop-flows-pip) demonstrates physical automation while the main desktop remains usable, but explicitly excludes Home. Its virtual-desktop mode lacks physical input and screenshots. No TRACE integration exists. |
| Dedicated Windows VM or second PC | Run TRACE and target apps inside its logged-in, unlocked interactive session. The owner retains the host desktop. Evaluate a Home-compatible VM host separately. |

Profiles, desktops, sessions and VMs are separate boundaries. Starting a process through SSH or a service alone does not guarantee an interactive desktop. This research changed no accounts, permissions, RDP settings or desktop sessions.

## Acceptance before claiming background support

- **Identity and transport:** authenticate the worker; bind each request to an exact environment, user session and discovered target HWND/PID. Reject mismatches before input. Use an explicit authenticated transport without an arbitrary public listener.
- **Desktop ownership:** acquire a worker-local lease and show the activity glow inside the controlled desktop. Independent host and worker sessions must not share input ownership or implicitly target each other's windows.
- **Host isolation:** retain independently checked host foreground-window and cursor state before/during/after real worker input. The host user must continue an owned task without focus theft or cursor movement from worker actions.
- **Real workflow:** perform worker capture, input, editing and an export through MCP; independently inspect the target state and exported artifact. Retain exact source/environment identity, expected/actual outcomes and sanitized artifact hashes.
- **Viewer lifecycle:** test minimized/disconnected viewing and lock/reconnect where the candidate supports them. Child Sessions cannot lock and terminate with their parent; test that lifecycle explicitly. Unsupported states reject input, preserve uncertainty and require fresh targeting after recovery. Record each environment independently.
- **Process boundary:** cancel and crash owned worker/input processes; prove their exit, balanced input and lease handoff. Preserve unrelated host/guest processes. Failed cleanup must quarantine further input.
- **Credentials and evidence:** keep worker credentials and application profiles separate from the owner's profiles. Transfer only explicitly selected artifacts; redact credentials and private screen content from retained receipts. A Child Session can share clipboard/profile resources; verify the actual boundary rather than describing it as a VM.
- **Completion:** mark each case `pass`, `fail`, `blocked` or `not_run`; retain failed attempts. Background support remains unverified until every required case passes on the declared account/desktop/session/VM configuration. Classify human-interrupted cases separately from product failures; resume only under a recorded authorized plan.
