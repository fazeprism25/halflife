// The Halflife pipeline: intake → extraction/classification → freshness estimate → triage →
// live verification → evidence confidence → learning → cache policy. One report per answer.

import crypto from "node:crypto";
import { cutoffAsOf, explicitAsOf, fmtDate, type AsOf } from "./asof.ts";
import { CacheActions } from "./cache.ts";
import { getClass } from "./classes.ts";
import type { Config } from "./config.ts";
import { CreditGuard } from "./credits.ts";
import { LEVEL_RANK, type EvidenceLevel } from "./evidence.ts";
import type { Bus } from "./events.ts";
import { extractHeuristic, extractWithLLM, type Extraction } from "./extract.ts";
import { YEAR_MS, halfLife, pOutdated } from "./freshness.ts";
import { ClassModel } from "./learn.ts";
import type { LLM } from "./llm.ts";
import type { Row, Store } from "./store.ts";
import type { Search } from "./tavily.ts";
import { clip, norm } from "./text.ts";
import { verifyClaim, type VerifyOutcome } from "./verify.ts";

export type IngestInput = {
  report_id?: unknown;
  source?: "gateway" | "api" | "playground";
  mode?: unknown;
  stream?: unknown;
  prompt?: unknown;
  text?: unknown;
  truncated?: unknown;
  model?: unknown;
  vk_fingerprint?: unknown;
  cache?: { id?: unknown; hit?: unknown; ttl_set?: unknown };
  triage?: { groups?: unknown; ttl_cap_seconds?: unknown };
  as_of?: unknown;
  /** true: extract and estimate freshness only; no live search, no verdicts, no spend on search. */
  assess_only?: unknown;
  /** false: verdicts are reported but never become learning observations (evaluation traffic,
   *  whose selection would bias the class change rates). */
  learn?: unknown;
  link_only?: unknown;
  sync?: unknown;
};

export class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type SyncResult = { status: "verified" | "partial" | "unverified" | "failed"; summary: string; stale: number; no_store: boolean; annotation: string };

export type EngineDeps = {
  cfg: Config;
  store: Store;
  llm: LLM | null;
  search: Search | null;
  bus: Bus;
  cache: CacheActions;
  now?: () => number;
};

const MAX_TEXT = 64 * 1024;
const ID_RE = /^hl_[a-f0-9]{8,40}$/;

export const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const fingerprint = (secret: string) => (secret ? sha(secret).slice(0, 12) : "");
const today = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type HeadlineCounts = {
  claims: number; time_sensitive: number; at_risk: number; checked: number; stale: number; possibly_stale: number;
  verdicts: { current: number; superseded: number; contradicted: number; unverifiable: number };
};
const nClaims = (k: number, w: string) => `${k} claim${k === 1 ? "" : "s"}${w}`;

/** One honest sentence per report. "Outdated" needs at least moderate evidence; weaker evidence
 *  is "possibly outdated"; "all current" is said only when every at-risk claim was checked. */
export function headlineFor(s: HeadlineCounts): string {
  if (s.claims === 0) return "No factual claims found";
  if (s.time_sensitive === 0) return `${nClaims(s.claims, "")}, none time-sensitive`;
  const unchecked = Math.max(0, s.at_risk - s.checked);
  const tail = unchecked ? `; ${unchecked} at risk, not checked` : "";
  if (s.stale) return `${s.stale} of ${nClaims(s.claims, "")} outdated${s.possibly_stale ? `, ${s.possibly_stale} possibly` : ""}${tail}`;
  if (s.possibly_stale) return `${s.possibly_stale} of ${nClaims(s.claims, "")} possibly outdated (weak evidence)${tail}`;
  if (s.checked && s.verdicts.current === s.checked) return `${s.checked} checked, ${s.checked === 1 ? "current" : "all current"}${tail}`;
  if (s.checked) {
    const parts = [s.verdicts.current ? `${s.verdicts.current} current` : "", s.verdicts.unverifiable ? `${s.verdicts.unverifiable} unverifiable` : ""].filter(Boolean);
    return `${s.checked} checked: ${parts.join(", ")}${tail}`;
  }
  if (s.at_risk) return `${nClaims(s.at_risk, "")} at risk, not checked`;
  return `${nClaims(s.time_sensitive, "")} time-sensitive, low risk`;
}

export class Engine {
  cfg: Config;
  store: Store;
  llm: LLM | null;
  search: Search | null;
  bus: Bus;
  cache: CacheActions;
  model: ClassModel;
  now: () => number;
  private queue: string[] = [];
  private running = 0;
  private syncRunning = 0;
  private inflight = new Map<string, Promise<void>>();
  private engineVKPrint: string;
  credits: CreditGuard;

  constructor(d: EngineDeps) {
    this.cfg = d.cfg;
    this.store = d.store;
    this.llm = d.llm;
    this.search = d.search;
    this.bus = d.bus;
    this.cache = d.cache;
    this.now = d.now ?? Date.now;
    this.model = new ClassModel(d.store);
    this.engineVKPrint = fingerprint(d.cfg.engineVK);
    const usage = d.search?.usage?.bind(d.search);
    this.credits = new CreditGuard({
      fetchUsage: d.cfg.tavilyAccountGuard && usage ? usage : null,
      spentToday: () => Number(this.store.spendFor(today(this.now())).credits),
      spentTotal: () => this.store.spendTotal(),
      dailyCap: d.cfg.dailyCreditCap,
      totalCap: d.cfg.totalCreditCap ?? Infinity,
      ceilingFraction: d.cfg.tavilyCeilingFraction ?? 0.8,
      refreshMs: 300_000, // /usage is rate-limited and lags anyway; local counting covers the gap
      now: this.now,
    });
    this.refreshHeadlines();
    // Requeue work interrupted by a restart.
    for (const r of this.store.all("SELECT id FROM reports WHERE status IN ('queued','running') ORDER BY created_at")) {
      this.store.updateReport(r.id, { status: "queued", stage: null });
      this.queue.push(r.id);
    }
    queueMicrotask(() => this.pump());
  }

  /** Reports summarised before summary_version 3 get their headline and counts re-derived from
   *  their stored claims. Verdicts and evidence levels are never changed: they stay as decided. */
  private refreshHeadlines() {
    for (const r of this.store.all("SELECT id, summary FROM reports WHERE status='done' AND summary IS NOT NULL")) {
      const s = JSON.parse(r.summary);
      if (s.summary_version >= 3 || typeof s.claims !== "number") continue;
      const claims = this.store.all("SELECT verdict, evidence_level FROM claims WHERE report_id=?", r.id);
      s.weak_current = claims.filter((c) => c.verdict === "current" && LEVEL_RANK[c.evidence_level as EvidenceLevel] < LEVEL_RANK.moderate).length;
      s.possibly_stale = claims.filter((c) => (c.verdict === "superseded" || c.verdict === "contradicted") && LEVEL_RANK[c.evidence_level as EvidenceLevel] < LEVEL_RANK.moderate).length;
      s.headline = headlineFor(s);
      s.summary_version = 3;
      this.store.updateReport(r.id, { summary: JSON.stringify(s) });
    }
  }

  get queueDepth() {
    return this.queue.length;
  }
  get activeJobs() {
    return this.running + this.syncRunning;
  }

  // ------------------------------------------------------------ intake

  /** Validate and record an answer. Returns the report id and what happened to it. */
  accept(inp: IngestInput, source: "gateway" | "api" | "playground"): { id: string; status: string } {
    const text = typeof inp.text === "string" ? inp.text : "";
    if (!text.trim()) throw new InputError("text is required");
    if (text.length > MAX_TEXT) throw new InputError(`text exceeds ${MAX_TEXT} characters`, 413);
    const id = typeof inp.report_id === "string" && ID_RE.test(inp.report_id) ? inp.report_id : "hl_" + crypto.randomBytes(10).toString("hex");
    const vkPrint = typeof inp.vk_fingerprint === "string" ? inp.vk_fingerprint.slice(0, 32) : null;
    if (source === "gateway" && vkPrint && this.engineVKPrint && this.engineVKPrint.startsWith(vkPrint)) {
      return { id, status: "ignored_internal" }; // defence in depth against analysing our own calls
    }
    const cacheId = typeof inp.cache?.id === "string" && /^[A-Za-z0-9-]{8,80}$/.test(inp.cache.id) ? inp.cache.id : null;
    const cacheHit = inp.cache?.hit === true ? 1 : inp.cache?.hit === false ? 0 : null;
    const ttlSet = typeof inp.cache?.ttl_set === "string" ? inp.cache.ttl_set.slice(0, 20) : null;

    const existing = this.store.get("SELECT id, status FROM reports WHERE id=?", id);
    if (existing) {
      // Second message for the same request (verify mode): attach cache info, never re-run.
      this.store.updateReport(id, { cache_id: cacheId ?? undefined, cache_hit: cacheHit, ttl_set: ttlSet ?? undefined });
      if (existing.status === "done") this.applyCachePolicy(id);
      return { id, status: "linked_existing" };
    }

    const now = this.now();
    const mode = typeof inp.mode === "string" && ["async", "verify"].includes(inp.mode) ? inp.mode : source === "gateway" ? "async" : "api";
    const groups = Array.isArray(inp.triage?.groups) ? inp.triage!.groups.filter((g: unknown) => typeof g === "string").slice(0, 20) : [];
    const asOf = typeof inp.as_of === "string" ? inp.as_of.slice(0, 10) : null;
    const row: Row = {
      id, created_at: now, source, mode,
      model: typeof inp.model === "string" ? inp.model.slice(0, 200) : null,
      prompt: typeof inp.prompt === "string" ? clip(inp.prompt, 8000) : null,
      text, truncated: inp.truncated === true ? 1 : 0, stream: inp.stream === true ? 1 : 0,
      vk_fingerprint: vkPrint, cache_id: cacheId, cache_hit: cacheHit, ttl_set: ttlSet,
      triage_groups: JSON.stringify(groups), status: "queued",
      summary: asOf || inp.assess_only === true || inp.learn === false ? JSON.stringify({ requested_as_of: asOf, assess_only: inp.assess_only === true, no_learn: inp.learn === false }) : null,
    };

    // Cache hit: link to the analysis of the original answer instead of paying again.
    if (cacheHit === 1 && cacheId) {
      const orig = this.store.get("SELECT id FROM reports WHERE cache_id=? AND (cache_hit=0 OR cache_hit IS NULL) AND status IN ('queued','running','done') ORDER BY created_at DESC LIMIT 1", cacheId);
      if (orig) {
        this.store.upsertReport({ ...row, status: "linked", linked_report_id: orig.id, finished_at: now });
        this.bus.emit({ type: "report", id, status: "linked", source });
        return { id, status: "linked" };
      }
    }
    if (inp.sync !== true && this.queue.length >= this.cfg.queueMax) throw new InputError("engine queue is full", 503);
    this.store.upsertReport(row);
    this.bus.emit({ type: "report", id, status: "queued", source });
    if (inp.sync !== true) {
      this.queue.push(id);
      this.pump();
    }
    return { id, status: "queued" };
  }

  /** Process now and wait (verify mode, /v1/check?wait). Bounded by the job budget. */
  async runNow(id: string): Promise<void> {
    if (this.inflight.has(id)) return this.inflight.get(id);
    if (this.syncRunning >= this.cfg.concurrency * 2) {
      // Too busy for synchronous work: fall back to the queue.
      this.queue.push(id);
      this.pump();
      throw new InputError("engine busy; queued for background verification", 503);
    }
    this.syncRunning++;
    const p = this.process(id).finally(() => {
      this.syncRunning--;
      this.inflight.delete(id);
    });
    this.inflight.set(id, p);
    return p;
  }

  private pump() {
    while (this.running < this.cfg.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      if (this.inflight.has(id)) continue;
      this.running++;
      const p = this.process(id).finally(() => {
        this.running--;
        this.inflight.delete(id);
        this.pump();
      });
      this.inflight.set(id, p);
    }
  }

  /** Waits for all queued and running jobs (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.queue.length || this.inflight.size) {
      await Promise.all([...this.inflight.values()]);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ------------------------------------------------------------ processing

  private async process(id: string): Promise<void> {
    const r = this.store.get("SELECT * FROM reports WHERE id=?", id);
    if (!r || r.status === "done" || r.status === "linked") return;
    const signal = AbortSignal.timeout(this.cfg.jobBudgetMs);
    const t0 = this.now();
    const setStage = (stage: string) => {
      this.store.updateReport(id, { status: "running", stage });
      this.bus.emit({ type: "report", id, status: "running", stage, source: r.source });
    };
    try {
      this.store.updateReport(id, { started_at: t0 });
      setStage("extract");
      const ex = await this.extract(r, signal);
      const tExtract = this.now();
      this.store.updateReport(id, { extraction: ex.method, extraction_note: ex.note ?? null, llm_calls: ex.method === "llm" ? 1 : 0 });
      if (ex.method === "llm") this.store.addSpend(today(t0), { llm_calls: 1, tokens: ex.usage?.total_tokens ?? 0 });

      setStage("assess");
      const requestedAsOf = r.summary ? JSON.parse(r.summary).requested_as_of : null;
      const assessOnly = r.summary ? JSON.parse(r.summary).assess_only === true : false;
      const learn = r.summary ? JSON.parse(r.summary).no_learn !== true : true;
      const claims = this.assess(r, ex, requestedAsOf);
      if (assessOnly) {
        for (const c of claims.filter((x) => x.triage === "verify")) {
          c.triage = "not_checked";
          this.store.run("UPDATE claims SET triage='not_checked', limitation_kind='assess_only', limitation=? WHERE id=?", "Assess-only request: freshness was estimated, but the claim was not checked against live sources.", c.id);
        }
      }

      setStage("verify");
      let credits = 0;
      let llmCalls = ex.method === "llm" ? 1 : 0;
      let tokens = ex.method === "llm" ? ex.usage?.total_tokens ?? 0 : 0;
      // Claims of one response are verified concurrently (at most maxVerifyPerResponse of them).
      // Measured live 2026-11-02: sequential verification took 11–21 s for 2 claims. Credit
      // reservations are serialised by the guard, so concurrency cannot overshoot a cap.
      await Promise.all(claims.filter((c) => c.triage === "verify").map(async (c) => {
        if (signal.aborted) {
          this.store.run("UPDATE claims SET triage='not_checked', limitation_kind='timeout', limitation=? WHERE id=?", "Job time budget exhausted before this claim was checked.", c.id);
          return;
        }
        const outcome = await verifyClaim(
          { statement: c.statement, searchQuery: c.search_query, cls: getClass(c.class), asOfLo: c.as_of_lo, asOfLabel: c.as_of_label, now: this.now() },
          { search: this.search, llm: this.llm, reserveCredits: (n) => this.credits.reserve(n), settleCredits: (a, b) => this.credits.settle(a, b), signal },
        );
        credits += outcome.credits;
        llmCalls += outcome.llmCalls;
        tokens += outcome.usage.reduce((s, u) => s + (u.total_tokens ?? 0), 0);
        this.store.addSpend(today(this.now()), {
          credits: outcome.credits, searches: outcome.tiers.includes("T1") ? 1 : 0, extracts: outcome.tiers.includes("T2") ? 1 : 0,
          llm_calls: outcome.llmCalls, tokens: outcome.usage.reduce((s, u) => s + (u.total_tokens ?? 0), 0),
        });
        this.recordOutcome(c, outcome, learn);
      }));
      const verifyMs = this.now() - tExtract;
      const summary = { ...this.summarise(id, ex, { extract_ms: tExtract - t0, verify_ms: verifyMs }, requestedAsOf), tokens, assess_only: assessOnly };
      this.store.updateReport(id, { status: "done", stage: null, finished_at: this.now(), credits, llm_calls: llmCalls, summary: JSON.stringify(summary) });
      this.applyCachePolicy(id);
      this.bus.emit({ type: "report", id, status: "done", source: r.source });
    } catch (e) {
      this.store.updateReport(id, { status: "failed", stage: null, error: clip(String((e as Error)?.message ?? e), 500), finished_at: this.now() });
      this.bus.emit({ type: "report", id, status: "failed", source: r.source });
    }
  }

  private async extract(r: Row, signal: AbortSignal): Promise<Extraction> {
    if (!this.llm) return extractHeuristic(r.text, "No extraction model is configured, so the rule-based extractor was used.");
    try {
      return await extractWithLLM(this.llm, r.text, r.prompt ?? undefined, this.now(), signal);
    } catch (e) {
      return extractHeuristic(r.text, `The extraction model failed (${clip((e as Error).message, 160)}), so the rule-based extractor was used.`);
    }
  }

  /** Freshness estimate per claim, evidence reuse (T0), and triage. Writes claim rows. */
  private assess(r: Row, ex: Extraction, requestedAsOf: string | null): Row[] {
    const now = this.now();
    const rows: Row[] = [];
    ex.claims.forEach((c, i) => {
      const cls = getClass(c.classId);
      const grid = this.model.grid(cls.id);
      const normKey = sha(norm(c.statement) + "|" + cls.id).slice(0, 24);
      let asOf: AsOf = explicitAsOf(c.asOfRaw, now) ?? explicitAsOf(requestedAsOf, now) ?? cutoffAsOf(r.model, now);
      if (asOf.kind === "explicit" && requestedAsOf && !c.asOfRaw) asOf = { ...asOf, kind: "request", label: `as-of date given with the request: ${requestedAsOf}` };
      const timeSensitive = c.timeSensitive && !cls.static;
      let reused: Row | undefined;
      if (timeSensitive) {
        reused = this.store.get(
          // A stored "superseded" whose change date is still in the future is never reused (see verify.ts).
          "SELECT * FROM claims WHERE norm_key=? AND verified_at IS NOT NULL AND reuse_until>? AND evidence_level IN ('strong','moderate') AND NOT (verdict='superseded' AND changed_on IS NOT NULL AND changed_on > ?) ORDER BY verified_at DESC LIMIT 1",
          normKey, now, today(now),
        );
        if (reused) {
          const v = Number(reused.verified_at);
          asOf = reused.verdict === "current"
            ? { kind: "verified", lo: v, hi: v, label: `verified current by Halflife on ${fmtDate(v)}` }
            : asOf;
        }
      }
      const pLo = pOutdated(grid, (now - asOf.hi) / YEAR_MS);
      const pHi = pOutdated(grid, (now - asOf.lo) / YEAR_MS);
      const hl = halfLife(grid);
      const triage = !timeSensitive ? "static" : reused ? "reused" : pHi < this.cfg.theta ? "low_risk" : "candidate";
      rows.push({
        id: `${r.id}_c${i}`, report_id: r.id, idx: i, span_start: c.start, span_end: c.end, text: c.text, statement: c.statement,
        class: cls.id, subject: c.subject, attribute: c.attribute, value: c.value, time_sensitive: timeSensitive ? 1 : 0,
        as_of_kind: asOf.kind, as_of_lo: Math.round(asOf.lo), as_of_hi: Math.round(asOf.hi), as_of_label: asOf.label, as_of_source: asOf.source ?? null,
        p_lo: pLo, p_hi: pHi, hl_median: hl.median, hl_lo: hl.lo, hl_hi: hl.hi,
        triage, search_query: c.searchQuery, norm_key: normKey,
        ...(reused ? {
          verdict: reused.verdict, current_value: reused.current_value, changed_on: reused.changed_on, explanation: reused.explanation,
          evidence_level: reused.evidence_level, level_reasons: reused.level_reasons, tiers: JSON.stringify(["T0"]),
          verified_at: reused.verified_at, reuse_until: reused.reuse_until, reused_from: reused.id,
        } : {}),
      });
    });
    // Verify the riskiest candidates, up to the per-response cap.
    const cands = rows.filter((x) => x.triage === "candidate").sort((a, b) => b.p_hi - a.p_hi);
    cands.forEach((x, k) => (x.triage = k < this.cfg.maxVerifyPerResponse ? "verify" : "cap"));
    this.store.tx(() => {
      for (const row of rows) {
        this.store.insert("claims", row);
        if (row.reused_from) {
          this.store.run(
            `INSERT INTO evidence (claim_id,eid,url,domain,site,title,published_at,content,score,tier,stance,quote,quote_valid)
             SELECT ?,eid,url,domain,site,title,published_at,content,score,tier,stance,quote,quote_valid FROM evidence WHERE claim_id=?`,
            row.id, row.reused_from,
          );
        }
      }
    });
    return rows;
  }

  private recordOutcome(c: Row, o: VerifyOutcome, learn = true) {
    const now = this.now();
    // "Not checked" = no verdict was attempted (no search, no judge, budget, search failure).
    // Retrieved evidence is still stored and shown, but it is not a verdict.
    const notChecked = o.llmCalls === 0 && o.limitation !== null;
    const verdict = notChecked ? null : o.verdict;
    const strongEnough = LEVEL_RANK[o.level as EvidenceLevel] >= LEVEL_RANK.moderate;
    const reuseUntil = verdict && strongEnough ? now + this.model.reuseWindowMs(c.class, this.cfg.theta) : null;
    this.store.tx(() => {
      this.store.run(
        `UPDATE claims SET triage=?, verdict=?, current_value=?, changed_on=?, explanation=?, evidence_level=?, level_reasons=?,
         limitation_kind=?, limitation=?, tiers=?, credits=?, verified_at=?, reuse_until=? WHERE id=?`,
        notChecked ? "not_checked" : "verify", verdict, o.currentValue, o.changedOn, o.explanation || null,
        notChecked ? null : o.level, JSON.stringify(o.levelReasons), o.limitation?.kind ?? null, o.limitation?.message ?? null,
        JSON.stringify(o.tiers), o.credits, verdict ? now : null, reuseUntil, c.id,
      );
      for (const e of o.evidence) {
        this.store.insert("evidence", {
          claim_id: c.id, eid: e.eid, url: e.url, domain: e.domain, site: e.site, title: e.title, published_at: e.publishedAt,
          content: e.content, score: e.score, tier: e.tier, stance: e.stance, quote: e.quote, quote_valid: e.quoteValid ? 1 : 0,
        });
      }
      // Learning: only well-evidenced change / no-change outcomes become observations.
      if (learn && strongEnough && (verdict === "current" || verdict === "superseded")) {
        const tau = (now - (Number(c.as_of_lo) + Number(c.as_of_hi)) / 2) / YEAR_MS;
        this.model.observe(c.class, tau, verdict === "superseded", c.id, now);
      }
    });
    this.bus.emit({ type: "claim", report_id: c.report_id, claim_id: c.id, verdict, level: notChecked ? null : o.level });
  }

  private summarise(id: string, ex: Extraction, timing: { extract_ms: number; verify_ms: number }, requestedAsOf: string | null) {
    const claims = this.store.all("SELECT * FROM claims WHERE report_id=? ORDER BY idx", id);
    const ts = claims.filter((c) => c.time_sensitive);
    const atRisk = ts.filter((c) => c.p_hi >= this.cfg.theta);
    const checked = claims.filter((c) => c.verdict);
    const count = (v: string) => checked.filter((c) => c.verdict === v).length;
    const stale = checked.filter((c) => (c.verdict === "superseded" || c.verdict === "contradicted") && LEVEL_RANK[c.evidence_level as EvidenceLevel] >= LEVEL_RANK.moderate);
    const notChecked = claims.filter((c) => c.triage === "not_checked" || c.triage === "cap");
    const possiblyStale = checked.filter((c) => (c.verdict === "superseded" || c.verdict === "contradicted") && !stale.includes(c));
    const verdicts = { current: count("current"), superseded: count("superseded"), contradicted: count("contradicted"), unverifiable: count("unverifiable") };
    const headline = headlineFor({ claims: claims.length, time_sensitive: ts.length, at_risk: atRisk.length, checked: checked.length, stale: stale.length, possibly_stale: possiblyStale.length, verdicts });
    return {
      headline, summary_version: 3,
      claims: claims.length, time_sensitive: ts.length, at_risk: atRisk.length, checked: checked.length,
      verdicts,
      stale: stale.length, possibly_stale: possiblyStale.length, not_checked: notChecked.length,
      weak_current: checked.filter((c) => c.verdict === "current" && LEVEL_RANK[c.evidence_level as EvidenceLevel] < LEVEL_RANK.moderate).length,
      extraction: { method: ex.method, model: ex.model ?? null, dropped: ex.dropped.length, note: ex.note ?? null },
      timing, theta: this.cfg.theta, requested_as_of: requestedAsOf,
      providers: { search: this.search ? this.search.kind : null, judge: this.llm ? this.llm.model : null },
    };
  }

  /** AD-11: invalidate stale cached answers; expire at the earliest claim reuse window. */
  applyCachePolicy(id: string) {
    const r = this.store.get("SELECT * FROM reports WHERE id=?", id);
    if (!r || !r.cache_id || r.cache_hit === 1 || r.status !== "done") return;
    // The plugin told Bifrost not to store this answer, so there is no entry to invalidate or
    // expire; a DELETE would return 200 and misleadingly look like an invalidation.
    if (r.ttl_set === "no-store") return;
    const claims = this.store.all("SELECT * FROM claims WHERE report_id=?", id);
    const stale = claims.filter((c) => (c.verdict === "superseded" || c.verdict === "contradicted") && LEVEL_RANK[c.evidence_level as EvidenceLevel] >= LEVEL_RANK.moderate);
    const now = this.now();
    if (stale.length) {
      this.cache.schedule(id, r.cache_id, "invalidate_stale", now, `${stale.length} claim${stale.length > 1 ? "s" : ""} judged outdated: “${clip(stale[0].statement, 80)}”`);
      return;
    }
    const windows = claims.filter((c) => c.reuse_until && c.verdict === "current").map((c) => Number(c.reuse_until));
    if (!windows.length) return;
    const earliest = Math.min(...windows);
    const ttlSec = /^\d+s$/.test(r.ttl_set ?? "") ? Number(r.ttl_set.slice(0, -1)) : this.cfg.cacheTTLSeconds;
    const cacheExpiry = Number(r.created_at) + ttlSec * 1000;
    if (earliest < cacheExpiry) {
      this.cache.schedule(id, r.cache_id, "expire_reuse_window", earliest, `earliest claim reuse window ends ${new Date(earliest).toISOString()}, before the cache TTL`);
    }
  }

  syncResult(id: string): SyncResult {
    const r = this.store.get("SELECT status, summary FROM reports WHERE id=?", id);
    if (!r || r.status !== "done") return { status: r?.status === "failed" ? "failed" : "unverified", summary: r?.status === "failed" ? "analysis failed" : "not finished", stale: 0, no_store: false, annotation: "" };
    const s = JSON.parse(r.summary ?? "{}");
    const claims = this.store.all("SELECT * FROM claims WHERE report_id=? ORDER BY idx", id);
    const stale = claims.filter((c) => (c.verdict === "superseded" || c.verdict === "contradicted") && LEVEL_RANK[c.evidence_level as EvidenceLevel] >= LEVEL_RANK.moderate);
    const status: SyncResult["status"] = s.at_risk === 0 ? "verified" : s.checked >= s.at_risk ? "verified" : s.checked > 0 ? "partial" : "unverified";
    let annotation = "";
    if (stale.length) {
      const lines = stale.slice(0, 3).map((c) => {
        const src = this.store.get("SELECT site, published_at FROM evidence WHERE claim_id=? AND quote_valid=1 ORDER BY published_at DESC LIMIT 1", c.id);
        const now = c.current_value ? ` Current: ${c.current_value}.` : "";
        const cite = src ? ` (source: ${src.site}${src.published_at ? ", " + fmtDate(Number(src.published_at)) : ""})` : "";
        return `• “${clip(c.text, 120)}” is ${c.verdict}.${now}${cite}`;
      });
      annotation = `Halflife freshness check: ${stale.length} claim${stale.length > 1 ? "s" : ""} in this answer appear${stale.length > 1 ? "" : "s"} outdated.\n${lines.join("\n")}\nReport: ${id}`;
    }
    return { status, summary: s.headline ?? "", stale: stale.length, no_store: stale.length > 0, annotation };
  }

  // ------------------------------------------------------------ views

  reportView(id: string): Row | null {
    const r = this.store.get("SELECT * FROM reports WHERE id=?", id);
    if (!r) return null;
    const claims = this.store.all("SELECT * FROM claims WHERE report_id=? ORDER BY idx", id).map((c) => ({
      id: c.id, idx: c.idx, span: [c.span_start, c.span_end], text: c.text, statement: c.statement,
      class: { id: c.class, label: getClass(c.class).label, static: !!getClass(c.class).static },
      subject: c.subject, attribute: c.attribute, value: c.value, time_sensitive: !!c.time_sensitive,
      as_of: { kind: c.as_of_kind, lo: c.as_of_lo, hi: c.as_of_hi, label: c.as_of_label, source: c.as_of_source },
      p_outdated: { lo: c.p_lo, hi: c.p_hi, calibrated: false },
      half_life_years: { median: c.hl_median, lo: c.hl_lo, hi: c.hl_hi },
      triage: c.triage, search_query: c.search_query,
      verdict: c.verdict, current_value: c.current_value, changed_on: c.changed_on, explanation: c.explanation,
      evidence_level: c.evidence_level, level_reasons: c.level_reasons ? JSON.parse(c.level_reasons) : [],
      limitation: c.limitation ? { kind: c.limitation_kind, message: c.limitation } : null,
      tiers: c.tiers ? JSON.parse(c.tiers) : [], credits: c.credits, verified_at: c.verified_at, reuse_until: c.reuse_until, reused_from: c.reused_from,
      evidence: this.store.all("SELECT * FROM evidence WHERE claim_id=? ORDER BY tier, eid", c.id).map((e) => ({
        eid: e.eid, url: e.url, domain: e.domain, site: e.site, title: e.title, published_at: e.published_at, content: e.content,
        score: e.score, tier: e.tier, stance: e.stance, quote: e.quote, quote_valid: !!e.quote_valid,
      })),
    }));
    const actions = this.store.all("SELECT action, due_at, status, reason, result, done_at FROM cache_actions WHERE report_id=? ORDER BY id", r.id);
    return {
      id: r.id, created_at: r.created_at, source: r.source, mode: r.mode, model: r.model, prompt: r.prompt, text: r.text,
      truncated: !!r.truncated, stream: !!r.stream, vk_fingerprint: r.vk_fingerprint,
      cache: { id: r.cache_id, hit: r.cache_hit === null ? null : !!r.cache_hit, ttl_set: r.ttl_set, actions },
      triage_groups: JSON.parse(r.triage_groups ?? "[]"), status: r.status, stage: r.stage, error: r.error,
      extraction: r.extraction, extraction_note: r.extraction_note, linked_report_id: r.linked_report_id,
      credits: r.credits, llm_calls: r.llm_calls, started_at: r.started_at, finished_at: r.finished_at,
      summary: r.summary ? JSON.parse(r.summary) : null, claims,
    };
  }

  listReports(limit: number, before?: number): Row[] {
    const rows = this.store.all(
      `SELECT r.id, r.created_at, r.source, r.mode, r.model, r.status, r.stage, r.cache_hit, r.ttl_set, r.linked_report_id, r.summary,
              r.stream, substr(COALESCE(r.prompt, r.text), 1, 160) AS preview,
              (SELECT MAX(p_hi) FROM claims c WHERE c.report_id = COALESCE(r.linked_report_id, r.id) AND c.time_sensitive=1) AS max_p
       FROM reports r WHERE r.created_at < ? ORDER BY r.created_at DESC LIMIT ?`,
      before ?? Number.MAX_SAFE_INTEGER, Math.min(200, Math.max(1, limit)),
    );
    return rows.map((r) => ({ ...r, cache_hit: r.cache_hit === null ? null : !!r.cache_hit, stream: !!r.stream, summary: r.summary ? JSON.parse(r.summary) : null }));
  }
}
