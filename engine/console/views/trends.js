// Trends for answers checked from ChatGPT: volume over time, outdated claims over time, which
// categories of information go out of date most, and verification outcomes. Real data only;
// an empty range says so instead of drawing empty axes.
import { api, clear, h, plural, tooltip } from "../lib.js";
import { pageHead } from "./ext-common.js";

const OUTCOMES = [
  ["current", "Current", "good"],
  ["superseded", "Superseded", "critical"],
  ["contradicted", "Contradicted", "serious"],
  ["unverifiable", "Unverifiable", "neutral"],
  ["not_checked", "Time-sensitive, not checked", "warning"],
];

export function renderTrends(root) {
  let days = 30;
  let disposed = false;
  const body = h("div", { class: "pad" });
  const seg = h("div", { class: "segmented", role: "group", "aria-label": "Range" },
    [7, 30, 90].map((d) => h("button", { type: "button", "aria-pressed": String(d === days), onclick: (e) => {
      days = d;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      load();
    } }, `${d} days`)));
  root.append(pageHead("Trends", "What the answers you checked from ChatGPT got wrong over time.", seg), h("div", { class: "page-body" }, body));
  const tip = tooltip();

  async function load() {
    try {
      const t = await api(`/v1/extension/trends?days=${days}`);
      if (!disposed) render(t);
    } catch (e) {
      if (e.status !== 401) clear(body).append(h("p", { class: "error" }, `Could not load trends: ${e.message}`));
    }
  }

  function render(t) {
    const total = t.series.reduce((a, d) => ({ responses: a.responses + d.responses, claims: a.claims + d.claims, at_risk: a.at_risk + d.at_risk, outdated: a.outdated + d.outdated }), { responses: 0, claims: 0, at_risk: 0, outdated: 0 });
    clear(body);
    if (!total.responses) {
      body.append(h("div", { class: "empty" }, h("h2", {}, `No checks in the last ${t.days} days`), h("p", {}, "Trends appear once you check answers from ChatGPT with the Halflife extension.")));
      return;
    }
    body.append(
      h("div", { class: "figures" },
        fig(total.responses, "answers checked"), fig(total.claims, "claims examined"),
        fig(total.at_risk, "potentially outdated"), fig(total.outdated, "outdated (≥ moderate evidence)")),
      h("div", { class: "trend-grid" },
        h("section", { class: "panel" }, h("h2", {}, "Answers checked per day"), h("p", {}, `${plural(total.responses, "answer")} in ${t.days} days (UTC days).`),
          bars(t.series, "responses", (d) => `${d.day}: ${plural(d.responses, "answer")} checked`, "ink")),
        h("section", { class: "panel" }, h("h2", {}, "Outdated claims per day"), h("p", {}, "Claims judged superseded or contradicted with at least moderate evidence."),
          total.outdated ? bars(t.series, "outdated", (d) => `${d.day}: ${plural(d.outdated, "outdated claim")} · ${d.at_risk} potentially outdated`, "critical") : h("p", { class: "muted chart-empty" }, "No outdated claims found in this range.")),
        h("section", { class: "panel" }, h("h2", {}, "Verification outcomes"), h("p", {}, `${plural(t.outcomes.claims, "claim")}; ${t.outcomes.not_time_sensitive} not time-sensitive are not shown.`),
          outcomes(t.outcomes)),
        h("section", { class: "panel" }, h("h2", {}, "Most often outdated categories"), h("p", {}, "Outdated claims (≥ moderate evidence) by information category."),
          t.classes.length ? classBars(t.classes) : h("p", { class: "muted chart-empty" }, "No outdated claims in this range."))),
      h("details", { class: "table-view" }, h("summary", {}, "Daily data as a table"),
        h("table", { class: "data-table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Day (UTC)"), h("th", { class: "num" }, "Answers"), h("th", { class: "num" }, "Claims"), h("th", { class: "num" }, "Potentially outdated"), h("th", { class: "num" }, "Outdated"))),
          h("tbody", {}, t.series.filter((d) => d.responses).map((d) => h("tr", {}, h("td", { class: "mono" }, d.day), h("td", { class: "num" }, d.responses), h("td", { class: "num" }, d.claims), h("td", { class: "num" }, d.at_risk), h("td", { class: "num" }, d.outdated)))))),
    );
  }

  const fig = (v, l) => h("div", { class: "figure" }, h("b", {}, String(v)), h("span", {}, l));

  /** Single-series column chart: thin bars, 2px gaps, rounded data end, recessive axis. */
  function bars(series, key, label, tone) {
    const W = 560, H = 150, L = 28, B = 20, T = 8;
    const max = Math.max(1, ...series.map((d) => d[key]));
    const step = (W - L) / series.length;
    const bw = Math.max(2, Math.min(18, step - 2));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.round(max / 2), max];
    return h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${key} per day, maximum ${max}` },
      ticks.map((v) => [h("line", { class: "grid-line", x1: L, x2: W, y1: y(v), y2: y(v) }), h("text", { class: "axis-label", x: L - 6, y: y(v) + 3, "text-anchor": "end" }, String(v))]),
      series.map((d, i) => {
        const x = L + i * step + (step - bw) / 2;
        const g = h("g", { class: "bar-hit" },
          h("rect", { x: L + i * step, y: T, width: step, height: H - T - B, fill: "transparent" }),
          d[key] ? h("path", { class: `bar bar-${tone}`, d: roundedTop(x, y(d[key]), bw, y(0) - y(d[key])) }) : null);
        g.addEventListener("mousemove", (e) => tip.show(label(d), e.clientX, e.clientY));
        g.addEventListener("mouseleave", () => tip.hide());
        return g;
      }),
      [0, series.length - 1].map((i) => h("text", { class: "axis-label", x: L + i * step + step / 2, y: H - 5, "text-anchor": i ? "end" : "start" }, series[i].day.slice(5))));
  }

  const roundedTop = (x, y, w, hgt) => {
    const r = Math.min(4, w / 2, hgt);
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  };

  /** One stacked bar of verdicts in the status palette; every segment is also in the legend. */
  function outcomes(o) {
    const parts = OUTCOMES.map(([k, l, tone]) => ({ k, l, tone, n: o[k] ?? 0 }));
    const sum = parts.reduce((a, p) => a + p.n, 0);
    if (!sum) return h("p", { class: "muted chart-empty" }, "No time-sensitive claims in this range.");
    const W = 560, H = 22;
    let x = 0;
    const segs = parts.filter((p) => p.n).map((p) => {
      const w = (p.n / sum) * W;
      const g = h("rect", { class: `seg seg-${p.tone}`, x: x + 1, y: 0, width: Math.max(1, w - 2), height: H, rx: 4 });
      g.addEventListener("mousemove", (e) => tip.show(`${p.l}: ${p.n} (${Math.round((p.n / sum) * 100)}%)`, e.clientX, e.clientY));
      g.addEventListener("mouseleave", () => tip.hide());
      x += w;
      return g;
    });
    return h("div", {},
      h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": parts.map((p) => `${p.l} ${p.n}`).join(", ") }, segs),
      h("ul", { class: "outcome-legend" }, parts.map((p) => h("li", {}, h("i", { class: `swatch seg-${p.tone}` }), h("span", {}, p.l), h("b", { class: "mono" }, String(p.n))))));
  }

  function classBars(classes) {
    const max = Math.max(...classes.map((c) => c.outdated));
    return h("ul", { class: "hbars" }, classes.map((c) => h("li", {},
      h("span", { class: "hbar-label" }, c.label),
      h("span", { class: "hbar-track" }, h("i", { style: { width: `${(c.outdated / max) * 100}%` } })),
      h("b", { class: "mono" }, String(c.outdated)))));
  }

  load();
  return () => {
    disposed = true;
    tip.hide();
  };
}
