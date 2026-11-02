// Claim explorer: individual claims across answers checked from ChatGPT, with verdict, the
// model's freshness estimate, expected lifespan, quote-verified sources and, only when a
// verified quote states it (AD-20), the replacement value.
import { api, claimState, clear, date, fmtDuration, h, icon, plural, pctRange, stamp, stateBadge } from "../lib.js";
import { pageHead, short } from "./ext-common.js";

const VERDICTS = [["", "All"], ["outdated", "Outdated"], ["current", "Current"], ["unverifiable", "Unverifiable"], ["unchecked", "Not checked"], ["static", "Not time-sensitive"]];

export function renderClaims(root) {
  const state = { verdict: "", cls: "", q: "" };
  let disposed = false;
  let timer = 0;
  const results = h("div", { class: "claim-cards" });
  const count = h("span", { class: "muted mono head-meta" });
  const seg = h("div", { class: "segmented", role: "group", "aria-label": "Verdict" },
    VERDICTS.map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === state.verdict), onclick: (e) => {
      state.verdict = k;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      load();
    } }, l)));
  const classSel = h("select", { class: "input", "aria-label": "Information category", onchange: (e) => {
    state.cls = e.target.value;
    load();
  } }, h("option", { value: "" }, "All categories"));
  const search = h("input", { class: "input", type: "search", placeholder: "Search claims", "aria-label": "Search claims", oninput: (e) => {
    state.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  } });
  root.append(
    pageHead("Claim explorer", "Every claim Halflife extracted from answers you checked in ChatGPT.", count),
    h("div", { class: "page-body" }, h("div", { class: "pad" },
      h("div", { class: "filter-bar" }, seg, classSel, search),
      results)),
  );

  api("/v1/classes").then((r) => {
    for (const c of r.classes) classSel.append(h("option", { value: c.id }, c.label));
  }).catch(() => {});

  async function load() {
    const qs = new URLSearchParams({ limit: "200" });
    if (state.verdict) qs.set("verdict", state.verdict);
    if (state.cls) qs.set("class", state.cls);
    if (state.q) qs.set("q", state.q);
    try {
      const r = await api(`/v1/extension/claims?${qs}`);
      if (disposed) return;
      count.textContent = r.claims.length >= 200 ? "first 200" : plural(r.claims.length, "claim");
      render(r.claims);
    } catch (e) {
      if (e.status !== 401) clear(results).append(h("p", { class: "error" }, `Could not load claims: ${e.message}`));
    }
  }

  function render(claims) {
    clear(results);
    if (!claims.length) {
      const filtered = state.verdict || state.cls || state.q;
      results.append(h("div", { class: "empty" },
        h("h2", {}, filtered ? "No claims match" : "No claims yet"),
        h("p", {}, filtered ? "Try a different verdict, category or search." : "Claims appear here after you check an answer from ChatGPT with the Halflife extension.")));
      return;
    }
    for (const c of claims) results.append(card(c));
  }

  function card(c) {
    const st = claimState(c);
    const replaced = c.current_value && (c.verdict === "superseded" || c.verdict === "contradicted");
    return h("article", { class: `claim-card tone-edge-${st.tone}` },
      h("div", { class: "claim-card-head" },
        stateBadge(st),
        h("span", { class: "tag" }, c.class.label),
        c.reused_from ? h("span", { class: "tag", title: "Verdict reused from an earlier check of the same claim within its reuse window" }, "reused") : null,
        h("time", { class: "muted mono", title: stamp(c.report_created_at) }, date(c.report_created_at))),
      h("p", { class: "claim-card-text" }, c.statement),
      replaced ? h("p", { class: "claim-card-now" }, icon("replace"), " Now: ", h("strong", {}, c.current_value), c.changed_on ? h("span", { class: "muted" }, ` (changed ${c.changed_on})`) : null) : null,
      h("dl", { class: "kv kv-tight" },
        c.time_sensitive ? [
          h("dt", {}, "Expected lifespan"), h("dd", {}, `half-life ~${fmtDuration(c.half_life_years.median)}`, h("span", { class: "muted" }, ` (${fmtDuration(c.half_life_years.lo)}–${fmtDuration(c.half_life_years.hi)})`)),
          h("dt", {}, "P(outdated)"), h("dd", {}, pctRange(c.p_outdated.lo, c.p_outdated.hi), h("span", { class: "muted" }, " model estimate, uncalibrated")),
        ] : [h("dt", {}, "Lifespan"), h("dd", {}, "Not time-sensitive: not checked against live sources")],
        c.verified_at ? [h("dt", {}, "Checked"), h("dd", {}, stamp(c.verified_at), c.evidence_level ? h("span", { class: "muted" }, c.evidence_level === "none" ? " · no usable evidence" : ` · ${c.evidence_level} evidence`) : null)] : null,
        c.limitation ? [h("dt", {}, "Not checked"), h("dd", { class: "secondary" }, c.limitation.message)] : null,
        c.question ? [h("dt", {}, "Asked"), h("dd", { class: "secondary" }, short(c.question, 160))] : null),
      c.sources.length ? h("div", { class: "sources" },
        h("div", { class: "section-label" }, `Sources (${c.sources.length}, quote verified)`),
        h("ul", {}, c.sources.map((s) => h("li", {},
          /^https?:\/\//i.test(s.url) ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.site || s.url) : h("span", {}, s.site || s.url),
          s.published_at ? h("span", { class: "muted mono" }, ` ${date(s.published_at)}`) : null,
          h("span", { class: `badge tone-${s.stance === "refutes" ? "critical" : "good"}` }, s.stance === "refutes" ? "refutes" : "supports"),
          s.quote ? h("blockquote", {}, `“${short(s.quote, 240)}”`) : null)))) : null,
      h("div", { class: "row-actions" },
        h("a", { class: "btn-ghost btn-small", href: `#/activity/${c.report_id}` }, "Checked answer"),
        h("a", { class: "btn-ghost btn-small", href: `#/inspector/${c.report_id}` }, "Full verification", icon("arrow"))));
  }

  load();
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
