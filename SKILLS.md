# TRACE skills

Initial selection confirmed by the owner on 18 October 2026. TRACE is the product; these are its first two skills.

## First two skills

| Order | Skill | Purpose | Current status |
| --- | --- | --- | --- |
| 1 | Reverse Engineer Anything | Inspect artifacts, gather evidence, and support reconstruction work. | Shared local skill/server setup and direct analysis verified. Individual model-host acceptance remains pending. See [setup](docs/SETUP.md) and [verification](docs/VERIFICATION.md). |
| 2 | Computer Use | Observe Windows apps, use mouse/keyboard and controls, and check action results. | Windows executor and six MCP tools implemented, with owned-fixture action and targeting evidence. Native release-primitive evidence does not establish end-to-end MCP recovery. Display transitions and full recovery acceptance remain in [SPEC.md](SPEC.md). |

Both skills are selected; neither configuration nor a fixture test establishes every host/app combination. All four CLI connections are configured. Finish Computer Use reliability, Codex/Claude workflows and real-app acceptance under [the specification](SPEC.md); report Grok/Gemini live coverage separately.

## Added skills

| Skill | Purpose | Current status |
| --- | --- | --- |
| [TRACE Phone](skills/trace-phone/SKILL.md) | Control an Android phone over adb (Wi-Fi or USB) through an on-device agent: scaled screenshots, accessibility nodes, act-then-settle, logcat. | Agent build, adb-server client, controller and MCP server (`trace-workbench phone mcp`, six tools) pass fake-adb/fake-agent tests. Owner-approved agent runs over USB are recorded in [the phone handoff](docs/PHONE_HANDOFF.md); the MCP server has not yet driven a real phone, and Wi-Fi and on-phone (Termux) links are unmeasured. |

## Future skills under review

| Candidate | Intended ability | Status |
| --- | --- | --- |
| Browser operation and debugging | Complete web workflows and inspect browser errors/performance. | Under review |
| Screen understanding | Identify interactive regions from screenshots. | Under review |
| Voice and listening | Generate narration, transcribe audio, and align speech timing. | Under review |
| Recorded-demo production and inspection | Coordinate REPLAY editing and verify recorded footage/exports. | Under review |
| Document intelligence | Extract structured content from scans, PDFs, tables, and Office files. | Under review |
| Recoverable parallel workers | Run isolated Windows jobs with restore points and task recovery. | Under review |

The earlier Windows-control candidate is covered by Computer Use, now implemented using pinned winapp and TRACE's window bridge. Future candidates have no assigned release or implementation approval; see [research and candidate tools](docs/CAPABILITIES.md).
