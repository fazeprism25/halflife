// Where a claim's clock starts (t_asof), as an interval, never a fabricated point.
//
// Priority: (1) an explicit date in the answer ("as of July 2024"), (2) the date Halflife last
// verified the same claim, (3) the generating model's published knowledge cutoff, (4) an
// explicitly labelled assumption when the model is unknown.

export type AsOf = {
  kind: "explicit" | "verified" | "model_cutoff" | "request" | "assumed";
  lo: number; // epoch ms
  hi: number; // epoch ms
  label: string;
  source?: string;
};

const MONTH_MS = 30.44 * 24 * 3600 * 1000;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/** Parse "YYYY", "YYYY-MM" or "YYYY-MM-DD" into the interval it denotes (UTC). */
export function parsePartialDate(s: unknown, now = Date.now()): { lo: number; hi: number } | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : null;
  const d = m[3] ? Number(m[3]) : null;
  const maxYear = new Date(now).getUTCFullYear() + 1;
  if (y < 1800 || y > maxYear) return null;
  if (mo !== null && (mo < 1 || mo > 12)) return null;
  if (d !== null) {
    const lo = Date.UTC(y, mo! - 1, d);
    if (new Date(lo).getUTCDate() !== d) return null;
    return { lo, hi: lo + 24 * 3600 * 1000 - 1 };
  }
  if (mo !== null) return { lo: Date.UTC(y, mo - 1, 1), hi: Date.UTC(y, mo, 1) - 1 };
  return { lo: Date.UTC(y, 0, 1), hi: Date.UTC(y + 1, 0, 1) - 1 };
}

// Published training-data / knowledge cutoffs. Each entry names its source. Models not listed
// fall back to an explicit assumption. Matching is on the model id without provider prefix.
type CutoffEntry = { match: RegExp; cutoff: string; source: string };
export const MODEL_CUTOFFS: CutoffEntry[] = [
  { match: /^gpt-4o(-mini)?(\b|-)/, cutoff: "2023-10", source: "OpenAI model documentation (knowledge cutoff Oct 2023)" },
  { match: /^gpt-4\.1/, cutoff: "2024-06", source: "OpenAI model documentation (knowledge cutoff Jun 2024)" },
  { match: /^gpt-4-turbo/, cutoff: "2023-12", source: "OpenAI model documentation (knowledge cutoff Dec 2023)" },
  { match: /^gpt-3\.5-turbo/, cutoff: "2021-09", source: "OpenAI model documentation (knowledge cutoff Sep 2021)" },
  { match: /^(o3|o4-mini)(\b|-)/, cutoff: "2024-06", source: "OpenAI model documentation (knowledge cutoff Jun 2024)" },
  { match: /^claude-3-5-sonnet/, cutoff: "2024-04", source: "Anthropic model documentation (training data cutoff Apr 2024)" },
  { match: /^claude-3-5-haiku/, cutoff: "2024-07", source: "Anthropic model documentation (training data cutoff Jul 2024)" },
  { match: /^claude-3-haiku/, cutoff: "2023-08", source: "Anthropic model documentation (training data cutoff Aug 2023)" },
  { match: /^gemini-2\.0-flash/, cutoff: "2024-08", source: "Google model documentation (knowledge cutoff Aug 2024)" },
  { match: /^gemini-1\.5/, cutoff: "2023-11", source: "Google model documentation (knowledge cutoff Nov 2023)" },
  { match: /^(meta-llama\/)?llama-?3\.[13]/i, cutoff: "2023-12", source: "Meta Llama 3.1/3.3 model card (knowledge cutoff Dec 2023)" },
];

export function normaliseModel(model: string | undefined | null): string {
  if (!model) return "";
  const m = model.trim().toLowerCase();
  const slash = m.indexOf("/");
  // keep "meta-llama/..." style org prefixes, strip bifrost provider prefixes like "openai/"
  const providers = ["openai", "anthropic", "gemini", "vertex", "bedrock", "groq", "openrouter", "mistral", "ollama", "azure", "cerebras", "together", "fireworks", "deepseek", "xai"];
  if (slash > 0 && providers.includes(m.slice(0, slash))) return m.slice(slash + 1);
  return m;
}

export function modelCutoff(model: string | undefined | null): CutoffEntry | null {
  const m = normaliseModel(model);
  if (!m) return null;
  return MODEL_CUTOFFS.find((e) => e.match.test(m)) ?? null;
}

/**
 * The interval a model's knowledge reflects. Knowledge thins out in the months before a cutoff,
 * so the interval spans the six months up to the end of the cutoff month.
 */
export function cutoffAsOf(model: string | undefined | null, now = Date.now()): AsOf {
  const e = modelCutoff(model);
  if (e) {
    const p = parsePartialDate(e.cutoff, now)!;
    return { kind: "model_cutoff", lo: p.lo - 6 * MONTH_MS, hi: p.hi, label: `model knowledge cutoff ${e.cutoff}`, source: e.source };
  }
  return {
    kind: "assumed", lo: now - 3 * YEAR_MS, hi: now - 6 * MONTH_MS,
    label: model ? `unknown cutoff for ${model}: assumed 6–36 months old` : "unknown model: assumed 6–36 months old",
  };
}

export function explicitAsOf(s: unknown, now = Date.now()): AsOf | null {
  const p = parsePartialDate(s, now);
  if (!p || p.lo > now) return null;
  return { kind: "explicit", lo: p.lo, hi: Math.min(p.hi, now), label: `stated in the answer: ${String(s)}` };
}

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
