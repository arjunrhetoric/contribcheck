import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_COMMITTER_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", ["-c", "user.name=Tmp", "-c", "user.email=tmp@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV, ...(env ?? {}) },
    encoding: "utf8",
    windowsHide: true,
  });
}

export function initRepo(dir: string, branch = "main"): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", branch]);
  return dir;
}

export interface CommitOpts {
  name?: string;
  email?: string;
  date?: string;
  message?: string;
  body?: string;
}

export function commitFile(repo: string, file: string, content: string | Buffer, opts?: CommitOpts): string {
  const fp = path.join(repo, file);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  git(repo, ["add", "-A"]);
  const msg = (opts?.message ?? "commit") + (opts?.body ? "\n\n" + opts.body : "");
  const env: Record<string, string> = {};
  if (opts?.name) { env.GIT_AUTHOR_NAME = opts.name; env.GIT_COMMITTER_NAME = opts.name; }
  if (opts?.email) { env.GIT_AUTHOR_EMAIL = opts.email; env.GIT_COMMITTER_EMAIL = opts.email; }
  if (opts?.date) { env.GIT_AUTHOR_DATE = opts.date; env.GIT_COMMITTER_DATE = opts.date; }
  git(repo, ["commit", "-m", msg], env);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function commitAll(repo: string, opts?: CommitOpts): string {
  git(repo, ["add", "-A"]);
  const msg = (opts?.message ?? "commit") + (opts?.body ? "\n\n" + opts.body : "");
  const env: Record<string, string> = {};
  if (opts?.name) { env.GIT_AUTHOR_NAME = opts.name; env.GIT_COMMITTER_NAME = opts.name; }
  if (opts?.email) { env.GIT_AUTHOR_EMAIL = opts.email; env.GIT_COMMITTER_EMAIL = opts.email; }
  if (opts?.date) { env.GIT_AUTHOR_DATE = opts.date; env.GIT_COMMITTER_DATE = opts.date; }
  git(repo, ["commit", "-m", msg], env);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function writeConfig(dir: string, repos: string[], extra?: Record<string, unknown>): { configPath: string; rosterPath: string; outDir: string } {
  const outDir = path.join(dir, "out");
  const config = {
    timezone: "Asia/Kolkata",
    courseStart: "2026-08-01",
    includeUnmerged: false,
    excludePaths: [],
    excludeCommits: [],
    bots: [],
    coAuthorCredit: "equal",
    composite: { enabled: false, weights: { commits: 0.2, churn: 0.3, survivingLines: 0.5 } },
    thresholds: { lowShare: 0.5, largeCommitLines: 2000, largeCommitFiles: 50 },
    areas: {},
    github: { enabled: false },
    teams: {
      "team-alpha": {
        deadline: "2026-11-15T23:59:00+05:30",
        graceMinutes: 0,
        ref: "main",
        repos,
      },
    },
    ...(extra ?? {}),
  };
  const configPath = path.join(dir, "contribcheck.yaml");
  fs.writeFileSync(configPath, toYaml(config));
  const rosterPath = path.join(dir, "roster.csv");
  fs.writeFileSync(rosterPath, "team,member_id,name,emails,github\nteam-alpha,alice,Alice,alice@example.com,alice-gh\nteam-alpha,bob,Bob,bob@example.com,bob-gh\n");
  return { configPath, rosterPath, outDir };
}

function toYaml(o: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (o === null || o === undefined) return "null\n";
  if (typeof o === "string") return JSON.stringify(o) + "\n";
  if (typeof o === "number" || typeof o === "boolean") return String(o) + "\n";
  if (Array.isArray(o)) {
    if (o.length === 0) return "[]\n";
    return o.map((v) => `${pad}- ${toYaml(v, indent + 1).trimStart()}`).join("");
  }
  const entries = Object.entries(o as Record<string, unknown>);
  if (entries.length === 0) return "{}\n";
  return entries.map(([k, v]) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
    }
    return `${pad}${k}: ${(typeof v === "object" ? JSON.stringify(v) : toYaml(v, 0)).trimEnd()}\n`;
  }).join("");
}

export function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function branch(repo: string, name: string, from?: string): void {
  git(repo, ["checkout", "-b", name, ...(from ? [from] : [])]);
}

export function merge(repo: string, from: string, opts?: { noFf?: boolean; message?: string }): void {
  git(repo, ["merge", ...(opts?.noFf ? ["--no-ff"] : []), "-m", opts?.message ?? `merge ${from}`, from]);
}

export function cherryPick(repo: string, sha: string, author?: { name: string; email: string }): void {
  git(repo, ["cherry-pick", sha]);
  if (author) git(repo, ["commit", "--amend", `--author=${author.name} <${author.email}>`, "--no-edit"]);
}

export function renameFile(repo: string, from: string, to: string, opts?: CommitOpts): string {
  git(repo, ["mv", from, to]);
  return commitAll(repo, opts);
}

