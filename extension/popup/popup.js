// Halflife popup: connection status, pairing, pause/resume, recent checks, disconnect.
// Everything goes through the service worker; the popup never sees the token.
"use strict";

const main = document.getElementById("main");
const conn = document.getElementById("conn");
const TONE = { outdated: "bad", possibly_outdated: "warn", unverified: "warn", current: "good" };

const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: { message: "No response from the extension." } })));

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

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function setConn(state, label) {
  conn.dataset.state = state;
  conn.textContent = label;
}

async function load() {
  const r = await send({ type: "hl.status" });
  main.replaceChildren();
  if (!r.ok) {
    setConn("offline", "Error");
    main.append(el("p", { class: "err" }, r.error.message));
    return;
  }
  const s = r.data;
  if (s.connection === "unpaired") return renderPair(s);
  if (s.connection === "offline") return renderOffline(s);
  renderConnected(s);
}

function renderPair(s, error) {
  setConn("unpaired", "Not connected");
  const form = el("form", { class: "section", onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    const r = await send({ type: "hl.pair", engineUrl: fd.get("url"), code: fd.get("code") });
    if (r.ok) return load();
    renderPair({ ...s, engineUrl: fd.get("url") }, r.error.message);
  } },
    el("div", { class: "label" }, "Connect to Halflife"),
    el("ol", {},
      el("li", {}, "Start Halflife and open its console."),
      el("li", {}, "Go to ", el("b", {}, "Extension"), " and choose ", el("b", {}, "Create pairing code"), "."),
      el("li", {}, "Enter the code here. It works once and expires in 10 minutes.")),
    el("label", { class: "field" }, el("span", {}, "Halflife address"), el("input", { name: "url", value: s.engineUrl, required: true, spellcheck: "false", autocomplete: "off" })),
    el("label", { class: "field" }, el("span", {}, "Pairing code"), el("input", { name: "code", required: true, placeholder: "ABCD-EF23", maxlength: 12, autocomplete: "off", spellcheck: "false" })),
    error ? el("p", { class: "err", role: "alert" }, error) : null,
    el("div", { class: "row" }, el("button", { class: "btn primary", type: "submit" }, "Connect")));
  main.replaceChildren(form);
  form.querySelector(error ? "input[name=code]" : "input[name=code]").focus();
}

/** Element.append renders null as the text "null": drop empty slots first. */
const put = (...nodes) => main.append(...nodes.filter(Boolean));

function renderOffline(s) {
  setConn("offline", "Offline");
  put(
    el("div", { class: "notice section" },
      el("strong", {}, "Halflife isn't reachable"),
      el("p", { class: "note" }, s.error || `Nothing answered at ${s.engineUrl}.`),
      el("p", { class: "note" }, "Start it with ", el("code", {}, "docker compose -f deploy/docker-compose.yml up -d"), ", then retry.")),
    el("div", { class: "row" },
      el("button", { class: "btn", type: "button", onclick: load }, "Retry"),
      el("button", { class: "btn danger", type: "button", onclick: disconnect }, "Disconnect")),
    pauseToggle(s));
}

function renderConnected(s) {
  const st = s.status;
  if (s.paused) setConn("paused", "Paused");
  else if (!st.accept_checks) setConn("paused", "Paused in Halflife");
  else setConn("connected", "Connected");
  const limited = !st.verification_available.judge || !st.verification_available.search;
  put(
    el("div", { class: "stats" },
      el("div", { class: "stat" }, el("b", {}, String(st.checks_today)), el("span", {}, `today of ${st.daily_limit}`)),
      el("div", { class: "stat" }, el("b", {}, String(st.total_checks)), el("span", {}, "total checks")),
      el("div", { class: "stat" }, el("b", {}, st.live_verification ? "Live" : "Estimate"), el("span", {}, "verification"))),
    !st.accept_checks ? el("p", { class: "note" }, "New checks are turned off in Halflife's Extension settings.") : null,
    limited && st.live_verification ? el("p", { class: "note" }, `Halflife has no ${!st.verification_available.judge ? "judge model" : "search"} configured, so claims are estimated but not verified live.`) : null,
    pauseToggle(s),
    diagnostics(),
    el("div", { class: "section" },
      el("div", { class: "label" }, "Recent checks"),
      s.recent && s.recent.length
        ? el("div", { class: "list" }, s.recent.map((c) => el("button", { class: "item", type: "button", title: "Open in Halflife", onclick: () => send({ type: "hl.open", id: c.id }) },
            el("span", { class: `dot ${TONE[c.assessment] || ""}`, "aria-hidden": "true" }),
            el("span", {}, el("div", { class: "q" }, c.question || "(no text)"), el("div", { class: "h" }, c.headline || (c.status === "failed" ? "Analysis failed" : "In progress…"))),
            el("time", { datetime: new Date(c.created_at).toISOString() }, ago(c.created_at)))))
        : el("div", { class: "list" }, el("div", { class: "empty" }, "No checks yet. In ChatGPT, click Check freshness under an answer."))),
    el("div", { class: "row" },
      el("button", { class: "btn", type: "button", onclick: () => send({ type: "hl.open" }) }, "Open dashboard"),
      el("button", { class: "btn danger", type: "button", onclick: disconnect }, "Disconnect")),
    el("p", { class: "note" }, `Engine: `, el("code", {}, s.engineUrl)));
}

/** What the adapter sees on the active tab (counts only). Needs no "tabs" permission: the id of
 *  the active tab is available without it, and only our own content script can answer. */
function diagnostics() {
  const line = el("p", { class: "note", id: "diag" });
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab || tab.id === undefined) return;
    chrome.tabs.sendMessage(tab.id, { type: "hl.diagnose" }, (d) => {
      if (chrome.runtime.lastError || !d) {
        line.textContent = "This tab is not a ChatGPT conversation.";
        return;
      }
      const layout = { A: "message roles", B: "search units (2026-09)", C: "turn shells" }[d.layout];
      line.textContent = d.answers
        ? `This tab: ${d.answers} answer${d.answers === 1 ? "" : "s"} found (${layout} layout), ${d.complete} complete${d.generating ? ", one still being written" : ""}.`
        : "This tab: no ChatGPT answers recognised. If answers are visible, ChatGPT's page structure may have changed.";
    });
  });
  return line;
}

function pauseToggle(s) {
  const input = el("input", { type: "checkbox", id: "pause", checked: s.paused, style: "width:auto" });
  input.addEventListener("change", async () => {
    await send({ type: "hl.setPaused", paused: input.checked });
    load();
  });
  return el("label", { class: "toggle", for: "pause" },
    el("span", {}, el("strong", {}, "Pause Halflife"), el("div", { class: "note" }, s.paused ? "Buttons are hidden in ChatGPT and nothing is sent." : "Buttons appear under completed answers.")),
    input);
}

async function disconnect() {
  await send({ type: "hl.disconnect" });
  load();
}

load();
