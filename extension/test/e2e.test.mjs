// End-to-end: the real unpacked extension in headless Edge/Chrome, a TEST FIXTURE ChatGPT-like
// page served as https://chatgpt.com (host-resolver mapping + a throwaway self-signed cert), and
// the real engine HTTP server with scripted model and search (engine/test/fixture-server.ts).
// No real ChatGPT, no LLM tokens, no Tavily credits.
//
//   node --test extension/test/e2e.test.mjs
//
// Covers: pairing through the popup, buttons only on completed answers (streaming), exactly what
// is sent (one answer + its question, nothing else on the page), compact result, duplicate
// selection after a reload, pause/resume, and a clear error when the engine is down.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findBrowser, launch, openPage, sleep, until } from "./cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const EXT_DIR = path.resolve(HERE, "..");
const CONV = "6a0b1c2d-3e4f-4a6b-8c8d-9e0f1a2b3c4d";
const OPENSSL = ["openssl", "C:/Program Files/Git/mingw64/bin/openssl.exe", "C:/Program Files/Git/usr/bin/openssl.exe"].find((p) => {
  try {
    execFileSync(p, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
const BROWSER = findBrowser();
const skip = !BROWSER ? "no Chromium-based browser" : !OPENSSL ? "openssl not found (needed for the throwaway certificate)" : false;

const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});

/** TEST FIXTURE page in ChatGPT's legacy layout. The last answer streams for ~2.5 s. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>TEST FIXTURE chat</title></head><body>
<nav><a href="/c/other">PRIVATE-SIDEBAR-TITLE</a></nav>
<main><div id="thread">
  <section data-turn="user" data-turn-id="t0"><div data-message-author-role="user" data-message-id="u-0"><div class="whitespace-pre-wrap">PRIVATE-EARLIER-QUESTION</div></div></section>
  <section data-turn="assistant" data-turn-id="t1"><div data-message-author-role="assistant" data-message-id="a-0"><div class="markdown"><p>PRIVATE-EARLIER-ANSWER</p></div></div></section>
  <section data-turn="user" data-turn-id="t2"><div data-message-author-role="user" data-message-id="u-1"><div class="whitespace-pre-wrap">[TEST FIXTURE] Who runs Twitter?</div></div></section>
  <section data-turn="assistant" data-turn-id="t3"><div data-message-author-role="assistant" data-message-id="a-1" data-message-model-slug="gpt-5-5"><div class="markdown"><p>[TEST FIXTURE] Jack Dorsey is the CEO of Twitter. The Battle of Hastings was fought in 1066.</p></div></div></section>
  <section data-turn="user" data-turn-id="t4"><div data-message-author-role="user" data-message-id="u-2"><div class="whitespace-pre-wrap">[TEST FIXTURE] Which Python?</div></div></section>
  <section data-turn="assistant" data-turn-id="t5"><div data-message-author-role="assistant" data-message-id="a-2"><div class="markdown result-streaming"><p id="stream"></p></div></div></section>
</div></main>
<form><textarea>PRIVATE-DRAFT-IN-COMPOSER</textarea><button type="button" data-testid="stop-button">Stop</button></form>
<script>
  const full = "[TEST FIXTURE] The latest stable Python release is 3.11.";
  let i = 0;
  const t = setInterval(() => {
    i += 4;
    document.getElementById("stream").textContent = full.slice(0, i);
    if (i >= full.length) {
      clearInterval(t);
      document.querySelector(".result-streaming").classList.remove("result-streaming");
      document.querySelector('[data-testid="stop-button"]').remove();
    }
  }, 300); // about 4 s of streaming
</script></body></html>`;

let tmp, engineProc, enginePort, page, server, browser, extId, chat;
const engineUrl = () => `http://127.0.0.1:${enginePort}`;
const consoleApi = async (p, method = "GET") => (await fetch(engineUrl() + p, { method, headers: { "x-halflife-console": "1", "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined })).json();

async function startEngine() {
  engineProc = spawn(process.execPath, [path.join(ROOT, "engine/test/fixture-server.ts"), "--port", String(enginePort)], { stdio: "ignore" });
  await until(async () => (await fetch(engineUrl() + "/v1/health")).ok, { what: "fixture engine" });
}

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-e2e-"));
  execFileSync(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com,DNS:chat.openai.com",
    "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem")], { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  page = await freePort();
  server = https.createServer({ key: fs.readFileSync(path.join(tmp, "key.pem")), cert: fs.readFileSync(path.join(tmp, "cert.pem")) }, (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }).listen(page, "127.0.0.1");
  enginePort = await freePort();
  await startEngine();
  browser = launch(BROWSER, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", `--user-data-dir=${path.join(tmp, "profile")}`,
    `--host-resolver-rules=MAP chatgpt.com:443 127.0.0.1:${page}`, "--ignore-certificate-errors", "--window-size=1200,900"]);
  extId = (await browser.send("Extensions.loadUnpacked", { path: EXT_DIR })).id;
});

after(async () => {
  await browser?.close();
  engineProc?.kill();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers (closed shadow roots via CDP pierce)

async function tree(p) {
  return (await p.send("DOM.getDocument", { depth: -1, pierce: true })).root;
}
function find(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) find(c, pred, out);
  return out;
}
const attrs = (n) => Object.fromEntries((n.attributes ?? []).reduce((a, v, i, arr) => (i % 2 ? a : [...a, [v, arr[i + 1]]]), []));
const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children ?? []).concat(n.shadowRoots ?? []).map(textOf).join(" "));

/** The Halflife host attached to the answer with this message id, and its shadow content. */
async function hostFor(p, messageId) {
  const root = await tree(p);
  const section = find(root, (n) => n.nodeName === "SECTION" && find(n, (m) => attrs(m)["data-message-id"] === messageId).length > 0)[0];
  if (!section) return null;
  const host = find(section, (n) => "data-halflife-host" in attrs(n))[0];
  if (!host) return null;
  return { host, shadow: host.shadowRoots?.[0], text: textOf(host.shadowRoots?.[0] ?? host).replace(/\s+/g, " ").trim() };
}
async function click(p, node) {
  await p.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
  const { model } = await p.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
  const [x1, y1, , , x3, y3] = model.content;
  const x = (x1 + x3) / 2, y = (y1 + y3) / 2;
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
async function clickButton(p, messageId, label) {
  const h = await until(() => hostFor(p, messageId), { what: `host for ${messageId}` });
  const btn = find(h.shadow, (n) => n.nodeName === "BUTTON" && textOf(n).includes(label))[0];
  assert.ok(btn, `button "${label}" for ${messageId} (have: ${h.text})`);
  await click(p, btn);
}
/** Optional screenshots for visual review: set HALFLIFE_E2E_SHOTS to a directory. */
async function shot(p, name, emulateDark = false) {
  const dir = process.env.HALFLIFE_E2E_SHOTS;
  if (!dir) return;
  if (emulateDark) await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(250);
  const { data } = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(data, "base64"));
}
const hostCount = (p) => p.eval("document.querySelectorAll('[data-halflife-host]').length");

async function popup() {
  const p = await openPage(browser, `chrome-extension://${extId}/popup/popup.html`);
  await until(() => p.eval("document.getElementById('conn').dataset.state !== 'loading'"), { what: "popup load" });
  return p;
}

// ------------------------------------------------------------------ tests (sequential, shared browser)

test("pairing through the popup stores the connection; the engine sees one connection", { skip }, async () => {
  const p = await popup();
  assert.equal(await p.eval("document.getElementById('conn').dataset.state"), "unpaired");
  const { code } = await consoleApi("/v1/extension/pairing-codes", "POST");
  await p.eval(`(() => { const f = document.querySelector("form"); f.url.value = ${JSON.stringify(engineUrl())}; f.code.value = ${JSON.stringify(code.slice(0, 4) + "-" + code.slice(4))}; f.requestSubmit(); })()`);
  await until(() => p.eval("document.getElementById('conn').dataset.state === 'connected'"), { what: "connected state" });
  await p.send("Emulation.setDeviceMetricsOverride", { width: 340, height: 420, deviceScaleFactor: 1, mobile: false });
  await shot(p, "popup-connected", true);
  const conns = (await consoleApi("/v1/extension/settings")).connections;
  assert.equal(conns.length, 1);
  assert.match(conns[0].origin, new RegExp(`^chrome-extension://${extId}$`), "token is bound to this extension's origin");
  await browser.send("Target.closeTarget", { targetId: p.targetId });
});

test("buttons appear only under completed answers; the streaming one gets its button when it finishes", { skip }, async () => {
  chat = await openPage(browser, `https://chatgpt.com/c/${CONV}`);
  await until(async () => (await hostCount(chat)) >= 2, { what: "buttons on completed answers" });
  assert.equal(await chat.eval("!!document.querySelector('[data-testid=stop-button]')"), true, "still streaming");
  assert.equal(await hostFor(chat, "a-2"), null, "no button on the answer being written");
  assert.ok(await hostFor(chat, "a-1"));
  await until(async () => (await hostCount(chat)) === 3, { what: "button after streaming ends" });
  assert.match((await hostFor(chat, "a-2")).text, /Check freshness/);
});

test("check: sends only the selected answer and its question; shows the compact result", { skip }, async () => {
  await clickButton(chat, "a-1", "Check freshness");
  const done = await until(async () => {
    const h = await hostFor(chat, "a-1");
    return h && /Outdated information found/.test(h.text) && h;
  }, { what: "compact result", timeout: 20000 });
  assert.match(done.text, /1 superseded or contradicted/);
  assert.match(done.text, /2 claims examined/);
  assert.match(done.text, /Open in Halflife/);
  await shot(chat, "chatgpt-result", true);

  const [check] = (await consoleApi("/v1/extension/activity")).checks;
  assert.equal(check.question, "[TEST FIXTURE] Who runs Twitter?");
  assert.equal(check.answer, "[TEST FIXTURE] Jack Dorsey is the CEO of Twitter. The Battle of Hastings was fought in 1066.");
  assert.equal(check.meta.message_id, "a-1");
  assert.equal(check.meta.model, "gpt-5-5");
  assert.equal(check.meta.conversation_hash, crypto.createHash("sha256").update(`chatgpt:${CONV}`).digest("hex"), "conversation id is hashed, not sent");
  const report = await consoleApi(`/v1/reports/${check.id}`);
  const stored = JSON.stringify(report);
  for (const secret of ["PRIVATE-EARLIER-QUESTION", "PRIVATE-EARLIER-ANSWER", "PRIVATE-SIDEBAR-TITLE", "PRIVATE-DRAFT-IN-COMPOSER", CONV]) {
    assert.ok(!stored.includes(secret), `${secret} must not leave the browser`);
  }
  assert.equal(report.source, "extension");
});

test("duplicate selection after a page reload returns the saved analysis", { skip }, async () => {
  await chat.send("Page.reload", {});
  await until(async () => (await hostCount(chat)) === 3, { what: "buttons after reload", timeout: 20000 });
  await clickButton(chat, "a-1", "Check freshness");
  const h = await until(async () => {
    const x = await hostFor(chat, "a-1");
    return x && /Already checked/.test(x.text) && x;
  }, { what: "duplicate note" });
  assert.match(h.text, /Outdated information found/);
  assert.equal((await consoleApi("/v1/extension/activity")).checks.length, 1, "no second report");
});

test("pause hides every button and resume restores them", { skip }, async () => {
  const p = await popup();
  await p.eval("document.getElementById('pause').click()");
  await until(async () => (await hostCount(chat)) === 0, { what: "buttons removed when paused" });
  await sleep(300);
  await p.eval("document.getElementById('pause').click()");
  await until(async () => (await hostCount(chat)) === 3, { what: "buttons back after resume" });
  await browser.send("Target.closeTarget", { targetId: p.targetId });
});

test("engine unavailable: a clear error in place, nothing retried silently", { skip }, async () => {
  engineProc.kill();
  await until(async () => {
    try {
      await fetch(engineUrl() + "/v1/health");
      return false;
    } catch {
      return true;
    }
  }, { what: "engine down" });
  await clickButton(chat, "a-2", "Check freshness");
  const h = await until(async () => {
    const x = await hostFor(chat, "a-2");
    return x && /isn't reachable/.test(x.text) && x;
  }, { what: "offline error" });
  assert.match(h.text, /Try again/);
  const p = await popup();
  assert.equal(await p.eval("document.getElementById('conn').dataset.state"), "offline");
});
