# Decisions

This file records the choices made where the build prompt left room for interpretation. It is also the resume point if work on this package is continued.

## Runtime and build

- **TypeScript, strict, ESM, `tsc` only.** `module`/`moduleResolution` are `NodeNext`; the published entry points are `dist/index.js` and `dist/index.d.ts`.
- **Runtime dependencies are exactly the allowed four**: `commander`, `zod`, `yaml`, `csv-parse`. No dependency was added for globbing, date math, ANSI stripping, or YAML generation; small helpers live in `src/util.ts`.
- **Dev dependencies are exactly** `typescript`, `vitest`, `@types/node`.
- **Node 22+**: the code uses `fetch`, `node:readline/promises`, and built-in `Intl` timezone support.
- **Git is always invoked through `execFile` with an argument array** (or `spawn` for stdin, used only by `git patch-id`). `shell: true` is never used.
- **Git version check**: `git --version` is parsed at startup of `scan` and `doctor`; versions below 2.23 fail with a clear message.

## Configuration and paths

- Paths in `contribcheck.yaml` are resolved relative to the config file, including `repos` and the default output directory.
- The default output directory is `contribcheck-out/` next to the config. `--out` overrides it.
- If the resolved output directory is inside an analyzed repository (working tree root or the configured path), the scan refuses with exit 2 unless `--allow-in-repo` is passed.
- `roster.csv` defaults to `roster.csv` next to the config when `--roster` is omitted. The CLI does not hardcode a cwd-relative default.
- `report` and `explain` default to `<cwd>/contribcheck-out/analysis.json`; `report` writes into a `reports/` directory beside the analysis unless `--out` is given.
- `--no-timestamp` omits `generatedAt` from `analysis.json` only. Reports are rendered from that file, so they inherit the omission.

## Attribution

- **One function decides credit.** `src/attribution.ts#attribute` returns `Share[]`; all metrics (commits, churn, surviving lines, weekly buckets, areas) are derived from those shares in `src/scan.ts`.
- **Share methods** are `direct`, `coauthor-equal`, `squash-github`, `squash-fallback`; excluded commits use their exclusion reason (`merge-commit`, `excluded-sha`, `bot`, `starter-code`, `duplicate`) with role `excluded`. Unresolved identities use role `unattributed`.
- **Co-author trailers** are matched case-insensitively (`Co-Authored-By:` and any casing) at the start of a line. Both `Name <email>` and name-only forms are accepted. A name-only co-author has no email or login, so it stays **unresolved** and its share goes to `unattributed`; names are never used to guess an identity.
- **Distinct identities** collapse repeated co-authors. All unresolved identities collapse into a single `unattributed` share so a commit’s shares still sum to 1.
- **Squash containers** are detected by a subject ending in `(#<number>)`. Without enrichment they use `squash-fallback` and raise `SQUASH_UNRESOLVED`.
- **Squash distribution with GitHub** uses the PR’s listed commits. Commit counts split by number of PR commits per author (`commitShare`); churn splits in proportion to each author’s own `additions + deletions` from `GET /commits/{sha}` (`churnShare`). If all churn weights are zero, churn splits equally; if all commit counts are zero, commits split equally. Surviving lines use `churnShare`. This is documented as an approximation in `docs/METHOD.md`.
- **Co-author setting affects only shares.** `pairCommits` counts each co-authored commit once per participating member (not share-weighted), even when `coAuthorCredit: none`; with `none`, only the primary gets credit for commits/churn.
- **Bots**: login ending `[bot]`, GitHub bot noreply patterns, a built-in list (dependabot, renovate, github-actions, codecov, etc.), or entries in `bots`. Bot commits are excluded and counted in `excluded`.
- **Duplicates**: patch-ids from `git patch-id --stable`, cached by SHA. Same patch-id + same resolved author => the later commit is excluded as `duplicate-of:<sha>` and counted as excluded. Same patch-id + different author => both count and `DUPLICATE_PATCH` is raised.
- **Starter code**: only when a team has 2+ repositories; a commit present in every repo and authored by someone not on the roster is excluded as `starter-code` and raises `STARTER_CODE`. The first observation wins; no silent dropping.
- **Empty commits**: counted as activity with zero churn (they are not "merge commits").
- **Merge commits**: excluded from credit (`merge-commit`), because they carry no own diff.

## Churn and blame

- **Built-in exclusions** match the prompt: lockfile basenames, `node_modules/`, `vendor/`, `dist/`, `build/`, `.next/`, `coverage/`, `*.min.js`, `*.map`, submodule entries, binaries (`-` in numstat), and files with `linguist-generated`/`linguist-vendored` set (checked with `git check-attr`).
- **`excludePaths`** are matched with a small glob implementation supporting `**`, `*`, and `?`. Paths are normalized to forward slashes first.
- **Rename detection** uses `-M`; a pure rename therefore contributes zero churn.
- **Formatting churn** is the difference between normal numstat and numstat with `-w --ignore-blank-lines`, for additions and deletions separately, floored at zero. It is reported as `formattingLines` and excluded from meaningful churn.
- **Blame** runs `git blame --line-porcelain -M -C` per surviving text file. `--ignore-revs-file .git-blame-ignore-revs` is added when that file exists. Excluded commits’ lines go to `excluded`; unresolved authors’ lines go to `unattributed`.
- **Blame cache key** is a hash of the repository path, blob SHA, and hash of `.git-blame-ignore-revs`. Including the repository path prevents collisions between different repos that contain the same blob (this was found by the demo).
- **Cache placement**: `.contribcheck/` lives next to the config, except when the config directory is inside an analyzed repository. In that case the cache is moved to the OS temp directory, so the scan never creates files inside an analyzed working tree.
- **`--skip-blame`** skips blame entirely; surviving lines become 0/omitted from computation rather than guessed.

## Time, weeks, deadlines

- Weekly buckets are ISO weeks computed from the calendar date in the configured IANA timezone. `finalWindowShare` is the share of a member’s credited commits whose author date falls in the 48 hours before `deadline + graceMinutes`.
- Post-deadline detection uses author date (self-reported, always labelled as such), compared as absolute instants; timezone offsets in the config and in git dates are both honored.
- `DATE_ANOMALY` is raised for author dates more than five minutes in the future relative to scan time, or before `courseStart`.
- All reports containing dates say that git dates are self-reported.

## Repository health

- Ref resolution order: configured `ref`; if missing, `origin/<ref>`; then `origin/HEAD`; then `main`, `master`; then `HEAD`. The ref actually used is recorded in `repos[].refUsed` and logged as a warning when a fallback was needed.
- Shallow clones raise `SHALLOW_CLONE`. `--unshallow` runs `git fetch --unshallow` before analysis. Under `--strict`, the analysis is still written, then the command exits 2.
- Missing repositories or bad refs produce warnings and a valid (empty) team section rather than a crash.
- Submodules are listed via `git ls-files --stage` mode `160000` and never counted.

## GitHub enrichment

- Enabled by `--github` or `github.enabled: true` in config. A token is read only from `GITHUB_TOKEN` or `GH_TOKEN`. Config files that look like they contain a token are refused (exit 2).
- Owner/repo come from the `origin` remote; HTTPS, SSH (`git@github.com:o/r.git`), and `ssh://` forms are supported by a regex on `github.com[:/]`.
- Requests are sequential, so the maximum concurrency of 4 is satisfied trivially. Retries honor `Retry-After` and `X-RateLimit-Reset` with exponential backoff plus jitter, capped at five attempts.
- Cache entries live in `.contribcheck/cache/` keyed by a SHA-256 of the URL. Only the response body and ETag are stored; request headers (including Authorization) are never stored. 304 responses are cache hits.
- PR metrics are collected for PRs linked to squash containers. This is the set of PRs the scan can justify from git history; enumerating every repo PR would add noise and extra API cost. `reviews`, inline `pulls/{n}/comments`, and `issues/{n}/comments` are paginated. Self-approval raises `SELF_APPROVED`.
- Without `--github`, `pr` is `null` and reports say “not collected”.

## JSON, reports, privacy

- `analysis.json` is the single source of truth, `schemaVersion: 1`. A working copy is also written to `.contribcheck/analysis.json` (unless the config is inside an analyzed repo), matching the privacy note that `.contribcheck/` holds the cache and analysis. Keys are sorted recursively and numbers are rounded to four decimals in JSON so repeated `--no-timestamp` runs are byte-identical.
- Human reports cap evidence at 25 items per metric; JSON is complete.
- Markdown table cells escape `|`, backticks, `<`, `>`, and backslashes. Raw HTML is never emitted.
- HTML is one self-contained file per team with inline CSS and inline SVG bars; every user-controlled value is HTML-escaped. No scripts.
- CSV prefixes cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return with an apostrophe (formula-injection guard). There is no grade column.
- `--redact` replaces emails (and email-shaped strings in messages/evidence) with deterministic hash-based pseudonyms such as `email-3f2a1b9c`, so the same address gets the same pseudonym in every format and every run.
- The student view (`explain --view student`) shows only that member’s metrics/flags and anonymized team totals; no emails, no other members’ numbers.
- `adjustments.yaml` notes are displayed verbatim and never change numbers.

## CLI and exits

- Exit codes: `0` success; `1` runtime failure; `2` invalid config/roster, refusal, or shallow clone under `--strict`; `3` unresolved identities under `--strict`.
- Global flags `--json`, `--quiet`, `--verbose`, `--no-color` are accepted; `--json` prints machine-readable summaries where meaningful.
- `purge` prompts on a TTY unless `--yes`; in a non-interactive shell it refuses without `--yes`.
- `scan` prints a per-team summary with no emails.
- Unresolved identities are grouped by email and only suggested by name similarity, always labelled `unverified`; they are never assigned automatically.

## Testing

- Fixtures create real git repositories in OS temp directories. Git identity, dates, GPG signing, and `core.autocrlf` are set explicitly through `-c` flags and environment variables. No wall-clock dependence: all test commits use fixed dates (post-deadline tests use 2026 dates relative to a fixed demo deadline rather than “now”).
- Tests never call the network. The GitHub client is tested with an injected fake `fetch`; the scan test injects a fake fetch and a fake token.
- `--depth 1 --no-local` is used for shallow-clone tests so the clone is genuinely shallow on Windows.

## Known deviations / limitations recorded honestly

- GitHub PR metrics are limited to PRs discovered through squash containers, not every PR in the repository.
- `git patch-id` is computed for every walked commit, which can be slow on very large histories; this is a deliberate accuracy/cost trade-off.
- Evidence is capped only in human reports, per the prompt; `analysis.json` keeps everything and can become large.
- The composite is a presentation aid and is off by default; it is never shown without its formula and components.
