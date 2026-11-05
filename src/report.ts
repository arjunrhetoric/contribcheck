import fs from "node:fs";
import path from "node:path";
import type { Analysis, TeamAnalysis } from "./types.js";
import { csvCell, escapeHtml, escapeMdCell, fmtPct, fmtNum, pseudonym, stripControl } from "./util.js";
import { loadAdjustments } from "./scan.js";

export type ReportFormat = "md" | "html" | "csv" | "json";

interface Redactor {
  seed: Map<string, string>;
  counters: { n: number };
}

function newRedactor(): Redactor {
  return { seed: new Map(), counters: { n: 0 } };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function redactText(s: string, r: Redactor): string {
  let out = s.replace(EMAIL_RE, (m) => pseudonym("email", m, r.seed, r.counters));
  out = out.replace(/\b([A-Za-z0-9][A-Za-z0-9-]{0,38}) approved PR #(\d+)/g, (m, login: string, num: string) =>
    `${pseudonym("login", login, r.seed, r.counters)} approved PR #${num}`);
  return out;
}

function redactAnalysis(analysis: Analysis, r: Redactor): Analysis {
  const clone = JSON.parse(JSON.stringify(analysis)) as Analysis;
  for (const t of clone.teams) {
    for (const u of t.unresolvedIdentities) {
      u.email = pseudonym("email", u.email, r.seed, r.counters);
    }
    for (const [k, arr] of Object.entries(t.evidence)) {
      t.evidence[k] = arr.map((x) => redactText(x, r));
    }
    for (const f of t.flags) {
      f.message = redactText(f.message, r);
      f.evidence = f.evidence.map((x) => redactText(x, r));
    }
    t.warnings = t.warnings.map((x) => redactText(x, r));
  }
  return clone;
}

export function renderReport(analysis: Analysis, format: ReportFormat, opts?: { redact?: boolean; configDir?: string }): string | Record<string, string> {
  if (format === "json") {
    const r = newRedactor();
    const a = opts?.redact ? redactAnalysis(analysis, r) : analysis;
    return JSON.stringify(a, null, 2);
  }
  if (format === "csv") return renderCsv(analysis, opts);
  if (format === "html") return renderHtml(analysis, opts);
  return renderMarkdown(analysis, opts);
}

export function renderMarkdown(analysis: Analysis, opts?: { redact?: boolean; configDir?: string }): Record<string, string> {
  const redact = opts?.redact ?? false;
  const r = newRedactor();
  const a = redact ? redactAnalysis(analysis, r) : analysis;
  const adjustments = opts?.configDir ? loadAdjustments(opts.configDir) : [];
  const out: Record<string, string> = {};
  for (const t of a.teams) {
    const L: string[] = [];
    L.push("> Evidence for human review. This is not a grade.");
    L.push("");
    L.push(`# contribcheck — team ${escapeMdCell(stripControl(t.teamId))}`);
    L.push("");
    L.push("Git dates are self-reported and may be wrong; every date below carries that caveat.");
    L.push("");
    L.push("## Method (summary)");
    L.push("");
    L.push("- Credit is decided by one `attribute(commit)` function; commit counts, churn, surviving lines, weekly activity and areas all use its shares.");
    L.push("- Co-authored work splits equally when `coAuthorCredit: equal`; squash merges without PR data fall back to the listed author (`SQUASH_UNRESOLVED`).");
    L.push("- Lockfiles, generated/vendored files, binaries, submodules and configured `excludePaths` are excluded from churn and blame.");
    L.push("- Formatting-only churn is estimated (normal numstat minus `-w --ignore-blank-lines`) and reported separately, not counted.");
    L.push("- Shares use attributed credit only (excluding `unattributed` and `excluded`); a zero denominator gives `null`.");
    L.push("");
    L.push("## Members");
    L.push("");
    L.push("| member | commits | churn | surviving | commit share | churn share | surviving share | post-deadline | pair |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const m of t.members) {
      L.push(`| ${escapeMdCell(stripControl(m.memberId))} ${escapeMdCell(stripControl(m.name))} | ${fmtNum(m.commits)} | ${fmtNum(m.churnTotal)} | ${fmtNum(m.survivingLines)} | ${fmtPct(m.shares.commits)} | ${fmtPct(m.shares.churn)} | ${fmtPct(m.shares.survivingLines)} | ${fmtNum(m.postDeadlineCommits)} | ${fmtNum(m.pairCommits)} |`);
    }
    L.push("");
    if (a.configSummary.compositeEnabled || t.members.some((m) => m.composite)) {
      L.push("## Composite (presentation aid only)");
      L.push("");
      L.push("Weights are renormalized over the dimensions that exist. Never read this number alone.");
      L.push("");
      for (const m of t.members) {
        if (!m.composite) continue;
        L.push(`- ${escapeMdCell(stripControl(m.memberId))}: ${m.composite.value} — ${escapeMdCell(m.composite.formula)}; components: ${escapeMdCell(JSON.stringify(m.composite.components))}`);
      }
      L.push("");
    }
    L.push(`Unattributed: commits=${fmtNum(t.unattributed.commits)} churn=${fmtNum(t.unattributed.churnTotal)} surviving=${fmtNum(t.unattributed.survivingLines)}. Excluded: commits=${t.excluded.commits} surviving=${t.excluded.survivingLines}.`);
    L.push("");
    L.push("## Flags");
    L.push("");
    if (t.flags.length === 0) L.push("No flags.");
    else for (const f of t.flags) {
      L.push(`- \`${escapeMdCell(f.code)}\` [${f.severity}]${f.memberId ? " " + escapeMdCell(f.memberId) : ""}: ${escapeMdCell(stripControl(f.message))}${f.evidence.length ? " — evidence: " + f.evidence.slice(0, 5).map((e) => escapeMdCell(stripControl(e))).join(", ") : ""}`);
    }
    L.push("");
    L.push("## Evidence (capped at 25 per metric)");
    L.push("");
    const memberIds = new Set(t.members.map((m) => m.memberId));
    const evidenceKeys = Object.keys(t.evidence).sort((ka, kb) => {
      const ra = memberIds.has(ka.split(":").slice(1).join(":")) || ka.startsWith("excluded") || ka.startsWith("subjects") ? 0 : 1;
      const rb = memberIds.has(kb.split(":").slice(1).join(":")) || kb.startsWith("excluded") || kb.startsWith("subjects") ? 0 : 1;
      return ra - rb || (ka < kb ? -1 : ka > kb ? 1 : 0);
    });
    for (const k of evidenceKeys.slice(0, 40)) {
      const v = t.evidence[k] ?? [];
      L.push(`- ${escapeMdCell(stripControl(k))}: ${v.slice(0, 25).map((e) => escapeMdCell(stripControl(e))).join(", ")}`);
    }
    L.push("");
    L.push("## Unresolved identities");
    L.push("");
    if (t.unresolvedIdentities.length === 0) L.push("None.");
    else for (const u of t.unresolvedIdentities) {
      L.push(`- ${escapeMdCell(stripControl(u.name))} \\<${escapeMdCell(stripControl(u.email))}\\> — ${u.commitCount} commit(s), sample ${escapeMdCell(u.sampleSha)}${u.suggestion ? `, suggestion: ${escapeMdCell(u.suggestion)}` : ""}`);
    }
    L.push("");
    const notes = adjustments.filter((x) => x.team === t.teamId);
    L.push("## Instructor notes");
    L.push("");
    if (notes.length === 0) L.push("None. (adjustments.yaml entries never change computed numbers.)");
    else for (const nn of notes) L.push(`- ${escapeMdCell(stripControl(nn.memberId))}: ${escapeMdCell(stripControl(nn.note))}`);
    L.push("");
    L.push("## Limitations");
    L.push("");
    L.push("- Force-pushed (rewritten) history cannot be recovered; shallow clones have incomplete history/blame; squash containers without PR data are approximations; git dates are self-reported.");
    out[t.teamId] = L.join("\n");
  }
  return out;
}

export function renderHtml(analysis: Analysis, opts?: { redact?: boolean; configDir?: string }): Record<string, string> {
  const redact = opts?.redact ?? false;
  const r = newRedactor();
  const a = redact ? redactAnalysis(analysis, r) : analysis;
  const adjustments = opts?.configDir ? loadAdjustments(opts.configDir) : [];
  const out: Record<string, string> = {};
  for (const t of a.teams) {
    const maxWeek = Math.max(1, ...t.members.flatMap((m) => Object.values(m.weeklyCommits)));
    let weeks = "";
    const allWeeks = [...new Set(t.members.flatMap((m) => Object.keys(m.weeklyCommits)))].sort();
    for (const m of t.members) {
      let bars = "";
      for (const w of allWeeks) {
        const v = m.weeklyCommits[w] ?? 0;
        const h = Math.round((v / maxWeek) * 60);
        bars += `<svg width="24" height="70" role="img" aria-label="${escapeHtml(w)} ${v}"><rect x="4" y="${70 - h}" width="16" height="${h}" fill="#3366cc"/><title>${escapeHtml(w)}: ${v}</title></svg>`;
      }
      weeks += `<h3>${escapeHtml(stripControl(m.memberId))} ${escapeHtml(stripControl(m.name))}</h3><div>${bars}</div><p>${escapeHtml(allWeeks.join(", ") || "no weeks")}</p>`;
    }
    const flags = t.flags.map((f) => `<li><code>${escapeHtml(f.code)}</code> [${escapeHtml(f.severity)}]${f.memberId ? " " + escapeHtml(f.memberId) : ""}: ${escapeHtml(stripControl(f.message))}</li>`).join("");
    const rows = t.members.map((m) => `<tr><td>${escapeHtml(stripControl(m.memberId))} ${escapeHtml(stripControl(m.name))}</td><td>${m.commits}</td><td>${m.churnTotal}</td><td>${m.survivingLines}</td><td>${fmtPct(m.shares.commits)}</td><td>${fmtPct(m.shares.churn)}</td><td>${fmtPct(m.shares.survivingLines)}</td></tr>`).join("");
    const unres = t.unresolvedIdentities.map((u) => `<li>${escapeHtml(stripControl(u.name))} &lt;${escapeHtml(stripControl(u.email))}&gt; — ${u.commitCount}, sample ${escapeHtml(u.sampleSha)}</li>`).join("");
    const evItems = Object.entries(t.evidence).slice(0, 10).map(([k, v]) => `<li>${escapeHtml(stripControl(k))}: ${v.slice(0, 5).map((e) => escapeHtml(stripControl(e))).join(", ")}</li>`).join("");
    const subjects = (t.evidence["subjects"] ?? []).slice(0, 10).map((s) => `<li>${escapeHtml(stripControl(s))}</li>`).join("");
    const comps = t.members.filter((m) => m.composite).map((m) => `<li>${escapeHtml(m.memberId)}: ${m.composite!.value} — ${escapeHtml(m.composite!.formula)}; components ${escapeHtml(JSON.stringify(m.composite!.components))}</li>`).join("");
    const notes = adjustments.filter((x) => x.team === t.teamId).map((x) => `<li>${escapeHtml(x.memberId)}: ${escapeHtml(stripControl(x.note))}</li>`).join("");
    out[t.teamId] = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>contribcheck ${escapeHtml(t.teamId)}</title><style>body{font-family:sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px}@media print{body{margin:0}}</style></head><body><p><strong>Evidence for human review. This is not a grade.</strong> Git dates are self-reported.</p><h1>contribcheck — team ${escapeHtml(t.teamId)}</h1><h2>Members</h2><table><tr><th>member</th><th>commits</th><th>churn</th><th>surviving</th><th>commit share</th><th>churn share</th><th>surviving share</th></tr>${rows}</table>${comps ? `<h2>Composite (presentation aid only)</h2><p>Weights are renormalized over available dimensions. Never read this number alone.</p><ul>${comps}</ul>` : ""}<h2>Weekly activity</h2>${weeks}<h2>Flags</h2><ul>${flags || "<li>None</li>"}</ul><h2>Unresolved identities</h2><ul>${unres || "<li>None</li>"}</ul><h2>Instructor notes</h2><ul>${notes || "<li>None</li>"}</ul><h2>Evidence</h2><ul>${evItems || "<li>None</li>"}</ul><h2>Commit subjects</h2><ul>${subjects || "<li>None</li>"}</ul><p>PR data: ${t.prCollected ? "collected" : "not collected"}.</p><p>Limitations: force-pushed history cannot be recovered; shallow clones have incomplete history and blame; squash containers without PR data are approximations; git dates are self-reported.</p></body></html>`;
  }
  return out;
}

export function renderCsv(analysis: Analysis, opts?: { redact?: boolean }): string {
  const redact = opts?.redact ?? false;
  const r = newRedactor();
  const a = redact ? redactAnalysis(analysis, r) : analysis;
  const header = ["team", "member_id", "name", "commits", "churn_added", "churn_deleted", "churn_total", "surviving_lines", "formatting_lines", "files_touched", "active_days", "post_deadline", "pair_commits", "commit_share", "churn_share", "surviving_share", "composite_value"];
  const lines = [header.join(",")];
  for (const t of a.teams) {
    for (const m of t.members) {
      const row = [t.teamId, m.memberId, m.name, m.commits, m.churnAdded, m.churnDeleted, m.churnTotal, m.survivingLines, m.formattingLines, m.filesTouched, m.activeDays, m.postDeadlineCommits, m.pairCommits, m.shares.commits ?? "", m.shares.churn ?? "", m.shares.survivingLines ?? "", m.composite?.value ?? ""];
      lines.push(row.map((v) => csvCell(String(v))).join(","));
    }
  }
  return lines.join("\n") + "\n";
}

export function renderExplain(analysis: Analysis, memberId: string, view: "instructor" | "student", teamId?: string, format: "md" | "json" = "md", opts?: { configDir?: string }): string {
  const teams = analysis.teams.filter((t) => !teamId || t.teamId === teamId);
  const team = teams.find((t) => t.members.some((m) => m.memberId === memberId)) ?? teams[0];
  if (!team) throw new Error(`Member "${memberId}" not found`);
  const m = team.members.find((x) => x.memberId === memberId);
  if (!m) throw new Error(`Member "${memberId}" not found in team ${team.teamId}`);
  if (format === "json") {
    if (view === "student") {
      return JSON.stringify({
        member: m,
        teamTotals: team.totals,
        unattributed: {
          commits: team.unattributed.commits,
          churnTotal: team.unattributed.churnTotal,
          survivingLines: team.unattributed.survivingLines,
        },
        flags: team.flags.filter((f) => f.memberId === memberId),
      }, null, 2);
    }
    return JSON.stringify({ member: m, team }, null, 2);
  }
  const L: string[] = [];
  L.push("> Evidence for human review. This is not a grade.");
  L.push("");
  L.push(`# explain ${escapeMdCell(memberId)} (${view} view)`);
  L.push("");
  L.push(`- commits: ${fmtNum(m.commits)} | churn: ${fmtNum(m.churnTotal)} (+${fmtNum(m.churnAdded)}/-${fmtNum(m.churnDeleted)}) | surviving: ${fmtNum(m.survivingLines)}`);
  L.push(`- shares: commits ${fmtPct(m.shares.commits)}, churn ${fmtPct(m.shares.churn)}, surviving ${fmtPct(m.shares.survivingLines)}`);
  if (m.composite) L.push(`- composite: ${m.composite.value} (${m.composite.formula}; components ${JSON.stringify(m.composite.components)})`);
  L.push(`- files touched: ${m.filesTouched}, active days: ${m.activeDays}, post-deadline: ${fmtNum(m.postDeadlineCommits)}, pair: ${fmtNum(m.pairCommits)}`);
  L.push(`- team totals (anonymized): commits ${fmtNum(team.totals.commits)}, churn ${fmtNum(team.totals.churnTotal)}, surviving ${fmtNum(team.totals.survivingLines)}`);
  L.push(`- team unattributed (anonymized): commits ${fmtNum(team.unattributed.commits)}, churn ${fmtNum(team.unattributed.churnTotal)}, surviving ${fmtNum(team.unattributed.survivingLines)}`);
  if (view === "instructor") {
    L.push("");
    L.push("## Flags for this member");
    for (const f of team.flags.filter((x) => x.memberId === memberId)) L.push(`- \`${f.code}\` [${f.severity}]: ${stripControl(f.message)}`);
  } else {
    L.push("");
    L.push("## Flags for this member");
    const own = team.flags.filter((x) => x.memberId === memberId);
    if (own.length === 0) L.push("None.");
    for (const f of own) L.push(`- \`${f.code}\` [${f.severity}]: ${stripControl(f.message)}`);
  }
  if (view === "instructor" && opts?.configDir) {
    const notes = loadAdjustments(opts.configDir).filter((x) => x.team === team.teamId && x.memberId === memberId);
    L.push("");
    L.push("## Instructor notes");
    if (notes.length === 0) L.push("None.");
    for (const n of notes) L.push(`- ${escapeMdCell(stripControl(n.note))}`);
  }
  return L.join("\n");
}

export function writeReports(analysis: Analysis, formats: ReportFormat[], outDir: string, opts?: { redact?: boolean; configDir?: string }): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_") || "team";
  const written: string[] = [];
  for (const f of formats) {
    if (f === "json") {
      const p = path.join(outDir, "analysis.json");
      fs.writeFileSync(p, renderReport(analysis, "json", opts) as string);
      written.push(p);
    } else if (f === "csv") {
      const p = path.join(outDir, "report.csv");
      fs.writeFileSync(p, renderCsv(analysis, opts));
      written.push(p);
    } else if (f === "md") {
      const rec = renderMarkdown(analysis, opts);
      for (const [team, body] of Object.entries(rec)) {
        const p = path.join(outDir, `${safeName(team)}.md`);
        fs.writeFileSync(p, body);
        written.push(p);
      }
    } else if (f === "html") {
      const rec = renderHtml(analysis, opts);
      for (const [team, body] of Object.entries(rec)) {
        const p = path.join(outDir, `${safeName(team)}.html`);
        fs.writeFileSync(p, body);
        written.push(p);
      }
    }
  }
  return written;
}

export { redactAnalysis };
