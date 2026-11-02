// Evaluation harness: runs the hand-labelled set (eval/labelled.mjs) through the REAL stack
// (/v1/check via the Bifrost relay → DeepSeek extraction → freshness → Tavily → verdict) and
// scores it against the pre-registered labels. Nothing is a fixture.
//
//   node eval/run.mjs [--only id,id] [--concurrency 2]
//
// Spend is bounded by the guard (deploy/test/spend-guard.mjs) and by the engine's own caps.
// Output: eval/results/run-<timestamp>.json and eval/results/latest.md.

import fs from "node:fs";
import path from "node:path";
import { preflight, readEnv, reconcile } from "../deploy/test/spend-guard.mjs";
import { ITEMS as ITEMS_V1, ITEMS_V2, SET_V2, SET_VERSION as SET_V1 } from "./labelled.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const GW = process.env.GW ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "deepseek/deepseek-flash";
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const SETS = { v1: [SET_V1, ITEMS_V1], v2: [SET_V2, ITEMS_V2] };
const [SET_VERSION, ITEMS] = SETS[arg("--set", "v1")];
const only = arg("--only", "") ? arg("--only").split(",") : null;
const CONC = Number(arg("--concurrency", "2"));
const env = readEnv();
const VK = { "x-bf-vk": env.HALFLIFE_DEMO_VK };

const items = ITEMS.filter((x) => !only || only.includes(x.id));
// ≤ 2 credits per claim (T1 search + T2 extract); static items should cost 0.
const before = await preflight({ plannedCredits: 2 * items.length, label: `eval ${SET_VERSION} n=${items.length}` });
const status = async () => (await (await fetch(`${GW}/relay/halflife/v1/status`, { headers: VK })).json()).spend;
const s0 = await status();

async function runOne(it) {
  const t0 = Date.now();
  const r = await fetch(`${GW}/relay/halflife/v1/check`, { method: "POST", headers: { "content-type": "application/json", ...VK }, body: JSON.stringify({ text: it.text, model: MODEL, wait: true, learn: false }) });
  const rep = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;
  const c = rep.claims?.[0] ?? null;
  const out = {
    id: it.id, cat: it.cat, text: it.text, label: it.label, conf: it.conf, truth: it.truth,
    http: r.status, report_id: rep.id, status: rep.status, extraction: rep.extraction, n_claims: rep.claims?.length ?? 0, latency_ms: ms, credits: rep.credits ?? 0, llm_calls: rep.llm_calls ?? 0,
    claim: c && {
      text: c.text, class: c.class?.id, triage: c.triage, verdict: c.verdict, current_value: c.current_value,
      A_half_life_years: c.half_life_years, B_p_outdated: c.p_outdated ? [c.p_outdated.lo, c.p_outdated.hi] : null, C_evidence_level: c.evidence_level,
      level_reasons: c.level_reasons, limitation: c.limitation, search_query: c.search_query, explanation: c.explanation,
      sources: (c.evidence ?? []).map((e) => ({ site: e.site, published: e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : null, stance: e.stance, quote_valid: e.quote_valid, quote: e.quote })),
    },
  };
  out.pred = predict(out.claim);
  out.correct = out.pred === "abstain" || it.label === "ambiguous" ? null : out.pred === it.label;
  console.log(`${out.correct === null ? "  ?" : out.correct ? " ok" : "BAD"}  ${it.id.padEnd(10)} label=${it.label.padEnd(7)} pred=${out.pred.padEnd(7)} ${c ? `${c.triage}/${c.verdict ?? "-"}/${c.evidence_level ?? "-"}` : "no claim"} ${out.credits}cr ${ms}ms${c?.limitation ? ` [${c.limitation.kind}]` : ""}`);
  return out;
}

/**
 * Halflife's prediction: stale (superseded|contradicted), current (verdict current), or abstain.
 * A claim triaged "static" (time-invariant) is NOT checked, so it is an abstention, not
 * "current": Halflife checks freshness, not the correctness of facts that cannot go stale.
 * (Scored as "current" in the first v1 run; changed after v2 exposed wrong static values.)
 */
function predict(c) {
  if (!c) return "abstain";
  if (c.triage === "static") return "abstain";
  if (c.verdict === "superseded" || c.verdict === "contradicted") return "stale";
  if (c.verdict === "current") return "current";
  return "abstain";
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

// ---- metrics
const m = metrics(results);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.mkdirSync(path.join(ROOT, "eval/results"), { recursive: true });
fs.writeFileSync(path.join(ROOT, `eval/results/run-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), set: SET_VERSION, model: MODEL, spend, metrics: m, results }, null, 2));
fs.writeFileSync(path.join(ROOT, `eval/results/latest-${SET_VERSION.slice(0, 2)}.md`), report(m, results, spend));
console.log("\n" + JSON.stringify(m, null, 1));

function metrics(all) {
  const rs = all.filter((r) => r.label !== "ambiguous");
  const ambiguous = all.filter((r) => r.label === "ambiguous").map((r) => ({ id: r.id, pred: r.pred, verdict: r.claim?.verdict ?? null, level: r.claim?.C_evidence_level ?? null }));
  const decided = rs.filter((r) => r.pred !== "abstain");
  const tp = rs.filter((r) => r.pred === "stale" && r.label === "stale").length;
  const fp = rs.filter((r) => r.pred === "stale" && r.label === "current").length;
  const fn = rs.filter((r) => r.pred !== "stale" && r.label === "stale").length;
  const fnDecided = rs.filter((r) => r.pred === "current" && r.label === "stale").length;
  const byLevel = {};
  for (const r of decided) {
    const k = r.claim?.triage === "static" ? "static (not searched)" : r.claim?.C_evidence_level ?? "none";
    byLevel[k] ??= { n: 0, correct: 0 };
    byLevel[k].n++;
    if (r.correct) byLevel[k].correct++;
  }
  const byCat = {};
  for (const r of rs) {
    byCat[r.cat] ??= { n: 0, decided: 0, correct: 0 };
    byCat[r.cat].n++;
    if (r.pred !== "abstain") byCat[r.cat].decided++;
    if (r.correct) byCat[r.cat].correct++;
  }
  // Brier score of B = P(outdated now) (interval midpoint) against the label, for time-sensitive
  // claims only. B is a prior from the class model and as-of date, NOT a verdict: it is reported
  // to track calibration, and is labelled uncalibrated in the product.
  const ts = rs.filter((r) => r.claim?.B_p_outdated && r.claim.triage !== "static");
  const brier = ts.length ? ts.reduce((s, r) => s + ((r.claim.B_p_outdated[0] + r.claim.B_p_outdated[1]) / 2 - (r.label === "stale" ? 1 : 0)) ** 2, 0) / ts.length : null;
  const lat = rs.map((r) => r.latency_ms).sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const searched = rs.filter((r) => r.claim && !["static", "reused"].includes(r.claim.triage));
  return {
    n: rs.length, decided: decided.length, abstained: rs.length - decided.length, coverage: +(decided.length / rs.length).toFixed(3),
    accuracy_on_decided: decided.length ? +(decided.filter((r) => r.correct).length / decided.length).toFixed(3) : null,
    stale: { tp, fp, fn, fn_decided_current: fnDecided, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null },
    by_evidence_level: byLevel, by_category: byCat,
    brier_p_outdated_uncalibrated: brier == null ? null : +brier.toFixed(3), brier_n: ts.length,
    static_not_checked: rs.filter((r) => r.claim?.triage === "static").map((r) => ({ id: r.id, label: r.label })),
    static_items_spending_credits: rs.filter((r) => r.cat === "static" && r.credits > 0).length,
    credits_total: rs.reduce((s, r) => s + r.credits, 0), credits_per_searched_claim: searched.length ? +(searched.reduce((s, r) => s + r.credits, 0) / searched.length).toFixed(2) : null,
    latency_ms: { p50: q(0.5), p95: q(0.95), max: lat.at(-1) },
    ambiguous,
    limitations: rs.reduce((o, r) => (r.claim?.limitation ? ((o[r.claim.limitation.kind] = (o[r.claim.limitation.kind] ?? 0) + 1), o) : o), {}),
  };
}

function report(m, rs, spend) {
  const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
  const lines = [
    `# Halflife evaluation — ${SET_VERSION}`, "",
    `Run ${new Date().toISOString()} · judge \`${MODEL}\` (thinking off) · real Tavily via the Bifrost relay · labels pre-registered in \`eval/labelled.mjs\`.`, "",
    `| Metric | Value |`, `|---|---|`,
    `| Items | ${m.n} |`, `| Decided (coverage) | ${m.decided} (${pct(m.coverage)}) |`, `| Accuracy on decided | ${pct(m.accuracy_on_decided)} |`,
    `| Stale precision / recall | ${pct(m.stale.precision)} / ${pct(m.stale.recall)} (tp ${m.stale.tp}, fp ${m.stale.fp}, fn ${m.stale.fn}; stale judged current: ${m.stale.fn_decided_current}) |`,
    `| Brier, P(outdated) midpoint (uncalibrated prior, n=${m.brier_n}) | ${m.brier_p_outdated_uncalibrated ?? "–"} |`,
    `| Credits total / per searched claim | ${m.credits_total} / ${m.credits_per_searched_claim} |`,
    `| Static items that spent credits | ${m.static_items_spending_credits} |`,
    `| Latency p50 / p95 / max (ms) | ${m.latency_ms.p50} / ${m.latency_ms.p95} / ${m.latency_ms.max} |`,
    `| Tavily credits (run, local count) / DeepSeek tokens | ${spend.engine_credits ?? "?"} / ${spend.engine_tokens ?? "?"} |`, "",
    `## Accuracy by evidence level`, "", `| Level | n | correct |`, `|---|---|---|`,
    ...Object.entries(m.by_evidence_level).map(([k, v]) => `| ${k} | ${v.n} | ${v.correct} (${pct(v.correct / v.n)}) |`), "",
    `## By category`, "", `| Category | n | decided | correct |`, `|---|---|---|---|`,
    ...Object.entries(m.by_category).map(([k, v]) => `| ${k} | ${v.n} | ${v.decided} | ${v.correct} |`), "",
    `## Items`, "", `| id | label | pred | triage/verdict/level | credits | note |`, `|---|---|---|---|---|---|`,
    ...rs.map((r) => `| ${r.id} | ${r.label} | ${r.pred}${r.correct === false ? " ✗" : ""} | ${r.claim ? `${r.claim.triage}/${r.claim.verdict ?? "–"}/${r.claim.C_evidence_level ?? "–"}` : "no claim"} | ${r.credits} | ${(r.claim?.limitation?.kind ?? (r.claim?.current_value ? `now: ${r.claim.current_value}` : "")).replace(/\|/g, "/")} |`),
  ];
  return lines.join("\n") + "\n";
}
