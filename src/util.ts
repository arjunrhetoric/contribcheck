export function stripControl(s: string): string {
  // Strip ANSI escapes (CSI and OSC) and other control chars except \n \t
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1B\[[0-9;?]*[A-Za-z]/g;
  // eslint-disable-next-line no-control-regex
  const osc = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
  let out = s.replace(ansi, "").replace(osc, "");
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, "");
  return out;
}

export function normalizeCRLF(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeMdCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/</g, "\\<").replace(/>/g, "\\>");
}

export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function fmtPct(share: number | null): string {
  if (share === null || !isFinite(share)) return "n/a";
  return (share * 100).toFixed(1) + "%";
}

export function fmtNum(n: number): string {
  if (!isFinite(n)) return "n/a";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Minimal glob matcher supporting **, *, ? for excludePaths and areas. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escapeRegExpChar(c);
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

function escapeRegExpChar(c: string): string {
  return c.replace(/[.+^${}()|[\]\\]/, (m) => "\\" + m);
}

export function matchesAny(path: string, patterns: string[]): boolean {
  const p = path.replace(/\\/g, "/");
  for (const g of patterns) {
    const gg = g.replace(/\\/g, "/");
    try {
      if (globToRegExp(gg).test(p)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export function stableSort<T>(arr: T[], key: (t: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Pseudonym map for --redact. Hash-based so the same address gets the same
 *  pseudonym across formats and runs. */
export function pseudonym(kind: "email" | "login" | "name", value: string, seed: Map<string, string>, counters: { n: number }): string {
  const k = kind + ":" + value.toLowerCase();
  const existing = seed.get(k);
  if (existing) return existing;
  counters.n += 1;
  const v = `${kind}-${fnv1a(k)}`;
  seed.set(k, v);
  return v;
}

/** Get date parts in IANA timezone using Intl. */
export function tzParts(date: Date, timeZone: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute"), ss: get("second") };
}

/** ISO week string YYYY-Www computed in given timezone. */
export function isoWeekInTz(date: Date, timeZone: string): string {
  // Compute local calendar date in tz, then ISO week from that calendar date (UTC-based calc).
  const p = tzParts(date, timeZone);
  const utc = new Date(Date.UTC(p.y, p.m - 1, p.d, 12, 0, 0));
  // ISO week algorithm on utc date
  const day = (utc.getUTCDay() + 6) % 7; // Mon=0
  const thursday = new Date(utc);
  thursday.setUTCDate(utc.getUTCDate() - day + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4day);
  const week = Math.floor((thursday.getTime() - week1Mon.getTime()) / (7 * 86400000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function dayKeyInTz(date: Date, timeZone: string): string {
  const p = tzParts(date, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function parseDateFlexible(s: string): Date | null {
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

/** Simple name similarity (normalized Levenshtein <=2 or substring) for unverified suggestions. */
export function similarNames(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return levenshtein(na, nb) <= 2;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[n];
}

export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
