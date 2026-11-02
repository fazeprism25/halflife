// Claim extraction and classification.
//
// Primary: one structured LLM call (prompts.ts) whose output is validated in code. Items whose
// span does not occur in the answer, or whose class is not in the closed list, are dropped.
// Fallback: a rule-based extractor over the shared lexical cues, used when no LLM is configured
// or the LLM call fails. It is labelled "heuristic" everywhere it surfaces.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getClass, isClassId } from "./classes.ts";
import type { LLM, LLMUsage } from "./llm.ts";
import { EXTRACT_SCHEMA, MAX_CLAIMS, extractSystemPrompt, extractUserPrompt } from "./prompts.ts";
import { clip, locate, sentences } from "./text.ts";

export type ExtractedClaim = {
  start: number;
  end: number;
  text: string;
  statement: string;
  classId: string;
  subject: string;
  attribute: string;
  value: string;
  asOfRaw: string | null;
  timeSensitive: boolean;
  searchQuery: string;
};

export type Extraction = {
  method: "llm" | "heuristic";
  claims: ExtractedClaim[];
  dropped: { reason: string; span: string }[];
  usage?: LLMUsage;
  model?: string;
  ms: number;
  note?: string;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate raw LLM output against the answer text. Exported for tests. */
export function validateExtraction(raw: unknown, text: string): { claims: ExtractedClaim[]; dropped: Extraction["dropped"] } {
  const claims: ExtractedClaim[] = [];
  const dropped: Extraction["dropped"] = [];
  const items = (raw as any)?.claims;
  if (!Array.isArray(items)) return { claims, dropped: [{ reason: "output had no claims array", span: "" }] };
  const taken: [number, number][] = [];
  for (const it of items.slice(0, MAX_CLAIMS)) {
    const span = str(it?.span, 400);
    if (!span) {
      dropped.push({ reason: "empty span", span: "" });
      continue;
    }
    const loc = locate(text, span);
    if (!loc) {
      dropped.push({ reason: "span not found in the answer", span: clip(span, 80) });
      continue;
    }
    if (!isClassId(it?.class)) {
      dropped.push({ reason: `unknown class ${JSON.stringify(it?.class)}`, span: clip(span, 80) });
      continue;
    }
    if (taken.some(([a, b]) => a === loc[0] && b === loc[1])) {
      dropped.push({ reason: "duplicate span", span: clip(span, 80) });
      continue;
    }
    taken.push(loc);
    const cls = getClass(it.class);
    const statement = str(it?.statement, 400) || text.slice(loc[0], loc[1]);
    claims.push({
      start: loc[0],
      end: loc[1],
      text: text.slice(loc[0], loc[1]),
      statement,
      classId: cls.id,
      subject: str(it?.subject, 120),
      attribute: str(it?.attribute, 120),
      value: str(it?.value, 200),
      asOfRaw: typeof it?.as_of === "string" && it.as_of.trim() ? it.as_of.trim().slice(0, 10) : null,
      timeSensitive: cls.static ? false : it?.time_sensitive !== false,
      searchQuery: str(it?.search_query, 300) || statement,
    });
  }
  claims.sort((a, b) => a.start - b.start);
  return { claims, dropped };
}

export async function extractWithLLM(llm: LLM, text: string, question: string | undefined, now: number, signal?: AbortSignal): Promise<Extraction> {
  const t0 = performance.now();
  const r = await llm.json(
    { name: "halflife_claims", system: extractSystemPrompt(), user: extractUserPrompt(text, question, new Date(now).toISOString().slice(0, 10)), schema: EXTRACT_SCHEMA, maxTokens: 1800 },
    signal,
  );
  const { claims, dropped } = validateExtraction(r.data, text);
  return { method: "llm", claims, dropped, usage: r.usage, model: r.model, ms: Math.round(performance.now() - t0) };
}

// ---------------------------------------------------------------- heuristic fallback

type CueGroup = { id: string; label: string; ttl_seconds: number; classes: string[]; patterns: string[]; re: RegExp[] };

let cueCache: CueGroup[] | null = null;

export function loadCueGroups(file?: string): CueGroup[] {
  if (cueCache && !file) return cueCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = file ?? process.env.HALFLIFE_CUES_PATH ?? path.resolve(here, "../../shared/temporal-cues.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const groups: CueGroup[] = raw.groups.map((g: any) => ({ ...g, re: g.patterns.map((s: string) => new RegExp(s, "i")) }));
  if (!file) cueCache = groups;
  return groups;
}

const AS_OF_RE = /\b(?:as of|since|in|by|during)\s+(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?((?:19|20)\d{2})\b/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function heuristicAsOf(s: string): string | null {
  const m = AS_OF_RE.exec(s);
  if (!m) return null;
  if (m[1]) return `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}`;
  return m[2];
}

export function extractHeuristic(text: string, note?: string): Extraction {
  const t0 = performance.now();
  const groups = loadCueGroups();
  const claims: ExtractedClaim[] = [];
  for (const s of sentences(text)) {
    if (claims.length >= MAX_CLAIMS) break;
    if (s.text.length < 12 || s.text.endsWith("?")) continue;
    const hit = groups.filter((g) => g.re.some((r) => r.test(s.text)));
    if (hit.length === 0) continue;
    // Most volatile matched group decides the class; the recency group carries no class.
    const ranked = hit.filter((g) => g.classes.length > 0).sort((a, b) => a.ttl_seconds - b.ttl_seconds);
    const classId = ranked[0]?.classes[0] ?? "other.time_sensitive";
    claims.push({
      start: s.start,
      end: s.end,
      text: s.text,
      statement: s.text,
      classId,
      subject: "",
      attribute: "",
      value: "",
      asOfRaw: heuristicAsOf(s.text),
      timeSensitive: true,
      searchQuery: clip(s.text.replace(/\b(as of|currently|right now|at present)\b[^,.]*,?/gi, "").trim(), 200),
    });
  }
  return { method: "heuristic", claims, dropped: [], ms: Math.round(performance.now() - t0), note };
}
