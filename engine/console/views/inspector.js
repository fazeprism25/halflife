// Inspector: live report feed, the answer with claims highlighted in place, and a claim panel
// that keeps the three measurements separate: A lifespan, B P(outdated), C evidence confidence.
import {
  ago, api, claimState, clear, copyButton, date, fmtDuration, h, icon, levelMeter, pct, pctRange, plural,
  probabilityBar, stamp, stateBadge, time, tooltip,
} from "../lib.js";

const STAGES = { extract: "Extracting claims", assess: "Estimating freshness", verify: "Verifying against live sources" };

export function renderInspector(root, { params, onEngineEvent }) {
  let reports = [];
  let selectedId = params[0] ?? null;
  let selectedClaim = null;
  let current = null;
  let disposed = false;

  // ---- Traffic drawer: an overlay over the workspace, closed by default (not a permanent column).
  // Open: the rest of the console is inert, so focus stays in the drawer. Close: button, Escape,
  // or a click on the scrim; focus returns to the toggle.
  let drawerOpen = false;
  let listLoaded = false;
  let seenTopId = null;
  const feedList = h("div", { class: "feed-list", role: "list", onkeydown: onFeedKey });
  const feedCount = h("span", { class: "muted mono", style: { fontSize: "11px" } });
  const detail = h("section", { class: "detail", "aria-live": "polite" });
  const toggleCount = h("span", { class: "drawer-toggle-count" });
  const newNote = h("span", { class: "sr-only" });
  const toggle = h("button", { class: "btn-ghost drawer-toggle", type: "button", "aria-expanded": "false", "aria-controls": "traffic-drawer", "aria-keyshortcuts": "t", title: "Show traffic (T)", onclick: () => setDrawer(!drawerOpen) },
    icon("panel"), h("span", {}, "Traffic"), toggleCount, h("span", { class: "new-dot", "aria-hidden": "true" }), newNote);
  const position = h("span", { class: "bar-position mono muted" });
  const newer = h("button", { class: "btn-ghost btn-small", type: "button", "aria-label": "Newer report", title: "Newer report", onclick: () => step(-1) }, icon("chevron-up"));
  const older = h("button", { class: "btn-ghost btn-small", type: "button", "aria-label": "Older report", title: "Older report", onclick: () => step(1) }, icon("chevron-down"));
  const bar = h("div", { class: "inspector-bar" }, toggle, h("span", { class: "bar-nav" }, position, newer, older));
  const drawer = h("aside", { class: "feed drawer", id: "traffic-drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "traffic-title", "data-open": "false" },
    h("div", { class: "feed-head" },
      h("strong", { id: "traffic-title", style: { fontSize: "13px" } }, "Traffic"),
      h("span", { class: "feed-head-end" }, feedCount,
        h("button", { class: "icon-btn", type: "button", "aria-label": "Close traffic", title: "Close (Esc)", onclick: () => setDrawer(false) }, icon("cross")))),
    feedList);
  const scrim = h("div", { class: "drawer-scrim", "data-open": "false", "aria-hidden": "true", onclick: () => setDrawer(false) });
  root.append(h("div", { class: "inspector" }, bar, detail, scrim, drawer));

  const rail = document.querySelector(".rail");
  function setDrawer(open) {
    if (open === drawerOpen) return;
    drawerOpen = open;
    drawer.dataset.open = scrim.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    for (const el of [bar, detail, rail]) el?.toggleAttribute("inert", open);
    document.documentElement.classList.toggle("drawer-open", open);
    if (open) {
      tip.hide();
      seenTopId = reports[0]?.id ?? null;
      updateBar();
      const target = feedList.querySelector('.feed-item[aria-current="true"]') ?? feedList.querySelector(".feed-item") ?? drawer.querySelector(".icon-btn");
      target.focus();
      target.scrollIntoView?.({ block: "nearest" });
    } else {
      toggle.focus();
    }
  }
  function onDocKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape" && drawerOpen) {
      e.preventDefault();
      setDrawer(false);
    } else if ((e.key === "t" || e.key === "T") && !drawerOpen && !e.target.closest?.("input, textarea, select, [contenteditable]")) {
      e.preventDefault();
      setDrawer(true);
    }
  }
  document.addEventListener("keydown", onDocKey);
  function onFeedKey(e) {
    const items = [...feedList.querySelectorAll(".feed-item")];
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined || !items.length) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, to))].focus();
  }
  function step(delta) {
    const i = reports.findIndex((r) => r.id === selectedId);
    const next = reports[i + delta];
    if (i >= 0 && next) select(next.id);
  }
  function updateBar() {
    const n = reports.length;
    const i = reports.findIndex((r) => r.id === selectedId);
    toggleCount.textContent = n ? (n >= 100 ? "100" : String(n)) : "";
    const fresh = !drawerOpen && listLoaded && reports[0] && reports[0].id !== seenTopId;
    toggle.dataset.new = String(Boolean(fresh));
    newNote.textContent = fresh ? ", new reports" : "";
    position.textContent = i >= 0 ? `${i + 1} of ${n >= 100 ? "latest 100" : n}` : "";
    newer.disabled = !(i > 0);
    older.disabled = !(i >= 0 && i < n - 1);
  }

  async function loadList() {
    try {
      const r = await api("/v1/reports?limit=100");
      if (disposed) return;
      reports = r.reports;
      if (!listLoaded) seenTopId = reports[0]?.id ?? null;
      listLoaded = true;
      renderFeed();
      updateBar();
      if (!selectedId && reports[0]) select(reports[0].id, false);
      if (!reports.length) renderEmpty();
    } catch (e) {
      if (e.status !== 401) clear(feedList).append(h("div", { class: "feed-empty error" }, `Could not load reports: ${e.message}`));
    }
  }

  function renderFeed() {
    feedCount.textContent = reports.length ? (reports.length >= 100 ? "latest 100" : plural(reports.length, "report")) : "";
    clear(feedList);
    if (!reports.length) {
      feedList.append(h("div", { class: "feed-empty" }, "No traffic yet. Answers that pass through the gateway appear here as they arrive."));
      return;
    }
    for (const r of reports) feedList.append(feedItem(r));
  }

  function feedItem(r) {
    const s = r.summary;
    const risk = r.max_p ?? 0;
    let headline;
    if (r.status === "linked") headline = [icon("link"), "Cache hit · analysis reused"];
    else if (r.status === "failed") headline = [h("span", { class: "badge tone-critical" }, icon("cross"), "Analysis failed")];
    else if (r.status !== "done") headline = [h("span", { class: "muted" }, STAGES[r.stage] ?? "Queued", "…")];
    else headline = [summaryBadge(s), h("span", {}, s?.headline ?? "")];
    return h("button", { class: "feed-item", role: "listitem", "aria-current": String(r.id === selectedId), onclick: () => { select(r.id); setDrawer(false); } },
      h("span", { class: "meta" }, h("span", { class: "mono", title: stamp(r.created_at) }, sameDay(r.created_at) ? time(r.created_at) : `${localDay(r.created_at)} ${time(r.created_at)}`), h("span", { class: "tag" }, r.source), r.model ? h("span", {}, r.model) : null, r.cache_hit ? h("span", { class: "tag" }, "hit") : null),
      h("span", { class: "risk-tick", title: `Highest P(outdated) among its claims: ${pct(risk)}` }, h("i", { style: { width: `${Math.round(risk * 100)}%` } })),
      h("span", { class: "preview" }, r.preview ?? ""),
      h("span", { class: "headline" }, headline),
    );
  }

  async function select(id, push = true) {
    selectedId = id;
    selectedClaim = null;
    if (push) history.replaceState(null, "", `#/inspector/${id}`);
    updateBar();
    for (const el of feedList.children) el.setAttribute("aria-current", String(el === feedList.children[reports.findIndex((r) => r.id === id)]));
    await loadDetail();
  }

  async function loadDetail() {
    if (!selectedId) return;
    try {
      const r = await api(`/v1/reports/${selectedId}`);
      if (disposed || r.id !== selectedId) return;
      let original = null;
      if (r.linked_report_id) original = await api(`/v1/reports/${r.linked_report_id}`).catch(() => null);
      current = { r, original };
      renderDetail();
    } catch (e) {
      clear(detail).append(h("div", { class: "empty" }, h("h2", {}, "Report unavailable"), h("p", {}, e.message)));
    }
  }

  function renderEmpty() {
    clear(detail).append(
      h("div", { class: "empty" },
        h("h2", {}, "Waiting for traffic"),
        h("p", {}, "Send any chat completion through the Bifrost gateway. Halflife captures the answer, estimates how likely each factual claim is to be outdated, and verifies the risky ones against live sources."),
        h("pre", { class: "code" }, `curl http://localhost:8080/v1/chat/completions \\
  -H "content-type: application/json" \\
  -H "x-bf-vk: $HALFLIFE_DEMO_VK" \\
  -d '{"model":"deepseek/deepseek-flash","messages":[{"role":"user","content":"Who is the CEO of Twitter?"}]}'`),
        h("p", {}, "Or use ", h("a", { href: "#/check" }, "Check"), " to send a prompt or paste an answer."),
      ),
    );
  }

  function renderDetail() {
    const { r, original } = current;
    const a = original ?? r; // analysis source (cache hits reuse the original's analysis)
    const claims = a.claims ?? [];
    if (!selectedClaim || !claims.find((c) => c.id === selectedClaim)) selectedClaim = defaultClaim(claims)?.id ?? null;
    const claimCol = h("aside", { class: "claim-col", "aria-label": "Claim detail" });
    const answerCol = h("div", { class: "answer-col" });

    // ---- identity line
    answerCol.append(
      h("div", { class: "report-id" },
        h("span", { class: "mono" }, r.id), copyButton(r.id, "Copy ID"),
        h("span", {}, stamp(r.created_at)),
        h("span", { class: "tag" }, r.source), r.model ? h("span", { class: "tag" }, r.model) : null,
        r.stream ? h("span", { class: "tag" }, "stream") : null, h("span", { class: "tag" }, `mode ${r.mode}`)),
    );
    const s = a.summary;
    if (a.status === "done") {
      answerCol.append(h("h2", { class: "report-title" }, summaryBadge(s), s.headline));
      answerCol.append(figures(a, s));
    } else if (a.status === "failed") {
      answerCol.append(h("h2", { class: "report-title" }, h("span", { class: "badge tone-critical" }, icon("cross"), "Failed"), "Analysis failed"), h("div", { class: "notice" }, icon("alert"), a.error ?? "unknown error"));
    } else {
      answerCol.append(h("h2", { class: "report-title" }, h("span", { class: "muted" }, `${STAGES[a.stage] ?? "Queued for analysis"}…`)));
    }
    // ---- notices: everything that limits what this report can claim
    if (original) answerCol.append(h("div", { class: "notice" }, icon("link"), h("span", {}, "Served from Bifrost's cache. The analysis below is from the original answer, ", h("a", { href: `#/inspector/${original.id}` }, original.id), " — no new model or search calls were made.")));
    if (a.extraction === "heuristic") answerCol.append(h("div", { class: "notice" }, icon("alert"), h("span", {}, h("b", {}, "Rule-based extraction. "), a.extraction_note ?? "")));
    if (s && !s.providers?.search && s.at_risk > 0) answerCol.append(h("div", { class: "notice" }, icon("alert"), h("span", {}, h("b", {}, "Not verified. "), "Live search is not configured, so at-risk claims were assessed but not checked against current sources.")));
    if (a.truncated) answerCol.append(h("div", { class: "notice" }, icon("alert"), "The answer exceeded the capture limit and was truncated before analysis."));

    if (r.prompt) answerCol.append(h("div", { class: "section-label" }, "Prompt"), h("p", { class: "prompt" }, r.prompt));
    answerCol.append(h("div", { class: "section-label" }, "Answer"), answerText(a.text, claims));
    if (claims.length) answerCol.append(h("div", { class: "section-label" }, "Claims"), claimsTable(claims));
    answerCol.append(cacheSection(r, a));

    const grid = h("div", { class: "detail-grid" }, answerCol, claimCol);
    clear(detail).append(grid);
    renderClaim(claimCol, claims, a);
  }

  function answerText(text, claims) {
    const out = h("div", { class: "answer" });
    let at = 0;
    const sorted = [...claims].sort((x, y) => x.span[0] - y.span[0]);
    sorted.forEach((c) => {
      const [s, e] = c.span;
      if (s < at) return; // overlapping spans: keep the first
      if (s > at) out.append(text.slice(at, s));
      const st = claimState(c);
      const span = h("span", {
        class: `claim-span tone-${st.tone}`, role: "button", tabindex: "0", "aria-selected": String(c.id === selectedClaim),
        "aria-label": `Claim ${c.idx + 1}: ${st.label}`,
        onclick: () => pick(c.id), onkeydown: (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), pick(c.id)),
      }, text.slice(s, e), h("span", { class: "claim-n" }, String(c.idx + 1)));
      out.append(span);
      at = e;
    });
    if (at < text.length) out.append(text.slice(at));
    return out;
  }

  function claimsTable(claims) {
    return h("ol", { class: "claim-list" }, claims.map((c) =>
      h("li", {}, h("button", { class: "claim-row", type: "button", "aria-selected": String(c.id === selectedClaim), onclick: () => pick(c.id) },
        h("span", { class: "n" }, String(c.idx + 1)),
        h("span", { class: "stmt" }, c.statement),
        h("span", { class: "row-meta" },
          stateBadge(claimState(c)),
          h("span", {}, c.class.label),
          c.time_sensitive ? h("span", {}, "P(outdated) ", h("span", { class: "mono" }, pctRange(c.p_outdated.lo, c.p_outdated.hi))) : null,
          c.evidence_level ? h("span", {}, "evidence ", c.evidence_level) : null)))));
  }

  function cacheSection(r, a) {
    const actions = r.cache.actions ?? [];
    return h("div", {},
      h("div", { class: "section-label" }, "Gateway & cache"),
      h("dl", { class: "kv" },
        h("dt", {}, "Plugin triage"), h("dd", {}, (r.triage_groups ?? []).length ? r.triage_groups.map((g) => h("span", { class: "tag", style: { marginRight: "4px" } }, g)) : h("span", { class: "muted" }, r.source === "gateway" ? "no lexical cues" : "not via gateway")),
        h("dt", {}, "Cache TTL set"), h("dd", { class: "mono" }, r.cache.ttl_set ?? "—"),
        h("dt", {}, "Cache entry"), h("dd", { class: "mono" }, r.cache.id ? `${r.cache.id}${r.cache.hit ? " (hit)" : ""}` : "—"),
        h("dt", {}, "Cache actions"), h("dd", {}, actions.length ? actions.map((x) => h("div", {}, h("span", { class: "tag" }, x.action.replace(/_/g, " ")), " ", h("span", { class: x.status === "failed" ? "error" : "secondary" }, x.status === "pending" ? `scheduled for ${date(x.due_at)} ${time(x.due_at)}` : `${x.status} ${x.done_at ? ago(x.done_at) : ""}`), x.reason ? h("div", { class: "muted", style: { fontSize: "12px" } }, x.reason) : null, x.result ? h("div", { class: "muted mono", style: { fontSize: "11px" } }, x.result) : null)) : h("span", { class: "muted" }, "none")),
        h("dt", {}, "Spend"), h("dd", { class: "mono" }, `${a.credits ?? 0} Tavily credit${a.credits === 1 ? "" : "s"} · ${a.llm_calls ?? 0} LLM call${a.llm_calls === 1 ? "" : "s"}${a.summary?.tokens ? ` · ${a.summary.tokens.toLocaleString()} tokens` : ""}`, r.linked_report_id ? h("div", { class: "muted", style: { fontSize: "12px", fontFamily: "inherit" } }, "Spent by the original report; this cache hit cost nothing.") : null),
        h("dt", {}, "Analysis time"), h("dd", { class: "mono" }, a.summary?.timing ? `extract ${(a.summary.timing.extract_ms / 1000).toFixed(1)}s · verify ${(a.summary.timing.verify_ms / 1000).toFixed(1)}s` : "—"),
      ),
    );
  }

  function pick(id) {
    selectedClaim = id;
    renderDetail();
  }

  // ---------------------------------------------------------------- claim panel

  function renderClaim(col, claims, a) {
    const c = claims.find((x) => x.id === selectedClaim);
    if (!c) {
      col.append(h("p", { class: "muted" }, claims.length ? "Select a claim." : a.status === "done" ? "No factual claims were found in this answer." : "Claims appear here once extraction finishes."));
      return;
    }
    const st = claimState(c);
    col.append(
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        h("span", { class: "muted", style: { fontSize: "12px" } }, `Claim ${c.idx + 1} of ${claims.length}`), stateBadge(st)),
      h("div", { class: "claim-head" }, c.statement),
      h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "6px" } }, h("span", { class: "tag" }, c.class.label), c.subject ? h("span", { class: "tag" }, c.subject) : null),
    );

    // Verdict
    if (c.verdict) {
      col.append(h("div", { class: "verdict-box" },
        c.current_value ? h("p", {}, h("span", { class: "muted" }, "Now: "), h("b", {}, c.current_value), c.changed_on ? h("span", { class: "muted" }, ` · changed ${c.changed_on}`) : null) : null,
        !c.current_value && omittedValue(c) ? h("p", { class: "muted", style: { fontSize: "12px" } }, "New value not shown: no verified quote states it.", c.changed_on ? ` Changed ${c.changed_on} (per the judge).` : "") : null,
        weakVerdictNote(c),
        c.explanation ? h("p", { class: "secondary" }, c.explanation) : null,
        c.reused_from ? h("p", { class: "muted", style: { fontSize: "12px" } }, `Reused a verification from ${date(c.verified_at)} (within its reuse window; no new search).`) : null,
      ));
    }
    if (c.limitation) col.append(h("div", { class: "notice" }, icon("alert"), c.limitation.message));
    else if (!c.verdict && c.time_sensitive) col.append(h("div", { class: "notice" }, icon("dot"), triageText(c, a)));

    if (c.time_sensitive) col.append(h("div", { class: "measure" }, h("div", { class: "measure-head" }, h("span", { class: "measure-key" }, "Timeline")), timeline(c)));

    // A — expected lifespan of the class
    const hl = c.half_life_years;
    col.append(h("div", { class: "measure" },
      h("div", { class: "measure-head" }, h("span", { class: "measure-key" }, "A · Expected lifespan"), h("a", { href: `#/model/${encodeURIComponent(c.class.id)}`, style: { fontSize: "12px" } }, "class model")),
      c.class.static ? h("div", { class: "measure-value" }, "Does not expire") : h("div", { class: "measure-value" }, `Half-life ${fmtDuration(hl.median)}`),
      c.class.static ? null : h("p", { class: "measure-note" }, `90% interval ${fmtDuration(hl.lo)} – ${fmtDuration(hl.hi)} for "${c.class.label}" claims. A property of the claim class, from its change-rate prior updated by verified outcomes.`),
    ));

    // B — probability outdated now
    if (c.time_sensitive) {
      col.append(h("div", { class: "measure" },
        h("div", { class: "measure-head" }, h("span", { class: "measure-key" }, "B · P(outdated now)"), h("span", { class: "tag" }, "estimated · uncalibrated")),
        h("div", { class: "measure-value" }, pctRange(c.p_outdated.lo, c.p_outdated.hi)),
        probabilityBar(c.p_outdated.lo, c.p_outdated.hi, a.summary?.theta),
        h("p", { class: "measure-note" }, `Clock starts at the claim's as-of date — ${c.as_of.label}`, c.as_of.source ? h("span", { class: "muted" }, ` (${c.as_of.source})`) : null, `. The range reflects uncertainty in that date. The marker is the verification threshold (${pct(a.summary?.theta ?? 0.2)}).`),
      ));
    }

    // C — confidence in the evidence
    col.append(h("div", { class: "measure" },
      h("div", { class: "measure-head" }, h("span", { class: "measure-key" }, "C · Evidence confidence")),
      h("div", { style: { margin: "8px 0 2px" } }, levelMeter(c.evidence_level)),
      c.level_reasons?.length ? h("ul", { class: "reasons" }, c.level_reasons.map((x) => h("li", {}, x))) : h("p", { class: "measure-note" }, c.verdict ? "" : "No verdict was made, so there is no evidence to rate."),
    ));

    // Evidence
    if (c.evidence?.length) {
      col.append(h("div", { class: "measure" },
        h("div", { class: "measure-head" }, h("span", { class: "measure-key" }, `Sources (${c.evidence.length})`), h("span", { class: "muted", style: { fontSize: "12px" } }, (c.tiers ?? []).join(" · "))),
        h("div", { class: "evidence", style: { marginTop: "10px" } }, c.evidence.map(evidenceCard)),
      ));
    }
    if (c.search_query && c.time_sensitive) col.append(h("p", { class: "muted", style: { fontSize: "12px" } }, "Search query: ", h("span", { class: "mono" }, c.search_query)));
  }

  function evidenceCard(e) {
    return h("article", { class: "ev" },
      h("div", { class: "ev-head" }, h("span", { class: "ev-site" }, e.site || e.domain), h("span", { class: "mono", title: "Publication date as reported by Tavily. It can be wrong for evergreen or SEO pages." }, e.published_at ? date(e.published_at) : "undated"), h("span", { class: "tag" }, e.tier)),
      h("a", { class: "ev-title", href: e.url, target: "_blank", rel: "noopener noreferrer" }, e.title || e.url, " ", icon("link")),
      e.quote ? h("blockquote", { class: `ev-quote ${e.stance ?? ""}` }, `“${e.quote}”`) : null,
      e.quote ? h("span", { class: `ev-check ${e.quote_valid ? "ok" : "bad"}` }, icon(e.quote_valid ? "check" : "cross"), e.quote_valid ? `Quote found in source · ${e.stance === "supports" ? "supports" : "refutes"} the claim` : "Quote not found in source · ignored") : h("p", { class: "ev-snippet" }, e.content),
    );
  }

  const tip = tooltip();
  function timeline(c) {
    const W = 372, H = 104, L = 8, R = 8;
    const now = Date.now();
    const evDates = (c.evidence ?? []).map((e) => e.published_at).filter(Boolean);
    const changed = c.changed_on ? Date.parse(c.changed_on.length === 4 ? `${c.changed_on}-07-01` : c.changed_on.length === 7 ? `${c.changed_on}-15` : c.changed_on) : null;
    let lo = Math.min(c.as_of.lo, ...evDates, ...(changed ? [changed] : []));
    let hi = now;
    const pad = (hi - lo) * 0.06 || 864e5 * 30;
    lo -= pad;
    hi += pad * 0.6;
    const x = (t) => L + ((t - lo) / (hi - lo)) * (W - L - R);
    const g = h("svg", { class: "timeline", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Timeline from ${date(c.as_of.lo)} to today` });
    // year ticks
    const y0 = new Date(lo).getUTCFullYear();
    const y1 = new Date(hi).getUTCFullYear();
    const step = Math.max(1, Math.ceil((y1 - y0 + 1) / 6));
    for (let y = y0; y <= y1; y += step) {
      const t = Date.UTC(y, 0, 1);
      if (t < lo || t > hi) continue;
      g.append(h("line", { class: "tl-tick", x1: x(t), x2: x(t), y1: 80, y2: 84 }), h("text", { class: "tl-label", x: x(t), y: 97, "text-anchor": "middle" }, String(y)));
    }
    g.append(h("line", { class: "tl-axis", x1: L, x2: W - R, y1: 80, y2: 80 }));
    // as-of band
    const ax = x(c.as_of.lo), aw = Math.max(3, x(c.as_of.hi) - ax);
    g.append(h("rect", { class: "tl-asof", x: ax, y: 18, width: aw, height: 10, rx: 2 }), h("text", { class: "tl-text", x: Math.min(ax, W - 90), y: 12 }, c.as_of.kind === "verified" ? "last verified" : c.as_of.kind === "explicit" ? "stated as-of" : "model knowledge"));
    hover(g.lastChild.previousSibling, `<b>As-of</b><br>${esc(c.as_of.label)}<br>${date(c.as_of.lo)} → ${date(c.as_of.hi)}`);
    // change
    if (changed && Number.isFinite(changed)) {
      g.append(h("line", { class: "tl-change", x1: x(changed), x2: x(changed), y1: 34, y2: 80 }), h("text", { class: "tl-text", x: x(changed) + 4, y: 42 }, `changed ${c.changed_on}`));
    }
    // evidence
    for (const e of c.evidence ?? []) {
      if (!e.published_at) continue;
      const dot = h("circle", { class: `tl-ev ${e.quote_valid ? e.stance : "none"}`, cx: x(e.published_at), cy: 62, r: 5 });
      g.append(dot);
      hover(dot, `<b>${esc(e.site)}</b> · ${date(e.published_at)}<br>${e.quote ? esc(`“${e.quote}”`) : esc((e.content ?? "").slice(0, 140))}`);
    }
    // verified + now
    if (c.verified_at) {
      const v = h("rect", { class: "tl-verified", x: x(c.verified_at) - 4, y: 58, width: 8, height: 8, transform: `rotate(45 ${x(c.verified_at)} 62)` });
      g.append(v);
      hover(v, `<b>Checked by Halflife</b><br>${date(c.verified_at)} ${time(c.verified_at)}`);
    }
    g.append(h("line", { class: "tl-now", x1: x(now), x2: x(now), y1: 14, y2: 84 }), h("text", { class: "tl-text", x: x(now) - 4, y: 10, "text-anchor": "end" }, "now"));
    const legend = h("div", { class: "legend", style: { flexWrap: "wrap", gap: "12px" } },
      h("span", {}, h("svg", { width: 10, height: 10, viewBox: "0 0 10 10" }, h("circle", { class: "tl-ev supports", cx: 5, cy: 5, r: 4 })), " supports"),
      h("span", {}, h("svg", { width: 10, height: 10, viewBox: "0 0 10 10" }, h("circle", { class: "tl-ev refutes", cx: 5, cy: 5, r: 4 })), " refutes"),
      h("span", {}, h("svg", { width: 10, height: 10, viewBox: "0 0 10 10" }, h("circle", { class: "tl-ev none", cx: 5, cy: 5, r: 4 })), " not cited"),
      h("span", { class: "muted" }, (c.evidence ?? []).filter((e) => !e.published_at).length ? `${(c.evidence ?? []).filter((e) => !e.published_at).length} undated not shown` : ""),
    );
    return h("div", {}, g, legend);
  }

  function hover(el, html) {
    el.addEventListener("pointermove", (ev) => {
      const d = h("div", { html });
      tip.show(d, ev.clientX, ev.clientY);
    });
    el.addEventListener("pointerleave", () => tip.hide());
  }

  // ---------------------------------------------------------------- live updates
  let pending = null;
  const off = onEngineEvent((e) => {
    if (e.type === "status") return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      loadList();
      const rid = e.type === "report" ? e.id : e.report_id;
      if (rid === selectedId || rid === current?.r?.linked_report_id) loadDetail();
    }, 250);
  });

  loadList().then(() => selectedId && loadDetail());
  return () => {
    disposed = true;
    off();
    document.removeEventListener("keydown", onDocKey);
    rail?.removeAttribute("inert");
    document.documentElement.classList.remove("drawer-open");
    tip.hide();
    clearTimeout(pending);
  };
}

function defaultClaim(claims) {
  const rank = (c) => (c.verdict === "superseded" || c.verdict === "contradicted" ? 3 : !c.verdict && c.time_sensitive && c.triage !== "low_risk" ? 2 : c.time_sensitive ? 1 : 0);
  return [...claims].sort((a, b) => rank(b) - rank(a) || b.p_outdated.hi - a.p_outdated.hi)[0];
}

function summaryBadge(s) {
  if (!s) return null;
  if (s.stale > 0) return h("span", { class: "badge tone-critical" }, icon("replace"), "Outdated");
  if (s.possibly_stale > 0) return h("span", { class: "badge tone-warning" }, icon("replace"), "Possibly outdated");
  if (s.at_risk > s.checked) return h("span", { class: "badge tone-warning" }, icon("alert"), "At risk");
  if (s.checked > 0 && s.verdicts.current === s.checked) return s.weak_current ? h("span", { class: "badge tone-neutral" }, icon("check"), "Likely current") : h("span", { class: "badge tone-good" }, icon("check"), "Current");
  if (s.time_sensitive === 0) return h("span", { class: "badge tone-neutral" }, icon("dot"), "Static");
  if (s.checked > 0 && s.verdicts.unverifiable === s.checked) return h("span", { class: "badge tone-neutral" }, icon("question"), "Unverifiable");
  return h("span", { class: "badge tone-neutral" }, icon("question"), "Mixed");
}

function figures(a, s) {
  const reused = (a.claims ?? []).filter((c) => c.reused_from).length;
  const f = (v, l) => h("div", { class: "figure" }, h("b", {}, String(v)), h("span", {}, l));
  return h("div", { class: "figures" },
    f(s.claims, "claims"), f(s.time_sensitive, "time-sensitive"), f(s.at_risk, `at risk (≥${pct(s.theta)})`),
    f(s.checked, reused ? `checked (${reused} reused, no new search)` : "checked live"), f(s.stale, "outdated"));
}

function triageText(c, a) {
  switch (c.triage) {
    case "low_risk": return `Not checked: estimated risk (${pctRange(c.p_outdated.lo, c.p_outdated.hi)}) is below the ${pct(a.summary?.theta ?? 0.2)} threshold.`;
    case "cap": return "Not checked: this answer had more at-risk claims than the per-response verification limit; riskier claims were checked first.";
    case "static": return "Not time-sensitive.";
    default: return a.status === "done" ? "Not checked." : "Verification pending…";
  }
}

const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const sameDay = (ms) => localDay(ms) === localDay(Date.now());
const omittedValue = (c) => (c.level_reasons ?? []).some((x) => /omitted: no verified quote states it/.test(x));
function weakVerdictNote(c) {
  if ((c.verdict !== "superseded" && c.verdict !== "contradicted") || ["moderate", "strong"].includes(c.evidence_level)) return null;
  return h("p", { class: "muted", style: { fontSize: "12px" } }, "Evidence is weak, so this claim is not counted as outdated and does not trigger cache invalidation.");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
