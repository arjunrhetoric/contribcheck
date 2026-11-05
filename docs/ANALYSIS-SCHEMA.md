# Analysis schema (`schemaVersion: 1`)

`analysis.json` is the single source of truth. Reports are rendered from it. All field names are stable for schema version 1; new optional fields may be added without a version bump, but removing or changing meaning requires a new `schemaVersion`.

All timestamps are ISO 8601 strings. Git author dates are self-reported; treat them accordingly. Numbers are rounded to four decimals in JSON. The file may contain emails, so it is sensitive.

## Top level

```ts
interface Analysis {
  schemaVersion: 1;
  toolVersion: string;          // "0.1.0"
  generatedAt?: string;         // omitted with --no-timestamp
  configSummary: {
    timezone: string;
    courseStart?: string;
    includeUnmerged: boolean;
    coAuthorCredit: "equal" | "none";
    compositeEnabled: boolean;
    teamIds: string[];          // sorted
  };
  teams: TeamAnalysis[];        // sorted by teamId
  __?                          // no secrets, no tokens, ever
}
```

## Team

```ts
interface TeamAnalysis {
  teamId: string;
  deadline: string | null;      // as written in config
  ref: string;                  // configured ref or "(auto)"
  repos: RepoInfo[];
  members: MemberMetrics[];     // sorted by memberId
  unattributed: BucketMetrics;
  excluded: BucketMetrics & { commits: number };
  totals: BucketMetrics & { commits: number };
  flags: Flag[];
  warnings: string[];
  evidence: Record<string, string[]>;  // full evidence; reports cap at 25
  unresolvedIdentities: UnresolvedIdentity[];
  prCollected: boolean;
}
```

`totals` reconciles exactly:

```
Σ members + unattributed + excluded = totals
```

for commits, churn, and surviving lines (subject to rounding).

## Repository info

```ts
interface RepoInfo {
  path: string;                 // absolute path as configured/resolved
  ref: string;                  // ref resolved for analysis
  refUsed: string;              // includes fallback note when applicable
  headSha: string;              // "" for an empty repo
  shallow: boolean;
  commitsCounted: number;
  commitsSkipped: number;
  submodules: string[];         // listed, never counted
}
```

## Member metrics

```ts
interface MemberMetrics {
  memberId: string;
  name: string;
  commits: number;              // fractional
  churnAdded: number;
  churnDeleted: number;
  churnTotal: number;           // added + deleted, fractional
  churn: { added: number; deleted: number; total: number }; // same values, grouped
  formattingLines: number;      // estimate, not counted
  survivingLines: number;       // fractional blame lines
  areas: Record<string, number>; // churn per configured area
  filesTouched: number;
  activeDays: number;           // distinct calendar days in configured timezone
  weeklyCommits: Record<string, number>; // "YYYY-Www" -> fractional commits
  postDeadlineCommits: number;
  finalWindowShare: number | null; // share of commits in 48h before deadline
  pairCommits: number;
  pr: PrMetrics | null;         // null when enrichment is off
  shares: {
    commits: number | null;     // null when denominator is zero
    churn: number | null;
    survivingLines: number | null;
  };
  composite: {
    value: number;
    formula: string;
    components: Record<string, number | null>;
  } | null;                     // only when composite.enabled
}
```

### PR metrics

```ts
interface PrMetrics {
  authored: number;
  merged: number;
  reviewsApproved: number;
  reviewsChangesRequested: number;
  reviewsCommented: number;
  inlineComments: number;
  issueComments: number;
  selfApproved: number;
}
```

Without `--github`, `pr` is `null` and reports say “not collected”.

### Shares

Internally each share is `{ memberId, share, role, method }`, and squash containers may also carry `commitShare` and `churnShare` because commit counts and churn can be weighted differently. Normal commits use the same weight for every metric. The exported per-member `shares` object contains only the three final ratios.

### Buckets

```ts
interface BucketMetrics {
  commits: number;
  churnAdded: number;
  churnDeleted: number;
  churnTotal: number;
  survivingLines: number;
}
```

`unattributed` holds credit from unresolved identities. `excluded` holds excluded commits and the surviving lines owned by excluded commits.

## Flags

```ts
interface Flag {
  code: string;
  severity: "info" | "review";
  memberId?: string;
  message: string;   // states observation + innocent explanation
  evidence: string[]; // SHAs, paths, PR numbers, counts
}
```

Codes: `LOW_SHARE`, `NO_ACTIVITY`, `NO_DEFAULT_BRANCH_WORK`, `POST_DEADLINE_WORK`, `LARGE_COMMIT`, `SQUASH_UNRESOLVED`, `UNRESOLVED_IDENTITY`, `DATE_ANOMALY`, `DUPLICATE_PATCH`, `FORMATTING_HEAVY`, `SELF_APPROVED`, `SHALLOW_CLONE`, `STARTER_CODE`.

## Unresolved identities

```ts
interface UnresolvedIdentity {
  name: string;
  email: string;
  commitCount: number;
  sampleSha: string;     // short SHA
  suggestion?: string;   // "<memberId> (unverified)" — never assigned
}
```

## Evidence keys

Evidence is keyed by metric, for example:

- `commits:<memberId>` — full SHAs credited to that member;
- `churn:<short-sha>` — per-file `+added/-deleted` lines;
- `excluded` — excluded commit, reason, and sanitized subject;
- `subjects` — sanitized commit subjects (for HTML evidence);
- `churn:<memberId>` / `surviving:<memberId>` when applicable.

Human reports show at most 25 entries per metric. JSON is complete.

## Determinism

With `--no-timestamp`:

- no `generatedAt`;
- object keys sorted recursively;
- arrays sorted by stable keys (teams, members, flags, unresolved identities);
- numbers rounded consistently.

The same inputs must produce byte-identical JSON. A test enforces this.
