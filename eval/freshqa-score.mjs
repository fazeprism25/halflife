// Scores the latest FreshQA runs (eval/results/freshqa-{A,BC}-*.json) against the set's labels and
// the hand adjudications in eval/freshqa-adjudications.json. Writes eval/results/latest-freshqa.md.
//
//   node eval/freshqa-score.mjs
//
// Two different questions are scored separately and never blended:
//   A   freshness DETECTION: does Halflife treat a claim as time-sensitive when FreshQA says the
//       answer can change, and as time-invariant when it says it never changes?
//   B/C freshness VERIFICATION: for time-sensitive claims, does the live check say "outdated"
//       for answers known to be stale (B) and "current" for answers known current at the
//       snapshot (C)? This is not general factual accuracy: B and C only contain answers that
//       were correct at some point.

import fs from "node:fs";
import path from "node:path";
import { normAns } from "./freshqa-lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RES = path.join(ROOT, "eval/results");
const latest = (part) => {
  const f = fs.readdirSync(RES).filter((x) => x.startsWith(`freshqa-${part}-`) && x.endsWith(".json")).sort().at(-1);
  return f ? { file: f, ...JSON.parse(fs.readFileSync(path.join(RES, f), "utf8")) } : null;
};
const set = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "freshqa-set.json"), "utf8"));
const adjFile = path.join(import.meta.dirname, "freshqa-adjudications.json");
const ADJ = fs.existsSync(adjFile) ? JSON.parse(fs.readFileSync(adjFile, "utf8")).items : {};
const pct = (x) => (x == null || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);
const ratio = (a, b) => (b ? a / b : null);
const L = [];

// ------------------------------------------------------------------ A: detection
const A = latest("A");
let mA = null;
if (A) {
  const rs = A.results;
  const noClaim = rs.filter((r) => !r.claims.length);
  const scored = rs.filter((r) => r.claims.length);
  const predTS = (r) => r.any_time_sensitive;
  const tp = scored.filter((r) => predTS(r) && r.label === "time_sensitive");
  const fp = scored.filter((r) => predTS(r) && r.label === "time_invariant");
  const fn = scored.filter((r) => !predTS(r) && r.label === "time_sensitive");
  const tn = scored.filter((r) => !predTS(r) && r.label === "time_invariant");
  const byType = {};
  for (const r of rs) {
    const k = r.fact_type;
    byType[k] ??= { n: 0, no_claim: 0, flagged_ts: 0, at_risk: 0 };
    byType[k].n++;
    if (!r.claims.length) byType[k].no_claim++;
    if (predTS(r)) byType[k].flagged_ts++;
    if (r.claims.some((c) => c.triage === "not_checked")) byType[k].at_risk++; // assess-only: at risk = would have been checked
  }
  const p = ratio(tp.length, tp.length + fp.length), rc = ratio(tp.length, tp.length + fn.length);
  mA = { n: rs.length, no_claim: noClaim.length, tp: tp.length, fp: fp.length, fn: fn.length, tn: tn.length, precision: p, recall: rc, f1: p && rc ? (2 * p * rc) / (p + rc) : null,
    specificity: ratio(tn.length, tn.length + fp.length), credits: rs.reduce((s, r) => s + r.credits, 0), tokens: A.spend?.engine_tokens ?? null, byType,
    fpItems: fp, fnItems: fn, noClaim };
  L.push(
    `## A. Freshness detection (time-sensitive vs time-invariant)`, "",
    `Run \`${A.file}\` · ${A.model} · **assess-only** (no search, ${mA.credits} Tavily credits) · ${mA.tokens ?? "?"} DeepSeek tokens.`, "",
    `Ground truth: FreshQA \`fact_type\` of the 2026-04-21 snapshot (never-changing → time-invariant; slow/fast-changing → time-sensitive). Input: the FreshQA question and its first answer verbatim. Prediction: "time-sensitive" if any extracted claim is time-sensitive.`, "",
    `| Metric | Value |`, `|---|---|`,
    `| Items (50 never, 25 slow, 25 fast; TEST split, valid premise) | ${mA.n} |`,
    `| No claim extracted (not scored) | ${mA.no_claim} |`,
    `| Time-sensitive precision / recall / F1 | ${pct(mA.precision)} / ${pct(mA.recall)} / ${pct(mA.f1)} |`,
    `| Time-invariant correctly left unchecked (specificity) | ${pct(mA.specificity)} |`,
    `| TP / FP / FN / TN | ${mA.tp} / ${mA.fp} / ${mA.fn} / ${mA.tn} |`, "",
    `| FreshQA fact_type | n | no claim | flagged time-sensitive | at risk (≥θ, would be checked) |`, `|---|---|---|---|---|`,
    ...Object.entries(byType).map(([k, v]) => `| ${k} | ${v.n} | ${v.no_claim} | ${v.flagged_ts} | ${v.at_risk} |`), "",
    `**False positives** (never-changing, but treated as time-sensitive: this costs a search, it does not produce a wrong verdict):`, "",
    ...mA.fpItems.map((r) => `- ${r.id} — ${r.question} → “${r.text}” · ${r.claim?.class}`), "",
    `**False negatives** (can change, but treated as time-invariant: never checked, the real risk):`, "",
    ...mA.fnItems.map((r) => `- ${r.id} (${r.fact_type}) — ${r.question} → “${r.text}” · ${r.claim?.class ?? "–"}`), "",
    ...(mA.noClaim.length ? [`**No claim extracted:**`, "", ...mA.noClaim.map((r) => `- ${r.id} (${r.fact_type}) — ${r.question} → “${r.text}”`), ""] : []),
  );
}

// ------------------------------------------------------------------ B/C: verification
const BC = latest("BC");
let mBC = null;
if (BC) {
  const byId = new Map(set.items.map((x) => [x.id, x]));
  const pred = (r) => {
    const c = r.claim;
    if (!c) return "no_claim";
    if (!c.time_sensitive || c.triage === "static") return "static";
    if (c.verdict === "superseded" || c.verdict === "contradicted") return ["moderate", "strong"].includes(c.level) ? "stale" : "stale_weak";
    if (c.verdict === "current") return ["moderate", "strong"].includes(c.level) ? "current" : "current_weak";
    if (c.verdict === "unverifiable") return "unverifiable";
    return `not_checked${c.limitation ? `:${c.limitation.kind}` : ""}`;
  };
  const rs = BC.results.map((r) => ({ ...r, pred: pred(r), item: byId.get(r.id), adj: ADJ[r.id] ?? null }));
  // A B item whose 2024 answer is true again (adjudicated "changed_back") is not stale: excluded.
  const changedBack = rs.filter((r) => r.part === "B" && r.adj?.outcome === "changed_back");
  const B = rs.filter((r) => r.part === "B" && !changedBack.includes(r));
  const C = rs.filter((r) => r.part === "C");
  const isStale = (p, weak) => p === "stale" || (weak && p === "stale_weak");
  const isCurrent = (p, weak) => p === "current" || (weak && p === "current_weak");
  const decided = (p, weak) => isStale(p, weak) || isCurrent(p, weak);
  // C items judged stale are adjudicated by hand from the cited sources (eval/freshqa-adjudications.json):
  //   changed_after_snapshot → the snapshot answer really changed after 2026-04-21 (verdict right)
  //   not_changed            → a false positive
  //   unclear / missing      → counted as unadjudicated and reported, never as correct
  const score = (weak) => {
    const tp = B.filter((r) => isStale(r.pred, weak)).length;
    const fn = B.filter((r) => isCurrent(r.pred, weak)).length;
    const cStale = C.filter((r) => isStale(r.pred, weak));
    const fp = cStale.filter((r) => r.adj?.outcome === "not_changed").length;
    const later = cStale.filter((r) => r.adj?.outcome === "changed_after_snapshot").length;
    const unadj = cStale.length - fp - later;
    const tn = C.filter((r) => isCurrent(r.pred, weak)).length;
    const abstB = B.length - tp - fn, abstC = C.length - cStale.length - tn;
    return { tp, fn, fp, tn, later, unadj, abstB, abstC, precision: ratio(tp, tp + fp), precision_worst: ratio(tp, tp + fp + unadj), recall_decided: ratio(tp, tp + fn), recall_all: ratio(tp, B.length), coverageB: ratio(tp + fn, B.length), coverageC: ratio(cStale.length + tn, C.length) };
  };
  const strict = score(false), loose = score(true);
  // Replacement values on B: matched against FreshQA's 2026-04-21 answers; a mismatch is a later
  // change only if adjudicated so. Values are never counted correct without a match or adjudication.
  const vals = B.filter((r) => isStale(r.pred, true)).map((r) => {
    const v = r.claim.current_value;
    if (!v) return { id: r.id, v: null, outcome: "omitted" };
    const nv = normAns(v);
    const hit = r.item.gold_now.some((g) => { const ng = normAns(g); return ng && (nv.includes(ng) || ng.includes(nv)); });
    return { id: r.id, v, gold: r.item.gold_now[0], outcome: hit ? "matches_snapshot" : r.adj?.value ?? "mismatch_unadjudicated" };
  });
  const vc = (o) => vals.filter((x) => x.outcome === o).length;
  const levels = {};
  for (const r of rs.filter((x) => decided(x.pred, true))) {
    const k = `${r.part}:${r.claim.level}`;
    levels[k] = (levels[k] ?? 0) + 1;
  }
  const lat = rs.map((r) => r.latency_ms).sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  const searched = rs.filter((r) => r.credits > 0);
  mBC = { strict, loose, vals, credits: rs.reduce((s, r) => s + r.credits, 0), perClaim: ratio(searched.reduce((s, r) => s + r.credits, 0), searched.length), tokens: BC.spend?.engine_tokens ?? null, p50: q(0.5), p95: q(0.95) };
  const row = (name, s) => `| ${name} | ${s.tp} / ${s.fn} / ${s.abstB} | ${s.tn} / ${s.later} / ${s.fp} / ${s.unadj} / ${s.abstC} | ${pct(s.precision)} (worst case ${pct(s.precision_worst)}) | ${pct(s.recall_decided)} / ${pct(s.recall_all)} | ${pct(s.coverageB)} / ${pct(s.coverageC)} |`;
  L.push(
    `## B/C. Freshness verification (live Tavily + DeepSeek judge)`, "",
    `Run \`${BC.file}\` · ${BC.model} · ${mBC.credits} Tavily credits (${mBC.perClaim?.toFixed(2) ?? "–"} per searched claim) · ${mBC.tokens ?? "?"} DeepSeek tokens · latency p50 ${mBC.p50} ms, p95 ${mBC.p95} ms.`, "",
    `- **B** (${B.length}): FreshQA's 2024-02-26 answer to a question whose answer had changed by 2026-04-21. Known stale.`,
    `- Excluded from B after adjudication: ${changedBack.map((r) => r.id).join(", ") || "none"} (the 2024 answer became true again).`,
    `- **C** (${C.length}): the 2026-04-21 answer to the same questions. Known current on 2026-04-21 only; any "outdated" verdict is adjudicated by hand from the cited sources (\`eval/freshqa-adjudications.json\`).`, "",
    `| Counting | B: stale / judged current (FN) / abstained | C: current / later change confirmed / FP / unadjudicated / abstained | Stale precision | Stale recall (decided / all B) | Coverage B / C |`, `|---|---|---|---|---|---|`,
    row("Strict (≥ moderate evidence)", strict), row("Including weak evidence", loose), "",
    `A "current" verdict on C is counted as agreeing with the 2026-04-21 snapshot. It was not re-verified for every item; the cited evidence was spot-checked for C-388, C-437, C-450 and C-175 and is consistent (no newer change found).`, "",
    `Abstentions are "unverifiable", "not checked" (budget, cap, search failure) or a claim triaged time-invariant. They are not counted as correct.`, "",
    `**Replacement values** on B claims judged stale (${vals.length}): ${vc("matches_snapshot")} match FreshQA's 2026-04-21 answer · ${vc("later_change_confirmed")} differ because the answer changed again after 2026-04-21 (adjudicated) · ${vc("wrong")} wrong (adjudicated) · ${vc("mismatch_unadjudicated")} differ, not adjudicated · ${vc("omitted")} omitted (no verified quote states a value).`, "",
    `Decided verdicts by evidence level: ${Object.entries(levels).map(([k, v]) => `${k} ${v}`).join(", ")}.`, "",
    `| id | question | answer checked | pred | level | value reported | adjudication |`, `|---|---|---|---|---|---|---|`,
    ...rs.map((r) => `| ${r.id} | ${r.question.replace(/\|/g, "/")} | ${r.text.replace(/\|/g, "/")} | ${r.pred} | ${r.claim?.level ?? "–"} | ${(r.claim?.current_value ?? "").replace(/\|/g, "/")} | ${r.adj ? `${r.adj.outcome ?? ""}${r.adj.value ? ` value:${r.adj.value}` : ""}${r.adj.note ? ` — ${r.adj.note.replace(/\|/g, "/")}` : ""}` : ""} |`), "",
  );
}

// Tagged reruns after a fix (eval/freshqa-run.mjs --tag rerun-…) are listed, never merged into the
// metrics above: those stay as measured on the main run.
const reruns = fs.readdirSync(RES).filter((x) => x.startsWith("freshqa-rerun-") && x.endsWith(".json")).sort();
const lastPerTag = new Map(reruns.map((f) => [f.replace(/-\d{4}-\d{2}-\d{2}T.*$/, ""), f]));
if (lastPerTag.size) {
  L.push(`## Post-fix reruns (not merged into the metrics above)`, "");
  for (const f of lastPerTag.values()) {
    const j = JSON.parse(fs.readFileSync(path.join(RES, f), "utf8"));
    L.push(`\`${f}\` (${j.spend?.engine_credits ?? "?"} credits):`, "", ...j.results.map((r) => `- ${r.id}: ${r.claim?.triage}/${r.claim?.verdict ?? "–"}/${r.claim?.level ?? "–"}${r.claim?.limitation ? ` [${r.claim.limitation.kind}]` : ""}${r.claim?.current_value ? ` now: ${r.claim.current_value}` : ""}`), "");
  }
}

const head = [
  `# Halflife evaluation — FreshQA (${set.version})`, "",
  `Generated ${new Date().toISOString()} by \`eval/freshqa-score.mjs\`. Set built by \`eval/freshqa-build.mjs\` (seed \`${set.seed}\`) from two public FreshQA snapshots:`, "",
  ...Object.values(set.source.snapshots).map((s) => `- ${s.date}: ${s.url} (sha256 \`${s.sha256.slice(0, 16)}…\`, file \`eval/data/freshqa/${s.file}\`)`), "",
  `Source: ${set.source.dataset}, ${set.source.repo} (${set.source.license}).`, "",
  `**What this measures:** freshness detection and freshness verification. It does **not** measure general factual accuracy. Halflife does not check time-invariant claims, and every B/C answer was correct at some date.`, "",
  `**Ground-truth limits:**`, "", ...set.ground_truth_limits.map((x) => `- ${x}`), "",
  `Excluded from B/C before sampling: ${set.counts.excluded} changed items with date-relative questions ("this year", "how old") or yes/no or vague answers (listed in \`eval/freshqa-set.json\`).`, "",
];
fs.writeFileSync(path.join(RES, "latest-freshqa.md"), [...head, ...L].join("\n") + "\n");
console.log(JSON.stringify({ A: mA && { ...mA, fpItems: mA.fpItems.length, fnItems: mA.fnItems.length, noClaim: mA.noClaim.length }, BC: mBC && { strict: mBC.strict, loose: mBC.loose, credits: mBC.credits } }, null, 1));
