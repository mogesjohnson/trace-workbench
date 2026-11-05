# Version control

## PR structure

Use a focused branch for one reviewable outcome. Target **2–3 commits per PR**; **4 is the hard maximum**. Plan commit boundaries before editing. If a change needs more, split the work into a separate PR with an explicit dependency.

Use meaningful commit subjects such as `feat: connect local analysis clients`, `test: verify stdio analysis`, or `docs: explain verified setup`. Each commit should describe its resulting change and remain understandable when reviewed separately. Inspect the diff and working tree before staging.

Open PRs against their intended base. Explain the problem, resulting behavior, validation, and remaining limits. A stacked PR names its dependency and stays draft until the prerequisites and its own checks are satisfied. Attach created PRs to the task when the coding host supports attachments.

Keep one implementation commit, one verification commit, and one documentation commit when the work naturally divides that way. For this initial integration, write the README after implementation and verification are complete. Do not pad a small change to reach a commit target.

## Versions and releases

The earlier published package is `2.0.0`. It makes the act result compact by default, which needs a major version under the V1 boundary. Its [release notes](docs/RELEASE_2.0.0.md) carry the migration notes, the head-to-head result and known limits G1–G4. Tag `v2.0.0` pins tested source `9886a6b`; the [publication receipt](evidence/release-2.0.0/publication.json) binds final-main CI, exact archive and five verified assets. Later receipt/documentation commits do not replace that archive. Fixes for the known limits are planned as `2.1.0`.

The published package is `2.1.0`. It fixes known limits G1–G5 with no 2.0 contract change. Its [release notes](docs/RELEASE_2.1.0.md) record each fix's live check and the head-to-head rerun. Tag `v2.1.0` pins tested source `acca833`; the [publication receipt](evidence/release-2.1.0/publication.json) binds final-main CI, exact archive and five verified assets. Later receipt/documentation commits do not replace that archive.

The development candidate is `2.2.0`. It adds Road V1 items 10 and 19 with no 2.0 contract change. Its [candidate notes](docs/RELEASE_2.2.0.md) record the checks and limits; final-main CI and publication are pending. It is not published.

The earlier published package is `1.1.0`, covering additive selective observation modes, scoped observation cost reductions, numeric reporting and opt-in current-session capture retention. [Release notes](docs/RELEASE_1.1.0.md) preserve compatibility and evidence limits. Tag `v1.1.0` pins tested source `ccf8734`; the [publication receipt](evidence/release-1.1.0/publication.json) binds final-main CI, exact archive and five verified assets. Later receipt/documentation commits do not replace that archive.

The package before that is `1.0.0`. Its [release notes](docs/RELEASE_1.0.0.md), [publication receipt](evidence/release-1.0.0/publication.json) and [compatibility boundary](docs/COMPUTER_USE.md#v1-compatibility-boundary) define the V1 promise. Tag `v1.0.0` pins the tested release source; later documentation commits do not replace that archive or inherit its exact-byte gate. The older publication below remains historical evidence.

### Historical 0.1.0 publication

The published version is `0.1.0`, following preview `0.1.0-alpha.3.3`. [Release notes](docs/RELEASE_0.1.0.md) describe its supported scope; [publication evidence](evidence/release-0.1.0/publication.json) records the exact archive and source. Native supervision and recovery are implemented; the owner-approved production-owner replacement resolves the obsolete failed probe prerequisite at its documented scope. Functional acceptance is reconciled in [the requirement map](docs/REQUIREMENT_EVIDENCE_REVIEW.md); final versioned distribution and reviewed release are complete. TRACE versions are independent of upstream package and skill versions. Keep package, lockfile and release notes consistent when preparing a candidate; a version bump alone is not release publication.

Use `v<package-version>` tags for published releases. A merged PR is not a release. Publish only after the version, artifacts, required checks, and known limits are recorded. Report CI account or billing failures as release blockers, with the run linked.

## History and local data

Preserve unrelated user changes. Stage explicit paths and inspect the staged diff. Never commit personal configuration, authentication data, analysis targets, model conversations, or machine-specific paths. Sanitized receipts may record versions, hashes, tool counts, and pass/fail results.

Avoid rewriting shared history. A justified amendment to an owned branch uses an explicit lease against an inspected remote head; explain the replacement in the task. Keep the final PR within the four-commit maximum.

## Worktree dependencies

Never link `node_modules` or `.runtime` into a worktree with a junction or symlink. `git worktree remove`, and `gh pr merge --delete-branch` which runs it, can delete through the link into the main checkout. On 4 November 2026 this reached the main `.runtime`. Run `npm ci` in the worktree instead. Live checks that need `.runtime` run from the main checkout.

If a worktree already has a link, remove it with `cmd /c rmdir <link>` before removing the worktree, and check that the target is intact.
