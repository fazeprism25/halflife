// LIVE end-to-end run: real prompts through the gateway, answered by DeepSeek, captured by the
// plugin, analysed by the engine (extraction → freshness → Tavily → verdict → cache policy).
// NOTHING here is a fixture. Spend is bounded by the guard (≤ 6 credits per prompt planned).
//
//   node deploy/test/live-e2e.mjs [caseId ...]      (stack running)
//
// Each case lists what a careful human expects, written BEFORE the run, so discrepancies are
// visible rather than tuned away. Results: deploy/test/results/live-e2e.json (appended per run).

import fs from "node:fs";
import path from "node:path";
import { preflight, readEnv, reconcile } from "./spend-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GW = process.env.GW ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "deepseek/deepseek-flash";
const env = readEnv();
const VK = { "x-bf-vk": env.HALFLIFE_DEMO_VK };

export const CASES = [
  { id: "stable", kind: "stable factual claim",
    prompt: "Answer in one short sentence each: In what year was the Battle of Hastings fought? What is the chemical symbol for gold?",
    expect: "Both claims static: triage 'static' (no credits) or, if checked, verdict current." },
  { id: "pricing", kind: "potentially outdated pricing claim",
    prompt: "In two short sentences: how much does a ChatGPT Plus subscription cost per month in USD, and how much does a YouTube Premium individual plan cost per month in the US?",
    expect: "Price claims triaged to verify. ChatGPT Plus has been $20/month; YouTube Premium individual rose to $13.99 in 2023 (an older model may say $11.99 → superseded)." },
  { id: "leadership", kind: "leadership claim",
    prompt: "In one short sentence each: who is the CEO of Intel, and who is the CEO of Starbucks?",
    expect: "Leadership claims verified. Intel: Lip-Bu Tan since March 2025 (Pat Gelsinger → superseded). Starbucks: Brian Niccol since Sept 2024 (Laxman Narasimhan → superseded)." },
  { id: "version", kind: "software/API version claim",
    prompt: "In two short sentences: what is the latest major version of Node.js, and what is the latest major version of the React library?",
    expect: "Version claims verified. React 19 (Dec 2024) is current unless a newer major shipped; Node.js majors ship each April/October (Node 25 Oct 2025, Node 26 expected Apr 2026, Node 27 expected Oct 2026)." },
  { id: "conflict", kind: "claim with conflicting sources",
    prompt: "In two short sentences: which country has the largest population in the world, and approximately what is its population?",
    expect: "India overtook China in 2023 (UN estimate). Population figures differ by source (UN vs national estimates ~1.43–1.46 billion): expect conflicting/approximate evidence; a 'current' or 'unverifiable' verdict is acceptable, an exact figure is not robust." },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(prompt) {
  const t0 = Date.now();
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", ...VK },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, temperature: 0, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json().catch(() => null);
  const h = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-halflife-")));
  return { status: r.status, ms: Date.now() - t0, headers: h, answer: j?.choices?.[0]?.message?.content ?? null, usage: j?.usage ?? null, cache_hit: j?.extra_fields?.cache_debug?.cache_hit ?? null, error: r.ok ? null : JSON.stringify(j).slice(0, 300) };
}

async function waitReport(id) {
  for (let i = 0; i < 180; i++) {
    const r = await fetch(`${GW}/relay/halflife/v1/reports/${id}`, { headers: VK });
    if (r.ok) {
      const j = await r.json();
      if (["done", "failed", "linked"].includes(j.status)) return j;
    }
    await sleep(1000);
  }
  throw new Error(`report ${id} did not finish in 180 s`);
}

const status = async () => (await (await fetch(`${GW}/relay/halflife/v1/status`, { headers: VK })).json()).spend;

const pick = process.argv.slice(2);
const cases = CASES.filter((c) => !pick.length || pick.includes(c.id));
const before = await preflight({ plannedCredits: 6 * cases.length, label: `live-e2e ${cases.map((c) => c.id).join(",")}` });
const s0 = await status();
const runs = [];
for (const c of cases) {
  const t0 = Date.now();
  const g = await chat(c.prompt);
  const run = { id: c.id, kind: c.kind, prompt: c.prompt, expect: c.expect, gateway: { status: g.status, latency_ms: g.ms, headers: g.headers, usage: g.usage, cache_hit: g.cache_hit, error: g.error }, answer: g.answer };
  if (g.status === 200 && g.headers["x-halflife-report"]) {
    const rep = await waitReport(g.headers["x-halflife-report"]);
    run.report = {
      id: rep.id, status: rep.status, error: rep.error, extraction: rep.extraction, extraction_note: rep.extraction_note, credits: rep.credits, llm_calls: rep.llm_calls,
      total_ms: Date.now() - t0, engine_ms: rep.finished_at && rep.started_at ? rep.finished_at - rep.started_at : null, timing: rep.summary?.timing ?? null, search_queries: rep.claims.map((x) => x.search_query),
      cache: rep.cache,
      claims: rep.claims.map((x) => ({
        text: x.text, class: x.class?.id, as_of: x.as_of?.label,
        // The three measures, kept separate (AD-09).
        A_expected_half_life_years: x.half_life_years ?? null,
        B_p_outdated: x.p_outdated ? [x.p_outdated.lo, x.p_outdated.hi] : null,
        C_evidence_level: x.evidence_level, level_reasons: x.level_reasons,
        triage: x.triage, verdict: x.verdict, current_value: x.current_value, changed_on: x.changed_on, explanation: x.explanation,
        limitation: x.limitation, tiers: x.tiers, credits: x.credits,
        evidence: (x.evidence ?? []).map((e) => ({ tier: e.tier, site: e.site, url: e.url, published: e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : null, stance: e.stance, quote_valid: e.quote_valid, quote: e.quote })),
      })),
    };
  }
  runs.push(run);
  console.log(`\n### ${c.id} (${c.kind}) HTTP ${g.status} answer ${g.ms} ms; report ${run.report?.status ?? "-"} in ${run.report?.total_ms ?? "-"} ms, ${run.report?.credits ?? 0} credits, extraction ${run.report?.extraction ?? "-"}`);
  console.log(`answer: ${String(g.answer ?? g.error).replace(/\s+/g, " ").slice(0, 300)}`);
  for (const x of run.report?.claims ?? []) {
    console.log(` - [${x.class}] ${x.text}\n     triage=${x.triage} verdict=${x.verdict ?? "-"} level=${x.C_evidence_level ?? "-"} P(out)=${x.B_p_outdated?.map((v) => v?.toFixed?.(2)).join("–")} now=${x.current_value ?? "-"}${x.limitation ? ` limitation=${x.limitation.kind}` : ""}`);
  }
  console.log(`expected: ${c.expect}`);
}
const s1 = await status();
await sleep(3000);
const spend = await reconcile(before, { engine_credits: s1.total_credits - s0.total_credits, engine_tokens: s1.today.tokens - s0.today.tokens, engine_llm_calls: s1.today.llm_calls - s0.today.llm_calls });
const file = path.join(ROOT, "deploy/test/results/live-e2e.json");
let all = [];
try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
all.push({ at: new Date().toISOString(), model: MODEL, spend, guard: s1.guard, runs });
fs.writeFileSync(file, JSON.stringify(all, null, 2));
console.log(`\nresults appended to deploy/test/results/live-e2e.json`);
