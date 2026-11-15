// Builds HALFLIFE_Project_Presentation.pptx in the repository root.
//
//   node presentation_assets/build/prepare_assets.js   (once, writes crops and the brand mark)
//   node presentation_assets/build/build_deck.js
//
// Needs pptxgenjs (and sharp for prepare_assets.js) on NODE_PATH. Every diagram, chart and label
// is a native, editable PowerPoint shape; images are only real product screenshots and the mark.
// The decay curves and the class-lifetime chart are computed from the priors in
// engine/src/classes.ts (copied below; keep in sync if the priors change).
const path = require("path");
const pptxgen = require("pptxgenjs");

const ROOT = path.resolve(__dirname, "..", "..");
const A = (...p) => path.join(ROOT, "presentation_assets", ...p);
const OUT = path.join(ROOT, "HALFLIFE_Project_Presentation.pptx");
const THEME_SCRIPT = process.env.PPTX_APPLY_THEME; // optional: path to apply_theme.js

// ---------------------------------------------------------------- palette and type
const C = {
  bg: "0D0D0C", surf: "151514", surf2: "1C1C1A", border: "2B2B29", border2: "3D3D3A",
  text: "F0EFEC", text2: "C3C2B7", muted: "8F8E86", faint: "5E5D58",
  em: "3CCB7F", emDim: "1F6B45", emTint: "11251A",
  red: "EF7D7D", redTint: "2A1717", orange: "F2A07F", amber: "FAB219", amberTint: "2A2210",
};
const HEAD = "Segoe UI Semibold";
const BODY = "Segoe UI";
const MONO = "Consolas";
const TOTAL = 18;

// ---------------------------------------------------------------- class priors (engine/src/classes.ts)
const DAY = 1 / 365.25;
const CLASSES = [
  ["Market price", 1 * DAY, 2], ["Market metric", 60 * DAY, 1.5], ["Software version", 120 * DAY, 2],
  ["Policy rate or regulation value", 0.5, 2], ["Scheduled or upcoming event", 0.5, 1.5],
  ["Product offering", 1, 1.5], ["Statistical indicator", 1, 2], ["Sports result or standing", 1, 2],
  ["Organisation facts", 3, 1.5], ["Law or regulation", 3, 1.5], ["Other time-sensitive fact", 3, 1],
  ["Government office holder", 4, 2], ["Person status", 4, 1.5], ["Record or superlative", 5, 1.5],
  ["Organisation leadership", 7, 1.5], ["Scientific consensus", 30, 1.5],
];
const STATIC = ["Historical fact", "Definition or constant"];
const survival = (L, a, t) => Math.pow((a * L) / (a * L + t), a); // P(no change by t), Gamma–Poisson

// Regularised lower incomplete gamma and a quantile by bisection (for 90% prior intervals).
function lgamma(z) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) { let s = 1 / a, d = s; for (let n = 1; n < 500; n++) { d *= x / (a + n); s += d; if (Math.abs(d) < 1e-14 * Math.abs(s)) break; } return s * Math.exp(-x + a * Math.log(x) - lgamma(a)); }
  let b = x + 1 - a, cc = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; cc = b + an / cc; if (Math.abs(cc) < 1e-300) cc = 1e-300; d = 1 / d; const del = d * cc; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
function gammaQuantile(a, p) { let lo = 0, hi = 1000; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (gammaP(a, m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }

// ---------------------------------------------------------------- deck
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
pres.title = "HALFLIFE: a freshness-verification layer for AI conversations";
pres.subject = "Geek Room Global AI Hackathon 2026, Problem 04 (Bifrost) and Problem 06 (Tavily)";
pres.author = "The Halflife authors";
pres.company = "Halflife";
pres.theme = { headFontFace: HEAD, bodyFontFace: BODY };

const FOOTER = "HALFLIFE  ·  Geek Room Global AI Hackathon 2026";
pres.defineSlideMaster({
  title: "HL_CONTENT",
  background: { color: C.bg },
  objects: [
    { text: { text: FOOTER, options: { x: 0.6, y: 7.02, w: 8, h: 0.28, fontFace: MONO, fontSize: 9, color: C.faint, margin: 0, valign: "middle" } } },
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.66, w: 12.13, h: 0.72, fontFace: HEAD, fontSize: 30, color: C.text, valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
  slideNumber: { x: 12.03, y: 7.02, w: 0.7, h: 0.28, fontFace: MONO, fontSize: 9, color: C.faint, align: "right", valign: "middle", margin: 0 },
});
pres.defineSlideMaster({ title: "HL_COVER", background: { color: C.bg }, objects: [] });

// ---------------------------------------------------------------- helpers
function T(slide, text, o) {
  slide.addText(text, Object.assign({ isTextBox: true, margin: 0, fontFace: BODY, fontSize: 14, color: C.text, valign: "top", fit: "none" }, o));
}
function rect(slide, x, y, w, h, o = {}) {
  slide.addShape(pres.shapes.RECTANGLE, Object.assign({ x, y, w, h, fill: { color: o.fill || C.surf }, line: o.line === null ? { type: "none" } : { color: o.line || C.border, width: o.lw || 0.75, dashType: o.dash || "solid" } }, o.extra || {}));
}
function rrect(slide, x, y, w, h, o = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: o.r || 0.06, fill: { color: o.fill || C.surf }, line: o.line === null ? { type: "none" } : { color: o.line || C.border, width: o.lw || 0.75 } });
}
function line(slide, x1, y1, x2, y2, o = {}) {
  const opts = {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1,
    line: { color: o.color || C.border2, width: o.width || 1.25, dashType: o.dash || "solid" },
  };
  if (o.end !== false && o.arrow !== false) opts.line.endArrowType = o.endType || "triangle";
  if (o.arrow === false) delete opts.line.endArrowType;
  if (o.both) opts.line.beginArrowType = "triangle";
  slide.addShape(pres.shapes.LINE, opts);
}
function eyebrow(slide, num, label) {
  T(slide, [
    { text: num, options: { color: C.em } },
    { text: "  /  " + label.toUpperCase(), options: { color: C.muted } },
  ], { x: 0.6, y: 0.36, w: 9, h: 0.26, fontFace: MONO, fontSize: 10.5, charSpacing: 1.5 });
}
function lede(slide, text, o = {}) {
  T(slide, text, Object.assign({ x: 0.6, y: 1.38, w: 11.6, h: 0.5, fontSize: 15, color: C.text2 }, o));
}
function marker(slide, n, x, y, o = {}) {
  const d = o.d || 0.3;
  slide.addShape(pres.shapes.OVAL, { x: x - d / 2, y: y - d / 2, w: d, h: d, fill: { color: o.fill || C.em }, line: { color: C.bg, width: 1.5 } });
  T(slide, String(n), { x: x - d / 2, y: y - d / 2, w: d, h: d, fontFace: HEAD, fontSize: o.fs || 11, color: C.bg, align: "center", valign: "middle" });
}
function chip(slide, text, x, y, w, o = {}) {
  const h = o.h || 0.3;
  rect(slide, x, y, w, h, { fill: o.fill || C.surf2, line: o.line || C.border2 });
  T(slide, text, { x, y, w, h, fontFace: o.font || MONO, fontSize: o.fs || 9.5, color: o.color || C.text2, align: "center", valign: "middle" });
}
function image(slide, file, x, y, w, h, o = {}) {
  slide.addImage({ path: file, x, y, w, h, altText: o.alt || "", objectName: o.name });
  rect(slide, x, y, w, h, { fill: undefined, line: o.frame || C.border2, lw: 0.75, extra: { fill: { type: "none" } } });
}
function frameOnly(slide, x, y, w, h, color) {
  slide.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { type: "none" }, line: { color: color || C.border2, width: 0.75 } });
}
function caption(slide, text, x, y, w, o = {}) {
  T(slide, text, Object.assign({ x, y, w, h: 0.3, fontSize: 9.5, color: C.muted }, o));
}
function polyline(slide, pts, box, o) {
  slide.addShape("custGeom", {
    x: box.x, y: box.y, w: box.w, h: box.h,
    points: pts.map((p, i) => (i === 0 ? { x: p[0], y: p[1], moveTo: true } : { x: p[0], y: p[1] })),
    fill: { type: "none" },
    line: { color: o.color, width: o.width || 2, dashType: o.dash || "solid" },
  });
}
const SECTIONS = new Set();
function newSlide(section, master = "HL_CONTENT") {
  if (!SECTIONS.has(section)) { pres.addSection({ title: section }); SECTIONS.add(section); }
  return pres.addSlide({ masterName: master, sectionTitle: section });
}
function mark(slide, x, y, d) {
  slide.addImage({ path: A("brand", "halflife-mark-dark.png"), x, y, w: d, h: d, altText: "Halflife mark" });
}

// Decay chart: P(claim still current) against time since as-of date, log scale.
const LO = Math.log10(1 / 8766), HI = 2; // 1 hour .. 100 years
function decayChart(slide, box, o = {}) {
  const { x, y, w, h } = box;
  const fx = (lt) => ((lt - LO) / (HI - LO)) * w;
  // frame lines
  line(slide, x, y + h, x + w, y + h, { arrow: false, color: C.border2, width: 0.75 });
  line(slide, x, y, x, y + h, { arrow: false, color: C.border2, width: 0.75 });
  line(slide, x, y + h / 2, x + w, y + h / 2, { arrow: false, color: C.border2, width: 0.75, dash: "dash" });
  const ticks = [["1 h", LO], ["1 d", Math.log10(DAY)], ["1 wk", Math.log10(7 * DAY)], ["1 mo", Math.log10(1 / 12)], ["1 yr", 0], ["10 yr", 1], ["100 yr", 2]];
  for (const [lab, lt] of ticks) {
    const tx = x + fx(lt);
    line(slide, tx, y + h, tx, y + h + 0.06, { arrow: false, color: C.border2, width: 0.75 });
    T(slide, lab, { x: tx - 0.4, y: y + h + 0.1, w: 0.8, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, align: "center" });
  }
  for (const [lab, fy] of [["100%", 0], ["50%", 0.5], ["0%", 1]]) {
    T(slide, lab, { x: x - 0.62, y: y + fy * h - 0.11, w: 0.52, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, align: "right" });
  }
  const series = o.series;
  for (const s of series) {
    const pts = [];
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const lt = LO + ((HI - LO) * i) / N;
      const sv = s.static ? survival(10000, 1, Math.pow(10, lt)) : survival(s.L, s.a, Math.pow(10, lt));
      pts.push([(w * i) / N, h * (1 - sv)]);
    }
    polyline(slide, pts, box, { color: s.color, width: s.width || 2.25, dash: s.dash });
    if (!s.static) {
      const a = s.a, beta = a * s.L;
      const half = beta * (Math.pow(2, 1 / a) - 1);
      const hx = x + fx(Math.log10(half)), hy = y + h / 2;
      const d = 0.13;
      slide.addShape(pres.shapes.OVAL, { x: hx - d / 2, y: hy - d / 2, w: d, h: d, fill: { color: s.color }, line: { color: C.bg, width: 1.25 } });
      if (s.label) {
        const left = s.labelSide === "left";
        T(slide, s.label, { x: left ? hx - 2.0 : hx + 0.1, y: hy + (s.labelDy || -0.42), w: 1.9, h: 0.25, fontSize: o.labelSize || 10.5, color: s.color, fontFace: BODY, align: left ? "right" : "left" });
      }
    } else if (s.label) {
      T(slide, s.label, { x: x + w - 2.6, y: y + 0.08, w: 2.6, h: 0.25, fontSize: o.labelSize || 10.5, color: s.color, align: "right" });
    }
  }
}

// ================================================================= 1. Cover
{
  const s = newSlide("Introduction", "HL_COVER");
  mark(s, 0.75, 1.15, 0.62);
  T(s, "GEEK ROOM GLOBAL AI HACKATHON 2026", { x: 0.75, y: 2.12, w: 6, h: 0.3, fontFace: MONO, fontSize: 11, color: C.em, charSpacing: 2 });
  T(s, "HALFLIFE", { x: 0.7, y: 2.45, w: 6.2, h: 1.2, fontFace: HEAD, fontSize: 72, color: C.text, charSpacing: 3 });
  T(s, "A freshness-verification layer for AI conversations.", { x: 0.75, y: 3.72, w: 5.6, h: 0.9, fontSize: 21, color: C.text2 });
  chip(s, "PROBLEM 04  ·  BIFROST EXTENSION", 0.75, 4.95, 3.05, { h: 0.38, fs: 10, color: C.text });
  chip(s, "PROBLEM 06  ·  TAVILY FRESHNESS", 3.95, 4.95, 2.85, { h: 0.38, fs: 10, color: C.text });
  T(s, "Hackathon prototype  ·  Apache-2.0  ·  github.com/fazeprism25/halflife", { x: 0.75, y: 6.6, w: 6.2, h: 0.3, fontFace: MONO, fontSize: 9.5, color: C.muted });

  // right: survival curves from the real priors
  T(s, "P(claim still current)", { x: 7.35, y: 0.95, w: 3, h: 0.25, fontFace: MONO, fontSize: 9.5, color: C.muted });
  decayChart(s, { x: 7.35, y: 1.35, w: 5.3, h: 4.1 }, {
    series: [
      { static: true, color: C.muted, dash: "dash", width: 1.75, label: "Historical fact: does not expire" },
      { L: 1 * DAY, a: 2, color: C.orange, label: "Market price" },
      { L: 120 * DAY, a: 2, color: C.em, label: "Software version", labelSide: "left", labelDy: 0.12 },
      { L: 4, a: 2, color: C.text, label: "Office holder" },
    ],
  });
  T(s, "Time since the claim's as-of date (log scale). The dot marks a 50% chance of change.", { x: 7.35, y: 5.85, w: 5.3, h: 0.25, fontSize: 9.5, color: C.muted });
  T(s, "Prior curves from the hand-set class priors in engine/src/classes.ts; estimated, uncalibrated.", { x: 7.35, y: 6.1, w: 5.3, h: 0.25, fontSize: 9.5, color: C.faint });
  s.addNotes("HALFLIFE is a freshness-verification layer for AI conversations, built for the Geek Room Global AI Hackathon 2026 against Problem 04 (a Bifrost extension) and Problem 06 (claim-level freshness with Tavily). The curves on the right are the real prior survival curves from the engine's class definitions: a price claim is likely to have changed within a day, a software-version claim within months, an office-holder claim within years, and a historical fact not at all. These are hand-set priors, not calibrated probabilities.");
}

// ================================================================= 2. Problem
{
  const s = newSlide("Introduction");
  eyebrow(s, "02", "The problem");
  s.addText("AI answers expire, one claim at a time", { placeholder: "title" });
  lede(s, "A model states every sentence with the same confidence, from training data with a cutoff. But the facts inside one answer age at very different rates.");

  // left: illustrative answer
  rect(s, 0.6, 2.15, 5.75, 4.15, { fill: C.surf });
  T(s, "ONE ANSWER, SIX CLOCKS", { x: 0.9, y: 2.38, w: 4, h: 0.25, fontFace: MONO, fontSize: 9.5, color: C.muted, charSpacing: 1.5 });
  const sp = (t, n, col) => [{ text: t, options: { color: col, underline: { style: "sng", color: col } } }, { text: n, options: { color: col, superscript: true } }];
  const pl = (t) => ({ text: t, options: { color: C.text2 } });
  T(s, [
    ...sp("Bitcoin trades at $60k", "1", C.orange), pl(", "), ...sp("ChatGPT Plus costs $20/month", "2", C.orange), pl(" and "),
    ...sp("the latest Python is 3.12", "3", C.em), pl(". "), ...sp("Satya Nadella is CEO of Microsoft", "4", C.text), pl(", "),
    ...sp("the EU AI Act is not yet in force", "5", C.text), pl(", and "), ...sp("the Berlin Wall fell in 1989", "6", C.muted), pl("."),
  ], { x: 0.9, y: 2.8, w: 5.15, h: 2.3, fontFace: "Cambria", fontSize: 19, lineSpacingMultiple: 1.25 });
  T(s, "Illustrative answer assembled from the example claims in the engine's class definitions (engine/src/classes.ts). The statements are examples of claim types, not verified facts.", { x: 0.9, y: 5.35, w: 5.15, h: 0.75, fontSize: 10, color: C.muted });

  // right: shelf life rows
  const rows = [
    ["1", "Market price", "~1 day", 1 * DAY, C.orange],
    ["2", "Product offering (pricing)", "~1 year", 1, C.orange],
    ["3", "Software version", "~4 months", 120 * DAY, C.em],
    ["4", "Organisation leadership", "~7 years", 7, C.text],
    ["5", "Law or regulation", "~3 years", 3, C.text],
    ["6", "Historical fact", "does not expire", null, C.muted],
  ];
  const X0 = 6.85, BX = 10.45, BW = 2.28;
  T(s, "CLAIM CLASS", { x: X0 + 0.45, y: 2.2, w: 1.8, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted });
  T(s, "TYPICAL LIFETIME (PRIOR)", { x: BX, y: 2.2, w: BW, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted });
  rows.forEach(([n, cls, life, L, col], i) => {
    const y = 2.6 + i * 0.6;
    marker(s, n, X0 + 0.15, y + 0.2, { d: 0.28, fill: col === C.text ? C.text2 : col, fs: 10 });
    T(s, cls, { x: X0 + 0.45, y: y + 0.04, w: 2.3, h: 0.3, fontSize: 13, color: C.text });
    T(s, life, { x: X0 + 2.2, y: y + 0.06, w: 1.25, h: 0.3, fontFace: MONO, fontSize: 10.5, color: col === C.muted ? C.muted : C.text2, align: "right" });
    rect(s, BX, y + 0.12, BW, 0.16, { fill: C.surf2, line: null });
    if (L) {
      const f = (Math.log10(L) - LO) / (HI - LO);
      rect(s, BX, y + 0.12, Math.max(0.05, BW * f), 0.16, { fill: col === C.text ? C.text2 : col, line: null });
    } else {
      rect(s, BX, y + 0.12, BW, 0.16, { fill: C.surf2, line: C.muted, dash: "dash" });
    }
  });
  T(s, "1 h", { x: BX, y: 6.2, w: 0.5, h: 0.2, fontFace: MONO, fontSize: 8.5, color: C.faint });
  T(s, "100 yr (log)", { x: BX + BW - 1.2, y: 6.2, w: 1.2, h: 0.2, fontFace: MONO, fontSize: 8.5, color: C.faint, align: "right" });

  T(s, [{ text: "An AI answer is not equally fresh across all of its claims.", options: { color: C.em } }], { x: 0.6, y: 6.5, w: 12, h: 0.4, fontFace: HEAD, fontSize: 18 });
  s.addNotes("The six claims in this illustrative answer belong to different classes in HALFLIFE's model, and each class has its own typical lifetime set as a prior in engine/src/classes.ts: about a day for market prices, about four months for 'latest version' claims, years for leadership and regulation, and never for historical facts. The point is that freshness is a property of each claim, not of the answer.");
}

// ================================================================= 3. Why existing approaches fall short
{
  const s = newSlide("Introduction");
  eyebrow(s, "03", "Why answer-level checking falls short");
  s.addText("Uniform checking spends in the wrong places", { placeholder: "title" });
  lede(s, "Four ways to keep answers current, positioned qualitatively by what they cost and how much stale content they still let through.");

  // quadrant
  const qx = 1.25, qy = 2.2, qw = 5.6, qh = 3.95;
  rect(s, qx, qy, qw, qh, { fill: C.surf, line: C.border });
  line(s, qx + qw / 2, qy, qx + qw / 2, qy + qh, { arrow: false, color: C.border, width: 0.75, dash: "dash" });
  line(s, qx, qy + qh / 2, qx + qw, qy + qh / 2, { arrow: false, color: C.border, width: 0.75, dash: "dash" });
  line(s, qx, qy + qh + 0.18, qx + qw, qy + qh + 0.18, { color: C.muted, width: 1 });
  T(s, "Search cost per answer", { x: qx, y: qy + qh + 0.26, w: qw, h: 0.24, fontFace: MONO, fontSize: 9.5, color: C.muted, align: "right" });
  line(s, qx - 0.18, qy + qh, qx - 0.18, qy, { color: C.muted, width: 1 });
  T(s, "Stale claims that get through", { x: qx - 0.62, y: qy, w: 0.3, h: qh, fontFace: MONO, fontSize: 9.5, color: C.muted, vert: "vert270", align: "right" });
  const pt = (label, sub, fx, fy, col, big) => {
    const px = qx + fx * qw, py = qy + fy * qh, d = big ? 0.26 : 0.2;
    s.addShape(pres.shapes.OVAL, { x: px - d / 2, y: py - d / 2, w: d, h: d, fill: { color: col }, line: { color: C.bg, width: 1.5 } });
    T(s, [{ text: label, options: { color: big ? C.em : C.text, bold: false, fontFace: HEAD, breakLine: true } }, { text: sub, options: { color: C.muted, fontSize: 9.5 } }], { x: px + 0.22, y: py - 0.2, w: 2.35, h: 0.6, fontSize: 12 });
  };
  pt("Check nothing", "free, but every expired claim ships", 0.08, 0.12, C.red);
  pt("Re-check the whole answer", "one verdict for many claims", 0.48, 0.42, C.text2);
  pt("Re-check every claim, always", "static claims searched too", 0.53, 0.82, C.orange);
  pt("Risk-weighted, per claim", "HALFLIFE's approach", 0.08, 0.7, C.em, true);
  T(s, "Qualitative illustration, not a measurement. It does not describe how any specific AI product behaves.", { x: qx, y: 6.72, w: 6, h: 0.25, fontSize: 9, color: C.faint });

  // right: reasons
  const R = [
    ["Static claims never change", "Searching “the Berlin Wall fell in 1989” spends a credit and cannot make an answer fresher. HALFLIFE never searches its two static classes."],
    ["Volatility spans orders of magnitude", "A price can expire in a day, an office holder in years. One re-check interval cannot fit both."],
    ["An answer-level verdict hides the cause", "Pass/fail for a whole answer cannot say which sentence is outdated, or show the evidence for it."],
    ["Caches keep serving old answers", "A gateway cache can return the same answer for hours without knowing which part of it is volatile."],
  ];
  R.forEach(([h, b], i) => {
    const y = 2.2 + i * 1.08;
    T(s, String(i + 1).padStart(2, "0"), { x: 7.75, y, w: 0.5, h: 0.3, fontFace: MONO, fontSize: 12, color: C.em });
    T(s, h, { x: 8.3, y: y - 0.02, w: 4.4, h: 0.32, fontFace: HEAD, fontSize: 14.5, color: C.text });
    T(s, b, { x: 8.3, y: y + 0.32, w: 4.4, h: 0.68, fontSize: 11.5, color: C.text2 });
  });
  s.addNotes("This slide positions four strategies qualitatively; it is not a benchmark. Checking nothing is free but lets every expired claim through. Re-checking the whole answer gives one verdict for many claims. Re-checking every claim every time also searches claims that cannot change. HALFLIFE weighs each claim by its class's change rate and age and spends search credits only where the estimated risk is high.");
}

// ================================================================= 4. Introducing HALFLIFE
{
  const s = newSlide("Product");
  eyebrow(s, "04", "Introducing HALFLIFE");
  s.addText("Claim-level freshness, from answer to evidence", { placeholder: "title" });
  T(s, [
    { text: "HALFLIFE finds the time-sensitive claims in an AI answer, estimates how likely each is to have gone out of date, checks the risky ones against live web evidence, and reports a verdict ", options: { color: C.text2 } },
    { text: "per claim", options: { color: C.em } },
    { text: ".", options: { color: C.text2 } },
  ], { x: 0.6, y: 1.42, w: 11.4, h: 0.85, fontSize: 18 });

  const steps = [
    ["AI answer", "From gateway traffic, the ChatGPT extension, or POST /v1/check."],
    ["Claim extraction", "An LLM, called through Bifrost, splits the answer into atomic claims. Each span must occur verbatim."],
    ["Freshness analysis", "One of 18 classes, an as-of date interval, and a Gamma–Poisson P(outdated). Verify if ≥ 20%, at most 3."],
    ["Live verification", "Reuse a recent verdict for 0 credits, else Tavily search, with extract as a fallback."],
    ["Evidence evaluation", "A judge model returns a verdict and quotes. Code checks every quote against its source."],
    ["Claim-level results", "Verdict, evidence level and sources per claim. Stale cache entries are invalidated."],
  ];
  const n = steps.length, gx = 0.28, bw = (12.13 - gx * (n - 1)) / n, by = 2.75, bh = 1.0;
  steps.forEach(([t, d], i) => {
    const x = 0.6 + i * (bw + gx);
    const last = i === n - 1;
    rect(s, x, by, bw, bh, { fill: last ? C.emTint : C.surf, line: last ? C.emDim : C.border2 });
    T(s, String(i + 1).padStart(2, "0"), { x: x + 0.15, y: by + 0.13, w: 0.6, h: 0.25, fontFace: MONO, fontSize: 10, color: C.em });
    T(s, t, { x: x + 0.15, y: by + 0.42, w: bw - 0.25, h: 0.5, fontFace: HEAD, fontSize: 14, color: C.text });
    T(s, d, { x: x + 0.02, y: by + bh + 0.2, w: bw - 0.04, h: 1.3, fontSize: 11, color: C.text2 });
    if (!last) line(s, x + bw + 0.03, by + bh / 2, x + bw + gx - 0.03, by + bh / 2, { color: C.em, width: 1.25 });
  });

  // bottom: entry points and scope
  const yb = 5.55;
  T(s, "ENTRY POINTS", { x: 0.6, y: yb, w: 3, h: 0.22, fontFace: MONO, fontSize: 9.5, color: C.muted, charSpacing: 1.5 });
  chip(s, "Bifrost gateway plugin", 0.6, yb + 0.32, 2.35, { h: 0.36, fs: 10, color: C.text });
  chip(s, "ChatGPT extension", 3.1, yb + 0.32, 2.0, { h: 0.36, fs: 10, color: C.text });
  chip(s, "POST /v1/check", 5.25, yb + 0.32, 1.7, { h: 0.36, fs: 10, color: C.text });
  rect(s, 7.45, yb - 0.02, 5.28, 0.78, { fill: C.amberTint, line: "4A3A12" });
  T(s, [{ text: "Not a universal fact-checker. ", options: { color: C.amber, fontFace: HEAD } }, { text: "It answers one question: has this claim gone stale? Static claims are never checked, even when wrong.", options: { color: C.text2 } }], { x: 7.65, y: yb + 0.08, w: 4.95, h: 0.62, fontSize: 11.5 });
  s.addNotes("The six stages are implemented in engine/src/pipeline.ts. Extraction and verdicts use a judge model through Bifrost (DeepSeek deepseek-flash in the reference deployment). The freshness model decides which claims to verify: at or above a 20% estimated risk, at most three per answer. Verification reuses a recent verdict when possible and otherwise searches with Tavily through a Bifrost relay. Every quote the judge returns is checked against the fetched source in code. HALFLIFE is deliberately scoped to staleness, not general truth.");
}

// ================================================================= 5. Freshness model
{
  const s = newSlide("Product");
  eyebrow(s, "05", "The freshness model");
  s.addText("Every claim class has its own rate of change", { placeholder: "title" });

  // left: lifetime range chart, native shapes
  const cx = 2.95, cw = 4.25, top = 1.75, rh = 0.24;
  T(s, "TYPICAL LIFETIME PER CLASS  ·  PRIOR", { x: 0.6, y: top - 0.25, w: 5, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const fx = (yrs) => cx + cw * ((Math.log10(yrs) - LO) / (HI - LO));
  const rowsAll = [...CLASSES.map((c) => ({ label: c[0], L: c[1], a: c[2] })), ...STATIC.map((l) => ({ label: l, stat: true }))];
  const chartTop = top + 0.12;
  const chartBottom = chartTop + rowsAll.length * rh;
  for (const [lab, lt] of [["1 h", LO], ["1 d", Math.log10(DAY)], ["1 mo", Math.log10(1 / 12)], ["1 yr", 0], ["10 yr", 1], ["100 yr", 2]]) {
    const tx = cx + cw * ((lt - LO) / (HI - LO));
    line(s, tx, chartTop, tx, chartBottom, { arrow: false, color: "232321", width: 0.75 });
    T(s, lab, { x: tx - 0.35, y: chartBottom + 0.05, w: 0.7, h: 0.2, fontFace: MONO, fontSize: 8.5, color: C.muted, align: "center" });
  }
  rowsAll.forEach((r, i) => {
    const y = chartTop + i * rh;
    T(s, r.label, { x: 0.6, y: y + 0.02, w: 2.3, h: rh - 0.02, fontSize: 9.5, color: r.stat ? C.muted : C.text2, valign: "middle" });
    if (r.stat) {
      T(s, "does not expire  ·  never searched", { x: cx + cw - 2.6, y: y + 0.02, w: 2.6, h: rh - 0.02, fontFace: MONO, fontSize: 8.5, color: C.muted, align: "right", valign: "middle" });
      return;
    }
    const beta = r.a * r.L;
    const lamLo = gammaQuantile(r.a, 0.05) / beta, lamHi = gammaQuantile(r.a, 0.95) / beta;
    const t1 = Math.max(1 / lamHi, Math.pow(10, LO)), t2 = Math.min(1 / lamLo, Math.pow(10, HI));
    const x1 = fx(t1), x2 = fx(t2);
    rect(s, x1, y + rh / 2 - 0.035, Math.max(0.03, x2 - x1), 0.07, { fill: C.emDim, line: null });
    const d = 0.11;
    s.addShape(pres.shapes.OVAL, { x: fx(r.L) - d / 2, y: y + rh / 2 - d / 2, w: d, h: d, fill: { color: C.em }, line: { color: C.bg, width: 1 } });
  });
  T(s, "Dot: typical lifetime in classes.ts. Bar: 90% prior interval of the time between changes. Hand-set, uncalibrated.", { x: 0.6, y: chartBottom + 0.36, w: 6.9, h: 0.25, fontSize: 9, color: C.muted });

  // right: how risk is estimated
  const rx = 7.75, rw = 4.98;
  T(s, "HOW RISK IS ESTIMATED", { x: rx, y: 1.5, w: rw, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  rect(s, rx, 1.82, rw, 0.62, { fill: C.surf2, line: C.border2 });
  T(s, "P(outdated now) = 1 − (β / (β + Δt))^α", { x: rx + 0.2, y: 1.82, w: rw - 0.4, h: 0.62, fontFace: MONO, fontSize: 14.5, color: C.text, valign: "middle" });
  const bl = [
    ["λ ~ Gamma(α, β)", "each class's change rate, as a Poisson process"],
    ["Δt", "time since the as-of date: a stated date, an earlier verification, the model's cutoff, or an assumed 6–36 months, so the result is a range"],
    ["θ = 20%", "claims at or above it are verified, riskiest first, at most 3 per answer"],
    ["Reuse window", "no new search until risk since the last verification reaches θ"],
    ["Learning", "strong or moderate verdicts update the class posterior"],
  ];
  const bh = [0.36, 0.74, 0.52, 0.52, 0.36];
  let by = 2.58;
  bl.forEach(([k, v], i) => {
    T(s, k, { x: rx, y: by, w: 1.35, h: bh[i], fontFace: MONO, fontSize: 10.5, color: C.em });
    T(s, v, { x: rx + 1.45, y: by, w: rw - 1.45, h: bh[i], fontSize: 10.5, color: C.text2 });
    by += bh[i];
  });

  // three measures
  const my = 5.12;
  T(s, "THREE MEASURES, NEVER BLENDED", { x: rx, y: my, w: rw, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const M = [
    ["Freshness risk", "P(outdated) range · estimated, uncalibrated", C.orange],
    ["Verdict", "current · superseded · contradicted · unverifiable", C.text],
    ["Evidence confidence", "strong · moderate · weak · none; rules, not a %", C.em],
  ];
  M.forEach(([k, v, col], i) => {
    const y = my + 0.3 + i * 0.4;
    rect(s, rx, y, rw, 0.36, { fill: C.surf, line: C.border });
    T(s, k, { x: rx + 0.15, y, w: 1.75, h: 0.36, fontFace: HEAD, fontSize: 11, color: col, valign: "middle" });
    T(s, v, { x: rx + 1.9, y, w: rw - 2.0, h: 0.36, fontSize: 10, color: C.text2, valign: "middle" });
  });
  T(s, "None of them guarantees that a claim is factually correct.", { x: rx, y: my + 1.55, w: rw, h: 0.25, fontSize: 10, color: C.muted });
  s.addNotes("Each of the 18 classes has a Gamma prior on its change rate, with a written rationale in engine/src/classes.ts. For a claim of age delta-t, P(outdated) is the Gamma-Poisson marginal; because the as-of date is an interval, the result is a range. The priors are hand-set and the score is labelled estimated and uncalibrated everywhere: FreshQA measured detection and verification, not calibration. Freshness risk, the verdict and evidence confidence are three separate measures and are never blended into one score. The verdict that drives cache actions comes from evidence, not from the risk number.");
}

// ================================================================= 6. Architecture
{
  const s = newSlide("Architecture");
  eyebrow(s, "06", "System architecture");
  s.addText("Two deployables: a gateway plugin and an engine", { placeholder: "title" });
  lede(s, "The plugin does microsecond-scale inline work inside Bifrost; everything slow, stateful or networked runs in the engine.", { y: 1.36, h: 0.35, fontSize: 13.5 });

  // clients
  const cx = 0.6, cw = 1.95;
  T(s, "CLIENTS", { x: cx, y: 1.9, w: cw, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const box = (x, y, w, h, title, sub, o = {}) => {
    rect(s, x, y, w, h, { fill: o.fill || C.surf, line: o.line || C.border2 });
    T(s, title, { x: x + 0.12, y: y + 0.07, w: w - 0.2, h: 0.26, fontFace: o.mono ? MONO : HEAD, fontSize: o.fs || 11.5, color: o.color || C.text });
    if (sub) T(s, sub, { x: x + 0.12, y: y + 0.33, w: w - 0.2, h: h - 0.36, fontSize: 9, color: C.muted });
  };
  box(cx, 2.35, cw, 0.85, "Application", "OpenAI-compatible, x-bf-vk");
  box(cx, 5.2, cw, 0.66, "ChatGPT + extension", "opt-in, one answer per click");
  box(cx, 6.04, cw, 0.66, "Operator browser", "console on 127.0.0.1:8090");

  // gateway
  const gx = 3.5, gy = 1.9, gw = 5.2, gh = 2.75;
  rect(s, gx, gy, gw, gh, { fill: "121211", line: C.border2 });
  T(s, [{ text: "BIFROST GATEWAY", options: { color: C.text, fontFace: MONO } }, { text: "   v2.4.0, built from source  ·  :8080", options: { color: C.muted } }], { x: gx + 0.18, y: gy + 0.12, w: gw - 0.3, h: 0.24, fontSize: 9.5 });
  const iw = 2.33, ih = 0.58, ix1 = gx + 0.18, ix2 = gx + 0.18 + iw + 0.17;
  const r1 = gy + 0.52, r2 = r1 + 0.72, r3 = r2 + 0.72;
  box(ix1, r1, iw, ih, "semantic_cache", "exact match · TTL key", { mono: true, fs: 10, fill: C.surf });
  box(ix1, r2, iw, ih, "/relay/halflife", "engine API · VK + route allow-list", { mono: true, fs: 10, fill: C.surf });
  box(ix1, r3, iw, ih, "halflife plugin (.so)", "post_builtin · 6 hooks · fail-open", { mono: true, fs: 10, fill: C.emTint, line: C.emDim, color: C.em });
  box(ix2, r1, iw, ih, "provider: deepseek", "native Bifrost provider", { mono: true, fs: 10, fill: C.surf });
  box(ix2, r2, iw, ih, "/relay/tavily", "holds the Tavily key · per-credit", { mono: true, fs: 10, fill: C.surf });
  box(ix2, r3, iw, ih, "cache admin API", "invalidate an entry by id", { mono: true, fs: 10, fill: C.surf });

  // external
  const ex = 9.75, ew = 2.98;
  T(s, "EXTERNAL SERVICES", { x: ex, y: 1.9, w: ew, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  box(ex, r1 - 0.04, ew, 0.66, "DeepSeek API", "deepseek-flash · extraction and verdicts");
  box(ex, r2 - 0.04, ew, 0.66, "Tavily API", "search · extract · usage");
  T(s, "Provider and Tavily keys exist only in the gateway's environment. The engine never sees them.", { x: ex, y: r3 - 0.02, w: ew, h: 0.62, fontSize: 9.5, color: C.muted });

  // engine
  const ey = 5.2, eh = 1.5;
  rect(s, gx, ey, gw, eh, { fill: "121211", line: C.emDim });
  T(s, [{ text: "HALFLIFE ENGINE", options: { color: C.em, fontFace: MONO } }, { text: "   Node 24  ·  zero npm dependencies  ·  :8090", options: { color: C.muted } }], { x: gx + 0.18, y: ey + 0.12, w: gw - 0.3, h: 0.24, fontSize: 9.5 });
  const chips1 = [["extract", 0.75], ["freshness model", 1.35], ["verify", 0.65], ["evidence", 0.85], ["cache actions", 1.0]];
  let cxp = gx + 0.18;
  chips1.forEach(([t, w], i) => { chip(s, t, cxp, ey + 0.5, w, { h: 0.32, fs: 9 }); cxp += w + 0.06; });
  const chips2 = [["SQLite store", 1.1], ["REST API", 0.85], ["SSE", 0.5], ["console", 0.8], ["/v1/extension", 1.15]];
  cxp = gx + 0.18;
  chips2.forEach(([t, w]) => { chip(s, t, cxp, ey + 0.94, w, { h: 0.32, fs: 9 }); cxp += w + 0.06; });

  // arrows (colour = kind)
  const WHITE = C.text, GREY = C.muted, GREEN = C.em, ORANGE = C.orange;
  // app -> gateway, reply back
  line(s, cx + cw, 2.66, gx, 2.66, { color: WHITE, width: 1.5 });
  line(s, gx, 2.94, cx + cw, 2.94, { color: WHITE, width: 1.25, dash: "dash" });
  T(s, "request", { x: cx + cw + 0.08, y: 2.42, w: 0.8, h: 0.2, fontFace: MONO, fontSize: 8, color: C.muted });
  T(s, "reply +\nx-halflife-*", { x: cx + cw + 0.08, y: 3.02, w: 0.9, h: 0.36, fontFace: MONO, fontSize: 7.5, color: C.muted });
  // gateway -> deepseek (model request)
  line(s, ix2 + iw, r1 + 0.22, ex, r1 + 0.22, { color: GREEN, width: 1.5, both: true });
  // relay/tavily -> tavily (retrieval) + evidence back
  line(s, ix2 + iw, r2 + 0.18, ex, r2 + 0.18, { color: ORANGE, width: 1.5 });
  line(s, ex, r2 + 0.4, ix2 + iw, r2 + 0.4, { color: ORANGE, width: 1.25, dash: "dash" });
  T(s, "evidence", { x: ix2 + iw + 0.3, y: r2 + 0.45, w: 0.9, h: 0.2, fontFace: MONO, fontSize: 8, color: C.orange });
  // plugin -> engine ingest
  line(s, ix1 + 0.6, r3 + ih, ix1 + 0.6, ey, { color: GREY, width: 1.5 });
  T(s, "ingest · internal network, token", { x: ix1 + 0.7, y: 4.72, w: 2.1, h: 0.2, fontFace: MONO, fontSize: 8, color: C.muted });
  // engine -> gateway callbacks
  line(s, ix2 + 1.7, ey, ix2 + 1.7, gy + gh, { color: GREEN, width: 1.5 });
  line(s, ix2 + 1.95, ey, ix2 + 1.95, gy + gh, { color: ORANGE, width: 1.5 });
  T(s, "engine → gateway: LLM calls,\nTavily relay, cache invalidation", { x: ix2 + 2.08, y: 4.72, w: 2.6, h: 0.36, fontFace: MONO, fontSize: 7.5, color: C.muted });
  // extension -> engine, console <- engine
  line(s, cx + cw, 5.53, gx, 5.53, { color: WHITE, width: 1.5 });
  T(s, "loopback,\npaired token", { x: cx + cw + 0.08, y: 5.18, w: 0.9, h: 0.32, fontFace: MONO, fontSize: 7.5, color: C.muted });
  line(s, gx, 6.37, cx + cw, 6.37, { color: WHITE, width: 1.25, dash: "dash" });
  T(s, "reports, SSE", { x: cx + cw + 0.08, y: 6.42, w: 0.9, h: 0.2, fontFace: MONO, fontSize: 7.5, color: C.muted });

  // legend
  const lx = 9.75, ly = 5.2;
  rect(s, lx, ly, 2.98, 1.5, { fill: C.surf, line: C.border });
  const L = [[WHITE, "solid", "User input"], [GREY, "solid", "Internal hand-off"], [GREEN, "solid", "Model requests"], [ORANGE, "solid", "Web retrieval"], [C.text2, "dash", "Results returned"]];
  L.forEach(([col, dash, lab], i) => {
    const y = ly + 0.2 + i * 0.25;
    line(s, lx + 0.18, y + 0.09, lx + 0.72, y + 0.09, { color: col, width: 1.5, dash, arrow: false });
    T(s, lab, { x: lx + 0.86, y, w: 2.0, h: 0.2, fontSize: 9.5, color: C.text2 });
  });
  s.addNotes("Application traffic enters Bifrost with a virtual key. Bifrost's semantic cache and the HALFLIFE Go plugin run inside the gateway; the plugin triages answers, sets cache TTLs and hands answers to the engine over the internal Docker network. The engine calls back into the gateway for its own LLM calls (marked with an internal token so the plugin skips them), for Tavily through /relay/tavily, and for cache invalidation. The ChatGPT extension talks to the engine directly on loopback with a paired token; it does not pass through the gateway, but the engine's model and Tavily calls for its checks do. The console reads reports from the engine and listens over server-sent events.");
}

// ================================================================= 7. Verification workflow
{
  const s = newSlide("Architecture");
  eyebrow(s, "07", "How a verification works");
  s.addText("Eight steps from a selected answer to a verdict", { placeholder: "title" });

  const steps = [
    ["Answer selected", "A completion passes the Bifrost plugin, or the user clicks Check freshness under a ChatGPT answer.", "plugin · extension"],
    ["Sent to the engine", "The plugin hands off via /v1/ingest (or waits, in verify mode). The extension sends the answer and the user message before it.", "/v1/ingest · /v1/extension"],
    ["Claims identified", "The judge returns atomic claim spans and one of 18 classes. A span that is not verbatim in the answer is dropped.", "extract.ts"],
    ["Risk estimated", "An as-of interval gives a P(outdated) range per claim. At or above 20% is at risk; the 3 riskiest go on.", "asof.ts · freshness.ts"],
    ["Reuse or research", "A stored verdict inside its reuse window is reused for 0 credits. Otherwise the credit guard reserves a search.", "verify.ts · credits.ts"],
    ["Tavily retrieves evidence", "Basic search, 5 results with published dates, topic by class. Extract the top 2 URLs if no quote verified.", "tavily.ts · /relay/tavily"],
    ["Evidence judged", "The judge returns a verdict and quotes. Code drops quotes not found in the source, then rates the evidence by rule.", "verify.ts · evidence.ts"],
    ["Claim-level report", "Verdict, evidence level and sources per claim. Stale cache entries invalidated; shown in console and extension.", "cache.ts · console"],
  ];
  const phases = [
    [0, 3, "CLAIM IDENTIFICATION", C.text2], [3, 4, "FRESHNESS ASSESSMENT", C.orange],
    [4, 7, "EVIDENCE VERIFICATION", C.em], [7, 8, "RESULT", C.text],
  ];
  const gap = 0.3, cw = (12.13 - 3 * gap) / 4, ch = 1.85;
  const rowY = [2.05, 4.8];
  const pos = (i) => ({ x: 0.6 + (i % 4) * (cw + gap), y: rowY[Math.floor(i / 4)] });
  for (const [a, b, lab, col] of phases) {
    const p1 = pos(a), p2 = pos(b - 1);
    const y = p1.y - 0.38;
    T(s, lab, { x: p1.x, y, w: p2.x + cw - p1.x, h: 0.22, fontFace: MONO, fontSize: 9, color: col, charSpacing: 1.5 });
    line(s, p1.x, y + 0.27, p2.x + cw, y + 0.27, { arrow: false, color: col, width: 1 });
  }
  steps.forEach(([t, d, tag], i) => {
    const { x, y } = pos(i);
    rect(s, x, y, cw, ch, { fill: i === 7 ? C.emTint : C.surf, line: i === 7 ? C.emDim : C.border });
    T(s, String(i + 1).padStart(2, "0"), { x: x + 0.18, y: y + 0.14, w: 0.5, h: 0.28, fontFace: MONO, fontSize: 13, color: C.em });
    T(s, t, { x: x + 0.62, y: y + 0.13, w: cw - 0.75, h: 0.3, fontFace: HEAD, fontSize: 13.5, color: C.text });
    T(s, d, { x: x + 0.18, y: y + 0.52, w: cw - 0.34, h: 1.0, fontSize: 10.5, color: C.text2 });
    T(s, tag, { x: x + 0.18, y: y + ch - 0.33, w: cw - 0.34, h: 0.22, fontFace: MONO, fontSize: 8.5, color: C.muted });
    if (i % 4 !== 3) line(s, x + cw + 0.04, y + ch / 2, x + cw + gap - 0.04, y + ch / 2, { color: C.border2, width: 1.25 });
  });
  // connector from step 4 to step 5
  const p4 = pos(3), p5 = pos(4);
  const midY = rowY[0] + ch + 0.12;
  line(s, p4.x + cw / 2, rowY[0] + ch, p4.x + cw / 2, midY, { arrow: false, color: C.border2, width: 1.25 });
  line(s, p4.x + cw / 2, midY, p5.x + cw / 2, midY, { arrow: false, color: C.border2, width: 1.25 });
  line(s, p5.x + cw / 2, midY, p5.x + cw / 2, rowY[1] - 0.42, { color: C.border2, width: 1.25 });
  s.addNotes("Identification (steps 1 to 3), freshness assessment (step 4) and evidence verification (steps 5 to 7) are separate stages. A claim that is not time-sensitive stops after step 3; a claim below the risk threshold stops after step 4 and is reported as not checked with that reason. A claim refused by any spending limit is reported as not checked: budget, never given a verdict and never retried. A verdict whose quotes cannot be found in the fetched source becomes unverifiable.");
}

// ================================================================= 8. ChatGPT extension
{
  const s = newSlide("In use");
  eyebrow(s, "08", "ChatGPT browser extension");
  s.addText("Check an answer where you read it", { placeholder: "title" });

  // left: the button, then the compact result (real chatgpt.com)
  const lx = 0.6, lw = 5.3;
  const h1 = lw * 360 / 1000, h2 = lw * 510 / 1000;
  const y1 = 1.62, y2 = y1 + h1 + 0.42;
  image(s, A("crops", "real-check-button.png"), lx, y1, lw, h1, { alt: "Real chatgpt.com answer with the Check freshness button under it", name: "Screenshot: Check freshness button (real chatgpt.com)" });
  marker(s, 1, lx + 0.13, y1 + h1 + 0.2, { d: 0.26, fs: 10 });
  caption(s, "Check freshness appears under a finished answer", lx + 0.36, y1 + h1 + 0.08, lw - 0.36);
  image(s, A("crops", "real-result.png"), lx, y2, lw, h2, { alt: "Real chatgpt.com answer with HALFLIFE's compact result: checked claims are current", name: "Screenshot: compact result (real chatgpt.com)" });
  marker(s, 2, lx + 0.13, y2 + h2 + 0.2, { d: 0.26, fs: 10 });
  caption(s, "The compact result, in place: 2 claims, 1 checked live, current", lx + 0.36, y2 + h2 + 0.08, lw - 0.36);

  // right: the full report in the console
  const rx = 6.25, rw = 12.73 - rx, h3 = rw * 765 / 1473;
  image(s, A("crops", "real-inspector.png"), rx, y1, rw, h3, { alt: "HALFLIFE Inspector for that chatgpt.com check: claim current, strong evidence", name: "Screenshot: Inspector for the ChatGPT check (real)" });
  marker(s, 3, rx + 0.13, y1 + h3 + 0.2, { d: 0.26, fs: 10 });
  caption(s, "Open in Halflife: the claim-level report in the console", rx + 0.36, y1 + h3 + 0.08, rw - 0.36);

  // how it works
  const steps = [
    ["Pair once", "A one-time code becomes a revocable, origin-bound token."],
    ["Click to check", "Nothing is sent before the click."],
    ["Analysed locally", "The answer and the question before it go to the engine on 127.0.0.1."],
    ["Same pipeline", "Extraction, risk model and Tavily evidence; learn: false."],
  ];
  const sy = y1 + h3 + 0.48, sg = 0.2, sw = (rw - 3 * sg) / 4;
  steps.forEach(([h, b], i) => {
    const x = rx + i * (sw + sg);
    T(s, String(i + 1).padStart(2, "0"), { x, y: sy, w: 0.4, h: 0.24, fontFace: MONO, fontSize: 10, color: C.em });
    T(s, h, { x, y: sy + 0.26, w: sw, h: 0.28, fontFace: HEAD, fontSize: 11.5, color: C.text });
    T(s, b, { x, y: sy + 0.56, w: sw, h: 0.7, fontSize: 9.5, color: C.text2 });
  });
  T(s, "Real chatgpt.com check, 2026-11-15. Cropped (avatar, timestamp removed); otherwise unedited.", { x: rx, y: 6.72, w: rw, h: 0.25, fontSize: 9, color: C.faint });
  s.addNotes("These three screenshots are a real check on chatgpt.com: the Check freshness button under a finished answer, the compact result HALFLIFE placed under it, and the full report opened from 'Open in Halflife'. The answer said Andy Burnham is the current UK prime minister; HALFLIFE extracted two claims, judged one time-sensitive and at risk, checked it live and found it current with strong evidence. The second claim (he took office on 20 July 2026) is classed as not time-sensitive, so it is not checked. The extension is an opt-in Manifest V3 extension for Chromium browsers, loaded unpacked. Pairing uses a one-time 8-character code valid for 10 minutes, exchanged for a random 256-bit token bound to the extension's origin; the engine stores only its SHA-256. Checks run through the same pipeline as gateway traffic with learn:false, so they never feed the class model. The screenshots were cropped to remove the account avatar and the timestamp; nothing else was changed.");
}

// ================================================================= 9. Claim-level results
{
  const s = newSlide("In use");
  eyebrow(s, "09", "Claim-level results");
  s.addText("Every claim gets its own verdict and evidence", { placeholder: "title" });

  const ix = 0.6, iy = 1.6, iw = 6.7, sc = iw / 1010, ih = 730 * sc;
  image(s, A("crops", "inspector-report.png"), ix, iy, iw, ih, { alt: "Inspector: a two-claim answer, Node.js 22 superseded, React 19 current, cache entry invalidated", name: "Screenshot: Inspector report (crop of 01)" });
  const P = (px, py) => [ix + px * sc, iy + (py - 60) * sc];
  marker(s, 1, ...P(102, 312));
  marker(s, 2, ...P(515, 476));
  marker(s, 3, ...P(590, 172));
  marker(s, 4, ...P(545, 686));
  marker(s, 5, ...P(512, 751));

  const cx = 7.7, cw = 2.0, sc2 = cw / 400, ch = 990 * sc2;
  const cy = iy;
  image(s, A("crops", "claim-panel-top.png"), cx, cy, cw, ch, { alt: "Claim panel: Keir Starmer superseded, now Andy Burnham, three measures and evidence rules", name: "Screenshot: claim panel (crop of 06)" });
  const Q = (px, py) => [cx + px * sc2, cy + py * sc2];
  marker(s, 6, ...Q(385, 143), { d: 0.27, fs: 10 });
  marker(s, 7, ...Q(385, 510), { d: 0.27, fs: 10 });
  marker(s, 8, ...Q(385, 860), { d: 0.27, fs: 10 });

  const lx = 9.95, lw = 2.78;
  const items = [
    ["Claims in place", "each claim highlighted in the answer"],
    ["Per-claim verdict", "class, P(outdated), evidence level"],
    ["Report summary", "claims, at risk, checked, outdated"],
    ["Gateway action", "stale cache entry invalidated"],
    ["Spend", "Tavily credits, LLM calls and tokens"],
    ["Current value", "shown only if a quote states it"],
    ["Three measures", "lifespan, P(outdated), evidence"],
    ["Evidence rules", "sources, recency and quote"],
  ];
  items.forEach(([h, b], i) => {
    const y = iy + i * 0.62;
    marker(s, i + 1, lx + 0.14, y + 0.15, { d: 0.27, fs: 10 });
    T(s, h, { x: lx + 0.38, y: y + 0.01, w: lw - 0.38, h: 0.26, fontFace: HEAD, fontSize: 11.5, color: C.text });
    T(s, b, { x: lx + 0.38, y: y + 0.26, w: lw - 0.38, h: 0.34, fontSize: 9.5, color: C.text2 });
  });
  T(s, "Real reports from development runs (DeepSeek, Tavily), unedited, UTC. Crops of screenshots 01 and 06.", { x: 0.6, y: iy + ih + 0.1, w: 6.7, h: 0.25, fontSize: 9.5, color: C.muted });
  s.addNotes("Left: the Inspector for a real report. The answer said Node.js 22 is the latest major version; HALFLIFE judged it superseded with strong evidence and invalidated the cached answer in Bifrost; React 19 was judged current. The verification was reused inside its reuse window, so the report cost 0 Tavily credits. Note that no new value is shown for Node.js because no verified quote stated one. Right: a claim panel from a verify-mode report. 'Keir Starmer is the current prime minister' was superseded, with the current value and change date taken from verified quotes, and the three measures shown separately. P(outdated) is labelled estimated and uncalibrated in the product.");
}

// ================================================================= 10. Dashboard
{
  const s = newSlide("In use");
  eyebrow(s, "10", "The console");
  s.addText("One console for every report", { placeholder: "title" });
  lede(s, "Gateway traffic, ChatGPT checks, the class model and system health. Vanilla ES modules, live over SSE, no build step.", { y: 1.36, h: 0.4, fontSize: 13.5 });

  const mx = 0.6, my = 1.95, mw = 7.3, mh = mw * 900 / 1440;
  image(s, A("screenshots", "03-traffic-flyout-desktop.png"), mx, my, mw, mh, { alt: "Console with the sidebar and the Traffic panel open beside the Inspector", name: "Screenshot: Traffic flyout (03)" });
  T(s, [{ text: "Inspector with Traffic open. ", options: { color: C.text2 } }, { text: "Traffic lists the latest 100 reports, live; the sidebar holds every page.", options: { color: C.muted } }], { x: mx, y: my + mh + 0.1, w: mw, h: 0.25, fontSize: 9.5 });

  const rx = 8.3, rw = 12.73 - rx;
  const h1 = rw * 540 / 1160;
  image(s, A("crops", "system-integrations.png"), rx, my, rw, h1, { alt: "System page: integrations and plugin counters", name: "Screenshot: System integrations (crop of 08)" });
  caption(s, "System: gateway, plugin heartbeat and counters, judge, Tavily, cache", rx, my + h1 + 0.06, rw);
  const y2 = my + h1 + 0.45, w2 = (rw - 0.18) / 2;
  const hA = w2 * 620 / 628, hB = w2 * 507 / 556;
  image(s, A("crops", "model-chart.png"), rx, y2, w2, hA, { alt: "Freshness model: half-life per class", name: "Screenshot: Freshness model (crop of 07)" });
  image(s, A("crops", "claim-explorer-card.png"), rx + w2 + 0.18, y2, w2, hB, { alt: "Claim explorer: one claim with quote-verified sources", name: "Screenshot: Claim explorer (crop of 11)" });
  caption(s, "Freshness model: half-life per class, prior vs posterior", rx, y2 + hA + 0.06, w2, { h: 0.45 });
  caption(s, "Claim explorer: a real chatgpt.com check", rx + w2 + 0.18, y2 + hA + 0.06, w2, { h: 0.45 });
  s.addNotes("All console screenshots were captured from the running local stack at commit a2a296e in a headed Edge window with the time zone set to UTC. They show real reports from development runs and one real chatgpt.com check made with the extension. The console is served by the engine on port 8090, bound to localhost.");
}

// ================================================================= 11. Bifrost P04
{
  const s = newSlide("Integrations");
  eyebrow(s, "11", "Problem 04  ·  Bifrost");
  s.addText("A gateway extension, not an app beside the gateway", { placeholder: "title" });
  lede(s, "It changes what Bifrost does with each answer: cache lifetimes, no-store for prices, stale-entry invalidation, verify-before-reply.", { y: 1.36, h: 0.4, fontSize: 13.5 });

  // hook lane (request order)
  T(s, "PLUGIN HOOKS, IN REQUEST ORDER", { x: 0.6, y: 2.0, w: 6, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const hooks = [
    ["HTTPTransportPreHook", "report ID, mode header, skip the engine's own calls, capture prompt"],
    ["PreLLMHook", "streams: prompt triage sets TTL or no-store"],
    ["PostLLMHook", "answer triage sets TTL or no-store; verify mode waits for the engine"],
    ["HTTPTransportPostHook", "cache id + hit status, then enqueue the ingest job"],
    ["HTTPTransportStreamChunkHook", "accumulate streamed text; enqueue at the last chunk"],
    ["HTTPTransportResponseHeadersHook", "x-halflife-report, -mode, -ttl, -triage, -cache, -status"],
  ];
  hooks.forEach(([h, d], i) => {
    const y = 2.32 + i * 0.5;
    rect(s, 0.6, y, 6.65, 0.42, { fill: C.surf, line: C.border });
    T(s, h, { x: 0.75, y, w: 3.1, h: 0.42, fontFace: MONO, fontSize: 9.5, color: C.em, valign: "middle" });
    T(s, d, { x: 3.9, y, w: 3.28, h: 0.42, fontSize: 9.5, color: C.text2, valign: "middle" });
  });
  T(s, "Every hook recovers panics and passes the original response through. The hand-off queue is bounded and drops (counted) rather than blocking; if the engine is down, inference is unaffected.", { x: 0.6, y: 5.37, w: 6.65, h: 0.62, fontSize: 10, color: C.muted });

  // right: extension points + stats
  const rx = 7.75, rw = 4.98;
  T(s, "SUPPORTED EXTENSION POINTS USED", { x: rx, y: 2.0, w: rw, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const pts = [
    ["Go plugin (.so)", "placement post_builtin, six hooks"],
    ["Two Relays", "/relay/tavily holds the key; /relay/halflife is VK-gated"],
    ["semantic_cache TTL key", "TTL caps and no-store per answer"],
    ["Cache admin API", "delete confirmed-stale entries"],
    ["Native deepseek provider", "virtual keys with daily $ budgets"],
  ];
  pts.forEach(([h, d], i) => {
    const y = 2.32 + i * 0.5;
    s.addShape(pres.shapes.RECTANGLE, { x: rx, y: y + 0.13, w: 0.14, h: 0.14, fill: { color: C.em }, line: { type: "none" } });
    T(s, h, { x: rx + 0.3, y: y + 0.04, w: 2.1, h: 0.32, fontFace: HEAD, fontSize: 11.5, color: C.text });
    T(s, d, { x: rx + 2.45, y: y + 0.06, w: rw - 2.45, h: 0.38, fontSize: 9.5, color: C.text2 });
  });
  const stats = [["0", "Bifrost source changes"], ["≈42 µs", "all hooks, one request (measured)"], ["6", "hooks, all fail-open"]];
  stats.forEach(([n, l], i) => {
    const w = (rw - 0.3) / 3, x = rx + i * (w + 0.15);
    rect(s, x, 4.95, w, 1.05, { fill: C.surf, line: C.border });
    T(s, n, { x: x + 0.15, y: 5.02, w: w - 0.2, h: 0.5, fontFace: HEAD, fontSize: 24, color: C.em });
    T(s, l, { x: x + 0.15, y: 5.52, w: w - 0.2, h: 0.45, fontSize: 9, color: C.text2 });
  });
  T(s, "Compiled inside Bifrost's transports/v2.4.0 module at pinned commit e869c3f (checked at build) against core/schemas and the Go standard library only. Hook timing measured in Docker with 4 CPUs. Not submitted upstream: no PR or proposal exists.", { x: 0.6, y: 6.2, w: 12.13, h: 0.6, fontSize: 10, color: C.muted });
  s.addNotes("The plugin is a Go .so loaded by Bifrost with placement post_builtin, the only placement that can set the semantic cache's TTL key. It does only microsecond-scale work: correlation IDs, lexical triage from shared/temporal-cues.json, TTL or no-store, text capture, bounded asynchronous hand-off and response headers. The gateway image is built from source because the official image is statically linked and cannot load Go plugins. The two relays mean the engine never holds the Tavily key and reuses Bifrost's virtual-key governance. There is no upstream contribution yet.");
}

// ================================================================= 12. Tavily P06
{
  const s = newSlide("Integrations");
  eyebrow(s, "12", "Problem 06  ·  Tavily");
  s.addText("Live evidence, spent only where risk is high", { placeholder: "title" });
  lede(s, "A model cannot know about changes after its training cutoff; current web sources can. Tavily is asked only about the riskiest claims.", { y: 1.36, h: 0.4, fontSize: 13.5 });

  // ladder
  T(s, "VERIFICATION LADDER, PER AT-RISK CLAIM", { x: 0.6, y: 2.0, w: 6, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const tiers = [
    ["T0", "Reuse", "A stored verdict for the same normalised claim, inside its reuse window.", "0 credits"],
    ["T1", "Search", "Tavily search: basic depth, 5 results, published dates, topic by class.", "1 credit"],
    ["T2", "Extract", "Tavily extract on the top 2 URLs, only if no quote from T1 verified.", "≈ 1 credit"],
  ];
  const lw = 5.6;
  tiers.forEach(([k, h, d, c], i) => {
    const y = 2.32 + i * 1.0, x = 0.6 + i * 0.25;
    rect(s, x, y, lw - i * 0.25, 0.78, { fill: C.surf, line: i === 0 ? C.emDim : C.border2 });
    T(s, k, { x: x + 0.15, y: y + 0.12, w: 0.5, h: 0.3, fontFace: MONO, fontSize: 13, color: C.em });
    T(s, h, { x: x + 0.65, y: y + 0.1, w: 1.5, h: 0.3, fontFace: HEAD, fontSize: 13, color: C.text });
    T(s, c, { x: x + lw - i * 0.25 - 1.2, y: y + 0.11, w: 1.05, h: 0.28, fontFace: MONO, fontSize: 10, color: i === 0 ? C.em : C.orange, align: "right" });
    T(s, d, { x: x + 0.65, y: y + 0.4, w: lw - i * 0.25 - 0.8, h: 0.36, fontSize: 9.5, color: C.text2 });
  });
  // evidence rules
  T(s, "EVIDENCE LEVEL, FROM EXPLICIT RULES", { x: 0.6, y: 5.42, w: 6, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const ev = [["strong", "≥ 2 independent sites, a recent source, nothing conflicting"], ["moderate", "a recent source or ≥ 2 sites, nothing conflicting"], ["weak / none", "anything less; a verdict without a verified quote is unverifiable"]];
  ev.forEach(([k, d], i) => {
    const y = 5.72 + i * 0.34;
    T(s, k, { x: 0.6, y, w: 1.15, h: 0.3, fontFace: MONO, fontSize: 10, color: i === 0 ? C.em : i === 1 ? C.text : C.muted });
    T(s, d, { x: 1.8, y, w: 4.5, h: 0.3, fontSize: 10, color: C.text2 });
  });

  // example screenshot
  const ex = 6.75, ew = 2.45, eh = ew * 700 / 400;
  image(s, A("crops", "claim-panel-sources.png"), ex, 2.0, ew, eh, { alt: "Sources for the Keir Starmer claim, quotes found in source", name: "Screenshot: quote-verified sources (crop of 06)" });
  // right: the example walk-through
  const rx = 9.55, rw = 12.73 - rx;
  T(s, "A REAL REPORT", { x: rx, y: 2.0, w: rw, h: 0.22, fontFace: MONO, fontSize: 9, color: C.em, charSpacing: 1.5 });
  T(s, "“Keir Starmer is the current prime minister of the United Kingdom.”", { x: rx, y: 2.3, w: rw, h: 0.8, fontFace: "Cambria", fontSize: 13.5, color: C.text });
  const facts = [
    ["Class", "Government office holder"],
    ["Verdict", "superseded"],
    ["Now", "Andy Burnham\nchanged 2026-07-20"],
    ["Evidence", "strong: 4 independent sources agree; newest 2026-07-24"],
    ["Quotes", "each checked against the fetched page in code"],
  ];
  facts.forEach(([k, v], i) => {
    const y = 3.2 + i * 0.5;
    T(s, k, { x: rx, y, w: 0.85, h: 0.45, fontFace: MONO, fontSize: 9.5, color: C.muted });
    T(s, v, { x: rx + 0.88, y, w: rw - 0.88, h: 0.48, fontSize: 10.5, color: k === "Verdict" ? C.red : C.text2 });
  });
  T(s, "The engine never holds the Tavily key: every call goes through Bifrost's /relay/tavily, after the credit guard reserves it.", { x: rx, y: 5.85, w: rw, h: 0.85, fontSize: 9.5, color: C.muted });
  caption(s, "Screenshot 06 (sources section), real data, unedited", ex, 2.0 + eh + 0.06, ew + 0.2, { fontSize: 8.5 });
  s.addNotes("The ladder keeps search spend proportional to risk. T0 reuses a stored verdict inside its reuse window for free; T1 is one basic Tavily search with published dates; T2 extracts the two top URLs only when no quote from the search could be verified. Tavily's published_date can be wrong for evergreen pages, which is a documented limitation. The example is a real verify-mode report: the claim was superseded, and the current value and change date come from quotes found in the fetched pages.");
}

// ================================================================= 13. Engineering
{
  const s = newSlide("Engineering");
  eyebrow(s, "13", "Engineering and implementation");
  s.addText("Small, dependency-free components with hard boundaries", { placeholder: "title" });

  const cols = [
    { x: 0.6, w: 2.2, title: "plugin/", sub: "Go · 1,262 lines", col: C.em, items: ["main.go · six hooks", "triage.go · lexical cues", "state.go · per-request", "ingest.go · bounded queue", "config.go"], foot: "stdlib + bifrost/core/schemas only" },
    { x: 3.0, w: 4.6, title: "engine/src/", sub: "Node 24 TypeScript · 3,715 lines · 0 npm deps", col: C.em, groups: [
      ["intake", ["server.ts", "pipeline.ts"]], ["extraction", ["extract.ts", "prompts.ts", "llm.ts"]],
      ["model", ["classes.ts", "asof.ts", "freshness.ts", "learn.ts"]], ["verification", ["verify.ts", "tavily.ts", "evidence.ts", "credits.ts"]],
      ["output", ["cache.ts", "store.ts", "events.ts"]], ["extension", ["extension.ts"]],
    ] },
    { x: 7.8, w: 2.35, title: "engine/console/", sub: "vanilla ES modules · 2,860 lines", col: C.text, items: ["app.js · shell, sidebar", "traffic.js · live list", "views/ · 9 pages", "lib.js, styles.css", "strict CSP, ETag"], foot: "no framework, no build step" },
    { x: 10.35, w: 2.38, title: "extension/", sub: "Manifest V3 · 1,011 lines", col: C.text, items: ["adapters/chatgpt.js", "content.js · button, result", "background.js · token", "popup/", "loopback only"], foot: "token in IndexedDB" },
  ];
  const top = 1.62, H = 3.95;
  for (const c of cols) {
    rect(s, c.x, top, c.w, H, { fill: C.surf, line: C.border });
    T(s, c.title, { x: c.x + 0.18, y: top + 0.15, w: c.w - 0.3, h: 0.3, fontFace: MONO, fontSize: 13, color: c.col });
    T(s, c.sub, { x: c.x + 0.18, y: top + 0.47, w: c.w - 0.3, h: 0.25, fontSize: 9.5, color: C.muted });
    if (c.items) {
      c.items.forEach((t, i) => chip(s, t, c.x + 0.18, top + 0.9 + i * 0.44, c.w - 0.36, { h: 0.34, fs: 9, color: C.text2 }));
      T(s, c.foot, { x: c.x + 0.18, y: top + H - 0.4, w: c.w - 0.3, h: 0.25, fontSize: 9, color: C.muted });
    } else {
      // engine: groups in pipeline order, two columns of three
      c.groups.forEach(([g, files], i) => {
        const col = i % 2, row = Math.floor(i / 2);
        const gx = c.x + 0.18 + col * 2.17, gy = top + 0.9 + row * 1.0, gw = 2.07;
        T(s, g.toUpperCase(), { x: gx, y: gy, w: gw, h: 0.2, fontFace: MONO, fontSize: 8.5, color: C.em, charSpacing: 1 });
        T(s, files.join("\n"), { x: gx, y: gy + 0.24, w: gw, h: 0.7, fontFace: MONO, fontSize: 9, color: C.text2, lineSpacingMultiple: 0.95 });
      });
    }
  }
  // deploy row
  const dy = top + H + 0.25;
  rect(s, 0.6, dy, 12.13, 0.62, { fill: C.surf, line: C.border });
  T(s, "deploy/", { x: 0.78, y: dy, w: 1.0, h: 0.62, fontFace: MONO, fontSize: 12, color: C.text, valign: "middle" });
  T(s, "docker-compose.yml  ·  gateway.Dockerfile (Bifrost from source, pinned)  ·  render-config.mjs (env.NAME refs only)  ·  setup.mjs  ·  test/", { x: 1.8, y: dy, w: 10.8, h: 0.62, fontFace: MONO, fontSize: 9, color: C.text2, valign: "middle" });
  // principles
  const pr = ["The LLM never produces a number", "Spans and quotes are checked in code", "Plugin: microseconds. Engine: the rest", "Untrusted text is passed as data"];
  const pw = (12.13 - 3 * 0.2) / 4;
  pr.forEach((t, i) => T(s, [{ text: "—  ", options: { color: C.em } }, { text: t, options: { color: C.text2 } }], { x: 0.6 + i * (pw + 0.2), y: dy + 0.82, w: pw, h: 0.3, fontSize: 10.5 }));
  s.addNotes("Line counts are non-test source lines from git ls-files at the time this deck was built (plugin 1,262 Go; engine/src 3,715; console 2,860; extension 1,011 including the popup). The engine has zero npm dependencies: it uses Node 24's native TypeScript stripping, node:sqlite, node:http and node:test. The judge model returns spans, a class from a closed list, dates, a verdict enum and quotes; all numbers come from code.");
}

// ================================================================= 14. Security and spend
{
  const s = newSlide("Engineering");
  eyebrow(s, "14", "Privacy, security and spending safeguards");
  s.addText("Safeguards that exist in the code today", { placeholder: "title" });

  const L = [
    ["Keys stay in the gateway", "Provider and Tavily keys live only in the gateway's environment; the rendered config holds env.NAME references. The engine never sees them."],
    ["Separate caller credentials", "Plugin ingest token, relay bearer injected by Bifrost, console header with optional token, extension token. Constant-time comparison."],
    ["Revocable extension pairing", "One-time 8-character code (10 min) → 256-bit token; only its SHA-256 is stored, bound to the extension origin. Loopback Host only; 403 through the relay."],
    ["Untrusted text as data", "Answers and pages are delimited in prompts; outputs schema-validated; spans and quotes checked against their sources."],
    ["Local data, no telemetry", "SQLite on a local volume, 14-day report retention (extension checks 30 days). Ports bind to 127.0.0.1. Data leaves only to the LLM provider and Tavily."],
  ];
  L.forEach(([h, b], i) => {
    const y = 1.62 + i * 0.86;
    T(s, h, { x: 0.6, y, w: 5.9, h: 0.28, fontFace: HEAD, fontSize: 12.5, color: C.text });
    T(s, b, { x: 0.6, y: y + 0.29, w: 5.9, h: 0.55, fontSize: 10, color: C.text2 });
  });

  // spend funnel
  const fx = 7.0, fw = 5.73;
  T(s, "TAVILY SPEND, LAYERED", { x: fx, y: 1.62, w: fw, h: 0.22, fontFace: MONO, fontSize: 9, color: C.muted, charSpacing: 1 });
  const layers = [
    ["Per answer", "verify only if P(outdated) ≥ 20%, at most 3 claims"],
    ["Reuse window", "a recent verdict is reused for 0 credits"],
    ["Daily cap", "150 credits (operator setting)"],
    ["Lifetime cap", "700 credits (operator setting)"],
    ["Account guard", "≤ 80% of the allowance Tavily's /usage reports (max 95%)"],
    ["Bifrost VK budget", "daily dollar budget on the engine key → HTTP 402"],
  ];
  layers.forEach(([h, b], i) => {
    const inset = i * 0.12, y = 1.95 + i * 0.6;
    rect(s, fx + inset, y, fw - 2 * inset, 0.5, { fill: i === 4 ? C.emTint : C.surf, line: i === 4 ? C.emDim : C.border });
    T(s, h, { x: fx + inset + 0.15, y, w: 1.55, h: 0.5, fontFace: HEAD, fontSize: 11, color: C.text, valign: "middle" });
    T(s, b, { x: fx + inset + 1.72, y, w: fw - 2 * inset - 1.85, h: 0.5, fontSize: 9.5, color: C.text2, valign: "middle" });
  });
  T(s, "The account guard refuses paid calls on any pay-as-you-go usage, or when usage or a finite allowance cannot be read. No allowance is hardcoded. A claim refused by any layer is reported as not checked: budget, never given a verdict and never retried.", { x: fx, y: 5.6, w: fw, h: 0.75, fontSize: 9.5, color: C.muted });

  rect(s, 0.6, 6.42, 12.13, 0.45, { fill: C.amberTint, line: "4A3A12" });
  T(s, [{ text: "Limits.  ", options: { color: C.amber, fontFace: HEAD } }, { text: "No external security review. The console has no authentication unless HALFLIFE_CONSOLE_TOKEN is set; run it on localhost only.", options: { color: C.text2 } }], { x: 0.78, y: 6.42, w: 11.8, h: 0.45, fontSize: 10.5, valign: "middle" });
  s.addNotes("Every item here is implemented: see docs/SECURITY.md, engine/src/extension.ts, engine/src/credits.ts and deploy/render-config.mjs. The daily and lifetime caps are operator settings and are never derived from the provider's allowance. The account guard reads Tavily's own /usage figures through the relay, counts every credit it reserves locally because Tavily's counter can lag by hours, and clamps the ceiling fraction to 0.95 in code. Residual risks: any local process with the extension token can submit checks; without a console token, any local process can use the console API.");
}

// ================================================================= 15. Testing
{
  const s = newSlide("Validation");
  eyebrow(s, "15", "Testing and validation");
  s.addText("Automated suites, and what real-world runs showed", { placeholder: "title" });

  const suites = [
    ["76/76", "Engine", "Unit + HTTP: freshness grid vs analytic Lomax, credit guard, pipeline, extension routes. No Docker, no keys.", "re-run 2026-11-15"],
    ["15/15", "Console UI", "Headless Edge/Chrome against a TEST FIXTURE engine: sidebar, Traffic flyout, phone sheet, System states.", "2026-11-03"],
    ["14/14", "Extension", "8 adapter + 6 end-to-end with the real unpacked extension on a fixture ChatGPT page.", "2026-11-03"],
    ["13/13", "Integration", "Real Bifrost binary, plugin and engine; scripted fixtures replace the LLM and Tavily. No credentials, no spend.", "2026-11-03"],
    ["21/21", "Go plugin", "Plugin tests with -race, plus benchmarks, built in Docker.", "2026-11-02; not re-run, plugin unchanged"],
  ];
  const w = (12.13 - 4 * 0.2) / 5;
  suites.forEach(([n, name, d, when], i) => {
    const x = 0.6 + i * (w + 0.2), y = 1.62;
    rect(s, x, y, w, 2.6, { fill: C.surf, line: C.border });
    T(s, n, { x: x + 0.18, y: y + 0.12, w: w - 0.3, h: 0.6, fontFace: HEAD, fontSize: 28, color: C.em });
    T(s, name, { x: x + 0.18, y: y + 0.74, w: w - 0.3, h: 0.3, fontFace: HEAD, fontSize: 13, color: C.text });
    T(s, d, { x: x + 0.18, y: y + 1.06, w: w - 0.3, h: 1.1, fontSize: 9.5, color: C.text2 });
    T(s, when, { x: x + 0.18, y: y + 2.18, w: w - 0.3, h: 0.36, fontFace: MONO, fontSize: 8.5, color: C.muted });
  });

  // real-world
  const by = 4.5;
  T(s, "REAL-SERVICE VALIDATION  ·  NOT AUTOMATED", { x: 0.6, y: by, w: 6, h: 0.22, fontFace: MONO, fontSize: 9, color: C.em, charSpacing: 1 });
  const ev = [
    ["Detection", "precision 85.5%, recall 97.9% · 100 FreshQA items, 0 credits"],
    ["Verification", "stale precision 95.8% of decided items · 59 items (29 stale, 30 current)"],
    ["Cost and latency", "1.04 Tavily credits per searched claim · p50 3.9 s, p95 7.9 s"],
    ["ChatGPT", "one manual pass on real chatgpt.com by the maintainer"],
  ];
  ev.forEach(([k, v], i) => {
    const y = by + 0.32 + i * 0.42;
    T(s, k, { x: 0.6, y, w: 1.55, h: 0.36, fontSize: 10.5, color: C.text, fontFace: HEAD });
    T(s, v, { x: 2.2, y, w: 4.3, h: 0.4, fontSize: 10, color: C.text2 });
  });
  T(s, "FreshQA snapshots 2024-02-26 and 2026-04-21, live DeepSeek and Tavily, measured 2026-11-02.", { x: 0.6, y: 6.5, w: 6, h: 0.3, fontSize: 9, color: C.muted });

  const cx = 6.95, cw = 5.78;
  rect(s, cx, by, cw, 2.05, { fill: C.surf, line: C.border });
  T(s, "CAVEATS", { x: cx + 0.2, y: by + 0.14, w: 3, h: 0.22, fontFace: MONO, fontSize: 9, color: C.orange, charSpacing: 1.5 });
  T(s, [
    { text: "Extension suite failed once (9/14, a pairing timeout that cascaded), then passed 14/14 twice on unchanged code. Cause not identified.", options: { bullet: { indent: 12 }, breakLine: true, paraSpaceAfter: 4 } },
    { text: "Small evaluation sets, one judge model; disputed items adjudicated by the AI assistant that built the system, not independent humans.", options: { bullet: { indent: 12 }, breakLine: true, paraSpaceAfter: 4 } },
    { text: "Calibration of P(outdated) was not measured. UI tests cover Edge and Chrome only. No hosted CI.", options: { bullet: { indent: 12 } } },
  ], { x: cx + 0.2, y: by + 0.44, w: cw - 0.4, h: 1.8, fontSize: 10, color: C.text2 });
  s.addNotes("The engine suite (76/76) was re-run on 2026-11-15 while preparing this deck. The other figures come from the project records (research/PROJECT_STATE.md, session 15, 2026-11-03); the Go plugin suite was last run on 2026-11-02 and not re-run because the plugin has not changed since. The FreshQA evaluation used real services and is described with its caveats in docs/EVALUATION.md. Automated suites use labelled test fixtures; they are not real-world demonstrations.");
}

// ================================================================= 16. Limitations
{
  const s = newSlide("Validation");
  eyebrow(s, "16", "Limitations and future work");
  s.addText("What is not solved yet", { placeholder: "title" });

  const rows = [
    ["Calibration", "P(outdated) comes from hand-set priors and few verified outcomes; calibration not measured.", "Calibration study on a larger labelled set"],
    ["Evaluation", "100 + 59 items, one judge model, adjudicated by the building AI assistant.", "Larger set, independent human adjudication, more judges"],
    ["Evidence", "Replacement values: 2 of 26 wrong. Published dates can be wrong; date or count reasoning errors.", "Stronger grounding of replacement values"],
    ["Scope", "Freshness only: a wrong static fact passes through unchecked.", "By design; keep separate from fact-checking"],
    ["Extension", "Depends on ChatGPT's page markup; Chromium only; text answers; not in a store.", "Adapter hardening, more browsers and assistants"],
    ["Providers", "Only DeepSeek verified end to end; other Bifrost providers configured but untested.", "Exercise the other configured providers"],
    ["Operations", "Single node, SQLite, not load-tested, no CI; console token optional.", "Shared store, load tests, CI, stronger auth"],
    ["Upstream", "No Bifrost pull request or proposal.", "Propose the plugin pattern upstream"],
  ];
  const head = (t) => ({ text: t, options: { fontFace: MONO, fontSize: 9, color: C.muted, fill: { color: C.bg }, bold: false } });
  const data = [[head("AREA"), head("LIMITATION TODAY"), head("POSSIBLE NEXT STEP (NOT DONE)")]];
  rows.forEach(([a, b, c]) => data.push([
    { text: a, options: { fontFace: HEAD, fontSize: 11, color: C.text } },
    { text: b, options: { fontSize: 10.5, color: C.text2 } },
    { text: c, options: { fontSize: 10.5, color: C.em } },
  ]));
  s.addTable(data, {
    x: 0.6, y: 1.55, w: 12.13, colW: [1.6, 6.33, 4.2], rowH: 0.56, fill: { color: C.bg }, fontFace: BODY,
    border: { type: "solid", pt: 0.75, color: C.border }, valign: "middle", margin: [0.04, 0.12, 0.04, 0.12],
  });
  s.addNotes("These limitations are taken from the README's Known limitations, docs/SECURITY.md and research/SUBMISSION.md. The right-hand column lists possible next steps only; none of them has been started.");
}

// ================================================================= 17. Hackathon alignment
{
  const s = newSlide("Validation");
  eyebrow(s, "17", "Hackathon alignment");
  s.addText("How HALFLIFE answers both problems", { placeholder: "title" });

  const colw = 5.9;
  const cols = [
    { x: 0.6, k: "PROBLEM 04", h: "A useful, documented, tested Bifrost extension on supported extension points", rows: [
      ["Real operational problem", "Stale answers served from cache; outdated model knowledge"],
      ["Supported extension points", ".so plugin (6 hooks), 2 relays, TTL key, cache admin API; 0 core changes"],
      ["Documented", "README, Architecture, Installation, Development, Security; 38 decision records"],
      ["Tested", "21 Go plugin tests with -race; 13 integration checks on real Bifrost"],
      ["Reproducible", "setup.mjs + Docker Compose; pinned Bifrost commit checked at build"],
    ] },
    { x: 0.6 + colw + 0.33, k: "PROBLEM 06", h: "Find stale claims, verify them against current sources, report per claim", rows: [
      ["Claim identification", "LLM extraction with verbatim spans; claims for 93 of 100 FreshQA answers"],
      ["Freshness detection", "18-class model + as-of date; recall 97.9%, precision 85.5% (100 items)"],
      ["Live verification", "Tavily via a Bifrost relay; quotes verified in code; stale precision 95.8% of decided"],
      ["Claim-level output", "Verdict, evidence level and sources per claim in API, console and extension"],
      ["Cost awareness", "Risk threshold, reuse window, layered credit guard"],
    ] },
  ];
  for (const c of cols) {
    T(s, c.k, { x: c.x, y: 1.55, w: colw, h: 0.25, fontFace: MONO, fontSize: 11, color: C.em, charSpacing: 2 });
    T(s, c.h, { x: c.x, y: 1.85, w: colw, h: 0.6, fontFace: HEAD, fontSize: 14, color: C.text });
    c.rows.forEach(([r, e], i) => {
      const y = 2.6 + i * 0.78;
      rect(s, c.x, y, colw, 0.68, { fill: C.surf, line: C.border });
      T(s, r, { x: c.x + 0.16, y: y + 0.08, w: 2.0, h: 0.52, fontFace: HEAD, fontSize: 11, color: C.text, valign: "middle" });
      T(s, e, { x: c.x + 2.2, y: y + 0.08, w: colw - 2.35, h: 0.54, fontSize: 10, color: C.text2, valign: "middle" });
    });
  }
  T(s, "Requirement wording follows the brief as provided to the team; the official rubric was not independently confirmed. No judging outcome is implied.", { x: 0.6, y: 6.55, w: 12.13, h: 0.3, fontSize: 9.5, color: C.muted });
  s.addNotes("Every piece of evidence on this slide can be traced to the repository: the plugin and relays in plugin/ and deploy/render-config.mjs, the documentation in docs/ and research/ARCHITECTURE_DECISIONS.md (AD-01 to AD-38), the test suites, and the FreshQA evaluation in docs/EVALUATION.md. The evaluation figures carry the caveats shown on the testing slide.");
}

// ================================================================= 18. Closing
{
  const s = newSlide("Closing", "HL_COVER");
  decayChart(s, { x: 7.35, y: 1.35, w: 5.3, h: 4.1 }, {
    labelSize: 10,
    series: [
      { static: true, color: C.faint, dash: "dash", width: 1.5, label: "Historical fact" },
      { L: 1 * DAY, a: 2, color: C.orange, label: "Market price" },
      { L: 120 * DAY, a: 2, color: C.em, label: "Software version", labelSide: "left", labelDy: 0.12 },
      { L: 4, a: 2, color: C.text, label: "Office holder" },
    ],
  });
  T(s, "Information has a lifetime.", { x: 0.75, y: 1.6, w: 6.2, h: 1.6, fontFace: HEAD, fontSize: 40, color: C.text });
  T(s, "AI answers should be evaluated with that in mind: claim by claim, with evidence, and with the cost of checking in proportion to the risk.", { x: 0.75, y: 3.25, w: 5.8, h: 1.1, fontSize: 16, color: C.text2 });
  mark(s, 0.75, 4.85, 0.5);
  T(s, "HALFLIFE", { x: 1.4, y: 4.82, w: 4, h: 0.56, fontFace: HEAD, fontSize: 26, color: C.text, charSpacing: 2, valign: "middle" });
  T(s, "A freshness-verification layer for AI conversations.", { x: 0.75, y: 5.5, w: 6, h: 0.35, fontSize: 14, color: C.em });
  T(s, "github.com/fazeprism25/halflife  ·  Problem 04 (Bifrost)  ·  Problem 06 (Tavily)", { x: 0.75, y: 6.6, w: 6.4, h: 0.3, fontFace: MONO, fontSize: 9.5, color: C.muted });
  s.addNotes("Close on the central idea: a claim's freshness depends on what kind of fact it is and how old it is. HALFLIFE estimates that risk per claim, verifies the risky claims against live evidence, and reports a verdict per claim, while staying honest that its risk estimate is uncalibrated and that it is not a general fact-checker.");
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  if (THEME_SCRIPT) {
    const { applyTheme } = require(THEME_SCRIPT);
    await applyTheme(OUT, {
      name: "Halflife Dark",
      colors: { dk1: C.bg, lt1: C.text, dk2: C.surf2, lt2: C.text2, accent1: C.em, accent2: C.orange, accent3: C.red, accent4: C.amber, accent5: C.muted, accent6: C.emDim, hlink: C.em, folHlink: C.text2 },
    });
  }
  console.log("wrote", OUT);
})().catch((e) => { console.error(e); process.exit(1); });
