// Feasibility experiment runner. Starts the Bifrost+probe container per config variant,
// drives real requests through it (provider: local Ollama qwen3:8b), and records evidence.
// Usage: node experiments/feasibility/run.mjs [experiment...]
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");
fs.mkdirSync(RESULTS, { recursive: true });
const IMAGE = "halflife-feasibility:dev";
const NAME = "halflife-feasibility";
const GW = "http://localhost:18080";
const POST = "http://localhost:19091";
const PRE = "http://localhost:19092";
// MODEL: a clearly labelled MOCK upstream that speaks the OpenAI wire format. Bifrost's real
// OpenAI provider adapter, SSE parser, plugin pipeline and semantic cache all run unchanged; only
// the model's answer is canned. Used because the host lacked free RAM to load a local model
// (see results/environment.json). Set REAL_MODEL=ollama/qwen3:8b to use local Ollama instead.
const MODEL = process.env.REAL_MODEL || "openai/mock-model";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let upstreamCalls = 0;
const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  upstreamCalls++;
  let j = {};
  try { j = JSON.parse(body); } catch {}
  const prompt = j.messages?.at(-1)?.content ?? "";
  const answer = `[MOCK UPSTREAM] As of July 2024, the answer to "${String(prompt).slice(0, 60)}" is a placeholder.`;
  const id = "mock-" + upstreamCalls;
  if (!j.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answer } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const parts = answer.match(/.{1,18}/g);
  for (let i = 0; i < parts.length; i++) {
    const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-model",
      choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: parts[i] } : { content: parts[i] }, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await sleep(40);
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => mock.listen(18000, "127.0.0.1", r));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function stop() {
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
}
async function start(variant) {
  stop();
  const src = path.join(HERE, "configs", variant, "config.json");
  const dataDir = path.join(HERE, ".run", variant);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(src, path.join(dataDir, "config.json"));
  execSync(
    `docker run -d --name ${NAME} -p 18080:8080 -p 19091:9091 -p 19092:9092 -v "${dataDir}:/data" ${IMAGE}`,
    { stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${GW}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("gateway did not become healthy: " + logs());
}
function logs() {
  return spawnSync("docker", ["logs", NAME], { encoding: "utf8" }).stdout + spawnSync("docker", ["logs", NAME], { encoding: "utf8" }).stderr;
}
async function chat(prompt, headers = {}, extra = {}) {
  const t0 = performance.now();
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 80, temperature: 0, ...extra }),
  });
  const ms = Math.round(performance.now() - t0);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return {
    status: r.status, ms,
    report_id: r.headers.get("x-halflife-report"),
    plugin_headers: { post: r.headers.get("x-halflife-plugin-halflife-probe-post"), pre: r.headers.get("x-halflife-plugin-halflife-probe-pre") },
    content: json?.choices?.[0]?.message?.content ?? null,
    cache_debug: json?.extra_fields?.cache_debug ?? null,
    raw: json ? undefined : text.slice(0, 500),
    upstream_calls_so_far: upstreamCalls,
  };
}
async function report(base, id) {
  const r = await fetch(`${base}/reports?id=${encodeURIComponent(id)}`);
  return r.json();
}
const hooks = (rep) => (rep?.events ?? []).map((e) => e.hook);
const nonce = () => Math.random().toString(36).slice(2, 8);
const Q = (q) => `${q} Answer in one short sentence. /no_think`;

const experiments = {
  async warmup() {
    await start("main");
    const r = await chat(Q("Say hello."), { "x-bf-cache-no-store": "true" });
    return { status: r.status, ms: r.ms };
  },

  // E1 inspection + E2 modification + E3 async (response returns before verification completes)
  async inspect_modify_async() {
    await start("main");
    const out = {};
    const a = await chat(Q(`Who is the CEO of Twitter? (${nonce()})`));
    const repImmediate = await report(POST, a.report_id);
    await sleep(2500);
    const repLater = await report(POST, a.report_id);
    out.inspection = {
      status: a.status, latency_ms: a.ms, report_header: a.report_id, plugin_headers: a.plugin_headers,
      model_text: a.content,
      plugin_captured_text: repLater.text,
      captured_equals_delivered: repLater.text === a.content,
      status_when_response_arrived: repImmediate.status,
      status_after_2_5s: repLater.status,
      queued_to_done_ms: repLater.done_at && repLater.queued_at ? new Date(repLater.done_at) - new Date(repLater.queued_at) : null,
      post_hook_ns: repLater.events?.find((e) => e.hook === "PostLLMHook")?.hook_ns,
      hooks_seen: hooks(repLater),
    };
    const b = await chat(Q(`What is the capital of France? (${nonce()})`), { "x-probe-modify": "true" });
    out.modification = { status: b.status, content: b.content, marker_present: (b.content ?? "").includes("[halflife-probe: response modified in PostLLMHook]") };
    return out;
  },

  // E4: which plugin placement sees cache hits; E5: per-request TTL set by plugin
  async cache_ttl_post() {
    await start("main");
    const out = {};
    const p = Q(`Name one primary colour. (${nonce()})`);
    const r1 = await chat(p);
    await sleep(800);
    const r2 = await chat(p);
    out.cache_hit_visibility = {
      first: { cache_debug: r1.cache_debug, ms: r1.ms },
      second: { cache_debug: r2.cache_debug, ms: r2.ms },
      post_builtin_probe_hooks_on_hit: hooks(await report(POST, r2.report_id)),
      pre_builtin_probe_hooks_on_hit: hooks(await report(PRE, r2.report_id)),
      pre_builtin_probe_saw_cache_hit_in_PostLLMHook: (await report(PRE, r2.report_id)).events?.find((e) => e.hook === "PostLLMHook")?.note ?? null,
    };
    // TTL set by post_builtin plugin (runs BEFORE semantic_cache's PostLLMHook)
    const t = Q(`Name one planet. (${nonce()})`);
    const t1 = await chat(t, { "x-probe-ttl": "4s" });
    await sleep(800);
    const t2 = await chat(t);
    await sleep(5000);
    const t3 = await chat(t);
    // Control: default TTL (5m)
    const c = Q(`Name one ocean. (${nonce()})`);
    const c1 = await chat(c);
    await sleep(5800);
    const c3 = await chat(c);
    out.plugin_ttl_post_builtin = {
      ttl_set_by_plugin: (await report(POST, t1.report_id)).ttl_set,
      t_plus_0_8s_hit: t2.cache_debug?.cache_hit ?? false,
      t_plus_5_8s_hit: t3.cache_debug?.cache_hit ?? false,
      control_default_ttl_t_plus_5_8s_hit: c3.cache_debug?.cache_hit ?? false,
      control_first: c1.cache_debug,
    };
    // Adaptive TTL from response content heuristic
    const v = Q(`Who is the current CEO of Microsoft? (${nonce()})`);
    const v1 = await chat(v, { "x-probe-adaptive-ttl": "true" });
    out.adaptive_ttl = { text: v1.content, ttl_set: (await report(POST, v1.report_id)).ttl_set ?? null };
    // Async invalidation through Bifrost's cache management API
    const s = Q(`Name one continent. (${nonce()})`);
    const s1 = await chat(s, { "x-probe-invalidate": "true" });
    await sleep(3500);
    const sRep = await report(POST, s1.report_id);
    const s2 = await chat(s);
    out.async_invalidation = { captured_cache_id: sRep.cache_id, invalidate_result: sRep.invalidate, next_request_hit: s2.cache_debug?.cache_hit ?? false };
    return out;
  },

  async cache_ttl_pre() {
    await start("pre-ttl");
    const t = Q(`Name one metal. (${nonce()})`);
    const t1 = await chat(t, { "x-probe-ttl": "4s" });
    await sleep(5000);
    const t3 = await chat(t);
    return {
      ttl_set_by_pre_builtin_plugin: (await report(PRE, t1.report_id)).ttl_set ?? null,
      pre_report: await report(PRE, t1.report_id),
      post_report_ttl: (await report(POST, t1.report_id)).ttl_set ?? null,
      t_plus_5s_hit: t3.cache_debug?.cache_hit ?? false,
      interpretation_if_true: "pre_builtin PostLLMHook runs AFTER semantic_cache wrote the entry, so its TTL is ignored",
    };
  },

  // E7 streaming
  async streaming() {
    await start("main");
    const t0 = performance.now();
    const r = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-probe-stream-note": "true" },
      body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 60, messages: [{ role: "user", content: Q(`Who wrote Hamlet? (${nonce()})`) }] }),
    });
    const id = r.headers.get("x-halflife-report");
    const body = await r.text();
    const ms = Math.round(performance.now() - t0);
    let assembled = "";
    let chunks = 0;
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5));
        chunks++;
        assembled += j.choices?.[0]?.delta?.content ?? "";
      } catch {}
    }
    await sleep(2500);
    const rep = await report(POST, id);
    return {
      status: r.status, ms, chunks, report_header_on_stream: id,
      client_text: assembled,
      note_appended_to_final_chunk: assembled.includes("[halflife: verification pending"),
      plugin_assembled_text: rep.text,
      plugin_text_matches_client_minus_note: assembled.replace(/ \[halflife: verification pending, report=[^\]]*\]/, "") === rep.text,
      report_status: rep.status,
      hooks: [...new Set(hooks(rep))],
    };
  },

  // E8 failure handling
  async failures() {
    const out = {};
    await start("main");
    const p = await chat(Q(`Name a fruit. (${nonce()})`), { "x-probe-panic": "true" });
    const after = await chat(Q(`Name a vegetable. (${nonce()})`));
    out.panic_in_post_hook = { status: p.status, content: p.content, raw: p.raw, gateway_alive_after: after.status === 200,
      container_running: spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", NAME], { encoding: "utf8" }).stdout.trim() };
    const sc = await chat("ignored", { "x-probe-shortcircuit": "true" });
    const scRaw = await (await fetch(`${GW}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-probe-shortcircuit": "true" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "x" }] }) })).text();
    const custom = await fetch(`${GW}/halflife/reports`);
    const customBody = (await custom.clone().text()).slice(0, 120);
    out.endpoints = { shortcircuit_status: sc.status, shortcircuit_body: scRaw.slice(0, 300), custom_route_status: custom.status, custom_route_body: customBody, sidecar_health: await (await fetch(`${POST}/health`)).json() };

    await start("bad-verifier");
    const bv = await chat(Q(`Name a river. (${nonce()})`));
    await sleep(4000);
    out.verifier_unreachable = { inference_status: bv.status, ms: bv.ms, report: (await report(POST, bv.report_id)) };
    out.verifier_unreachable.report = { status: out.verifier_unreachable.report.status, error: out.verifier_unreachable.report.error };

    await start("worker-panic");
    const wp = await chat(Q(`Name a bird. (${nonce()})`));
    await sleep(1000);
    const wpRep = await report(POST, wp.report_id);
    out.worker_panic = { inference_status: wp.status, report_status: wpRep.status, error: wpRep.error };

    await start("small-queue");
    const burst = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => chat(Q(`Name a number above ${i * 10}. (${nonce()})`))));
    const q = await (await fetch(`${POST}/reports`)).json();
    out.queue_saturation = { statuses: burst.map((b) => b.status), dropped: q.dropped };

    await start("fail-init");
    const fi = await chat(Q(`Name a tree. (${nonce()})`));
    const plugins = await (await fetch(`${GW}/api/plugins`)).text();
    out.plugin_init_failure = { inference_status: fi.status, content: fi.content, probe_headers_present: !!fi.report_id, plugins_api: plugins.slice(0, 1200) };
    return out;
  },

  // E10: expose the plugin's sidecar API (and a Tavily-shaped upstream) through a Bifrost Relay
  async relay() {
    await start("relay");
    const VK = { "x-bf-vk": "sk-bf-feasibility-local-only" };
    const ADMIN = { "X-Bifrost-Setup-Token": "feasibility-local-only-token" };
    const noVk = await fetch(`${GW}/relay/halflife/health`);
    const h = await fetch(`${GW}/relay/halflife/health`, { headers: VK });
    const hb = await h.text();
    const blocked = await fetch(`${GW}/relay/halflife/not-a-route`, { headers: VK });
    const calls = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${GW}/relay/halflife/mock-search`, { method: "POST", headers: { ...VK, "content-type": "application/json", authorization: "Bearer caller-secret-should-be-stripped" }, body: "{}" });
      const b = await r.text();
      calls.push({ i, status: r.status, body: b.slice(0, 160) });
      await sleep(300);
    }
    await sleep(1500);
    const lg = await fetch(`${GW}/api/relay-logs`, { headers: ADMIN });
    const vk = await fetch(`${GW}/api/governance/virtual-keys`, { headers: ADMIN });
    return { without_vk_status: noVk.status, health: { status: h.status, body: hb.slice(0, 200) }, unlisted_route_status: blocked.status,
      mock_search_calls_budget_0_05usd_cost_0_017_each: calls,
      relay_logs: { status: lg.status, body: (await lg.text()).slice(0, 2500) },
      virtual_keys: { status: vk.status, body: (await vk.text()).slice(0, 1500) } };
  },

  // E9 overhead: cached requests (no provider latency) to expose plugin + gateway overhead
  async overhead() {
    await start("main");
    const p = Q(`Name one shape. (${nonce()})`);
    await chat(p);
    await sleep(500);
    const lat = [];
    const hookNs = [];
    for (let i = 0; i < 40; i++) {
      const r = await chat(p);
      lat.push(r.ms);
      const rep = await report(POST, r.report_id);
      const h = rep.events?.find((e) => e.hook === "PostLLMHook");
      if (h?.hook_ns) hookNs.push(h.hook_ns);
    }
    lat.sort((a, b) => a - b);
    hookNs.sort((a, b) => a - b);
    const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
    return { cached_request_ms: { p50: pct(lat, 0.5), p95: pct(lat, 0.95) }, post_hook_us_on_hits: hookNs.length ? { p50: pct(hookNs, 0.5) / 1000, p95: pct(hookNs, 0.95) / 1000 } : "post_builtin probe does not run on cache hits" };
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(experiments);
const all = {};
try {
  for (const name of wanted) {
    log("running", name);
    try {
      all[name] = await experiments[name]();
    } catch (e) {
      all[name] = { error: String(e), logs_tail: logs().split("\n").slice(-40).join("\n") };
    }
    fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(all[name], null, 2));
    log("done", name, JSON.stringify(all[name]).slice(0, 300));
  }
} finally {
  fs.writeFileSync(path.join(RESULTS, "gateway-logs-last.txt"), logs().replace(/(api[_-]?key|authorization)[^\n]*/gi, "$1 [redacted]"));
  stop();
  mock.close();
}
