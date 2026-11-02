// Tavily access through the Bifrost relay /relay/tavily/*. Bifrost holds the Tavily key
// (the engine never sees it), prices each call by usage.credits and enforces the engine
// virtual key's budget, answering 402 when it is exhausted (AD-07, AD-10).

export type SearchParams = {
  query: string;
  topic: "general" | "news" | "finance";
  maxResults: number;
  depth: "basic" | "advanced";
};

export type SearchResult = {
  url: string;
  title: string;
  content: string;
  score: number;
  published_date: string | null;
};

import { parseUsage, type AccountUsage } from "./credits.ts";

export type SearchResponse = { results: SearchResult[]; credits: number; ms: number };
export type ExtractResponse = { results: { url: string; content: string }[]; failed: string[]; credits: number; ms: number };

export interface Search {
  readonly kind: "tavily" | "test";
  search(p: SearchParams, signal?: AbortSignal): Promise<SearchResponse>;
  extract(urls: string[], query: string, signal?: AbortSignal): Promise<ExtractResponse>;
  /** Account usage (free, no credits). Only the real Tavily client implements it. */
  usage?(): Promise<AccountUsage>;
}

export class SearchError extends Error {
  kind: "budget" | "rate_limit" | "auth" | "http" | "timeout" | "network" | "parse";
  status: number;
  retryAfterMs: number;
  constructor(kind: SearchError["kind"], message: string, status = 0, retryAfterMs = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type TavilyOptions = {
  bifrostUrl: string;
  virtualKey: string;
  searchTimeoutMs: number;
  extractTimeoutMs: number;
  fetchImpl?: typeof fetch;
};

export class TavilyViaBifrost implements Search {
  readonly kind = "tavily" as const;
  private o: TavilyOptions;
  private f: typeof fetch;
  constructor(o: TavilyOptions) {
    this.o = o;
    this.f = o.fetchImpl ?? fetch;
  }

  async search(p: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    const body = {
      query: p.query.slice(0, 400),
      topic: p.topic,
      search_depth: p.depth,
      max_results: p.maxResults,
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
      include_published_date: true,
    };
    const { json, ms } = await this.post("/search", body, this.o.searchTimeoutMs, signal);
    const results: SearchResult[] = Array.isArray(json?.results)
      ? json.results
          .filter((r: any) => typeof r?.url === "string")
          .map((r: any) => ({
            url: String(r.url),
            title: String(r.title ?? ""),
            content: String(r.content ?? "").slice(0, 4000),
            score: Number(r.score ?? 0),
            published_date: typeof r.published_date === "string" && r.published_date ? r.published_date : null,
          }))
      : [];
    return { results, credits: creditsOf(json, p.depth === "advanced" ? 2 : 1), ms };
  }

  async extract(urls: string[], query: string, signal?: AbortSignal): Promise<ExtractResponse> {
    const body = { urls: urls.slice(0, 5), query: query.slice(0, 400), chunks_per_source: 3, extract_depth: "basic", include_usage: true };
    const { json, ms } = await this.post("/extract", body, this.o.extractTimeoutMs, signal);
    const results = Array.isArray(json?.results)
      ? json.results.filter((r: any) => typeof r?.url === "string").map((r: any) => ({ url: String(r.url), content: String(r.raw_content ?? r.content ?? "").slice(0, 8000) }))
      : [];
    const failed = Array.isArray(json?.failed_results) ? json.failed_results.map((r: any) => String(r?.url ?? r)) : [];
    return { results, failed, credits: creditsOf(json, Math.ceil(results.length / 5)), ms };
  }

  async usage(): Promise<AccountUsage> {
    const res = await this.f(`${this.o.bifrostUrl}/relay/tavily/usage`, { headers: { "x-bf-vk": this.o.virtualKey }, signal: AbortSignal.timeout(this.o.searchTimeoutMs) });
    if (!res.ok) throw new SearchError(res.status === 402 ? "budget" : "http", `Tavily /usage HTTP ${res.status}`, res.status);
    return parseUsage(await res.json());
  }

  private async post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ json: any; ms: number }> {
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.f(`${this.o.bifrostUrl}/relay/tavily${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bf-vk": this.o.virtualKey },
        body: JSON.stringify(body),
        signal: sig,
      });
    } catch (e) {
      if (timeout.aborted || signal?.aborted) throw new SearchError("timeout", `Tavily ${path} exceeded ${timeoutMs} ms`);
      throw new SearchError("network", `Tavily ${path} unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    // 402: Bifrost relay budget exhausted. 432/433: Tavily plan / pay-as-you-go limit.
    if (res.status === 402 || res.status === 432 || res.status === 433) throw new SearchError("budget", `search budget exhausted (HTTP ${res.status})`, res.status);
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      throw new SearchError("rate_limit", "Tavily rate limit", 429, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000);
    }
    if (res.status === 401 || res.status === 403) throw new SearchError("auth", `Tavily rejected the credential (HTTP ${res.status})`, res.status);
    if (!res.ok) throw new SearchError("http", `Tavily ${path} HTTP ${res.status}`, res.status);
    try {
      return { json: JSON.parse(text), ms };
    } catch {
      throw new SearchError("parse", `Tavily ${path} returned non-JSON`);
    }
  }
}

function creditsOf(json: any, fallback: number): number {
  const c = Number(json?.usage?.credits);
  return Number.isFinite(c) && c >= 0 ? c : fallback;
}
