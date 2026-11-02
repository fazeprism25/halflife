// TEST FIXTURES ONLY. Scripted upstreams that speak the OpenAI chat wire format and Tavily's
// search/extract format, so the integration test can drive the REAL Bifrost gateway, the REAL
// Halflife plugin and the REAL engine end to end without credentials. Every model answer contains
// "[TEST FIXTURE]" and every search result is on the reserved example.* domains. Nothing here is
// ever presented as real verification. Enabled only when HALFLIFE_FIXTURE_UPSTREAM is set.

import http from "node:http";

const PORT = Number(process.env.PORT ?? 18000);
const counters = { chat: 0, internal: 0, search: 0, extract: 0 };
let lastDeepSeek = null;

const APP_ANSWERS = [
  {
    match: /ceo of twitter/i,
    text: "As of 2023, Jack Dorsey is the CEO of Twitter. The Battle of Hastings was fought in 1066. [TEST FIXTURE]",
  },
  {
    match: /latest .*python/i,
    text: "The latest stable Python release is 3.11. [TEST FIXTURE]",
  },
  { match: /.*/, text: "Water boils at 100 degrees Celsius at sea level. [TEST FIXTURE]" },
];

const CLAIMS = [
  { re: /Jack Dorsey is the CEO of Twitter/, claim: { span: "Jack Dorsey is the CEO of Twitter", statement: "Jack Dorsey is the CEO of Twitter.", class: "org.leadership", subject: "Twitter", attribute: "CEO", value: "Jack Dorsey", as_of: "2023", time_sensitive: true, search_query: "fixture twitter ceo" } },
  { re: /Battle of Hastings was fought in 1066/, claim: { span: "The Battle of Hastings was fought in 1066", statement: "The Battle of Hastings was fought in 1066.", class: "historical.fact", subject: "Battle of Hastings", attribute: "year", value: "1066", as_of: null, time_sensitive: false, search_query: "battle of hastings" } },
  { re: /latest stable Python release is 3\.11/, claim: { span: "The latest stable Python release is 3.11", statement: "The latest stable Python release is 3.11.", class: "software.version", subject: "Python", attribute: "latest release", value: "3.11", as_of: null, time_sensitive: true, search_query: "fixture python latest release" } },
  { re: /Water boils at 100 degrees/, claim: { span: "Water boils at 100 degrees Celsius at sea level", statement: "Water boils at 100 degrees Celsius at sea level.", class: "static.definition", subject: "water", attribute: "boiling point", value: "100 °C", as_of: null, time_sensitive: false, search_query: "water boiling point" } },
];

const today = new Date();
const daysAgo = (n) => new Date(today.getTime() - n * 864e5).toISOString().slice(0, 10);
const SEARCH = {
  twitter: [
    { url: "https://news.example.com/x-ceo", title: "[TEST FIXTURE] X names new chief executive", content: "[TEST FIXTURE] Linda Yaccarino took over as chief executive of Twitter, now X, in June 2023.", score: 0.91, published_date: daysAgo(40) },
    { url: "https://wire.example.org/x-leadership", title: "[TEST FIXTURE] X leadership", content: "[TEST FIXTURE] Linda Yaccarino is the CEO of X, the company formerly called Twitter.", score: 0.84, published_date: daysAgo(10) },
  ],
  python: [
    { url: "https://docs.example.net/python-releases", title: "[TEST FIXTURE] Python releases", content: "[TEST FIXTURE] Python 3.14.0 is the latest stable release.", score: 0.9, published_date: daysAgo(20) },
  ],
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function chatCompletion(model, content) {
  return { id: `fx-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } };
}

function engineCall(body) {
  const system = body.messages?.[0]?.content ?? "";
  const user = body.messages?.at(-1)?.content ?? "";
  if (system.includes("claim extractor")) {
    const answer = /<answer>\n([\s\S]*)\n<\/answer>/.exec(user)?.[1] ?? "";
    return { claims: CLAIMS.filter((c) => c.re.test(answer)).map((c) => c.claim) };
  }
  if (system.includes("verification judge")) {
    if (/Twitter/.test(user)) {
      return { verdict: "superseded", current_value: "Linda Yaccarino", current_value_quote: { evidence_id: "E2", quote: "Linda Yaccarino is the CEO of X" }, changed_on: "2023-06", explanation: "[TEST FIXTURE] Both sources name Linda Yaccarino as CEO since June 2023.",
        citations: [
          { evidence_id: "E1", quote: "Linda Yaccarino took over as chief executive of Twitter", stance: "refutes" },
          { evidence_id: "E2", quote: "Linda Yaccarino is the CEO of X", stance: "refutes" },
        ] };
    }
    if (/Python/.test(user)) {
      return { verdict: "superseded", current_value: "3.14", current_value_quote: { evidence_id: "E1", quote: "Python 3.14.0 is the latest stable release" }, changed_on: null, explanation: "[TEST FIXTURE] The release page lists 3.14.0.",
        citations: [{ evidence_id: "E1", quote: "Python 3.14.0 is the latest stable release", stance: "refutes" }] };
    }
    return { verdict: "unverifiable", current_value: null, changed_on: null, explanation: "[TEST FIXTURE] no evidence", citations: [] };
  }
  return { error: "unknown fixture call" };
}

async function stream(res, model, text) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const parts = text.match(/.{1,16}/gs) ?? [text];
  const id = `fx-s-${Date.now()}`;
  for (let i = 0; i < parts.length; i++) {
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: parts[i] } : { content: parts[i] }, finish_reason: null }] })}\n\n`);
    await new Promise((r) => setTimeout(r, 15));
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: "bad json" });
    }
    const url = req.url ?? "";
    if (url === "/counters") return json(res, 200, counters);
    // What Bifrost's native DeepSeek provider actually put on the wire (the test asserts on it).
    if (url === "/last-deepseek") return json(res, 200, lastDeepSeek ?? {});
    if (url.endsWith("/chat/completions")) {
      counters.chat++;
      if (url.startsWith("/deepseek/")) lastDeepSeek = { path: url, bearer: req.headers.authorization === "Bearer fixture-not-a-secret", body };
      const model = String(body.model ?? "fixture");
      if (body.response_format) {
        counters.internal++;
        return json(res, 200, chatCompletion(model, JSON.stringify(engineCall(body))));
      }
      const prompt = String(body.messages?.at(-1)?.content ?? "");
      const answer = APP_ANSWERS.find((a) => a.match.test(prompt)).text;
      if (body.stream) return stream(res, model, answer);
      return json(res, 200, chatCompletion(model, answer));
    }
    // [TEST FIXTURE] Tavily GET /usage shape (the engine's credit guard reads it, AD-19).
    if (url.endsWith("/tavily/usage")) {
      return json(res, 200, { key: { usage: counters.search + counters.extract, limit: null }, account: { current_plan: "TEST FIXTURE", plan_usage: counters.search + counters.extract, plan_limit: 100000, paygo_usage: 0, paygo_limit: null } });
    }
    if (url.endsWith("/search")) {
      counters.search++;
      const q = String(body.query ?? "");
      const results = /twitter/i.test(q) ? SEARCH.twitter : /python/i.test(q) ? SEARCH.python : [];
      return json(res, 200, { query: q, results, response_time: 0.01, usage: { credits: body.search_depth === "advanced" ? 2 : 1 } });
    }
    if (url.endsWith("/extract")) {
      counters.extract++;
      return json(res, 200, { results: [], failed_results: (body.urls ?? []).map((u) => ({ url: u, error: "fixture" })), usage: { credits: 0 } });
    }
    json(res, 404, { error: "fixture: unknown path " + url });
  })
  .listen(PORT, "0.0.0.0", () => console.log(`[fixtures] TEST FIXTURE upstream on :${PORT}`));
