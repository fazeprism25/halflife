// End-to-end integration test: REAL Bifrost v2.4.0 + REAL Halflife plugin + REAL engine, with
// the scripted TEST FIXTURE upstreams (deploy/test/fixtures.mjs) standing in for the LLM provider
// and Tavily so it runs without credentials. Results: deploy/test/results/integration.json
//
//   node deploy/test/integration.mjs            (builds images, starts, tests, tears down)
//   KEEP=1 node deploy/test/integration.mjs     (leave the stack running afterwards)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const COMPOSE = ["compose", "-f", path.join(ROOT, "deploy/docker-compose.yml"), "-p", "halflife-it", "--profile", "test"];
const GW = "http://127.0.0.1:8080";
const ENGINE = "http://127.0.0.1:8090";
const rnd = () => crypto.randomBytes(18).toString("base64url");
const secrets = {
  HALFLIFE_INGEST_TOKEN: rnd(), HALFLIFE_INTERNAL_TOKEN: rnd(), HALFLIFE_RELAY_TOKEN: rnd(), BIFROST_ADMIN_TOKEN: rnd(),
  HALFLIFE_ENGINE_VK: "sk-bf-" + rnd(), HALFLIFE_DEMO_VK: "sk-bf-" + rnd(), HALFLIFE_DEMO_VK_PROBE: "sk-bf-" + rnd(),
};
// Provider keys are blanked so a developer's real keys can never be used by the test.
const env = { ...process.env, ...secrets, HALFLIFE_FIXTURE_UPSTREAM: "http://fixtures:18000", HALFLIFE_CACHE_TTL_SECONDS: "3600",
  TAVILY_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", GROQ_API_KEY: "", OPENROUTER_API_KEY: "", MISTRAL_API_KEY: "", DEEPSEEK_API_KEY: "" };
const VK = { "x-bf-vk": secrets.HALFLIFE_DEMO_VK };
const CONSOLE = { "x-halflife-console": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;

function compose(args, opts = {}) {
  const r = spawnSync("docker", [...COMPOSE, ...args], { env, encoding: "utf8", cwd: ROOT, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker compose ${args.join(" ")} failed:\n${(r.stderr || "").slice(-3000)}`);
  return r;
}

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) });
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

async function waitFor(url, headers = {}, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function chat(prompt, extraHeaders = {}, body = {}) {
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...VK, ...extraHeaders },
    body: JSON.stringify({ model: "openai/fixture-gpt-4o-mini", messages: [{ role: "user", content: prompt }], ...body }),
  });
  const text = await r.text();
  const h = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-halflife-")));
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: h, json, text };
}

async function report(id, via = "relay") {
  const url = via === "relay" ? `${GW}/relay/halflife/v1/reports/${id}` : `${ENGINE}/v1/reports/${id}`;
  const r = await fetch(url, { headers: via === "relay" ? VK : CONSOLE });
  return r.ok ? r.json() : { http: r.status };
}

async function waitDone(id, via) {
  for (let i = 0; i < 60; i++) {
    const r = await report(id, via);
    if (r.status === "done" || r.status === "failed" || r.status === "linked") return r;
    await sleep(500);
  }
  throw new Error(`report ${id} did not finish`);
}

async function main() {
  console.log("building and starting the stack (fixture mode)…");
  compose(["down", "-v", "--remove-orphans"], { allowFail: true });
  // NO_BUILD=1 reuses the local images (saves disk and a Go build when only the engine changed and was rebuilt).
  compose(["up", "-d", ...(process.env.NO_BUILD ? ["--no-build"] : ["--build"])], { stdio: ["ignore", "inherit", "inherit"] });
  await waitFor(`${GW}/health`);
  await waitFor(`${ENGINE}/v1/health`);
  console.log("running checks");

  let first;
  await check("plugin loaded and active in Bifrost", async () => {
    const r = await fetch(`${GW}/api/plugins`, { headers: { "X-Bifrost-Setup-Token": secrets.BIFROST_ADMIN_TOKEN } });
    const body = await r.text();
    assert(r.ok, `GET /api/plugins → ${r.status}`);
    const j = JSON.parse(body);
    const list = Array.isArray(j) ? j : j.plugins ?? [];
    const hl = list.find((p) => p.name === "halflife");
    assert(hl, "halflife plugin not listed");
    const st = JSON.stringify(hl.status ?? hl);
    assert(!/error/i.test(String(hl.status?.status ?? "")), `plugin status ${st}`);
    return { status: hl.status ?? null };
  });

  await check("stale answer: headers, async report, superseded verdict with strong evidence", async () => {
    first = await chat("Who is the CEO of Twitter?");
    assert(first.status === 200, `HTTP ${first.status}: ${first.text.slice(0, 200)}`);
    const id = first.headers["x-halflife-report"];
    assert(/^hl_[a-f0-9]+$/.test(id ?? ""), `missing report header: ${JSON.stringify(first.headers)}`);
    assert(first.headers["x-halflife-status"] === "queued", `status header ${first.headers["x-halflife-status"]}`);
    assert((first.headers["x-halflife-triage"] ?? "").includes("leadership"), "leadership triage expected");
    const r = await waitDone(id, "relay");
    assert(r.status === "done", `report ${r.status}: ${r.error ?? ""}`);
    const ceo = r.claims.find((c) => /Dorsey/.test(c.text));
    assert(ceo, "CEO claim not extracted");
    assert(ceo.verdict === "superseded", `verdict ${ceo.verdict}`);
    assert(ceo.evidence_level === "strong", `level ${ceo.evidence_level}`);
    assert(ceo.current_value === "Linda Yaccarino", "current value");
    assert(ceo.evidence.every((e) => e.quote_valid || e.quote === null), "quotes verified");
    const hastings = r.claims.find((c) => /Hastings/.test(c.text));
    assert(hastings?.triage === "static" && hastings.verdict === null, "historical claim must not be verified");
    return { report: id, headline: r.summary.headline, cache: r.cache };
  });

  await check("stale cached answer is invalidated in Bifrost's semantic cache", async () => {
    const id = first.headers["x-halflife-report"];
    let r;
    for (let i = 0; i < 20; i++) {
      r = await report(id, "relay");
      if (r.cache?.actions?.some((a) => a.status !== "pending")) break;
      await sleep(500);
    }
    const a = r.cache.actions?.[0];
    assert(r.cache.id, "cache id was not captured by the plugin");
    assert(a?.action === "invalidate_stale" && a.status === "done", `cache action ${JSON.stringify(a)}`);
    const again = await chat("Who is the CEO of Twitter?");
    const hit = again.json?.extra_fields?.cache_debug?.cache_hit;
    assert(hit === false || hit === undefined, "the invalidated entry was served from cache");
    return { action: a, second_request_cache_hit: hit ?? null };
  });

  await check("fresh answer is cached and the hit links to the original analysis (no new spend)", async () => {
    const a = await chat("What is the boiling point of water?");
    const ida = a.headers["x-halflife-report"];
    await waitDone(ida, "relay");
    const before = await (await fetch(`${ENGINE}/v1/status`, { headers: CONSOLE })).json();
    const b = await chat("What is the boiling point of water?");
    assert(b.json?.extra_fields?.cache_debug?.cache_hit === true, "expected a cache hit");
    assert(b.headers["x-halflife-cache"] === "hit", "x-halflife-cache header");
    const rb = await waitDone(b.headers["x-halflife-report"], "relay");
    assert(rb.status === "linked" && rb.linked_report_id === ida, `hit report ${rb.status} → ${rb.linked_report_id}`);
    const after = await (await fetch(`${ENGINE}/v1/status`, { headers: CONSOLE })).json();
    assert(after.spend.today.llm_calls === before.spend.today.llm_calls, "a cache hit must not trigger LLM calls");
    return { original: ida, hit: rb.id };
  });

  await check("streamed answer: report header before body, text captured after the stream", async () => {
    const r = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...VK },
      body: JSON.stringify({ model: "openai/fixture-gpt-4o-mini", stream: true, messages: [{ role: "user", content: "What is the latest version of Python?" }] }),
    });
    const id = r.headers.get("x-halflife-report");
    const body = await r.text();
    const text = body.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]")).map((l) => { try { return JSON.parse(l.slice(5)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
    assert(id && r.headers.get("x-halflife-status") === "pending", "stream headers");
    const rep = await waitDone(id, "relay");
    assert(rep.text === text, `captured text differs:\n${rep.text}\nvs\n${text}`);
    assert(rep.claims.some((c) => c.verdict === "superseded"), "python claim superseded");
    return { report: id, chars: text.length };
  });

  await check("verify mode: verdict before the response, annotation, no-store for a stale answer", async () => {
    const r = await chat("What is the latest version of Python? (verify)", { "x-halflife-mode": "verify" });
    assert(r.status === 200, `HTTP ${r.status}`);
    const content = r.json?.choices?.[0]?.message?.content ?? "";
    assert(/^verified/.test(r.headers["x-halflife-status"] ?? ""), `status ${r.headers["x-halflife-status"]}`);
    assert(r.headers["x-halflife-ttl"] === "no-store", `ttl ${r.headers["x-halflife-ttl"]}`);
    assert(content.includes("Halflife freshness check"), "annotation missing");
    return { status: r.headers["x-halflife-status"], annotation: content.split("\n").slice(-3) };
  });

  await check("engine's own LLM calls are not analysed (loop prevention)", async () => {
    const list = await (await fetch(`${ENGINE}/v1/reports?limit=200`, { headers: CONSOLE })).json();
    const internal = list.reports.filter((r) => /claim extractor|verification judge/.test(r.preview ?? ""));
    assert(internal.length === 0, `${internal.length} internal calls were ingested`);
    return { reports: list.reports.length };
  });

  await check("DeepSeek via Bifrost's native provider: json_schema downgraded, thinking off passed through", async () => {
    const schema = { type: "object", additionalProperties: false, required: ["claims"], properties: { claims: { type: "array", items: { type: "object" } } } };
    const r = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bf-vk": secrets.HALFLIFE_ENGINE_VK, "x-halflife-internal": secrets.HALFLIFE_INTERNAL_TOKEN },
      body: JSON.stringify({
        model: "deepseek/deepseek-flash", temperature: 0, max_tokens: 300, thinking: { type: "disabled" },
        response_format: { type: "json_schema", json_schema: { name: "halflife_claims", strict: true, schema } },
        messages: [{ role: "system", content: "You are the claim extractor of Halflife." }, { role: "user", content: "<question>\n\n</question>\n\n<answer>\nAs of 2023, Jack Dorsey is the CEO of Twitter.\n</answer>" }],
      }),
    });
    const j = await r.json();
    assert(r.status === 200, `status ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const data = JSON.parse(j.choices[0].message.content);
    assert(Array.isArray(data.claims) && data.claims.length === 1, "fixture claims not returned");
    const out = compose(["exec", "-T", "fixtures", "node", "-e", "fetch('http://localhost:18000/last-deepseek').then(r=>r.text()).then(t=>process.stdout.write(t))"]);
    const seen = JSON.parse(out.stdout);
    assert(seen.path === "/deepseek/chat/completions", `path ${seen.path}`);
    assert(seen.bearer === true, "provider key not sent as a bearer token");
    assert(seen.body.response_format?.type === "json_object", `response_format ${JSON.stringify(seen.body.response_format)}`);
    assert(seen.body.thinking?.type === "disabled", `thinking ${JSON.stringify(seen.body.thinking)}`);
    assert(seen.body.max_tokens === 300, `max_tokens ${seen.body.max_tokens}`);
    assert(seen.body.model === "deepseek-flash", `model ${seen.body.model}`);
    const sys = seen.body.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    assert(/json/.test(sys) && sys.includes('"claims"'), "schema instruction (with the word json) not injected");
    return { upstream_format: seen.body.response_format.type, thinking: seen.body.thinking.type, system_messages: seen.body.messages.filter((m) => m.role === "system").length };
  });

  await check("Halflife API through the Bifrost relay is VK-gated and route-allowlisted", async () => {
    const noVk = await fetch(`${GW}/relay/halflife/v1/status`);
    const ok = await fetch(`${GW}/relay/halflife/v1/status`, { headers: VK });
    const unlisted = await fetch(`${GW}/relay/halflife/v1/playground`, { method: "POST", headers: { ...VK, "content-type": "application/json" }, body: "{}" });
    const direct = await fetch(`${ENGINE}/v1/status`);
    assert(noVk.status === 401 || noVk.status === 403, `no VK → ${noVk.status}`);
    assert(ok.status === 200, `with VK → ${ok.status}`);
    assert(unlisted.status === 404, `unlisted route → ${unlisted.status}`);
    assert(direct.status === 401, `engine without credential → ${direct.status}`);
    return { no_vk: noVk.status, with_vk: ok.status, unlisted: unlisted.status };
  });

  await check("POST /v1/check through the relay (apps outside the gateway)", async () => {
    const r = await fetch(`${GW}/relay/halflife/v1/check`, { method: "POST", headers: { ...VK, "content-type": "application/json" }, body: JSON.stringify({ text: "As of 2023, Jack Dorsey is the CEO of Twitter.", model: "gpt-4o-mini", wait: true }) });
    const j = await r.json();
    assert(r.status === 200 && j.status === "done", `HTTP ${r.status} ${j.status}`);
    assert(j.claims[0]?.verdict === "superseded", "verdict via /v1/check");
    return { id: j.id, headline: j.summary.headline };
  });

  await check("Bifrost meters Tavily credits per virtual key and refuses with 402 when the budget is spent", async () => {
    // Fixture-only key with a $0.01 budget; each search is 1 credit × $0.008 (relay usage pricing).
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${GW}/relay/tavily/search`, { method: "POST", headers: { "content-type": "application/json", "x-bf-vk": secrets.HALFLIFE_DEMO_VK_PROBE }, body: JSON.stringify({ query: "fixture twitter ceo" }) });
      statuses.push(r.status);
      if (r.status === 402) break;
      await sleep(300);
    }
    assert(statuses[0] === 200, `first call ${statuses[0]}`);
    assert(statuses.includes(402), `no 402 after budget exhausted: ${statuses}`);
    const engineSearch = await fetch(`${GW}/relay/tavily/search`, { method: "POST", headers: { "content-type": "application/json", "x-bf-vk": secrets.HALFLIFE_DEMO_VK }, body: "{}" });
    assert(engineSearch.status === 403 || engineSearch.status === 401, `demo VK has no Tavily grant but got ${engineSearch.status}`);
    return { statuses, demo_vk_without_grant: engineSearch.status };
  });

  await check("engine outage never affects inference (fail-open)", async () => {
    compose(["stop", "engine"]);
    try {
      const r = await chat("What is the boiling point of water, again?");
      assert(r.status === 200 && r.json?.choices?.[0]?.message?.content, `HTTP ${r.status}`);
      assert(r.headers["x-halflife-report"], "plugin still annotates");
      return { status: r.status };
    } finally {
      compose(["start", "engine"]);
      await waitFor(`${ENGINE}/v1/health`);
    }
  });

  await check("plugin heartbeat reaches the engine", async () => {
    for (let i = 0; i < 30; i++) {
      const s = await (await fetch(`${ENGINE}/v1/status`, { headers: CONSOLE })).json();
      if (s.integrations.plugin && !s.integrations.plugin.stale) return { counters: s.integrations.plugin.counters };
      await sleep(1000);
    }
    throw new Error("no heartbeat");
  });
}

const started = Date.now();
try {
  await main();
} catch (e) {
  failures++;
  results.push({ name: "setup", ok: false, error: String(e?.message ?? e) });
  console.error(e);
} finally {
  const logs = compose(["logs", "--no-color", "--tail", "200"], { allowFail: true }).stdout ?? "";
  const redacted = Object.values(secrets).reduce((s, v) => s.split(v).join("[redacted]"), logs);
  fs.mkdirSync(path.join(ROOT, "deploy/test/results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "deploy/test/results/integration.json"), JSON.stringify({ at: new Date().toISOString(), mode: "TEST FIXTURE upstreams (no real LLM or Tavily)", ms: Date.now() - started, passed: results.filter((r) => r.ok).length, failed: failures, results }, null, 2));
  fs.writeFileSync(path.join(ROOT, "deploy/test/results/integration-logs.txt"), redacted);
  if (!process.env.KEEP) compose(["down", "-v", "--remove-orphans"], { allowFail: true });
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
