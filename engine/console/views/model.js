// Freshness model: how fast each claim class expires (half-life with 90% interval, log scale),
// and for the selected class its survival curve, prior vs posterior after observed outcomes.
import { api, clear, fmtDuration, h, pct, tooltip } from "../lib.js";

const HOUR = 1 / 8766;
const MIN_T = HOUR;
const MAX_T = 1000;

export function renderModel(root, { params }) {
  let data = null;
  let selected = params[0] ? decodeURIComponent(params[0]) : null;
  const tip = tooltip();
  const left = h("div", { class: "panel" });
  const right = h("div", { class: "panel" });
  root.append(
    h("header", { class: "page-head" }, h("div", {}, h("h1", {}, "Freshness model"), h("p", {}, "Every factual claim has a different expiration rate. These are the per-class change-rate models Halflife uses, and what verification has taught them."))),
    h("div", { class: "page-body" }, h("div", { class: "pad" }, h("div", { class: "split" }, left, right))),
  );

  function render() {
    const classes = [...data.classes].sort((a, b) => a.prior.half_life.median - b.prior.half_life.median);
    if (!selected || !classes.find((c) => c.id === selected)) selected = classes.find((c) => c.observations.n > 0)?.id ?? "org.leadership";
    clear(left).append(
      h("h2", {}, "How fast facts expire"),
      h("p", {}, "Half-life per claim class: dot = median, bar = 90% credible interval. Blue appears when verified outcomes have updated the prior."),
      rangeChart(classes),
      h("details", { class: "table-view" }, h("summary", {}, "Table view"), classTable(classes)),
    );
    renderClass(classes.find((c) => c.id === selected));
  }

  function rangeChart(classes) {
    const W = 620, rowH = 26, top = 8, labelW = 178, R = 14;
    const H = top + classes.length * rowH + 26;
    const lx = (t) => labelW + ((Math.log(Math.min(MAX_T, Math.max(MIN_T, t))) - Math.log(MIN_T)) / (Math.log(MAX_T) - Math.log(MIN_T))) * (W - labelW - R);
    const svg = h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Half-life by claim class on a logarithmic time axis" });
    const ticks = [[HOUR, "1h"], [1 / 365.25, "1d"], [7 / 365.25, "1w"], [30 / 365.25, "1mo"], [1, "1y"], [10, "10y"], [100, "100y"], [1000, "1000y"]];
    for (const [t, l] of ticks) {
      svg.append(h("line", { class: "grid-line", x1: lx(t), x2: lx(t), y1: top, y2: H - 20 }), h("text", { class: "axis-label", x: lx(t), y: H - 6, "text-anchor": "middle" }, l));
    }
    classes.forEach((c, i) => {
      const y = top + i * rowH;
      const post = c.observations.n > 0 ? c.posterior.half_life : null;
      const hl = post ?? c.prior.half_life;
      const row = h("g", { class: "hl-row", "aria-selected": String(c.id === selected), tabindex: "0", role: "button", "aria-label": `${c.label}: half-life ${fmtDuration(hl.median)}` });
      row.append(h("rect", { class: "hl-bg", x: 0, y, width: W, height: rowH, rx: 4 }));
      row.append(h("text", { class: "hl-name", x: 8, y: y + 17 }, c.label));
      if (!c.static) {
        row.append(h("rect", { class: "hl-range", x: lx(c.prior.half_life.lo), y: y + 10, width: Math.max(2, lx(c.prior.half_life.hi) - lx(c.prior.half_life.lo)), height: 6, rx: 3 }));
        if (post) row.append(h("rect", { class: "hl-range post", x: lx(post.lo), y: y + 10, width: Math.max(2, lx(post.hi) - lx(post.lo)), height: 6, rx: 3 }));
        row.append(h("circle", { class: "hl-median", cx: lx(hl.median), cy: y + 13, r: 4.5 }));
      } else {
        row.append(h("text", { class: "hl-meta", x: W - R, y: y + 17, "text-anchor": "end" }, "does not expire"));
      }
      const pick = () => {
        selected = c.id;
        history.replaceState(null, "", `#/model/${encodeURIComponent(c.id)}`);
        render();
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
      row.addEventListener("pointermove", (e) => {
        tip.show(h("div", {},
          h("b", {}, c.label), h("br"),
          c.static ? "Not time-sensitive" : `Half-life ${fmtDuration(hl.median)} (90%: ${fmtDuration(hl.lo)} – ${fmtDuration(hl.hi)})`, h("br"),
          `P(outdated) after 1 year: ${pct(c.p_outdated.find((p) => p.years === 1)?.[post ? "posterior" : "prior"] ?? 0)}`, h("br"),
          `${c.observations.n} verified outcome${c.observations.n === 1 ? "" : "s"}`), e.clientX, e.clientY);
      });
      row.addEventListener("pointerleave", () => tip.hide());
      svg.append(row);
    });
    return svg;
  }

  function classTable(classes) {
    return h("table", { class: "data-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Class"), h("th", { class: "num" }, "Half-life"), h("th", { class: "num" }, "90% interval"), h("th", { class: "num" }, "P(out) 1 mo"), h("th", { class: "num" }, "P(out) 1 y"), h("th", { class: "num" }, "Outcomes"))),
      h("tbody", {}, classes.map((c) => {
        const k = c.observations.n ? "posterior" : "prior";
        const hl = c[k].half_life;
        const at = (y) => pct(c.p_outdated.find((p) => Math.abs(p.years - y) < 1e-6)?.[k] ?? 0);
        return h("tr", {}, h("td", {}, c.label), h("td", { class: "num" }, c.static ? "—" : fmtDuration(hl.median)), h("td", { class: "num" }, c.static ? "—" : `${fmtDuration(hl.lo)}–${fmtDuration(hl.hi)}`), h("td", { class: "num" }, at(30 / 365.25)), h("td", { class: "num" }, at(1)), h("td", { class: "num" }, `${c.observations.n} (${c.observations.changed} changed)`));
      })),
    );
  }

  function renderClass(c) {
    const post = c.observations.n > 0;
    clear(right).append(
      h("h2", {}, c.label),
      h("p", {}, c.describe),
      survivalChart(c, post),
      h("div", { class: "legend" }, h("span", {}, h("i", { class: "prior" }), "Prior"), post ? h("span", {}, h("i", { class: "post" }), `Posterior (${c.observations.n} outcome${c.observations.n === 1 ? "" : "s"})`) : h("span", { class: "muted" }, "No verified outcomes yet")),
      h("div", { class: "section-label" }, "Prior and its basis"),
      h("dl", { class: "kv", style: { gridTemplateColumns: "150px 1fr" } },
        h("dt", {}, "Typical lifetime"), h("dd", { class: "mono" }, fmtDuration(c.prior.lifetime_years)),
        h("dt", {}, "Gamma prior on λ"), h("dd", { class: "mono" }, `α ${c.prior.alpha}, β ${round(c.prior.beta)} y`),
        h("dt", {}, "Rationale"), h("dd", {}, c.rationale),
        h("dt", {}, "Evidence recency"), h("dd", {}, `sources within ${c.evidence_recency_days} days count as recent`),
        h("dt", {}, "Search topic"), h("dd", { class: "mono" }, c.tavily_topic),
        h("dt", {}, "Outcomes"), h("dd", {}, `${c.observations.n} verified (${c.observations.changed} changed), strong or moderate evidence only`)),
      h("div", { class: "section-label" }, "P(outdated) by age of claim"),
      h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Age"), h("th", { class: "num" }, "Prior"), post ? h("th", { class: "num" }, "Posterior") : null)),
        h("tbody", {}, c.p_outdated.map((p) => h("tr", {}, h("td", {}, fmtDuration(p.years)), h("td", { class: "num" }, pct(p.prior)), post ? h("td", { class: "num" }, pct(p.posterior)) : null)))),
      h("p", { class: "muted", style: { fontSize: "12px", marginTop: "12px" } }, "Changes are modelled as a Poisson process with an uncertain rate λ ~ Gamma(α, β), so P(outdated after t) = 1 − (β/(β+t))^α. Verified outcomes update λ on a grid posterior. These probabilities are uncalibrated estimates, never produced by a language model."),
    );
  }

  function survivalChart(c, post) {
    const W = 420, H = 210, L = 36, R = 12, T = 10, B = 26;
    const ts = c.curve.t;
    const x = (t) => L + ((Math.log(t) - Math.log(ts[0])) / (Math.log(ts.at(-1)) - Math.log(ts[0]))) * (W - L - R);
    const y = (s) => T + (1 - s) * (H - T - B);
    const svg = h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Survival curve for ${c.label}` });
    for (const s of [0, 0.5, 1]) svg.append(h("line", { class: "grid-line", x1: L, x2: W - R, y1: y(s), y2: y(s) }), h("text", { class: "axis-label", x: L - 6, y: y(s) + 3, "text-anchor": "end" }, pct(s)));
    const nTicks = 5;
    for (let i = 0; i < nTicks; i++) {
      const t = Math.exp(Math.log(ts[0]) + ((Math.log(ts.at(-1)) - Math.log(ts[0])) * i) / (nTicks - 1));
      svg.append(h("text", { class: "axis-label", x: x(t), y: H - 8, "text-anchor": i === 0 ? "start" : i === nTicks - 1 ? "end" : "middle" }, fmtDuration(t)));
    }
    const path = (arr) => arr.map((s, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)},${y(s).toFixed(1)}`).join("");
    svg.append(h("path", { class: "line-prior", d: path(c.curve.prior) }));
    if (post) svg.append(h("path", { class: "line-post", d: path(c.curve.posterior) }));
    // crosshair
    const cross = h("line", { class: "grid-line", x1: 0, x2: 0, y1: T, y2: H - B, style: { display: "none" } });
    const dot = h("circle", { class: "marker-now", r: 4, style: { display: "none" } });
    svg.append(cross, dot, h("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }));
    svg.lastChild.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      let i = 0;
      for (let k = 0; k < ts.length; k++) if (Math.abs(x(ts[k]) - px) < Math.abs(x(ts[i]) - px)) i = k;
      const s = post ? c.curve.posterior[i] : c.curve.prior[i];
      cross.setAttribute("x1", x(ts[i])); cross.setAttribute("x2", x(ts[i])); cross.style.display = "";
      dot.setAttribute("cx", x(ts[i])); dot.setAttribute("cy", y(s)); dot.style.display = "";
      tip.show(h("div", {}, h("b", {}, `After ${fmtDuration(ts[i])}`), h("br"), `Still true: ${pct(c.curve.prior[i])} prior`, post ? ` · ${pct(c.curve.posterior[i])} posterior` : "", h("br"), `P(outdated): ${pct(1 - s)}`), e.clientX, e.clientY);
    });
    svg.lastChild.addEventListener("pointerleave", () => {
      cross.style.display = "none";
      dot.style.display = "none";
      tip.hide();
    });
    return svg;
  }

  api("/v1/classes").then((d) => {
    data = d;
    render();
  }).catch((e) => clear(left).append(h("p", { class: "error" }, `Could not load the model: ${e.message}`)));
  return () => tip.hide();
}

const round = (x) => (x < 1 ? x.toPrecision(2) : x < 100 ? x.toFixed(1) : Math.round(x).toString());
