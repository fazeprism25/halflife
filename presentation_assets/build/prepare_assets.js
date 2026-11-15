// Copies the screenshots the deck uses into presentation_assets/screenshots/ (unchanged) and
// writes crops into presentation_assets/crops/. Crops only cut away area; no pixel inside a crop
// is altered. Also renders the Halflife mark (from engine/console/favicon.svg) for a dark background.
//
//   NODE_PATH=<folder with sharp> node presentation_assets/build/prepare_assets.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "docs", "assets", "screenshots");
const OUT = path.join(ROOT, "presentation_assets");
const SHOTS = path.join(OUT, "screenshots");
const CROPS = path.join(OUT, "crops");
const BRAND = path.join(OUT, "brand");
for (const d of [SHOTS, CROPS, BRAND]) fs.mkdirSync(d, { recursive: true });

const USED = [
  "01-inspector-claim-report.png", "03-traffic-flyout-desktop.png", "06-claim-panel-evidence.png",
  "07-freshness-model.png", "08-system-integrations.png", "09-system-tavily-usage-and-limits.png",
  "10-chatgpt-activity.png", "11-chatgpt-claim-explorer.png",
];

// Real chatgpt.com screenshots supplied by the maintainer (kept in presentation_assets/screenshots/,
// not in docs/). Crops remove the account avatar and the report timestamp (local time zone).
const REAL_CROPS = [
  ["real-check-button.png", "real-chatgpt-1-check-button.png", 460, 80, 1000, 360],
  ["real-result.png", "real-chatgpt-2-result.png", 460, 80, 1000, 510],
  ["real-inspector.png", "real-chatgpt-3-inspector.png", 380, 118, 1473, 765],
];

// [output name, source, left, top, width, height] in source pixels
const CROP_LIST = [
  ["inspector-report.png", "01-inspector-claim-report.png", 0, 60, 1010, 730],
  ["claim-panel-top.png", "06-claim-panel-evidence.png", 0, 0, 400, 990],
  ["claim-panel-sources.png", "06-claim-panel-evidence.png", 0, 955, 400, 700],
  ["model-chart.png", "07-freshness-model.png", 28, 152, 628, 620],
  ["system-integrations.png", "08-system-integrations.png", 0, 135, 1160, 540],
  ["claim-explorer-card.png", "11-chatgpt-claim-explorer.png", 28, 207, 556, 507],
  ["spending-limits.png", "09-system-tavily-usage-and-limits.png", 28, 455, 1124, 205],
];

async function main() {
  for (const f of USED) fs.copyFileSync(path.join(SRC, f), path.join(SHOTS, f));
  for (const [out, src, left, top, width, height] of CROP_LIST) {
    await sharp(path.join(SRC, src)).extract({ left, top, width, height }).png().toFile(path.join(CROPS, out));
  }
  for (const [out, src, left, top, width, height] of REAL_CROPS) {
    await sharp(path.join(SHOTS, src)).extract({ left, top, width, height }).flatten({ background: "#000000" }).png().toFile(path.join(CROPS, out));
  }
  // The console's mark: a circle, one half filled. Light half on the left, as in the dark theme.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512">
    <circle cx="12" cy="12" r="10" fill="#0d0d0c" stroke="#f0efec" stroke-width="1.6"/>
    <path d="M12 2a10 10 0 0 0 0 20z" fill="#f0efec"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(BRAND, "halflife-mark-dark.png"));
  console.log("assets written to", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
