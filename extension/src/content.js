// Halflife content script for ChatGPT.
//
// Adds one small "Check freshness" action under each *completed* assistant answer. Nothing is
// read or sent until the user clicks it; then only that answer, the user message directly before
// it, its message id, model slug and the conversation id (hashed by the service worker) are sent.
// The UI lives in a shadow root so ChatGPT's styles and ours never interact.
(function () {
  "use strict";
  if (window.__halflifeLoaded) return;
  window.__halflifeLoaded = true;

  const adapter = window.HalflifeAdapters && window.HalflifeAdapters.chatgpt;
  if (!adapter || !adapter.supports(location)) return;

  const HOST_ATTR = "data-halflife-host";
  const POLL_MS = 1500;
  const POLL_MAX_MS = 180000;
  const STABLE_MS = 600;
  const STAGES = { extract: "Extracting claims", assess: "Estimating freshness", verify: "Verifying against live sources" };
  const LABELS = {
    outdated: ["Outdated information found", "bad"],
    possibly_outdated: ["Possibly outdated (weak evidence)", "warn"],
    unverified: ["Not fully verified", "warn"],
    current: ["Checked claims are current", "good"],
    low_risk: ["Time-sensitive claims, low risk", "neutral"],
    no_time_sensitive: ["No time-sensitive claims", "neutral"],
    no_claims: ["No factual claims found", "neutral"],
  };

  let paused = false;
  let contextLost = false;
  /** Per answer key: last known UI state, so a re-rendered or re-hydrated answer keeps its result.
   *  Kept in memory only (page storage would expose results to the page). */
  const states = new Map();
  const hosts = new Map(); // key → { host, root }

  // ---------------------------------------------------------------- messaging

  function send(msg) {
    return new Promise((resolve) => {
      if (contextLost || !chrome.runtime || !chrome.runtime.id) return resolve(lost());
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError || !r) return resolve(lost());
          resolve(r);
        });
      } catch {
        resolve(lost());
      }
    });
  }
  function lost() {
    contextLost = true;
    observer.disconnect();
    return { ok: false, error: { kind: "reload", message: "Halflife was updated or reloaded. Reload this tab to use it again." } };
  }

  // ---------------------------------------------------------------- keys and hashing

  async function hashKey(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return "h" + Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------- UI

  const CSS = `
    :host { all: initial; display: block; margin: 6px 0 12px; font: 13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; color: var(--fg); }
    :host { --fg: #0d0d0d; --muted: #5d5d5a; --line: rgba(0,0,0,.12); --chip: rgba(0,0,0,.04); --chip-hover: rgba(0,0,0,.08);
            --good: #0a7d0a; --good-bg: rgba(12,163,12,.10); --warn: #7a5200; --warn-bg: rgba(250,178,25,.18);
            --bad: #a32424; --bad-bg: rgba(208,59,59,.12); --neutral: #52514e; --neutral-bg: rgba(133,132,126,.12); }
    :host([data-theme="dark"]) {
      --fg: #ececec; --muted: #a8a8a3; --line: rgba(255,255,255,.14); --chip: rgba(255,255,255,.05); --chip-hover: rgba(255,255,255,.10);
              --good: #5fd35f; --good-bg: rgba(12,163,12,.18); --warn: #fab219; --warn-bg: rgba(250,178,25,.16);
              --bad: #ef7d7d; --bad-bg: rgba(208,59,59,.20); --neutral: #c3c2b7; --neutral-bg: rgba(133,132,126,.18);
    }
    * { box-sizing: border-box; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button { font: inherit; color: inherit; cursor: pointer; border: 1px solid var(--line); background: var(--chip); border-radius: 999px; padding: 3px 10px 3px 8px; display: inline-flex; align-items: center; gap: 6px; transition: background .15s, border-color .15s, opacity .15s; }
    button:hover:not(:disabled) { background: var(--chip-hover); }
    button:focus-visible { outline: 2px solid #3987e5; outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .6; }
    button.link { border: 0; background: none; padding: 2px 4px; color: var(--muted); text-decoration: underline; text-underline-offset: 2px; border-radius: 4px; }
    button.link:hover { color: var(--fg); background: none; }
    .mark { width: 14px; height: 14px; flex: none; }
    .card { margin-top: 6px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; max-width: 560px; animation: in .18s ease-out; }
    @keyframes in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .card, .spin { animation: none !important; } }
    .badge { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
    .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .good { color: var(--good); background: var(--good-bg); } .warn { color: var(--warn); background: var(--warn-bg); }
    .bad { color: var(--bad); background: var(--bad-bg); } .neutral { color: var(--neutral); background: var(--neutral-bg); }
    .headline { color: var(--muted); margin-top: 6px; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 10px 0 8px; }
    .stat b { display: block; font-size: 16px; font-variant-numeric: tabular-nums; }
    .stat span { color: var(--muted); font-size: 11.5px; }
    .stat.hl-bad b { color: var(--bad); } .stat.hl-warn b { color: var(--warn); }
    .note { color: var(--muted); font-size: 12px; }
    .err { color: var(--bad); }
    .spin { width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--fg); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 480px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `;

  const MARK = '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5a9.5 9.5 0 0 1 0 19z" fill="currentColor"/></svg>';

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }
  function markButton(label, onclick, disabled) {
    const b = el("button", { type: "button", onclick, disabled });
    b.insertAdjacentHTML("afterbegin", MARK); // constant markup only
    b.append(label);
    return b;
  }

  /** ChatGPT has its own light/dark setting, independent of the OS, so the page decides:
   *  its html class when it sets one, otherwise the luminance of the page background. */
  function pageTheme() {
    const cl = document.documentElement.classList;
    if (cl.contains("dark")) return "dark";
    if (cl.contains("light")) return "light";
    for (const el of [document.body, document.documentElement]) {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) return 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3] < 128 ? "dark" : "light";
    }
    // Transparent backgrounds: the canvas is dark only if the page opts into a dark color-scheme.
    const cs = getComputedStyle(document.documentElement).colorScheme || "normal";
    if (/dark/.test(cs) && (!/light/.test(cs) || matchMedia("(prefers-color-scheme: dark)").matches)) return "dark";
    return "light";
  }
  let theme = "light";
  function applyTheme() {
    theme = pageTheme();
    for (const [, h] of hosts) h.host.setAttribute("data-theme", theme);
  }

  function render(key) {
    const h = hosts.get(key);
    if (!h) return;
    const s = states.get(key) || { phase: "idle" };
    const root = h.root;
    while (root.childNodes.length > 1) root.lastChild.remove(); // keep <style>
    const wrap = el("div", { role: "group", "aria-label": "Halflife freshness check" });
    root.append(wrap);

    if (s.phase === "idle") {
      wrap.append(el("div", { class: "row" }, markButton("Check freshness", () => start(key), false)));
      return;
    }
    if (s.phase === "busy") {
      wrap.append(el("div", { class: "row", "aria-live": "polite" }, el("span", { class: "spin", "aria-hidden": "true" }), el("span", { class: "note" }, s.label || "Checking…")));
      return;
    }
    if (s.phase === "error") {
      wrap.append(el("div", { class: "card", role: "alert" },
        el("div", { class: "err" }, s.message),
        el("div", { class: "row", style: "margin-top:8px" },
          s.kind === "reload" ? null : markButton("Try again", () => start(key, true), false),
          s.kind === "unpaired" ? el("span", { class: "note" }, "Click the Halflife icon in the toolbar to connect.") : null)));
      return;
    }
    // done
    const r = s.result;
    const [label, tone] = LABELS[r.assessment] || ["Check finished", "neutral"];
    const c = r.counts || {};
    const stat = (n, t, cls) => el("div", { class: `stat ${n > 0 && cls ? cls : ""}` }, el("b", {}, String(n ?? 0)), el("span", {}, t));
    wrap.append(el("div", { class: "card", "aria-live": "polite" },
      el("div", { class: "row" }, el("span", { class: `badge ${tone}` }, label)),
      r.headline ? el("div", { class: "headline" }, r.headline) : null,
      el("div", { class: "stats" },
        stat(c.claims, "claims examined"),
        stat(c.at_risk, "potentially outdated", "hl-warn"),
        stat((c.superseded || 0) + (c.contradicted || 0), "superseded or contradicted", "hl-bad"),
        stat(c.checked, "checked live")),
      r.live_verification === false ? el("div", { class: "note" }, "Live verification is off in Halflife settings: these are estimates only.") : null,
      el("div", { class: "row" },
        el("button", { type: "button", class: "link", onclick: () => send({ type: "hl.open", id: r.id }) }, "Open in Halflife"),
        el("button", { type: "button", class: "link", onclick: () => start(key, true) }, "Re-check"),
        s.duplicate ? el("span", { class: "note" }, "Already checked; showing the saved result.") : null)));
  }

  function setState(key, s) {
    states.set(key, s);
    render(key);
  }

  // ---------------------------------------------------------------- the check

  async function start(key, force = false) {
    const h = hosts.get(key);
    if (!h || (states.get(key) || {}).phase === "busy") return; // duplicate clicks are ignored
    const resp = h.resp;
    setState(key, { phase: "busy", label: "Reading the answer…" });
    // Never analyse incomplete output: the answer must be complete and unchanged across a short wait.
    const first = adapter.answerText(resp);
    await new Promise((r) => setTimeout(r, STABLE_MS));
    const fresh = currentResp(key) || resp;
    const second = adapter.answerText(fresh);
    if (!adapter.isComplete(fresh, document) || !second || first !== second) {
      return setState(key, { phase: "error", kind: "streaming", message: "This answer is still being written. Try again when it has finished." });
    }
    const question = await adapter.questionFor(fresh, document);
    setState(key, { phase: "busy", label: "Sending to Halflife…" });
    const r = await send({ type: "hl.check", payload: { answer: second, question, message_id: fresh.messageId || undefined, model: adapter.modelSlug(fresh) || undefined, conversation_id: adapter.conversationId(location) || undefined, force } });
    if (!r.ok) return setState(key, { phase: "error", kind: r.error.kind, message: r.error.message });
    await follow(key, r.data);
  }

  async function follow(key, first) {
    let v = first;
    const t0 = Date.now();
    while (v.status !== "done" && v.status !== "failed") {
      setState(key, { phase: "busy", label: `${STAGES[v.stage] || "Queued"}…` });
      if (Date.now() - t0 > POLL_MAX_MS) return setState(key, { phase: "error", kind: "timeout", message: "Halflife is still working on this. Open it in Halflife to follow progress." });
      await new Promise((r) => setTimeout(r, POLL_MS));
      const p = await send({ type: "hl.poll", id: v.id });
      if (!p.ok) return setState(key, { phase: "error", kind: p.error.kind, message: p.error.message });
      v = p.data;
    }
    if (v.status === "failed") return setState(key, { phase: "error", kind: "failed", message: `Halflife could not analyse this answer${v.error ? `: ${v.error}` : "."}` });
    setState(key, { phase: "done", result: v, duplicate: first.duplicate === true });
  }

  // ---------------------------------------------------------------- attaching to answers

  const keyOf = new WeakMap(); // container element → key
  function currentResp(key) {
    return adapter.responses(document).find((r) => keyOf.get(r.container) === key) || null;
  }

  async function scan() {
    if (contextLost) return;
    applyTheme();
    for (const resp of adapter.responses(document)) {
      if (paused) break;
      if (!adapter.isComplete(resp, document)) continue;
      let key = resp.messageId || keyOf.get(resp.container);
      if (!key) key = await hashKey(adapter.answerText(resp));
      keyOf.set(resp.container, key);
      let h = hosts.get(key);
      if (h && h.host.isConnected && resp.container.contains(h.host)) {
        h.resp = resp;
        continue;
      }
      if (h && h.host.isConnected) h.host.remove(); // duplicate rendering elsewhere
      const host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      host.setAttribute("data-theme", theme);
      const root = host.attachShadow({ mode: "closed" });
      root.append(el("style", {}, CSS));
      resp.anchor.append(host);
      hosts.set(key, { host, root, resp });
      render(key);
    }
    if (paused) removeAll();
  }

  function removeAll() {
    for (const [, h] of hosts) h.host.remove();
    hosts.clear();
  }

  // Debounced, with a maximum wait: while an answer streams, mutations never stop, and a pure
  // debounce would keep the buttons of earlier, finished answers from appearing.
  let timer = 0;
  let firstPending = 0;
  const schedule = () => {
    const now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(timer);
    const run = () => {
      firstPending = 0;
      void scan();
    };
    if (now - firstPending >= 1000) run();
    else timer = setTimeout(run, 400);
  };
  const observer = new MutationObserver((records) => {
    // Ignore batches that only insert or remove our own hosts. Attribute records (streaming state
    // flips) have no added/removed nodes and must never be ignored.
    const ours = (r) => {
      const nodes = [...r.addedNodes, ...r.removedNodes];
      return r.type === "childList" && nodes.length > 0 && nodes.every((n) => n.nodeType === 1 && n.hasAttribute(HOST_ATTR));
    };
    if (records.every(ours)) return;
    schedule();
  });

  // Diagnostics for the popup: which layout the adapter recognised and how many answers it sees.
  // Counts only; no page text is returned.
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !msg || msg.type !== "hl.diagnose") return false;
    const rs = adapter.responses(document);
    reply({ platform: adapter.id, layout: rs[0] ? rs[0].layout : null, answers: rs.length, complete: rs.filter((r) => adapter.isComplete(r, document)).length, generating: adapter.isGenerating(document), buttons: hosts.size, paused });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.paused) return;
    paused = !!changes.paused.newValue;
    if (paused) removeAll();
    else schedule();
  });

  send({ type: "hl.state" }).then((r) => {
    paused = !!(r.ok && r.data.paused);
    if (contextLost) return;
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-is-streaming", "data-talvt-turn-state"] });
    // ChatGPT switches theme by changing the html class.
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    schedule();
  });
})();
