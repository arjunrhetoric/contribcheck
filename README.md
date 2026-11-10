# contribcheck

**Explainable, auditable contribution evidence from local git repositories.**

Git history records who did what, but common tools mislead: squash merges collapse a pull request into one commit, pair work in `Co-authored-by` trailers is ignored, lockfiles and generated code count as effort, bots count as people, and churn that was later deleted looks the same as code that survived. `contribcheck` reads one or more local repositories for a team and produces an explainable breakdown: who authored what, what survives in the final codebase, when work happened, and what needs a human to look at. It can optionally add GitHub pull request data.

> **This is not a grade.** It is evidence for a human decision. It never ranks people, never assigns grades, and never outputs a single verdict.

## What it is

- A CLI that writes files: `analysis.json`, Markdown/HTML/CSV reports, and per-member explanations.
- A small library (`scan`, `loadConfig`, `loadRoster`, `renderReport`, and types).
- Deterministic and offline by default. The only network calls are to `api.github.com`, and only with `--github`.
- Read-only on analyzed repositories. It never runs checkout, reset, pull, push, commit, gc, or any other write command. `git fetch --unshallow` is the sole exception, and only with `--unshallow`.

## What it is not

- Not a grader or an AI/LLM scorer.
- Not keystroke, time, or activity monitoring.
- Not a server, database, web app, or telemetry collector.
- Not an identity guesser. Unresolved identities are reported, never silently assigned.
- Not a ranking tool.

## Quick start (five minutes, using the demo)

Requires Node.js 22+ and Git 2.23+.

```bash
git clone <this repo> contribcheck
cd contribcheck
npm install
npm run build
npm run demo
```

`npm run demo` writes a deterministic three-member repository to `examples/demo/repos/team-alpha` and template config/roster files to `examples/demo/`.

```bash
cd examples/demo
node ../../dist/cli.js scan
node ../../dist/cli.js report --format md,html,csv
node ../../dist/cli.js explain alice --view student --format md
```

Sample summary from the demo:

```
team team-alpha: 3 members, 17 commits, 604 churn, 604 surviving
  alice Alice: commits=4.5 churn=107.5 surviving=4.5
  bob Bob: commits=3.5 churn=4.5 surviving=104.5
  carol Carol: commits=7 churn=491 surviving=487
  flag DATE_ANOMALY [review]: ...
  flag DUPLICATE_PATCH [info]: ...
  flag FORMATTING_HEAVY [info] bob: ...
  flag LARGE_COMMIT [review]: ...
  flag POST_DEADLINE_WORK [info] carol: ...
  flag SQUASH_UNRESOLVED [info]: ...
  flag UNRESOLVED_IDENTITY [review]: ...
```

Sample member table from `team-alpha.md`:

| member | commits | churn | surviving | formatting (est.) | commit share | churn share | surviving share | post-deadline | pair |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| alice Alice | 4.5 | 107.5 | 4.5 | 0 | 30.0% | 17.8% | 0.8% | 0 | 1 |
| bob Bob | 3.5 | 4.5 | 104.5 | 200 | 23.3% | 0.8% | 17.5% | 0 | 1 |
| carol Carol | 7 | 491 | 487 | 0 | 46.7% | 81.4% | 81.7% | 1 | 0 |

Unattributed: commits=1 (5.9% of team commits), churn=1 (0.2% of churn), surviving=1 (0.2% of surviving). Excluded: commits=1 surviving=7.

## Your own team

```bash
npx contribcheck init
```

This writes `contribcheck.yaml`, `roster.csv`, and `adjustments.yaml` templates. Edit the repository paths, team deadline, and roster, then:

```bash
npx contribcheck doctor
npx contribcheck scan
npx contribcheck report --format md,html,csv
```

## Configuration (`contribcheck.yaml`)

```yaml
timezone: Asia/Kolkata            # IANA name for weekly buckets and deadlines
courseStart: "2026-08-01"         # optional; earlier commits are flagged
includeUnmerged: false            # also count commits not reachable from the team ref
excludePaths: ["docs/generated/**"]
excludeCommits: []                # SHAs to ignore (e.g. an instructor template import)
bots: []                          # extra logins or emails treated as bots
coAuthorCredit: equal             # equal | none
composite:
  enabled: false
  weights: { commits: 0.2, churn: 0.3, survivingLines: 0.5 }
thresholds:
  lowShare: 0.5
  largeCommitLines: 2000
  largeCommitFiles: 50
areas:
  frontend: "apps/web/**"
  backend: "apps/api/**"
github:
  enabled: false
teams:
  team-alpha:
    deadline: "2026-11-15T23:59:00+05:30"
    graceMinutes: 0
    ref: main                     # default: remote default branch, else main/master/HEAD
    repos:
      - ../clones/alpha-frontend
      - ../clones/alpha-backend
```

Paths are relative to the config file. The default output directory is `contribcheck-out/` next to the config. If the output path would be inside an analyzed repository, the scan refuses unless `--allow-in-repo` is passed.

## Roster (`roster.csv`)

```csv
team,member_id,name,emails,github
team-alpha,alice,Alice,alice@example.com;alice@school.edu,alice-gh
team-alpha,bob,Bob,bob@example.com,bob-gh
```

- `emails` is semicolon-separated.
- `github` is optional, but every member needs at least one email or a GitHub login.
- `member_id` must be unique, no email may belong to two members, and every team must exist in the config.

## How credit works

One function, `attribute(commit)`, decides credit. Commit counts, churn, surviving lines, weekly activity, and area breakdowns all use its shares. Highlights:

- **Co-authors** split equally (`coAuthorCredit: equal`); unresolved co-authors go to `unattributed`; `pairCommits` is always counted.
- **Squash merges** credit the PR’s commit authors when GitHub data is available, using a documented approximation; otherwise the listed author is credited and `SQUASH_UNRESOLVED` is raised.
- **Bots, lockfiles, generated/vendored files, binaries, submodules, and excluded paths** are removed from churn and blame. Every exclusion is listed as evidence.
- **Formatting-only churn** is estimated and reported separately, not counted.
- **Surviving lines** come from `git blame -M -C` at the team ref, respecting `.git-blame-ignore-revs`.
- **Shares** use attributed credit only; a zero denominator gives `null`, not 0.
- **Flags** always include an innocent explanation, and every metric links to evidence.

Read every rule, formula, and default threshold in [`docs/METHOD.md`](docs/METHOD.md).

## Commands

| Command | Purpose |
| --- | --- |
| `contribcheck init` | Write config, roster, and adjustments templates |
| `contribcheck doctor` | Check git version, config/roster validity, shallow status, token and rate limit |
| `contribcheck scan` | Walk repositories, write `analysis.json`, print a per-team summary |
| `contribcheck identities` | List unresolved identities by email |
| `contribcheck report` | Render `md`, `html`, `csv`, `json` from `analysis.json` |
| `contribcheck explain <memberId>` | Explain one member (`--view instructor` or `student`) |
| `contribcheck purge` | Delete `.contribcheck/` and the output directory (confirmation unless `--yes`) |

Global flags: `--json`, `--quiet`, `--verbose`, `--no-color`.

Scan flags: `--config`, `--roster`, `--team`, `--out`, `--github`, `--include-unmerged`, `--skip-blame`, `--strict`, `--unshallow`, `--no-timestamp`, `--allow-in-repo`.

Exit codes: `0` success; `1` runtime failure; `2` invalid config/roster, refusal, or shallow clone under `--strict`; `3` unresolved identities under `--strict`.

## GitHub enrichment (optional)

```bash
export GITHUB_TOKEN=...        # or GH_TOKEN; never put tokens in config
contribcheck scan --github
```

- Owner/repo come from the `origin` remote (HTTPS and SSH forms).
- Responses are cached in `.contribcheck/cache/` with ETags; 304 is a cache hit.
- Retries respect `Retry-After` and `X-RateLimit-Reset`, with exponential backoff and jitter.
- PR metrics include PRs authored/merged, reviews by state, inline comments, issue comments, and self-approvals.
- Without `--github`, PR metrics are `null` and reports say “not collected.”

## Outputs

- `analysis.json` — the single source of truth, `schemaVersion: 1`; sensitive because it contains emails. A working copy is also kept in `.contribcheck/analysis.json` (or the OS temp cache when the config lives inside an analyzed repo).
- `<team>.md` — evidence for human review, method summary, member table, flags, evidence, unresolved identities, instructor notes, limitations.
- `<team>.html` — one self-contained file with inline CSS and inline SVG weekly bars; escaped, print-friendly, no scripts.
- `report.csv` — one row per member per team, flat metrics, no grade column, formula-injection guarded.
- `explain` — one member only; the student view shows anonymized team totals and no emails.

## Privacy and responsible use

- No network calls except `api.github.com` with `--github`. No telemetry.
- Tokens are read only from `GITHUB_TOKEN`/`GH_TOKEN`, never stored, never printed, never included in errors. Configs that look like they contain a token are refused.
- `analysis.json` contains emails. Treat it as sensitive; use `--redact` when sharing, and `contribcheck purge --yes` when done.
- Instructors: read [`docs/RESPONSIBLE-USE.md`](docs/RESPONSIBLE-USE.md) before using this with students. Tell students what is measured, review flags with them, and remember that design, documentation, research, testing, and in-person pairing are underrepresented in git history.
- Depending on your jurisdiction, student-privacy rules such as FERPA (US) or GDPR/UK GDPR (EU/UK) may apply. This is not legal advice; consult your institution.

## Limitations

Squash merges are approximations, rewritten history is unrecoverable, shallow clones are incomplete, git dates are self-reported, identities are never guessed, and non-code work is underrepresented. See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for the full list.

## Documentation

- [`docs/METHOD.md`](docs/METHOD.md) — every rule, formula, default, and a worked example
- [`docs/EXPLAINER.md`](docs/EXPLAINER.md) — beginner-friendly guide to npm, git, the architecture, machines, publishing, and the whole package
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)
- [`docs/ANALYSIS-SCHEMA.md`](docs/ANALYSIS-SCHEMA.md)
- [`docs/RESPONSIBLE-USE.md`](docs/RESPONSIBLE-USE.md)
- [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests create real git repositories in OS temp directories and never use the network or wall-clock time. CI runs Node 22 and 24 on Ubuntu and Windows.

## License

MIT. See [`LICENSE`](LICENSE).
