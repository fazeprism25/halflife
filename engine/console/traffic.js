// Traffic: the latest 100 reports, shown as a collapsible section of the main sidebar (AD-35).
// One shared list for the whole console, so the sidebar shows it on every page; the Inspector
// reads the same list for its newer/older stepping. Live: any engine event reloads the list
// (debounced). "New" means a newer report than the newest one the viewer has had on screen.
import { api, clear, h, icon, pct, plural, stamp, time } from "./lib.js";

const STAGES = { extract: "Extracting claims", assess: "Estimating freshness", verify: "Verifying against live sources" };
const LIMIT = 100;
const EXPAND_KEY = "halflife.traffic";

export function createTraffic({ onEngineEvent, onPick, isVisible }) {
  const toggle = document.getElementById("traffic-toggle");
  const panel = document.getElementById("traffic-panel");
  const count = document.getElementById("traffic-count");
  const newNote = document.getElementById("traffic-new");
  const list = h("ul", { class: "feed-list", "aria-label": "Latest reports", onkeydown: onKey });
  panel.append(list);

  let reports = [];
  let selectedId = null;
  let loaded = false;
  let seenTopId = null;
  let expanded = false;
  const listeners = new Set();
  try {
    expanded = localStorage.getItem(EXPAND_KEY) === "open";
  } catch {}
  applyExpanded();
  toggle.addEventListener("click", () => setExpanded(!expanded));

  function applyExpanded() {
    toggle.setAttribute("aria-expanded", String(expanded));
    panel.hidden = !expanded;
    toggle.closest(".traffic").dataset.expanded = String(expanded);
  }
  function setExpanded(v, { persist = true } = {}) {
    expanded = v;
    applyExpanded();
    if (persist) {
      try {
        localStorage.setItem(EXPAND_KEY, v ? "open" : "closed");
      } catch {}
    }
    markSeenIfVisible();
  }

  function onKey(e) {
    const items = [...list.querySelectorAll(".feed-item")];
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined || !items.length) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, to))].focus();
  }

  async function load() {
    try {
      const r = await api(`/v1/reports?limit=${LIMIT}`);
      reports = r.reports;
      if (!loaded) seenTopId = reports[0]?.id ?? null;
      loaded = true;
      render();
      markSeenIfVisible();
      for (const fn of listeners) fn(reports);
    } catch (e) {
      if (e.status !== 401) clear(list).append(h("li", { class: "feed-empty error" }, `Could not load reports: ${e.message}`));
    }
  }

  function render() {
    count.textContent = reports.length ? (reports.length >= LIMIT ? String(LIMIT) : String(reports.length)) : "";
    count.title = reports.length >= LIMIT ? "Showing the latest 100 reports" : plural(reports.length, "report");
    clear(list);
    if (!reports.length) {
      list.append(h("li", { class: "feed-empty" }, "No traffic yet. Answers that pass through the gateway appear here as they arrive."));
      return;
    }
    for (const r of reports) list.append(h("li", {}, item(r)));
    if (reports.length >= LIMIT) list.append(h("li", { class: "feed-foot muted" }, "Latest 100 reports"));
  }

  function item(r) {
    const s = r.summary;
    const risk = r.max_p ?? 0;
    let headline;
    if (r.status === "linked") headline = [icon("link"), "Cache hit · analysis reused"];
    else if (r.status === "failed") headline = [h("span", { class: "badge tone-critical" }, icon("cross"), "Analysis failed")];
    else if (r.status !== "done") headline = [h("span", { class: "muted" }, STAGES[r.stage] ?? "Queued", "…")];
    else headline = [summaryBadge(s), h("span", {}, s?.headline ?? "")];
    return h("button", { class: "feed-item", type: "button", "data-id": r.id, "aria-current": String(r.id === selectedId), onclick: () => onPick(r.id) },
      h("span", { class: "meta" }, h("span", { class: "mono", title: stamp(r.created_at) }, sameDay(r.created_at) ? time(r.created_at) : `${localDay(r.created_at)} ${time(r.created_at)}`), h("span", { class: "tag" }, r.source), r.model ? h("span", {}, r.model) : null, r.cache_hit ? h("span", { class: "tag" }, "hit") : null),
      h("span", { class: "risk-tick", title: `Highest P(outdated) among its claims: ${pct(risk)}` }, h("i", { style: { width: `${Math.round(risk * 100)}%` } })),
      h("span", { class: "preview" }, r.preview ?? ""),
      h("span", { class: "headline" }, headline),
    );
  }

  function markSeenIfVisible() {
    if (expanded && isVisible() && loaded) seenTopId = reports[0]?.id ?? null;
    updateNew();
  }
  function hasNew() {
    return loaded && !!reports[0] && reports[0].id !== seenTopId;
  }
  function updateNew() {
    const fresh = hasNew();
    toggle.dataset.new = String(fresh);
    newNote.textContent = fresh ? ", new reports" : "";
    document.dispatchEvent(new CustomEvent("halflife:traffic-new", { detail: fresh }));
  }

  let pending = null;
  onEngineEvent((e) => {
    if (e.type === "status") return;
    clearTimeout(pending);
    pending = setTimeout(load, 250);
  });
  load();

  return {
    get reports() { return reports; },
    get loaded() { return loaded; },
    get expanded() { return expanded; },
    setExpanded,
    hasNew,
    /** Call when the sidebar opens or closes, so on-screen reports count as seen. */
    visibilityChanged: markSeenIfVisible,
    setSelected(id) {
      selectedId = id;
      for (const b of list.querySelectorAll(".feed-item")) b.setAttribute("aria-current", String(b.dataset.id === id));
    },
    /** Focus the selected report (or the first one); false when there is nothing to focus. */
    focusSelected() {
      const el = list.querySelector('.feed-item[aria-current="true"]') ?? list.querySelector(".feed-item");
      if (!el) return false;
      el.focus();
      el.scrollIntoView?.({ block: "nearest" });
      return true;
    },
    onChange(fn) {
      listeners.add(fn);
      if (loaded) fn(reports);
      return () => listeners.delete(fn);
    },
    reload: load,
  };
}

export function summaryBadge(s) {
  if (!s) return null;
  if (s.stale > 0) return h("span", { class: "badge tone-critical" }, icon("replace"), "Outdated");
  if (s.possibly_stale > 0) return h("span", { class: "badge tone-warning" }, icon("replace"), "Possibly outdated");
  if (s.at_risk > s.checked) return h("span", { class: "badge tone-warning" }, icon("alert"), "At risk");
  if (s.checked > 0 && s.verdicts.current === s.checked) return s.weak_current ? h("span", { class: "badge tone-neutral" }, icon("check"), "Likely current") : h("span", { class: "badge tone-good" }, icon("check"), "Current");
  if (s.time_sensitive === 0) return h("span", { class: "badge tone-neutral" }, icon("dot"), "Static");
  if (s.checked > 0 && s.verdicts.unverifiable === s.checked) return h("span", { class: "badge tone-neutral" }, icon("question"), "Unverifiable");
  return h("span", { class: "badge tone-neutral" }, icon("question"), "Mixed");
}

const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const sameDay = (ms) => localDay(ms) === localDay(Date.now());
