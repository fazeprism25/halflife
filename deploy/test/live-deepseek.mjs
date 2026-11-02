// LIVE check of the DeepSeek integration, against the RUNNING stack and real DeepSeek + Tavily.
// It spends real (small) money: about 6 DeepSeek calls and up to 6 Tavily credits.
//
//   docker compose -f deploy/docker-compose.yml up -d --build      (with DEEPSEEK_API_KEY in deploy/.env)
//   node deploy/test/live-deepseek.mjs
//
// It reads the virtual keys and the internal token from deploy/.env, and never prints any value
// from that file. The results (no secrets) go to deploy/test/results/live-deepseek.json.

import fs from "node:fs";
import path from "node:path";
import { preflight, reconcile } from "./spend-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GW = process.env.GW ?? "http://127.0.0.1:8080";
const MODEL = process.env.MODEL ?? "deepseek/deepseek-flash";
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "deploy/.env"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const results = [];
let failures = 0;
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 500) });
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

// The engine's identity: its VK plus the internal token, so the plugin skips these calls and they
// are billed to the engine budget, exactly as the engine's own judge calls are.
const engineHeaders = { "content-type": "application/json", "x-bf-vk": env.HALFLIFE_ENGINE_VK, "x-halflife-internal": env.HALFLIFE_INTERNAL_TOKEN };

async function chat(body) {
  const t0 = Date.now();
  const r = await fetch(`${GW}/v1/chat/completions`, { method: "POST", headers: engineHeaders, body: JSON.stringify({ model: MODEL, ...body }) });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: r.status, j, raw: text.slice(0, 400), ms: Date.now() - t0 };
}

let guardBefore = null;

async function main() {
  assert(env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY is empty in deploy/.env");
  // 3 claims × (1 search + ≤1 extract) = ≤6 credits.
  guardBefore = await preflight({ plannedCredits: 6, label: "live-deepseek" });
  for (const k of ["HALFLIFE_ENGINE_VK", "HALFLIFE_DEMO_VK", "HALFLIFE_INTERNAL_TOKEN"]) assert(env[k], `${k} missing in deploy/.env (run node deploy/setup.mjs)`);
  const status = await (await fetch(`${GW}/relay/halflife/v1/status`, { headers: { "x-bf-vk": env.HALFLIFE_DEMO_VK } })).json();
  console.log(`engine judge model: ${status.integrations?.llm?.model ?? "?"}; search configured: ${status.integrations?.search?.configured}`);

  await check("Bifrost authenticates with DeepSeek: a real inference request succeeds (thinking off)", async () => {
    const r = await chat({ max_tokens: 20, temperature: 0, thinking: { type: "disabled" }, messages: [{ role: "user", content: "Reply with exactly the word: ok" }] });
    assert(r.status === 200, `HTTP ${r.status}: ${r.raw}`);
    const m = r.j.choices?.[0]?.message ?? {};
    assert(typeof m.content === "string" && m.content.trim(), "empty content");
    return { latency_ms: r.ms, served_model: r.j.model, content: m.content.slice(0, 40), reasoning_returned: !!(m.reasoning_content || m.reasoning), usage: r.j.usage };
  });

  await check("thinking mode on (DeepSeek default), for comparison only", async () => {
    const r = await chat({ max_tokens: 1500, messages: [{ role: "user", content: "Reply with exactly the word: ok" }] });
    assert(r.status === 200, `HTTP ${r.status}: ${r.raw}`);
    const m = r.j.choices?.[0]?.message ?? {};
    return { latency_ms: r.ms, content: String(m.content ?? "").slice(0, 40), reasoning_chars: String(m.reasoning_content ?? m.reasoning ?? "").length, usage: r.j.usage };
  });

  await check("structured output: json_schema through Bifrost (downgraded to json_object) parses and matches", async () => {
    const schema = {
      type: "object", additionalProperties: false, required: ["verdict", "citations"],
      properties: { verdict: { type: "string", enum: ["current", "superseded", "contradicted", "unverifiable"] }, citations: { type: "array", items: { type: "object", additionalProperties: false, required: ["evidence_id", "quote"], properties: { evidence_id: { type: "string" }, quote: { type: "string" } } } } },
    };
    const evidence = [{ evidence_id: "E1", content: "Python 3.14.0 was released on 7 October 2025 and is the latest stable release." }];
    const r = await chat({
      max_tokens: 300, temperature: 0, thinking: { type: "disabled" },
      response_format: { type: "json_schema", json_schema: { name: "probe_verdict", strict: true, schema } },
      messages: [{ role: "system", content: "Judge the claim using only the evidence. Quote the evidence exactly." }, { role: "user", content: `Claim: The latest stable Python release is 3.11.\nEvidence: ${JSON.stringify(evidence)}` }],
    });
    assert(r.status === 200, `HTTP ${r.status}: ${r.raw}`);
    const data = JSON.parse(r.j.choices[0].message.content);
    assert(["current", "superseded", "contradicted", "unverifiable"].includes(data.verdict), `verdict ${data.verdict}`);
    assert(Array.isArray(data.citations), "citations not an array");
    const quoteOk = data.citations.every((c) => evidence[0].content.includes(c.quote));
    return { latency_ms: r.ms, verdict: data.verdict, citations: data.citations.length, quotes_exact: quoteOk, usage: r.j.usage };
  });

  let report = null;
  await check("claim extraction + verification through the real engine (/v1/check via the relay, Tavily evidence)", async () => {
    const text = "As of early 2023, Jack Dorsey is the CEO of Twitter. The latest stable version of Python is 3.11. The Battle of Hastings was fought in 1066.";
    const t0 = Date.now();
    const r = await fetch(`${GW}/relay/halflife/v1/check`, { method: "POST", headers: { "content-type": "application/json", "x-bf-vk": env.HALFLIFE_DEMO_VK }, body: JSON.stringify({ text, model: MODEL, wait: true }) });
    report = await r.json();
    assert(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(report).slice(0, 300)}`);
    assert(report.status === "done", `status ${report.status} ${report.error ?? ""}`);
    assert(report.extraction === "llm", `extraction=${report.extraction} (${report.extraction_note ?? ""}): the LLM path failed and fell back`);
    assert(report.claims.length >= 2, `${report.claims.length} claims`);
    return {
      latency_ms: Date.now() - t0, llm_calls: report.llm_calls, credits: report.credits, extraction_note: report.extraction_note,
      claims: report.claims.map((c) => ({ text: c.text, class: c.class.id, as_of: c.as_of.label, p_outdated: [c.p_outdated.lo, c.p_outdated.hi].map((x) => x?.toFixed?.(2)), triage: c.triage, verdict: c.verdict, current_value: c.current_value, evidence_level: c.evidence_level, limitation: c.limitation, valid_quotes: c.evidence.filter((e) => e.quote_valid).length, dated_sources: c.evidence.filter((e) => e.published_at).length, sources: c.evidence.length })),
    };
  });

  await check("verification analysis produced a grounded verdict for at least one stale claim", async () => {
    assert(report?.claims, "no report");
    const judged = report.claims.filter((c) => c.verdict && c.verdict !== "unverifiable");
    assert(judged.length >= 1, `no decisive verdicts: ${report.claims.map((c) => `${c.verdict ?? "not checked"}${c.limitation ? ` (${c.limitation.kind}: ${c.limitation.message})` : ""}`).join("; ")}`);
    for (const c of judged) assert(c.evidence.some((e) => e.quote_valid), `verdict ${c.verdict} without a verified quote`);
    return judged.map((c) => ({ claim: c.text, verdict: c.verdict, current_value: c.current_value, evidence_level: c.evidence_level }));
  });

  await check("error handling: a model outside the allow-list is refused by Bifrost, not sent upstream", async () => {
    const r = await chat({ model: "deepseek/not-a-real-model", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    assert(r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
    return { status: r.status, error: (r.j?.error?.message ?? r.raw).slice(0, 160) };
  });
}

main()
  .catch((e) => {
    failures++;
    console.log(`ABORT ${e.message}`);
  })
  .finally(async () => {
    let spend = null;
    try {
      if (guardBefore) spend = await reconcile(guardBefore);
    } catch (e) {
      console.log(`[guard] reconcile failed: ${e.message}`);
    }
    const out = path.join(ROOT, "deploy/test/results/live-deepseek.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), model: MODEL, passed: results.filter((r) => r.ok).length, failed: failures, spend, results }, null, 2));
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; results in deploy/test/results/live-deepseek.json`);
    process.exit(failures ? 1 : 0);
  });
