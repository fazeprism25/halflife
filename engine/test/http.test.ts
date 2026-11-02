// HTTP surface (auth, routing, static safety) and the Bifrost/Tavily clients (wire behaviour,
// error mapping). Clients are exercised against an in-process fake gateway (test fixture).
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { CacheActions } from "../src/cache.ts";
import { extraBodyFor } from "../src/config.ts";
import { Bus } from "../src/events.ts";
import { BifrostLLM, LLMError, parseJSONLoose } from "../src/llm.ts";
import { Engine } from "../src/pipeline.ts";
import { createServer, type Health } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { SearchError, TavilyViaBifrost } from "../src/tavily.ts";
import { FakeLLM, FakeSearch, testConfig } from "./fakes.ts";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address() as any;
  return `http://127.0.0.1:${a.port}`;
}

function engineServer(over: any = {}) {
  const cfg = testConfig(over);
  const store = new Store(":memory:");
  const bus = new Bus();
  const cache = new CacheActions(store, { bifrostUrl: "http://x", adminToken: "" });
  const llm = new FakeLLM({ halflife_claims: () => ({ claims: [] }), halflife_verdict: () => ({}) });
  const engine = new Engine({ cfg, store, llm, search: new FakeSearch(() => []), bus, cache });
  const health: Health = {
    llm: { configured: true, model: "test", last_ok_at: null, last_error: null, last_error_at: null },
    search: { configured: true, last_ok_at: null, last_error: null, last_error_at: null },
    bifrost: { reachable: true, checked_at: Date.now(), error: null },
  };
  return { server: createServer({ cfg, engine, store, health }), engine };
}

test("API authentication: plugin, relay and console scopes are separated", async (t) => {
  const { server, engine } = engineServer();
  const base = await listen(server);
  t.after(() => server.close());
  const j = { "content-type": "application/json" };
  const body = JSON.stringify({ text: "The CEO of X is Y." });

  assert.equal((await fetch(`${base}/v1/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/reports`)).status, 401, "no credential");
  assert.equal((await fetch(`${base}/v1/reports`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${base}/v1/reports`, { headers: { authorization: "Bearer relay-test" } })).status, 200, "relay token");
  assert.equal((await fetch(`${base}/v1/reports`, { headers: { "x-halflife-console": "1" } })).status, 200, "console header");
  // the plugin token cannot read reports; the relay token cannot ingest
  assert.equal((await fetch(`${base}/v1/reports`, { headers: { authorization: "Bearer ingest-test" } })).status, 403);
  assert.equal((await fetch(`${base}/v1/ingest`, { method: "POST", headers: { ...j, authorization: "Bearer relay-test" }, body })).status, 403);
  const ing = await fetch(`${base}/v1/ingest`, { method: "POST", headers: { ...j, authorization: "Bearer ingest-test" }, body });
  assert.equal(ing.status, 202);
  // console-only endpoints are not reachable through the relay
  assert.equal((await fetch(`${base}/v1/playground`, { method: "POST", headers: { ...j, authorization: "Bearer relay-test" }, body: "{}" })).status, 404);
  // input validation and content type
  assert.equal((await fetch(`${base}/v1/check`, { method: "POST", headers: { authorization: "Bearer relay-test", "content-type": "text/plain" }, body })).status, 415);
  assert.equal((await fetch(`${base}/v1/check`, { method: "POST", headers: { ...j, authorization: "Bearer relay-test" }, body: "{bad" })).status, 400);
  assert.equal((await fetch(`${base}/v1/check`, { method: "POST", headers: { ...j, authorization: "Bearer relay-test" }, body: JSON.stringify({ text: "" }) })).status, 400);
  const big = await fetch(`${base}/v1/check`, { method: "POST", headers: { ...j, authorization: "Bearer relay-test" }, body: JSON.stringify({ text: "x".repeat(300000) }) });
  assert.equal(big.status, 413);
  const chk = await fetch(`${base}/v1/check`, { method: "POST", headers: { ...j, authorization: "Bearer relay-test" }, body: JSON.stringify({ text: "Nothing time sensitive.", wait: true }) });
  assert.equal(chk.status, 200);
  assert.equal((await chk.json()).status, "done");
  await engine.drain();
});

test("console token, when configured, is required", async (t) => {
  const { server } = engineServer({ consoleToken: "s3cret" });
  const base = await listen(server);
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/v1/reports`, { headers: { "x-halflife-console": "1" } })).status, 401);
  assert.equal((await fetch(`${base}/v1/reports`, { headers: { "x-halflife-console": "s3cret" } })).status, 200);
});

test("static serving blocks path traversal and sets a strict CSP", async (t) => {
  const { server } = engineServer();
  const base = await listen(server);
  t.after(() => server.close());
  const r = await fetch(`${base}/../src/config.ts`);
  assert.notEqual(r.status, 200);
  const enc = await fetch(`${base}/%2e%2e/src/config.ts`);
  assert.notEqual(enc.status, 200);
  const idx = await fetch(`${base}/`);
  if (idx.status === 200) assert.match(idx.headers.get("content-security-policy") ?? "", /script-src 'self'/);
});

function fakeGateway(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    seen.push({ url: req.url!, headers: req.headers, body: b ? JSON.parse(b) : null });
    handler(req, b, res);
  });
  return { server, seen };
}

test("BifrostLLM sends the engine VK and internal token, steps down structured output on 400, maps 402", async (t) => {
  let n = 0;
  const { server, seen } = fakeGateway((req, body, res) => {
    n++;
    const j = JSON.parse(body);
    if (j.response_format?.type === "json_schema") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "response_format json_schema not supported" } }));
    }
    if (j.model === "broke/model") {
      res.writeHead(402);
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: "```json\n{\"claims\": []}\n```" } }], usage: { total_tokens: 7 } }));
  });
  const base = await listen(server);
  t.after(() => server.close());
  const llm = new BifrostLLM({ bifrostUrl: base, model: "openai/gpt-x", virtualKey: "sk-bf-e", internalToken: "tok", timeoutMs: 2000 });
  const r = await llm.json({ name: "t", system: "s", user: "u", schema: {}, maxTokens: 10 });
  assert.deepEqual(r.data, { claims: [] });
  assert.equal(seen[0].headers["x-bf-vk"], "sk-bf-e");
  assert.equal(seen[0].headers["x-halflife-internal"], "tok");
  assert.equal(seen[1].body.response_format.type, "json_object", "stepped down after 400");
  assert.equal(seen[1].body.temperature, 0);
  const broke = new BifrostLLM({ bifrostUrl: base, model: "broke/model", virtualKey: "v", internalToken: "t", timeoutMs: 2000 });
  await assert.rejects(broke.json({ name: "t", system: "s", user: "u", schema: {}, maxTokens: 10 }), (e: any) => e instanceof LLMError && e.kind === "budget");
});

test("BifrostLLM: provider request fields, 429 Retry-After, blank JSON-mode content, non-format 400s", async (t) => {
  const calls: any[] = [];
  let mode = "";
  const { server } = fakeGateway((req, body, res) => {
    const j = JSON.parse(body);
    calls.push(j);
    const n = calls.length;
    const ok = (content: string) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content } }] }));
    };
    if (mode === "429" && n === 1) {
      res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Rate limit reached" } }));
    }
    if (mode === "blank" && n === 1) return ok("   "); // DeepSeek JSON mode may return only spaces
    if (mode === "ctx") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 1000000 tokens" } }));
    }
    if (mode === "balance") {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
    }
    ok('{"ok": true}');
  });
  const base = await listen(server);
  t.after(() => server.close());
  const mk = () => new BifrostLLM({ bifrostUrl: base, model: "deepseek/deepseek-flash", virtualKey: "v", internalToken: "t", extraBody: { thinking: { type: "disabled" } }, timeoutMs: 2000 });
  const req = { name: "t", system: "s", user: "u", schema: {}, maxTokens: 10 };

  mode = "429";
  const r1 = await mk().json(req);
  assert.deepEqual(r1.data, { ok: true });
  assert.equal(calls.length, 2, "429 retried once");
  assert.deepEqual(calls[0].thinking, { type: "disabled" }, "provider field sent");
  assert.equal(calls[0].model, "deepseek/deepseek-flash", "extra body cannot override the model");
  assert.equal(calls[1].response_format.type, "json_schema", "a 429 does not step the format down");

  calls.length = 0;
  mode = "blank";
  assert.deepEqual((await mk().json(req)).data, { ok: true });
  assert.equal(calls.length, 2, "blank content retried once");

  calls.length = 0;
  mode = "ctx";
  const llm = mk();
  await assert.rejects(llm.json(req), (e: any) => e.kind === "http" && e.status === 400);
  assert.equal(calls.length, 1, "a non-format 400 is not retried");
  mode = "";
  await llm.json(req);
  assert.equal(calls.at(-1).response_format.type, "json_schema", "a non-format 400 does not degrade later calls");

  mode = "balance";
  await assert.rejects(mk().json(req), (e: any) => e.kind === "budget" && /Insufficient Balance/.test(e.message));
});

test("extraBodyFor: per-provider defaults, JSON override, invalid override ignored", () => {
  const per = { deepseek: { thinking: { type: "disabled" } } };
  assert.deepEqual(extraBodyFor("deepseek/deepseek-flash", per, undefined), { thinking: { type: "disabled" } });
  assert.deepEqual(extraBodyFor("openai/gpt-4.1-mini", per, undefined), {});
  assert.deepEqual(extraBodyFor("deepseek/deepseek-flash", per, '{"reasoning_effort":"low"}'), { reasoning_effort: "low" });
  assert.deepEqual(extraBodyFor("deepseek/deepseek-flash", per, "{not json"), { thinking: { type: "disabled" } });
  assert.deepEqual(extraBodyFor("", undefined, undefined), {});
});

test("BifrostLLM times out", async (t) => {
  const { server } = fakeGateway(() => {
    /* never answers */
  });
  const base = await listen(server);
  t.after(() => server.closeAllConnections?.() ?? server.close());
  const llm = new BifrostLLM({ bifrostUrl: base, model: "m", virtualKey: "v", internalToken: "t", timeoutMs: 300 });
  const t0 = Date.now();
  await assert.rejects(llm.json({ name: "t", system: "s", user: "u", schema: {}, maxTokens: 10 }), (e: any) => e.kind === "timeout");
  assert.ok(Date.now() - t0 < 3000);
  server.closeAllConnections?.();
});

test("Tavily via relay: request shape, results, and error mapping (402/432/433/429/401)", async (t) => {
  let status = 200;
  const { server, seen } = fakeGateway((req, body, res) => {
    if (status !== 200) {
      res.writeHead(status, status === 429 ? { "retry-after": "3" } : {});
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ url: "https://a.com/x", title: "T", content: "C", score: 0.5, published_date: "2026-01-02" }, { nourl: 1 }], usage: { credits: 1 } }));
  });
  const base = await listen(server);
  t.after(() => server.close());
  const tv = new TavilyViaBifrost({ bifrostUrl: base, virtualKey: "sk-bf-e", searchTimeoutMs: 2000, extractTimeoutMs: 2000 });
  const r = await tv.search({ query: "q", topic: "news", maxResults: 5, depth: "basic" });
  assert.equal(seen[0].url, "/relay/tavily/search");
  assert.equal(seen[0].headers["x-bf-vk"], "sk-bf-e");
  assert.equal(seen[0].headers.authorization, undefined, "the engine never sends a Tavily key");
  assert.equal(seen[0].body.topic, "news");
  assert.equal(seen[0].body.include_usage, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.credits, 1);
  for (const [s, kind] of [[402, "budget"], [432, "budget"], [433, "budget"], [429, "rate_limit"], [401, "auth"], [500, "http"]] as const) {
    status = s;
    await assert.rejects(tv.search({ query: "q", topic: "general", maxResults: 1, depth: "basic" }), (e: any) => e instanceof SearchError && e.kind === kind, `status ${s}`);
  }
});

test("parseJSONLoose", () => {
  assert.deepEqual(parseJSONLoose('Sure! {"a":1} hope that helps'), { a: 1 });
  assert.equal(parseJSONLoose("no json"), undefined);
});
