import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { git, initRepo, commitFile, writeConfig, mkTemp } from "./helpers.js";
import { scan } from "../src/index.js";
import { renderHtml, renderMarkdown, renderReport, renderExplain, renderCsv } from "../src/report.js";
import { stripControl } from "../src/util.js";

let tmp = "";
beforeEach(() => { tmp = mkTemp("cc-sec-"); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("security", () => {
  it("HTML report escapes <script> in subjects and names", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "<script>alert(1)</script>", email: "evil@nowhere.test", date: "2026-09-01T10:00:00+05:30", message: "<script>alert(2)</script>" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const html = renderHtml(analysis)["team-alpha"]!;
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("CSV formula-like cells are prefixed", () => {
    const cell = (renderCsv as unknown as { _?: unknown });
    void cell;
    // build minimal analysis
    const analysis = {
      schemaVersion: 1, toolVersion: "0.1.0", configSummary: { timezone: "UTC", includeUnmerged: false, coAuthorCredit: "equal", compositeEnabled: false, teamIds: ["t"] },
      teams: [{
        teamId: "t", deadline: null, ref: "main", repos: [], unresolvedIdentities: [], flags: [], warnings: [], evidence: {}, prCollected: false,
        unattributed: { commits: 0, churnAdded: 0, churnDeleted: 0, churnTotal: 0, survivingLines: 0 },
        excluded: { commits: 0, churnAdded: 0, churnDeleted: 0, churnTotal: 0, survivingLines: 0 },
        totals: { commits: 1, churnAdded: 1, churnDeleted: 0, churnTotal: 1, survivingLines: 1 },
        members: [{
          memberId: "=2+5", name: "+cmd", commits: 1, churnAdded: 1, churnDeleted: 0, churnTotal: 1,
          formattingLines: 0, survivingLines: 1, areas: {}, filesTouched: 1, activeDays: 1, weeklyCommits: {},
          postDeadlineCommits: 0, finalWindowShare: null, pairCommits: 0, pr: null,
          shares: { commits: 1, churn: 1, survivingLines: 1 }, composite: null,
        }],
      }],
    } as never;
    const csv = renderCsv(analysis);
    expect(csv).toContain("'=2+5");
    expect(csv).toContain("'+cmd");
  });

  it("fake token never appears in analysis, cache, reports or logs", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    try { git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]); } catch { /* ignore */ }
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: "2026-09-01T10:00:00+05:30", message: "init" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo], { github: { enabled: true } });
    const token = "ghp_faketokenABC123XYZ456";
    process.env["GITHUB_TOKEN"] = token;
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    const logs: string[] = [];
    const origLog = console.log;
    (console as unknown as { log: (...a: string[]) => void }).log = (...a: string[]) => { logs.push(a.join(" ")); };
    try {
      await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: false, github: true });
    } finally {
      console.log = origLog;
      globalThis.fetch = realFetch;
      delete process.env["GITHUB_TOKEN"];
    }
    const analysisRaw = fs.readFileSync(path.join(outDir, "analysis.json"), "utf8");
    expect(analysisRaw).not.toContain(token);
    for (const l of logs) expect(l).not.toContain(token);
    // cache dir
    const cacheDir = path.join(tmp, ".contribcheck");
    if (fs.existsSync(cacheDir)) {
      const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
      for (const f of walk(cacheDir)) {
        expect(fs.readFileSync(f, "utf8")).not.toContain(token);
      }
    }
  });

  it("scan leaves repo unchanged", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: "2026-09-01T10:00:00+05:30", message: "init" });
    const headBefore = git(repo, ["rev-parse", "HEAD"]).trim();
    const statusBefore = git(repo, ["status", "--porcelain"]).trim();
    const refsBefore = git(repo, ["for-each-ref"]).trim();
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(repo, ["status", "--porcelain"]).trim()).toBe(statusBefore);
    expect(git(repo, ["for-each-ref"]).trim()).toBe(refsBefore);
  });

  it("control characters stripped from terminal output", () => {
    expect(stripControl("\x1b[31mhello\x1b[0m\x00\x07world")).toBe("helloworld");
  });

  it("redacts emails in every report format and keeps the student view private", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: "2026-09-01T10:00:00+05:30", message: "init" });
    commitFile(repo, "b.txt", "y\n", { name: "Ghost", email: "ghost@nowhere.test", date: "2026-09-02T10:00:00+05:30", message: "ghost" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const json = renderReport(analysis, "json", { redact: true }) as string;
    expect(json).not.toContain("ghost@nowhere.test");
    expect(json).toContain("email-");
    const md = renderMarkdown(analysis, { redact: true })["team-alpha"]!;
    expect(md).not.toContain("ghost@nowhere.test");
    const html = renderHtml(analysis, { redact: true })["team-alpha"]!;
    expect(html).not.toContain("ghost@nowhere.test");
    const student = renderExplain(analysis, "alice", "student", undefined, "md");
    expect(student).not.toContain("bob@example.com");
    expect(student).not.toContain("Ghost");
  });

  it("config containing token-like string refuses to run", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: "2026-09-01T10:00:00+05:30", message: "init" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    fs.appendFileSync(configPath, "\n# ghp_abcdefghij1234567890abcdefghij12\n");
    await expect(scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true })).rejects.toThrow(/token/i);
  });
});
