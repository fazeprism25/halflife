// Spend guard for LIVE scripts (AD-19). Reads the provider-side counters through their free
// endpoints and refuses to start a run that could leave the free Tavily allowance or exceed
// the development DeepSeek budget. Every run appends one line to results/spend-ledger.jsonl.
//
//   Tavily:   GET https://api.tavily.com/usage        (no credits)
//   DeepSeek: GET https://api.deepseek.com/user/balance (free)
//
// Keys are read from deploy/.env and never printed.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const LEDGER = path.join(ROOT, "deploy/test/results/spend-ledger.jsonl");

/** Share of the Tavily plan allowance usable for development/evaluation; the rest is reserve. */
export const TAVILY_CEILING_FRACTION = 0.8;
/** DeepSeek development budget: stop when this much of the starting balance has been spent. */
export const DEEPSEEK_DEV_BUDGET_USD = 1.0;
const DEEPSEEK_USD_PER_TOKEN_BOUND = 1.2e-6;
const DEEPSEEK_BASELINE_FILE = path.join(ROOT, "deploy/test/results/deepseek-baseline.json");

export function readEnv() {
  return Object.fromEntries(
    fs.readFileSync(path.join(ROOT, "deploy/.env"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

// Free reads only; one retry on network errors (connect timeouts were seen once on Windows).
async function get(url, headers) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      if (i >= 1) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

export async function tavilyUsage(env = readEnv()) {
  const r = await get("https://api.tavily.com/usage", { authorization: `Bearer ${env.TAVILY_API_KEY}` });
  if (!r.ok) throw new Error(`Tavily /usage HTTP ${r.status}`);
  const j = await r.json();
  const a = j.account ?? {};
  return { plan: a.current_plan ?? null, plan_usage: Number(a.plan_usage ?? 0), plan_limit: a.plan_limit == null ? null : Number(a.plan_limit), paygo_usage: Number(a.paygo_usage ?? 0), paygo_limit: a.paygo_limit ?? null, key_usage: Number(j.key?.usage ?? 0), key_limit: j.key?.limit ?? null, search_usage: Number(a.search_usage ?? 0), extract_usage: Number(a.extract_usage ?? 0), research_usage: Number(a.research_usage ?? 0) };
}

export async function deepseekBalance(env = readEnv()) {
  const r = await get("https://api.deepseek.com/user/balance", { authorization: `Bearer ${env.DEEPSEEK_API_KEY}` });
  if (!r.ok) throw new Error(`DeepSeek /user/balance HTTP ${r.status}`);
  const j = await r.json();
  const usd = (j.balance_infos ?? []).find((b) => b.currency === "USD");
  return { available: !!j.is_available, total_usd: usd ? Number(usd.total_balance) : null, granted_usd: usd ? Number(usd.granted_balance) : null, topped_up_usd: usd ? Number(usd.topped_up_balance) : null };
}

/**
 * Throws unless `plannedCredits` more Tavily credits and the DeepSeek dev budget are safely
 * available. Returns the snapshot so the caller can reconcile after the run.
 */
export async function preflight({ plannedCredits, label }) {
  const env = readEnv();
  let t;
  try {
    t = await tavilyUsage(env);
  } catch (e) {
    // /usage is rate-limited (429 seen 2026-11-02). Fall back to the last reading in the ledger
    // (< 24 h old) plus the local count; with no recent reading, refuse.
    t = lastReading();
    if (!t) throw new Error(`${e.message} and no recent reading in the ledger; refusing to run`);
    console.log(`[guard] ${e.message}: using the ledger reading from ${t.read_at}`);
  }
  if (t.paygo_usage > 0) throw new Error(`Tavily reports pay-as-you-go usage (${t.paygo_usage}); refusing to run`);
  if (t.plan_limit == null) throw new Error("Tavily plan limit unknown; refusing to run");
  const ceiling = Math.floor(t.plan_limit * TAVILY_CEILING_FRACTION);
  // Tavily's /usage counter lags by minutes, so also count every credit we know we spent:
  // direct relay calls recorded in the ledger plus the engine's persisted spend total.
  const eng = await engineSpend(env);
  const local = localCredits() + eng.credits;
  const used = Math.max(t.plan_usage, local);
  if (used + plannedCredits > ceiling) throw new Error(`Tavily: ${used} used (counter ${t.plan_usage}, local ${local}) + ${plannedCredits} planned > ceiling ${ceiling} of ${t.plan_limit}; refusing to run`);
  let d = null;
  if (env.DEEPSEEK_API_KEY) {
    d = await deepseekBalance(env);
    let base = null;
    try { base = JSON.parse(fs.readFileSync(DEEPSEEK_BASELINE_FILE, "utf8")); } catch { /* first run */ }
    if (!base) {
      base = { at: new Date().toISOString(), total_usd: d.total_usd, engine_tokens: eng.tokens };
      fs.mkdirSync(path.dirname(DEEPSEEK_BASELINE_FILE), { recursive: true });
      fs.writeFileSync(DEEPSEEK_BASELINE_FILE, JSON.stringify(base, null, 2));
    }
    // The balance moves in $0.01 steps and lags, so also bound spend by the engine's token count
    // at DeepSeek's highest flash rate (peak output, $1.20/M), whichever is higher.
    const tokenBound = (eng.tokens - (base.engine_tokens ?? 0)) * DEEPSEEK_USD_PER_TOKEN_BOUND;
    const spent = Math.max(base.total_usd - d.total_usd, tokenBound);
    if (spent >= DEEPSEEK_DEV_BUDGET_USD) throw new Error(`DeepSeek dev budget reached: $${spent.toFixed(4)} of $${DEEPSEEK_DEV_BUDGET_USD} spent since ${base.at}; refusing to run`);
    d.spent_since_baseline_usd = Number(spent.toFixed(6));
  }
  const snap = { at: new Date().toISOString(), label, phase: "before", planned_credits: plannedCredits, engine_tokens: eng.tokens, tavily: t, tavily_local_count: local, tavily_ceiling: ceiling, deepseek: d };
  append(snap);
  console.log(`[guard] Tavily ${t.plan} ${used}/${t.plan_limit} used (counter ${t.plan_usage}, local ${local}) (ceiling ${ceiling}, planned ≤${plannedCredits}); paygo ${t.paygo_usage}` + (d ? `; DeepSeek balance $${d.total_usd} (dev spend so far $${d.spent_since_baseline_usd?.toFixed(4)})` : ""));
  return snap;
}

/** Re-reads both counters and records the actual consumption of the run. */
export async function reconcile(before, extra = {}) {
  const env = readEnv();
  const t = await tavilyUsage(env).catch((e) => ({ error: e.message }));
  const d = env.DEEPSEEK_API_KEY ? await deepseekBalance(env).catch(() => null) : null;
  if (t.error) {
    const row = { at: new Date().toISOString(), label: before.label, phase: "after", tavily_error: t.error, deepseek_balance_usd: d?.total_usd ?? null, ...extra };
    append(row);
    console.log(`[guard] reconcile could not read Tavily usage (${t.error}); recorded local counts only`);
    return row;
  }
  const row = {
    at: new Date().toISOString(), label: before.label, phase: "after",
    // Delta of Tavily's own counter. It lags by minutes to hours, so it can include earlier
    // usage; the run's real spend is engine_credits (counted locally) plus any direct calls.
    tavily_counter_delta: t.plan_usage - before.tavily.plan_usage,
    tavily_search_delta: t.search_usage - before.tavily.search_usage,
    tavily_extract_delta: t.extract_usage - before.tavily.extract_usage,
    tavily_paygo_usage: t.paygo_usage, tavily_plan_usage: t.plan_usage,
    deepseek_usd_spent: d && before.deepseek ? Number((before.deepseek.total_usd - d.total_usd).toFixed(6)) : null,
    deepseek_balance_usd: d?.total_usd ?? null,
    ...extra,
  };
  append(row);
  console.log(`[guard] engine credits this run: ${extra.engine_credits ?? "?"} (local count); Tavily counter ${t.plan_usage}/${t.plan_limit} (moved ${row.tavily_counter_delta}, lags), paygo ${t.paygo_usage}` + (d ? `; DeepSeek $${row.deepseek_usd_spent} (balance $${d.total_usd})` : ""));
  return row;
}

/** Most recent successful Tavily reading recorded in the ledger, if under 24 h old. */
function lastReading() {
  try {
    const rows = fs.readFileSync(LEDGER, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    const r = rows.reverse().find((x) => x.phase === "before" && x.tavily?.plan_limit);
    if (!r || Date.now() - Date.parse(r.at) > 24 * 3600e3) return null;
    return { ...r.tavily, read_at: r.at };
  } catch {
    return null;
  }
}

/** Credits spent by scripts directly through the relay (not by the engine), from the ledger. */
function localCredits() {
  try {
    return fs.readFileSync(LEDGER, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l)).reduce((s, r) => s + Number(r.outside_engine_credits ?? 0), 0);
  } catch {
    return 0;
  }
}

/** The engine's lifetime credits and today's tokens; refused if the stack is up but unreadable. */
async function engineSpend(env) {
  const GW = process.env.GW ?? "http://127.0.0.1:8080";
  let r;
  try {
    r = await fetch(`${GW}/relay/halflife/v1/status`, { headers: { "x-bf-vk": env.HALFLIFE_DEMO_VK }, signal: AbortSignal.timeout(5000) });
  } catch {
    return { credits: 0, tokens: 0 }; // stack not running: the engine is not spending
  }
  const j = await r.json().catch(() => null);
  const n = Number(j?.spend?.total_credits);
  if (!Number.isFinite(n)) throw new Error("engine status has no spend.total_credits; refusing to run");
  return { credits: n, tokens: Number(j.spend.total_tokens ?? j.spend.today?.tokens ?? 0) };
}

function append(row) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
}

// CLI: node deploy/test/spend-guard.mjs   → prints the current counters (free calls only)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const env = readEnv();
  const t = await tavilyUsage(env);
  const d = env.DEEPSEEK_API_KEY ? await deepseekBalance(env) : null;
  console.log(JSON.stringify({ tavily: t, tavily_ceiling: t.plan_limit ? Math.floor(t.plan_limit * TAVILY_CEILING_FRACTION) : null, deepseek: d }, null, 2));
}
