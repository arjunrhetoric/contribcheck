import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parse as yamlParse } from "yaml";
import { checkGitVersion, gitExec, isShallow, repoRootOf } from "./git.js";
import { loadConfig, loadRoster, detectTokenInConfig } from "./config.js";
import { attribute, isBotAddress, parseCoAuthors, resolveIdentity } from "./attribution.js";
import { GitHubClient, parseOriginRemote } from "./github.js";
import { dayKeyInTz, fnv1a, isoWeekInTz, matchesAny, normalizeCRLF, parseDateFlexible, round2, similarNames, stableSort, stripControl } from "./util.js";
import type {
  Analysis, AppConfig, AttributedCommit, CommitInfo, Flag, MemberMetrics, RosterMember, ScanOptions, TeamAnalysis,
} from "./types.js";

export const TOOL_VERSION = "0.1.0";
const SCHEMA_VERSION = 1 as const;

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock",
  "poetry.lock", "Gemfile.lock", "go.sum", "composer.lock",
]);
const EXCLUDED_DIRS = ["node_modules/", "vendor/", "dist/", "build/", ".next/", "coverage/"];

function isBuiltInExcluded(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, "/");
  const base = posix.split("/").pop() ?? posix;
  if (LOCKFILES.has(base)) return true;
  for (const d of EXCLUDED_DIRS) if (posix === d.slice(0, -1) || posix.startsWith(d)) return true;
  if (posix.endsWith(".min.js") || posix.endsWith(".map")) return true;
  return false;
}

function areaFor(filePath: string, areas: Record<string, string>): string | null {
  const posix = filePath.replace(/\\/g, "/");
  for (const [name, pat] of Object.entries(areas)) {
    if (matchesAny(posix, [pat])) return name;
  }
  return null;
}

async function resolveRef(repoPath: string, desired?: string): Promise<{ ref: string; used: string }> {
  if (desired) {
    // verify it exists
    try {
      await gitExec(repoPath, ["rev-parse", "--verify", desired]);
      return { ref: desired, used: desired };
    } catch {
      // try origin/desired
      try {
        await gitExec(repoPath, ["rev-parse", "--verify", `origin/${desired}`]);
        return { ref: `origin/${desired}`, used: `origin/${desired} (fallback for ${desired})` };
      } catch { /* fall through */ }
    }
  }
  // remote default
  try {
    const { stdout } = await gitExec(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const full = stdout.trim(); // refs/remotes/origin/main
    const m = full.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return { ref: m[1], used: `${m[1]} (remote default)` };
  } catch { /* ignore */ }
  for (const cand of ["main", "master"]) {
    try {
      await gitExec(repoPath, ["show-ref", "--verify", `refs/heads/${cand}`]);
      return { ref: cand, used: `${cand} (fallback)` };
    } catch { /* ignore */ }
    try {
      await gitExec(repoPath, ["rev-parse", "--verify", `origin/${cand}`]);
      return { ref: `origin/${cand}`, used: `origin/${cand} (fallback)` };
    } catch { /* ignore */ }
  }
  return { ref: "HEAD", used: "HEAD (fallback)" };
}

interface RawLogCommit extends CommitInfo { mailmapName: string; mailmapEmail: string }

async function getCommits(repoPath: string, ref: string, includeUnmerged: boolean, onRefSet: Set<string>): Promise<RawLogCommit[]> {
  // log format with NUL separators; %x00 field sep, %x1e record sep
  const fmt = "%H%x00%h%x00%aN%x00%aE%x00%aI%x00%cN%x00%cE%x00%P%x00%D%x00%s%x00%b%x1e";
  const args = ["log", "--use-mailmap", "--no-ext-diff", "--no-textconv", `--format=${fmt}`, ref, "--"];
  const { stdout } = await gitExec(repoPath, args);
  const records = stdout.split("\x1e");
  const out: RawLogCommit[] = [];
  for (const rec of records) {
    const r = rec.startsWith("\n") ? rec.slice(1) : rec;
    if (!r.trim()) continue;
    const f = r.split("\x00");
    if (f.length < 11) continue;
    const [sha, shortSha, aN, aE, aI, cN, cE, parents, refNames, subject, body] = f;
    if (!sha) continue;
    out.push({
      sha: sha.trim(), shortSha: shortSha.trim(),
      authorName: normalizeCRLF(aN), authorEmail: aE.trim(), authorDate: aI.trim(),
      committerName: cN, committerEmail: cE.trim(),
      subject: normalizeCRLF(subject), body: normalizeCRLF(body ?? ""),
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      refNames: refNames.trim(),
      mailmapName: normalizeCRLF(aN), mailmapEmail: aE.trim(),
    });
  }
  void onRefSet;
  void includeUnmerged;
  return out;
}

async function getOnRefSet(repoPath: string, ref: string): Promise<Set<string>> {
  try {
    const { stdout } = await gitExec(repoPath, ["rev-list", ref]);
    return new Set(stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function getAllBranchCommits(repoPath: string): Promise<Map<string, RawLogCommit>> {
  const fmt = "%H%x00%h%x00%aN%x00%aE%x00%aI%x00%cN%x00%cE%x00%P%x00%D%x00%s%x00%b%x1e";
  const { stdout } = await gitExec(repoPath, ["log", "--use-mailmap", "--no-ext-diff", "--no-textconv", `--format=${fmt}`, "--all", "--"]);
  const map = new Map<string, RawLogCommit>();
  for (const rec of stdout.split("\x1e")) {
    const r = rec.startsWith("\n") ? rec.slice(1) : rec;
    if (!r.trim()) continue;
    const f = r.split("\x00");
    if (f.length < 11) continue;
    const [sha, shortSha, aN, aE, aI, cN, cE, parents, refNames, subject, body] = f;
    if (!sha?.trim() || map.has(sha.trim())) continue;
    map.set(sha.trim(), {
      sha: sha.trim(), shortSha: shortSha.trim(),
      authorName: normalizeCRLF(aN), authorEmail: aE.trim(), authorDate: aI.trim(),
      committerName: cN, committerEmail: cE.trim(),
      subject: normalizeCRLF(subject), body: normalizeCRLF(body ?? ""),
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      refNames: refNames.trim(),
      mailmapName: normalizeCRLF(aN), mailmapEmail: aE.trim(),
    });
  }
  return map;
}

async function patchIdFor(repoPath: string, sha: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(sha);
  if (hit !== undefined) return hit;
  try {
    const diff = await gitExec(repoPath, ["diff-tree", "--no-commit-id", "--no-ext-diff", "--no-textconv", "-p", "--root", sha]);
    const pid = await gitExec(repoPath, ["patch-id", "--stable"], diff.stdout);
    const id = pid.stdout.trim().split(/\s+/)[0] ?? "";
    cache.set(sha, id);
    return id;
  } catch {
    cache.set(sha, "");
    return "";
  }
}

interface NumstatRow { path: string; newPath?: string; added: number; deleted: number; binary: boolean }

async function numstatFor(repoPath: string, sha: string, extraArgs: string[]): Promise<NumstatRow[]> {
  try {
    const { stdout } = await gitExec(repoPath, ["diff-tree", "--no-commit-id", "--numstat", "-M", "-r", "--no-ext-diff", "--no-textconv", "--root", ...extraArgs, sha]);
    const rows: NumstatRow[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      // format: added\tdeleted\tpath  (or old => new for renames with numstat? shows path with => ?)
      const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);
      if (!m) continue;
      const [, a, d, p] = m;
      if (a === "-" || d === "-") {
        rows.push({ path: p, added: 0, deleted: 0, binary: true });
      } else {
        // handle rename "old => new"
        let fp = p;
        const arrow = p.indexOf(" => ");
        if (arrow >= 0) {
          // formats like "a/{old => new}/f" or "old => new"; take new side
          const parts = p.split(" => ");
          fp = parts[parts.length - 1];
          // strip braces prefix
          const brace = fp.indexOf("}");
          if (p.includes("{") && brace >= 0) {
            const prefix = p.slice(0, p.indexOf("{"));
            fp = prefix + fp;
          }
        }
        rows.push({ path: fp.trim(), added: Number(a) || 0, deleted: Number(d) || 0, binary: false });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function checkAttrBatch(repoPath: string, ref: string, files: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (files.length === 0) return result;
  // git check-attr linguist-generated linguist-vendored <ref> -- files... ; use stdin to avoid arg limits
  try {
    const input = files.map((f) => `${ref}:${f}`).join("\x00");
    void input;
    // Simpler: pass paths directly in chunks
    const chunk = files.slice(0, 500);
    const { stdout } = await gitExec(repoPath, ["check-attr", "linguist-generated", "linguist-vendored", `${ref}`, "--", ...chunk]);
    for (const line of stdout.split("\n")) {
      const m = line.match(/^(.+):\s+(\S+):\s+(\S+)\s*$/);
      if (!m) continue;
      const [, fp, attr, val] = m;
      if ((attr === "linguist-generated" || attr === "linguist-vendored") && (val === "set" || val === "true")) {
        result.set(fp.trim(), true);
      }
    }
  } catch { /* ignore */ }
  return result;
}

async function listSubmodules(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await gitExec(repoPath, ["ls-files", "--stage"]);
    const out: string[] = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(/^160000\s+\S+\s+\S+\t(.+)$/);
      if (m) out.push(m[1]);
    }
    return out;
  } catch {
    return [];
  }
}

export interface ScanResult {
  analysis: Analysis;
  outDir: string;
  analysisPath: string;
}

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  await checkGitVersion();
  const config: AppConfig = loadConfig(opts.configPath, { out: opts.out });
  detectTokenInConfig(path.resolve(opts.configPath));
  const rosterPath = opts.rosterPath ?? path.join(config.__configDir, "roster.csv");
  const roster = loadRoster(rosterPath, config);
  const includeUnmerged = opts.includeUnmerged ?? config.includeUnmerged;
  const githubEnabled = opts.github ?? config.github.enabled;

  // Output dir guard
  const outDir = path.resolve(opts.out ?? config.__outDir);
  if (!opts.allowInRepo) {
    for (const team of Object.values(config.teams)) {
      for (const rp of team.repos) {
        const root = await repoRootOf(rp).catch(() => null);
        const candidates = [rp, root].filter(Boolean) as string[];
        for (const c of candidates) {
          const rel = path.relative(path.resolve(c), outDir);
          if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
            const err = new Error(`Output directory ${outDir} is inside analyzed repository ${c}. Refuse unless --allow-in-repo is passed.`);
            (err as unknown as { code: number }).code = 2;
            throw err;
          }
        }
      }
    }
  }

  const teamFilter = opts.team;
  const teamIds = Object.keys(config.teams).filter((t) => !teamFilter || t === teamFilter);
  if (teamFilter && teamIds.length === 0) {
    const err = new Error(`Unknown team "${teamFilter}"`);
    (err as unknown as { code: number }).code = 2;
    throw err;
  }

  const gh = githubEnabled ? new GitHubClient({ dir: path.join(await cacheDirFor(config), "cache") }) : null;
  if (gh) gh.requireToken();

  const generatedAt = new Date().toISOString();
  const teams: TeamAnalysis[] = [];
  let strictShallow = false;
  let hasUnresolved = false;

  for (const teamId of stableSort(teamIds, (t) => t)) {
    const t = config.teams[teamId]!;
    const teamRoster = roster.filter((m) => m.team === teamId);
    const analysis = await scanTeam(teamId, t, teamRoster, roster, config, {
      includeUnmerged, skipBlame: opts.skipBlame ?? false,
      unshallow: opts.unshallow ?? false, strict: opts.strict ?? false,
      gh, verbose: opts.verbose ?? false,
    });
    teams.push(analysis);
    if (analysis.flags.some((f) => f.code === "SHALLOW_CLONE")) strictShallow = true;
    if (analysis.unresolvedIdentities.length > 0) hasUnresolved = true;
  }

  const analysisObj: Analysis = {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    ...(opts.noTimestamp ? {} : { generatedAt }),
    configSummary: {
      timezone: config.timezone,
      courseStart: config.courseStart,
      includeUnmerged,
      coAuthorCredit: config.coAuthorCredit,
      compositeEnabled: config.composite.enabled,
      teamIds: stableSort(teamIds, (t) => t),
    },
    teams: teams.sort((a, b) => (a.teamId < b.teamId ? -1 : 1)),
  };

  fs.mkdirSync(outDir, { recursive: true });
  const analysisPath = path.join(outDir, "analysis.json");
  const analysisText = stringifyDeterministic(analysisObj) + "\n";
  fs.writeFileSync(analysisPath, analysisText);
  // Working copy under .contribcheck/ unless the config lives inside an analyzed repo
  try {
    const base = await cacheDirFor(config);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "analysis.json"), analysisText);
  } catch { /* cache is best-effort */ }

  if (!opts.quiet) {
    printSummary(analysisObj);
  }

  if (opts.strict && strictShallow) {
    const err = new Error("Shallow clone detected under --strict (exit 2). Analysis written.");
    (err as unknown as { code: number }).code = 2;
    throw err;
  }
  if (opts.strict && hasUnresolved) {
    const err = new Error("Unresolved identities under --strict (exit 3).");
    (err as unknown as { code: number }).code = 3;
    throw err;
  }
  return { analysis: analysisObj, outDir, analysisPath };
}

export function stringifyDeterministic(o: unknown): string {
  return JSON.stringify(sortDeep(o), null, 2);
}

function sortDeep(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(sortDeep);
  if (o && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o as Record<string, unknown>).sort()) {
      out[k] = sortDeep((o as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof o === "number") {
    if (!isFinite(o)) return null;
    return Math.round(o * 10000) / 10000;
  }
  return o;
}

function printSummary(a: Analysis): void {
  for (const t of a.teams) {
    console.log(stripControl(`team ${t.teamId}: ${t.members.length} members, ${t.totals.commits} commits, ${t.totals.churnTotal} churn, ${t.totals.survivingLines} surviving`));
    for (const m of t.members) {
      console.log(stripControl(`  ${m.memberId} ${m.name}: commits=${fmtN(m.commits)} churn=${fmtN(m.churnTotal)} surviving=${fmtN(m.survivingLines)}`));
    }
    for (const f of t.flags) {
      console.log(stripControl(`  flag ${f.code} [${f.severity}]${f.memberId ? " " + f.memberId : ""}: ${f.message}`));
    }
  }
}

function fmtN(n: number): string {
  return String(Math.round(n * 100) / 100);
}

interface TeamScanOpts {
  includeUnmerged: boolean;
  skipBlame: boolean;
  unshallow: boolean;
  strict: boolean;
  gh: GitHubClient | null;
  verbose: boolean;
}

async function cacheDirFor(config: AppConfig): Promise<string> {
  const candidate = path.join(config.__configDir, ".contribcheck");
  for (const team of Object.values(config.teams)) {
    for (const rp of team.repos) {
      const root = await repoRootOf(rp).catch(() => null);
      if (!root) continue;
      const rel = path.relative(path.resolve(root), candidate);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        // Never write caches inside an analyzed working tree.
        return path.join(os.tmpdir(), "contribcheck-cache", fnv1a(config.__configPath));
      }
    }
  }
  return candidate;
}

async function scanTeam(
  teamId: string,
  t: AppConfig["teams"][string],
  teamRoster: RosterMember[],
  _allRoster: RosterMember[],
  config: AppConfig,
  o: TeamScanOpts,
): Promise<TeamAnalysis> {
  const warnings: string[] = [];
  const flags: Flag[] = [];
  const evidence: Record<string, string[]> = {};
  const addEvidence = (k: string, v: string) => {
    if (!evidence[k]) evidence[k] = [];
    if (evidence[k]!.length < 1000 && !evidence[k]!.includes(v)) evidence[k]!.push(v);
  };

  const repos = [];
  const allBySha = new Map<string, { raw: RawLogCommit; repoPath: string; onRef: boolean; repoIdx: number }>();
  const shaRepoPresence = new Map<string, Set<number>>();
  const patchCache = new Map<string, string>();
  let shallowAny = false;

  const deadlineDate = parseDateFlexible(t.deadline);
  const graceMs = (t.graceMinutes ?? 0) * 60 * 1000;
  const deadlineWithGrace = deadlineDate ? new Date(deadlineDate.getTime() + graceMs) : null;
  const courseStartDate = config.courseStart ? parseDateFlexible(config.courseStart) : null;
  const scanNow = new Date();

  for (let repoIdx = 0; repoIdx < t.repos.length; repoIdx++) {
    const repoPath = t.repos[repoIdx]!;
    if (!fs.existsSync(repoPath)) throw new Error(`Repository not found: ${repoPath}`);
    const shallow = await isShallow(repoPath);
    if (shallow) {
      shallowAny = true;
      flags.push({
        code: "SHALLOW_CLONE", severity: "review",
        message: `Repository ${repoPath} is a shallow clone; history and blame are incomplete. Innocent explanation: cloned with --depth to save time or disk.`,
        evidence: [repoPath],
      });
      if (o.unshallow) {
        try {
          await gitExec(repoPath, ["fetch", "--unshallow"]);
        } catch (e) {
          warnings.push(`fetch --unshallow failed for ${repoPath}: ${(e as Error).message}`);
        }
      }
    }
    const { ref, used } = await resolveRef(repoPath, t.ref);
    let headSha = "";
    try {
      headSha = (await gitExec(repoPath, ["rev-parse", ref])).stdout.trim();
    } catch {
      headSha = "";
      warnings.push(`Cannot resolve ref ${ref} in ${repoPath}; producing empty report section.`);
    }
    const submodules = await listSubmodules(repoPath);
    let counted = 0;
    let skipped = 0;
    const onRefSet = headSha ? await getOnRefSet(repoPath, ref).catch(() => new Set<string>()) : new Set<string>();
    let commits: RawLogCommit[] = [];
    if (headSha) {
      try {
        commits = await getCommits(repoPath, ref, o.includeUnmerged, onRefSet);
      } catch {
        commits = [];
      }
      if (o.includeUnmerged) {
        const all = await getAllBranchCommits(repoPath).catch(() => new Map());
        for (const [sha, raw] of all) {
          if (!commits.some((c) => c.sha === sha)) commits.push(raw);
        }
      }
    }
    // empty repo handling
    if (commits.length === 0) warnings.push(`Repository ${repoPath} has no commits reachable from ${ref} (empty or single-commit edge).`);
    if (used.includes("fallback")) warnings.push(`Repository ${repoPath}: requested ref "${t.ref ?? "(default)"}" not found; used ${used}.`);

    for (const raw of commits) {
      const onRef = onRefSet.has(raw.sha);
      if (!o.includeUnmerged && !onRef) {
        skipped++;
        continue;
      }
      const ex = allBySha.get(raw.sha);
      if (!ex) {
        allBySha.set(raw.sha, { raw, repoPath, onRef, repoIdx });
        counted++;
      } else {
        // merge onRef
        ex.onRef = ex.onRef || onRef;
      }
      if (!shaRepoPresence.has(raw.sha)) shaRepoPresence.set(raw.sha, new Set());
      shaRepoPresence.get(raw.sha)!.add(repoIdx);
    }
    repos.push({ path: repoPath, ref, refUsed: used, headSha, shallow, commitsCounted: counted, commitsSkipped: skipped, submodules });
  }

  // GitHub bulk author map
  const apiLoginBySha = new Map<string, string>();
  const prBySquashSha = new Map<string, number>();
  const prCommitsCache = new Map<number, { sha: string; authorLogin: string | null; authorEmail: string; authorName: string; stats?: { additions: number; deletions: number } }[]>();
  let prLimitReached = false;
  const prMetricsByMember = new Map<string, { authored: number; merged: number; reviewsApproved: number; reviewsChangesRequested: number; reviewsCommented: number; inlineComments: number; issueComments: number; selfApproved: number }>();
  const prCollected = o.gh !== null;

  if (o.gh) {
    try {
      for (const r of repos) {
        const origin = await gitExec(r.path, ["remote", "get-url", "origin"]).then((x) => x.stdout.trim()).catch(() => "");
        const parsed = origin ? parseOriginRemote(origin) : null;
        if (!parsed) {
          warnings.push(`GitHub enrichment: cannot parse origin remote "${origin}" in ${r.path}; skipping.`);
          continue;
        }
        const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
        // bulk commits
        try {
          const list = await o.gh.paginated<{ sha: string; author: { login: string } | null }>(`${base}/commits?sha=${encodeURIComponent(r.ref)}`);
          for (const c of list) {
            if (c?.sha && c?.author?.login) apiLoginBySha.set(c.sha.toLowerCase(), c.author.login);
          }
        } catch (e) {
          warnings.push(`GitHub bulk commits failed for ${parsed.owner}/${parsed.repo}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      warnings.push(`GitHub enrichment failed: ${(e as Error).message}`);
    }
  }

  // Build attributed commits
  const attributed: AttributedCommit[] = [];
  const sortedRaw = [...allBySha.values()].sort((a, b) => (a.raw.authorDate < b.raw.authorDate ? -1 : 1));

  // patch ids
  for (const e of sortedRaw) {
    await patchIdFor(e.repoPath, e.raw.sha, patchCache);
  }
  // duplicate detection
  const patchFirst = new Map<string, string>(); // patchId -> first sha (same author grouping handled below)
  const patchAuthorFirst = new Map<string, string>(); // patchId|authorKey -> first sha
  const duplicateOf = new Map<string, string>();

  // need author key: resolved member or email
  const authorKeyFor = (raw: RawLogCommit, repoPath: string): string => {
    void repoPath;
    const login = apiLoginBySha.get(raw.sha.toLowerCase()) ?? null;
    const r = resolveIdentity(raw.mailmapName, raw.mailmapEmail, teamRoster, login);
    return r.memberId ?? `email:${raw.mailmapEmail.toLowerCase()}`;
  };

  for (const e of sortedRaw) {
    const pid = patchCache.get(e.raw.sha) ?? "";
    if (!pid) continue;
    const key = pid + "|" + authorKeyFor(e.raw, e.repoPath);
    if (!patchFirst.has(pid)) patchFirst.set(pid, e.raw.sha);
    if (patchAuthorFirst.has(key)) {
      duplicateOf.set(e.raw.sha, patchAuthorFirst.get(key)!);
    } else {
      patchAuthorFirst.set(key, e.raw.sha);
    }
  }

  const excludeSet = new Set(config.excludePaths);
  void excludeSet;

  for (const e of sortedRaw) {
    const { raw, repoPath, onRef } = e;
    const parents = raw.parents;
    const isMerge = parents.length > 1;
    const subject = raw.subject;
    const squashMatch = subject.match(/\(#(\d+)\)\s*$/);
    const isSquashCandidate = !!squashMatch;
    const squashPrNumber = squashMatch ? Number(squashMatch[1]) : null;
    const coAuthors = parseCoAuthors(raw.body);
    const login = apiLoginBySha.get(raw.sha.toLowerCase()) ?? null;

    // churn computation
    const rows = isMerge ? [] : await numstatFor(repoPath, raw.sha, []);
    const rowsW = isMerge ? [] : await numstatFor(repoPath, raw.sha, ["-w", "--ignore-blank-lines"]);
    const wMap = new Map(rowsW.map((r) => [r.path, r]));
    // linguist attrs for files
    const filePaths = rows.map((r) => r.path);
    const attrMap = await checkAttrBatch(repoPath, raw.sha, filePaths.slice(0, 200));

    let added = 0;
    let deleted = 0;
    let formatting = 0;
    let nFiles = 0;
    const files: AttributedCommit["files"] = [];
    const submoduleList = repos[e.repoIdx]?.submodules ?? [];
    for (const r of rows) {
      const posix = r.path.replace(/\\/g, "/");
      if (submoduleList.includes(r.path) || submoduleList.includes(posix)) continue;
      if (r.binary) continue;
      if (isBuiltInExcluded(posix)) continue;
      if (matchesAny(posix, config.excludePaths)) continue;
      if (attrMap.get(r.path) || attrMap.get(`${raw.sha}:${r.path}`)) continue;
      const w = wMap.get(r.path);
      const wAdd = w && !w.binary ? w.added : 0;
      const wDel = w && !w.binary ? w.deleted : 0;
      const fAdd = Math.max(0, r.added - wAdd);
      const fDel = Math.max(0, r.deleted - wDel);
      formatting += fAdd + fDel;
      const mAdd = r.added - fAdd;
      const mDel = r.deleted - fDel;
      added += mAdd;
      deleted += mDel;
      nFiles++;
      files.push({ path: r.path, added: mAdd, deleted: mDel });
      addEvidence(`churn:${raw.sha.slice(0, 7)}`, `${r.path} +${mAdd}/-${mDel}`);
    }
    const isEmpty = !isMerge && rows.length === 0;
    void isEmpty;

    // exclusion reasons in order
    let exclusionReason: string | null = null;
    if (isMerge) exclusionReason = "merge-commit";
    else if (config.excludeCommits.includes(raw.sha.toLowerCase())) exclusionReason = "excluded-sha";
    else {
      const bot = isBotAddress(raw.mailmapName, raw.mailmapEmail, login, config.bots);
      if (bot) exclusionReason = "bot";
      else {
        // starter code: present in every repo, author not on roster, team has 2+ repos
        const presence = shaRepoPresence.get(raw.sha)?.size ?? 1;
        if (repos.length >= 2 && presence >= repos.length) {
          const rr = resolveIdentity(raw.mailmapName, raw.mailmapEmail, teamRoster, login);
          if (!rr.memberId) {
            exclusionReason = "starter-code";
            flags.push({
              code: "STARTER_CODE", severity: "info",
              message: `Commit ${raw.sha.slice(0, 7)} appears in every repository and is by a non-roster author; treated as starter code. Innocent explanation: instructor template import shared across forks.`,
              evidence: [raw.sha],
            });
          }
        }
      }
    }

    // squash distribution
    let squashDistribution: { memberId: string | null; commits: number; churn: number }[] | null = null;
    if (isSquashCandidate && o.gh && squashPrNumber && !exclusionReason) {
      try {
        // find repo origin for this commit's repo
        const origin = await gitExec(repoPath, ["remote", "get-url", "origin"]).then((x) => x.stdout.trim()).catch(() => "");
        const parsed = origin ? parseOriginRemote(origin) : null;
        if (parsed) {
          const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
          // pulls for sha
          const pullsRes = await o.gh.getJson<{ number: number }[]>(`${base}/commits/${raw.sha}/pulls`);
          const pulls = pullsRes.data ?? [];
          const prNum = pulls.length > 0 ? pulls[0]!.number : squashPrNumber;
          prBySquashSha.set(raw.sha, prNum);
          const prCommitsRes = await o.gh.getJson<{ sha: string; commit: { author: { name: string; email: string } }; author: { login: string } | null }[]>(`${base}/pulls/${prNum}/commits`);
          const prCommits = prCommitsRes.data ?? [];
          if (prCommits.length >= 250) {
            prLimitReached = true;
            warnings.push(`GitHub PR #${prNum} commit listing reached the 250-commit limit; distribution is approximate.`);
          }
          // per-commit stats
          const dist = new Map<string, { memberId: string | null; commits: number; churn: number }>();
          for (const pc of prCommits.slice(0, 250)) {
            const em = pc.commit?.author?.email ?? "";
            const nm = pc.commit?.author?.name ?? "";
            const lg = pc.author?.login ?? null;
            const rr = resolveIdentity(nm, em, teamRoster, lg);
            let churn = 0;
            try {
              const st = await o.gh.getJson<{ stats: { additions: number; deletions: number } }>(`${base}/commits/${pc.sha}`);
              churn = (st.data?.stats?.additions ?? 0) + (st.data?.stats?.deletions ?? 0);
            } catch { churn = 0; }
            const k = rr.memberId ?? "__unatt__";
            const exd = dist.get(k) ?? { memberId: rr.memberId, commits: 0, churn: 0 };
            exd.commits += 1;
            exd.churn += churn;
            dist.set(k, exd);
          }
          if (dist.size > 0) squashDistribution = [...dist.values()];
          // PR metrics: authored/merged + reviews/comments
          try {
            const prRes = await o.gh.getJson<{ user: { login: string } | null; merged_at: string | null }>(`${base}/pulls/${prNum}`);
            void prRes;
          } catch { /* ignore */ }
        }
      } catch (err) {
        warnings.push(`Squash enrichment failed for ${raw.sha.slice(0, 7)}: ${(err as Error).message}`);
      }
    }

    // attribute shares
    const coWithLogin = coAuthors.map((c) => ({ ...c, login: null as string | null }));
    let shares;
    if (exclusionReason) {
      shares = [{ memberId: null as string | null, share: 1, role: "excluded" as const, method: exclusionReason }];
    } else {
      shares = attribute({
        primaryName: raw.mailmapName, primaryEmail: raw.mailmapEmail, primaryLogin: login,
        coAuthors: coWithLogin, roster: teamRoster, coAuthorCredit: config.coAuthorCredit,
        isSquashContainer: isSquashCandidate, squashPrNumber,
        squashDistribution,
      });
    }

    // duplicate handling: same patch+author counted once
    const dupOf = duplicateOf.get(raw.sha) ?? null;
    let isDuplicateCountedOnce = false;
    if (dupOf && !exclusionReason) {
      // same author duplicate: mark excluded-duplicate (counts as activity? spec: count the first, mark other as duplicate that links to it)
      exclusionReason = `duplicate-of:${dupOf.slice(0, 7)}`;
      isDuplicateCountedOnce = true;
      shares = [{ memberId: null, share: 1, role: "excluded" as const, method: "duplicate" }];
    }
    // different-author same patch: both count + DUPLICATE_PATCH flag
    const pid = patchCache.get(raw.sha) ?? "";
    if (pid && patchFirst.get(pid) !== raw.sha && !dupOf && !exclusionReason) {
      // check if another commit with same pid but different author exists
      flags.push({
        code: "DUPLICATE_PATCH", severity: "info",
        message: `Commit ${raw.sha.slice(0, 7)} has the same patch-id as ${patchFirst.get(pid)?.slice(0, 7)} but a different author; both are counted. Innocent explanation: cherry-pick or rebase across branches.`,
        evidence: [raw.sha, patchFirst.get(pid)!],
      });
    }
    void isDuplicateCountedOnce;

    // dates
    const authorDate = parseDateFlexible(raw.authorDate);
    let postDeadline = false;
    if (authorDate && deadlineWithGrace) postDeadline = authorDate.getTime() > deadlineWithGrace.getTime();
    let dateAnomaly: string | null = null;
    if (authorDate) {
      if (authorDate.getTime() > scanNow.getTime() + 5 * 60 * 1000) dateAnomaly = "future";
      else if (courseStartDate && authorDate.getTime() < courseStartDate.getTime()) dateAnomaly = "before-course-start";
    }

    const largeFlag = !exclusionReason && ((added + deleted) > config.thresholds.largeCommitLines || nFiles > config.thresholds.largeCommitFiles);
    if (largeFlag) {
      flags.push({
        code: "LARGE_COMMIT", severity: "review",
        message: `Commit ${raw.sha.slice(0, 7)} is large (${added + deleted} lines, ${nFiles} files); often an import. Innocent explanation: bulk import, generated files missed by exclusions, or initial commit.`,
        evidence: [raw.sha],
      });
    }
    if (isSquashCandidate && !exclusionReason && !squashDistribution) {
      flags.push({
        code: "SQUASH_UNRESOLVED", severity: "info",
        message: `Commit ${raw.sha.slice(0, 7)} looks like a squash merge (#${squashPrNumber}) but no pull request data was available; credited to the listed author as an approximation. Innocent explanation: merged via UI without API access.`,
        evidence: [raw.sha],
      });
    }
    if (dateAnomaly) {
      flags.push({
        code: "DATE_ANOMALY", severity: "review",
        message: `Commit ${raw.sha.slice(0, 7)} has author date ${raw.authorDate} (${dateAnomaly}; git dates are self-reported). Innocent explanation: wrong system clock or rebased old history.`,
        evidence: [raw.sha],
      });
    }

    addEvidence("subjects", stripControl(raw.subject).slice(0, 120));
    attributed.push({
      ...raw, onRef, repoPath, patchId: pid, isMerge, isEmpty: rows.length === 0 && !isMerge,
      exclusionReason, shares, churnAdded: added, churnDeleted: deleted, churnFiles: nFiles,
      formattingLines: formatting, coAuthors, isSquashCandidate, squashPrNumber,
      duplicateOf: dupOf, duplicateFlag: !!dupOf || (pid !== "" && patchFirst.get(pid) !== raw.sha),
      largeFlag, postDeadline, dateAnomaly, files,
    });
  }

  // PR metrics collection (reviews etc.) when gh
  const prSelfApproved: string[] = [];
  if (o.gh) {
    try {
      for (const r of repos) {
        const origin = await gitExec(r.path, ["remote", "get-url", "origin"]).then((x) => x.stdout.trim()).catch(() => "");
        const parsed = origin ? parseOriginRemote(origin) : null;
        if (!parsed) continue;
        const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
        const prNums = new Set<number>([...prBySquashSha.values()]);
        const bumpLogin = (login: string | null | undefined, field: string) => {
          if (!login) return;
          const mem = teamRoster.find((m) => m.github?.toLowerCase() === login.toLowerCase());
          if (!mem) return;
          const cur = prMetricsByMember.get(mem.member_id) ?? { authored: 0, merged: 0, reviewsApproved: 0, reviewsChangesRequested: 0, reviewsCommented: 0, inlineComments: 0, issueComments: 0, selfApproved: 0 };
          (cur as unknown as Record<string, number>)[field] = ((cur as unknown as Record<string, number>)[field] ?? 0) + 1;
          prMetricsByMember.set(mem.member_id, cur);
        };
        for (const n of prNums) {
          try {
            const pr = await o.gh.getJson<{ user: { login: string } | null; merged_at: string | null }>(`${base}/pulls/${n}`);
            const authorLogin = pr.data?.user?.login ?? null;
            if (authorLogin) {
              bumpLogin(authorLogin, "authored");
              if (pr.data?.merged_at) bumpLogin(authorLogin, "merged");
            }
            const revs = await o.gh.paginated<{ user: { login: string } | null; state: string }>(`${base}/pulls/${n}/reviews`);
            const inlines = await o.gh.paginated<{ user: { login: string } | null }>(`${base}/pulls/${n}/comments`);
            const issues = await o.gh.paginated<{ user: { login: string } | null }>(`${base}/issues/${n}/comments`);
            for (const rv of revs) {
              if (rv.state === "APPROVED") {
                bumpLogin(rv.user?.login, "reviewsApproved");
                if (authorLogin && rv.user?.login && rv.user.login.toLowerCase() === authorLogin.toLowerCase()) {
                  bumpLogin(rv.user.login, "selfApproved");
                  prSelfApproved.push(`${rv.user.login} approved PR #${n}`);
                }
              } else if (rv.state === "CHANGES_REQUESTED") bumpLogin(rv.user?.login, "reviewsChangesRequested");
              else bumpLogin(rv.user?.login, "reviewsCommented");
            }
            for (const c of inlines) bumpLogin(c.user?.login, "inlineComments");
            for (const c of issues) bumpLogin(c.user?.login, "issueComments");
          } catch { /* ignore per-PR */ }
        }
      }
    } catch { /* ignore */ }
  }
  for (const ev of prSelfApproved) {
    const login = ev.split(" ")[0]!;
    const mem = teamRoster.find((m) => m.github?.toLowerCase() === login.toLowerCase());
    flags.push({
      code: "SELF_APPROVED", severity: "info", ...(mem ? { memberId: mem.member_id } : {}),
      message: `${ev} — a PR authored and approved by the same account. Innocent explanation: solo PR workflow, or a shared team account.`,
      evidence: [ev],
    });
  }
  void prLimitReached;

  // Aggregate per member
  interface Acc {
    commits: number; added: number; deleted: number; formatting: number; surviving: number;
    files: Set<string>; days: Set<string>; weeks: Map<string, number>;
    postDeadline: number; pair: number; areas: Map<string, number>;
    commitsInWindow: number; totalCreditedCommits: number; onRefCommits: number; offRefCommits: number;
  }
  const acc = new Map<string, Acc>();
  for (const m of teamRoster) acc.set(m.member_id, { commits: 0, added: 0, deleted: 0, formatting: 0, surviving: 0, files: new Set(), days: new Set(), weeks: new Map(), postDeadline: 0, pair: 0, areas: new Map(), commitsInWindow: 0, totalCreditedCommits: 0, onRefCommits: 0, offRefCommits: 0 });
  const unattributed = { commits: 0, churnAdded: 0, churnDeleted: 0, churnTotal: 0, survivingLines: 0 };
  const excluded = { commits: 0, churnAdded: 0, churnDeleted: 0, churnTotal: 0, survivingLines: 0 };
  const unresolvedMap = new Map<string, { name: string; email: string; count: number; sample: string }>();

  const countedCommits = attributed.filter((c) => !c.exclusionReason || c.exclusionReason.startsWith("duplicate-of") ? false : c.exclusionReason !== null ? false : true);
  // Note: duplicates excluded above; empty commits included (zero churn)
  void countedCommits;

  for (const c of attributed) {
    const authorDate = parseDateFlexible(c.authorDate);
    const week = authorDate ? isoWeekInTz(authorDate, config.timezone) : "unknown";
    const day = authorDate ? dayKeyInTz(authorDate, config.timezone) : "unknown";
    const isPair = c.coAuthors.length > 0;
    if (c.exclusionReason) {
      excluded.commits += 1;
      // excluded churn not counted (already filtered); surviving handled in blame
      addEvidence("excluded", `${c.sha.slice(0, 7)} ${c.exclusionReason} ${stripControl(c.subject).slice(0, 80)}`);
      continue;
    }
    for (const s of c.shares) {
      const wCommits = s.share * 1;
      const wAdd = s.share * c.churnAdded;
      const wDel = s.share * c.churnDeleted;
      if (s.memberId && acc.has(s.memberId)) {
        const a = acc.get(s.memberId)!;
        a.commits += wCommits;
        a.added += wAdd;
        a.deleted += wDel;
        a.formatting += s.share * c.formattingLines;
        a.totalCreditedCommits += wCommits;
        if (c.onRef) a.onRefCommits += wCommits; else a.offRefCommits += wCommits;
        if (authorDate) {
          a.weeks.set(week, (a.weeks.get(week) ?? 0) + wCommits);
          a.days.add(day);
        }
        if (c.postDeadline) a.postDeadline += wCommits;
        if (isPair && config.coAuthorCredit !== null) {
          // pairCommits counts co-authored commits regardless of setting
          a.pair += wCommits;
        }
        for (const f of c.files) {
          a.files.add(f.path);
          const area = areaFor(f.path, config.areas);
          if (area) a.areas.set(area, (a.areas.get(area) ?? 0) + s.share * (f.added + f.deleted));
        }
        // final window: 48h before deadline
        if (authorDate && deadlineDate && authorDate.getTime() <= deadlineDate.getTime() + graceMs && authorDate.getTime() > deadlineDate.getTime() + graceMs - 48 * 3600 * 1000) {
          a.commitsInWindow += wCommits;
        }
        addEvidence(`commits:${s.memberId}`, c.sha);
      } else {
        unattributed.commits += wCommits;
        unattributed.churnAdded += wAdd;
        unattributed.churnDeleted += wDel;
        const key = c.authorEmail.toLowerCase() || c.authorName.toLowerCase();
        const exu = unresolvedMap.get(key) ?? { name: c.authorName, email: c.authorEmail, count: 0, sample: c.sha };
        exu.count += 1;
        unresolvedMap.set(key, exu);
      }
    }
  }
  unattributed.churnTotal = unattributed.churnAdded + unattributed.churnDeleted;
  excluded.churnTotal = 0;

  // Blame
  const blameCacheDir = path.join(await cacheDirFor(config), "blame");
  const survivingByMember = new Map<string, number>();
  let unattributedSurviving = 0;
  let excludedSurviving = 0;
  if (!o.skipBlame) {
    for (const r of repos) {
      const blameFiles = await listFilesAtRef(r.path, r.ref);
      // filter exclusions: built-in, excludePaths, submodules
      const candidates = blameFiles.filter((f) => {
        const posix = f.replace(/\\/g, "/");
        if (isBuiltInExcluded(posix)) return false;
        if (matchesAny(posix, config.excludePaths)) return false;
        if ((r.submodules ?? []).includes(f)) return false;
        return true;
      });
      // linguist check in bulk per repo
      const attr = await checkAttrBatch(r.path, r.ref, candidates.slice(0, 1000));
      for (const f of candidates) {
        if (attr.get(f)) continue;
        const lines = await blameFile(r.path, r.ref, f, blameCacheDir);
        for (const ln of lines) {
          // find commit
          const commit = attributed.find((c) => c.sha === ln.commit);
          if (!commit) {
            // commit not in walked set (e.g., unmerged or outside ref) -> attribute via roster lookup if possible
            const rr = resolveIdentity(ln.authorName, ln.authorEmail, teamRoster, null);
            if (rr.memberId) {
              survivingByMember.set(rr.memberId, (survivingByMember.get(rr.memberId) ?? 0) + 1);
            } else {
              unattributedSurviving += 1;
              const key = (ln.authorEmail || ln.authorName).toLowerCase();
              const exu = unresolvedMap.get(key) ?? { name: ln.authorName, email: ln.authorEmail, count: 0, sample: ln.commit };
              exu.count += 0; // blame lines don't add commit counts
              if (!unresolvedMap.has(key)) unresolvedMap.set(key, exu);
            }
            continue;
          }
          if (commit.exclusionReason) {
            excludedSurviving += 1;
            continue;
          }
          for (const s of commit.shares) {
            const w = s.share * 1;
            if (s.memberId && acc.has(s.memberId)) {
              survivingByMember.set(s.memberId, (survivingByMember.get(s.memberId) ?? 0) + w);
            } else {
              unattributedSurviving += w;
            }
          }
        }
      }
    }
  }
  for (const [mid, v] of survivingByMember) acc.get(mid)!.surviving = v;
  unattributed.survivingLines = unattributedSurviving;
  excluded.survivingLines = excludedSurviving;

  // Build member metrics
  const totalMemberCommits = [...acc.values()].reduce((a, x) => a + x.commits, 0);
  const totalMemberChurn = [...acc.values()].reduce((a, x) => a + x.added + x.deleted, 0);
  const totalMemberSurv = [...acc.values()].reduce((a, x) => a + x.surviving, 0);

  const members: MemberMetrics[] = teamRoster.map((m) => {
    const a = acc.get(m.member_id)!;
    const churnTotal = a.added + a.deleted;
    const shares = {
      commits: totalMemberCommits > 0 ? round2((a.commits / totalMemberCommits) * 10000) / 10000 : null,
      churn: totalMemberChurn > 0 ? round2((churnTotal / totalMemberChurn) * 10000) / 10000 : null,
      survivingLines: totalMemberSurv > 0 ? round2((a.surviving / totalMemberSurv) * 10000) / 10000 : null,
    };
    const rawChurn = churnTotal + a.formatting;
    if (rawChurn > 0 && a.formatting > rawChurn / 2 && churnTotal >= 0) {
      // formatting heavy (more than half raw is formatting)
      if (a.formatting > 0) {
        flags.push({
          code: "FORMATTING_HEAVY", severity: "info", memberId: m.member_id,
          message: `${m.member_id} has more than half of raw churn as formatting-only changes (estimate). Innocent explanation: ran a formatter or fixed whitespace across files.`,
          evidence: [`formatting:${Math.round(a.formatting)} raw:${Math.round(rawChurn)}`],
        });
      }
    }
    const finalWindowShare = a.totalCreditedCommits > 0 ? round2((a.commitsInWindow / a.totalCreditedCommits) * 10000) / 10000 : null;
    if (c_postDeadline(a)) {
      flags.push({
        code: "POST_DEADLINE_WORK", severity: "info", memberId: m.member_id,
        message: `${m.member_id} has ${round2(a.postDeadline)} commit(s) after the deadline (git dates are self-reported). Innocent explanation: agreed extension or timezone confusion.`,
        evidence: [`postDeadline:${round2(a.postDeadline)}`],
      });
    }
    const areas: Record<string, number> = {};
    for (const [k, v] of a.areas) areas[k] = round2(v * 100) / 100;
    const weeks: Record<string, number> = {};
    for (const [k, v] of a.weeks) weeks[k] = round2(v * 100) / 100;
    const pm = prMetricsByMember.get(m.member_id);
    const pr = prCollected ? {
      authored: pm?.authored ?? 0, merged: pm?.merged ?? 0,
      reviewsApproved: pm?.reviewsApproved ?? 0, reviewsChangesRequested: pm?.reviewsChangesRequested ?? 0,
      reviewsCommented: pm?.reviewsCommented ?? 0, inlineComments: pm?.inlineComments ?? 0,
      issueComments: pm?.issueComments ?? 0, selfApproved: pm?.selfApproved ?? 0,
    } : null;
    let composite: MemberMetrics["composite"] = null;
    if (config.composite.enabled) {
      const w = config.composite.weights;
      const comps: Record<string, number | null> = { commits: shares.commits, churn: shares.churn, survivingLines: shares.survivingLines };
      const avail = Object.entries(comps).filter(([, v]) => v !== null) as [string, number][];
      const wSum = avail.reduce((s, [k]) => s + (w as Record<string, number>)[k]!, 0);
      const value = wSum > 0 ? avail.reduce((s, [k, v]) => s + (v * (w as Record<string, number>)[k]!) / wSum, 0) : 0;
      composite = {
        value: round2(value * 10000) / 10000,
        formula: `composite = (${w.commits}*commits + ${w.churn}*churn + ${w.survivingLines}*surviving) / renormalized over available dimensions`,
        components: comps,
      };
    }
    return {
      memberId: m.member_id, name: m.name,
      commits: round2(a.commits * 100) / 100,
      churnAdded: round2(a.added * 100) / 100,
      churnDeleted: round2(a.deleted * 100) / 100,
      churnTotal: round2(churnTotal * 100) / 100,
      formattingLines: Math.round(a.formatting),
      survivingLines: round2(a.surviving * 100) / 100,
      areas, filesTouched: a.files.size, activeDays: a.days.size,
      weeklyCommits: weeks,
      postDeadlineCommits: round2(a.postDeadline * 100) / 100,
      finalWindowShare,
      pairCommits: round2(a.pair * 100) / 100,
      pr, shares, composite,
    };
  });

  function c_postDeadline(a: Acc): boolean {
    return a.postDeadline > 0;
  }

  // Team-level flags: LOW_SHARE, NO_ACTIVITY, NO_DEFAULT_BRANCH_WORK, UNRESOLVED_IDENTITY
  const n = Math.max(teamRoster.length, 1);
  for (const m of members) {
    const thresh = config.thresholds.lowShare * (1 / n);
    if (m.shares.churn !== null && m.shares.survivingLines !== null && m.shares.churn < thresh && m.shares.survivingLines < thresh && (m.commits > 0 || totalMemberChurn > 0)) {
      // only when there is some work overall; skip if all zero
      if (totalMemberChurn > 0 && totalMemberSurv > 0) {
        flags.push({
          code: "LOW_SHARE", severity: "review", memberId: m.memberId,
          message: `${m.memberId} is below ${(config.thresholds.lowShare * 100).toFixed(0)}% of an equal share (${(thresh * 100).toFixed(1)}%) on both churn and surviving lines. Innocent explanation: pair work, in-person collaboration, or non-code contributions not visible in git.`,
          evidence: [`churn:${m.shares.churn}`, `surviving:${m.shares.survivingLines}`],
        });
      }
    }
    const prActive = m.pr ? (m.pr.authored + m.pr.merged + m.pr.reviewsApproved + m.pr.reviewsChangesRequested + m.pr.reviewsCommented + m.pr.inlineComments + m.pr.issueComments) : 0;
    if (o.includeUnmerged) {
      const a = acc.get(m.memberId)!;
      if (a.offRefCommits > 0 && a.onRefCommits === 0) {
        flags.push({
          code: "NO_DEFAULT_BRANCH_WORK", severity: "info", memberId: m.memberId,
          message: `${m.memberId} has credit only on commits outside the team ref. Innocent explanation: work is on an unmerged feature branch awaiting review.`,
          evidence: [`off-ref commits:${round2(a.offRefCommits)}`],
        });
      }
    }
    if (m.commits === 0 && (!prCollected || prActive === 0)) {
      flags.push({
        code: "NO_ACTIVITY", severity: "review", memberId: m.memberId,
        message: `${m.memberId} has zero credited commits${prCollected ? " and no PR activity" : ""}. Innocent explanation: non-code work (design, docs, testing) or commits under another identity.`,
        evidence: [],
      });
    }
  }

  if (unresolvedMap.size > 0) {
    flags.push({
      code: "UNRESOLVED_IDENTITY", severity: "review",
      message: `${unresolvedMap.size} unresolved identit(ies) found; their credit sits in unattributed. Innocent explanation: personal email not added to the roster or a shared machine.`,
      evidence: [...unresolvedMap.keys()].slice(0, 10),
    });
  }

  const unresolvedIdentities = [...unresolvedMap.entries()].map(([key, v]) => {
    void key;
    let suggestion: string | undefined;
    for (const m of teamRoster) {
      if (similarNames(v.name, m.name)) {
        suggestion = `${m.member_id} (unverified)`;
        break;
      }
    }
    return { name: v.name, email: v.email, commitCount: Math.round(v.count), sampleSha: v.sample.slice(0, 7), ...(suggestion ? { suggestion } : {}) };
  }).sort((a, b) => b.commitCount - a.commitCount || (a.email < b.email ? -1 : 1));

  const totals = {
    commits: round2((totalMemberCommits + unattributed.commits + excluded.commits) * 100) / 100,
    churnAdded: round2(([...acc.values()].reduce((a, x) => a + x.added, 0) + unattributed.churnAdded) * 100) / 100,
    churnDeleted: round2(([...acc.values()].reduce((a, x) => a + x.deleted, 0) + unattributed.churnDeleted) * 100) / 100,
    churnTotal: round2((totalMemberChurn + unattributed.churnTotal) * 100) / 100,
    survivingLines: Math.round(totalMemberSurv + unattributedSurviving + excludedSurviving),
  };

  // cap evidence at 25 per metric for human reports (JSON keeps full)
  void evidence;

  return {
    teamId, deadline: t.deadline ?? null, ref: t.ref ?? "(auto)",
    repos: repos.map((r) => ({ path: r.path, ref: r.ref, refUsed: r.refUsed, headSha: r.headSha, shallow: r.shallow, commitsCounted: r.commitsCounted, commitsSkipped: r.commitsSkipped, submodules: r.submodules })),
    members: members.sort((a, b) => (a.memberId < b.memberId ? -1 : 1)),
    unattributed: {
      commits: round2(unattributed.commits * 100) / 100,
      churnAdded: round2(unattributed.churnAdded * 100) / 100,
      churnDeleted: round2(unattributed.churnDeleted * 100) / 100,
      churnTotal: round2(unattributed.churnTotal * 100) / 100,
      survivingLines: Math.round(unattributedSurviving),
    },
    excluded: {
      commits: excluded.commits,
      churnAdded: 0, churnDeleted: 0, churnTotal: 0,
      survivingLines: Math.round(excludedSurviving),
    },
    totals,
    flags: flags.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : (a.memberId ?? "") < (b.memberId ?? "") ? -1 : 1)),
    warnings: shallowAny ? [...warnings, "Shallow clone detected: blame and history are incomplete. Force-pushed (rewritten) history cannot be recovered."] : warnings,
    evidence,
    unresolvedIdentities,
    prCollected,
  };
}

async function listFilesAtRef(repoPath: string, ref: string): Promise<string[]> {
  try {
    const { stdout } = await gitExec(repoPath, ["ls-tree", "-r", "-z", "--name-only", ref, "--"]);
    return stdout.split("\x00").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

interface BlameLine { commit: string; authorName: string; authorEmail: string }

async function blameFile(repoPath: string, ref: string, file: string, cacheDir: string): Promise<BlameLine[]> {
  // cache key: blob sha + ignore-revs hash
  let blobSha = "";
  try {
    blobSha = (await gitExec(repoPath, ["rev-parse", `${ref}:${file}`])).stdout.trim();
  } catch {
    return [];
  }
  let ignoreHash = "none";
  try {
    const ignorePath = path.join(repoPath, ".git-blame-ignore-revs");
    if (fs.existsSync(ignorePath)) {
      ignoreHash = crypto.createHash("sha256").update(fs.readFileSync(ignorePath)).digest("hex").slice(0, 16);
    }
  } catch { /* ignore */ }
  const key = fnv1a(repoPath + ":" + blobSha + ":" + ignoreHash);
  const cacheFile = path.join(cacheDir, `${key}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as BlameLine[];
    }
  } catch { /* ignore */ }
  const args = ["blame", "--line-porcelain", "-M", "-C", "--no-ext-diff", "--no-textconv", ref, "--", file];
  // insert --ignore-revs-file if exists
  try {
    if (fs.existsSync(path.join(repoPath, ".git-blame-ignore-revs"))) {
      args.splice(1, 0, "--ignore-revs-file", ".git-blame-ignore-revs");
    }
  } catch { /* ignore */ }
  let stdout = "";
  try {
    ({ stdout } = await gitExec(repoPath, args));
  } catch {
    return [];
  }
  const out: BlameLine[] = [];
  let cur: BlameLine | null = null;
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) \d+ \d+( \d+)?$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { commit: m[1], authorName: "", authorEmail: "" };
    } else if (cur) {
      const am = line.match(/^author (.+)$/);
      if (am) cur.authorName = am[1];
      const em = line.match(/^author-mail <(.+)>$/);
      if (em) cur.authorEmail = em[1] === "not.committed.yet" ? "" : em[1];
    }
  }
  if (cur) out.push(cur);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out));
  } catch { /* ignore */ }
  return out;
}

export async function loadAnalysis(analysisPath: string): Promise<Analysis> {
  const raw = fs.readFileSync(path.resolve(analysisPath), "utf8");
  return JSON.parse(raw) as Analysis;
}

export function loadAdjustments(configDir: string): { memberId: string; team: string; note: string }[] {
  const f = path.join(configDir, "adjustments.yaml");
  if (!fs.existsSync(f)) return [];
  try {
    const data = yamlParse(fs.readFileSync(f, "utf8")) as unknown;
    if (!data || typeof data !== "object") return [];
    const adj = (data as { adjustments?: { memberId: string; team: string; note: string }[] }).adjustments;
    if (Array.isArray(adj)) return adj;
    return [];
  } catch {
    return [];
  }
}
