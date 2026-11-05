import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface CacheEntry {
  url: string;
  etag?: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  storedAt: string;
}

function cacheDir(): string {
  return path.join(process.cwd(), ".contribcheck", "cache");
}

function cacheFileFor(url: string, dir?: string): string {
  const h = crypto.createHash("sha256").update(url).digest("hex");
  return path.join(dir ?? cacheDir(), h + ".json");
}

export interface FetchResult {
  status: number;
  body: string;
  headers: Headers;
  fromCache: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GitHubClient {
  token: string | null;
  dir: string;
  fetchFn: typeof fetch;
  maxConcurrent = 4;

  constructor(opts?: { dir?: string; fetchFn?: typeof fetch }) {
    this.token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? null;
    this.dir = opts?.dir ?? cacheDir();
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  requireToken(): void {
    if (!this.token) throw new Error("GitHub enrichment requested but no token found. Set GITHUB_TOKEN or GH_TOKEN.");
  }

  private readCache(url: string): CacheEntry | null {
    try {
      const f = cacheFileFor(url, this.dir);
      if (!fs.existsSync(f)) return null;
      return JSON.parse(fs.readFileSync(f, "utf8")) as CacheEntry;
    } catch {
      return null;
    }
  }

  private writeCache(url: string, entry: CacheEntry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(cacheFileFor(url, this.dir), JSON.stringify(entry));
  }

  sanitizeError(msg: string): string {
    if (this.token) msg = msg.split(this.token).join("***");
    return msg;
  }

  async request(url: string, attempt = 0): Promise<FetchResult> {
    this.requireToken();
    const cached = this.readCache(url);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "contribcheck/0.1.0",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { ...headers, Authorization: `Bearer ${this.token}` } });
    } catch (e) {
      throw new Error(this.sanitizeError(`GitHub request failed for ${url}: ${(e as Error).message}`));
    }
    // Never store request headers; store ETag only
    const etag = res.headers.get("etag") ?? undefined;
    if (res.status === 304 && cached) {
      return { status: 200, body: cached.body, headers: res.headers, fromCache: true };
    }
    if (res.status === 403 || res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const reset = res.headers.get("x-ratelimit-reset");
      const remaining = res.headers.get("x-ratelimit-remaining");
      const rateLimited = res.status === 429 || remaining === "0" || !!retryAfter || !!reset;
      if (rateLimited && attempt < 5) {
        let waitMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        if (retryAfter) waitMs = Number(retryAfter) * 1000;
        else if (reset) {
          const resetMs = Number(reset) * 1000 - Date.now();
          if (resetMs > 0 && resetMs < 10 * 60 * 1000) waitMs = resetMs + 1000;
        }
        await sleep(Math.min(waitMs, 30000));
        return this.request(url, attempt + 1);
      }
      if (remaining === "0") throw new Error(this.sanitizeError("GitHub rate limit exhausted. Re-run later; the cache makes re-runs cheap."));
      throw new Error(this.sanitizeError(`GitHub request failed: ${url} -> ${res.status}`));
    }
    if (res.status === 404) {
      return { status: 404, body: "", headers: res.headers, fromCache: false };
    }
    if (!res.ok) {
      throw new Error(this.sanitizeError(`GitHub request failed: endpoint ${new URL(url).pathname} -> ${res.status}`));
    }
    const body = await res.text();
    this.writeCache(url, { url, etag, status: res.status, headers: { etag: etag ?? "" }, body, storedAt: new Date().toISOString() });
    return { status: res.status, body, headers: res.headers, fromCache: false };
  }

  async getJson<T>(url: string): Promise<{ data: T | null; fromCache: boolean }> {
    const r = await this.request(url);
    if (r.status === 404) return { data: null, fromCache: false };
    return { data: JSON.parse(r.body) as T, fromCache: r.fromCache };
  }

  async paginated<T>(baseUrl: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = baseUrl.includes("?") ? `${baseUrl}&per_page=100` : `${baseUrl}?per_page=100`;
    let page = 0;
    while (url && page < 50) {
      const r = await this.request(url);
      if (r.status === 404) break;
      const arr = JSON.parse(r.body) as T[];
      if (!Array.isArray(arr)) break;
      out.push(...arr);
      const link = r.headers.get("link");
      url = parseNextLink(link);
      page++;
    }
    return out;
  }

  async rateLimit(): Promise<unknown> {
    const r = await this.getJson<unknown>("https://api.github.com/rate_limit");
    return r.data;
  }
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

export function parseOriginRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const u = remoteUrl.trim();
  let m = u.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\s*$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}
