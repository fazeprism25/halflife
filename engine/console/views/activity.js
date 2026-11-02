// ChatGPT activity: answers checked from ChatGPT with the Halflife extension, newest first,
// with a compact detail for the selected check and a link to its full verification (Inspector).
import { ago, api, claimState, clear, h, icon, plural, stamp, stateBadge } from "../lib.js";
import { assessmentBadge, confirmButton, figure, pageHead, SCORE_HELP, scoreText, short } from "./ext-common.js";

export function renderActivity(root, { params, onEngineEvent }) {
  let checks = [];
  let selected = params[0] ?? null;
  let filter = "all";
  let disposed = false;
  const list = h("div", { class: "act-list", role: "list" });
  const detail = h("section", { class: "act-detail", "aria-live": "polite" });
  const count = h("span", { class: "muted mono head-meta" });
  const seg = h("div", { class: "segmented", role: "group", "aria-label": "Filter" },
    [["all", "All"], ["attention", "Needs attention"], ["current", "Current"]].map(([k, l]) =>
      h("button", { type: "button", "aria-pressed": String(k === filter), onclick: (e) => {
        filter = k;
        for (const b of seg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        renderList();
      } }, l)));
  root.append(
    pageHead("ChatGPT activity", "Answers you checked from ChatGPT with the Halflife extension.", count, seg),
    h("div", { class: "page-body" }, h("div", { class: "act-grid" }, list, detail)),
  );

  async function load() {
    try {
      const r = await api("/v1/extension/activity?limit=200");
      if (disposed) return;
      checks = r.checks;
      count.textContent = checks.length >= 200 ? "latest 200" : plural(checks.length, "check");
      renderList();
      if (!selected && checks[0]) select(checks[0].id, false);
      else if (selected) renderDetail();
      if (!checks.length) renderEmpty();
    } catch (e) {
      if (e.status !== 401) clear(list).append(h("p", { class: "error pad-s" }, `Could not load activity: ${e.message}`));
    }
  }

  const visible = () => checks.filter((c) =>
    filter === "all" ? true
      : filter === "current" ? c.assessment === "current"
        : ["outdated", "possibly_outdated", "unverified"].includes(c.assessment) || c.status === "failed");

  function renderList() {
    clear(list);
    const rows = visible();
    if (!rows.length) {
      list.append(h("div", { class: "feed-empty" }, checks.length ? "No checks match this filter." : "No checks yet."));
      return;
    }
    for (const c of rows) {
      const s = c.summary;
      list.append(h("button", { class: "act-row", role: "listitem", "aria-current": String(c.id === selected), onclick: () => select(c.id) },
        h("div", { class: "act-row-top" }, assessmentBadge(c.assessment, c.status), h("time", { class: "muted mono", datetime: new Date(c.created_at).toISOString(), title: stamp(c.created_at) }, ago(c.created_at))),
        h("div", { class: "act-q" }, c.question ? short(c.question, 140) : h("span", { class: "muted" }, "No question captured")),
        h("div", { class: "act-a" }, short(c.answer, 160)),
        s && c.status === "done" ? h("div", { class: "act-meta" },
          h("span", {}, plural(s.claims, "claim")),
          h("span", { title: "Potentially outdated: time-sensitive claims whose estimated P(outdated) reached the verify threshold" }, `${c.at_risk} at risk`),
          s.stale ? h("span", { class: "ink-critical" }, `${s.stale} outdated`) : null,
          h("span", { title: SCORE_HELP }, `score ${scoreText(s)}`)) : null));
    }
  }

  function renderEmpty() {
    clear(detail).append(h("div", { class: "empty" },
      h("h2", {}, "No ChatGPT checks yet"),
      h("p", {}, "Install the Halflife extension, pair it with this console, then click ", h("b", {}, "Check freshness"), " under any ChatGPT answer. Only answers you choose are sent here."),
      h("a", { class: "btn", href: "#/extension" }, "Set up the extension", icon("arrow"))));
  }

  function select(id, push = true) {
    selected = id;
    if (push) history.replaceState(null, "", `#/activity/${id}`);
    for (const el of list.children) el.setAttribute("aria-current", String(el === list.children[visible().findIndex((c) => c.id === id)]));
    renderDetail();
  }

  async function renderDetail() {
    const c = checks.find((x) => x.id === selected);
    if (!c) {
      if (checks.length) clear(detail).append(h("p", { class: "muted" }, "This check no longer exists. It may have been deleted or passed its retention period."));
      return;
    }
    let report = null;
    try {
      report = await api(`/v1/reports/${c.id}`);
    } catch (e) {
      if (e.status === 401) return;
    }
    if (disposed || selected !== c.id) return;
    const s = c.summary;
    const done = c.status === "done" && s;
    const meta = c.meta ?? {};
    clear(detail).append(
      h("div", { class: "act-detail-head" },
        assessmentBadge(c.assessment, c.status),
        h("span", { class: "muted mono" }, stamp(c.created_at)),
        meta.model ? h("span", { class: "tag" }, meta.model) : null,
        s?.assess_only ? h("span", { class: "tag", title: "Live verification was off: claims were estimated, not searched" }, "estimate only") : null),
      done ? h("p", { class: "act-headline" }, s.headline) : c.status === "failed" ? h("p", { class: "error" }, c.error ?? "Analysis failed") : h("p", { class: "muted" }, "Halflife is still analysing this answer…"),
      done ? h("div", { class: "figures" },
        figure(scoreText(s), "freshness score", SCORE_HELP),
        figure(s.claims, "claims examined"),
        figure(c.at_risk, "potentially outdated", "Time-sensitive claims whose estimated P(outdated) reached the verify threshold"),
        figure((s.verdicts.superseded ?? 0) + (s.verdicts.contradicted ?? 0), "superseded or contradicted"),
        figure(s.checked, "checked live")) : null,
      h("div", { class: "section-label" }, "Question"),
      h("p", { class: "prompt" }, report?.prompt ?? (c.question || "No question captured (the message before this answer was not available).")),
      h("div", { class: "section-label" }, "Answer"),
      h("p", { class: "act-answer" }, short(report?.text ?? c.answer, 1200)),
      report?.claims?.length ? h("div", {},
        h("div", { class: "section-label" }, `Claims (${report.claims.length})`),
        h("ul", { class: "act-claims" }, report.claims.map((cl) => h("li", {},
          stateBadge(claimState(cl)),
          h("span", {}, cl.statement),
          cl.current_value ? h("span", { class: "secondary" }, ` Now: ${cl.current_value}`) : null)))) : null,
      h("div", { class: "row-actions" },
        h("a", { class: "btn", href: `#/inspector/${c.id}` }, "Open full verification", icon("arrow")),
        confirmButton("Delete this check", "Click again to delete", async () => {
          await api(`/v1/extension/reports/${c.id}`, { method: "DELETE" });
          selected = null;
          history.replaceState(null, "", "#/activity");
          await load();
        })),
    );
  }

  let t = 0;
  load();
  const off = onEngineEvent((e) => {
    if (e.type === "report" && e.source === "extension") {
      clearTimeout(t);
      t = setTimeout(load, 300);
    }
  });
  return () => {
    disposed = true;
    off();
    clearTimeout(t);
  };
}
