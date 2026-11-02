// Renders the Halflife mark (a ring with its right half filled, as in the console favicon) to
// PNG icons with no dependencies: anti-aliased by 4×4 supersampling, encoded with node:zlib.
//   node extension/scripts/make-icons.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../icons");
const INK = [11, 11, 11];
const PAPER = [252, 252, 251];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render(size) {
  const S = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const c = size / 2;
  const rOuter = size * 0.47; // background disc
  const ring = size * 0.36; // ring centre radius
  const stroke = Math.max(1.2, size * 0.075);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0, ink = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = x + (sx + 0.5) / S - c, py = y + (sy + 0.5) / S - c;
        const d = Math.hypot(px, py);
        if (d <= rOuter) bg++;
        const onRing = Math.abs(d - ring) <= stroke / 2;
        const inHalf = px >= 0 && d <= ring;
        if (onRing || inHalf) ink++;
      }
      const a = bg / (S * S), k = ink / (S * S);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(PAPER[i] * (1 - k) + INK[i] * k);
      raw[o + 3] = Math.round(255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(OUT, `icon-${s}.png`), render(s));
console.log(`icons written to ${OUT}`);
