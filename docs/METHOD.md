# Method

This document describes every rule, formula, and default threshold used by contribcheck. Numbers are computed from local git data only; every output is evidence for a human decision, never a grade.

## 1. Data flow

1. Load and validate `contribcheck.yaml` (zod, field paths in errors) and `roster.csv`.
2. For each team, walk each configured repository at the team ref.
3. Deduplicate commits across repositories by SHA (forks share history).
4. Attribute every commit with `attribute(commit)`.
5. Compute meaningful churn, formatting estimates, areas, dates, and flags from those shares.
6. Run blame at the team ref for surviving lines.
7. Write `analysis.json`; reports are rendered from it.

## 2. Scope

Commits reachable from the team ref are walked with `git log --use-mailmap`. With `includeUnmerged: true`, commits from other branches are also walked and marked `onRef: false`. Merge commits are walked but excluded from credit.

### Duplicate patches

Every walked commit gets a `git patch-id --stable` value (cached by SHA). Then:

- Same patch-id **and** same resolved author: the later commit is a cherry-pick/rebase duplicate. It is excluded as `duplicate-of:<short-sha>` and recorded in `excluded`.
- Same patch-id, **different** authors: both commits count, and `DUPLICATE_PATCH` is raised for human review.

## 3. The attribution function

`attribute()` returns shares `{ memberId | null, share, role, method }` that sum to 1.

### Identity resolution order

1. `.mailmap` (git resolves it; the scan uses `--use-mailmap`).
2. Roster emails, case-insensitive.
3. GitHub noreply addresses (`ID+login@users.noreply.github.com`, `login@users.noreply.github.com`) matched against roster `github`.
4. GitHub `author.login`, matched against roster `github` (enrichment only).
5. Otherwise unresolved. A name-only `Co-authored-by` trailer has no email or login and is therefore unresolved; names are never used to guess identity. Credit goes to `unattributed`; the identity is listed by email with a commit count and sample SHA.

### Co-authors

`Co-authored-by:` trailers are parsed case-insensitively from the raw message body, including multiple trailers and name-only forms. With `coAuthorCredit: equal`, distinct resolved identities (primary included) split commit count, churn, and surviving lines equally:

```
share_i = 1 / n
```

An unresolved co-author contributes `1/n` to `unattributed`. With `coAuthorCredit: none`, the primary author receives 1 and co-authors receive 0. `pairCommits` always counts co-authored commits.

### Squash containers

A subject ending in `(#<number>)` is a squash candidate.

**Without GitHub data** (or no PR found):

- the listed author receives the whole commit (`squash-fallback`);
- `SQUASH_UNRESOLVED` is raised.

**With GitHub data**, the pull request’s commits are listed (`GET /pulls/{n}/commits`, up to GitHub’s 250-commit listing limit; a warning is emitted at the limit). For each PR commit:

- `c_i` = number of PR commits by author `i`;
- `w_i` = that author’s `additions + deletions` from `GET /commits/{sha}`.

The container’s shares are:

```
share_i = w_i / Σ w        (if Σ w > 0)
share_i = c_i / Σ c        (else if Σ c > 0)
share_i = 1 / n            (else)
```

This is an **approximation**: squash merges destroy per-commit history, GitHub’s stats may be unavailable for large commits, and the 250-commit listing limit can hide commits. The report labels the method `squash-github` and the limitation is repeated in `docs/LIMITATIONS.md`.

### Bots

A commit is excluded when any of these hold:

- login ends with `[bot]`;
- email matches a GitHub bot noreply pattern (`49699333+dependabot[bot]@users.noreply.github.com`, `*[bot]@users.noreply.github.com`);
- name/login/email is in the built-in list (`dependabot`, `renovate`, `github-actions`, `codecov`, and similar);
- name/login/email is listed in `bots`.

Bot commits are counted in `excluded` and raise no per-member flags.

### Exclusions

Exclusions are listed as evidence. In order:

1. merge commits;
2. SHAs in `excludeCommits` (full lowercase SHA);
3. bot commits;
4. starter code — a commit present in every one of a team’s 2+ repositories and authored by someone not on the roster (warning `STARTER_CODE`);
5. same-author duplicate patches.

Empty commits are **not** excluded; they count as activity with zero churn.

## 4. Meaningful churn

For each non-merge commit, numstat is computed twice:

```
normal:  git diff-tree ... --numstat -M
ignored: git diff-tree ... --numstat -M -w --ignore-blank-lines
```

For each file, after exclusions:

```
formatting_added    = max(0, normal_added   - ignored_added)
formatting_deleted  = max(0, normal_deleted - ignored_deleted)
meaningful_added    = normal_added   - formatting_added
meaningful_deleted  = normal_deleted - formatting_deleted
```

`formattingLines` is reported but not counted in churn. It is an estimate.

### Built-in exclusions

- lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`, `composer.lock`;
- directories: `node_modules/`, `vendor/`, `dist/`, `build/`, `.next/`, `coverage/`;
- `*.min.js`, `*.map`;
- submodule entries;
- binary files (numstat `-`);
- files with `linguist-generated` or `linguist-vendored` set in gitattributes (checked with `git check-attr`);
- paths matching `excludePaths`.

Renames use `-M`, so a pure rename has zero churn.

## 5. Surviving lines (blame)

At each team ref, for each surviving text file:

```
git blame --line-porcelain -M -C [--ignore-revs-file .git-blame-ignore-revs] <ref> -- <file>
```

Each line is attributed to its last-touching commit, then to that commit’s shares. Excluded commits’ lines go to `excluded`; unresolved authors’ lines go to `unattributed`. Blame results are cached by `hash(repo path + blob SHA + ignore-revs hash)`.

`--skip-blame` skips this step for fast runs.

## 6. Metrics and shares

Per member:

- `commits` — fractional sum of shares;
- `churn.added/deleted/total` — fractional meaningful churn;
- `formattingLines` — reported, not counted;
- `survivingLines` — fractional blame lines;
- `areas` — churn per configured area glob;
- `filesTouched`, `activeDays`;
- `weeklyCommits` — ISO weeks in the configured timezone;
- `postDeadlineCommits`, `finalWindowShare`;
- `pairCommits`;
- `pr` — PR metrics or `null`;
- `shares` — commits, churn, surviving lines;
- `composite` — only when enabled.

### Shares

```
share(m, metric) = value(m) / Σ value over members
```

The denominator includes attributed member credit only. `unattributed` and `excluded` are excluded from the denominator. A zero denominator gives `null`, never 0. Shares are displayed with one decimal place.

### Reconciliation

For every metric:

```
Σ members + unattributed + excluded = team total
```

This is enforced by a test.

### Composite (off by default)

```
composite = Σ (w_d × share_d) / Σ w_d     over dimensions d that exist
```

Default weights: commits 0.2, churn 0.3, surviving lines 0.5. The formula and each component are always printed; the composite is never printed alone.

## 7. Flags

| Code | Severity | Rule |
| --- | --- | --- |
| `LOW_SHARE` | review | churn share and surviving share both below `lowShare × (1 / roster size)` |
| `NO_ACTIVITY` | review | zero credited commits, and zero PR activity when enrichment is on |
| `NO_DEFAULT_BRANCH_WORK` | info | only commits on unmerged branches (requires `includeUnmerged`) |
| `POST_DEADLINE_WORK` | info | credited commit after deadline + grace |
| `LARGE_COMMIT` | review | > `largeCommitLines` or > `largeCommitFiles` |
| `SQUASH_UNRESOLVED` | info | squash-looking commit with no PR data |
| `UNRESOLVED_IDENTITY` | review | unresolved identities present |
| `DATE_ANOMALY` | review | future author date or before `courseStart` |
| `DUPLICATE_PATCH` | info | same patch-id, different authors |
| `FORMATTING_HEAVY` | info | more than half of a member’s raw churn is formatting-only |
| `SELF_APPROVED` | info | PR approved by its own author |
| `SHALLOW_CLONE` | review | shallow repository |
| `STARTER_CODE` | info | shared non-roster commit across repos |

Every message states what was observed and gives at least one innocent explanation (pair work, in-person collaboration, non-code work, bulk import, timezone/clock issue). Flags link to short/full SHAs, paths, PR numbers, or blame-derived counts.

Default thresholds: `lowShare: 0.5`, `largeCommitLines: 2000`, `largeCommitFiles: 50`.

## 8. Worked example

Team of three, deadline `2026-11-15T23:59:00+05:30`.

Commit `abc1234` adds 90 lines and deletes 10, with:

```
Co-authored-by: Bob <bob@example.com>
```

Alice is the primary. Both resolve. With `coAuthorCredit: equal`, n = 2, so each gets 0.5 commits, 45 added, 5 deleted. `pairCommits` for both increases by 0.5. If Bob were unresolved, Alice would get 0.5 and `unattributed` would get 0.5 commits and half the churn.

Now a squash container `def5678` with subject `Add reports (#42)`, 100 added lines. Without enrichment: Alice (the listed author) gets 1 commit and 100 churn, and `SQUASH_UNRESOLVED` is raised. With enrichment, suppose PR #42 has two commits: Alice 80 churn, Bob 20 churn. Then:

```
share_Alice = 80 / 100 = 0.8
share_Bob   = 20 / 100 = 0.2
```

Alice gets 0.8 commits / 80 churn, Bob 0.2 commits / 20 churn.

Finally, suppose Alice has 30 meaningful churn and 12 surviving lines in a team where member totals are 120 churn and 48 surviving:

```
churn share     = 30 / 120 = 25.0%
surviving share = 12 / 48  = 25.0%
```

With three members, an equal share is 33.3%. `LOW_SHARE` needs both values below `0.5 × 33.3% = 16.7%`, so 25% does not trigger it.

## 9. Determinism

- Members sorted by `memberId`; teams by `teamId`; flags by code then member; evidence stable.
- JSON keys are recursively sorted and numbers rounded to four decimals.
- `--no-timestamp` omits `generatedAt`, producing byte-identical JSON for identical inputs.
