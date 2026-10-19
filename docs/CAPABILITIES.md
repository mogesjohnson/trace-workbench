# Future skills under review

Research reviewed 18 October 2026. The [first two selected skills](../SKILLS.md) are Reverse Engineer Anything and Computer Use. The future candidates below remain under review, with no assigned release or implementation approval. No provider credits were used.

TRACE should give agents executable abilities: an engine that performs the work, structured tools that expose it, and a small skill that teaches its use. A written instruction file alone does not supply desktop input, vision, or audio processing. [Agent Skills](https://agentskills.io/home) describes instruction/resource packaging; [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) expose executable operations and can return images, audio, and structured results.

## Computer Use foundation

Computer Use is selected and implemented using [Microsoft winapp UI automation](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation), pinned to `0.7.1`, plus TRACE's source-owned window bridge. [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) remains a comparison, not a bundled dependency. See [current acceptance](../SPEC.md).

## Future candidates

| Review order | Capability | What agents could do | Foundation to evaluate |
| --- | --- | --- | --- |
| 1 | Browser operation and debugging | Complete browser workflows, inspect page structure, diagnose console/network errors, and measure performance. | [agent-browser](https://github.com/vercel-labs/agent-browser), [Playwright MCP](https://github.com/microsoft/playwright-mcp), and [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp). |
| 2 | Screen understanding | Turn screenshots into labeled regions when accessibility data is missing; ground actions in visible controls. | [Microsoft OmniParser](https://github.com/microsoft/OmniParser). |
| 3 | Voice and listening | Generate timed narration, transcribe recordings, and align a script with existing audio. | ElevenLabs [timed speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps), [transcription](https://elevenlabs.io/docs/overview/capabilities/speech-to-text), and [alignment](https://elevenlabs.io/docs/overview/capabilities/forced-alignment); [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for a later local transcription option. |
| 4 | Recorded-demo production and inspection | Coordinate REPLAY recording/editing, inspect streams, extract frames, find silence/black footage, and verify exports. | A proposed REPLAY adapter with [FFprobe](https://www.ffmpeg.org/ffprobe.html) and [FFmpeg filters](https://www.ffmpeg.org/ffmpeg-filters.html). Footage comes from actual computer operation. |
| 5 | Document intelligence | Extract structured content from PDFs, scans, tables, and Office files for agent analysis. | [Docling](https://github.com/docling-project/docling) and its [MCP server](https://github.com/docling-project/docling-mcp). |
| 6 | Recoverable parallel workers | Give separate jobs isolated Windows desktops and restore a known environment after experiments. | [Hyper-V checkpoints](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/checkpoints?tabs=hyper-v-manager) and [PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct), plus a TRACE guest bridge and task journal that still need implementation. |

## Integration choices

Use MCP as the shared tool interface for the four agent hosts. Keep each engine behind a focused adapter; load only the tools needed for the task. Each host still needs acceptance checks for tool calls, returned images, cancellation, and permissions. Protocol support alone does not establish equivalent model behavior.

Complete the first two selected skills before broadening scope. Browser control, screenshot parsing, and the other candidates need further review before selection. If voice is selected later, keep narration requests within REPLAY's existing allowance and use its account connection rather than copying credentials into new clients.

Persist task IDs, action outcomes, and artifact references so another agent can inspect completed work. After an interruption, re-observe the application before continuing. A saved task journal or VM checkpoint does not undo external service changes.

## Selection limits

- **Windows control:** TRACE's owned-fixture test covers the pinned engine's selected actions, including key, scroll, drag, and an interrupted hold, on one 144 DPI display. TRACE adds per-user desktop ownership and exact DWM capture mapping. A second monitor, a DPI change, and broader application coverage remain in the specification.
- **Browser control:** agent-browser currently includes CLI and stdio MCP modes, Windows x64 binaries, compact snapshots, and isolated sessions. Browser engines do not supply native desktop control. Use separate contexts/profiles for independent jobs.
- **Vision:** OmniParser supplies screenshot parsing; TRACE still needs an executor and adapter. Its current README distinguishes MIT-based `icon_detect_v3` and caption weights from earlier AGPL detectors. Pin the exact code and weight revision; the documented v3 download currently references a Hugging Face PR.
- **Voice:** the [official local ElevenLabs MCP README](https://raw.githubusercontent.com/elevenlabs/elevenlabs-mcp/main/README.md) marks that server deprecated in favor of [hosted OAuth MCP](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp). Explicit APIs are the proposed fit for timing, transcription, alignment, and the existing narration budget. No new voice request was made.
- **Media:** silence or static frames are evidence for inspection, not proof of a bad demo. Distributed FFmpeg builds have [configuration-dependent license terms](https://www.ffmpeg.org/legal.html).
- **Documents:** Docling supports Windows and local conversion. Model downloads, OCR accuracy, and model-specific licenses need evaluation for the selected pipeline.
- **Workers:** Hyper-V needs a supported Windows edition and suitable hardware. VM recovery does not provide task-level resume automatically; the journal and guest desktop bridge are additional work.

For searchable screen/audio history, [Screenpipe](https://github.com/screenpipe/screenpipe) is a useful reference. Its current source license requires a commercial license for commercial use, so it is not selected as a bundled dependency in this proposal.

## First delivery

Complete the selected skills' acceptance in [SPEC.md](../SPEC.md). Report configured hosts separately from live agent workflows. Future modules remain under review.
