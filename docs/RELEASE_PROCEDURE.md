# TRACE 0.1.0 integration and publication procedure

Prepared candidate; no merge, tag or release has been performed. Use [release notes](RELEASE_0.1.0.md), [acceptance manifest](../evidence/release-0.1.0/acceptance-manifest.json) and [requirement map](REQUIREMENT_EVIDENCE_REVIEW.md) as the review packet.

## Before owner approval

1. Require successful hosted Windows CI for this final candidate head. Check source validation, required suite, both MCP paths and exact-archive installation/rollback. No desktop actions or model requests are part of this gate.
2. Retain the sanitized verifier receipt from the completed job log, including actual tested commit, ZIP SHA-256 and bytes. Fetch that exact commit and reproduce its ZIP with `git archive --format=zip --prefix=trace-workbench/`; compare its hash with the receipt. Keep raw logs private.
3. Review PR dependencies, changed-file/line/commit budgets and unresolved limits. The candidate contains the exact acceptance manifest and notes. A different final commit or archive must be checked at its own scope.

## Approved integration order

The existing stack begins at PR 10 on main, then 9, then 11 through 37 in ascending order. Each child targets the preceding branch. Preserve shared history and the reviewed focused changes; do not squash the entire stack into one oversized PR. Integrate from the oldest base upward, confirming each current base/head and review/check disposition before merging. GitHub may retarget a child after its base branch merges; inspect that result rather than assuming it.

Older failed CI/probe/live receipts remain historical. Later compatible successful source checks and owner-approved replacements resolve their stated scope; never rewrite their results to pass. Existing historical PRs predate the later numeric budgets; new work must obey those budgets. Do not silently broaden any pending PR to absorb the whole stack.

## After integration, before publication

1. Require hosted CI on the resulting main commit. Use its **exact verified** `source.zip` bytes or reproduce the Git archive at the receipt's exact commit and compare SHA-256/length. A candidate-head receipt cannot certify different main-commit bytes.
2. Make a delivery folder containing `trace-workbench-0.1.0-source.zip`, the checked-in acceptance manifest, release notes, and a sanitized `distribution-receipt.json` with actual source commit, archive hash/bytes, CI run URL and verifier result. Identify the checked-in manifest's prepublication REL-01 status and record the completed distribution gates in the sidecar; do not alter the verified source ZIP.
3. Generate `SHA256SUMS.txt` for every delivery asset except the checksum file itself. Verify each hash again before upload. Retain commands and the exact source identity in the release description.
4. Confirm package and lockfile are 0.1.0, tag `v0.1.0` points to the reviewed tested main commit, and the source/archive limits remain explicit. Publish the GitHub release only under direct owner approval; `private: true` keeps npm publication outside scope.
5. Update the dashboard and second-brain with the actual merged commit, CI URL, release URL and checksums. Only then close REL-01 and the full goal.

No additional mouse, Escape, clipboard, host, glow, REPLAY recording or export reruns are needed unless relevant runtime source/environment changes invalidate retained evidence. Final archive verification is a distinct distribution gate.
