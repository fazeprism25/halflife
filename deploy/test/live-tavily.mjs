// LIVE minimal Tavily check through the Bifrost relay (the product path), with the engine's
// exact request parameters. Spends at most 2 credits: 1 basic search + 1 extract of 1 URL.
// Reconciles the credits Tavily reported per call against the account /usage counter.
//
//   node deploy/test/live-tavily.mjs     (stack running)

import fs from "node:fs";
import path from "node:path";
import { preflight, readEnv, reconcile } from "./spend-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GW = process.env.GW ?? "http://127.0.0.1:8080";
const env = readEnv();
const before = await preflight({ plannedCredits: 2, label: "live-tavily" });

async function relay(p, body) {
  const t0 = Date.now();
  const r = await fetch(`${GW}/relay/tavily${p}`, { method: "POST", headers: { "content-type": "application/json", "x-bf-vk": env.HALFLIFE_ENGINE_VK }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  return { status: r.status, ms: Date.now() - t0, j };
}

const out = { at: new Date().toISOString() };
const query = "latest stable Python release version";
// Identical to engine/src/tavily.ts search() for T1.
const s = await relay("/search", { query, topic: "general", search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false, include_usage: true, include_published_date: true });
const results = s.j?.results ?? [];
out.search = {
  status: s.status, latency_ms: s.ms, reported_credits: s.j?.usage?.credits ?? null, n: results.length,
  urls_valid: results.every((x) => { try { return ["http:", "https:"].includes(new URL(x.url).protocol); } catch { return false; } }),
  with_published_date: results.filter((x) => x.published_date).length,
  results: results.map((x) => ({ url: x.url, published_date: x.published_date ?? null, parsed: x.published_date ? new Date(x.published_date).toISOString() : null, score: x.score, content_chars: (x.content ?? "").length, snippet: (x.content ?? "").slice(0, 160) })),
};
console.log(`search: HTTP ${s.status} ${s.ms} ms, ${results.length} results, ${out.search.with_published_date} dated, credits ${out.search.reported_credits}`);

if (results[0]) {
  // Identical to engine/src/tavily.ts extract() for T2, but only one URL.
  const x = await relay("/extract", { urls: [results[0].url], query, chunks_per_source: 3, extract_depth: "basic", include_usage: true });
  out.extract = { status: x.status, latency_ms: x.ms, reported_credits: x.j?.usage?.credits ?? null, ok: (x.j?.results ?? []).length, failed: (x.j?.failed_results ?? []).length, content_chars: (x.j?.results?.[0]?.raw_content ?? "").length, mentions_python: /python\s+3\.\d+/i.test(x.j?.results?.[0]?.raw_content ?? "") };
  console.log(`extract: HTTP ${x.status} ${x.ms} ms, ok ${out.extract.ok}, failed ${out.extract.failed}, credits ${out.extract.reported_credits}`);
}

// Tavily's counter can lag; wait briefly before reconciling.
await new Promise((r) => setTimeout(r, 4000));
const reported = (out.search.reported_credits ?? 0) + (out.extract?.reported_credits ?? 0);
out.spend = await reconcile(before, { reported_credits: reported, outside_engine_credits: reported });
fs.writeFileSync(path.join(ROOT, "deploy/test/results/live-tavily.json"), JSON.stringify(out, null, 2));
