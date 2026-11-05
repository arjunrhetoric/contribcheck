#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadRoster } from "./config.js";
import { checkGitVersion, gitExec, isShallow } from "./git.js";
import { loadAnalysis, scan } from "./scan.js";
import { renderExplain, writeReports, type ReportFormat } from "./report.js";
import { stripControl } from "./util.js";
import { GitHubClient } from "./github.js";

const program = new Command();
program.name("contribcheck").description("Explainable, auditable contribution breakdown from local git repositories").version("0.1.0");
program.option("--json", "machine-readable results");
program.option("--quiet", "quiet output");
program.option("--verbose", "verbose output");
program.option("--no-color", "disable color");

function exitCode(e: unknown): number {
  const code = (e as { code?: number })?.code;
  if (code === 2 || code === 3) return code;
  const msg = (e as Error)?.message ?? "";
  if (/invalid config|invalid roster|not found|refus/i.test(msg)) return 2;
  return 1;
}

function handleErr(e: unknown, opts: { json?: boolean }): void {
  const msg = stripControl((e as Error)?.message ?? String(e));
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(msg);
  process.exit(exitCode(e));
}

program.command("init").description("write contribcheck.yaml, roster.csv and adjustments.yaml templates").action((...args: unknown[]) => {
  const opts = program.opts() as { json?: boolean };
  try {
    const dir = process.cwd();
    const yaml = `timezone: Asia/Kolkata
courseStart: "2026-08-01"
includeUnmerged: false
excludePaths: ["docs/generated/**"]
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
areas:
  frontend: "apps/web/**"
  backend: "apps/api/**"
github:
  enabled: false
teams:
  team-alpha:
    deadline: "2026-11-15T23:59:00+05:30"
    graceMinutes: 0
    ref: main
    repos:
      - ../clones/alpha-frontend
`;
    const roster = `team,member_id,name,emails,github
team-alpha,alice,Alice,alice@example.com,alice-gh
team-alpha,bob,Bob,bob@example.com,bob-gh
`;
    const adj = `# adjustments: visible notes only; they never change computed numbers.
# adjustments:
#   - memberId: alice
#     team: team-alpha
#     note: "Presented the demo in class."
`;
    if (!fs.existsSync(path.join(dir, "contribcheck.yaml"))) fs.writeFileSync(path.join(dir, "contribcheck.yaml"), yaml);
    if (!fs.existsSync(path.join(dir, "roster.csv"))) fs.writeFileSync(path.join(dir, "roster.csv"), roster);
    if (!fs.existsSync(path.join(dir, "adjustments.yaml"))) fs.writeFileSync(path.join(dir, "adjustments.yaml"), adj);
    const next = "Wrote templates. Next: edit contribcheck.yaml + roster.csv, then run: contribcheck doctor && contribcheck scan";
    if (opts.json) console.log(JSON.stringify({ ok: true, next }));
    else console.log(stripControl(next));
  } catch (e) { handleErr(e, program.opts()); }
});

program.command("doctor").description("check git version, config, roster, shallow status, token").option("--config <p>", "config path", "contribcheck.yaml").option("--roster <p>", "roster path", "roster.csv").action(async (cmdOpts: { config: string; roster: string }) => {
  const opts = { ...program.opts(), ...cmdOpts } as { json?: boolean; config: string; roster: string };
  try {
    await checkGitVersion();
    const config = loadConfig(cmdOpts.config);
    const roster = loadRoster(cmdOpts.roster, config);
    const shallow: Record<string, boolean> = {};
    for (const t of Object.values(config.teams)) for (const r of t.repos) {
      if (fs.existsSync(r)) shallow[r] = await isShallow(r);
    }
    let rate: unknown = "not checked";
    if (config.github.enabled) {
      const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
      if (!token) rate = "no token (set GITHUB_TOKEN or GH_TOKEN)";
      else {
        try { rate = await new GitHubClient({ dir: path.join(config.__configDir, ".contribcheck", "cache") }).rateLimit(); }
        catch (e) { rate = `rate-limit check failed: ${stripControl((e as Error).message).slice(0, 120)}`; }
      }
    }
    const result = { ok: true, git: "ok", teams: Object.keys(config.teams), members: roster.length, shallow, rateLimit: rate };
    if (opts.json) console.log(JSON.stringify(result));
    else console.log(stripControl(`doctor ok: git ok, ${result.teams.length} team(s), ${roster.length} member(s)`));
  } catch (e) { handleErr(e, program.opts()); }
});

program.command("scan").description("scan repositories and write analysis.json")
  .option("--config <p>", "config path", "contribcheck.yaml")
  .option("--roster <p>", "roster path (default: roster.csv next to the config)")
  .option("--team <t>", "only this team")
  .option("--out <d>", "output directory")
  .option("--github", "enable GitHub enrichment")
  .option("--include-unmerged", "count unmerged branches")
  .option("--skip-blame", "skip blame")
  .option("--strict", "strict exit codes")
  .option("--unshallow", "fetch --unshallow first")
  .option("--no-timestamp", "omit generatedAt")
  .option("--allow-in-repo", "allow output inside a repo")
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = program.opts() as Record<string, unknown>;
    try {
      const res = await scan({
        configPath: (cmdOpts["config"] as string) ?? "contribcheck.yaml",
        rosterPath: (cmdOpts["roster"] as string) ?? "roster.csv",
        team: cmdOpts["team"] as string | undefined,
        out: cmdOpts["out"] as string | undefined,
        github: (cmdOpts["github"] as boolean) ?? undefined,
        includeUnmerged: (cmdOpts["includeUnmerged"] as boolean) ?? undefined,
        skipBlame: (cmdOpts["skipBlame"] as boolean) ?? false,
        strict: (cmdOpts["strict"] as boolean) ?? false,
        unshallow: (cmdOpts["unshallow"] as boolean) ?? false,
        noTimestamp: (cmdOpts["timestamp"] as boolean) === false ? true : false,
        allowInRepo: (cmdOpts["allowInRepo"] as boolean) ?? false,
        quiet: (g["quiet"] as boolean) ?? false,
        verbose: (g["verbose"] as boolean) ?? false,
      });
      if (g["json"]) console.log(JSON.stringify({ ok: true, out: res.outDir, analysis: res.analysisPath }));
      else if (!g["quiet"]) console.log(stripControl(`wrote ${res.analysisPath}`));
    } catch (e) { handleErr(e, program.opts() as { json?: boolean }); }
  });

program.command("identities").description("list unresolved identities").option("--analysis <p>", "analysis path").action(async (cmdOpts: { analysis?: string }) => {
  try {
    const p = cmdOpts.analysis ?? path.join(process.cwd(), "contribcheck-out", "analysis.json");
    const a = await loadAnalysis(p);
    if ((program.opts() as { json?: boolean }).json) {
      console.log(JSON.stringify(Object.fromEntries(a.teams.map((t) => [t.teamId, t.unresolvedIdentities]))));
      return;
    }
    for (const t of a.teams) {
      console.log(stripControl(`team ${t.teamId}: ${t.unresolvedIdentities.length} unresolved`));
      for (const u of t.unresolvedIdentities) console.log(stripControl(`  ${u.name} <${u.email}> x${u.commitCount} sample ${u.sampleSha}${u.suggestion ? ` ~ ${u.suggestion}` : ""}`));
    }
  } catch (e) { handleErr(e, program.opts()); }
});

program.command("report").description("render human reports from analysis.json")
  .option("--analysis <p>", "analysis path")
  .option("--config <p>", "config path (for instructor notes)", "contribcheck.yaml")
  .option("--format <f>", "comma list md,html,csv,json", "md")
  .option("--out <d>", "output directory")
  .option("--redact", "pseudonymize emails/logins")
  .action(async (cmdOpts: { analysis?: string; config: string; format: string; out?: string; redact?: boolean }) => {
    try {
      const ap = cmdOpts.analysis ?? path.join(process.cwd(), "contribcheck-out", "analysis.json");
      const a = await loadAnalysis(ap);
      const formats = cmdOpts.format.split(",").map((s) => s.trim()).filter(Boolean) as ReportFormat[];
      const allowed: ReportFormat[] = ["md", "html", "csv", "json"];
      for (const f of formats) {
        if (!allowed.includes(f)) {
          const err = new Error(`Unknown report format "${f}". Use md, html, csv, json.`);
          (err as unknown as { code: number }).code = 2;
          throw err;
        }
      }
      const out = cmdOpts.out ?? path.join(path.dirname(path.resolve(ap)), "reports");
      const cfgPath = path.resolve(cmdOpts.config);
      const configDir = fs.existsSync(cfgPath) ? path.dirname(cfgPath) : path.dirname(path.resolve(ap));
      const written = writeReports(a, formats, out, { redact: cmdOpts.redact, configDir });
      if ((program.opts() as { json?: boolean }).json) console.log(JSON.stringify({ ok: true, files: written }));
      else console.log(stripControl(`wrote ${written.length} file(s) to ${out}`));
    } catch (e) { handleErr(e, program.opts()); }
  });

program.command("explain <memberId>").description("explain one member").option("--team <t>").option("--view <v>", "instructor|student", "instructor").option("--format <f>", "md|json", "md").option("--analysis <p>").option("--config <p>", "config path (for instructor notes)", "contribcheck.yaml").action(async (memberId: string, cmdOpts: { team?: string; view: string; format: string; analysis?: string; config: string }) => {
  try {
    const ap = cmdOpts.analysis ?? path.join(process.cwd(), "contribcheck-out", "analysis.json");
    const a = await loadAnalysis(ap);
    const cfgPath = path.resolve(cmdOpts.config);
    const configDir = fs.existsSync(cfgPath) ? path.dirname(cfgPath) : undefined;
    const out = renderExplain(a, memberId, cmdOpts.view as "instructor" | "student", cmdOpts.team, cmdOpts.format as "md" | "json", { configDir });
    console.log(cmdOpts.format === "json" ? out : stripControl(out));
  } catch (e) { handleErr(e, program.opts()); }
});

program.command("purge").description("delete .contribcheck/ and output directory").option("--yes", "skip confirmation").option("--config <p>", "config path", "contribcheck.yaml").action(async (cmdOpts: { yes?: boolean; config: string }) => {
  try {
    const config = loadConfig(cmdOpts.config);
    if (!cmdOpts.yes) {
      const readline = await import("node:readline/promises");
      if (!process.stdin.isTTY) {
        console.error("Refusing to purge without --yes (non-interactive).");
        process.exit(1);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Delete .contribcheck/ and ${config.__outDir}? [y/N] `);
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log("purge cancelled.");
        return;
      }
    }
    fs.rmSync(path.join(config.__configDir, ".contribcheck"), { recursive: true, force: true });
    fs.rmSync(config.__outDir, { recursive: true, force: true });
    console.log(stripControl("purged."));
  } catch (e) { handleErr(e, program.opts()); }
});

// default --help works via commander
program.parseAsync(process.argv).catch((e) => handleErr(e, program.opts()));
