// FreshQA snapshot parsing (RFC 4180 CSV, no dependencies). Data: eval/data/freshqa/*.csv,
// exported from the public FreshQA spreadsheets (github.com/freshllms/freshqa, Apache-2.0).
import fs from "node:fs";

export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Returns the question rows keyed by id. The sheet starts with a warning row and a blank row. */
export function loadSnapshot(path) {
  const rows = parseCSV(fs.readFileSync(path, "utf8"));
  const hi = rows.findIndex((r) => r[0] === "id" && r.includes("question"));
  if (hi < 0) throw new Error(`${path}: header row not found`);
  const head = rows[hi];
  const out = new Map();
  for (const r of rows.slice(hi + 1)) {
    if (!/^\d+$/.test(r[0] ?? "")) continue;
    const o = Object.fromEntries(head.map((k, i) => [k, (r[i] ?? "").trim()]));
    o.answers = head.filter((k) => /^answer_\d+$/.test(k)).map((k) => o[k]).filter(Boolean);
    out.set(o.id, o);
  }
  return out;
}

export const normAns = (s) => s.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/\s+/g, " ").trim();
