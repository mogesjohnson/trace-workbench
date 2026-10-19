# TRACE skills

Initial selection confirmed by the owner on 18 October 2026. TRACE is the product; these are its first two skills.

## First two skills

| Order | Skill | Purpose | Current status |
| --- | --- | --- | --- |
| 1 | Reverse Engineer Anything | Inspect artifacts, gather evidence, and support reconstruction work. | Shared local skill/server setup and direct analysis verified. Individual model-host acceptance remains pending. See [setup](docs/SETUP.md) and [verification](docs/VERIFICATION.md). |
| 2 | Computer Use | Observe Windows apps, use mouse/keyboard and controls, and check action results. | Selected for initial delivery. The reference workflow was demonstrated; TRACE's shared desktop executor still needs implementation and four-host validation. See [observed workflow](docs/OBSERVED-WORKFLOW.md). |

Selected scope does not mean both skills are finished. The next implementation priority is Computer Use, while preserving the verified analysis setup. Both skills need acceptance checks with Codex, Claude Code, Grok Build, and Gemini CLI before claiming universal availability.

## Future skills under review

| Candidate | Intended ability | Status |
| --- | --- | --- |
| Browser operation and debugging | Complete web workflows and inspect browser errors/performance. | Under review |
| Screen understanding | Identify interactive regions from screenshots. | Under review |
| Voice and listening | Generate narration, transcribe audio, and align speech timing. | Under review |
| Recorded-demo production and inspection | Coordinate REPLAY editing and verify recorded footage/exports. | Under review |
| Document intelligence | Extract structured content from scans, PDFs, tables, and Office files. | Under review |
| Recoverable parallel workers | Run isolated Windows jobs with restore points and task recovery. | Under review |

The earlier Windows-control candidate is covered by Computer Use. Its engine choices remain under technical review. Future candidates have no assigned release or implementation approval; see [research and candidate tools](docs/CAPABILITIES.md).
