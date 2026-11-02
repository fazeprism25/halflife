// Text utilities shared by extraction and verification. Used to *check* LLM output against the
// source text: spans and quotes are only accepted if they really occur.

/** Lowercase, unify quotes/dashes, collapse whitespace. */
export function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Find `needle` in `hay` tolerating case and whitespace differences. Returns the [start, end)
 * offsets in the ORIGINAL hay, or null. Used to locate claim spans for highlighting.
 */
export function locate(hay: string, needle: string): [number, number] | null {
  const n = needle.trim();
  if (!n) return null;
  const direct = hay.indexOf(n);
  if (direct >= 0) return [direct, direct + n.length];
  // Build a normalised copy of hay with an index map back to original offsets.
  const map: number[] = [];
  let out = "";
  let prevSpace = false;
  for (let i = 0; i < hay.length; i++) {
    let ch = hay[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      ch = " ";
      prevSpace = true;
    } else prevSpace = false;
    const c = norm(ch) || " ";
    for (const x of c) {
      out += x;
      map.push(i);
    }
  }
  const nn = norm(n);
  const at = out.indexOf(nn);
  if (at < 0) return null;
  return [map[at], map[at + nn.length - 1] + 1];
}

/** True if quote occurs in source (case/whitespace/punctuation-variant tolerant). Min 12 chars. */
export function quoteOccurs(source: string, quote: string): boolean {
  const q = norm(quote).replace(/^["'.…\s]+|["'.…\s]+$/g, "");
  if (q.length < 12) return false;
  return norm(source).includes(q);
}

export function domainOf(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return "";
  }
}

/**
 * Registrable-domain approximation: last two labels, or last three for common two-part public
 * suffixes. Used only to count *independent* sources.
 */
export function siteOf(url: string): string {
  const h = domainOf(url);
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const two = parts.slice(-2).join(".");
  if (/^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join(".");
  return two;
}

export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

/** Sentence split that keeps offsets. Handles common abbreviations and decimals. */
const ABBREV = new Set(["mr", "mrs", "ms", "dr", "inc", "ltd", "co", "vs", "e.g", "i.e", "u.s", "st", "no", "jr", "sr", "corp"]);

export function sentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    if (s) out.push({ text: s, start: start + lead, end: start + lead + s.length });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      push(i + 1);
      continue;
    }
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue; // 3.12, e.g., URLs
    if (ch === ".") {
      const word = /([A-Za-z.]+)$/.exec(text.slice(Math.max(start, i - 6), i))?.[1]?.toLowerCase();
      if (word && ABBREV.has(word)) continue;
    }
    push(i + 1);
  }
  push(text.length);
  return out;
}
