# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-05

### Added

- `scan` command and library API (`scan`, `loadConfig`, `loadRoster`, `renderReport`, types).
- Single `attribute(commit)` credit function: co-authors, squash containers, bots, exclusions, unresolved identities.
- Meaningful churn with lockfile/generated/binary/submodule/`excludePaths` exclusions and formatting-only estimates.
- Surviving-line attribution with `git blame -M -C`, `.git-blame-ignore-revs`, and blob-based caching.
- Patch-id duplicate detection, starter-code detection, large-commit and deadline flags.
- Optional GitHub enrichment with ETag caching, retry/backoff, PR/review/comment metrics, and self-approval detection.
- `init`, `doctor`, `scan`, `identities`, `report`, `explain`, and `purge` commands.
- Markdown, HTML (self-contained, escaped, inline SVG), CSV (formula-injection guarded), and JSON reports.
- `--redact`, student view, instructor notes, deterministic output with `--no-timestamp`.
- Demo generator (`scripts/make-demo-repo.mjs`), docs, and CI for Node 22/24 on Ubuntu and Windows.
- Scale smoke benchmark (`scripts/benchmark-scan.mjs`) with batched git operations.
- 43 Vitest tests covering attribution, exclusions, identity, deadlines, shallow clones, blame, duplicates, security, determinism, GitHub client behavior, and paths with spaces.

### Security

- Upgraded `zod` to 4.6.x and `csv-parse` to 7.0.x so `npm audit` reports 0 vulnerabilities for production and development dependencies.
- Kept the runtime dependency set to exactly `commander`, `zod`, `yaml`, and `csv-parse`.
- Added `vitest` 5 and a `vitest.config.ts` timeout for slower Windows fixture tests.

### Performance

- Batched patch-id and numstat work per repository instead of spawning multiple git processes per commit.
- Cached `linguist-generated`/`linguist-vendored` attributes per repository.
- Indexed commits by SHA for blame line attribution.
- Benchmark: a synthetic 200-commit repository scans in ~5.5 s (down from ~84 s); 500 commits in ~7.4 s on Windows.

[0.1.0]: https://github.com/arjunrhetoric/contribcheck/releases/tag/v0.1.0
