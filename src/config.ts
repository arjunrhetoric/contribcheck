import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parse as csvParse } from "csv-parse/sync";
import type { AppConfig, RosterMember } from "./types.js";

const compositeSchema = z.object({
  enabled: z.boolean().default(false),
  weights: z.object({
    commits: z.number().default(0.2),
    churn: z.number().default(0.3),
    survivingLines: z.number().default(0.5),
  }).default({ commits: 0.2, churn: 0.3, survivingLines: 0.5 }),
}).default({ enabled: false, weights: { commits: 0.2, churn: 0.3, survivingLines: 0.5 } });

const teamSchema = z.object({
  deadline: z.string(),
  graceMinutes: z.number().default(0),
  ref: z.string().optional(),
  repos: z.array(z.string()).min(1),
});

const configSchema = z.object({
  timezone: z.string().min(1),
  courseStart: z.string().optional(),
  includeUnmerged: z.boolean().default(false),
  excludePaths: z.array(z.string()).default([]),
  excludeCommits: z.array(z.string()).default([]),
  bots: z.array(z.string()).default([]),
  coAuthorCredit: z.enum(["equal", "none"]).default("equal"),
  composite: compositeSchema,
  thresholds: z.object({
    lowShare: z.number().default(0.5),
    largeCommitLines: z.number().default(2000),
    largeCommitFiles: z.number().default(50),
  }).default({ lowShare: 0.5, largeCommitLines: 2000, largeCommitFiles: 50 }),
  areas: z.record(z.string()).default({}),
  github: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  teams: z.record(teamSchema),
});

export function formatZodError(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function loadConfig(configPath: string, overrides?: { out?: string }): AppConfig {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) throw new Error(`Config not found: ${abs} (code 2)`);
  const raw = fs.readFileSync(abs, "utf8");
  let data: unknown;
  try {
    data = parse(raw);
  } catch (e) {
    const err = new Error(`Invalid YAML in ${abs}: ${(e as Error).message}`);
    (err as unknown as { code: number }).code = 2;
    throw err;
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) {
    const msg = formatZodError(parsed.error);
    const err = new Error(`Invalid config ${abs}: ${msg}`);
    (err as unknown as { code: number }).code = 2;
    throw err;
  }
  const v = parsed.data;
  // Validate timezone
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v.timezone });
  } catch {
    const err = new Error(`Invalid config: timezone: unknown IANA timezone "${v.timezone}"`);
    (err as unknown as { code: number }).code = 2;
    throw err;
  }
  const configDir = path.dirname(abs);
  const outDir = overrides?.out ? path.resolve(overrides.out) : path.join(configDir, "contribcheck-out");
  const teams: AppConfig["teams"] = {};
  for (const [id, t] of Object.entries(v.teams)) {
    teams[id] = {
      deadline: t.deadline,
      graceMinutes: t.graceMinutes ?? 0,
      ref: t.ref,
      repos: t.repos.map((r) => path.resolve(configDir, r)),
    };
  }
  return {
    timezone: v.timezone,
    courseStart: v.courseStart,
    includeUnmerged: v.includeUnmerged ?? false,
    excludePaths: v.excludePaths ?? [],
    excludeCommits: (v.excludeCommits ?? []).map((s) => String(s).toLowerCase()),
    bots: v.bots ?? [],
    coAuthorCredit: v.coAuthorCredit ?? "equal",
    composite: v.composite as AppConfig["composite"],
    thresholds: v.thresholds as AppConfig["thresholds"],
    areas: v.areas ?? {},
    github: v.github ?? { enabled: false },
    teams,
    __configDir: configDir,
    __configPath: abs,
    __outDir: outDir,
  };
}

export function loadRoster(rosterPath: string, config: AppConfig): RosterMember[] {
  const abs = path.resolve(rosterPath);
  if (!fs.existsSync(abs)) {
    const err = new Error(`Roster not found: ${abs}`);
    (err as unknown as { code: number }).code = 2;
    throw err;
  }
  const raw = fs.readFileSync(abs, "utf8");
  let records: Record<string, string>[];
  try {
    records = csvParse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
  } catch (e) {
    const err = new Error(`Invalid roster CSV: ${(e as Error).message}`);
    (err as unknown as { code: number }).code = 2;
    throw err;
  }
  const required = ["team", "member_id", "name", "emails", "github"];
  // header check: allow missing github column? Spec says columns team,member_id,name,emails,github. Require first 4.
  const members: RosterMember[] = [];
  const seenIds = new Set<string>();
  const emailOwner = new Map<string, string>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const line = `roster.csv row ${i + 2}`;
    const team = (r["team"] ?? "").trim();
    const member_id = (r["member_id"] ?? "").trim();
    const name = (r["name"] ?? "").trim();
    const emailsRaw = (r["emails"] ?? "").trim();
    const github = (r["github"] ?? "").trim();
    if (!team || !member_id || !name) {
      const err = new Error(`Invalid roster at ${line}: team, member_id, name are required`);
      (err as unknown as { code: number }).code = 2;
      throw err;
    }
    if (seenIds.has(member_id)) {
      const err = new Error(`Invalid roster at ${line}: duplicate member_id "${member_id}"`);
      (err as unknown as { code: number }).code = 2;
      throw err;
    }
    seenIds.add(member_id);
    const emails = emailsRaw ? emailsRaw.split(";").map((e) => e.trim()).filter(Boolean) : [];
    if (emails.length === 0 && !github) {
      const err = new Error(`Invalid roster at ${line}: member "${member_id}" needs at least one email or a GitHub login`);
      (err as unknown as { code: number }).code = 2;
      throw err;
    }
    for (const e of emails) {
      const k = e.toLowerCase();
      if (emailOwner.has(k)) {
        const err = new Error(`Invalid roster at ${line}: email "${e}" belongs to two members ("${emailOwner.get(k)}" and "${member_id}")`);
        (err as unknown as { code: number }).code = 2;
        throw err;
      }
      emailOwner.set(k, member_id);
    }
    if (!(team in config.teams)) {
      const err = new Error(`Invalid roster at ${line}: team "${team}" does not exist in config`);
      (err as unknown as { code: number }).code = 2;
      throw err;
    }
    members.push({ team, member_id, name, emails, github: github || undefined });
  }
  void required;
  return members;
}

export function detectTokenInConfig(configPath: string): void {
  const raw = fs.readFileSync(path.resolve(configPath), "utf8");
  // ghp_, gho_, github_pat_, gh token pattern
  if (/(ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh_[A-Za-z0-9]{10,})/.test(raw)) {
    const err = new Error("Refusing to run: config file appears to contain a GitHub token. Keep tokens in GITHUB_TOKEN/GH_TOKEN only.");
    (err as unknown as { code: number }).code = 2;
    throw err;
  }
}
