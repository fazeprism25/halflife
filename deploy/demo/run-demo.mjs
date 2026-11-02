// LIVE demo runner: the exact steps of research/DEMO_SCRIPT.md, against the running stack with
// real DeepSeek answers and real Tavily evidence. Nothing is mocked. It prints what to show and
// writes a timestamped transcript (deploy/demo/results/demo-<ts>.md): the backup evidence if the
// live demo fails. Spend is bounded by the guard.
//
//   node deploy/demo/run-demo.mjs            (stack running: docker compose -f deploy/docker-compose.yml up -d)

import fs from "node:fs";
import path from "node:path";
import { preflight, readEnv, reconcile } from "../test/spend-guard.mjs";

const GW = process.env.GW ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "deepseek/deepseek-flash";
const env = readEnv();
const VK = { "x-bf-vk": env.HALFLIFE_DEMO_VK };
const pr = (p) => (p > 0 && p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const log = (s = "") => (console.log(s), out.push(s));

const STEPS = [
  { id: "stable", title: "1. Time-invariant facts cost nothing", mode: "async",
    prompt: "Answer in one short sentence each: In what year was the Battle of Hastings fought? What is the chemical symbol for gold?" },
  { id: "pm", title: "2. Verify-before-reply: a stale answer is annotated and never cached", mode: "verify",
    prompt: "In one short sentence: who is the current prime minister of the United Kingdom?" },
  { id: "pricing", title: "3. Claim-level verdicts on a mixed answer (one current, one superseded)", mode: "async",
    prompt: "In two short sentences: how much does a ChatGPT Plus subscription cost per month in USD, and how much does a YouTube Premium individual plan cost per month in the US?" },
  { id: "version", title: "4. Software version: the stale cache entry is invalidated", mode: "async",
    prompt: "In two short sentences: what is the latest major version of Node.js, and what is the latest major version of the React library?" },
  { id: "leader-1", title: "5a. Leadership answer (cached by Bifrost)", mode: "async",
    prompt: "In one short sentence each: who is the CEO of Intel, and who is the CEO of Starbucks?" },
  { id: "leader-2", title: "5b. Same prompt again: a cache hit is linked to the original analysis, 0 credits", mode: "async",
    prompt: "In one short sentence each: who is the CEO of Intel, and who is the CEO of Starbucks?" },
];

async function chat(prompt, mode) {
  const t0 = Date.now();
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", ...VK, ...(mode === "verify" ? { "x-halflife-mode": "verify" } : {}) },
    // DeepSeek thinks by default; without this the 300-token budget can go to reasoning and the
    // answer comes back empty (Halflife then reports "skipped; no-text").
    body: JSON.stringify({ model: MODEL, max_tokens: 300, temperature: 0, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json().catch(() => null);
  const h = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-halflife-")));
  return { status: r.status, ms: Date.now() - t0, headers: h, answer: j?.choices?.[0]?.message?.content ?? null, cache_hit: j?.extra_fields?.cache_debug?.cache_hit ?? null };
}
async function report(id) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${GW}/relay/halflife/v1/reports/${id}`, { headers: VK });
    if (r.ok) {
      const j = await r.json();
      if (["done", "failed", "linked"].includes(j.status)) {
        if (j.status === "linked" && j.linked_report_id) j.original = await (await fetch(`${GW}/relay/halflife/v1/reports/${j.linked_report_id}`, { headers: VK })).json();
        // cache actions run just after "done"; give them a moment
        if (j.cache?.id && !j.cache.hit) await sleep(4000);
        return j.status === "linked" ? j : { ...(await (await fetch(`${GW}/relay/halflife/v1/reports/${id}`, { headers: VK })).json()) };
      }
    }
    await sleep(1000);
  }
  throw new Error(`report ${id} did not finish`);
}
const status = async () => (await (await fetch(`${GW}/relay/halflife/v1/status`, { headers: VK })).json()).spend;

const before = await preflight({ plannedCredits: 6 * STEPS.length, label: "demo run" });
const s0 = await status();
log(`# Halflife live demo transcript — ${new Date().toISOString()}`);
log("");
log(`Gateway ${GW} · model ${MODEL} · real DeepSeek and Tavily · engine credits before: ${s0.total_credits}`);
for (const st of STEPS) {
  log("");
  log(`## ${st.title}`);
  log("");
  log(`Prompt (${st.mode}): ${st.prompt}`);
  const g = await chat(st.prompt, st.mode);
  log("");
  log(`HTTP ${g.status} in ${g.ms} ms · Bifrost cache ${g.cache_hit === true ? "HIT" : g.cache_hit === false ? "miss" : "n/a"}`);
  for (const [k, v] of Object.entries(g.headers)) log(`- \`${k}: ${v}\``);
  log("");
  log("Answer:");
  log("");
  log("> " + (g.answer ?? "(none)").replace(/\n/g, "\n> "));
  const id = g.headers["x-halflife-report"];
  if (!id || /^skipped/.test(g.headers["x-halflife-status"] ?? "")) {
    log("");
    log(`No analysis: ${g.headers["x-halflife-status"] ?? "no report header"}`);
    continue;
  }
  const r = await report(id);
  const a = r.original ?? r;
  log("");
  log(`Report \`${r.id}\` → ${r.status}${r.original ? ` (linked to \`${r.original.id}\`; no new model or search calls)` : ""} · **${a.summary?.headline}** · ${r.original ? 0 : a.credits} Tavily credits · ${r.original ? 0 : a.llm_calls} LLM calls`);
  for (const c of a.claims ?? []) {
    log(`- “${c.statement}” — ${c.class.label}; ${c.time_sensitive ? `P(outdated) ${pr(c.p_outdated.lo)}–${pr(c.p_outdated.hi)} (uncalibrated); ` : "time-invariant, not checked; "}${c.verdict ? `**${c.verdict}** (${c.evidence_level} evidence${c.reused_from ? ", reused verification, 0 credits" : ""})` : c.triage}${c.current_value ? `; now: ${c.current_value}` : ""}`);
    for (const e of (c.evidence ?? []).filter((e) => e.quote_valid).slice(0, 2)) log(`  - ${e.stance} · ${e.site} ${e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : "undated"}: “${e.quote}” (${e.url})`);
  }
  for (const x of r.cache?.actions ?? []) log(`- cache action: ${x.action} → ${x.status}${x.result ? ` (${x.result})` : ""}: ${x.reason}`);
}
const s1 = await status();
await sleep(1500);
const spend = await reconcile(before, { engine_credits: s1.total_credits - s0.total_credits, engine_tokens: (s1.total_tokens ?? 0) - (s0.total_tokens ?? 0) });
log("");
log(`## 6. Cost controls`);
log("");
log(`This run: ${spend.engine_credits} Tavily credits, ${spend.engine_tokens} DeepSeek tokens. Engine lifetime ${s1.total_credits} of cap ${s1.total_cap_credits}; today ${s1.today.credits} of ${s1.cap_credits}; account ceiling ${Math.round((s1.guard?.ceiling_fraction ?? 0.8) * 100)}% of the plan, checked before every paid call.`);
const dir = path.join(import.meta.dirname, "results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `demo-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
fs.writeFileSync(file, out.join("\n") + "\n");
console.log(`\nwrote ${file}`);
