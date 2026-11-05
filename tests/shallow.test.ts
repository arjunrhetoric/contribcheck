import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initRepo, commitFile, writeConfig, mkTemp } from "./helpers.js";
import { scan } from "../src/index.js";

let tmp = "";
beforeEach(() => { tmp = mkTemp("cc-shallow-"); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("shallow clone", () => {
  it("raises SHALLOW_CLONE and --strict exits 2", async () => {
    const src = initRepo(path.join(tmp, "src"));
    commitFile(src, "a.txt", "a\n", { name: "Alice", email: "alice@example.com", date: "2026-09-01T10:00:00+05:30", message: "one" });
    commitFile(src, "b.txt", "b\n", { name: "Alice", email: "alice@example.com", date: "2026-09-02T10:00:00+05:30", message: "two" });
    const cloneDir = path.join(tmp, "clone");
    execFileSync("git", ["clone", "--depth", "1", "--no-local", "--branch", "main", src, cloneDir], { windowsHide: true });
    const { configPath, rosterPath, outDir } = writeConfig(tmp, [cloneDir]);
    const { analysis } = await scan({ configPath, rosterPath, out: outDir, noTimestamp: true, quiet: true });
    expect(analysis.teams[0]!.flags.some((f) => f.code === "SHALLOW_CLONE")).toBe(true);
    const dir2 = path.join(tmp, "o2");
    await expect(scan({ configPath, rosterPath, out: dir2, noTimestamp: true, quiet: true, strict: true })).rejects.toMatchObject({ code: 2 });
  });
});
