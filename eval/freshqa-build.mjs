// Builds the FreshQA evaluation set (eval/freshqa-set.json) deterministically from two public
// FreshQA snapshots. No hand-written statements: every item is FreshQA's question plus one of its
// answers verbatim, sent through the product path (/v1/check with `question` + `text`).
//
//   node eval/freshqa-build.mjs
//
// Parts
//   A  time-sensitivity detection. Ground truth = FreshQA `fact_type` (never-changing vs
//      slow/fast-changing) of the latest snapshot. Run assess-only: 0 Tavily credits.
//   B  known-stale claims: the 2024-02-26 answer to a question whose answer had changed by the
//      2026-04-21 snapshot (no answer in common). Ground truth: NOT current as of 2026-04-21.
//   C  latest-snapshot claims: the 2026-04-21 answer to the same questions. Ground truth: current
//      as of 2026-04-21 only. It may have changed since, so a "stale" verdict on C is adjudicated
//      by hand from the cited sources, never counted correct or wrong automatically.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSnapshot, normAns } from "./freshqa-lib.mjs";

const DIR = path.join(import.meta.dirname, "data", "freshqa");
const SNAP = {
  old: { file: "freshqa-2024-02-26.csv", date: "2024-02-26", sheet: "1V6nIxVTI9tqZ-wfgK-uFuUPiGEa1Zmnz53OeGbaNtO0" },
  new: { file: "freshqa-2026-04-21.csv", date: "2026-04-21", sheet: "1_8mi-yuK30mvoDJu1KQXD6ODem7MKMcIgVAwDSzJkjM" },
};
const SEED = "halflife-freshqa-2026-11-02";
const N_A_STATIC = 50, N_A_SLOW = 25, N_A_FAST = 25, N_BC = 30;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rank = (r) => sha(`${SEED}:${r.question}`);
const pick = (rows, n) => [...rows].sort((a, b) => (rank(a) < rank(b) ? -1 : 1)).slice(0, n);

const oldS = loadSnapshot(path.join(DIR, SNAP.old.file));
const newS = loadSnapshot(path.join(DIR, SNAP.new.file));
const ok = (r) => r.false_premise === "FALSE" && r.answers.length > 0;

// ---- A: detection (TEST split, valid premise)
const testRows = [...newS.values()].filter((r) => ok(r) && r.split === "TEST");
const A = [
  ...pick(testRows.filter((r) => r.fact_type === "never-changing"), N_A_STATIC),
  ...pick(testRows.filter((r) => r.fact_type === "slow-changing"), N_A_SLOW),
  ...pick(testRows.filter((r) => r.fact_type === "fast-changing"), N_A_FAST),
].map((r) => ({
  id: `A-${r.id}`, part: "A", fq_id: r.id, split: r.split, fact_type: r.fact_type, question: r.question, text: r.answers[0],
  label: r.fact_type === "never-changing" ? "time_invariant" : "time_sensitive",
}));

// ---- B/C: answers that changed between the snapshots
// Excluded, with the reason recorded: questions whose meaning depends on the asking date (a claim
// about "this year" or someone's age has no stable truth value), yes/no questions, and vague answers.
const DATE_RELATIVE = /\b(this (year|week|month)|last (year|season)|how old|current age|years? ago|since|next|upcoming|what month|what season|how long|in how many years|right now|this month|present year|today)\b/i;
const VAGUE = /^(yes|no|over |more than |the show|this year's|\d+ or \d+)/i;
const oldByQ = new Map([...oldS.values()].map((r) => [normAns(r.question), r]));
const excluded = [];
const changed = [];
for (const r of newS.values()) {
  const o = oldByQ.get(normAns(r.question));
  if (!o || !ok(r) || !ok(o) || r.fact_type === "never-changing") continue;
  const oldSet = new Set(o.answers.map(normAns));
  if (r.answers.some((a) => oldSet.has(normAns(a)))) continue; // unchanged
  const why = DATE_RELATIVE.test(r.question) ? "date-relative question" : VAGUE.test(o.answers[0]) || VAGUE.test(r.answers[0]) ? "yes/no or vague answer" : null;
  if (why) excluded.push({ fq_id: r.id, question: r.question, why });
  else changed.push({ r, o });
}
const chosen = pick(changed.map((x) => ({ ...x, question: x.r.question })), N_BC);
const B = chosen.map(({ r, o }) => ({
  id: `B-${r.id}`, part: "B", fq_id: r.id, fq_id_old: o.id, fact_type: r.fact_type, question: r.question, text: o.answers[0],
  label: "stale", gold_now: r.answers, gold_old: o.answers,
}));
const C = chosen.map(({ r, o }) => ({
  id: `C-${r.id}`, part: "C", fq_id: r.id, fact_type: r.fact_type, question: r.question, text: r.answers[0],
  label: "current_at_snapshot", gold_now: r.answers, gold_old: o.answers,
}));

const files = Object.fromEntries(Object.entries(SNAP).map(([k, s]) => [k, { ...s, sha256: sha(fs.readFileSync(path.join(DIR, s.file))), url: `https://docs.google.com/spreadsheets/d/${s.sheet}` }]));
const out = {
  version: "freshqa-v1",
  built_with: "eval/freshqa-build.mjs",
  source: { dataset: "FreshQA (Vu et al., 2023, arXiv:2310.03214)", repo: "https://github.com/freshllms/freshqa", license: "Apache-2.0 (repository)", snapshots: files },
  seed: SEED,
  counts: { A: A.length, B: B.length, C: C.length, changed_pool: changed.length, excluded: excluded.length },
  ground_truth_limits: [
    "A: FreshQA fact_type labels the question, not the extracted claim; a few never-changing questions have answers that FreshQA itself later revised.",
    "B: 'stale' means the 2024-02-26 answer shares no answer string with the 2026-04-21 answer. A change back after 2026-04-21 is possible but not expected for these items.",
    "C: 'current' is known only as of 2026-04-21. Outcomes after that date need manual adjudication from the cited sources.",
    "FreshQA answers are maintained by the dataset authors and may contain errors.",
  ],
  items: [...A, ...B, ...C],
  excluded,
};
fs.writeFileSync(path.join(import.meta.dirname, "freshqa-set.json"), JSON.stringify(out, null, 1));
console.log(out.counts);
