# Limitations

contribcheck is evidence for a human decision. It is not a grade, a ranking, or a complete picture of a team.

## History and identity

- **Squash merges destroy per-commit history.** Without GitHub enrichment, a squash container is credited to the listed author and `SQUASH_UNRESOLVED` is raised. With enrichment, credit is reconstructed from the PR’s commits, but the split is an approximation (see `docs/METHOD.md`).
- **Rewritten history cannot be recovered.** Force-pushes, filter-branch/filter-repo, and repository re-creation remove commits from the local clone. If a student force-pushed during the project, work may be missing.
- **Shallow clones have incomplete history and blame.** Detected as `SHALLOW_CLONE`. `--unshallow` fixes it when the remote is reachable.
- **Identities are resolved, never guessed.** `.mailmap`, roster emails, GitHub noreply addresses, and GitHub logins are used in that order. Unresolved identities are listed and their credit goes to `unattributed`. Name-similarity suggestions are explicitly `unverified`.
- **Git dates are self-reported.** Author dates can be changed with environment variables or `--date`. They are used for weekly buckets, deadlines, and anomalies, and every output says so.
- **Shared machines and shared accounts** can attribute commits to the wrong person. A roster should include all emails a student actually used.
- **Name-only co-author trailers cannot be resolved.** Without an email or login, the share stays in `unattributed`; add an email to the trailer or the roster.
- **Co-authored-by trailers may be absent** even when people genuinely paired. Pair work done in person, over a call, or via live share is invisible unless committed.

## What counts

- **Non-code work is underrepresented.** Design, research, documentation review, testing by hand, mentoring, and project management may produce few or no commits.
- **Generated and vendored code is excluded.** This is deliberate, but a team may have written the generator, which is counted only if the generator itself is committed.
- **Formatting-only churn is estimated**, not measured exactly. It is reported separately and excluded from meaningful churn; the estimate can be wrong at file boundaries.
- **Line survival is not value.** Old lines can be valuable; recently added lines can be important. Blame measures who last touched surviving text, not impact.
- **Commit size is not effort.** Large commits can be imports; small commits can be the hardest work. `LARGE_COMMIT` is a prompt to look, not a verdict.
- **Renames and moves** are detected with `-M`; pure renames have zero churn, so a student who reorganized a codebase may appear to have done less.
- **Cherry-picks and rebases** are deduplicated by patch-id. Same-author duplicates are counted once; different-author duplicates are both counted and flagged.
- **Bots are excluded**, but a student whose CI account is misconfigured as a bot may disappear.

## GitHub enrichment

- Enrichment is optional and requires `GITHUB_TOKEN` or `GH_TOKEN`.
- **PR metrics cover PRs linked from squash containers**, not every PR in the repository. This keeps API use proportional and grounded in git history.
- GitHub documents a **250-commit limit** on listing PR commits; contribcheck warns when the limit is reached and the squash split may be incomplete.
- Reviews and comments are attributed by GitHub login. A student without a `github` value in the roster will not receive PR credit.
- The cache stores response bodies and ETags only. Re-runs are cheap, but data can become stale; delete `.contribcheck/cache/` to refresh.
- Rate limits, private repositories, and revoked tokens can stop enrichment. contribcheck stops with a clear message rather than inventing data.

## Tool behavior

- Merge commits are excluded (no own diff); a merge-only contributor can appear to have no activity.
- Empty commits count as activity with zero churn.
- Evidence is capped at 25 items per metric in human reports; `analysis.json` is complete.
- The analysis contains emails and is sensitive. Delete it when it is no longer needed.
- The composite is off by default and is never a substitute for reading the evidence. It renormalizes over available dimensions, so missing metrics change the weights.
- A shallow clone under `--strict` writes the analysis and then exits 2; unresolved identities under `--strict` exit 3. This is intentional so the evidence is not lost.
- contribcheck never modifies analyzed repositories. The only write-like git command it can run is `git fetch --unshallow`, and only with `--unshallow`.

## Things this tool cannot tell you

- Whether a student understood the code.
- Whether a contribution was helpful, kind, or original.
- Whether the team collaborated fairly outside git.
- Whether a commit was authored by the person named in it.
- Whether the project met its learning objectives.

Those require a human who knows the course, the students, and the context.
