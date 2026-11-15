// Builds HALFLIFE_Video_Slides.pptx (repository root): the slides for the demo video, from the
// opening up to the live product demo. Made for Google Slides (fonts are Google Fonts; the decay
// chart is a PNG so it survives import unchanged). Speaker notes hold the voiceover.
//
//   NODE_PATH=<folder with pptxgenjs + sharp> node presentation_assets/build/build_video_deck.js
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..", "..");
const A = (...p) => path.join(ROOT, "presentation_assets", ...p);
const OUT = process.env.OUT_FILE || path.join(ROOT, "HALFLIFE_Video_Slides.pptx");

const C = {
  bg: "0D0D0C", surf: "151514", surf2: "1C1C1A", border: "2B2B29", border2: "3D3D3A",
  text: "F0EFEC", text2: "C3C2B7", muted: "8F8E86", faint: "6A6963",
  em: "3CCB7F", emTint: "11251A",
  red: "EF7D7D", redTint: "2A1717", amber: "FAB219", amberTint: "2A2210",
  blue: "3987E5", blueTint: "101C2C",
};
// QA_FONTS=1 swaps in locally installed fonts for preview renders only.
const QA = !!process.env.QA_FONTS;
const HEAD = QA ? "Arial" : "Inter SemiBold";
const BODY = QA ? "Arial" : "Inter";
const MONO = QA ? "Consolas" : "JetBrains Mono";
const SERIF = "Georgia";

// Class priors copied from engine/src/classes.ts: [label, mean lifetime L (years), shape a]
const DAY = 1 / 365.25;
const PRIORS = {
  price: ["Market price", 1 * DAY, 2],
  version: ["Software version", 120 * DAY, 2],
  office: ["Government office holder", 4, 2],
};
const survival = (L, a, t) => Math.pow((a * L) / (a * L + t), a);
const halfLife = (L, a) => a * L * (Math.pow(2, 1 / a) - 1);
function fmtYears(y) {
  if (y < 2 / 365.25) return `~${Math.round(y * 8766)} hours`;
  if (y < 1) return `~${Math.round(y * 12 * 10) / 10} months`;
  return `~${Math.round(y * 10) / 10} years`;
}

// ---------------------------------------------------------------- decay chart as PNG
async function decayPng(file) {
  const W = 1600, H = 1000, L0 = 110, R0 = 40, T0 = 70, B0 = 110;
  const pw = W - L0 - R0, ph = H - T0 - B0;
  const LO = Math.log10(1 / 8766), HI = 2;
  const X = (lt) => L0 + ((lt - LO) / (HI - LO)) * pw;
  const Y = (p) => T0 + (1 - p) * ph;
  const col = { price: "#EF7D7D", version: "#FAB219", office: "#3987E5", hist: "#C3C2B7" };
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><style>text{font-family:'Segoe UI',Arial,sans-serif}</style>`;
  s += `<line x1="${L0}" y1="${Y(0)}" x2="${L0 + pw}" y2="${Y(0)}" stroke="#3D3D3A" stroke-width="2"/>`;
  s += `<line x1="${L0}" y1="${Y(1)}" x2="${L0}" y2="${Y(0)}" stroke="#3D3D3A" stroke-width="2"/>`;
  s += `<line x1="${L0}" y1="${Y(0.5)}" x2="${L0 + pw}" y2="${Y(0.5)}" stroke="#5E5D58" stroke-width="2" stroke-dasharray="10 10"/>`;
  for (const [lab, p] of [["100%", 1], ["50%", 0.5], ["0%", 0]]) s += `<text x="${L0 - 16}" y="${Y(p) + 9}" fill="#8F8E86" font-size="26" text-anchor="end">${lab}</text>`;
  const ticks = [["1 h", LO], ["1 day", Math.log10(DAY)], ["1 wk", Math.log10(7 * DAY)], ["1 mo", Math.log10(1 / 12)], ["1 yr", 0], ["10 yr", 1], ["100 yr", 2]];
  for (const [lab, lt] of ticks) {
    s += `<line x1="${X(lt)}" y1="${Y(0)}" x2="${X(lt)}" y2="${Y(0) + 10}" stroke="#3D3D3A" stroke-width="2"/>`;
    s += `<text x="${X(lt)}" y="${Y(0) + 44}" fill="#8F8E86" font-size="26" text-anchor="middle">${lab}</text>`;
  }
  s += `<text x="${L0}" y="${T0 - 30}" fill="#8F8E86" font-size="26">chance the claim is still true</text>`;
  s += `<text x="${L0 + pw / 2}" y="${H - 18}" fill="#8F8E86" font-size="26" text-anchor="middle">time since the claim was last known to be true (log scale)</text>`;
  const path = (fn) => { let d = ""; for (let i = 0; i <= 300; i++) { const lt = LO + ((HI - LO) * i) / 300; d += (i ? "L" : "M") + X(lt).toFixed(1) + " " + Y(fn(Math.pow(10, lt))).toFixed(1); } return d; };
  s += `<path d="${path(() => 1)}" fill="none" stroke="${col.hist}" stroke-width="5" stroke-dasharray="16 12"/>`;
  s += `<text x="${L0 + pw}" y="${Y(1) + 42}" fill="${col.hist}" font-size="30" text-anchor="end">Historical fact: never expires</text>`;
  const lab = { price: [24, -40, "start"], version: [-46, -36, "end"], office: [-46, -36, "end"] };
  for (const k of ["price", "version", "office"]) {
    const [name, Lm, a] = PRIORS[k];
    s += `<path d="${path((t) => survival(Lm, a, t))}" fill="none" stroke="${col[k]}" stroke-width="6"/>`;
    const hx = X(Math.log10(halfLife(Lm, a))), hy = Y(0.5);
    s += `<circle cx="${hx}" cy="${hy}" r="13" fill="${col[k]}" stroke="#0D0D0C" stroke-width="4"/>`;
    const short = { price: "Market price", version: "Software version", office: "Office holder" }[k];
    s += `<text x="${hx + lab[k][0]}" y="${hy + lab[k][1]}" fill="${col[k]}" font-size="30" font-weight="600" text-anchor="${lab[k][2]}">${short}</text>`;
  }
  s += `</svg>`;
  await sharp(Buffer.from(s)).png().toFile(file);
}

// ---------------------------------------------------------------- deck
async function main() {
  const curves = path.join(require("os").tmpdir(), "halflife-decay.png");
  await decayPng(curves);

  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
  pres.title = "HALFLIFE: demo video slides";
  pres.author = "The Halflife authors";
  pres.company = "Halflife";
  pres.theme = { headFontFace: HEAD, bodyFontFace: BODY };

  const FOOTER = "HALFLIFE  ·  Geek Room Global AI Hackathon 2026";
  pres.defineSlideMaster({
    title: "HL_CONTENT", background: { color: C.bg },
    objects: [{ text: { text: FOOTER, options: { x: 0.6, y: 7.02, w: 8, h: 0.28, fontFace: MONO, fontSize: 9, color: C.faint, margin: 0, valign: "middle" } } }],
    slideNumber: { x: 12.03, y: 7.02, w: 0.7, h: 0.28, fontFace: MONO, fontSize: 9, color: C.faint, align: "right", valign: "middle", margin: 0 },
  });
  pres.defineSlideMaster({ title: "HL_PLAIN", background: { color: C.bg }, objects: [] });

  const T = (s, text, o) => s.addText(text, Object.assign({ isTextBox: true, margin: 0, fontFace: BODY, fontSize: 14, color: C.text, valign: "top", fit: "none" }, o));
  const box = (s, x, y, w, h, o = {}) => s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: o.fill === null ? { type: "none" } : { color: o.fill || C.surf }, line: o.line === null ? { type: "none" } : { color: o.line || C.border, width: o.lw || 1, dashType: o.dash || "solid" } });
  const line = (s, x1, y1, x2, y2, o = {}) => {
    const ln = { color: o.color || C.text2, width: o.width || 1.5, dashType: o.dash || "solid" };
    if (o.arrow !== false) ln.endArrowType = "triangle";
    if (o.both) ln.beginArrowType = "triangle";
    s.addShape(pres.shapes.LINE, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), flipH: x2 < x1, flipV: y2 < y1, line: ln });
  };
  const eyebrow = (s, num, label) => T(s, [{ text: num, options: { color: C.em } }, { text: "  /  " + label.toUpperCase(), options: { color: C.muted } }], { x: 0.6, y: 0.4, w: 10, h: 0.28, fontFace: MONO, fontSize: 11, charSpacing: 1.5 });
  const title = (s, text) => T(s, text, { x: 0.6, y: 0.75, w: 12.1, h: 0.75, fontFace: HEAD, fontSize: 32 });
  const lede = (s, text, y = 1.55) => T(s, text, { x: 0.6, y, w: 11.8, h: 0.5, fontSize: 16, color: C.text2 });
  const chip = (s, text, x, y, w, o = {}) => {
    const h = o.h || 0.36;
    box(s, x, y, w, h, { fill: o.fill || C.surf2, line: o.line || C.border2 });
    T(s, text, { x, y, w, h, fontFace: o.font || MONO, fontSize: o.fs || 11, color: o.color || C.text2, align: "center", valign: "middle", bold: !!o.bold });
  };
  const num = (s, n, x, y, color, d = 0.36) => {
    s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color }, line: { type: "none" } });
    T(s, String(n), { x, y, w: d, h: d, fontFace: HEAD, fontSize: 13, color: C.bg, align: "center", valign: "middle" });
  };
  const mark = (s, x, y, d) => s.addImage({ path: A("brand", "halflife-mark-dark.png"), x, y, w: d, h: d, altText: "Halflife mark" });

  // ============================================================ 1. Opening hook
  {
    const s = pres.addSlide({ masterName: "HL_PLAIN" });
    T(s, "A REAL AI ANSWER", { x: 1.0, y: 1.0, w: 8, h: 0.3, fontFace: MONO, fontSize: 12, color: C.muted, charSpacing: 3 });
    const red = { color: C.red, underline: { style: "sng", color: C.red } };
    const grn = { color: C.em, underline: { style: "sng", color: C.em } };
    T(s, [
      { text: "“As of my knowledge cutoff, " },
      { text: "the latest major version of Node.js is Node.js 22", options: red },
      { text: ", and " },
      { text: "the latest major version of React is React 19", options: grn },
      { text: ".”" },
    ], { x: 1.0, y: 1.5, w: 11.3, h: 2.2, fontFace: SERIF, fontSize: 34, color: C.text, lineSpacingMultiple: 1.15 });

    box(s, 1.0, 4.05, 5.45, 1.05, { fill: C.redTint, line: C.red });
    T(s, [{ text: "Superseded", options: { bold: true, color: C.red, breakLine: true } }, { text: "Node.js 26 has since been released (May 2026)", options: { color: C.text2, fontSize: 14 } }], { x: 1.25, y: 4.2, w: 5.0, h: 0.8, fontSize: 18 });
    box(s, 6.75, 4.05, 5.55, 1.05, { fill: C.emTint, line: C.em });
    T(s, [{ text: "Current", options: { bold: true, color: C.em, breakLine: true } }, { text: "React 19 is still the latest major version", options: { color: C.text2, fontSize: 14 } }], { x: 7.0, y: 4.2, w: 5.1, h: 0.8, fontSize: 18 });

    T(s, "Same answer. Same confidence. One claim has already expired.", { x: 1.0, y: 5.55, w: 11.3, h: 0.6, fontFace: HEAD, fontSize: 26, color: C.text });
    T(s, "DeepSeek answer sent through the Bifrost gateway and checked by Halflife, 2026-11-02 (real report, unedited).", { x: 1.0, y: 6.55, w: 11.3, h: 0.3, fontSize: 11, color: C.muted });
    s.addNotes("AI answers sound equally confident about every fact. But some of those facts have already expired.\n\n[Real report from 2026-11-02: DeepSeek via Bifrost, checked by Halflife. Node.js 22 claim superseded with strong evidence; React 19 current.]");
  }

  // ============================================================ 2. Introducing HALFLIFE
  {
    const s = pres.addSlide({ masterName: "HL_PLAIN" });
    mark(s, 1.0, 1.0, 0.8);
    T(s, "HALFLIFE", { x: 0.95, y: 1.95, w: 8, h: 1.2, fontFace: HEAD, fontSize: 72, charSpacing: 3 });
    T(s, "A freshness-verification layer for AI answers.", { x: 1.0, y: 3.2, w: 11, h: 0.6, fontSize: 26, color: C.text2 });

    const steps = [
      ["Finds", "the claims in an answer that can go out of date", C.text],
      ["Estimates", "how likely each one is to have changed", C.amber],
      ["Verifies", "the risky ones against live web evidence", C.em],
    ];
    steps.forEach(([h, d, col], i) => {
      const x = 1.0 + i * 3.85;
      box(s, x, 4.3, 3.55, 1.35, { fill: C.surf, line: C.border2 });
      T(s, h, { x: x + 0.25, y: 4.45, w: 3.1, h: 0.45, fontFace: HEAD, fontSize: 22, color: col });
      T(s, d, { x: x + 0.25, y: 4.95, w: 3.1, h: 0.6, fontSize: 14, color: C.text2 });
      if (i < 2) line(s, x + 3.58, 4.97, x + 3.82, 4.97, { color: C.muted });
    });
    chip(s, "BUILT ON BIFROST", 1.0, 6.2, 2.4, { line: C.blue, color: C.text });
    chip(s, "LIVE EVIDENCE FROM TAVILY", 3.6, 6.2, 3.3, { line: C.amber, color: C.text });
    T(s, "Problem 04 · Bifrost extension    ·    Problem 06 · Stale-answer detection", { x: 7.2, y: 6.2, w: 5.4, h: 0.36, fontFace: MONO, fontSize: 11, color: C.muted, valign: "middle" });
    s.addNotes("Halflife is a freshness-verification layer for AI answers. It finds the claims that may be out of date, and checks them against current evidence.");
  }

  // ============================================================ 3. Why the name
  {
    const s = pres.addSlide({ masterName: "HL_CONTENT" });
    eyebrow(s, "01", "Why it's called Halflife");
    title(s, "Facts decay. Each kind has its own half-life");
    T(s, [
      { text: "In physics, a half-life is the time it takes for half of a radioactive sample to decay.", options: { breakLine: true } },
      { text: " ", options: { breakLine: true, fontSize: 8 } },
      { text: "Halflife applies the same idea to facts. Every kind of claim has a half-life: ", options: {} },
      { text: "the time until there's an even chance it has changed.", options: { color: C.text, bold: true } },
    ], { x: 0.6, y: 1.8, w: 5.4, h: 2.0, fontSize: 16, color: C.text2 });

    const rows = [
      ["Market price", fmtYears(halfLife(PRIORS.price[1], PRIORS.price[2])), C.red],
      ["Software version", fmtYears(halfLife(PRIORS.version[1], PRIORS.version[2])), C.amber],
      ["Government office holder", fmtYears(halfLife(PRIORS.office[1], PRIORS.office[2])), C.blue],
      ["Historical fact", "never expires", C.text2],
    ];
    T(s, "STARTING HALF-LIFE, BY CLAIM CLASS", { x: 0.6, y: 3.95, w: 5.4, h: 0.3, fontFace: MONO, fontSize: 10.5, color: C.muted, charSpacing: 1.5 });
    rows.forEach(([n, v, col], i) => {
      const y = 4.35 + i * 0.5;
      s.addShape(pres.shapes.OVAL, { x: 0.6, y: y + 0.11, w: 0.16, h: 0.16, fill: { color: col }, line: { type: "none" } });
      T(s, n, { x: 0.95, y, w: 3.2, h: 0.4, fontSize: 15, valign: "middle" });
      T(s, v, { x: 4.0, y, w: 2.0, h: 0.4, fontFace: MONO, fontSize: 13, color: col, align: "right", valign: "middle" });
    });
    T(s, "18 claim classes in total. Starting values are hand-set estimates that verified outcomes later update. Not calibrated.", { x: 0.6, y: 6.4, w: 5.4, h: 0.5, fontSize: 10.5, color: C.muted });
    s.addImage({ path: curves, x: 6.5, y: 1.85, w: 6.25, h: 3.906, altText: "Decay curves: chance a claim is still true over time for market price, software version, office holder and historical fact" });
    T(s, "Dots mark each half-life: a 50% chance the claim has changed. Gamma–Poisson change-rate model per class (engine/src/classes.ts).", { x: 6.5, y: 5.9, w: 6.25, h: 0.3, fontSize: 10.5, color: C.muted });
    s.addNotes("Why Halflife? In physics, a half-life is the time it takes for half of a radioactive sample to decay. Facts decay too, at very different speeds. Halflife gives every kind of claim its own half-life: the time until there's an even chance it has changed.\n\n[Values on the slide are the hand-set starting priors from engine/src/classes.ts. They are estimates and are not calibrated.]");
  }

  // ============================================================ 4. Information expires
  {
    const s = pres.addSlide({ masterName: "HL_CONTENT" });
    eyebrow(s, "02", "The problem");
    title(s, "Information expires at different speeds");
    lede(s, "A model states every sentence with the same confidence, from training data with a cutoff.");
    const cards = [
      ["Product price", "YouTube Premium: $13.99/month", "$15.99 since April 2026", "weeks", C.red, 0.85],
      ["Software version", "Latest Node.js: 22", "Node.js 26 since May 2026", "months", C.amber, 0.62],
      ["Office holder", "UK Prime Minister: Keir Starmer", "Andy Burnham since July 2026", "years", C.blue, 0.38],
      ["Historical fact", "Battle of Hastings: 1066", "Still 1066", "never", C.text2, 0],
    ];
    cards.forEach(([cls, claim, now, speed, col, drain], i) => {
      const x = 0.6 + i * 3.08, y = 2.35, w = 2.88, h = 3.9;
      box(s, x, y, w, h, { fill: C.surf, line: C.border2 });
      T(s, cls.toUpperCase(), { x: x + 0.25, y: y + 0.25, w: w - 0.5, h: 0.3, fontFace: MONO, fontSize: 11, color: col, charSpacing: 1 });
      T(s, claim, { x: x + 0.25, y: y + 0.7, w: w - 0.5, h: 0.95, fontFace: SERIF, fontSize: 18, color: drain ? C.muted : C.text, strike: drain ? "sngStrike" : undefined });
      const nowRuns = [{ text: now, options: { color: drain ? C.text : C.text2, bold: !!drain } }];
      if (drain) nowRuns.unshift({ text: "Now: ", options: { color: C.muted } });
      T(s, nowRuns, { x: x + 0.25, y: y + 1.75, w: w - 0.5, h: 0.65, fontSize: 14 });
      T(s, "CHANGES IN", { x: x + 0.25, y: y + 2.75, w: w - 0.5, h: 0.25, fontFace: MONO, fontSize: 10, color: C.muted, charSpacing: 1 });
      T(s, speed, { x: x + 0.25, y: y + 3.0, w: w - 0.5, h: 0.4, fontFace: HEAD, fontSize: 20, color: col });
      const bw = w - 0.5;
      box(s, x + 0.25, y + 3.5, bw, 0.1, { fill: C.border, line: null });
      if (drain) box(s, x + 0.25, y + 3.5, bw * (1 - drain), 0.1, { fill: col, line: null });
      else box(s, x + 0.25, y + 3.5, bw, 0.1, { fill: C.text2, line: null });
    });
    T(s, "Changes as reported by the sources Halflife retrieved, and confirmed by independent web searches (2026-11-02).", { x: 0.6, y: 6.45, w: 12, h: 0.3, fontSize: 10.5, color: C.muted });
    s.addNotes("Facts don't age at the same speed. A price can change in weeks. A software version, in months. A head of government, in a year or two. A historical date, never.");
  }

  // ============================================================ 5. One rule doesn't fit
  {
    const s = pres.addSlide({ masterName: "HL_CONTENT" });
    eyebrow(s, "03", "Why one rule doesn't fit");
    title(s, "Check each claim by how fast its kind of fact changes");
    const cols = [
      ["Check nothing", "Free, but every expired claim reaches the user.", C.red, C.surf, C.border2, "✕"],
      ["Check everything", "Wastes searches on facts that can't change, like a date from 1066.", C.red, C.surf, C.border2, "✕"],
      ["Halflife: check by risk", "Search only claims likely to be stale: estimated risk of 20% or more, at most 3 per answer. Facts that can't go out of date are never searched.", C.em, C.emTint, C.em, "✓"],
    ];
    cols.forEach(([h, d, col, fill, ln, icon], i) => {
      const x = 0.6 + i * 4.1, y = 2.0, w = 3.85, h2 = 3.6;
      box(s, x, y, w, h2, { fill, line: ln });
      T(s, icon, { x: x + 0.3, y: y + 0.3, w: 0.6, h: 0.6, fontSize: 30, color: col, fontFace: HEAD });
      T(s, h, { x: x + 0.3, y: y + 1.05, w: w - 0.6, h: 0.5, fontFace: HEAD, fontSize: 22, color: i === 2 ? C.em : C.text });
      T(s, d, { x: x + 0.3, y: y + 1.7, w: w - 0.6, h: 1.7, fontSize: 15, color: C.text2 });
    });
    T(s, "18 claim classes, each with its own change rate. Search credits go where staleness is likely.", { x: 0.6, y: 6.0, w: 12, h: 0.45, fontFace: HEAD, fontSize: 18, color: C.text });
    s.addNotes("Checking every claim the same way either wastes searches on facts that can't change, or misses the ones that already have. Halflife models eighteen kinds of claim, each with its own rate of change, and only spends a live search where a claim is likely to be stale.");
  }

  // ============================================================ 6. Estimate vs evidence
  {
    const s = pres.addSlide({ masterName: "HL_CONTENT" });
    eyebrow(s, "04", "The freshness model");
    title(s, "Estimates choose what to check. Evidence decides");
    lede(s, "Halflife keeps three measures apart and never blends them into one score.");
    const cards = [
      ["A", "Expected lifespan", "Half-life of the claim's class, with a 90% interval.", "Half-life 8.4 mo", "a property of the class, not the claim", C.text2],
      ["B", "Risk it's out of date", "From the class's change rate and the claim's age. A range. Decides whether to search (≥ 20%).", "39%–92%", "estimated · uncalibrated", C.amber],
      ["C", "Evidence confidence", "From explicit rules: verified quotes, independent sites, how recent the sources are.", "Strong", "strong · moderate · weak · none. Never a percentage", C.em],
    ];
    cards.forEach(([k, h, d, val, sub, col], i) => {
      const x = 0.6 + i * 4.1, y = 2.3, w = 3.85, hh = 3.35;
      box(s, x, y, w, hh, { fill: C.surf, line: C.border2 });
      num(s, k, x + 0.3, y + 0.3, col);
      T(s, h, { x: x + 0.8, y: y + 0.28, w: w - 1.0, h: 0.45, fontFace: HEAD, fontSize: 17, valign: "middle" });
      T(s, d, { x: x + 0.3, y: y + 0.95, w: w - 0.6, h: 1.1, fontSize: 14, color: C.text2 });
      T(s, val, { x: x + 0.3, y: y + 2.1, w: w - 0.6, h: 0.55, fontFace: HEAD, fontSize: 26, color: col });
      T(s, sub, { x: x + 0.3, y: y + 2.7, w: w - 0.6, h: 0.5, fontFace: MONO, fontSize: 10.5, color: C.muted });
    });
    T(s, "VERDICT", { x: 0.6, y: 5.95, w: 1.2, h: 0.36, fontFace: MONO, fontSize: 11, color: C.muted, valign: "middle" });
    [["current", C.em], ["superseded", C.red], ["contradicted", C.red], ["unverifiable", C.text2], ["not checked", C.muted]].forEach(([v, col], i) =>
      chip(s, v, 1.75 + i * 1.95, 5.95, 1.8, { color: col, line: col === C.muted ? C.border2 : col }));
    T(s, "Example values from a real report (Node.js 22 claim, 2026-11-02). The language model never outputs a number: it returns claim spans, classes, dates, a verdict and quotes, all checked in code.", { x: 0.6, y: 6.5, w: 12.1, h: 0.45, fontSize: 10.5, color: C.muted });
    s.addNotes("Halflife keeps three things separate: the expected lifespan of this kind of claim; an estimated risk that it's out of date, labelled uncalibrated; and the strength of the evidence, rated by explicit rules, never as a percentage. The estimate decides what to check. The evidence decides the verdict.");
  }

  // ============================================================ 7. Architecture 1: two ways in
  {
    const s = pres.addSlide({ masterName: "HL_CONTENT" });
    eyebrow(s, "05", "Architecture");
    title(s, "Two ways in, one engine");
    const node = (x, y, w, h, head, sub, o = {}) => {
      box(s, x, y, w, h, { fill: o.fill || C.surf, line: o.line || C.border2, lw: o.lw || 1 });
      T(s, head, { x: x + 0.22, y: y + 0.16, w: w - 0.44, h: 0.4, fontFace: o.mono ? MONO : HEAD, fontSize: o.hs || 16, color: o.hc || C.text });
      if (sub) T(s, sub, { x: x + 0.22, y: y + 0.58, w: w - 0.44, h: h - 0.7, fontSize: 12.5, color: C.text2 });
    };
    // row 1: ChatGPT
    node(0.6, 1.9, 2.7, 1.1, "ChatGPT answer", "in your browser");
    node(4.0, 1.9, 3.4, 1.1, "Halflife extension", "Check freshness button · one answer, only on click");
    line(s, 3.3, 2.45, 4.0, 2.45);
    // engine
    node(9.4, 1.9, 3.33, 3.6, "HALFLIFE ENGINE", "", { line: C.em, lw: 1.75, hc: C.em, mono: true, hs: 14 });
    ["extract claims", "estimate risk", "verify risky claims", "claim-level report"].forEach((t, i) => chip(s, t, 9.65, 2.5 + i * 0.6, 2.83, { fs: 11 }));
    T(s, "console · API · local storage", { x: 9.62, y: 4.95, w: 2.9, h: 0.3, fontSize: 11, color: C.muted });
    line(s, 7.4, 2.45, 9.4, 2.45, { color: C.text });
    T(s, "answer + its question · local only", { x: 7.45, y: 2.05, w: 1.95, h: 0.4, fontFace: MONO, fontSize: 9, color: C.muted });
    // row 2: gateway
    node(0.6, 3.95, 2.7, 1.1, "Your app", "any OpenAI-compatible client");
    box(s, 4.0, 3.55, 4.6, 1.95, { fill: C.blueTint, line: C.blue, lw: 1.75 });
    T(s, "BIFROST GATEWAY", { x: 4.22, y: 3.7, w: 4.2, h: 0.35, fontFace: MONO, fontSize: 14, color: C.blue });
    box(s, 4.22, 4.2, 2.6, 1.05, { fill: C.surf2, line: C.em });
    T(s, [{ text: "Halflife plugin", options: { bold: true, color: C.em, breakLine: true } }, { text: "inline · microseconds · fail-open", options: { color: C.text2, fontSize: 11 } }], { x: 4.37, y: 4.32, w: 2.35, h: 0.85, fontSize: 14 });
    T(s, "semantic cache", { x: 6.95, y: 4.3, w: 1.55, h: 0.3, fontSize: 11.5, color: C.text2 });
    T(s, "relays", { x: 6.95, y: 4.65, w: 1.55, h: 0.3, fontSize: 11.5, color: C.text2 });
    line(s, 3.3, 4.35, 4.0, 4.35);
    line(s, 4.0, 4.7, 3.3, 4.7, { dash: "dash", color: C.muted });
    T(s, "reply + x-halflife headers", { x: 0.6, y: 5.15, w: 3.3, h: 0.3, fontFace: MONO, fontSize: 9, color: C.muted, align: "right" });
    line(s, 8.6, 4.9, 9.4, 4.9, { dash: "dash", color: C.em });
    T(s, "hand-off", { x: 8.62, y: 4.6, w: 0.76, h: 0.25, fontFace: MONO, fontSize: 9, color: C.muted, align: "right" });
    // provider
    node(4.0, 6.0, 4.6, 0.8, "LLM provider (DeepSeek)", "", { hs: 14 });
    line(s, 6.3, 5.5, 6.3, 6.0, { both: true, color: C.blue });
    T(s, "The extension talks to the engine directly on your machine. Gateway traffic is handed to the engine by the plugin running inside Bifrost.", { x: 9.4, y: 5.75, w: 3.33, h: 1.05, fontSize: 11, color: C.muted });
    s.addNotes("Answers reach Halflife two ways. From ChatGPT, through a browser extension: one answer at a time, only when you click. Or from any app that routes its AI traffic through the Bifrost gateway, where the Halflife plugin hands each answer to the engine.");
  }

  // ============================================================ 8. Architecture 2: inside one check
  {
    const s = pres.addSlide({ masterName: "HL_CONTENT" });
    eyebrow(s, "06", "Architecture");
    title(s, "Inside one check");
    const nodes = [
      ["Extract & classify", "claims, quoted word for word, 1 of 18 classes", C.text],
      ["Estimate risk", "freshness model, local, no network", C.text],
      ["Pick risky claims", "risk ≥ 20%, at most 3 per answer", C.text],
      ["Live search", "reuse a recent check, or search + extract", C.amber],
      ["Judge evidence", "verdict + quotes, each quote checked in code", C.text],
      ["Claim-level report", "console + extension result", C.em],
    ];
    const W = 1.88, G = 0.17, Y = 1.8, H = 1.55;
    nodes.forEach(([h, d, col], i) => {
      const x = 0.6 + i * (W + G);
      box(s, x, Y, W, H, { fill: i === 3 ? C.amberTint : i === 5 ? C.emTint : C.surf, line: col === C.text ? C.border2 : col, lw: col === C.text ? 1 : 1.5 });
      T(s, String(i + 1).padStart(2, "0"), { x: x + 0.16, y: Y + 0.13, w: 0.6, h: 0.25, fontFace: MONO, fontSize: 10.5, color: C.muted });
      T(s, h, { x: x + 0.16, y: Y + 0.38, w: W - 0.3, h: 0.5, fontFace: HEAD, fontSize: 14, color: col });
      T(s, d, { x: x + 0.16, y: Y + 0.85, w: W - 0.3, h: 0.65, fontSize: 11, color: C.text2 });
      if (i < 5) line(s, x + W, Y + H / 2, x + W + G, Y + H / 2, { color: C.muted, width: 1.25 });
    });
    const cx = (i) => 0.6 + i * (W + G) + W / 2;
    // static claims exit at step 2
    line(s, cx(1), Y + H, cx(1), 3.75, { color: C.muted, dash: "dash" });
    chip(s, "can't expire → never searched", cx(1) - 1.0, 3.75, 2.25, { fs: 10, color: C.muted });
    // Bifrost band
    const BY = 4.45, BH = 0.75;
    box(s, 0.6, BY, 12.13, BH, { fill: C.blueTint, line: C.blue, lw: 1.75 });
    T(s, [{ text: "BIFROST GATEWAY", options: { color: C.blue, bold: true } }, { text: "    every model call and every web search goes through it", options: { color: C.text2 } }], { x: 0.85, y: BY, w: 9, h: BH, fontFace: MONO, fontSize: 12, valign: "middle" });
    // connectors node -> band
    line(s, cx(0), Y + H, cx(0), BY, { color: C.blue, both: true });
    line(s, cx(4), Y + H, cx(4), BY, { color: C.blue, both: true });
    line(s, cx(3), Y + H, cx(3), BY, { color: C.amber, both: true });
    line(s, cx(5), Y + H, cx(5), BY, { color: C.em, dash: "dash" });
    T(s, "cache action (gateway traffic)", { x: cx(5) + 0.08, y: 3.55, w: 1.0, h: 0.75, fontFace: MONO, fontSize: 9, color: C.muted });
    // external services
    const EY = 5.75;
    box(s, 0.6, EY, 5.6, 0.95, { fill: C.surf, line: C.border2 });
    T(s, [{ text: "DeepSeek", options: { bold: true, breakLine: true } }, { text: "judge model for claim extraction and verdicts (deepseek-flash)", options: { color: C.text2, fontSize: 12 } }], { x: 0.85, y: EY + 0.13, w: 5.2, h: 0.75, fontSize: 15 });
    box(s, 6.6, EY, 6.13, 0.95, { fill: C.amberTint, line: C.amber });
    T(s, [{ text: "Tavily", options: { bold: true, color: C.amber, breakLine: true } }, { text: "live web search and extract, via a Bifrost relay that holds the key", options: { color: C.text2, fontSize: 12 } }], { x: 6.85, y: EY + 0.13, w: 5.7, h: 0.75, fontSize: 15 });
    line(s, 3.4, BY + BH, 3.4, EY, { color: C.blue, both: true });
    line(s, 9.66, BY + BH, 9.66, EY, { color: C.amber, both: true });
    s.addNotes("Inside the engine, a language model (DeepSeek, called through Bifrost) splits the answer into individual claims and labels each one. Halflife's freshness model estimates how likely each claim is to have changed. Only the risky ones go to Tavily for a live search, again through Bifrost. The model then judges the evidence, and every quote it cites is checked against the source in code.");
  }

  // ============================================================ 9. Bifrost + Tavily roles
  {
    const s = pres.addSlide({ masterName: "HL_CONTENT" });
    eyebrow(s, "07", "Bifrost and Tavily");
    title(s, "Bifrost carries the traffic. Tavily brings the evidence");
    const cols = [
      ["BIFROST", "Problem 04 · gateway + extension", C.blue, C.blueTint, [
        "Halflife plugin runs inside the gateway: a Go plugin on six hooks, fail-open",
        "Every model call, including Halflife's own, goes through it",
        "A relay holds the Tavily key, so the engine never sees it",
        "Cache: shorter lifetimes for volatile answers, no-store for prices, stale entries deleted",
      ]],
      ["TAVILY", "Problem 06 · live evidence", C.amber, C.amberTint, [
        "Searched only for claims likely to be stale",
        "Search first; extract the top pages only if no quote could be verified",
        "A recent verification is reused: 0 credits",
        "Every search stays within limits Halflife enforces",
      ]],
      ["HALFLIFE", "the freshness logic", C.em, C.emTint, [
        "Splits answers into claims and classifies them",
        "Estimates freshness risk per claim",
        "Turns evidence into a verdict, with quotes checked against the source",
        "Reports per claim in the console and the ChatGPT extension",
      ]],
    ];
    cols.forEach(([h, sub, col, fill, items], i) => {
      const x = 0.6 + i * 4.1, y = 1.8, w = 3.85, hh = 4.45;
      box(s, x, y, w, hh, { fill, line: col, lw: 1.5 });
      T(s, h, { x: x + 0.3, y: y + 0.25, w: w - 0.6, h: 0.4, fontFace: MONO, fontSize: 18, color: col, bold: true, charSpacing: 2 });
      T(s, sub, { x: x + 0.3, y: y + 0.7, w: w - 0.6, h: 0.3, fontSize: 12, color: C.muted });
      T(s, items.map((t, j) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: j < items.length - 1 } })), { x: x + 0.3, y: y + 1.2, w: w - 0.55, h: 3.1, fontSize: 14, color: C.text2, paraSpaceAfter: 9 });
    });
    T(s, "Built only on Bifrost's supported extension points: a plugin, two relays, the cache TTL key and the cache admin API. No changes to Bifrost's source.", { x: 0.6, y: 6.45, w: 12.1, h: 0.4, fontSize: 11, color: C.muted });
    s.addNotes("Bifrost carries the traffic: the Halflife plugin runs inside it, every model call goes through it, and a Bifrost relay holds the Tavily key. Tavily brings the live evidence. Halflife decides which claims need it, and what the evidence says.");
  }

  // ============================================================ 10. Into the demo
  {
    const s = pres.addSlide({ masterName: "HL_PLAIN" });
    mark(s, 1.0, 1.1, 0.6);
    T(s, "NEXT", { x: 1.0, y: 2.05, w: 6, h: 0.3, fontFace: MONO, fontSize: 12, color: C.em, charSpacing: 3 });
    T(s, "A real ChatGPT answer, checked live", { x: 1.0, y: 2.45, w: 11.3, h: 0.9, fontFace: HEAD, fontSize: 40 });
    const steps = ["Ask ChatGPT", "Click Check freshness", "Result under the answer", "Full report in the console"];
    steps.forEach((t, i) => {
      const x = 1.0 + i * 2.9;
      num(s, i + 1, x, 4.0, C.em, 0.45);
      T(s, t, { x, y: 4.65, w: 2.6, h: 0.8, fontSize: 17, color: C.text2 });
      if (i < 3) line(s, x + 0.6, 4.225, x + 2.75, 4.225, { color: C.border2 });
    });
    T(s, "Recorded on chatgpt.com with the Halflife extension and a local engine.", { x: 1.0, y: 6.3, w: 11, h: 0.3, fontSize: 11, color: C.muted });
    s.addNotes("Here's a real ChatGPT answer that mixes fast-changing facts with a permanent one.\n\n[Cut to screen recording: shot 7 of the video script.]");
  }

  await pres.writeFile({ fileName: OUT });
  console.log("wrote " + OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
