// Generates the README graphics (banner.svg, decay-curves.svg) from the class priors in
// engine/src/classes.ts, copied below. Usage: node docs/assets/diagrams/make-diagrams.mjs docs/assets/diagrams
// Survival under the prior: P(no change within t) = (beta/(beta+t))^alpha, beta = alpha*L.
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

const DAY = 1 / 365.25;
const C = {
  bg: "#0f0f0e", panel: "#161615", grid: "#2b2b29", text: "#f0efec", sub: "#c3c2b7", muted: "#8f8e86",
  em: "#10b981", em2: "#34d399", em3: "#6ee7b7", orange: "#f59e0b", orange2: "#fb923c", grey: "#8f8e86",
};
const font = "font-family=\"-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif\"";

// ---------------------------------------------------------------- decay curves
const series = [
  { id: "market.price", L: 1 * DAY, a: 2, color: C.orange2 },
  { id: "software.version", L: 120 * DAY, a: 2, color: C.orange },
  { id: "product.offering", L: 1, a: 1.5, color: C.em3 },
  { id: "gov.office_holder", L: 4, a: 2, color: C.em2 },
  { id: "org.leadership", L: 7, a: 1.5, color: C.em },
  { id: "science.consensus", L: 30, a: 1.5, color: C.sub },
  { id: "historical.fact", L: Infinity, a: 1, color: C.grey, dash: "6 5" },
];
const W = 880, H = 440, ml = 64, mr = 190, mt = 64, mb = 64;
const pw = W - ml - mr, ph = H - mt - mb;
const tMin = 1 * DAY, tMax = 100; // years, log axis
const x = (t) => ml + (Math.log10(t) - Math.log10(tMin)) / (Math.log10(tMax) - Math.log10(tMin)) * pw;
const y = (p) => mt + (1 - p) * ph;
const surv = (s, t) => (s.L === Infinity ? 1 : Math.pow((s.a * s.L) / (s.a * s.L + t), s.a));

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">Prior decay curves for seven Halflife claim classes</title>
<desc id="d">Probability that a claim is still unchanged after a given time, under each class's hand-set Gamma-Poisson prior. Market prices decay within days, software versions within months, office holders over years, historical facts not at all. Illustrative and uncalibrated.</desc>
<rect width="${W}" height="${H}" rx="14" fill="${C.bg}"/>
<text x="${ml}" y="30" fill="${C.text}" font-size="17" font-weight="600" ${font}>How fast different kinds of facts go stale</text>
<text x="${ml}" y="49" fill="${C.muted}" font-size="12" ${font}>P(claim still unchanged after t) under each class's prior · hand-set assumptions from engine/src/classes.ts · uncalibrated</text>
`;
for (const p of [0, 0.25, 0.5, 0.75, 1]) {
  svg += `<line x1="${ml}" x2="${ml + pw}" y1="${y(p)}" y2="${y(p)}" stroke="${C.grid}" stroke-width="1"${p === 0.5 ? ' stroke-dasharray="3 4"' : ""}/>
<text x="${ml - 10}" y="${y(p) + 4}" fill="${C.muted}" font-size="11" text-anchor="end" ${font}>${Math.round(p * 100)}%</text>\n`;
}
const ticks = [[DAY, "1 day"], [7 * DAY, "1 week"], [30 * DAY, "1 month"], [1, "1 year"], [10, "10 years"], [100, "100 years"]];
for (const [t, l] of ticks) {
  svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${mt + ph}" stroke="${C.grid}" stroke-width="1"/>
<text x="${x(t)}" y="${mt + ph + 20}" fill="${C.muted}" font-size="11" text-anchor="middle" ${font}>${l}</text>\n`;
}
svg += `<text x="${ml + pw / 2}" y="${H - 14}" fill="${C.sub}" font-size="12" text-anchor="middle" ${font}>time since the claim's as-of date (log scale)</text>\n`;
const labelYs = [];
for (const s of series) {
  const pts = [];
  for (let i = 0; i <= 240; i++) {
    const t = Math.pow(10, Math.log10(tMin) + (i / 240) * (Math.log10(tMax) - Math.log10(tMin)));
    pts.push(`${x(t).toFixed(1)},${y(surv(s, t)).toFixed(1)}`);
  }
  svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>\n`;
}
// legend
series.forEach((s, i) => {
  const ly = mt + 8 + i * 26;
  svg += `<line x1="${ml + pw + 22}" x2="${ml + pw + 44}" y1="${ly}" y2="${ly}" stroke="${s.color}" stroke-width="3"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>
<text x="${ml + pw + 52}" y="${ly + 4}" fill="${C.text}" font-size="12" ${font}>${s.id}</text>\n`;
});
svg += `<text x="${ml + pw + 22}" y="${mt + 8 + series.length * 26 + 10}" fill="${C.muted}" font-size="11" ${font}>dashed: static, never</text>
<text x="${ml + pw + 22}" y="${mt + 8 + series.length * 26 + 25}" fill="${C.muted}" font-size="11" ${font}>searched</text>
</svg>\n`;
fs.writeFileSync(path.join(out, "decay-curves.svg"), svg);

// ---------------------------------------------------------------- banner
const BW = 880, BH = 200;
const lf = (L) => (Math.log10(L) - Math.log10(0.5*DAY)) / (2 - Math.log10(0.5*DAY));
const bars = [
  ["“Bitcoin trades at $60k”", "market.price", lf(1*DAY), C.orange2],
  ["“The latest Python is 3.12”", "software.version", lf(120*DAY), C.orange],
  ["“Satya Nadella is CEO of Microsoft”", "org.leadership", lf(7), C.em],
  ["“The Berlin Wall fell in 1989”", "historical.fact", 1, C.grey],
];
let b = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BW} ${BH}" width="${BW}" height="${BH}" role="img" aria-labelledby="bt bd">
<title id="bt">HALFLIFE</title>
<desc id="bd">HALFLIFE wordmark. Four example claims with different shelf lives: a market price, a software version, a company leader and a historical fact.</desc>
<rect width="${BW}" height="${BH}" rx="14" fill="${C.bg}"/>
<g transform="translate(40 58)">
  <circle cx="22" cy="22" r="20" fill="${C.text}" stroke="${C.text}" stroke-width="2"/>
  <path d="M22 2a20 20 0 0 1 0 40z" fill="${C.em}"/>
</g>
<text x="98" y="92" fill="${C.text}" font-size="40" font-weight="700" letter-spacing="6" ${font}>HALFLIFE</text>
<text x="40" y="140" fill="${C.sub}" font-size="14" ${font}>Different facts expire at different rates.</text>
<text x="40" y="160" fill="${C.sub}" font-size="14" ${font}>Halflife finds the claims that may have</text>
<text x="40" y="180" fill="${C.sub}" font-size="14" ${font}>expired and checks them against live evidence.</text>
<text x="420" y="40" fill="${C.muted}" font-size="11" letter-spacing="1" ${font}>TYPICAL TIME BETWEEN CHANGES · CLASS PRIOR · LOG SCALE</text>
`;
bars.forEach(([claim, cls, frac, col], i) => {
  const yy = 58 + i * 36;
  b += `<text x="420" y="${yy}" fill="${C.text}" font-size="12.5" ${font}>${claim}</text>
<text x="840" y="${yy}" fill="${C.muted}" font-size="11" text-anchor="end" ${font}>${cls}</text>
<rect x="420" y="${yy + 7}" width="420" height="6" rx="3" fill="${C.grid}"/>
<rect x="420" y="${yy + 7}" width="${(420 * frac).toFixed(0)}" height="6" rx="3" fill="${col}"/>\n`;
});
b += `</svg>\n`;
fs.writeFileSync(path.join(out, "banner.svg"), b);
console.log("ok");
