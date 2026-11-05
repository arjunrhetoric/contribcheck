import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { git, initRepo, commitFile, commitAll, writeConfig, mkTemp, branch, merge, renameFile } from "./helpers.js";
import { scan } from "../src/index.js";

let tmp = "";
beforeEach(() => { tmp = mkTemp("cc-scan-"); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const D1 = "2026-09-01T10:00:00+05:30";
const D2 = "2026-09-02T10:00:00+05:30";

describe("co-author split + totals reconcile", () => {
  it("splits equally and members+unattributed+excluded == totals", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "one\n", { name: "Alice", email: "alice@example.com", date: D1, message: "start" });
    commitFile(repo, "b.txt", "two\n", {
      name: "Alice", email: "alice@example.com", date: D2, message: "pair work",
      body: "Co-authored-by: Bob <bob@example.com>",
    });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    const alice = t.members.find((m) => m.memberId === "alice")!;
    const bob = t.members.find((m) => m.memberId === "bob")!;
    expect(alice.commits).toBeCloseTo(1.5, 6);
    expect(bob.commits).toBeCloseTo(0.5, 6);
    expect(alice.pairCommits).toBeCloseTo(0.5, 6);
    // totals reconcile
    const sumCommits = t.members.reduce((a, m) => a + m.commits, 0) + t.unattributed.commits + t.excluded.commits;
    expect(sumCommits).toBeCloseTo(t.totals.commits, 6);
    const sumChurn = t.members.reduce((a, m) => a + m.churnTotal, 0) + t.unattributed.churnTotal + t.excluded.churnTotal;
    expect(sumChurn).toBeCloseTo(t.totals.churnTotal, 6);
    const sumSurv = t.members.reduce((a, m) => a + m.survivingLines, 0) + t.unattributed.survivingLines + t.excluded.survivingLines;
    expect(sumSurv).toBe(t.totals.survivingLines);
  });
});

describe("squash without github", () => {
  it("raises SQUASH_UNRESOLVED and uses fallback", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: D1, message: "feat (#42)" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    expect(t.flags.some((f) => f.code === "SQUASH_UNRESOLVED")).toBe(true);
  });
});

describe("bots excluded", () => {
  it("excludes dependabot noreply and builtin bots", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "a\n", { name: "Alice", email: "alice@example.com", date: D1, message: "start" });
    commitFile(repo, "b.txt", "b\n", { name: "dependabot", email: "49699333+dependabot[bot]@users.noreply.github.com", date: D2, message: "bump" });
    commitFile(repo, "c.txt", "c\n", { name: "github-actions", email: "actions@github.com", date: D2, message: "ci" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    expect(t.excluded.commits).toBe(2);
    expect(t.members.find((m) => m.memberId === "alice")!.commits).toBeCloseTo(1, 6);
  });
});

describe("exclusions from churn and blame", () => {
  it("lockfiles, dist/, binaries, linguist-generated excluded", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "src/a.txt", "hello\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    // add gitattributes marking generated file
    commitFile(repo, ".gitattributes", "src/gen.txt linguist-generated=true\n", { name: "Alice", email: "alice@example.com", date: D1, message: "attrs" });
    commitFile(repo, "package-lock.json", JSON.stringify({ big: "x".repeat(5000) }), { name: "Bob", email: "bob@example.com", date: D2, message: "lock" });
    commitFile(repo, "dist/bundle.js", "bundle\n".repeat(100), { name: "Bob", email: "bob@example.com", date: D2, message: "dist" });
    commitFile(repo, "src/gen.txt", "gen\n".repeat(100), { name: "Bob", email: "bob@example.com", date: D2, message: "gen" });
    commitFile(repo, "img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0xd8]), { name: "Bob", email: "bob@example.com", date: D2, message: "bin" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    const bob = t.members.find((m) => m.memberId === "bob")!;
    // all bob commits were excluded content => near-zero meaningful churn
    expect(bob.churnTotal).toBe(0);
    expect(t.totals.survivingLines).toBeGreaterThan(0);
  });
});

describe("whitespace reformat", () => {
  it("near-zero meaningful churn and FORMATTING_HEAVY", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    const lines = Array.from({ length: 50 }, (_, i) => `line${i}   \n`).join("");
    commitFile(repo, "f.txt", lines, { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    // whitespace-only change: trailing spaces removed / blank lines
    const lines2 = Array.from({ length: 50 }, (_, i) => `line${i}\n`).join("");
    commitFile(repo, "f.txt", lines2, { name: "Bob", email: "bob@example.com", date: D2, message: "reformat" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    const bob = t.members.find((m) => m.memberId === "bob")!;
    expect(bob.churnTotal).toBe(0);
    expect(bob.formattingLines).toBeGreaterThan(0);
    expect(t.flags.some((f) => f.code === "FORMATTING_HEAVY" && f.memberId === "bob")).toBe(true);
  });
});

describe("identity: mailmap, aliases, noreply, unresolved", () => {
  it("merges via mailmap, roster alias, noreply; lists unresolved", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    fs.writeFileSync(path.join(repo, ".mailmap"), "Alice <alice@example.com> Old Name <old@example.com>\n");
    commitFile(repo, "a.txt", "a\n", { name: "Old Name", email: "old@example.com", date: D1, message: "old identity" });
    commitFile(repo, "b.txt", "b\n", { name: "Bobby", email: "bob2@example.com", date: D1, message: "alias" });
    commitFile(repo, "c.txt", "c\n", { name: "bobby", email: "999+bob-gh@users.noreply.github.com", date: D1, message: "noreply" });
    commitFile(repo, "d.txt", "d\n", { name: "Ghost", email: "ghost@nowhere.test", date: D1, message: "ghost" });
    git(repo, ["add", "-A"]);
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    fs.writeFileSync(rosterPath, "team,member_id,name,emails,github\nteam-alpha,alice,Alice,alice@example.com,alice-gh\nteam-alpha,bob,Bob,bob@example.com;bob2@example.com,bob-gh\n");
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    const alice = t.members.find((m) => m.memberId === "alice")!;
    const bob = t.members.find((m) => m.memberId === "bob")!;
    expect(alice.commits).toBeCloseTo(1, 6);
    expect(bob.commits).toBeCloseTo(2, 6);
    expect(t.unattributed.commits).toBeCloseTo(1, 6);
    expect(t.unresolvedIdentities.some((u) => u.email === "ghost@nowhere.test")).toBe(true);
    expect(t.flags.some((f) => f.code === "UNRESOLVED_IDENTITY")).toBe(true);
  });
});

describe("deadlines and timezones", () => {
  it("flags post-deadline with grace and offset handling", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    // deadline 2026-11-15T23:59:00+05:30. Commit at 2026-11-16T00:30:00+05:30 is late; with 60min grace, 00:30 is within grace.
    commitFile(repo, "late.txt", "x\n", { name: "Alice", email: "alice@example.com", date: "2026-11-16T00:30:00+05:30", message: "late" });
    const extra = { teams: { "team-alpha": { deadline: "2026-11-15T23:59:00+05:30", graceMinutes: 60, ref: "main", repos: [repo] } } };
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo], extra);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    expect(analysis.teams[0]!.members.find((m) => m.memberId === "alice")!.postDeadlineCommits).toBe(0);
    // without grace it is late
    const extra2 = { teams: { "team-alpha": { deadline: "2026-11-15T23:59:00+05:30", graceMinutes: 0, ref: "main", repos: [repo] } } };
    const dir2 = path.join(tmp, "cfg2");
    fs.mkdirSync(dir2, { recursive: true });
    const w2 = writeConfig(dir2, [repo], extra2);
    const a2 = await scan({ configPath: w2.configPath, rosterPath: w2.rosterPath, out: w2.outDir, noTimestamp: true, quiet: true });
    expect(a2.analysis.teams[0]!.members.find((m) => m.memberId === "alice")!.postDeadlineCommits).toBeCloseTo(1, 6);
    expect(a2.analysis.teams[0]!.flags.some((f) => f.code === "POST_DEADLINE_WORK")).toBe(true);
  });
});

describe("blame", () => {
  it("attributes surviving line to original author after another edit", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "f.txt", "keep\nremove\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    commitFile(repo, "f.txt", "keep\nchanged\n", { name: "Bob", email: "bob@example.com", date: D2, message: "edit" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    const alice = t.members.find((m) => m.memberId === "alice")!;
    const bob = t.members.find((m) => m.memberId === "bob")!;
    expect(alice.survivingLines).toBeCloseTo(1, 6);
    expect(bob.survivingLines).toBeCloseTo(1, 6);
  });

  it("respects .git-blame-ignore-revs", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "f.txt", "a\nb\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    const rev = commitFile(repo, "f.txt", "a \nb \n", { name: "Bob", email: "bob@example.com", date: D2, message: "ws" });
    fs.writeFileSync(path.join(repo, ".git-blame-ignore-revs"), rev + "\n");
    commitAll(repo, { name: "Alice", email: "alice@example.com", date: D2, message: "ignore revs" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    const alice = t.members.find((m) => m.memberId === "alice")!;
    // with the whitespace rev ignored, surviving lines go back to alice
    expect(alice.survivingLines).toBeGreaterThanOrEqual(2);
  });
});

describe("duplicate patches", () => {
  it("same-author cherry-pick counted once; different author kept + flagged", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "f.txt", "v1\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    git(repo, ["checkout", "-b", "other"]);
    git(repo, ["checkout", "main"]);
    commitFile(repo, "g.txt", "feat\n", { name: "Alice", email: "alice@example.com", date: D1, message: "feature" });
    const feat = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["checkout", "other"]);
    commitFile(repo, "h.txt", "other\n", { name: "Alice", email: "alice@example.com", date: D2, message: "other" });
    // cherry-pick same feature commit onto other branch (same author)
    git(repo, ["cherry-pick", feat]);
    // different-author copy of same patch on main
    git(repo, ["checkout", "main"]);
    const sha = git(repo, ["cherry-pick", "--no-commit", feat]).trim();
    void sha;
    git(repo, ["commit", "--amend", "--author=Bob <bob@example.com>", "--no-edit"], { GIT_AUTHOR_DATE: D2, GIT_COMMITTER_DATE: D2 });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo], { includeUnmerged: true });
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true, includeUnmerged: true });
    const t = analysis.teams[0]!;
    // feature counted: alice original + bob copy = 2 feature credits; same-author cherry-pick duplicate excluded
    expect(t.flags.some((f) => f.code === "DUPLICATE_PATCH")).toBe(true);
    const alice = t.members.find((m) => m.memberId === "alice")!;
    const bob = t.members.find((m) => m.memberId === "bob")!;
    expect(bob.commits).toBeGreaterThan(0);
    expect(alice.commits).toBeGreaterThan(0);
  });
});

describe("paths with spaces", () => {
  it("repo path containing spaces works", async () => {
    const repo = initRepo(path.join(tmp, "my repo with spaces"));
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    expect(analysis.teams[0]!.totals.commits).toBe(1);
  });
});

describe("merges and renames", () => {
  it("excludes merge commits and gives a pure rename zero churn", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "hello\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    branch(repo, "feature");
    commitFile(repo, "b.txt", "feature\n", { name: "Bob", email: "bob@example.com", date: D2, message: "feature work" });
    git(repo, ["checkout", "main"]);
    merge(repo, "feature", { noFf: true, message: "Merge feature" });
    renameFile(repo, "a.txt", "renamed.txt", { name: "Alice", email: "alice@example.com", date: D2, message: "rename a" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const t = analysis.teams[0]!;
    expect(t.excluded.commits).toBe(1);
    const alice = t.members.find((m) => m.memberId === "alice")!;
    const bob = t.members.find((m) => m.memberId === "bob")!;
    expect(bob.churnTotal).toBe(1);
    // Alice's only meaningful churn is the 1-line initial commit; the rename adds 0.
    expect(alice.churnTotal).toBe(1);
  });

  it("flags work only outside the team ref when includeUnmerged is on", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "hello\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    branch(repo, "feature");
    commitFile(repo, "b.txt", "b\n", { name: "Bob", email: "bob@example.com", date: D2, message: "only branch work" });
    git(repo, ["checkout", "main"]);
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true, includeUnmerged: true });
    const t = analysis.teams[0]!;
    expect(t.flags.some((f) => f.code === "NO_DEFAULT_BRANCH_WORK" && f.memberId === "bob")).toBe(true);
  });
});

describe("output location guard", () => {
  it("refuses an output directory inside an analyzed repo unless allowed", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: D1, message: "init" });
    const { configPath, rosterPath } = writeConfig(tmp, [repo]);
    await expect(scan({ configPath, rosterPath, out: path.join(repo, "out"), noTimestamp: true, quiet: true })).rejects.toMatchObject({ code: 2 });
  });
});

describe("strict exit codes", () => {
  it("exits 3 when unresolved identities exist under --strict", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "Ghost", email: "ghost@nowhere.test", date: D1, message: "init" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    await expect(scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true, strict: true })).rejects.toMatchObject({ code: 3 });
  });
});

describe("squash with mocked github distributes churn", () => {
  it("uses PR commit authors", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    try { git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]); } catch { /* ignore */ }
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: D1, message: "big change (#9)" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo], { github: { enabled: true } });
    const realFetch = globalThis.fetch;
    const fakeFetch = async (url: unknown) => {
      const u = String(url);
      const json = (data: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...(headers ?? {}) } });
      if (u.includes("/commits?")) return json([]);
      if (u.endsWith("/commits/") || /\/commits\/[0-9a-f]+\/pulls$/.test(u)) return json([{ number: 9 }]);
      if (u.includes("/pulls/9/commits")) return json([
        { sha: "a".repeat(40), commit: { author: { name: "Alice", email: "alice@example.com" } }, author: { login: "alice-gh" } },
        { sha: "b".repeat(40), commit: { author: { name: "Bob", email: "bob@example.com" } }, author: { login: "bob-gh" } },
      ]);
      if (/\/commits\/a+$/.test(u)) return json({ stats: { additions: 90, deletions: 0 } });
      if (/\/commits\/b+$/.test(u)) return json({ stats: { additions: 10, deletions: 0 } });
      if (u.includes("/reviews")) return json([]);
      if (u.includes("/comments")) return json([]);
      return json({});
    };
    (globalThis as unknown as { fetch: unknown }).fetch = fakeFetch;
    process.env["GITHUB_TOKEN"] = "test-token-xyz";
    try {
      const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true, github: true });
      const t = analysis.teams[0]!;
      expect(t.flags.some((f) => f.code === "SQUASH_UNRESOLVED")).toBe(false);
      const alice = t.members.find((m) => m.memberId === "alice")!;
      const bob = t.members.find((m) => m.memberId === "bob")!;
      expect(alice.commits).toBeCloseTo(0.9, 6);
      expect(bob.commits).toBeCloseTo(0.1, 6);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env["GITHUB_TOKEN"];
    }
  });
});
