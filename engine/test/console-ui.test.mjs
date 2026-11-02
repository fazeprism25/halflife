// Console UI test (collapsible sidebar with Traffic, AD-35; System provider usage, AD-34) in a real
// headless Edge or Chrome, against the TEST FIXTURE engine (scripted model, search and /usage: no
// tokens, no Tavily credits). Not part of `npm test`, which stays browser-free. From the repo root:
//
//   node --test engine/test/console-ui.test.mjs
//
// Optional: HALFLIFE_UI_SHOTS=<dir> writes screenshots for visual review.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findBrowser, launch, openPage, sleep, until } from "../../extension/test/cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER = findBrowser();
const skip = BROWSER ? false : "no Edge or Chrome found (set HALFLIFE_TEST_BROWSER)";
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const FIXTURE_ALLOWANCE = 9000; // a TEST FIXTURE value for the scripted /usage, not a default

let tmp, engineProc, port, browser, p;
const base = () => `http://127.0.0.1:${port}`;

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-ui-"));
  port = await freePort();
  engineProc = spawn(process.execPath, [path.join(HERE, "fixture-server.ts"), "--port", String(port), "--seed", "--usage", String(FIXTURE_ALLOWANCE)], { stdio: "ignore" });
  await until(async () => (await fetch(base() + "/v1/health")).ok, { what: "fixture engine" });
  browser = launch(BROWSER, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", `--user-data-dir=${path.join(tmp, "profile")}`]);
  p = await openPage(browser, "about:blank");
  await p.send("Page.enable");
  await viewport(1440, 900);
  await p.send("Page.navigate", { url: base() + "/#/inspector" });
  await ready();
  await p.eval(`localStorage.clear()`);
  await reload();
});

after(async () => {
  await browser?.close();
  engineProc?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const viewport = (width, height) => p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const ready = () => until(() => p.eval("document.querySelectorAll('#traffic-panel .feed-item').length >= 3 && !!document.querySelector('.report-title')"), { what: "inspector with reports" });
async function reload() {
  await p.send("Page.reload", { ignoreCache: true });
  await sleep(200);
  await ready();
  await settle();
}
const state = () => p.eval(`(() => {
  const sb = document.querySelector("#sidebar"), m = document.querySelector("#menu-btn"), tt = document.querySelector("#traffic-toggle");
  const a = document.activeElement, main = document.querySelector("main");
  return {
    open: sb.dataset.open === "true", visible: getComputedStyle(sb).visibility === "visible", mode: document.querySelector("#shell").dataset.mode,
    expanded: m.getAttribute("aria-expanded"), mainInert: main.inert, topInert: document.querySelector(".topbar").inert, role: sb.getAttribute("role"),
    focusInSidebar: sb.contains(a), focusOnMenu: a === m, traffic: tt.getAttribute("aria-expanded"), trafficHidden: document.querySelector("#traffic-panel").hidden,
    hash: location.hash, position: document.querySelector(".bar-position")?.textContent ?? "", mainW: main.getBoundingClientRect().width,
    sbW: sb.getBoundingClientRect().width, pref: localStorage.getItem("halflife.sidebar"), trafficPref: localStorage.getItem("halflife.traffic"),
  };
})()`);
async function key(k, code = k, vk = 0) {
  for (const type of ["keyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, ...(type === "keyDown" && (k.length === 1 || k === "Enter") ? { text: k === "Enter" ? "\r" : k } : {}) });
}
async function clickAt(x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
async function clickSel(sel) {
  const [x, y] = await p.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await clickAt(x, y);
}
const settle = () => sleep(320); // longer than the 200 ms transitions
async function shot(name) {
  const dir = process.env.HALFLIFE_UI_SHOTS;
  if (!dir) return;
  await settle();
  const { data } = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(data, "base64"));
}
const noHScroll = () => p.eval(`document.documentElement.scrollWidth <= innerWidth`);

// ---------------------------------------------------------------- desktop (docked mode)

test("desktop: collapsed by default, the page uses the full width, no Traffic bar above the report", { skip }, async () => {
  const s = await state();
  assert.equal(s.mode, "docked");
  assert.deepEqual([s.open, s.visible, s.expanded], [false, false, "false"]);
  assert.ok(s.mainW >= 1440 - 1, `main ${s.mainW}px should fill the 1440px viewport`);
  assert.equal(await p.eval(`!!document.querySelector(".inspector-bar, .drawer, .drawer-toggle")`), false, "the old Traffic bar and drawer are gone");
  assert.ok(await p.eval(`!!document.querySelector(".report-title") && !!document.querySelector(".claim-col")`), "report and claim detail render");
  assert.match(s.position, /^1 of /);
  assert.ok(await noHScroll());
  await shot("01-desktop-collapsed");
});

test("desktop: the menu button docks the sidebar beside the page; the choice is remembered", { skip }, async () => {
  await clickSel("#menu-btn");
  await settle();
  let s = await state();
  assert.deepEqual([s.open, s.visible, s.expanded, s.mainInert, s.role], [true, true, "true", false, null], "docked is non-modal");
  assert.ok(s.focusInSidebar, "focus moves to the current navigation link");
  assert.equal(await p.eval(`document.activeElement.dataset.route`), "inspector");
  assert.ok(Math.abs(s.mainW - (1440 - s.sbW)) <= 1, `main ${s.mainW} + sidebar ${s.sbW} = viewport`);
  assert.equal(s.pref, "open");
  assert.equal(await p.eval(`[...document.querySelectorAll("#nav a")].map((a) => a.dataset.route).join()`), "inspector,check,model,system,activity,claims,trends,extension", "every destination is still in the navigation");
  await shot("02-desktop-docked");
  await reload();
  s = await state();
  assert.equal(s.open, true, "remembered across a reload");
  // Docked is a layout choice, not a popup: Escape and outside clicks leave it alone.
  await key("Escape", "Escape", 27);
  await clickAt(1000, 500);
  await settle();
  assert.equal((await state()).open, true);
  await clickSel("#menu-btn");
  await settle();
  s = await state();
  assert.deepEqual([s.open, s.visible, s.pref], [false, false, "closed"]);
  assert.ok(s.mainW >= 1439);
  await reload();
  assert.equal((await state()).open, false, "collapsed choice remembered");
});

test("Traffic is its own section: expands and collapses independently, never widens the sidebar", { skip }, async () => {
  await clickSel("#menu-btn");
  await settle();
  let s = await state();
  const [sbW, mainW] = [s.sbW, s.mainW];
  assert.deepEqual([s.traffic, s.trafficHidden], ["false", true], "collapsed by default");
  await clickSel("#traffic-toggle");
  await settle();
  s = await state();
  assert.deepEqual([s.traffic, s.trafficHidden, s.trafficPref], ["true", false, "open"]);
  assert.ok(await p.eval(`document.querySelectorAll("#traffic-panel .feed-item").length >= 7`), "the existing list is shown");
  assert.deepEqual([s.sbW, s.mainW], [sbW, mainW], "expanding Traffic changes neither the sidebar nor the report width");
  assert.ok(await p.eval(`document.querySelector("#nav a").getBoundingClientRect().height > 0`), "navigation stays visible with Traffic open");
  await shot("03-desktop-docked-traffic");
  // independent of the sidebar: close and reopen the sidebar, Traffic stays expanded
  await clickSel("#menu-btn");
  await settle();
  await clickSel("#menu-btn");
  await settle();
  assert.equal((await state()).traffic, "true");
  await clickSel("#traffic-toggle");
  await settle();
  s = await state();
  assert.deepEqual([s.traffic, s.trafficHidden, s.open, s.trafficPref], ["false", true, true, "closed"], "collapsing Traffic leaves the sidebar open");
  await clickSel("#traffic-toggle");
  await settle();
});

test("selecting a report in the sidebar selects it in place (docked: the sidebar stays)", { skip }, async () => {
  await clickSel("#traffic-panel li:nth-child(2) .feed-item");
  await until(async () => (await state()).position.startsWith("2 of"), { what: "second report selected" });
  const s = await state();
  const id = s.hash.split("/")[2];
  assert.ok(id, "the selection is in the URL");
  await until(() => p.eval(`document.querySelector(".report-id .mono")?.textContent === ${JSON.stringify(id)}`), { what: "detail of the selected report" });
  assert.equal(await p.eval(`document.querySelector('#traffic-panel .feed-item[aria-current="true"]').dataset.id`), id);
  assert.equal(s.open, true, "docked sidebar is not dismissed by a selection");
  await clickSel("#menu-btn");
  await settle();
});

test("newer/older step through traffic from the report header", { skip }, async () => {
  await clickSel('.report-nav [aria-label="Newer report"]');
  await until(async () => (await state()).position.startsWith("1 of"), { what: "newer" });
  assert.equal(await p.eval(`document.querySelector('[aria-label="Newer report"]').disabled`), true, "no newer report than the latest");
  await clickSel('.report-nav [aria-label="Older report"]');
  await until(async () => (await state()).position.startsWith("2 of"), { what: "older" });
  assert.equal((await state()).open, false);
});

test("keyboard: T opens the sidebar on Traffic with focus on the selected report; arrows and Enter select", { skip }, async () => {
  let s = await state();
  assert.equal(s.visible, false, "a collapsed sidebar is out of the tab order");
  await key("t", "KeyT", 84);
  await until(async () => (await state()).focusInSidebar, { what: "T focuses Traffic" });
  s = await state();
  assert.deepEqual([s.open, s.traffic], [true, "true"]);
  assert.ok(await p.eval(`document.activeElement.matches('.feed-item[aria-current="true"]')`), "focus starts on the selected report");
  await key("ArrowDown", "ArrowDown", 40);
  assert.ok(await p.eval(`document.activeElement === document.querySelectorAll("#traffic-panel .feed-item")[2]`), "ArrowDown focuses the next report");
  await key("Home", "Home", 36);
  assert.ok(await p.eval(`document.activeElement === document.querySelector("#traffic-panel .feed-item")`), "Home focuses the first report");
  await key("ArrowDown", "ArrowDown", 40);
  await key("ArrowDown", "ArrowDown", 40);
  await key("Enter", "Enter", 13);
  await until(async () => (await state()).position.startsWith("3 of"), { what: "third report selected" });
  assert.equal(await p.eval(`getComputedStyle(document.activeElement).outlineStyle`), "solid", "visible focus on the focused report");
  await clickSel("#menu-btn");
  await settle();
  assert.equal((await state()).focusOnMenu, true);
});

test("live: a new report shows on the menu button and in Traffic while collapsed; seeing it clears the mark", { skip }, async () => {
  const before = await p.eval(`document.querySelectorAll("#traffic-panel .feed-item").length`);
  await fetch(base() + "/v1/check", { method: "POST", headers: { "content-type": "application/json", "x-halflife-console": "1" }, body: JSON.stringify({ text: "The latest stable Python release is 3.11." }) });
  await until(() => p.eval(`document.querySelector("#menu-btn").dataset.new === "true"`), { what: "new-report mark on the menu button" });
  assert.equal(await p.eval(`document.querySelector("#traffic-toggle").dataset.new`), "true");
  assert.match(await p.eval(`document.querySelector("#menu-btn").textContent`), /new reports/);
  assert.equal(await p.eval(`document.querySelectorAll("#traffic-panel .feed-item").length`), before + 1, "the list updated live while hidden");
  assert.match((await state()).position, /^4 of/, "the open report keeps its place as the list grows");
  await shot("04-desktop-new-report");
  await clickSel("#menu-btn");
  await settle();
  assert.equal(await p.eval(`document.querySelector("#traffic-toggle").dataset.new`), "false", "seen once Traffic is on screen");
  assert.equal(await p.eval(`document.querySelector("#menu-btn").dataset.new`), "false");
  await clickSel("#menu-btn");
  await settle();
});

// ---------------------------------------------------------------- tablet and phone (overlay mode)

test("tablet: overlay mode starts collapsed, is modal, and closes with Escape, outside click or a selection", { skip }, async () => {
  await p.eval(`localStorage.setItem("halflife.sidebar", "open")`);
  await viewport(820, 1000);
  await reload();
  let s = await state();
  assert.deepEqual([s.mode, s.open], ["overlay", false], "an overlay never opens on its own");
  assert.ok(await noHScroll());
  const mainW = s.mainW;
  await clickSel("#menu-btn");
  await until(async () => (await state()).focusInSidebar, { what: "focus in overlay" });
  await settle();
  s = await state();
  assert.deepEqual([s.open, s.visible, s.mainInert, s.topInert, s.role], [true, true, true, true, "dialog"]);
  assert.equal(s.mainW, mainW, "the overlay does not shrink the page");
  assert.equal(await p.eval(`getComputedStyle(document.querySelector("#sidebar")).position`), "fixed");
  await shot("05-tablet-overlay");
  await key("Escape", "Escape", 27);
  await settle();
  s = await state();
  assert.deepEqual([s.open, s.visible, s.mainInert, s.focusOnMenu], [false, false, false, true]);
  // outside click
  await clickSel("#menu-btn");
  await settle();
  await clickAt(700, 500);
  await settle();
  assert.equal((await state()).open, false);
  // a selection closes it (Traffic remembered expanded from the desktop tests)
  await clickSel("#menu-btn");
  await settle();
  assert.equal((await state()).traffic, "true");
  await clickSel("#traffic-panel li:nth-child(1) .feed-item");
  await until(async () => (await state()).position.startsWith("1 of"), { what: "selected from the overlay" });
  await settle();
  s = await state();
  assert.deepEqual([s.open, s.focusOnMenu], [false, true]);
  // a navigation link closes it and navigates
  await clickSel("#menu-btn");
  await settle();
  await clickSel('#nav a[data-route="model"]');
  await settle();
  s = await state();
  assert.deepEqual([s.open, s.hash], [false, "#/model"]);
});

test("phone: no horizontal scroll on any page; the overlay fits the screen", { skip }, async () => {
  await viewport(390, 844);
  for (const r of ["inspector", "check", "model", "system", "activity", "claims", "trends", "extension"]) {
    await p.eval(`location.hash = "#/${r}"`);
    await until(() => p.eval(`document.querySelector("#main").children.length > 0 && document.querySelector('#nav a[aria-current="page"]')?.dataset.route === "${r}"`), { what: `route ${r}` });
    await sleep(150);
    assert.ok(await noHScroll(), `no horizontal page scroll on ${r}`);
  }
  await p.eval(`location.hash = "#/inspector"`);
  await ready();
  await settle();
  await shot("06-phone-collapsed");
  await clickSel("#menu-btn");
  await settle();
  const r = await p.eval(`(() => { const b = document.querySelector("#sidebar").getBoundingClientRect(); return { left: b.left, width: b.width, top: b.top, height: b.height }; })()`);
  assert.equal(Math.round(r.left), 0);
  assert.ok(r.width <= 390 - 40 && r.width >= 300, `sidebar width ${r.width}`);
  assert.deepEqual([Math.round(r.top), Math.round(r.height)], [0, 844]);
  assert.ok(await noHScroll());
  await shot("07-phone-overlay-traffic");
  await clickAt(340, 400); // the uncovered strip (right of the 300 px sidebar, left of the scrollbar gutter)
  await settle();
  assert.equal((await state()).open, false);
});

test("selecting a report from another page opens it in the Inspector", { skip }, async () => {
  await viewport(1440, 900);
  await p.eval(`location.hash = "#/trends"`);
  await settle();
  await key("t", "KeyT", 84);
  await until(async () => (await state()).focusInSidebar, { what: "Traffic from another page" });
  const id = await p.eval(`document.querySelectorAll("#traffic-panel .feed-item")[1].dataset.id`);
  await clickSel("#traffic-panel li:nth-child(2) .feed-item");
  await until(() => p.eval(`location.hash === "#/inspector/${id}" && document.querySelector(".report-id .mono")?.textContent === "${id}"`), { what: "inspector opened on that report" });
  assert.equal(await p.eval(`document.querySelector('#traffic-panel .feed-item[aria-current="true"]')?.dataset.id`), id);
  await clickSel("#menu-btn");
  await settle();
});

test("light and dark themes give the sidebar their own tokens", { skip }, async () => {
  await clickSel("#menu-btn");
  await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await settle();
  assert.equal(await p.eval(`getComputedStyle(document.querySelector("#sidebar")).backgroundColor`), "rgb(22, 22, 21)"); // --surface-1 (dark)
  await shot("08-desktop-docked-dark");
  await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await settle();
  assert.equal(await p.eval(`getComputedStyle(document.querySelector("#sidebar")).backgroundColor`), "rgb(252, 252, 251)"); // --surface-1 (light)
  await p.send("Emulation.setEmulatedMedia", { features: [] });
  await clickSel("#menu-btn");
  await settle();
});

// ---------------------------------------------------------------- System: provider usage (AD-34)

test("System shows the provider-reported allowance and keeps Halflife's limits separate", { skip }, async () => {
  await p.eval(`location.hash = "#/system"`);
  await until(() => p.eval(`!!document.querySelector(".usage-panel .usage-figure")`), { what: "usage panel" });
  const t = await p.eval(`({ usage: document.querySelector(".usage-panel").innerText, limits: document.querySelector(".limits-panel").innerText, state: document.querySelector("[data-usage-state]").dataset.usageState })`);
  assert.equal(t.state, "ok");
  assert.match(t.usage, /131 of 9,000 credits used/, "the allowance the (fixture) provider reports");
  assert.match(t.usage, /8,869\s+remaining/);
  assert.match(t.usage, /Last successful refresh/);
  assert.doesNotMatch(t.usage + t.limits, /\b1,?000\b/, "no assumed 1,000-credit plan anywhere");
  assert.match(t.limits, /Lifetime ceiling\s+\d+ of 700/);
  assert.match(t.limits, /Daily limit\s+\d+ of 150/);
  assert.match(t.limits, /Account guard\s+\d+ of 7,200/, "80% of the reported allowance");
  await shot("09-system-usage");
  // manual refresh: the first is allowed, a second within 120 s is refused with the reason
  await clickSel(".usage-head button");
  await until(() => p.eval(`!!document.querySelector(".usage-head button") && !document.querySelector(".usage-head button").disabled`), { what: "refresh done" });
  await clickSel(".usage-head button");
  await until(() => p.eval(`/Not refreshed: manual refresh is limited/.test(document.querySelector(".usage-panel").innerText)`), { what: "throttle note" });
});

test("usage panel: other allowances, unknown allowance, stale and unavailable readings", { skip }, async () => {
  const render = (u) => p.eval(`import("/views/system.js").then(({ usagePanel }) => { const el = usagePanel(${JSON.stringify(u)}, null); return { text: el.innerText ?? el.textContent, meter: !!el.querySelector(".meter"), state: el.querySelector("[data-usage-state]").dataset.usageState, unavailable: !!el.querySelector("[data-allowance=unavailable]") }; })`);
  const now = Date.now();
  const u = (o) => ({ state: "ok", fetched_at: now - 60_000, cache_ms: 300_000, stale_after_ms: 900_000, plan: "TEST FIXTURE", used: 131, allowance: 4000, allowance_state: "finite", remaining: 3869, estimated_used: 131, remaining_conservative: 3869, paygo: { used: 0, limit: null }, key: { used: 131, limit: null, limit_state: "unlimited" }, last_error: null, ...o });
  // the textContent of a detached node has no layout, so innerText falls back; match loosely
  let r = await render(u({}));
  assert.match(r.text, /131 of 4,000 credits used/);
  assert.ok(r.meter);
  r = await render(u({ allowance: 15000, remaining: 14869, remaining_conservative: 14869 }));
  assert.match(r.text, /131 of 15,000 credits used/);
  assert.match(r.text, /14,869/);
  for (const allowance_state of ["missing", "unlimited", "invalid"]) {
    r = await render(u({ allowance: null, allowance_state, remaining: null, remaining_conservative: null }));
    assert.match(r.text, /131 credits used/);
    assert.doesNotMatch(r.text, /131 of/, `no maximum when the allowance is ${allowance_state}`);
    assert.doesNotMatch(r.text, /remaining by/, "no remaining balance");
    assert.equal(r.meter, false);
    assert.ok(r.unavailable);
    assert.match(r.text, /Account allowance unavailable/);
  }
  r = await render(u({ state: "stale", fetched_at: now - 3600_000, last_error: "Tavily /usage HTTP 429 (rate limited)", last_error_at: now - 30_000, retry_after_until: now + 60_000 }));
  assert.equal(r.state, "stale");
  assert.match(r.text, /Stale/);
  assert.match(r.text, /may be out of date/);
  assert.match(r.text, /429/);
  assert.match(r.text, /Tavily asked to wait/);
  r = await render({ state: "unavailable", fetched_at: null, used: null, allowance: null, allowance_state: null, last_error: "Tavily /usage HTTP 401", last_error_at: now, cache_ms: 300_000, stale_after_ms: 900_000, key: null, paygo: null });
  assert.match(r.text, /Usage could not be read/);
  assert.match(r.text, /never/);
  assert.doesNotMatch(r.text, /credits used/);
  r = await render(u({ key: { used: 40, limit: 50, limit_state: "finite" } }));
  assert.match(r.text, /This API key\s*40 of 50/, "key-level limit shown as the key's");
  assert.match(r.text, /131 of 4,000/, "account figures unchanged by the key limit");
});
