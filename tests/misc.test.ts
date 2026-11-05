import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { initRepo, commitFile, writeConfig, mkTemp } from "./helpers.js";
import { scan } from "../src/index.js";
import { GitHubClient } from "../src/github.js";

let tmp = "";
beforeEach(() => { tmp = mkTemp("cc-det-"); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("determinism", () => {
  it("same input with --no-timestamp is byte-identical", async () => {
    const repo = initRepo(path.join(tmp, "repo"));
    commitFile(repo, "a.txt", "x\n", { name: "Alice", email: "alice@example.com", date: "2026-09-01T10:00:00+05:30", message: "one" });
    commitFile(repo, "b.txt", "y\n", { name: "Bob", email: "bob@example.com", date: "2026-09-02T10:00:00+05:30", message: "two" });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [repo]);
    await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    const a = fs.readFileSync(path.join(outDir, "analysis.json"));
    const out2 = path.join(tmp, "out2");
    await scan({ configPath, rosterPath, out: out2, noTimestamp: true, quiet: true });
    const b = fs.readFileSync(path.join(out2, "analysis.json"));
    expect(a.equals(b)).toBe(true);
  });
});

describe("github client", () => {
  it("pagination, ETag 304, rate-limit retry, no token in errors", async () => {
    const dir = path.join(tmp, "cache");
    process.env["GITHUB_TOKEN"] = "secret-token-xyz";
    try {
      // pagination
      let calls = 0;
      const pagFetch = (async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify([{ sha: "a" }]), { status: 200, headers: { link: '<https://api.github.com/x?page=2>; rel="next"', etag: '"e1"' } });
        }
        return new Response(JSON.stringify([{ sha: "b" }]), { status: 200 });
      }) as unknown as typeof fetch;
      const c1 = new GitHubClient({ dir: path.join(dir, "c1"), fetchFn: pagFetch });
      const pages = await c1.paginated<{ sha: string }>("https://api.github.com/repos/o/r/commits");
      expect(pages).toHaveLength(2);

      // ETag 304
      const d2 = path.join(dir, "c2");
      let n = 0;
      const fake304 = { status: 304, ok: false, headers: new Headers({}), text: async () => "" } as unknown as Response;
      const etagFetch = (async () => {
        n++;
        if (n === 1) return new Response(JSON.stringify({ v: 1 }), { status: 200, headers: { etag: '"abc"' } });
        return fake304;
      }) as unknown as typeof fetch;
      const c2 = new GitHubClient({ dir: d2, fetchFn: etagFetch });
      const r1 = await c2.request("https://api.github.com/thing");
      expect(r1.fromCache).toBe(false);
      const r2 = await c2.request("https://api.github.com/thing");
      expect(r2.fromCache).toBe(true);
      expect(r2.body).toContain("v");

      // rate-limit retry then success
      let m = 0;
      const rlFetch = (async () => {
        m++;
        if (m === 1) return new Response("limited", { status: 429, headers: { "retry-after": "0" } });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch;
      const c3 = new GitHubClient({ dir: path.join(dir, "c3"), fetchFn: rlFetch });
      const r3 = await c3.request("https://api.github.com/rl");
      expect(r3.status).toBe(200);

      // no token in errors
      const badFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
      const c4 = new GitHubClient({ dir: path.join(dir, "c4"), fetchFn: badFetch });
      await expect(c4.request("https://api.github.com/bad")).rejects.toThrow(/bad/);
      try {
        await c4.request("https://api.github.com/bad");
      } catch (e) {
        expect(String((e as Error).message)).not.toContain("secret-token-xyz");
      }
    } finally {
      delete process.env["GITHUB_TOKEN"];
    }
  });
});
