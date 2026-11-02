// TEST FIXTURE SERVER. The real engine, store and HTTP server (console included) with scripted
// model and search doubles, for visual review of the console and end-to-end tests of the browser
// extension without spending any LLM tokens or Tavily credits. Every answer, claim and source it
// produces is a fixture and is labelled as such. Never used by the product (AD-13).
//
//   node engine/test/fixture-server.ts [--port 8099] [--seed]
//     --seed   adds TEST FIXTURE extension checks spread over the past days
//     --usage <limit|none|error>   scripted Tavily /usage reading (AD-34): a TEST FIXTURE account
//              allowance, no plan_limit at all, or a read that always fails
import { CacheActions } from "../src/cache.ts";
import { parseUsage } from "../src/credits.ts";
import { Bus } from "../src/events.ts";
import { ExtensionService } from "../src/extension.ts";
import { Engine } from "../src/pipeline.ts";
import { createServer, type Health } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { FakeLLM, FakeSearch, testConfig } from "./fakes.ts";

const arg = (k: string) => process.argv.includes(k);
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8099;

/** Scripted claims: each fixture sentence maps to one claim with a known class and outcome. */
const FACTS: { re: RegExp; claim: any; outcome?: "superseded" | "current" | "contradicted" | "unverifiable" }[] = [
  { re: /Jack Dorsey is the CEO of Twitter/, claim: { statement: "Jack Dorsey is the CEO of Twitter.", class: "org.leadership", subject: "Twitter", attribute: "CEO", value: "Jack Dorsey", search_query: "Twitter X CEO" }, outcome: "superseded" },
  { re: /latest stable Python release is 3\.11/, claim: { statement: "The latest stable Python release is 3.11.", class: "software.version", subject: "Python", attribute: "latest version", value: "3.11", search_query: "latest Python release" }, outcome: "superseded" },
  { re: /Node\.js 24 is the active LTS/, claim: { statement: "Node.js 24 is the active LTS release.", class: "software.version", subject: "Node.js", attribute: "active LTS", value: "24", search_query: "Node.js active LTS" }, outcome: "current" },
  { re: /Tokyo has about 14 million people/, claim: { statement: "Tokyo has about 14 million people.", class: "stats.indicator", subject: "Tokyo", attribute: "population", value: "14 million", search_query: "Tokyo population" }, outcome: "current" },
  { re: /The Battle of Hastings was fought in 1066/, claim: { statement: "The Battle of Hastings was fought in 1066.", class: "historical.fact", subject: "Battle of Hastings", attribute: "date", value: "1066", search_query: "Battle of Hastings", time_sensitive: false } },
  { re: /UK Prime Minister is Rishi Sunak/, claim: { statement: "The UK Prime Minister is Rishi Sunak.", class: "gov.office_holder", subject: "UK", attribute: "Prime Minister", value: "Rishi Sunak", search_query: "UK Prime Minister" }, outcome: "superseded" },
  { re: /GPT-4 has a context window of 8k tokens/, claim: { statement: "GPT-4 has a context window of 8k tokens.", class: "product.offering", subject: "GPT-4", attribute: "context window", value: "8k", search_query: "GPT-4 context window" }, outcome: "unverifiable" },
];

const llm = new FakeLLM({
  halflife_claims: (req) => ({
    claims: FACTS.filter((f) => f.re.test(req.user)).map((f) => {
      const span = req.user.match(f.re)![0];
      return { span, as_of: null, time_sensitive: true, ...f.claim };
    }),
  }),
  halflife_verdict: (req) => {
    const f = FACTS.find((x) => req.user.includes(x.claim.statement));
    const o = f?.outcome ?? "unverifiable";
    if (o === "unverifiable") return { verdict: "unverifiable", explanation: "[TEST FIXTURE] The sources do not state the value.", citations: [] };
    const stance = o === "current" ? "supports" : "refutes";
    return {
      verdict: o, explanation: `[TEST FIXTURE] Scripted ${o} verdict.`,
      current_value: o === "current" ? null : "[fixture] new value", current_value_quote: o === "current" ? null : { evidence_id: "E1", quote: "TEST FIXTURE source states the new value" },
      changed_on: o === "current" ? null : "2025-06-01",
      citations: [{ evidence_id: "E1", quote: "TEST FIXTURE source states the new value", stance }, { evidence_id: "E2", quote: "A second TEST FIXTURE source agrees", stance }],
    };
  },
});
const search = new FakeSearch(() => [
  { url: "https://fixture.example/a", title: "TEST FIXTURE source A", content: "TEST FIXTURE source states the new value. This page is a scripted test fixture.", score: 0.9, published_date: "2026-10-01" },
  { url: "https://fixture.example/b", title: "TEST FIXTURE source B", content: "A second TEST FIXTURE source agrees with source A.", score: 0.8, published_date: "2026-09-15" },
]);

// Scripted /usage. Must be attached before the Engine is built (it binds search.usage).
const usageArg = process.argv.includes("--usage") ? process.argv[process.argv.indexOf("--usage") + 1] : null;
if (usageArg) {
  (search as any).usage = async () => {
    if (usageArg === "error") throw new Error("Tavily /usage HTTP 503 (TEST FIXTURE)");
    const account: Record<string, unknown> = { current_plan: "TEST FIXTURE", plan_usage: 131, paygo_usage: 0, paygo_limit: null };
    if (usageArg !== "none") account.plan_limit = Number(usageArg);
    return parseUsage({ key: { usage: 131, limit: null }, account });
  };
}

let offset = 0; // lets --seed place checks on earlier days
const store = new Store(":memory:");
const bus = new Bus();
const cfg = testConfig({ consoleToken: "" });
const engine = new Engine({ cfg, store, llm, search, bus, cache: new CacheActions(store, { bifrostUrl: "http://x", adminToken: "" }), now: () => Date.now() - offset });
const ext = new ExtensionService(store, engine, () => Date.now() - offset);
if (usageArg) await engine.credits.refresh(); // as main.ts does at start
const health: Health = {
  llm: { configured: true, model: "test/fake-llm (fixture)", last_ok_at: Date.now(), last_error: null, last_error_at: null },
  search: { configured: true, last_ok_at: Date.now(), last_error: null, last_error_at: null },
  bifrost: { reachable: null, checked_at: null, error: "fixture server: no gateway" },
};

if (arg("--seed")) {
  ext.updateSettings({ daily_limit: 1000, per_minute_limit: 60 });
  const conn = { id: "ext_00000000f1f1", origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" };
  store.insert("extension_tokens", { id: conn.id, token_hash: "fixture", origin: conn.origin, label: "TEST FIXTURE browser", created_at: Date.now() - 9 * 864e5, last_used_at: Date.now() - 3600e3, revoked_at: null });
  const seeds: [number, string, string][] = [
    [8, "[TEST FIXTURE] Who runs Twitter?", "[TEST FIXTURE] Jack Dorsey is the CEO of Twitter. The Battle of Hastings was fought in 1066."],
    [6, "[TEST FIXTURE] Which Python should I install?", "[TEST FIXTURE] The latest stable Python release is 3.11, so install that."],
    [5, "[TEST FIXTURE] What Node version for production?", "[TEST FIXTURE] Node.js 24 is the active LTS release and a safe choice."],
    [3, "[TEST FIXTURE] Who leads the UK government?", "[TEST FIXTURE] The UK Prime Minister is Rishi Sunak. Tokyo has about 14 million people."],
    [2, "[TEST FIXTURE] How big is GPT-4's context?", "[TEST FIXTURE] GPT-4 has a context window of 8k tokens."],
    [1, "[TEST FIXTURE] Tell me about Hastings", "[TEST FIXTURE] The Battle of Hastings was fought in 1066."],
    [0, "[TEST FIXTURE] Is Node.js 24 still LTS?", "[TEST FIXTURE] Node.js 24 is the active LTS release. Tokyo has about 14 million people."],
  ];
  for (const [daysAgo, q, a] of seeds) {
    offset = daysAgo * 864e5 + 3 * 3600e3;
    ext.check({ platform: "chatgpt", message_id: `fixture-${daysAgo}`, question: q, answer: a, model: "gpt-5-5" }, conn);
    await engine.drain();
  }
  offset = 0;
}

createServer({ cfg, engine, store, health, ext }).listen(port, "127.0.0.1", () => {
  console.log(`[fixture] TEST FIXTURE engine on http://127.0.0.1:${port} (scripted model and search; no real data, no spend)`);
});
