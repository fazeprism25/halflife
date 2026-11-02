// C. Confidence in the verification evidence (AD-09). An ordinal level from explicit rules,
// never a percentage. Every rule that fires is reported as a human-readable reason.

export type Verdict = "current" | "superseded" | "contradicted" | "unverifiable";
export const VERDICTS: Verdict[] = ["current", "superseded", "contradicted", "unverifiable"];
export type Stance = "supports" | "refutes";
export type EvidenceLevel = "strong" | "moderate" | "weak" | "none";
export const LEVEL_RANK: Record<EvidenceLevel, number> = { none: 0, weak: 1, moderate: 2, strong: 3 };

export type CitationFacts = {
  site: string;
  publishedAt: number | null;
  stance: Stance;
  quoteValid: boolean;
};

export type LevelInput = {
  verdict: Verdict;
  citations: CitationFacts[];
  asOfLo: number;
  now: number;
  recencyDays: number;
};

const DAY_MS = 24 * 3600 * 1000;

export function agreeingStance(v: Verdict): Stance | null {
  if (v === "current") return "supports";
  if (v === "superseded" || v === "contradicted") return "refutes";
  return null;
}

export function evidenceLevel(inp: LevelInput): { level: EvidenceLevel; reasons: string[] } {
  const want = agreeingStance(inp.verdict);
  if (!want) return { level: "none", reasons: ["no verdict could be supported by the evidence"] };
  const valid = inp.citations.filter((c) => c.quoteValid);
  const invalid = inp.citations.length - valid.length;
  const agree = valid.filter((c) => c.stance === want);
  let oppose = valid.filter((c) => c.stance !== want);
  const reasons: string[] = [];
  // "Superseded" means the claim was true and then changed, so older sources that still state the
  // old value are expected, not a conflict. Only a supporting source dated on or after the newest
  // dated refuting source (or undated) counts against the verdict. "Contradicted" keeps every
  // opposing quote, because it asserts the claim was never true.
  let earlierOld = 0;
  if (inp.verdict === "superseded") {
    const refDates = agree.map((c) => c.publishedAt).filter((t): t is number => t !== null);
    if (refDates.length) {
      const newestRefute = Math.max(...refDates);
      const before = oppose.filter((c) => c.publishedAt !== null && c.publishedAt < newestRefute);
      earlierOld = before.length;
      oppose = oppose.filter((c) => !before.includes(c));
    }
  }
  if (invalid > 0) reasons.push(`${invalid} cited quote${invalid > 1 ? "s" : ""} not found in the source and ignored`);
  if (agree.length === 0) {
    reasons.push("no verified quote supports the verdict");
    return { level: "none", reasons };
  }
  const sites = new Set(agree.map((c) => c.site).filter(Boolean));
  const isRecent = (c: CitationFacts) =>
    c.publishedAt !== null && inp.now - c.publishedAt <= inp.recencyDays * DAY_MS && c.publishedAt >= inp.asOfLo;
  const recent = agree.filter(isRecent);
  const dated = agree.filter((c) => c.publishedAt !== null);

  reasons.push(`${sites.size} independent source${sites.size === 1 ? "" : "s"} agree${sites.size === 1 ? "s" : ""}`);
  if (recent.length > 0) {
    const newest = Math.max(...recent.map((c) => c.publishedAt!));
    reasons.push(`newest agreeing source published ${new Date(newest).toISOString().slice(0, 10)}, within ${inp.recencyDays} days and after the claim's as-of date`);
  } else if (dated.length > 0) {
    reasons.push(`agreeing sources are dated, but none within ${inp.recencyDays} days after the claim's as-of date`);
  } else {
    reasons.push("agreeing sources carry no publication date");
  }
  if (earlierOld > 0) reasons.push(`${earlierOld} older source${earlierOld > 1 ? "s" : ""} still state${earlierOld > 1 ? "" : "s"} the old value, which is consistent with a change`);
  if (oppose.length > 0) reasons.push(`${oppose.length} verified quote${oppose.length > 1 ? "s point" : " points"} the other way`);

  let level: EvidenceLevel;
  if (oppose.length === 0 && sites.size >= 2 && recent.length > 0) level = "strong";
  else if (oppose.length === 0 && (recent.length > 0 || sites.size >= 2)) level = "moderate";
  else level = "weak";
  return { level, reasons };
}
