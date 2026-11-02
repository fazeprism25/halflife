// Console UI test (Inspector Traffic drawer) in a real headless Edge or Chrome, against the TEST
// FIXTURE engine (scripted model and search: no tokens, no Tavily credits). Not part of `npm test`,
// which stays browser-free. Run from the repository root:
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

let tmp, engineProc, port, browser, p;
const base = () => `http://127.0.0.1:${port}`;

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-ui-"));
  port = await freePort();
  engineProc = spawn(process.execPath, [path.join(HERE, "fixture-server.ts"), "--port", String(port), "--seed"], { stdio: "ignore" });
  await until(async () => (await fetch(base() + "/v1/health")).ok, { what: "fixture engine" });
  browser = launch(BROWSER, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", `--user-data-dir=${path.join(tmp, "profile")}`]);
  p = await openPage(browser, "about:blank");
  await p.send("Page.enable");
  await viewport(1440, 900);
  await p.send("Page.navigate", { url: base() + "/#/inspector" });
  await until(() => p.eval("document.querySelectorAll('.feed-item').length >= 3 && !!document.querySelector('.report-title')"), { what: "inspector with reports" });
});

after(async () => {
  await browser?.close();
  engineProc?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const viewport = (width, height) => p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const state = () => p.eval(`(() => {
  const d = document.querySelector("#traffic-drawer"), t = document.querySelector(".drawer-toggle");
  const a = document.activeElement;
  return {
    open: d.dataset.open === "true", visible: getComputedStyle(d).visibility === "visible",
    expanded: t.getAttribute("aria-expanded"), railInert: document.querySelector(".rail").inert,
    detailInert: document.querySelector(".detail").inert, focusInDrawer: d.contains(a), focusOnToggle: a === t,
    hash: location.hash, position: document.querySelector(".bar-position").textContent,
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
const settle = () => sleep(320); // longer than the 200 ms transition
async function shot(name) {
  const dir = process.env.HALFLIFE_UI_SHOTS;
  if (!dir) return;
  await settle();
  const { data } = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(data, "base64"));
}
async function openWithToggle() {
  await clickSel(".drawer-toggle");
  await until(async () => (await state()).focusInDrawer, { what: "focus in drawer" });
  await settle();
}

test("closed by default: the workspace uses the full width and the report detail is shown", { skip }, async () => {
  const s = await state();
  assert.equal(s.open, false);
  assert.equal(s.visible, false, "a closed drawer is hidden from layout, tab order and the accessibility tree");
  assert.equal(s.expanded, "false");
  const [mainW, detailW] = await p.eval(`[document.querySelector("main").offsetWidth, document.querySelector(".detail").offsetWidth]`);
  assert.ok(detailW >= mainW - 1, `detail ${detailW}px should fill main ${mainW}px`);
  assert.ok(await p.eval(`!!document.querySelector(".report-title") && !!document.querySelector(".claim-col")`), "report and claim detail render");
  assert.match(s.position, /^1 of /);
  await shot("01-wide-closed");
});

test("toggle opens an overlay: focus moves into it and the rest of the console is inert", { skip }, async () => {
  const before = await p.eval(`document.querySelector(".detail").getBoundingClientRect().width`);
  await openWithToggle();
  const s = await state();
  assert.deepEqual([s.open, s.visible, s.expanded, s.railInert, s.detailInert], [true, true, "true", true, true]);
  assert.ok(await p.eval(`document.activeElement.matches('.feed-item[aria-current="true"]')`), "focus starts on the selected report");
  assert.equal(await p.eval(`document.querySelector(".detail").getBoundingClientRect().width`), before, "the drawer overlays; it does not shrink the workspace");
  await shot("02-wide-open");
});

test("Escape closes and returns focus to the toggle", { skip }, async () => {
  await key("Escape", "Escape", 27);
  await settle();
  const s = await state();
  assert.deepEqual([s.open, s.visible, s.expanded, s.railInert, s.detailInert, s.focusOnToggle], [false, false, "false", false, false, true]);
});

test("a click outside the drawer (on the scrim) closes it", { skip }, async () => {
  await openWithToggle();
  await clickAt(1100, 500);
  await settle();
  assert.equal((await state()).open, false);
  // the scrim also covers the navigation rail: a click there dismisses rather than navigating
  await openWithToggle();
  const hash = (await state()).hash;
  await clickSel('#nav a[data-route="system"]');
  await settle();
  const s = await state();
  assert.equal(s.open, false);
  assert.equal(s.hash, hash, "the click was taken by the scrim, not the nav link");
});

test("the close button closes it", { skip }, async () => {
  await openWithToggle();
  await clickSel("#traffic-drawer .icon-btn");
  await settle();
  const s = await state();
  assert.equal(s.open, false);
  assert.equal(s.focusOnToggle, true);
});

test("keyboard: T opens, arrow keys move between reports, Enter selects and closes", { skip }, async () => {
  const ids = await p.eval(`[...document.querySelectorAll(".feed-item")].map((b) => b.textContent)`);
  assert.ok(ids.length >= 3);
  await key("t", "KeyT", 84);
  await until(async () => (await state()).focusInDrawer, { what: "T opens the drawer" });
  await key("ArrowDown", "ArrowDown", 40);
  assert.ok(await p.eval(`document.activeElement === document.querySelectorAll(".feed-item")[1]`), "ArrowDown focuses the next report");
  await key("Enter", "Enter", 13);
  await until(async () => (await state()).position.startsWith("2 of"), { what: "second report selected" });
  await settle();
  const s = await state();
  assert.equal(s.open, false, "selecting a report closes the overlay");
  const id = s.hash.split("/")[2];
  assert.ok(id, "the selection is in the URL");
  await until(() => p.eval(`document.querySelector(".report-id .mono")?.textContent === ${JSON.stringify(id)}`), { what: "detail of the selected report" });
});

test("newer/older step through traffic without opening the drawer", { skip }, async () => {
  await clickSel('.bar-nav [aria-label="Newer report"]');
  await until(async () => (await state()).position.startsWith("1 of"), { what: "newer" });
  assert.equal(await p.eval(`document.querySelector('[aria-label="Newer report"]').disabled`), true, "no newer report than the latest");
  await clickSel('.bar-nav [aria-label="Older report"]');
  await until(async () => (await state()).position.startsWith("2 of"), { what: "older" });
  assert.equal((await state()).open, false);
});

test("a new report while the drawer is closed marks the toggle; opening clears it", { skip }, async () => {
  await fetch(base() + "/v1/check", { method: "POST", headers: { "content-type": "application/json", "x-halflife-console": "1" }, body: JSON.stringify({ text: "The latest stable Python release is 3.11." }) });
  await until(() => p.eval(`document.querySelector(".drawer-toggle").dataset.new === "true"`), { what: "new-report mark" });
  assert.match(await p.eval(`document.querySelector(".drawer-toggle").textContent`), /new reports/);
  await shot("03-wide-new-report");
  await openWithToggle();
  assert.equal(await p.eval(`document.querySelector(".drawer-toggle").dataset.new`), "false");
  await key("Escape", "Escape", 27);
  await settle();
});

test("phone width: no horizontal scroll, the drawer fits the screen and still closes", { skip }, async () => {
  await viewport(390, 844);
  await settle();
  assert.ok(await p.eval(`document.documentElement.scrollWidth <= innerWidth`), "no horizontal page scroll");
  assert.equal((await state()).open, false);
  await shot("04-phone-closed");
  await openWithToggle();
  const r = await p.eval(`(() => { const b = document.querySelector("#traffic-drawer").getBoundingClientRect(); return { left: b.left, width: b.width, top: b.top, height: b.height, pos: getComputedStyle(document.querySelector("#traffic-drawer")).position }; })()`);
  assert.equal(r.pos, "fixed");
  assert.equal(Math.round(r.left), 0);
  assert.ok(r.width <= 390 - 40 && r.width >= 300, `drawer width ${r.width}`);
  assert.equal(Math.round(r.top), 0);
  assert.equal(Math.round(r.height), 844);
  await shot("05-phone-open");
  await clickAt(375, 400); // the uncovered strip
  await settle();
  assert.equal((await state()).open, false);
});

test("tablet width: drawer and claim detail still lay out", { skip }, async () => {
  await viewport(820, 1000);
  await settle();
  assert.ok(await p.eval(`document.documentElement.scrollWidth <= innerWidth`));
  await openWithToggle();
  await shot("06-tablet-open");
  await key("Escape", "Escape", 27);
  await settle();
  assert.equal((await state()).open, false);
  await viewport(1440, 900);
});

test("light and dark themes render the drawer with their own tokens", { skip }, async () => {
  await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await openWithToggle();
  const bg = await p.eval(`getComputedStyle(document.querySelector("#traffic-drawer")).backgroundColor`);
  assert.equal(bg, "rgb(22, 22, 21)"); // --surface-1 (dark)
  await shot("07-wide-open-dark");
  await key("Escape", "Escape", 27);
  await settle();
  await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await openWithToggle();
  assert.equal(await p.eval(`getComputedStyle(document.querySelector("#traffic-drawer")).backgroundColor`), "rgb(252, 252, 251)"); // --surface-1 (light)
  await shot("08-wide-open-light");
  await key("Escape", "Escape", 27);
  await settle();
  await p.send("Emulation.setEmulatedMedia", { features: [] });
});

test("leaving the Inspector restores the console: nothing stays inert, other pages unchanged", { skip }, async () => {
  await openWithToggle();
  await p.eval(`location.hash = "#/activity"`);
  await until(() => p.eval(`!document.querySelector("#traffic-drawer") && !!document.querySelector(".act-grid, .act-list, .page-head")`), { what: "activity page" });
  assert.equal(await p.eval(`document.querySelector(".rail").inert`), false);
  assert.equal(await p.eval(`document.documentElement.classList.contains("drawer-open")`), false);
  for (const r of ["check", "model", "system", "claims", "trends", "extension", "inspector"]) {
    await p.eval(`location.hash = "#/${r}"`);
    await until(() => p.eval(`document.querySelector("#main").children.length > 0 && document.querySelector('#nav a[aria-current="page"]')?.dataset.route === "${r}"`), { what: `route ${r}` });
  }
  await key("t", "KeyT", 84);
  await until(async () => (await state()).open, { what: "drawer works after navigating back" });
  await key("Escape", "Escape", 27);
});
