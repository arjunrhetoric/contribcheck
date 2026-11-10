# contribcheck — the complete explainer

This guide is for someone who knows a little JavaScript or TypeScript but is new to npm packages. It explains the vocabulary, how npm packages work in general, how **this** package works specifically, how it behaves on different machines, and how to answer questions about it.

You do not need to memorize everything. Read the “one-page summary” first, then use the sections as reference.

## Contents

1. [One-page summary](#1-one-page-summary)
2. [The vocabulary, from the ground up](#2-the-vocabulary-from-the-ground-up)
3. [How the CLI actually runs](#3-how-the-cli-actually-runs)
4. [What contribcheck does, in domain terms](#4-what-contribcheck-does-in-domain-terms)
5. [Git concepts used by this package](#5-git-concepts-used-by-this-package)
6. [The attribution engine, in detail](#6-the-attribution-engine-in-detail)
7. [Architecture and file map](#7-architecture-and-file-map)
8. [GitHub enrichment](#8-github-enrichment)
9. [Outputs, redaction, and student view](#9-outputs-redaction-and-student-view)
10. [Security and privacy model](#10-security-and-privacy-model)
11. [How it behaves on different machines](#11-how-it-behaves-on-different-machines)
12. [Tests and CI](#12-tests-and-ci)
13. [Publishing this package, step by step](#13-publishing-this-package-step-by-step)
14. [Troubleshooting and FAQ](#14-troubleshooting-and-faq)
15. [Glossary](#15-glossary)
16. [The demo, explained](#16-the-demo-explained)
17. [Two-minute explanation you can give](#17-two-minute-explanation-you-can-give)
18. [Cheat sheet](#18-cheat-sheet)

---

## 1. One-page summary

`contribcheck` is a **command-line tool** written in **TypeScript**, packaged as an **npm package**, that reads local **git repositories** and writes an **evidence report** about who contributed what to a team project.

It is:

- a **CLI** (`contribcheck scan`, `contribcheck report`, …);
- a **library** (`import { scan } from "contribcheck"`);
- **offline by default** (no network unless `--github`);
- **read-only** on the repositories it analyzes (no checkout, commit, push, etc.);
- **not** a grader, ranker, or AI scorer.

The basic flow:

```text
contribcheck.yaml + roster.csv + local git repositories
        │
        ▼
  load and validate inputs
        │
        ▼
  walk git history, diffs, blame
        │
        ▼
  decide credit with attribute(commit)
        │
        ▼
  aggregate metrics + flags + evidence
        │
        ▼
  analysis.json
        │
        ▼
  Markdown / HTML / CSV reports, student view
```

The most important idea: **credit is decided once**, in one function, and every metric uses that decision. That makes the output explainable and auditable.

---

## 2. The vocabulary, from the ground up

### 2.1 Node.js, npm, and packages

| Term | Simple meaning |
|---|---|
| **Node.js** | A program that runs JavaScript outside a browser. It also provides built-in modules such as `fs` (files), `path`, `child_process` (running other programs), and `fetch` (HTTP). |
| **npm** | Two related things: (1) the command-line client, and (2) the public registry at `registry.npmjs.org` where packages are stored. |
| **package** | A folder with a `package.json` file. It can contain code, types, docs, and metadata. |
| **module** | A single JavaScript/TypeScript file that exports something. A package usually contains many modules. |
| **library** | Code that another program imports and calls. `contribcheck` can be used as a library. |
| **CLI** | Command-line interface. A program you run in a terminal, e.g. `contribcheck scan`. |
| **repository (repo)** | A project folder tracked by git, with history. Not the same thing as an npm package, though one folder can be both. |
| **registry** | The server that stores published packages and their metadata. |
| **dependency** | Another package your package needs at runtime. |
| **dev dependency** | A package needed only while developing/testing/building, not by users at runtime. |
| **transitive dependency** | A dependency of a dependency. You usually do not list it yourself. |
| **`node_modules/`** | The folder where npm installs packages. It is generated, huge, and normally not committed or published. |
| **lockfile** | `package-lock.json`. It records the exact versions and download URLs that were installed, so installs are repeatable. |

A useful analogy:

- npm registry = an app store;
- a package = an app;
- `package.json` = the app’s ID card and requirements list;
- `package-lock.json` = the exact shopping receipt;
- `node_modules/` = the installed app files;
- `npx` = “run this app without permanently installing it”.

### 2.2 `package.json`

Every npm package has one. Ours looks roughly like this (abridged):

```json
{
  "name": "contribcheck",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": { "contribcheck": "./dist/cli.js" },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md", "docs", "CHANGELOG.md"],
  "engines": { "node": ">=22" },
  "dependencies": {
    "commander": "^12.1.0",
    "csv-parse": "^5.6.0",
    "yaml": "^2.6.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "demo": "node scripts/make-demo-repo.mjs",
    "prepublishOnly": "npm run typecheck && npm run test && npm run build"
  }
}
```

What each important field means:

| Field | Why it exists |
|---|---|
| `name` | The package name on the registry and the name people import. |
| `version` | The package version. `0.1.0` means “early, not stable yet”. |
| `type: "module"` | The package uses **ES modules** (`import`/`export`), not old CommonJS (`require`). |
| `main` | A fallback entry file for tools that do not understand `exports`. |
| `exports` | The modern, explicit map of what can be imported. Here only the package root (`"."`) is exposed. |
| `types` | Where TypeScript declarations live. |
| `bin` | Creates a terminal command. `contribcheck` runs `dist/cli.js`. |
| `files` | A whitelist of what gets packed/published. `node_modules`, tests, and source are not included. |
| `engines` | Warns that Node 22 or newer is required. |
| `dependencies` | Installed for everyone who installs the package. |
| `devDependencies` | Installed only for development, not for consumers. |
| `scripts` | Named commands run with `npm run <name>`. |
| `prepublishOnly` | Runs automatically before `npm publish`, as a safety gate. |

### 2.3 Version numbers and semver

Versions look like `MAJOR.MINOR.PATCH`, e.g. `12.1.0`.

- **MAJOR** changed: breaking changes.
- **MINOR** changed: new features, backwards compatible.
- **PATCH** changed: bug fixes, backwards compatible.

Ranges in `package.json`:

| Range | Meaning |
|---|---|
| `12.1.0` | Exactly that version. |
| `^12.1.0` | `>=12.1.0 <13.0.0` — accepts compatible minor/patch updates. |
| `~12.1.0` | `>=12.1.0 <12.2.0` — accepts patch updates only. |
| `*` or `latest` | Anything / newest. Avoid for reproducibility. |

The caret `^` is common because it gets bug fixes without jumping to a breaking major version.

### 2.4 Lockfiles, `npm install`, and `npm ci`

- `npm install` reads `package.json`, resolves versions, writes `package-lock.json`, and installs into `node_modules/`.
- `npm ci` (“clean install”) deletes `node_modules/`, then installs **exactly** what the lockfile says. It is the standard for CI.
- Do not edit `package-lock.json` by hand.
- Commit the lockfile for applications and tools. For libraries, practices vary, but committing it helps contributors and CI.

The lockfile does not contain the actual package code; it contains exact versions, integrity hashes, and dependency relationships.

### 2.5 Local vs global vs `npx`

```bash
npm install contribcheck          # local dependency of the current project
npm install -g contribcheck       # global command on your machine
npx contribcheck scan             # run it; installs temporarily if needed
./node_modules/.bin/contribcheck  # run the locally installed binary
```

`npx` is convenient, but it may download the package. For this project, the safest workflow is:

```bash
npm install
npm run build
node dist/cli.js --help
```

That runs the exact code in your checkout.

### 2.6 CommonJS vs ES modules

Older Node code uses **CommonJS**:

```js
const fs = require("node:fs");
module.exports = { hello: () => "hi" };
```

Modern code uses **ES modules**:

```js
import fs from "node:fs";
export function hello() { return "hi"; }
```

This package uses ESM (`"type": "module"`). Consequences:

- Relative imports in built JavaScript must include the file extension: `import { scan } from "./scan.js"`.
- `require("contribcheck")` is not the intended usage; import it instead.
- The `exports` map explicitly exposes only the package root.

### 2.7 TypeScript, `tsc`, `dist`, and `.d.ts`

TypeScript is JavaScript plus static types. Browsers and Node do not run TypeScript directly, so it is **compiled**:

```text
src/*.ts  ── tsc ──►  dist/*.js  +  dist/*.d.ts
```

- `src/` is what humans edit.
- `dist/` is what gets published and executed.
- `.js` files are runtime code.
- `.d.ts` files are **type declarations**: they describe the API to editors and TypeScript users without containing implementation.
- `tsc --noEmit` type-checks without writing files. That is what `npm run typecheck` does.
- `tsc` with no flags builds `dist/`.

`dist/` is gitignored in this repository. That is normal for a package whose `prepublishOnly` script builds before publishing. If you clone the repo, run `npm run build` before running `node dist/cli.js`.

### 2.8 The npm package tarball

`npm publish` does not send your folder as-is. It creates a `.tgz` tarball containing only the files allowed by `files` (plus a few mandatory files like `package.json`, `README`, `LICENSE`).

Useful commands:

```bash
npm pack --dry-run   # list what would be included, without creating a tarball
npm pack             # create contribcheck-0.1.0.tgz
```

You can install a tarball locally:

```bash
npm install ../contribcheck-0.1.0.tgz
```

This is an excellent pre-publish test because it uses the same packed artifact consumers would get.

### 2.9 Lifecycle scripts

npm can run scripts around events:

- `preinstall`, `install`, `postinstall` — when a consumer installs (avoid doing surprising work here).
- `prepublishOnly` — before publishing, publisher side only.
- `prepack` — before creating a tarball.

This package only uses `prepublishOnly`, which runs:

```text
typecheck → test → build
```

So a broken package cannot be published accidentally.

### 2.10 What “publishing” actually means

Publishing uploads a tarball and metadata to the registry. After that:

- anyone can `npm install contribcheck`;
- the version is effectively permanent (unpublishing is heavily restricted);
- `README.md` is shown on the package page;
- `bin`, `exports`, `types`, and `files` control how it behaves for consumers.

**Current state:** this project has been built, packed, and installed from its tarball locally, but it has **not** been published to the public npm registry. Publishing requires an npm account, login, and `npm publish`.

### 2.11 The rest of the dependency vocabulary

A few more terms you may hear:

| Term | Meaning |
|---|---|
| **Hoisting** | npm tries to place a dependency as high in `node_modules/` as possible so multiple packages can share it. If two packages need incompatible versions, one copy may be nested under the package that needs it. |
| **Deduplication** | Reusing one installed copy instead of several identical ones (`npm dedupe`). |
| **Peer dependency** | A package that a plugin expects the *host* project to provide, e.g. a plugin that needs a specific React version. It is not installed automatically the same way normal dependencies are. |
| **Optional dependency** | A dependency whose install failure should not fail the whole install. |
| **Override** | A `package.json` field that forces a transitive dependency to a chosen version, often for security fixes. |
| **Workspace** | npm’s monorepo feature for managing several packages in one repository. This project does not use workspaces. |
| **npm audit** | Reports known vulnerabilities in the dependency tree. |
| **npm cache** | A machine-level download cache (usually under the user’s home directory), separate from this project’s `.contribcheck/` cache. |
| **`npm link`** | Connects a local package into another project for development without publishing. |

The key distinction: `.contribcheck/` is **application data** (git analysis and GitHub responses), while npm’s cache is **package download data**. They are unrelated.

### 2.12 Useful inspection commands

```bash
npm view contribcheck                 # registry metadata
npm view contribcheck versions        # published versions
npm ls commander                      # why is this installed?
npm explain commander                 # dependency path explanation
npm outdated                          # newer versions available
npm audit                             # known vulnerabilities
npm pkg get dependencies              # read a package.json field
npm pkg set version=0.1.1             # edit a field safely
```

When debugging “why is this package here?”, `npm explain <name>` is usually faster than reading `package-lock.json` by hand.

---

## 3. How the CLI actually runs

### 3.1 The `bin` entry and the shebang

`dist/cli.js` starts with:

```js
#!/usr/bin/env node
```

That is a **shebang**. On Unix-like systems it tells the OS to run the file with Node. npm also creates executable shims:

- on Linux/macOS: a symlink or executable script in `node_modules/.bin/`;
- on Windows: `contribcheck.cmd`, `contribcheck.ps1`, and possibly a shell script.

When you type `contribcheck`, your shell finds the shim via `PATH`, and the shim runs `node .../dist/cli.js`.

### 3.2 Argument parsing with Commander

The CLI uses the `commander` package. Simplified flow:

```text
process.argv (e.g. ["node","cli.js","scan","--team","alpha"])
      │
      ▼
Commander matches the "scan" command
      │
      ▼
parse known options into an object
      │
      ▼
call the scan action
      │
      ▼
call library scan()
      │
      ▼
write files, print summary, exit with a code
```

Commander handles `--help`, `--version`, unknown options, and subcommands.

### 3.3 Exit codes

| Code | Meaning in this tool |
|---|---|
| `0` | Success. |
| `1` | Runtime failure (missing repo, Git failure, unknown member, etc.). |
| `2` | Invalid config/roster, unsafe output path, bad CLI value, or shallow clone under `--strict`. |
| `3` | Unresolved identities under `--strict`. |

Exit codes matter because scripts and CI use them, not the text output.

### 3.4 stdout vs stderr

- Normal results and summaries go to **stdout**.
- Error messages go to **stderr**.
- `--json` switches some commands to machine-readable output.

This separation lets you pipe stdout to a file while still seeing errors.

### 3.5 How Node resolves imports

When Node sees:

```js
import { scan } from "./scan.js";
```

it resolves relative to the current file. When a consumer sees:

```js
import { scan } from "contribcheck";
```

Node looks in `node_modules/contribcheck`, reads `package.json`, finds the `exports` map, and loads `dist/index.js`. TypeScript reads `types`/`types` condition for declarations.

If `dist/index.js` is missing, the import fails. That is why `npm run build` is required before running the published entry point from a fresh clone.

---

## 4. What contribcheck does, in domain terms

### 4.1 The problem

Git history is not a fair effort report:

- **Squash merges** collapse a PR into one commit, losing the other authors.
- **Co-authored-by trailers** are ignored by most line-count tools.
- **Lockfiles, generated code, vendored code, binaries** inflate churn.
- **Bots** look like contributors.
- **Churn that was deleted** looks as important as code that survived.
- **Git dates are self-reported** and can be wrong or manipulated.

`contribcheck` tries to produce **evidence for a human decision**, not a score.

### 4.2 The two inputs

1. **`contribcheck.yaml`** — team definitions, repo paths, deadline, timezone, exclusions, thresholds, optional areas, optional GitHub enrichment.
2. **`roster.csv`** — who is on each team: `team,member_id,name,emails,github`.

Everything else is local git data.
 
### 4.3 The scan pipeline, step by step

```text
1. Validate config with zod and roster with csv-parse.
2. Check git >= 2.23.
3. For each team:
   a. For each repo:
      - detect shallow clone;
      - resolve the team ref;
      - read commits reachable from that ref;
      - optionally include other branches;
   b. Deduplicate commits across repos by SHA.
   c. Compute patch-ids for duplicate detection.
   d. For each commit:
      - decide exclusions (merge, bot, SHA, starter code, duplicate);
      - compute meaningful churn (excluding lockfiles, generated, binary, etc.);
      - estimate formatting-only churn;
      - parse co-author trailers;
      - resolve identities;
      - call attribute(commit) to get shares;
      - detect squash containers and, if enabled, distribute via GitHub PR data;
      - apply deadline/date rules.
   e. Aggregate per-member metrics from shares.
   f. Run git blame at the team ref for surviving lines.
   g. Reconcile member + unattributed + excluded = team total.
   h. Build flags with evidence.
4. Write analysis.json (and a working copy under .contribcheck/).
5. Print a summary without emails.
```

### 4.4 The outputs

| Output | Purpose |
|---|---|
| `analysis.json` | Single source of truth, machine-readable, complete. Contains emails; sensitive. |
| `<team>.md` | Human review report. Starts with “Evidence for human review. This is not a grade.” |
| `<team>.html` | Self-contained, escaped, print-friendly, inline SVG weekly bars. |
| `report.csv` | One row per member per team, flat metrics, no grade column. Formula-injection guarded. |
| `explain` output | One member only. Student view hides other members and emails. |
| `.contribcheck/` | Cache (GitHub/ETag/blame) plus a working analysis copy. |

---

## 5. Git concepts used by this package

### 5.1 Repository, working tree, object database

- **Repository**: the `.git/` directory plus history.
- **Working tree**: the checked-out files you see.
- **Object database**: immutable blobs, trees, commits, and tags stored under `.git/objects`.
- **Index/staging area**: what will go into the next commit.

`contribcheck` reads the object database and refs. It does not change the working tree or index.

### 5.2 Commit, SHA, parent, tree

A commit contains:

- a **SHA** (content hash, e.g. `145c76d9127f...`);
- a **tree** (snapshot of files);
- zero or more **parents** (previous commits);
- an **author** (name, email, date);
- a **committer** (name, email, date);
- a **message** (subject + body).

A commit with two or more parents is a **merge commit**.

Git dates are supplied by the person or program making the commit. They are not trustworthy timestamps like a server log.

### 5.3 Refs, branches, HEAD, remotes

- **Ref**: a named pointer to a commit, e.g. `refs/heads/main`.
- **Branch**: a movable ref under `refs/heads/`.
- **`HEAD`**: what is currently checked out.
- **Remote**: another copy of the repository, usually `origin`.
- **`origin/HEAD`**: the remote’s default branch pointer (when fetched).
- **Detached HEAD**: HEAD points directly at a commit instead of a branch.

Ref resolution in this tool:

```text
configured ref
  → origin/<ref>
  → origin/HEAD
  → main
  → master
  → HEAD
```

The ref actually used is recorded and logged.

### 5.4 Merge, squash, cherry-pick, rebase

| Operation | What it does | Effect on history |
|---|---|---|
| **Merge** | Joins two histories with a merge commit. | Both parent histories remain. |
| **Fast-forward merge** | Moves a branch pointer forward, no merge commit. | Linear history. |
| **Squash merge** | Combines all PR commits into one new commit on the target branch. | Individual commits disappear from the target branch. |
| **Cherry-pick** | Copies one commit’s change onto another branch as a new commit. | Same patch, new SHA. |
| **Rebase** | Replays commits onto a new base. | New SHAs, same logical changes. |

Squash and cherry-pick are why `contribcheck` uses **patch-ids**.

### 5.5 Patch-id

`git patch-id --stable` hashes the actual diff of a commit, ignoring metadata like SHA and commit message. Two commits with the same patch-id contain the same change.

Rules in this tool:

- same patch-id + same resolved author → the later one is a duplicate; count once;
- same patch-id + different authors → both count, but raise `DUPLICATE_PATCH`.

### 5.6 Diff, numstat, rename detection

`git diff` shows line changes. `--numstat` gives machine-readable counts:

```text
12  3  src/app.ts
```

= 12 added lines, 3 deleted lines.

Rename detection (`-M`) lets git say “this file was renamed” instead of “old file deleted, new file added”. A pure rename therefore has zero churn.

Binary files show `-` instead of numbers.

### 5.7 Churn

**Churn** is added + deleted lines. It measures edit volume, not value. A huge generated file can have enormous churn but no engineering effort.

This tool computes **meaningful churn** after exclusions, and separately estimates **formatting-only churn**.

### 5.8 Blame

`git blame` walks history line by line and reports which commit last touched each surviving line. `contribcheck` runs:

```text
git blame --line-porcelain -M -C <ref> -- <file>
```

- `--line-porcelain` is stable machine-readable output.
- `-M` detects moved lines within a file.
- `-C` detects copied lines from other files.

Lines from a co-authored commit receive that commit’s fractional shares.

### 5.9 `.mailmap`

`.mailmap` maps old names/emails to canonical ones. Git can apply it with `--use-mailmap`, which this tool uses when reading history. This merges identities without guessing.

### 5.10 `.gitattributes` and linguist attributes

`.gitattributes` can mark files:

```text
generated/* linguist-generated=true
vendor/* linguist-vendored=true
```

`git check-attr` reads these. contribcheck excludes such files from churn and blame.

### 5.11 Submodules

A submodule is a pointer to another repository at a specific commit. It appears as mode `160000` in `git ls-files --stage`. The tool lists submodules but does not analyze their contents.

### 5.12 Shallow clones

`git clone --depth 1` downloads only recent history. `git rev-parse --is-shallow-repository` detects this. Blame and history are incomplete; the tool raises `SHALLOW_CLONE`. `--unshallow` runs the only write-like command it ever runs: `git fetch --unshallow`.

### 5.13 `.git-blame-ignore-revs`

A file listing commits that should be ignored by blame, typically bulk formatting commits. Passing `--ignore-revs-file .git-blame-ignore-revs` makes blame skip them. contribcheck does this automatically when the file exists.

### 5.14 Rewritten history

Force-push, rebase, and history filtering create new SHAs and can remove old commits. If the old commits are gone from the local clone, no tool can recover them. This is documented as a limitation.

---

## 6. The attribution engine, in detail

### 6.1 The core rule

There is exactly one function that decides credit:

```ts
attribute(commit) -> Share[]
```

Each share looks like:

```ts
{
  memberId: string | null,
  share: number,
  role: "primary" | "co-author" | "pr-author" | "excluded" | "unattributed",
  method: "direct" | "coauthor-equal" | "squash-github" | "squash-fallback" | ...
}
```

The shares for a commit sum to 1. Commit counts, churn, surviving lines, weekly activity, and areas all use those shares. This is why different reports cannot silently disagree.

### 6.2 Identity resolution order

1. `.mailmap` (git’s own resolution).
2. Roster emails, case-insensitive.
3. GitHub noreply addresses (`123+login@users.noreply.github.com`, `login@users.noreply.github.com`) matched to roster `github`.
4. GitHub API `author.login`, only with enrichment.
5. Otherwise **unresolved**.

Unresolved credit goes to `unattributed`. The tool lists unresolved identities by email with commit count and a sample SHA. A name-similarity hint may be shown, but it is always labelled `unverified` and never assigned automatically.

A name-only `Co-authored-by` trailer has no email or login, so it also stays unresolved. Names are never used to guess.

### 6.3 Co-authors

`Co-authored-by:` trailers are parsed case-insensitively from the message body. Both forms work:

```text
Co-authored-by: Bob <bob@example.com>
Co-authored-by: Bob
```

With `coAuthorCredit: equal`:

```text
share = 1 / number_of_distinct_resolved_identities
```

The primary author is one of them. An unresolved co-author contributes their share to `unattributed`.

With `coAuthorCredit: none`, the primary gets 1 and co-authors get 0 for commits/churn/surviving lines.

`pairCommits` is different: it counts the co-authored commit **once for every resolved participant**, regardless of the credit setting. So in a two-person pair, both get `pairCommits += 1`, even if only the primary gets commit credit.

### 6.4 Bots

A commit is excluded when:

- the login ends in `[bot]`;
- the email matches a GitHub bot noreply pattern;
- the name/login/email is in a built-in list (`dependabot`, `renovate`, `github-actions`, `codecov`, …);
- the name/login/email is listed in `bots` in the config.

Bot commits count in the `excluded` bucket, not for any member.

### 6.5 Exclusion order

1. Merge commits (no own diff).
2. SHAs in `excludeCommits` (full or prefix).
3. Bot commits.
4. Starter code: in a team with 2+ repos, a commit present in every repo and authored by someone not on the roster.
5. Same-author duplicate patches.

Empty commits are **not** excluded. They count as activity with zero churn.

Every exclusion is recorded in `evidence.excluded` with a reason.

### 6.6 Squash containers

A subject ending in `(#123)` is treated as a squash candidate.

Without GitHub data:

- the listed author gets the whole commit (`squash-fallback`);
- `SQUASH_UNRESOLVED` is raised.

With GitHub data, the PR’s commit list is used:

```text
commitShare_i = PR commits by author i / total PR commits
churnShare_i  = author i’s additions+deletions / total PR churn
```

If all churn weights are zero, churn splits equally. If all commit counts are zero, commits split equally.

This is an approximation: squash merges lose history, GitHub stats can be missing, and the PR commit listing has a documented 250-commit limit.

### 6.7 Meaningful churn and formatting

For each file, two numstat runs happen:

```text
normal:   additions/deletions
ignored:  additions/deletions with -w --ignore-blank-lines
```

Then:

```text
formatting_added   = max(0, normal_added   - ignored_added)
formatting_deleted = max(0, normal_deleted - ignored_deleted)
meaningful_added   = normal_added   - formatting_added
meaningful_deleted = normal_deleted - formatting_deleted
```

`formattingLines` is reported but not counted in churn. It is labelled an estimate.

Built-in exclusions:

- lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`, `composer.lock`;
- directories: `node_modules/`, `vendor/`, `dist/`, `build/`, `.next/`, `coverage/`;
- `*.min.js`, `*.map`;
- submodules;
- binaries;
- `linguist-generated` / `linguist-vendored`;
- `excludePaths`.

### 6.8 Surviving lines

Blame runs on every text file that survives exclusions at the team ref. Each line is assigned to its last-touching commit, then to that commit’s shares.

- lines from excluded commits → `excluded`;
- lines from unresolved authors → `unattributed`;
- co-authored lines → fractional shares.

Blame is cached by a hash of the repository path, blob SHA, and the ignore-revs file hash. `--skip-blame` skips this step for speed.

### 6.9 Shares and reconciliation

For each metric:

```text
share(member, metric) = member value / sum of member values
```

The denominator includes attributed member credit only. `unattributed` and `excluded` are not in the denominator.

If the denominator is zero, the share is `null`, not `0`.

Team totals obey:

```text
members + unattributed + excluded = team total
```

for commits, churn, and surviving lines.

### 6.10 Composite score

Off by default. When enabled:

```text
composite = Σ(weight × share) / Σ(weights of available dimensions)
```

Default weights: commits 0.2, churn 0.3, surviving lines 0.5.

The formula and components are always printed with the value. The composite is never shown as a standalone verdict.

### 6.11 Flags

| Flag | Severity | Trigger |
|---|---|---|
| `LOW_SHARE` | review | churn share and surviving share both below `lowShare × (1/team size)` |
| `NO_ACTIVITY` | review | zero credited commits, and zero PR activity when enrichment is on |
| `NO_DEFAULT_BRANCH_WORK` | info | only commits outside the team ref (`--include-unmerged`) |
| `POST_DEADLINE_WORK` | info | credited commit after deadline + grace |
| `LARGE_COMMIT` | review | over line/file thresholds |
| `SQUASH_UNRESOLVED` | info | squash-looking commit without PR data |
| `UNRESOLVED_IDENTITY` | review | unresolved identities present |
| `DATE_ANOMALY` | review | future author date or before `courseStart` |
| `DUPLICATE_PATCH` | info | same patch-id, different authors |
| `FORMATTING_HEAVY` | info | more than half of raw churn is formatting-only |
| `SELF_APPROVED` | info | PR approved by its own author |
| `SHALLOW_CLONE` | review | shallow repository |
| `STARTER_CODE` | info | shared non-roster commit across repos |

Every message states what was observed and gives an innocent explanation. Flags are questions, not findings.

### 6.12 A worked example

Alice adds 90 lines and deletes 10, with:

```text
Co-authored-by: Bob <bob@example.com>
```

Both resolve. `coAuthorCredit: equal`, n = 2:

```text
Alice: 0.5 commits, +45, -5
Bob:   0.5 commits, +45, -5
pairCommits: Alice 1, Bob 1
```

A squash commit `Add reports (#42)` adds 100 lines. With GitHub data:

- PR commits: Alice 2 commits / 80 churn, Bob 1 commit / 20 churn.

```text
commitShare_Alice = 2/3 ≈ 0.667    churnShare_Alice = 80/100 = 0.8
commitShare_Bob   = 1/3 ≈ 0.333    churnShare_Bob   = 20/100 = 0.2
```

So Alice gets 0.667 commits and 80 churn; Bob gets 0.333 commits and 20 churn.

---

## 7. Architecture and file map

### 7.1 Dependency direction

```text
src/cli.ts
  ├── src/config.ts        config + roster validation
  ├── src/git.ts           thin git process wrapper
  ├── src/scan.ts          orchestration: history, churn, blame, metrics
  │     ├── src/attribution.ts   identity resolution + credit shares
  │     ├── src/github.ts        optional API client
  │     └── src/util.ts          text, time, glob, CSV helpers
  ├── src/report.ts        Markdown/HTML/CSV/JSON rendering
  └── src/index.ts         public library exports
```

Types live in `src/types.ts` and are exported from `src/index.ts`.

### 7.2 Module responsibilities

| File | Responsibility |
|---|---|
| `src/cli.ts` | Parse commands/options, call library functions, map errors to exit codes. |
| `src/config.ts` | Load and validate YAML/CSV; resolve paths; detect token-like config. |
| `src/git.ts` | `execFile`/`spawn` wrappers; git version check; shallow/root helpers. |
| `src/attribution.ts` | The one credit function; bots; co-authors; identity resolution. |
| `src/scan.ts` | The pipeline: walking, patch-ids, churn, blame, aggregation, flags, JSON. |
| `src/github.ts` | Token handling, cache, ETag, retries, pagination, rate limits. |
| `src/report.ts` | Escaping, redaction, Markdown/HTML/CSV, student view. |
| `src/util.ts` | Control stripping, globs, timezone weeks, formatting, CSV guards. |
| `src/index.ts` | Public API surface. |

### 7.3 Library API

```ts
import {
  scan,
  loadConfig,
  loadRoster,
  renderReport,
  type Analysis,
  type ScanOptions,
} from "contribcheck";
```

- `scan(options)` runs the pipeline and writes `analysis.json`.
- `loadConfig(path)` returns a validated config object.
- `loadRoster(path, config)` returns validated roster members.
- `renderReport(analysis, format, options)` returns a string or a map of team files, depending on format.

The CLI is a thin layer over these functions. That is a common package design: the library does the work; the CLI handles arguments and exit codes.

### 7.4 Error handling

- Config and roster validation errors carry exit code `2`.
- Git/IO failures carry exit code `1`.
- `--strict` unresolved identities carry exit code `3`.
- Errors never include the GitHub token.
- CLI errors are stripped of control characters before printing.

---

## 8. GitHub enrichment

Optional. Enabled with `--github` or `github.enabled: true`.

### 8.1 Token rules

- Read only from `GITHUB_TOKEN` or `GH_TOKEN`.
- Never from config.
- Never printed.
- Never stored in cache or analysis.
- Never included in errors.
- If config looks like it contains a token, refuse to run.

### 8.2 API calls

- `GET /repos/{owner}/{repo}/commits` — bulk author logins.
- `GET /repos/{owner}/{repo}/commits/{sha}/pulls` — PRs for a squash commit.
- `GET /repos/{owner}/{repo}/pulls/{n}/commits` — underlying PR commits (250 limit).
- `GET /repos/{owner}/{repo}/commits/{sha}` — per-commit stats.
- `GET /repos/{owner}/{repo}/pulls/{n}/reviews`.
- `GET /repos/{owner}/{repo}/pulls/{n}/comments`.
- `GET /repos/{owner}/{repo}/issues/comments`.
- `GET /rate_limit` — doctor.

### 8.3 Caching and rate limits

- Cache key: hash of URL.
- Store response body + ETag only.
- Send `If-None-Match`; treat `304 Not Modified` as a cache hit.
- Retry `403`/`429` with `Retry-After` and `X-RateLimit-Reset`, exponential backoff, jitter.
- Requests are sequential, so the “max 4 concurrent” limit is trivially respected.
- If quota is exhausted, stop with a clear message.

### 8.4 What PR metrics cover

PR metrics are collected for PRs linked from squash containers, not every PR in the repository. This keeps API use proportional and grounded in git history.

Per member: PRs authored, merged, reviews (approved/changes requested/commented), inline comments, issue comments, self-approvals.

Without enrichment, `pr` is `null` and reports say “not collected”.

---

## 9. Outputs, redaction, and student view

### 9.1 `analysis.json`

The complete machine-readable result. Contains:

- `schemaVersion`, tool version, generation time (unless `--no-timestamp`);
- config summary (no secrets);
- teams, repos, members, metrics, flags, warnings, evidence;
- `unattributed`, `excluded`, totals;
- unresolved identities;
- PR metrics or `null`.

Because it contains emails, it is sensitive. `--no-timestamp` plus sorted keys and rounded numbers makes identical inputs produce byte-identical JSON.

### 9.2 Markdown

One file per team. Human review order:

1. “Evidence for human review. This is not a grade.”
2. method summary;
3. member table;
4. composite section if enabled;
5. unattributed/excluded summary;
6. PR data status;
7. flags;
8. evidence lists (capped at 25 per metric);
9. unresolved identities;
10. instructor notes;
11. limitations.

Table cells escape pipes, backticks, angle brackets, and newlines. Raw HTML is not rendered.

### 9.3 HTML

One self-contained file per team:

- inline CSS;
- inline SVG weekly bars;
- no external assets;
- no scripts;
- print-friendly;
- every user-controlled value escaped.

### 9.4 CSV

One row per member per team. Flat metrics, including commit/churn/surviving shares and optional composite columns. No grade column. Cells starting with `=`, `+`, `-`, `@`, tab, or CR get a leading apostrophe to prevent spreadsheet formula injection.

### 9.5 Redaction

`--redact` replaces emails (and email-shaped strings in messages/evidence) with stable hash-based pseudonyms such as `email-3a1f9c2b`. The same address gets the same pseudonym in every format and every run.

### 9.6 Student view

`contribcheck explain <member> --view student` shows:

- that member’s metrics and shares;
- that member’s flags;
- that member’s evidence;
- anonymized team totals and unattributed totals.

It never shows other members’ individual numbers or any email addresses.

### 9.7 Instructor notes

`adjustments.yaml` entries are displayed under “Instructor notes” but **never** change computed numbers. This keeps human context visible without silently adjusting the data.

---

## 10. Security and privacy model

### 10.1 What is untrusted

- commit messages;
- author names and emails;
- branch names;
- file paths;
- repository paths;
- roster names;
- PR data from GitHub.

### 10.2 Defenses

| Threat | Defense |
|---|---|
| ANSI/control characters in terminal output | `stripControl()` |
| HTML injection (`<script>`) | `escapeHtml()` |
| Markdown table breakage | escape pipes/backticks/angles/newlines |
| CSV formula injection | apostrophe prefix |
| Token leakage | env-only, sanitized errors, never cached |
| Repo modification | read-only git commands; only opt-in `fetch --unshallow` |
| Accidental output inside a repo | refusal unless `--allow-in-repo` |
| Cache inside a repo | cache moved to OS temp when config is inside a repo |
| Shell injection | `execFile`/`spawn` with argument arrays, never `shell: true` |

### 10.3 Privacy

- No telemetry.
- No network except `api.github.com` with enrichment.
- No server or database.
- Data stays in local files.
- `analysis.json` is sensitive; delete it when done (`purge --yes`).
- Student privacy laws may apply (FERPA in the US, GDPR/UK GDPR in the EU/UK); see `docs/RESPONSIBLE-USE.md`. This is not legal advice.

### 10.4 Responsible use

- Tell students what is measured before the project.
- Never use the composite alone.
- Review every flag with the student.
- Give students the student view.
- Remember that design, documentation, research, testing, and in-person pairing are underrepresented.
- Delete analyses when grades are final.

---

## 11. How it behaves on different machines

This is the part most likely to cause “works on my machine” surprises.

### 11.1 Operating systems

| Area | Windows | Linux | macOS |
|---|---|---|---|
| Path separator | `\` | `/` | `/` |
| Case sensitivity | usually insensitive | sensitive | usually insensitive |
| Shell used by npm scripts | `cmd.exe` by default | `/bin/sh` | `/bin/sh` |
| Executable bit | not meaningful | matters | matters |
| `bin` shims | `.cmd`, `.ps1` | symlink/script | symlink/script |
| Line endings | CRLF often | LF | LF |
| File locking | stricter | looser | looser |
| Long paths | can hit limits | usually fine | usually fine |

The code uses Node’s `path` module and normalizes glob paths to `/`. Tests explicitly cover repository paths with spaces.

### 11.2 Line endings (CRLF vs LF)

Git can store LF while checking out CRLF (`core.autocrlf`). This tool:

- normalizes commit messages before parsing trailers;
- sets `core.autocrlf=false` in test fixtures;
- treats whitespace-only changes as formatting estimates.

A mass line-ending conversion can look like formatting churn. That is a known limitation, not a bug.

### 11.3 npm scripts and shells

npm runs scripts through a platform shell (`cmd.exe` on Windows, `/bin/sh` on Unix). Scripts should therefore avoid bash-only syntax.

This package’s scripts use only:

- `tsc`;
- `vitest run`;
- `node`;
- `&&`.

Those work in cmd, PowerShell (through npm), and bash. The demo generator is a Node `.mjs` script, so it also avoids shell differences.

### 11.4 Git version

Git 2.23+ is required for `blame --ignore-revs-file`. The tool checks the version at scan/doctor startup and fails clearly if it is older. Some commands and behaviors differ subtly across Git versions; the minimum is chosen to match the feature used.

### 11.5 Node version

Requires Node 22+ because it uses modern built-ins (`fetch`, `node:readline/promises`, modern `Intl`). `engines` warns consumers. CI tests Node 22 and 24.

### 11.6 Concurrent scans

The cache is written with ordinary file writes. Running two scans against the same cache at the same time could race. The tool is designed for one scan at a time per config.

### 11.7 Temporary directories

Tests create real repositories under the OS temp directory. Windows sometimes holds file handles longer, so cleanup can occasionally need a retry; the tests remove their temp trees after each case.

### 11.8 Terminal differences

ANSI colors and control sequences differ by terminal. All terminal-facing output passes through control-character stripping, so a malicious commit subject cannot reprogram the terminal.

### 11.9 Case-only renames

On case-insensitive filesystems, `File.txt` → `file.txt` may not behave like a rename the way it does on Linux. Git sees what the filesystem reports.

---

## 12. Tests and CI

### 12.1 Why Vitest

Vitest runs TypeScript tests quickly, supports ESM, and has a simple assertion API.

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc
```

Tests import `src/*.ts` directly. They do **not** require `dist/` to exist, so `npm test` works before `npm run build`.

### 12.2 The fixture approach

`tests/helpers.ts` creates **real git repositories** in temporary directories. It sets:

- author/committer names and emails;
- fixed dates;
- `commit.gpgsign=false`;
- `core.autocrlf=false`.

This avoids mocking git, which would hide real behavior.

### 12.3 What the tests cover

| File | Focus |
|---|---|
| `attribution.test.ts` | co-author splits, squash shares, bots, identity resolution, trailer parsing |
| `scan.test.ts` | totals reconciliation, duplicates, exclusions, formatting, deadlines, blame, merges, renames, empty repos, paths with spaces, composite, notes, GitHub squash mock |
| `security.test.ts` | HTML escaping, CSV injection, token leakage, repo immutability, control characters, redaction, student view |
| `shallow.test.ts` | shallow clone detection and strict exit code |
| `misc.test.ts` | determinism and GitHub client pagination/ETag/rate-limit/token safety |

### 12.4 No network, no wall clock

- GitHub tests inject a fake `fetch`.
- Scan tests inject a fake fetch and a fake token.
- Commit dates are fixed.
- The demo generator is not part of the test suite’s clock-sensitive logic.

### 12.5 Determinism test

The same repository scanned twice with `--no-timestamp` must produce byte-identical `analysis.json`. This catches accidental ordering, timestamps, or floating-point drift.

### 12.6 CI

`.github/workflows/ci.yml` runs on:

- Node 22 and 24;
- `ubuntu-latest` and `windows-latest`.

Steps: `npm ci` → typecheck → test → build → `npm pack --dry-run`.

Locally, everything has been run on Windows. The Linux jobs are configured but were not executed in this environment.

### 12.7 Scale benchmark (not a unit test)

The repository includes `scripts/benchmark-scan.mjs`:

```bash
npm run build
npm run benchmark -- 200
npm run benchmark -- 500
```

It creates a synthetic repository with 20 files and N commits, then times a full scan and a `--skip-blame` scan.

Measured on Windows (Node 23.5, Git 2.47, warm machine):

| Commits | Full scan | Skip-blame scan |
|---|---|---|
| 200 | ~5.5 s | ~2.1 s |
| 500 | ~7.4 s | ~3.1 s |

Before batching git calls, the same 200-commit case took ~84 s. The fix was to:

- compute patch-ids for a whole repository in two git processes instead of two per commit;
- compute normal and whitespace-insensitive numstat in two processes per repository;
- check `linguist-*` attributes once per repository;
- index commits by SHA for blame lookups instead of scanning an array per line.

This is a **benchmark**, not a pass/fail scalability gate. It does not cover 10k+ commits, giant binary diffs, thousands of files, or multi-gigabyte repositories. Treat the numbers as a characterization, not a guarantee.

---

## 13. Publishing this package, step by step

> The package is currently **not published**. These are the steps when you decide to publish.

### 13.1 Preflight

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Check the file list. You should see `dist/`, `README.md`, `docs/`, `CHANGELOG.md`, `LICENSE`, and `package.json`. You should **not** see `src/`, `tests/`, `node_modules/`, or demo outputs.

### 13.2 Test the tarball

```bash
npm pack
mkdir /tmp/contribcheck-install-test
cd /tmp/contribcheck-install-test
npm init -y
npm install /path/to/contribcheck-0.1.0.tgz
npx contribcheck --help
```

If this fails, do not publish.

### 13.3 Version and changelog

- Update `version` in `package.json`.
- Update `CHANGELOG.md`.
- Commit both.
- Tag the release if you use tags: `git tag v0.1.0`.

### 13.4 Log in and publish

```bash
npm login
npm publish
```

For a scoped package:

```bash
npm publish --access public
```

If 2FA is enabled, npm asks for a one-time code.

### 13.5 `prepublishOnly` runs automatically

Before upload, npm runs:

```text
typecheck → test → build
```

If any step fails, publishing stops. That is intentional.

### 13.6 After publishing

```bash
npm view contribcheck version
mkdir /tmp/check && cd /tmp/check
npm init -y
npm install contribcheck
npx contribcheck --help
```

### 13.7 Things to know

- Published versions are effectively permanent. Avoid publishing secrets or accidental files.
- `files` is a whitelist; it is safer than a long `.npmignore`.
- `README.md` becomes the registry page.
- The `repository`, `homepage`, and `bugs` fields are optional but improve the package page and trust.
- Provenance/attestations can be enabled in CI for supply-chain transparency.

### 13.8 Common publish errors

| Error | Likely cause |
|---|---|
| `E404` | Not logged in, wrong registry, or package name unavailable. |
| `E403` | No permission, 2FA required, or name owned by someone else. |
| `EPUBLISHCONFLICT` | That version already exists. Bump the version. |
| `prepublishOnly` failure | Typecheck/test/build failed; fix before retrying. |
| Missing `dist` | Build did not run or `files` excludes it. |

---

## 14. Troubleshooting and FAQ

### “`contribcheck` is not recognized”

- Use `npx contribcheck`, or
- run `node dist/cli.js`, or
- ensure `npm install` created `node_modules/.bin/`, or
- check that `dist/cli.js` exists (`npm run build`).

### “Cannot find module … /dist/index.js”

Run `npm run build`. A fresh clone has no `dist/` because it is gitignored.

### “No commits found”

- Is the configured `ref` correct?
- Is the repository shallow?
- Are commits on another branch and `includeUnmerged` false?
- Is the repository actually a git repo?
- Does the roster team name match the config team?

### “Everyone has low share / no activity”

- Check identity resolution: emails may not match the roster.
- Check the ref. A repo sitting on an old branch can hide work.
- Check squash merges. Without GitHub data, co-authors from the PR are lost.
- Check exclusions. Generated/lockfile-only work is intentionally not counted.

### “Why is `unattributed` so high?”

Unresolved identities. Add the missing emails or GitHub logins to `roster.csv`, or fix `.mailmap`. The `identities` command lists them.

### “Why is my name missing?”

- Commit email not in roster.
- Commit authored by a bot address.
- Commit is a merge/duplicate/excluded SHA.
- Name-only co-author trailer has no email/login.
- Work is only on an unmerged branch and `includeUnmerged` is false.

### “Why is surviving lines zero?”

- `--skip-blame` was used.
- The ref has no text files after exclusions.
- Blame failed (shallow clone, binary files, missing history).
- The member’s commits were excluded.

### “GitHub enrichment says 401/403”

- Token missing or expired.
- Token lacks access to a private repo.
- Rate limit exhausted.
- Config accidentally contains a token (the tool refuses).
- `origin` is not a GitHub URL.

### “Output path refused”

The output would be inside an analyzed repository. Choose another path, or pass `--allow-in-repo` if you really mean it.

### “Cache seems stale”

Delete `.contribcheck/` or run `contribcheck purge --yes`. The cache is an optimization, not the source of truth.

### “Why does `analysis.json` contain emails?”

It is the complete evidence file. Reports can be redacted; the source analysis is sensitive. Delete it when no longer needed.

### “Is this an AI grader?”

No. No LLM, no scoring model, no automatic grade. It produces evidence for a human.

### “Does it rank people?”

No. It reports metrics and flags. Ranking is a human/social decision the tool deliberately does not make.

### “Does it modify my repositories?”

No normal command does. It only reads. The single exception is `git fetch --unshallow`, and only with `--unshallow`.

### “Why does it need Git 2.23?”

`git blame --ignore-revs-file` requires it.

### “Does it work offline?”

Yes, except `--github`. Local scans use only git.

### “Can I use it on one repo for one person?”

Yes. A team can have one member and one repo. It is designed for teams, but the model does not require many members.

### “Can I run it in CI?”

Yes. It writes files and exits with meaningful codes. Make sure the CI checkout has enough history (`fetch-depth: 0`) or expect `SHALLOW_CLONE`.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **ANSI escape** | Special terminal control sequence used for colors/cursor movement; stripped from output. |
| **API** | Application Programming Interface; the functions/types a library exposes. |
| **bin** | `package.json` field that creates terminal commands. |
| **blame** | Git feature that attributes each line to the last commit that touched it. |
| **branch** | Movable pointer to a commit. |
| **cache** | Stored results to avoid repeated work/API calls. |
| **churn** | Added + deleted lines. |
| **CI** | Continuous Integration; automated checks on push/PR. |
| **commit** | Immutable snapshot plus metadata and parents. |
| **composite** | Optional weighted combination of shares; off by default. |
| **CRLF/LF** | Windows vs Unix line-ending conventions. |
| **CSV injection** | Spreadsheet formula attack via cells starting with `=`, `+`, `-`, `@`. |
| **dependency** | Package needed at runtime. |
| **devDependency** | Package needed only for development/testing/building. |
| **deterministic** | Same input → same output, byte for byte. |
| **dist** | Built output directory. |
| **ETag** | HTTP validator used for conditional requests and 304 cache hits. |
| **ESM** | ECMAScript modules (`import`/`export`). |
| **evidence** | SHAs, paths, PR numbers, counts, or blame lines supporting a metric/flag. |
| **excluded** | Bucket for commits/lines intentionally not credited. |
| **exports map** | `package.json` field defining what consumers may import. |
| **fixture** | Test setup that creates a known repository/state. |
| **flag** | A review prompt with code, severity, message, evidence. |
| **glob** | Pattern like `docs/**` used to match paths. |
| **HEAD** | Current checkout pointer. |
| **IANA timezone** | Named timezone like `Asia/Kolkata`. |
| **ISO week** | Week numbering `YYYY-Www` used for weekly buckets. |
| **lockfile** | Exact dependency receipt (`package-lock.json`). |
| **mailmap** | Git file mapping old identities to canonical ones. |
| **merge commit** | Commit with 2+ parents; excluded from credit. |
| **module** | A single importable file. |
| **node_modules** | Installed dependency folder. |
| **npm** | Package manager + registry. |
| **npx** | Run a package binary, installing temporarily if needed. |
| **numstat** | Machine-readable diff stats (added/deleted per file). |
| **package** | Folder with `package.json`, publishable to npm. |
| **patch-id** | Hash of a commit’s diff, used to detect cherry-picks/rebase duplicates. |
| **pseudonym** | Stable fake identifier used by `--redact`. |
| **rate limit** | API request quota. |
| **redaction** | Replacing sensitive values with pseudonyms. |
| **ref** | Named pointer to a commit. |
| **registry** | Server storing npm packages. |
| **remote** | Another copy of a repo, usually `origin`. |
| **SHA** | Content-addressed commit ID. |
| **share** | Fraction of a commit/metric owned by a member. |
| **shallow clone** | Clone with truncated history. |
| **shebang** | `#!` line telling the OS how to run a script. |
| **squash merge** | Combine PR commits into one commit. |
| **submodule** | Pointer to another repository at a commit. |
| **surviving line** | Line present at the team ref, attributed by blame. |
| **tarball** | `.tgz` package archive created by `npm pack`. |
| **transitive dependency** | Dependency of a dependency. |
| **unattributed** | Bucket for unresolved identities. |
| **zod** | TypeScript schema validation library used for config. |

---

## 16. The demo, explained

`npm run demo` creates `examples/demo/repos/team-alpha` with three members: Alice, Bob, Carol.

It includes:

- a starter skeleton;
- a co-authored commit (Alice + Bob);
- a lockfile change (excluded);
- a bot commit (excluded);
- a whitespace reformat (formatting estimate);
- a squash-merged feature (`(#17)`);
- a cherry-pick with a different author (`DUPLICATE_PATCH`);
- a large generated docs commit (`LARGE_COMMIT`);
- an unresolved author (Sam Helper);
- a late/future commit (`POST_DEADLINE_WORK`, `DATE_ANOMALY`);
- an empty commit (activity, zero churn).

The demo produces 7 flag codes and demonstrates the main behaviors without needing GitHub.

---

## 17. Two-minute explanation you can give

> contribcheck is a TypeScript CLI and npm library that reads local git repositories and produces an evidence report about team contributions. It solves the problem that normal git stats mislead: squash merges hide co-authors, lockfiles and generated files inflate churn, bots look like people, and deleted code counts the same as code that survived. It walks the team ref, deduplicates across repos, resolves identities through mailmap and roster emails, and sends every commit through one attribution function. That function decides shares for co-authors, squash merges, bots, and unresolved identities, and all metrics use those shares. It separates meaningful churn from formatting-only churn, uses git blame for surviving lines, and emits JSON plus Markdown, HTML, and CSV reports with flags and evidence. It is read-only, offline by default, never guesses identities, and never produces a grade or ranking. GitHub PR data is optional and token-based.

---

## 18. Cheat sheet

```bash
# Setup
npm install
npm run build

# Quality
npm run typecheck
npm test
npm run build
npm pack --dry-run

# Demo
npm run demo
cd examples/demo
node ../../dist/cli.js scan
node ../../dist/cli.js report --format md,html,csv,json
node ../../dist/cli.js explain alice --view student --format md

# Real team
npx contribcheck init
npx contribcheck doctor
npx contribcheck scan
npx contribcheck report --format md,html,csv
npx contribcheck identities
npx contribcheck explain <memberId> --view instructor
npx contribcheck purge --yes
```

Useful files:

| Path | What it is |
|---|---|
| `src/` | TypeScript source |
| `dist/` | built output (generated) |
| `tests/` | Vitest tests and fixtures |
| `docs/` | method, schema, limitations, decisions, responsible use |
| `examples/demo/` | demo config/roster |
| `scripts/make-demo-repo.mjs` | deterministic demo generator |
| `.github/workflows/ci.yml` | CI matrix |

That is the whole system: a validated input layer, a read-only git data layer, one credit function, an aggregation/reporting layer, and a small CLI/library surface around it.
