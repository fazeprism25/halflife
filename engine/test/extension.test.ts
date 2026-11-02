// Browser-extension API (AD-32): pairing, token scope and origin binding, strict validation,
// duplicate handling, limits, settings, console views, deletion and the schema migration.
// Model and search are scripted test doubles (AD-13); no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CacheActions } from "../src/cache.ts";
import { Bus } from "../src/events.ts";
import { assessmentOf, ExtensionService } from "../src/extension.ts";
import { Engine } from "../src/pipeline.ts";
import { createServer, type Health } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { FakeLLM, FakeSearch, NOW, testConfig } from "./fakes.ts";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const ANSWER = "Jack Dorsey is the CEO of Twitter. The Battle of Hastings was fought in 1066.";

const extraction = (req: { user: string }) => ({
  claims: req.user.includes("Jack Dorsey")
    ? [
        { span: "Jack Dorsey is the CEO of Twitter", statement: "Jack Dorsey is the CEO of Twitter.", class: "org.leadership", subject: "Twitter", attribute: "CEO", value: "Jack Dorsey", as_of: null, time_sensitive: true, search_query: "Twitter X CEO" },
        { span: "The Battle of Hastings was fought in 1066", statement: "The Battle of Hastings was fought in 1066.", class: "historical.fact", subject: "Battle of Hastings", attribute: "date", value: "1066", as_of: null, time_sensitive: false, search_query: "Battle of Hastings" },
      ]
    : [],
});
const results = () => [
  { url: "https://www.reuters.com/a", title: "X names new CEO", content: "On June 5, 2023, Linda Yaccarino took over as chief executive of Twitter, now called X.", score: 0.9, published_date: "2025-06-01" },
  { url: "https://apnews.com/b", title: "X leadership", content: "Linda Yaccarino is the CEO of X, the company formerly known as Twitter.", score: 0.8, published_date: "2026-03-10" },
];
const verdict = () => ({
  verdict: "superseded", current_value: "Linda Yaccarino", current_value_quote: { evidence_id: "E2", quote: "Linda Yaccarino is the CEO of X" }, changed_on: "2023-06-05", explanation: "Reuters and AP report a new CEO.",
  citations: [
    { evidence_id: "E1", quote: "Linda Yaccarino took over as chief executive of Twitter", stance: "refutes" },
    { evidence_id: "E2", quote: "Linda Yaccarino is the CEO of X", stance: "refutes" },
  ],
});

async function setup(t: any) {
  const store = new Store(":memory:");
  const bus = new Bus();
  const cache = new CacheActions(store, { bifrostUrl: "http://x", adminToken: "" });
  const llm = new FakeLLM({ halflife_claims: (r) => extraction(r), halflife_verdict: () => verdict() });
  const search = new FakeSearch(() => results());
  let now = NOW;
  const clock = () => now;
  const engine = new Engine({ cfg: testConfig(), store, llm, search, bus, cache, now: clock });
  const ext = new ExtensionService(store, engine, clock);
  const health: Health = {
    llm: { configured: true, model: "test", last_ok_at: null, last_error: null, last_error_at: null },
    search: { configured: true, last_ok_at: null, last_error: null, last_error_at: null },
    bifrost: { reachable: true, checked_at: NOW, error: null },
  };
  const server = createServer({ cfg: testConfig(), engine, store, health, ext });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const consoleH = { "x-halflife-console": "1", "content-type": "application/json" };
  const call = async (method: string, p: string, o: { headers?: Record<string, string>; body?: unknown } = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...o.headers }, body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const pair = async (origin = ORIGIN) => {
    const code = (await call("POST", "/v1/extension/pairing-codes", { headers: consoleH, body: {} })).body.code;
    const r = await call("POST", "/v1/extension/pair", { headers: { origin }, body: { code } });
    assert.equal(r.status, 201);
    return { "x-test": "1", authorization: `Bearer ${r.body.token}`, origin } as Record<string, string>;
  };
  return { store, engine, ext, search, llm, call, pair, consoleH, base, port: (server.address() as any).port, advance: (ms: number) => (now += ms) };
}

test("pairing: one-time code, extension origin required, token bound to that origin", async (t) => {
  const { call, consoleH } = await setup(t);
  // Only the console can create codes: no credential, or an extension token, cannot.
  assert.equal((await call("POST", "/v1/extension/pairing-codes", { body: {} })).status, 401);
  const { code, expires_at } = (await call("POST", "/v1/extension/pairing-codes", { headers: consoleH, body: { label: "laptop" } })).body;
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.equal(expires_at, NOW + 10 * 60_000);
  assert.equal((await call("POST", "/v1/extension/pair", { body: { code } })).status, 403, "no Origin header");
  assert.equal((await call("POST", "/v1/extension/pair", { headers: { origin: "https://chatgpt.com" }, body: { code } })).status, 403, "a web page cannot pair");
  assert.equal((await call("POST", "/v1/extension/pair", { headers: { origin: ORIGIN }, body: { code: "WRONGCOD" } })).status, 401);
  const ok = await call("POST", "/v1/extension/pair", { headers: { origin: ORIGIN }, body: { code: code.toLowerCase().slice(0, 4) + "-" + code.slice(4) } });
  assert.equal(ok.status, 201, "codes are case- and dash-insensitive");
  assert.match(ok.body.token, /^hlx_[A-Za-z0-9_-]{43}$/);
  assert.equal((await call("POST", "/v1/extension/pair", { headers: { origin: ORIGIN }, body: { code } })).status, 401, "a code works once");

  const auth = { authorization: `Bearer ${ok.body.token}` };
  assert.equal((await call("GET", "/v1/extension/status", { headers: { ...auth, origin: ORIGIN } })).status, 200);
  assert.equal((await call("GET", "/v1/extension/status", { headers: auth })).status, 200, "no Origin (non-browser client holding the token)");
  assert.equal((await call("GET", "/v1/extension/status", { headers: { ...auth, origin: OTHER } })).status, 401, "another extension");
  assert.equal((await call("GET", "/v1/extension/status", { headers: { ...auth, origin: "https://chatgpt.com" } })).status, 401, "a web page with a leaked token");
});

test("pairing: repeated wrong codes withdraw every outstanding code", async (t) => {
  const { call, consoleH } = await setup(t);
  const { code } = (await call("POST", "/v1/extension/pairing-codes", { headers: consoleH, body: {} })).body;
  for (let i = 0; i < 10; i++) await call("POST", "/v1/extension/pair", { headers: { origin: ORIGIN }, body: { code: `BAD${i}XXXX` } });
  assert.equal((await call("POST", "/v1/extension/pair", { headers: { origin: ORIGIN }, body: { code } })).status, 401);
});

test("extension token scope: own checks and status only; loopback Host only", async (t) => {
  const { call, pair, port } = await setup(t);
  const a = await pair();
  assert.equal((await call("GET", "/v1/reports", { headers: a })).status, 401, "cannot read gateway traffic");
  assert.equal((await call("POST", "/v1/check", { headers: a, body: { text: ANSWER } })).status, 401);
  assert.equal((await call("GET", "/v1/events", { headers: a })).status, 401);
  for (const p of ["/v1/extension/activity", "/v1/extension/settings", "/v1/extension/claims", "/v1/extension/trends"]) {
    assert.equal((await call("GET", p, { headers: a })).status, 404, `${p} is console-only`);
  }
  assert.equal((await call("DELETE", "/v1/extension/reports?confirm=all", { headers: a })).status, 404);
  // DNS-rebinding defence: a non-loopback Host is refused before any credential is looked at.
  const status = await new Promise<number>((resolve) => {
    http.request({ host: "127.0.0.1", port, path: "/v1/extension/status", headers: { host: "evil.example:8090", authorization: a.authorization } }, (r) => {
      r.resume();
      resolve(r.statusCode!);
    }).end();
  });
  assert.equal(status, 403);
});

test("check: runs the normal pipeline with learn:false; duplicates reuse the analysis", async (t) => {
  const { call, pair, engine, store, search } = await setup(t);
  const a = await pair();
  const req = { platform: "chatgpt", message_id: "msg-0001", question: "Who runs Twitter?", answer: ANSWER, model: "gpt-5-5", conversation_hash: "a".repeat(64) };
  const r = await call("POST", "/v1/extension/checks", { headers: a, body: req });
  assert.equal(r.status, 202);
  assert.ok(["queued", "running"].includes(r.body.status));
  assert.equal(r.body.duplicate, false);
  assert.equal(r.body.dashboard_path, `/#/activity/${r.body.id}`);
  await engine.drain();
  const v = (await call("GET", `/v1/extension/checks/${r.body.id}`, { headers: a })).body;
  assert.equal(v.status, "done");
  assert.equal(v.assessment, "outdated");
  assert.equal(v.live_verification, true);
  assert.deepEqual({ claims: v.counts.claims, ts: v.counts.time_sensitive, outdated: v.counts.outdated, superseded: v.counts.superseded }, { claims: 2, ts: 1, outdated: 1, superseded: 1 });
  const row = store.get("SELECT source, prompt, model, client_ref, client_meta FROM reports WHERE id=?", r.body.id)!;
  assert.equal(row.source, "extension");
  assert.equal(row.prompt, "Who runs Twitter?");
  assert.equal(row.model, "chatgpt/gpt-5-5");
  assert.equal(row.client_ref, "chatgpt:msg-0001");
  assert.deepEqual(JSON.parse(row.client_meta), { platform: "chatgpt", message_id: "msg-0001", model: "gpt-5-5", conversation_hash: "a".repeat(64), question_missing: false });
  assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM observations")!.n), 0, "user-selected checks never become learning observations");
  const searches = search.searches.length;

  // Same message, same text (whitespace differences ignored): existing analysis, no new spend.
  const dup = await call("POST", "/v1/extension/checks", { headers: a, body: { ...req, answer: `  ${ANSWER.replace(". ", ".  ")}\n` } });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.id, r.body.id);
  // Edited / re-rendered text under the same id: a new analysis.
  const edited = await call("POST", "/v1/extension/checks", { headers: a, body: { ...req, answer: ANSWER + " It has 500 employees." } });
  assert.equal(edited.status, 202);
  assert.notEqual(edited.body.id, r.body.id);
  // Explicit re-check.
  const forced = await call("POST", "/v1/extension/checks", { headers: a, body: { ...req, force: true } });
  assert.equal(forced.status, 202);
  await engine.drain();
  assert.equal(search.searches.length, searches, "re-checks within the reuse window use stored evidence (T0)");
  assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM reports WHERE source='extension'")!.n), 3);
  // Without a message id the reference falls back to a content hash.
  const anon = await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", answer: "Nothing to see." } });
  assert.match(store.get("SELECT client_ref FROM reports WHERE id=?", anon.body.id)!.client_ref, /^chatgpt:hash:[a-f0-9]{24}$/);
});

test("check validation: strict structure and size limits", async (t) => {
  const { call, pair } = await setup(t);
  const a = await pair();
  const base = { platform: "chatgpt", answer: ANSWER };
  const bad: [unknown, number][] = [
    [{ ...base, page_html: "<html>" }, 400],
    [{ ...base, platform: "gemini" }, 400],
    [{ platform: "chatgpt" }, 400],
    [{ ...base, answer: "   " }, 400],
    [{ ...base, answer: "x".repeat(60_001) }, 413],
    [{ ...base, question: "q".repeat(4_001) }, 413],
    [{ ...base, message_id: "../../etc" }, 400],
    [{ ...base, model: "<script>" }, 400],
    [{ ...base, conversation_hash: "not-a-hash" }, 400],
    [{ ...base, force: "yes" }, 400],
    [[base], 400],
  ];
  for (const [body, status] of bad) assert.equal((await call("POST", "/v1/extension/checks", { headers: a, body })).status, status, JSON.stringify(body).slice(0, 60));
  assert.equal((await call("POST", "/v1/extension/checks", { headers: a, body: "{nope" })).status, 400);
  assert.equal((await call("POST", "/v1/extension/checks", { headers: { ...a, "content-type": "text/plain" }, body: JSON.stringify(base) })).status, 415);
  assert.equal((await call("POST", "/v1/extension/checks", { headers: a, body: { ...base, answer: "y".repeat(300_000) } })).status, 413, "body limit");
});

test("settings: kill switch, assess-only mode, per-minute and daily limits", async (t) => {
  const { call, pair, consoleH, engine, search, advance } = await setup(t);
  const a = await pair();
  const send = (n: number) => call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: `m${n}`, answer: `${ANSWER} (${n})` } });
  assert.equal((await call("PUT", "/v1/extension/settings", { headers: consoleH, body: { accept_checks: "no" } })).status, 400);
  assert.equal((await call("PUT", "/v1/extension/settings", { headers: consoleH, body: { surprise: 1 } })).status, 400);
  assert.equal((await call("PUT", "/v1/extension/settings", { headers: consoleH, body: { retention_days: 0 } })).status, 400);

  await call("PUT", "/v1/extension/settings", { headers: consoleH, body: { accept_checks: false } });
  assert.equal((await send(1)).status, 403);
  assert.equal((await call("GET", "/v1/extension/status", { headers: a })).body.accept_checks, false);

  await call("PUT", "/v1/extension/settings", { headers: consoleH, body: { accept_checks: true, live_verification: false } });
  const r = await send(2);
  await engine.drain();
  const v = (await call("GET", `/v1/extension/checks/${r.body.id}`, { headers: a })).body;
  assert.equal(v.live_verification, false);
  assert.equal(search.searches.length, 0, "assess-only: no live search");
  assert.equal(v.assessment, "unverified");

  await call("PUT", "/v1/extension/settings", { headers: consoleH, body: { per_minute_limit: 2, daily_limit: 2 } });
  assert.equal((await send(3)).status, 202);
  assert.equal((await send(4)).status, 429, "per-minute limit (2 in this minute)");
  advance(61_000);
  assert.equal((await send(5)).status, 429, "daily limit (2 today)");
  const st = (await call("GET", "/v1/extension/status", { headers: a })).body;
  assert.deepEqual({ today: st.checks_today, limit: st.daily_limit, total: st.total_checks }, { today: 2, limit: 2, total: 2 });
});

test("connections are isolated; revoked tokens stop working", async (t) => {
  const { call, pair, consoleH, engine } = await setup(t);
  const a = await pair();
  const b = await pair(OTHER);
  const r = await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: "m1", answer: ANSWER } });
  await engine.drain();
  assert.equal((await call("GET", `/v1/extension/checks/${r.body.id}`, { headers: b })).status, 404, "B cannot read A's check");
  assert.equal((await call("GET", "/v1/extension/checks", { headers: b })).body.checks.length, 0);
  const mine = (await call("GET", "/v1/extension/checks", { headers: a })).body.checks;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].question, ANSWER, "no question was sent, so the answer preview is shown");
  const conns = (await call("GET", "/v1/extension/settings", { headers: consoleH })).body.connections;
  assert.equal(conns.length, 2);
  const aId = conns.find((c: any) => c.origin === ORIGIN).id;
  assert.equal(conns.find((c: any) => c.id === aId).checks, 1);
  assert.equal((await call("DELETE", `/v1/extension/connections/${aId}`, { headers: consoleH })).status, 200);
  assert.equal((await call("GET", "/v1/extension/status", { headers: a })).status, 401);
  // Disconnect from the extension side.
  assert.equal((await call("DELETE", "/v1/extension/token", { headers: b })).status, 200);
  assert.equal((await call("GET", "/v1/extension/status", { headers: b })).status, 401);
});

test("console views: activity, claim explorer and trends cover extension checks only", async (t) => {
  const { call, pair, consoleH, engine, advance } = await setup(t);
  const a = await pair();
  engine.accept({ text: "Gateway traffic: Jack Dorsey is the CEO of Twitter.", model: "openai/gpt-4o-mini" }, "gateway");
  const r1 = await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: "m1", question: "Who runs Twitter?", answer: ANSWER } });
  await engine.drain();
  advance(24 * 3600 * 1000);
  await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: "m2", answer: "Nothing time-sensitive here." } });
  await engine.drain();

  const act = (await call("GET", "/v1/extension/activity", { headers: consoleH })).body.checks;
  assert.equal(act.length, 2, "gateway traffic is not listed");
  assert.deepEqual(act.map((x: any) => x.assessment), ["no_claims", "outdated"]);
  assert.equal(act[1].question, "Who runs Twitter?");
  assert.equal(act[1].at_risk, 1);

  const all = (await call("GET", "/v1/extension/claims", { headers: consoleH })).body.claims;
  assert.equal(all.length, 2, "gateway claims excluded");
  const out = (await call("GET", "/v1/extension/claims?verdict=outdated", { headers: consoleH })).body.claims;
  assert.equal(out.length, 1);
  assert.equal(out[0].current_value, "Linda Yaccarino");
  assert.equal(out[0].sources.length, 2, "quote-verified sources only");
  assert.ok(out[0].half_life_years.median > 0);
  assert.equal((await call("GET", "/v1/extension/claims?verdict=static", { headers: consoleH })).body.claims[0].class.id, "historical.fact");
  assert.equal((await call("GET", "/v1/extension/claims?q=hastings", { headers: consoleH })).body.claims.length, 1);
  assert.equal((await call("GET", "/v1/extension/claims?q=%25", { headers: consoleH })).body.claims.length, 0, "LIKE wildcards are escaped");

  const tr = (await call("GET", "/v1/extension/trends?days=7", { headers: consoleH })).body;
  assert.equal(tr.series.length, 7);
  const days = tr.series.filter((d: any) => d.responses);
  assert.deepEqual(days.map((d: any) => [d.day, d.responses, d.outdated]), [["2026-11-02", 1, 1], ["2026-11-03", 1, 0]]);
  assert.deepEqual(tr.classes, [{ class: "org.leadership", label: tr.classes[0].label, outdated: 1 }]);
  assert.equal(tr.outcomes.superseded, 1);
  assert.equal(tr.outcomes.not_time_sensitive, 1);
  assert.equal(r1.status, 202);
});

test("deletion and retention remove extension checks only", async (t) => {
  const { call, pair, consoleH, engine, store, ext, advance } = await setup(t);
  const a = await pair();
  const g = engine.accept({ text: "Gateway answer." }, "gateway");
  const r = await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: "m1", answer: ANSWER } });
  await engine.drain();
  assert.equal((await call("DELETE", `/v1/extension/reports/${g.id}`, { headers: consoleH })).status, 404, "gateway reports are not deletable here");
  assert.equal((await call("DELETE", `/v1/extension/reports/${r.body.id}`, { headers: consoleH })).status, 200);
  assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM claims WHERE report_id=?", r.body.id)!.n), 0, "claims cascade");
  await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: "m2", answer: "Another answer." } });
  await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: "m3", answer: "A third answer." } });
  await engine.drain();
  assert.equal((await call("DELETE", "/v1/extension/reports", { headers: consoleH })).status, 400, "confirmation required");
  assert.equal((await call("DELETE", "/v1/extension/reports?confirm=all", { headers: consoleH })).body.deleted, 2);
  await call("POST", "/v1/extension/checks", { headers: a, body: { platform: "chatgpt", message_id: "m4", answer: "Old answer." } });
  await engine.drain();
  advance(31 * 24 * 3600 * 1000);
  assert.equal(ext.sweep(), 1, "default retention is 30 days");
  assert.ok(store.get("SELECT id FROM reports WHERE id=?", g.id), "gateway report kept");
});

test("assessment mapping is derived from the engine summary", () => {
  const s = (o: any) => ({ claims: 2, time_sensitive: 1, at_risk: 1, checked: 1, stale: 0, possibly_stale: 0, weak_current: 0, verdicts: { current: 1, superseded: 0, contradicted: 0, unverifiable: 0 }, ...o });
  assert.equal(assessmentOf(null), null);
  assert.equal(assessmentOf(s({ claims: 0 })), "no_claims");
  assert.equal(assessmentOf(s({ time_sensitive: 0 })), "no_time_sensitive");
  assert.equal(assessmentOf(s({ stale: 1 })), "outdated");
  assert.equal(assessmentOf(s({ possibly_stale: 1 })), "possibly_outdated");
  assert.equal(assessmentOf(s({ at_risk: 2 })), "unverified", "an at-risk claim was not checked");
  assert.equal(assessmentOf(s({ weak_current: 1 })), "unverified", "current only on weak evidence");
  assert.equal(assessmentOf(s({})), "current");
  assert.equal(assessmentOf(s({ at_risk: 0, checked: 0 })), "low_risk");
});

test("migration adds the extension columns to a database from an earlier version", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hl-mig-")), "old.db");
  new Store(file).close();
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX reports_client; DROP TABLE extension_tokens; ALTER TABLE reports DROP COLUMN client_ref; ALTER TABLE reports DROP COLUMN content_hash; ALTER TABLE reports DROP COLUMN client_id; ALTER TABLE reports DROP COLUMN client_meta;");
  db.exec("INSERT INTO reports (id, created_at, source, mode, text, status) VALUES ('hl_0000000000000001', 1, 'gateway', 'async', 'old', 'done')");
  db.close();
  const s = new Store(file);
  const cols = s.all("PRAGMA table_info(reports)").map((r) => r.name);
  for (const c of ["client_ref", "content_hash", "client_id", "client_meta"]) assert.ok(cols.includes(c), c);
  assert.ok(s.get("SELECT id FROM reports WHERE id='hl_0000000000000001'"), "existing rows kept");
  assert.ok(s.get("SELECT name FROM sqlite_master WHERE name='extension_tokens'"));
  s.close();
});
