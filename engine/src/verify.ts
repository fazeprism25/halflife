// Live verification of one claim: Tavily evidence ladder (T1 search, T2 extract) and a
// schema-checked verdict. Quotes are verified against the evidence text in code; a verdict
// without a verified quote is downgraded to "unverifiable" (AD-10, AD-12).

import type { ClassDef } from "./classes.ts";
import { type CitationFacts, type EvidenceLevel, type Stance, type Verdict, VERDICTS, evidenceLevel } from "./evidence.ts";
import { LLMError, type LLM, type LLMUsage } from "./llm.ts";
import { VERDICT_SCHEMA, verdictSystemPrompt, verdictUserPrompt } from "./prompts.ts";
import type { Reservation } from "./credits.ts";
import { SearchError, type Search } from "./tavily.ts";
import { clip, domainOf, norm, quoteOccurs, siteOf } from "./text.ts";

export type EvidenceItem = {
  eid: string;
  url: string;
  domain: string;
  site: string;
  title: string;
  publishedAt: number | null;
  content: string;
  score: number;
  tier: "T1" | "T2";
  stance: Stance | null;
  quote: string | null;
  quoteValid: boolean;
};

export type VerifyOutcome = {
  verdict: Verdict;
  currentValue: string | null;
  /** The verified quote that states currentValue (required for currentValue to be reported). */
  currentValueQuote: { eid: string; quote: string } | null;
  changedOn: string | null;
  explanation: string;
  level: EvidenceLevel;
  levelReasons: string[];
  evidence: EvidenceItem[];
  credits: number;
  tiers: string[];
  llmCalls: number;
  usage: LLMUsage[];
  /** Why the claim could not be fully verified, when it could not. */
  limitation: null | { kind: "no_search" | "no_judge" | "budget" | "rate_limit" | "search_error" | "judge_error" | "no_results" | "no_quote"; message: string };
};

export type VerifyInput = {
  statement: string;
  searchQuery: string;
  cls: ClassDef;
  asOfLo: number;
  asOfLabel: string;
  now: number;
};

export type VerifyDeps = {
  search: Search | null;
  llm: LLM | null;
  /** Called before each paid search call; false (or {ok:false}) refuses the call (AD-19). */
  reserveCredits: (n: number) => boolean | Reservation | Promise<boolean | Reservation>;
  /** Replaces a reservation with the credits the call actually consumed. */
  settleCredits?: (reserved: number, actual: number) => void;
  signal?: AbortSignal;
};

export function parsePublished(s: string | null, now: number): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t) || t > now + 24 * 3600 * 1000 || t < Date.UTC(1990, 0, 1)) return null;
  return t;
}

const empty = (): VerifyOutcome => ({
  verdict: "unverifiable", currentValue: null, currentValueQuote: null, changedOn: null, explanation: "", level: "none", levelReasons: [],
  evidence: [], credits: 0, tiers: [], llmCalls: 0, usage: [], limitation: null,
});

export async function verifyClaim(inp: VerifyInput, deps: VerifyDeps): Promise<VerifyOutcome> {
  const out = empty();
  if (!deps.search) {
    out.limitation = { kind: "no_search", message: "Live search is not configured (no Tavily relay), so this claim was not checked against current sources." };
    out.explanation = out.limitation.message;
    return out;
  }
  // ---- T1: search
  const r1 = await reserve(deps, 1);
  if (r1 !== true) {
    out.limitation = { kind: "budget", message: r1 };
    out.explanation = out.limitation.message;
    return out;
  }
  try {
    const r = await deps.search.search({ query: inp.searchQuery, topic: inp.cls.tavilyTopic, maxResults: 5, depth: "basic" }, deps.signal);
    out.credits += r.credits;
    deps.settleCredits?.(1, r.credits);
    out.tiers.push("T1");
    r.results.forEach((x, i) => {
      out.evidence.push({
        eid: `E${i + 1}`, url: x.url, domain: domainOf(x.url), site: siteOf(x.url), title: clip(x.title, 200),
        publishedAt: parsePublished(x.published_date, inp.now), content: clip(x.content, 1500), score: x.score,
        tier: "T1", stance: null, quote: null, quoteValid: false,
      });
    });
  } catch (e) {
    return searchFailure(out, e);
  }
  if (out.evidence.length === 0) {
    out.limitation = { kind: "no_results", message: "The search returned no sources for this claim." };
    out.explanation = out.limitation.message;
    return out;
  }
  if (!deps.llm) {
    out.limitation = { kind: "no_judge", message: "Sources were retrieved, but no judge model is configured, so no verdict was made." };
    out.explanation = out.limitation.message;
    out.levelReasons = ["no verdict without a judge model"];
    return out;
  }
  // ---- verdict on T1 evidence
  let judged = await judge(inp, out, deps);
  if (judged === "error") return out;

  // ---- T2: extract passages from the top sources when no quote could be verified
  if (judged === "no_valid_quote" && (await reserve(deps, 1)) === true) {
    const top = out.evidence.slice(0, 2).map((e) => e.url);
    try {
      const x = await deps.search.extract(top, inp.statement, deps.signal);
      out.credits += x.credits;
      deps.settleCredits?.(1, x.credits);
      out.tiers.push("T2");
      const base = out.evidence.length;
      x.results.forEach((r, i) => {
        const src = out.evidence.find((e) => e.url === r.url);
        out.evidence.push({
          eid: `E${base + i + 1}`, url: r.url, domain: domainOf(r.url), site: siteOf(r.url), title: src?.title ?? "",
          publishedAt: src?.publishedAt ?? null, content: clip(r.content, 3000), score: src?.score ?? 0,
          tier: "T2", stance: null, quote: null, quoteValid: false,
        });
      });
      if (x.results.length > 0) {
        for (const e of out.evidence) {
          e.stance = null;
          e.quote = null;
          e.quoteValid = false;
        }
        judged = await judge(inp, out, deps);
        if (judged === "error") return out;
      }
    } catch (e) {
      // T1 result stands; record why escalation failed.
      if (e instanceof SearchError && e.kind === "budget") out.levelReasons.push("passage extraction skipped: budget exhausted");
      else out.levelReasons.push("passage extraction failed");
    }
  }
  return out;
}

/** true when the credits may be spent, otherwise the refusal reason. */
async function reserve(deps: VerifyDeps, n: number): Promise<true | string> {
  const r = await deps.reserveCredits(n);
  if (r === true) return true;
  if (r === false) return "Verification credit cap reached; claim not checked.";
  return r.ok ? true : r.reason;
}

/** The value's head (before any parenthesis/comma) must appear, token by token, in the quote. */
export function valueInQuote(value: string, quote: string): boolean {
  const head = value.split(/[(,;]/)[0];
  const all = norm(head).split(/[^\p{L}\p{N}.]+/u).map((t) => t.replace(/^\.+|\.+$/g, "")).filter((t) => t.length >= 1 && !STOP.has(t));
  // Numeric values ("$15.99 per month", "Node.js 26") are grounded by their numbers; names by
  // all their words. Unit words ("per month" vs "/month") vary too much between sources.
  const nums = all.filter((t) => /\d/.test(t));
  const toks = nums.length ? nums : all;
  if (toks.length === 0) return false;
  const q = " " + norm(quote).replace(/[^\p{L}\p{N}.]+/gu, " ") + " ";
  // " 3.14." also matches 3.14.0: a version value is grounded by a more specific release.
  return toks.every((t) => q.includes(" " + t + " ") || q.includes(" " + t + "."));
}
const STOP = new Set(["the", "a", "an", "of", "is", "as", "now", "currently", "version", "v"]);

function searchFailure(out: VerifyOutcome, e: unknown): VerifyOutcome {
  if (e instanceof SearchError) {
    if (e.kind === "budget") out.limitation = { kind: "budget", message: "The search budget is exhausted (Bifrost or Tavily limit); claim not checked." };
    else if (e.kind === "rate_limit") out.limitation = { kind: "rate_limit", message: "Tavily rate-limited the request; claim not checked." };
    else out.limitation = { kind: "search_error", message: `Live search failed: ${e.message}` };
  } else out.limitation = { kind: "search_error", message: `Live search failed: ${(e as Error)?.message ?? e}` };
  out.explanation = out.limitation.message;
  return out;
}

/** Runs the verdict call and applies all code-side checks. Mutates out. */
async function judge(inp: VerifyInput, out: VerifyOutcome, deps: VerifyDeps): Promise<"ok" | "no_valid_quote" | "error"> {
  const today = new Date(inp.now).toISOString().slice(0, 10);
  const prompt = verdictUserPrompt(
    { statement: inp.statement, asOfLabel: inp.asOfLabel },
    out.evidence.map((e) => ({ id: e.eid, url: e.url, title: e.title, published: e.publishedAt ? new Date(e.publishedAt).toISOString().slice(0, 10) : null, content: e.content })),
    today,
  );
  let data: any;
  try {
    out.llmCalls++;
    const r = await deps.llm!.json({ name: "halflife_verdict", system: verdictSystemPrompt(), user: prompt, schema: VERDICT_SCHEMA, maxTokens: 900 }, deps.signal);
    out.usage.push(r.usage);
    data = r.data;
  } catch (e) {
    const msg = e instanceof LLMError && e.kind === "budget" ? "The judge model's budget is exhausted." : `The judge model failed: ${(e as Error).message}`;
    out.limitation = { kind: e instanceof LLMError && e.kind === "budget" ? "budget" : "judge_error", message: msg };
    out.explanation = msg;
    out.verdict = "unverifiable";
    return "error";
  }
  const verdict: Verdict = VERDICTS.includes(data?.verdict) ? data.verdict : "unverifiable";
  const byId = new Map(out.evidence.map((e) => [e.eid, e]));
  const facts: CitationFacts[] = [];
  const refuting: { ev: (typeof out.evidence)[number]; quote: string }[] = [];
  for (const c of Array.isArray(data?.citations) ? data.citations.slice(0, 6) : []) {
    const ev = byId.get(String(c?.evidence_id ?? ""));
    const stance: Stance | null = c?.stance === "supports" || c?.stance === "refutes" ? c.stance : null;
    if (!ev || !stance || typeof c?.quote !== "string") continue;
    const valid = quoteOccurs(ev.content, c.quote);
    if (valid && stance === "refutes") refuting.push({ ev, quote: c.quote });
    // keep the first verified quote per evidence item
    if (!ev.quoteValid) {
      ev.quote = clip(c.quote.trim(), 300);
      ev.stance = stance;
      ev.quoteValid = valid;
    }
    facts.push({ site: ev.site, publishedAt: ev.publishedAt, stance, quoteValid: valid });
  }
  const lvl = evidenceLevel({ verdict, citations: facts, asOfLo: inp.asOfLo, now: inp.now, recencyDays: inp.cls.evidenceRecencyDays });
  out.level = lvl.level;
  out.levelReasons = lvl.reasons;
  out.explanation = typeof data?.explanation === "string" ? clip(data.explanation.trim(), 600) : "";
  out.currentValue = null;
  out.currentValueQuote = null;
  if ((verdict === "superseded" || verdict === "contradicted") && typeof data?.current_value === "string" && data.current_value.trim()) {
    // The new value is reported only when a verified quote states it (AD-12): an inferred
    // value ("Musk bought Twitter" → "Musk is CEO") is dropped, and the reason is recorded.
    const vq = data?.current_value_quote;
    const ev = vq && typeof vq === "object" ? byId.get(String(vq.evidence_id ?? "")) : undefined;
    // The judge's own value quote first. For numeric values only (prices, versions, rates), fall
    // back to any verified refuting citation that states the number: the judge sometimes points
    // current_value_quote at the wrong item. Names get no fallback, because a name occurring in a
    // refuting quote ("Elon Musk bought Twitter") does not state that it is the new value.
    let grounded: { ev: NonNullable<typeof ev>; quote: string } | null = null;
    if (ev && typeof vq.quote === "string" && quoteOccurs(ev.content, vq.quote) && valueInQuote(data.current_value, vq.quote)) grounded = { ev, quote: vq.quote };
    else if (/\d/.test(data.current_value.split(/[(,;]/)[0])) grounded = refuting.find((r) => valueInQuote(data.current_value, r.quote)) ?? null;
    if (grounded) {
      out.currentValue = clip(data.current_value.trim(), 200);
      out.currentValueQuote = { eid: grounded.ev.eid, quote: clip(grounded.quote.trim(), 300) };
      out.levelReasons = [...out.levelReasons, `current value quoted from ${grounded.ev.eid} (${grounded.ev.site})`];
    } else {
      out.levelReasons = [...out.levelReasons, `current value "${clip(data.current_value, 80)}" omitted: no verified quote states it`];
    }
  }
  out.changedOn = verdict === "superseded" && typeof data?.changed_on === "string" && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(data.changed_on) ? data.changed_on : null;
  // A change dated after today cannot have superseded the claim yet (FreshQA eval, 2026-11-02: the
  // judge called "Zootopia 2 is the latest WDAS film" superseded by a film releasing 2026-11-25).
  if (verdict === "superseded" && out.changedOn && Date.parse(out.changedOn.length === 4 ? `${out.changedOn}-01-01` : out.changedOn.length === 7 ? `${out.changedOn}-01` : out.changedOn) > inp.now) {
    out.verdict = "unverifiable";
    out.limitation = { kind: "future_change", message: `The judge answered "superseded" with a change dated ${out.changedOn}, which is after today, so the verdict was discarded.` };
    out.levelReasons = [...out.levelReasons, `change date ${out.changedOn} is in the future`];
    out.currentValue = null;
    out.currentValueQuote = null;
    out.changedOn = null;
    return "no_valid_quote";
  }
  if (verdict !== "unverifiable" && lvl.level === "none") {
    out.verdict = "unverifiable";
    out.limitation = { kind: "no_quote", message: `The judge answered "${verdict}" but none of its quotes could be found in the sources, so the verdict was discarded.` };
    out.levelReasons = [...lvl.reasons];
    return "no_valid_quote";
  }
  out.verdict = verdict;
  out.limitation = null;
  return verdict === "unverifiable" ? "no_valid_quote" : "ok";
}
