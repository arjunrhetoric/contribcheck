import type { RosterMember, Share } from "./types.js";

export interface ResolvedIdentity {
  memberId: string | null;
  method: string;
}

const BUILTIN_BOTS = new Set([
  "dependabot", "renovate", "github-actions", "codecov", "dependabot[bot]",
  "renovate[bot]", "github-actions[bot]", "codecov[bot]", "deepsource", "snyk-bot",
  "allcontributors", "imgbot", "netlify", "vercel", "heroku",
  "greenkeeper", "mergify", "stale", "whitesource", "pre-commit-ci",
]);

export function isBotAddress(name: string, email: string, login: string | null, extraBots: string[]): boolean {
  const extra = new Set(extraBots.map((s) => s.toLowerCase()));
  const nm = name.toLowerCase().trim();
  const em = email.toLowerCase().trim();
  const lg = (login ?? "").toLowerCase().trim();
  if (lg.endsWith("[bot]")) return true;
  // GitHub bot noreply pattern: N+login[bot]@users.noreply.github.com or login@users.noreply.github.com with [bot]
  if (/^\d+\+.+\[bot\]@users\.noreply\.github\.com$/.test(em)) return true;
  if (/\[bot\]@users\.noreply\.github\.com$/.test(em)) return true;
  if (BUILTIN_BOTS.has(nm) || BUILTIN_BOTS.has(lg) || BUILTIN_BOTS.has(em)) return true;
  if (extra.has(nm) || extra.has(em) || (lg && extra.has(lg))) return true;
  return false;
}

export function parseCoAuthors(body: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  const lines = body.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*co-authored-by\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const rest = m[1].trim();
    const em = rest.match(/^(.*)<([^<>]+)>\s*$/);
    if (em) {
      out.push({ name: em[1].trim(), email: em[2].trim() });
    } else {
      out.push({ name: rest, email: "" });
    }
  }
  return out;
}

export function parseNoreplyLogin(email: string): string | null {
  const e = email.toLowerCase().trim();
  let m = e.match(/^(\d+\+)?(.+)@users\.noreply\.github\.com$/);
  if (!m) return null;
  let login = m[2];
  // strip trailing [bot]? keep base login without [bot]
  login = login.replace(/\[bot\]$/, "");
  return login || null;
}

export function resolveIdentity(
  name: string,
  email: string,
  roster: RosterMember[],
  apiLogin: string | null,
): ResolvedIdentity {
  const emLower = email.toLowerCase();
  for (const m of roster) {
    if (m.emails.some((e) => e.toLowerCase() === emLower)) {
      return { memberId: m.member_id, method: "direct" };
    }
  }
  // GitHub noreply
  const loginFromEmail = parseNoreplyLogin(email);
  if (loginFromEmail) {
    for (const m of roster) {
      if (m.github && m.github.toLowerCase() === loginFromEmail.toLowerCase()) {
        return { memberId: m.member_id, method: "noreply" };
      }
    }
  }
  if (apiLogin) {
    for (const m of roster) {
      if (m.github && m.github.toLowerCase() === apiLogin.toLowerCase()) {
        return { memberId: m.member_id, method: "github-api" };
      }
    }
  }
  return { memberId: null, method: "unresolved" };
}

export interface AttributeInput {
  primaryName: string;
  primaryEmail: string;
  primaryLogin: string | null;
  coAuthors: { name: string; email: string; login: string | null }[];
  roster: RosterMember[];
  coAuthorCredit: "equal" | "none";
  isSquashContainer: boolean;
  squashPrNumber: number | null;
  squashDistribution: { memberId: string | null; commits: number; churn: number }[] | null;
}

/**
 * One function decides credit. All metrics use these shares.
 * Returns shares summing to 1.
 */
export function attribute(input: AttributeInput): Share[] {
  // Squash container with enrichment distribution
  if (input.isSquashContainer && input.squashDistribution && input.squashDistribution.length > 0) {
    const dist = input.squashDistribution;
    const totalCommits = dist.reduce((a, d) => a + d.commits, 0);
    const totalChurn = dist.reduce((a, d) => a + d.churn, 0);
    const n = dist.length;
    const shares: Share[] = dist.map((d) => {
      const commitShare = totalCommits > 0 ? d.commits / totalCommits : 1 / n;
      const churnShare = totalChurn > 0 ? d.churn / totalChurn : 1 / n;
      return {
        memberId: d.memberId,
        share: churnShare,
        commitShare,
        churnShare,
        role: d.memberId ? "pr-author" : "unattributed",
        method: "squash-github",
      };
    });
    return shares;
  }
  if (input.isSquashContainer) {
    const r = resolveIdentity(input.primaryName, input.primaryEmail, input.roster, input.primaryLogin);
    return [{ memberId: r.memberId, share: 1, role: r.memberId ? "primary" : "unattributed", method: "squash-fallback" }];
  }
  const primary = resolveIdentity(input.primaryName, input.primaryEmail, input.roster, input.primaryLogin);
  if (input.coAuthorCredit === "none" || input.coAuthors.length === 0) {
    return [{ memberId: primary.memberId, share: 1, role: primary.memberId ? "primary" : "unattributed", method: "direct" }];
  }
  // equal split among distinct resolved identities (primary + co-authors)
  type Id = { memberId: string | null; method: string };
  const ids: Id[] = [{ memberId: primary.memberId, method: primary.method }];
  for (const c of input.coAuthors) {
    const r = resolveIdentity(c.name, c.email, input.roster, c.login);
    ids.push({ memberId: r.memberId, method: r.method });
  }
  // distinct by memberId (null collapses to one unattributed bucket)
  const uniq = new Map<string, Id>();
  for (const id of ids) {
    const k = id.memberId ?? "__unattributed__";
    if (!uniq.has(k)) uniq.set(k, id);
  }
  const list = [...uniq.values()];
  const n = list.length;
  return list.map((u) => ({
    memberId: u.memberId,
    share: 1 / n,
    role: (u.memberId ? (u.memberId === primary.memberId ? "primary" : "co-author") : "unattributed") as Share["role"],
    method: u.memberId ? (u.memberId === primary.memberId ? primary.method : "coauthor-equal") : "coauthor-equal",
  }));
}
