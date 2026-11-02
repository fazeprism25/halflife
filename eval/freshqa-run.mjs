// Runs the FreshQA set (eval/freshqa-set.json, built by eval/freshqa-build.mjs) through the REAL
// stack: /v1/check via the Bifrost relay → DeepSeek extraction → freshness model → (B/C only)
// Tavily → verdict. Nothing is a fixture. Raw outcomes only; scoring is eval/freshqa-score.mjs.
//
//   node eval/freshqa-run.mjs --part A        # assess-only: 0 Tavily credits
//   node eval/freshqa-run.mjs --part BC       # live verification: ≤ 2 credits per item, guarded
//   [--only id,id] [--concurrency 3]
//
// Output: eval/results/freshqa-<part>-<timestamp>.json

import fs from "node:fs";
import path from "node:path";
import { preflight, readEnv, reconcile } from "../deploy/test/spend-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const GW = process.env.GW ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "deepseek/deepseek-flash";
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PART = arg("--part", "A");
if (!["A", "BC"].includes(PART)) throw new Error("--part A|BC");
const only = arg("--only", "") ? arg("--only").split(",") : null;
const CONC = Number(arg("--concurrency", "3"));
const set = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "freshqa-set.json"), "utf8"));
const items = set.items.filter((x) => PART.includes(x.part) && (!only || only.includes(x.id)));
const verify = PART !== "A";
const env = readEnv();
const VK = { "x-bf-vk": env.HALFLIFE_DEMO_VK };

const before = await preflight({ plannedCredits: verify ? 2 * items.length : 0, label: `eval freshqa ${PART} n=${items.length}` });
const status = async () => (await (await fetch(`${GW}/relay/halflife/v1/status`, { headers: VK })).json()).spend;
const s0 = await status();

function primary(claims) {
  // The claim the answer is about: one with a verdict, else the riskiest time-sensitive one.
  if (!claims?.length) return null;
  const score = (c) => (c.verdict ? 2 : 0) + (c.time_sensitive ? 1 : 0) + (c.p_outdated?.hi ?? 0) / 10;
  return [...claims].sort((a, b) => score(b) - score(a))[0];
}

async function runOne(it) {
  const t0 = Date.now();
  const body = { text: it.text, question: it.question, model: MODEL, wait: true, learn: false, // evaluation traffic never trains the class model
    ...(verify ? {} : { verify: false }) };
  const r = await fetch(`${GW}/relay/halflife/v1/check`, { method: "POST", headers: { "content-type": "application/json", ...VK }, body: JSON.stringify(body) });
  const rep = await r.json().catch(() => ({}));
  const c = primary(rep.claims);
  const out = {
    id: it.id, part: it.part, fact_type: it.fact_type, label: it.label, question: it.question, text: it.text,
    http: r.status, report_id: rep.id, status: rep.status, extraction: rep.extraction, latency_ms: Date.now() - t0,
    credits: rep.credits ?? 0, llm_calls: rep.llm_calls ?? 0, tokens: rep.summary?.tokens ?? null,
    claims: (rep.claims ?? []).map((x) => ({ statement: x.statement, class: x.class?.id, time_sensitive: x.time_sensitive, triage: x.triage })),
    any_time_sensitive: (rep.claims ?? []).some((x) => x.time_sensitive),
    claim: c && {
      statement: c.statement, class: c.class?.id, time_sensitive: c.time_sensitive, triage: c.triage, verdict: c.verdict, level: c.evidence_level,
      current_value: c.current_value, changed_on: c.changed_on, p_outdated: c.p_outdated ? [c.p_outdated.lo, c.p_outdated.hi] : null,
      limitation: c.limitation, search_query: c.search_query, explanation: c.explanation, level_reasons: c.level_reasons,
      sources: (c.evidence ?? []).map((e) => ({ eid: e.eid, site: e.site, url: e.url, published: e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : null, stance: e.stance, quote_valid: e.quote_valid, quote: e.quote })),
    },
  };
  console.log(`${it.id.padEnd(7)} ${it.label.padEnd(19)} ${c ? `${c.time_sensitive ? "TS" : "--"} ${c.class?.id} ${c.triage}/${c.verdict ?? "-"}/${c.evidence_level ?? "-"}` : "no claim"} ${out.credits}cr ${out.latency_ms}ms${c?.current_value ? ` now=${c.current_value}` : ""}`);
  return out;
}

const results = [];
const queue = [...items];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) results.push(await runOne(queue.shift()));
}));
results.sort((a, b) => items.findIndex((x) => x.id === a.id) - items.findIndex((x) => x.id === b.id));
const s1 = await status();
await new Promise((r) => setTimeout(r, 2000));
const spend = await reconcile(before, { engine_credits: s1.total_credits - s0.total_credits, engine_tokens: (s1.total_tokens ?? 0) - (s0.total_tokens ?? 0) });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const TAG = arg("--tag", PART); // a tagged rerun never replaces the main run the scorer reads
const file = path.join(ROOT, `eval/results/freshqa-${TAG}-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), set: set.version, part: PART, model: MODEL, spend, results }, null, 2));
console.log(`\nwrote ${path.relative(ROOT, file)} · engine credits ${spend.engine_credits ?? "?"} · tokens ${spend.engine_tokens ?? "?"}`);
