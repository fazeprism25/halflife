// Halflife console: shared helpers (DOM, API, formatting, icons, small SVG charts).
// No framework, no build step. Every number shown comes from the engine API.

export function h(tag, attrs = {}, ...children) {
  const el = tag === "svg" || SVG_TAGS.has(tag) ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v; // only used with constant SVG icon strings
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}
const SVG_TAGS = new Set(["path", "circle", "line", "rect", "g", "text", "polyline", "polygon", "title", "defs", "clipPath", "pattern", "tspan"]);
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => {
  while (el.firstChild) el.firstChild.remove();
  return el;
};

// ---------------------------------------------------------------- API

const TOKEN_KEY = "halflife.console-token";
export function consoleToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "1";
  } catch {
    return "1";
  }
}
export function setConsoleToken(t) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {}
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "x-halflife-console": consoleToken(), ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent("halflife:unauthorized"));
    throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

/** Server-sent events over fetch (EventSource cannot send the console header). Reconnects. */
export function subscribe(onEvent, onState) {
  let stopped = false;
  let ctrl;
  (async function loop() {
    let delay = 1000;
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await fetch("/v1/events", { headers: { "x-halflife-console": consoleToken() }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onState?.("live");
        delay = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (data) {
              try {
                onEvent(JSON.parse(data));
              } catch {}
            }
          }
        }
      } catch {
        if (stopped) return;
      }
      onState?.("reconnecting");
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  })();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

// ---------------------------------------------------------------- formatting

const YEAR = 365.25;
export function fmtDuration(years) {
  if (!Number.isFinite(years)) return "—";
  const d = years * YEAR;
  if (d < 1 / 24) return `${Math.max(1, Math.round(d * 24 * 60))} min`;
  if (d < 1) return `${round(d * 24)} h`;
  if (d < 60) return `${round(d)} d`;
  if (years < 2) return `${round(years * 12)} mo`;
  if (years > 1000) return "> 1000 y";
  return `${round(years)} y`;
}
const round = (x) => (x < 10 ? (Math.round(x * 10) / 10).toString() : Math.round(x).toString());
export const pct = (p) => (p < 0.005 && p > 0 ? "<1%" : `${Math.round(p * 100)}%`);
export function pctRange(lo, hi) {
  const a = pct(lo);
  const b = pct(hi);
  return a === b ? a : `${a}–${b}`;
}
/** Calendar date in UTC: used for as-of dates, publication dates and other day-precision values. */
export const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
/** A moment in the viewer's local time zone, with the zone named: used for event timestamps. */
export function stamp(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const tz = `UTC${off >= 0 ? "+" : "−"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time(ms)} ${tz}`;
}
export function time(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return date(ms);
}
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- verdict semantics

/** One place that maps engine states to label, tone and icon. Tones map to status tokens. */
export function claimState(c) {
  if (!c.time_sensitive) return { key: "static", label: "Not time-sensitive", tone: "neutral", icon: "dot" };
  switch (c.verdict) {
    case "current": return weakVerdict(c) ? { key: "current", label: "Likely current · weak evidence", tone: "neutral", icon: "check" } : { key: "current", label: "Current", tone: "good", icon: "check" };
    // Below moderate evidence the engine neither invalidates the cache nor counts the claim as
    // outdated, so the console must not present it with the same weight.
    case "superseded": return weakVerdict(c) ? { key: "superseded", label: "Possibly superseded · weak evidence", tone: "warning", icon: "replace" } : { key: "superseded", label: "Superseded", tone: "critical", icon: "replace" };
    case "contradicted": return weakVerdict(c) ? { key: "contradicted", label: "Possibly contradicted · weak evidence", tone: "warning", icon: "cross" } : { key: "contradicted", label: "Contradicted", tone: "serious", icon: "cross" };
    case "unverifiable": return { key: "unverifiable", label: "Unverifiable", tone: "neutral", icon: "question" };
  }
  if (c.triage === "low_risk") return { key: "low", label: "Low risk, not checked", tone: "neutral", icon: "dot" };
  return { key: "risk", label: c.triage === "cap" ? "At risk, over check limit" : "At risk, not checked", tone: "warning", icon: "alert" };
}

export const LEVELS = ["none", "weak", "moderate", "strong"];
const weakVerdict = (c) => LEVELS.indexOf(c.evidence_level) < 2;

const ICONS = {
  check: '<path d="M3.5 8.2 6.6 11.2 12.5 4.8" />',
  replace: '<path d="M3 5.5h8.5M9 3l2.5 2.5L9 8" /><path d="M13 10.5H4.5M7 8l-2.5 2.5L7 13" />',
  cross: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />',
  question: '<path d="M6 6.2a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.3v.4" /><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none" />',
  alert: '<path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3" /><circle cx="8" cy="11.3" r=".6" fill="currentColor" stroke="none" />',
  dot: '<circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />',
  link: '<path d="M7 4H4v8h8V9M9.5 3H13v3.5M13 3 7.5 8.5" />',
  arrow: '<path d="M3 8h10M9 4l4 4-4 4" />',
  copy: '<rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 10.5V3h7.5" />',
};
export function icon(name, cls = "") {
  return h("svg", { class: `icon ${cls}`, viewBox: "0 0 16 16", "aria-hidden": "true", html: ICONS[name] ?? "" });
}

export function stateBadge(state) {
  return h("span", { class: `badge tone-${state.tone}` }, icon(state.icon), state.label);
}

// ---------------------------------------------------------------- charts

/** Horizontal interval on a 0–1 probability scale: the B measurement. */
export function probabilityBar(lo, hi, theta) {
  const W = 100;
  return h(
    "svg",
    { class: "pbar", viewBox: `0 0 ${W} 10`, preserveAspectRatio: "none", role: "img", "aria-label": `Estimated probability outdated ${pctRange(lo, hi)}` },
    h("rect", { class: "pbar-track", x: 0, y: 4, width: W, height: 2, rx: 1 }),
    h("rect", { class: "pbar-range", x: lo * W, y: 1, width: Math.max(1.2, (hi - lo) * W), height: 8, rx: 2 }),
    theta !== undefined ? h("line", { class: "pbar-theta", x1: theta * W, x2: theta * W, y1: 0, y2: 10 }) : null,
  );
}

/** Ordinal 4-step meter for evidence confidence (C). Never a percentage. */
export function levelMeter(level) {
  const idx = level ? LEVELS.indexOf(level) : -1;
  return h(
    "span",
    { class: "level", role: "img", "aria-label": `Evidence confidence: ${level ?? "not assessed"}` },
    LEVELS.slice(1).map((l, i) => h("span", { class: `level-step ${i < idx ? "on" : ""}` })),
    h("span", { class: "level-label" }, level ?? "not assessed"),
  );
}

export function tooltip() {
  let el = document.getElementById("tooltip");
  if (!el) {
    el = h("div", { id: "tooltip", class: "tooltip", role: "tooltip" });
    document.body.append(el);
  }
  return {
    show(html, x, y) {
      clear(el);
      append(el, [html]);
      el.style.display = "block";
      const r = el.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, x + 14);
      const top = y + r.height + 20 > window.innerHeight ? y - r.height - 12 : y + 14;
      el.style.left = `${Math.max(8, left)}px`;
      el.style.top = `${Math.max(8, top)}px`;
    },
    hide() {
      el.style.display = "none";
    },
  };
}

export function copyButton(text, label = "Copy") {
  const b = h("button", { class: "btn-ghost btn-small", type: "button", title: "Copy to clipboard" }, icon("copy"), label);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.lastChild.textContent = "Copied";
      setTimeout(() => (b.lastChild.textContent = label), 1200);
    } catch {
      b.lastChild.textContent = "Copy failed";
    }
  });
  return b;
}
