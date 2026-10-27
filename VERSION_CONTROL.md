# Version control

## PR structure

Use a focused branch for one reviewable outcome. Target **2–3 commits per PR**; **4 is the hard maximum**. Plan commit boundaries before editing. If a change needs more, split the work into a separate PR with an explicit dependency.

Use meaningful commit subjects such as `feat: connect local analysis clients`, `test: verify stdio analysis`, or `docs: explain verified setup`. Each commit should describe its resulting change and remain understandable when reviewed separately. Inspect the diff and working tree before staging.

Open PRs against their intended base. Explain the problem, resulting behavior, validation, and remaining limits. A stacked PR names its dependency and stays draft until the prerequisites and its own checks are satisfied. Attach created PRs to the task when the coding host supports attachments.

Keep one implementation commit, one verification commit, and one documentation commit when the work naturally divides that way. For this initial integration, write the README after implementation and verification are complete. Do not pad a small change to reach a commit target.

## Versions and releases

The current preview is `0.1.0-alpha.3.3`. Native supervision and recovery are implemented; the owner-approved production-owner replacement resolves the obsolete failed probe prerequisite at its documented scope. Functional acceptance is reconciled in [the requirement map](docs/REQUIREMENT_EVIDENCE_REVIEW.md); final versioned distribution and reviewed release remain open. TRACE versions are independent of upstream package and skill versions. Keep package, lockfile and release notes consistent when preparing a candidate; a version bump alone is not release publication.

Use `v<package-version>` tags for published releases. A merged PR is not a release. Publish only after the version, artifacts, required checks, and known limits are recorded. Report CI account or billing failures as release blockers, with the run linked.

## History and local data

Preserve unrelated user changes. Stage explicit paths and inspect the staged diff. Never commit personal configuration, authentication data, analysis targets, model conversations, or machine-specific paths. Sanitized receipts may record versions, hashes, tool counts, and pass/fail results.

Avoid rewriting shared history. A justified amendment to an owned branch uses an explicit lease against an inspected remote head; explain the replacement in the task. Keep the final PR within the four-commit maximum.
