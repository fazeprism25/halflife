// ChatGPT adapter tests in a real browser engine (headless Edge or Chrome).
//
// Each fixture is a TEST FIXTURE DOM written from published observations of ChatGPT's markup
// (see research/CHATGPT_EXTENSION.md); it is not a capture of a real conversation. The adapter
// script is loaded unchanged, the fixture's assertions run in the page, and the result is read
// back with --dump-dom.
//   node --test extension/test/adapter.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = fs.readFileSync(path.join(HERE, "../src/adapters/chatgpt.js"), "utf8");
const BROWSERS = [
  process.env.HALFLIFE_TEST_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].filter(Boolean);
const BROWSER = BROWSERS.find((b) => fs.existsSync(b));

/** Runs `body` (an async function source using `A` = adapter, `check(name, actual, expected)`) on a fixture DOM. */
function run(dom, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-adapter-"));
  const file = path.join(dir, "fixture.html");
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>.scroller{height:300px;overflow-y:auto}.spacer{height:3000px}</style></head><body>
${dom}
<pre id="result">pending</pre>
<script>${ADAPTER}</script>
<script>
(async () => {
  const A = window.HalflifeAdapters.chatgpt;
  const out = [];
  const check = (name, actual, expected) => out.push({ name, actual, expected });
  try { await (${body})(A, check); } catch (e) { out.push({ name: "threw", actual: String(e && e.stack || e), expected: null }); }
  document.getElementById("result").textContent = JSON.stringify(out);
})();
</script></body></html>`);
  const r = spawnSync(BROWSER, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(dir, "profile")}`, "--virtual-time-budget=5000", "--dump-dom", "file:///" + file.replace(/\\/g, "/")], { encoding: "utf8", timeout: 60000 });
  const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(r.stdout ?? "");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(m, `no result from the browser (status ${r.status}): ${(r.stderr || "").slice(0, 300)}`);
  const text = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.notEqual(text, "pending", "page script did not finish");
  return JSON.parse(text);
}

function expectAll(results) {
  for (const r of results) assert.deepEqual(r.actual, r.expected, r.name);
  assert.ok(results.length > 0);
}

const skip = BROWSER ? false : "no Chromium-based browser found (set HALFLIFE_TEST_BROWSER)";

test("layout A (data-message-author-role): pairs each answer with its own question; multi-part answers grouped", { skip }, () => {
  const dom = `
  <main><div id="thread">
    <section data-turn-id="t1" data-turn="user" data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u-1"><div class="whitespace-pre-wrap">Who is the CEO of Twitter?</div></div></section>
    <section data-turn-id="t2" data-turn="assistant" data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a-1" data-message-model-slug="gpt-5-5"><div class="markdown prose"><p>Jack Dorsey is the CEO.</p><ul><li>Founded 2006</li></ul></div></div><div><button>Copy</button></div></section>
    <section data-turn-id="t3" data-turn="user" data-testid="conversation-turn-3"><div data-message-author-role="user" data-message-id="u-2"><div class="whitespace-pre-wrap">And the latest Python?</div></div></section>
    <section data-turn-id="t4" data-turn="assistant" data-testid="conversation-turn-4">
      <div data-message-author-role="assistant" data-message-id="a-2a"><div class="markdown"><p>Searching the web.</p></div></div>
      <div data-message-author-role="assistant" data-message-id="a-2b" data-message-model-slug="gpt-5-5-thinking"><div class="markdown"><p>Python 3.11 is the latest.</p></div></div>
    </section>
  </div></main>`;
  expectAll(run(dom, async (A, check) => {
    const rs = A.responses(document);
    check("count", rs.length, 2);
    check("layout", rs[0].layout, "A");
    check("ids", rs.map((r) => r.messageId), ["a-1", "a-2b"]);
    check("text 1", A.answerText(rs[0]), "Jack Dorsey is the CEO.\n\nFounded 2006");
    check("text 2 joins both parts", A.answerText(rs[1]), "Searching the web.\n\nPython 3.11 is the latest.");
    check("question 1", await A.questionFor(rs[0], document), "Who is the CEO of Twitter?");
    check("question 2", await A.questionFor(rs[1], document), "And the latest Python?");
    check("model", A.modelSlug(rs[1]), "gpt-5-5-thinking");
    check("complete", rs.map((r) => A.isComplete(r, document)), [true, true]);
    check("not generating", A.isGenerating(document), false);
  }));
});

test("layout B (2026-09 search units): role from the unit key, id from the selection attribute", { skip }, () => {
  const dom = `
  <div data-chatgpt-search-unit-key="fallback-turn-1:0:user"><div data-chatgpt-selection-message-id="u-9" data-chatgpt-selection-conversation-id="11111111-2222-3333-4444-555555555555"><div data-user-message-bubble><div class="whitespace-pre-wrap">What is the population of Tokyo?</div></div></div></div>
  <div data-chatgpt-search-unit-key="fallback-turn-1:1:assistant"><div data-chatgpt-selection-message-id="a-9"><div data-markdown-text-style><p>About 14 million people.</p></div></div>
    <div data-chatgpt-search-unit-key="nested:0:assistant"><div data-markdown-text-style><p>nested</p></div></div></div>`;
  expectAll(run(dom, async (A, check) => {
    const rs = A.responses(document);
    check("count (nested unit ignored)", rs.length, 1);
    check("layout", rs[0].layout, "B");
    check("id", rs[0].messageId, "a-9");
    check("text", A.answerText(rs[0]), "About 14 million people.");
    check("question", await A.questionFor(rs[0], document), "What is the population of Tokyo?");
  }));
});

test("streaming: the last answer is incomplete while ChatGPT is generating; earlier ones are not", { skip }, () => {
  const dom = `
  <section data-turn="user"><div data-message-author-role="user"><div class="whitespace-pre-wrap">Q1</div></div></section>
  <section data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a-1"><div class="markdown">Done answer.</div></div></section>
  <section data-turn="user"><div data-message-author-role="user"><div class="whitespace-pre-wrap">Q2</div></div></section>
  <section data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a-2"><div class="markdown result-streaming">Half an ans</div></div></section>
  <form><button data-testid="stop-button">Stop</button></form>`;
  expectAll(run(dom, async (A, check) => {
    const rs = A.responses(document);
    check("generating", A.isGenerating(document), true);
    check("complete flags", rs.map((r) => A.isComplete(r, document)), [true, false]);
    document.querySelector('[data-testid="stop-button"]').remove();
    document.querySelector(".result-streaming").classList.remove("result-streaming");
    check("after streaming ends", rs.map((r) => A.isComplete(r, document)), [true, true]);
    document.querySelectorAll(".markdown")[1].textContent = "";
    check("empty answer is never complete", A.isComplete(A.responses(document)[1], document), false);
  }));
});

test("turn-state attribute also counts as generating (2026-10 observation)", { skip }, () => {
  expectAll(run(`<div data-talvt-turn-state="streaming"></div><div data-talvt-turn-state="complete"></div>`, async (A, check) => {
    check("streaming", A.isGenerating(document), true);
    document.querySelector('[data-talvt-turn-state="streaming"]').setAttribute("data-talvt-turn-state", "complete");
    check("complete", A.isGenerating(document), false);
  }));
});

test("virtualised thread: an empty question shell is hydrated by scrolling, and the scroll position is restored", { skip }, () => {
  const dom = `
  <div class="scroller" id="scroller" data-scroll-root>
    <section data-turn="user" data-turn-id="t1" id="q"></section>
    <div class="spacer"></div>
    <section data-turn="assistant" data-turn-id="t2"><div data-message-author-role="assistant" data-message-id="a-1"><div class="markdown">Answer far below its question.</div></div></section>
  </div>
  <script>
    // TEST FIXTURE: hydrate the user turn only while it is inside the scroll viewport, as ChatGPT's
    // virtualised list does. A layout poll is used because headless --dump-dom runs no rendering
    // frames (no rAF, no IntersectionObserver after programmatic scrolls; probed 2026-11-03).
    setInterval(() => {
      const q = document.getElementById("q"), sc = document.getElementById("scroller");
      const a = q.getBoundingClientRect(), b = sc.getBoundingClientRect();
      const inView = a.bottom >= b.top && a.top <= b.bottom;
      if (inView && !q.firstChild) q.innerHTML = '<div data-message-author-role="user" data-message-id="u-1"><div class="whitespace-pre-wrap">The hydrated question</div></div>';
      if (!inView && q.firstChild) q.replaceChildren(); // dehydrate again when scrolled away
    }, 20);
  </script>`;
  expectAll(run(dom, async (A, check) => {
    const sc = document.getElementById("scroller");
    sc.scrollTop = sc.scrollHeight;
    await new Promise((r) => setTimeout(r, 100));
    const before = sc.scrollTop;
    const rs = A.responses(document);
    check("shell is empty before", document.getElementById("q").textContent, "");
    check("question", await A.questionFor(rs[0], document), "The hydrated question");
    check("scroll restored", sc.scrollTop, before);
  }));
});

test("no question is attached when another answer sits between, or when none exists", { skip }, () => {
  const dom = `
  <section data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a-0"><div class="markdown">Greeting.</div></div></section>
  <section data-turn="user"><div data-message-author-role="user"><div class="whitespace-pre-wrap">Q</div></div></section>
  <section data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a-1"><div class="markdown">First.</div></div></section>
  <section data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a-2"><div class="markdown">Second, no question of its own.</div></div></section>`;
  expectAll(run(dom, async (A, check) => {
    const rs = A.responses(document);
    check("q0", await A.questionFor(rs[0], document), null);
    check("q1", await A.questionFor(rs[1], document), "Q");
    check("q2", await A.questionFor(rs[2], document), null);
  }));
});

test("own UI, buttons and unsafe ids are excluded; unknown layouts yield nothing", { skip }, () => {
  const dom = `<div id="root">
  <section data-turn="assistant"><div data-message-author-role="assistant" data-message-id="bad id/../x"><div class="markdown">Real text.</div><div data-halflife-host>Check freshness</div></div></section></div>`;
  expectAll(run(dom, async (A, check) => {
    const rs = A.responses(document);
    check("text excludes host", A.answerText(rs[0]), "Real text.");
    check("unsafe id dropped", rs[0].messageId, null);
    document.getElementById("root").innerHTML = '<div class="message assistant"><p>Some other site layout</p></div>';
    check("unknown layout", A.responses(document).length, 0);
    check("conversation id", A.conversationId({ pathname: "/c/6a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d" }), "6a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d");
    check("local placeholder chat", A.conversationId({ pathname: "/c/local-chatgpt:abc" }), null);
    check("supports", [A.supports({ hostname: "chatgpt.com" }), A.supports({ hostname: "chat.openai.com" }), A.supports({ hostname: "evil.com" })], [true, true, false]);
  }));
});

test("long answer: 50,000 characters are read in full", { skip }, () => {
  const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
  const dom = `<section data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a-1"><div class="markdown">${Array.from({ length: 44 }, () => `<p>${para}</p>`).join("")}</div></div></section>`;
  expectAll(run(dom, async (A, check) => {
    const t = A.answerText(A.responses(document)[0]);
    check("length over 50k", t.length > 50000, true);
    check("paragraphs kept", t.split("\n\n").length, 44);
  }));
});
