// Tavily feasibility probe. Requires TAVILY_API_KEY in the environment (never printed).
// Measures: latency, published_date coverage, credits used (include_usage), and the effect
// of start_date / topic / max_age_hours on freshness-relevant evidence.
// Usage: node experiments/feasibility/tavily_probe.mjs > experiments/feasibility/results/tavily.json
const KEY = process.env.TAVILY_API_KEY;
if (!KEY) {
  console.error("TAVILY_API_KEY not set; skipping live Tavily probe.");
  process.exit(2);
}

const claims = [
  { claim: "The CEO of Twitter (X) is Elon Musk", topic: "news", cutoff: "2024-07-01" },
  { claim: "The latest stable version of Python is 3.12", topic: "general", cutoff: "2024-01-01" },
  { claim: "The Federal Reserve target rate is 5.25-5.50%", topic: "finance", cutoff: "2024-06-01" },
];

async function call(path, body) {
  const t0 = performance.now();
  const r = await fetch(`https://api.tavily.com/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ ...body, include_usage: true }),
  });
  const ms = Math.round(performance.now() - t0);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, ms, json };
}

const out = [];
for (const c of claims) {
  const variants = {
    basic_plain: { query: c.claim, search_depth: "basic", topic: c.topic, max_results: 5, include_published_date: true },
    basic_since_cutoff: { query: c.claim, search_depth: "basic", topic: c.topic, max_results: 5, include_published_date: true, start_date: c.cutoff },
    advanced_since_cutoff: { query: c.claim, search_depth: "advanced", topic: c.topic, max_results: 5, chunks_per_source: 2, include_published_date: true, start_date: c.cutoff },
  };
  for (const [name, body] of Object.entries(variants)) {
    const { status, ms, json } = await call("search", body);
    const results = json.results ?? [];
    out.push({
      claim: c.claim, variant: name, status, latency_ms: ms,
      credits: json.usage?.credits ?? null,
      n_results: results.length,
      n_with_published_date: results.filter((x) => x.published_date).length,
      published_dates: results.map((x) => x.published_date ?? null),
      top_urls: results.slice(0, 3).map((x) => x.url),
    });
  }
  // Targeted extract of the top 2 URLs from the since-cutoff search, reranked by the claim.
  const seed = out.filter((o) => o.claim === c.claim && o.variant === "basic_since_cutoff")[0];
  if (seed?.top_urls?.length) {
    const { status, ms, json } = await call("extract", { urls: seed.top_urls.slice(0, 2), query: c.claim, chunks_per_source: 2 });
    out.push({ claim: c.claim, variant: "extract_top2", status, latency_ms: ms, credits: json.usage?.credits ?? null,
      n_results: (json.results ?? []).length, n_failed: (json.failed_results ?? []).length });
  }
}
console.log(JSON.stringify(out, null, 2));
