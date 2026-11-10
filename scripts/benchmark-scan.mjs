#!/usr/bin/env node
// Reproducible scale smoke benchmark. Requires `npm run build` first.
// Usage: node scripts/benchmark-scan.mjs [commit-count | repo-root commit-count] [--keep]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const first = process.argv[2];
const second = process.argv[3];
const repoRoot = path.resolve(first && !/^\d+$/.test(first) ? first : ".");
const commitCount = Number(/^\d+$/.test(first ?? "") ? first : (second ?? 200));
const keep = process.argv.includes("--keep");

if (!Number.isInteger(commitCount) || commitCount < 1) {
  console.error("commit-count must be a positive integer");
  process.exit(2);
}

const distEntry = path.join(repoRoot, "dist", "index.js");
if (!fs.existsSync(distEntry)) {
  console.error("dist/index.js not found. Run `npm run build` first.");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-bench-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo, { recursive: true });

function git(args, env) {
  return execFileSync(
    "git",
    ["-c", "user.name=Bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd: repo, env: { ...process.env, ...(env ?? {}) }, encoding: "utf8", windowsHide: true },
  ).trim();
}

git(["init", "-b", "main"]);
const buildStart = Date.now();
for (let i = 0; i < commitCount; i++) {
  const who = i % 2 === 0 ? { n: "Alice", e: "alice@example.com" } : { n: "Bob", e: "bob@example.com" };
  const file = `src/file-${i % 20}.js`;
  const body = Array.from({ length: 20 }, (_, j) => `export const v${i}_${j} = ${i * 100 + j};`).join("\n") + "\n";
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), body);
  git(["add", "-A"]);
  git(["commit", "-m", `commit ${i}`], {
    GIT_AUTHOR_NAME: who.n,
    GIT_AUTHOR_EMAIL: who.e,
    GIT_COMMITTER_NAME: who.n,
    GIT_COMMITTER_EMAIL: who.e,
    GIT_AUTHOR_DATE: `2026-09-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00+00:00`,
    GIT_COMMITTER_DATE: `2026-09-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00+00:00`,
  });
}
const buildMs = Date.now() - buildStart;

fs.writeFileSync(path.join(tmp, "contribcheck.yaml"), `timezone: UTC
courseStart: "2026-08-01"
includeUnmerged: false
excludePaths: []
excludeCommits: []
bots: []
coAuthorCredit: equal
composite:
  enabled: false
  weights: { commits: 0.2, churn: 0.3, survivingLines: 0.5 }
thresholds:
  lowShare: 0.5
  largeCommitLines: 2000
  largeCommitFiles: 50
areas: {}
github:
  enabled: false
teams:
  team-bench:
    deadline: "2027-01-01T00:00:00+00:00"
    graceMinutes: 0
    ref: main
    repos:
      - repo
`);
fs.writeFileSync(
  path.join(tmp, "roster.csv"),
  "team,member_id,name,emails,github\nteam-bench,alice,Alice,alice@example.com,alice-gh\nteam-bench,bob,Bob,bob@example.com,bob-gh\n",
);

const { scan } = await import(pathToFileURL(distEntry).href);
const scanStart = Date.now();
const result = await scan({
  configPath: path.join(tmp, "contribcheck.yaml"),
  rosterPath: path.join(tmp, "roster.csv"),
  out: path.join(tmp, "out"),
  noTimestamp: true,
  quiet: true,
});
const fullScanMs = Date.now() - scanStart;

const noBlameStart = Date.now();
await scan({
  configPath: path.join(tmp, "contribcheck.yaml"),
  rosterPath: path.join(tmp, "roster.csv"),
  out: path.join(tmp, "out-noblame"),
  noTimestamp: true,
  quiet: true,
  skipBlame: true,
});
const skipBlameScanMs = Date.now() - noBlameStart;

const team = result.analysis.teams[0];
console.log(JSON.stringify({
  commits: commitCount,
  repoBuildMs: buildMs,
  fullScanMs,
  skipBlameScanMs,
  commitsCounted: team.totals.commits,
  churnTotal: team.totals.churnTotal,
  survivingLines: team.totals.survivingLines,
  analysisBytes: fs.statSync(path.join(tmp, "out", "analysis.json")).size,
  members: team.members.map((m) => ({ id: m.memberId, commits: m.commits, churn: m.churnTotal, surviving: m.survivingLines })),
  tmp: keep ? tmp : "(cleaned)",
}, null, 2));

if (keep) {
  console.log(`kept temporary repository at ${tmp}`);
} else {
  fs.rmSync(tmp, { recursive: true, force: true });
}
