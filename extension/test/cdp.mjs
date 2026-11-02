// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe (fds 3 and 4), used by
// the extension end-to-end test. Branded Chrome/Edge ≥ 137 ignore --load-extension; the
// supported route is CDP Extensions.loadUnpacked with --enable-unsafe-extension-debugging.
import { spawn } from "node:child_process";
import fs from "node:fs";

export const BROWSERS = [
  process.env.HALFLIFE_TEST_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].filter(Boolean);
export const findBrowser = () => BROWSERS.find((b) => fs.existsSync(b)) ?? null;

export function launch(exe, args) {
  const proc = spawn(exe, ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", ...args], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const out = proc.stdio[3];
  const inp = proc.stdio[4];
  let id = 0;
  let buf = "";
  const pending = new Map();
  const listeners = new Set();
  inp.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
        else resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    out.write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  return {
    proc, send,
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    close: () => new Promise((r) => {
      proc.once("exit", r);
      send("Browser.close").catch(() => {});
      setTimeout(() => { try { proc.kill(); } catch {} r(); }, 3000);
    }),
  };
}

/** Opens a page target and returns a small session helper. */
export async function openPage(b, url) {
  const { targetId } = await b.send("Target.createTarget", { url });
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  await s("Runtime.enable");
  return {
    targetId, sessionId, send: s,
    async eval(expr) {
      const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, { timeout = 15000, every = 150, what = "condition" } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
