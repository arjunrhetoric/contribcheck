export type Role = "primary" | "co-author" | "pr-author" | "excluded" | "unattributed";
export type FlagSeverity = "info" | "review";

export interface Share {
  memberId: string | null;
  share: number;
  role: Role;
  method: string;
  /** Optional per-metric weights (squash containers can differ). Defaults to `share`. */
  commitShare?: number;
  churnShare?: number;
}

export interface TeamConfig {
  deadline: string;
  graceMinutes: number;
  ref?: string;
  repos: string[];
}

export interface CompositeConfig {
  enabled: boolean;
  weights: { commits: number; churn: number; survivingLines: number };
}

export interface AppConfig {
  timezone: string;
  courseStart?: string;
  includeUnmerged: boolean;
  excludePaths: string[];
  excludeCommits: string[];
  bots: string[];
  coAuthorCredit: "equal" | "none";
  composite: CompositeConfig;
  thresholds: { lowShare: number; largeCommitLines: number; largeCommitFiles: number };
  areas: Record<string, string>;
  github: { enabled: boolean };
  teams: Record<string, TeamConfig>;
  __configDir: string;
  __configPath: string;
  __outDir: string;
}

export interface RosterMember {
  team: string;
  member_id: string;
  name: string;
  emails: string[];
  github?: string;
}

export interface PrMetrics {
  authored: number;
  merged: number;
  reviewsApproved: number;
  reviewsChangesRequested: number;
  reviewsCommented: number;
  inlineComments: number;
  issueComments: number;
  selfApproved: number;
}

export interface MemberMetrics {
  memberId: string;
  name: string;
  commits: number;
  churnAdded: number;
  churnDeleted: number;
  churnTotal: number;
  formattingLines: number;
  survivingLines: number;
  areas: Record<string, number>;
  filesTouched: number;
  activeDays: number;
  weeklyCommits: Record<string, number>;
  postDeadlineCommits: number;
  finalWindowShare: number | null;
  pairCommits: number;
  pr: PrMetrics | null;
  shares: { commits: number | null; churn: number | null; survivingLines: number | null };
  composite: { value: number; formula: string; components: Record<string, number | null> } | null;
}

export interface BucketMetrics {
  commits: number;
  churnAdded: number;
  churnDeleted: number;
  churnTotal: number;
  survivingLines: number;
}

export interface RepoInfo {
  path: string;
  ref: string;
  refUsed: string;
  headSha: string;
  shallow: boolean;
  commitsCounted: number;
  commitsSkipped: number;
  submodules: string[];
}

export interface Flag {
  code: string;
  severity: FlagSeverity;
  memberId?: string;
  message: string;
  evidence: string[];
}

export interface UnresolvedIdentity {
  name: string;
  email: string;
  commitCount: number;
  sampleSha: string;
  suggestion?: string;
}

export interface TeamAnalysis {
  teamId: string;
  deadline: string | null;
  ref: string;
  repos: RepoInfo[];
  members: MemberMetrics[];
  unattributed: BucketMetrics;
  excluded: BucketMetrics & { commits: number };
  totals: BucketMetrics & { commits: number };
  flags: Flag[];
  warnings: string[];
  evidence: Record<string, string[]>;
  unresolvedIdentities: UnresolvedIdentity[];
  prCollected: boolean;
}

export interface Analysis {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt?: string;
  configSummary: {
    timezone: string;
    courseStart?: string;
    includeUnmerged: boolean;
    coAuthorCredit: string;
    compositeEnabled: boolean;
    teamIds: string[];
  };
  teams: TeamAnalysis[];
}

export interface ScanOptions {
  configPath: string;
  rosterPath: string;
  team?: string;
  out?: string;
  github?: boolean;
  includeUnmerged?: boolean;
  skipBlame?: boolean;
  strict?: boolean;
  unshallow?: boolean;
  noTimestamp?: boolean;
  allowInRepo?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  subject: string;
  body: string;
  parents: string[];
  refNames: string;
}

export interface AttributedCommit extends CommitInfo {
  onRef: boolean;
  repoPath: string;
  patchId: string;
  isMerge: boolean;
  isEmpty: boolean;
  exclusionReason: string | null;
  shares: Share[];
  churnAdded: number;
  churnDeleted: number;
  churnFiles: number;
  formattingLines: number;
  excludedLinesNote?: string;
  coAuthors: { name: string; email: string }[];
  isSquashCandidate: boolean;
  squashPrNumber: number | null;
  duplicateOf: string | null;
  duplicateFlag: boolean;
  largeFlag: boolean;
  postDeadline: boolean;
  dateAnomaly: string | null;
  files: { path: string; added: number; deleted: number }[];
}
