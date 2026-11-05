#!/usr/bin/env node
// Generates a deterministic three-member demo git repository for contribcheck.
// Plain .mjs so it runs with `node scripts/make-demo-repo.mjs`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const demoDir = path.join(root, "examples", "demo");
const repoDir = path.join(demoDir, "repos", "team-alpha");

function git(args, env) {
  return execFileSync(
    "git",
    ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd: repoDir, env: { ...process.env, ...(env ?? {}) }, encoding: "utf8", windowsHide: true },
  ).trim();
}

function write(file, content) {
  const p = path.join(repoDir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function commit(message, { name, email, date, body } = {}) {
  git(["add", "-A"]);
  const full = message + (body ? "\n\n" + body : "");
  git(["commit", "-m", full], {
    GIT_AUTHOR_NAME: name ?? "Demo",
    GIT_AUTHOR_EMAIL: email ?? "demo@example.com",
    GIT_COMMITTER_NAME: name ?? "Demo",
    GIT_COMMITTER_EMAIL: email ?? "demo@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(["rev-parse", "HEAD"]);
}

if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
fs.mkdirSync(repoDir, { recursive: true });
git(["init", "-b", "main"]);

const alice = { name: "Alice", email: "alice@example.com" };
const bob = { name: "Bob", email: "bob@example.com" };
const carol = { name: "Carol", email: "carol@example.com" };

// Starter-style base
write("README.md", "# Demo team project\n\nA tiny app used to demo contribcheck.\n");
commit("Initial project skeleton", { ...alice, date: "2026-08-05T09:00:00+05:30" });

// Alice builds the backend
write("src/server.js", Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i};   `).join("\n") + "\n");
commit("Add request handler", { ...alice, date: "2026-08-12T11:00:00+05:30" });

// Bob + Alice pair on validation (co-authored)
write("src/validate.js", "export function validate(input) {\n  return typeof input === 'object' && input !== null;\n}\n");
commit("Add input validation", {
  ...alice,
  date: "2026-08-20T14:30:00+05:30",
  body: "Co-authored-by: Bob <bob@example.com>",
});

// Carol does frontend
write("apps/web/index.html", "<!doctype html>\n<html><body><h1>Demo</h1></body></html>\n");
commit("Add frontend shell", { ...carol, date: "2026-08-25T10:15:00+05:30" });

// Lockfile churn from everyone (should be excluded)
write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "demo" } } }, null, 2));
commit("Update lockfile", { ...bob, date: "2026-08-28T16:00:00+05:30" });

// Dependency bot (excluded)
write(".github/workflows/ci.yml", "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n");
commit("chore(deps): bump actions/checkout", {
  name: "dependabot[bot]",
  email: "49699333+dependabot[bot]@users.noreply.github.com",
  date: "2026-09-01T00:00:00+05:30",
});

// Whitespace reformat (formatting-only churn)
const formatted = Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
write("src/server.js", formatted);
commit("Reformat server.js", { ...bob, date: "2026-09-05T09:30:00+05:30" });

// Carol feature branch that will be squash-merged
git(["checkout", "-b", "feature/report"]);
write("src/report.js", "export function report(rows) {\n  return rows.map((r) => r.id).join(',');\n}\n");
commit("Add report builder", { ...carol, date: "2026-10-02T13:00:00+05:30" });
write("src/report.css", ".report { display: grid; }\n");
commit("Style report builder", { ...carol, date: "2026-10-04T13:00:00+05:30" });
git(["checkout", "main"]);
write("src/report-notes.md", "Notes for the report feature.\n");
commit("Add report notes", { ...carol, date: "2026-10-03T13:00:00+05:30" });
git(["merge", "--squash", "feature/report"]);
const squash = commit("Add report builder (#17)", { ...carol, date: "2026-10-10T12:00:00+05:30" });
void squash;

// A feature-branch commit, cherry-picked onto main under a different author:
// same patch-id, two authors -> both counted and DUPLICATE_PATCH raised.
git(["checkout", "-b", "feature/util"]);
write("src/util.js", "export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n");
const utilSha = commit("Add util helpers", { ...alice, date: "2026-10-15T10:00:00+05:30" });
git(["checkout", "main"]);
git(["cherry-pick", utilSha]);
git(["commit", "--amend", "--author=Bob <bob@example.com>", "--no-edit"], {
  GIT_AUTHOR_DATE: "2026-10-16T10:00:00+05:30",
  GIT_COMMITTER_DATE: "2026-10-16T10:00:00+05:30",
});

// Large generated-ish commit by Bob (large commit flag)
write("docs/generated/api.md", Array.from({ length: 120 }, (_, i) => `### Endpoint ${i}\n\nGenerated documentation line ${i}.`).join("\n\n") + "\n");
commit("Generate API docs", { ...carol, date: "2026-10-20T15:20:00+05:30" });

// Late commit (after deadline 2026-11-15T23:59+05:30)
write("src/late.js", "export const lateFix = true;\n");
commit("Late fix after deadline", { ...carol, date: "2026-11-17T01:30:00+05:30" });

// Unresolved identity: a commit by someone not on the roster
write("notes/scratch.md", "scratch notes\n");
commit("Add scratch notes", { name: "Sam Helper", email: "sam.helper@nowhere.test", date: "2026-10-25T09:00:00+05:30" });

// An empty commit counts as activity but has zero churn
git(["commit", "--allow-empty", "-m", "Kick CI"], {
  GIT_AUTHOR_NAME: "Alice",
  GIT_AUTHOR_EMAIL: "alice@example.com",
  GIT_COMMITTER_NAME: "Alice",
  GIT_COMMITTER_EMAIL: "alice@example.com",
  GIT_AUTHOR_DATE: "2026-10-27T08:00:00+05:30",
  GIT_COMMITTER_DATE: "2026-10-27T08:00:00+05:30",
});

fs.writeFileSync(
  path.join(demoDir, "contribcheck.yaml"),
  `# Demo config for contribcheck. Repos are relative to this file.
timezone: Asia/Kolkata
courseStart: "2026-08-01"
includeUnmerged: true
excludePaths: []
excludeCommits: []
bots: []
coAuthorCredit: equal
composite:
  enabled: true
  weights: { commits: 0.2, churn: 0.3, survivingLines: 0.5 }
thresholds:
  lowShare: 0.5
  largeCommitLines: 200
  largeCommitFiles: 40
areas:
  frontend: "apps/web/**"
  backend: "src/**"
github:
  enabled: false
teams:
  team-alpha:
    deadline: "2026-11-15T23:59:00+05:30"
    graceMinutes: 0
    ref: main
    repos:
      - repos/team-alpha
`,
);

fs.writeFileSync(
  path.join(demoDir, "roster.csv"),
  `team,member_id,name,emails,github
team-alpha,alice,Alice,alice@example.com,alice-gh
team-alpha,bob,Bob,bob@example.com,bob-gh
team-alpha,carol,Carol,carol@example.com,carol-gh
`,
);

console.log(`demo repo written to ${repoDir}`);
console.log("next: cd examples/demo && node ../../dist/cli.js scan");
