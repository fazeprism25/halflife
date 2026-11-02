// Per-class change-rate posteriors, updated from verification outcomes (AD-09).
// Only verdicts backed by strong or moderate evidence become observations, which limits label
// noise from judge errors. "contradicted" is not a change observation (the claim was never true).

import { CLASSES, getClass, priorBeta } from "./classes.ts";
import { type Grid, type Observation, gammaGrid, halfLife, pOutdated, reuseWindowYears, survival } from "./freshness.ts";
import type { Store } from "./store.ts";

export class ClassModel {
  private store: Store;
  private cache = new Map<string, { n: number; grid: Grid }>();
  constructor(store: Store) {
    this.store = store;
  }

  observations(classId: string): Observation[] {
    return this.store
      .all("SELECT tau_years, changed FROM observations WHERE class=? ORDER BY id", classId)
      .map((r) => ({ tauYears: Number(r.tau_years), changed: !!r.changed }));
  }

  grid(classId: string): Grid {
    const c = getClass(classId);
    const n = Number(this.store.get("SELECT COUNT(*) AS n FROM observations WHERE class=?", c.id)?.n ?? 0);
    const hit = this.cache.get(c.id);
    if (hit && hit.n === n) return hit.grid;
    const grid = gammaGrid(c.alpha, priorBeta(c), n ? this.observations(c.id) : []);
    this.cache.set(c.id, { n, grid });
    return grid;
  }

  observe(classId: string, tauYears: number, changed: boolean, claimId: string, now = Date.now()) {
    if (!(tauYears > 0) || !Number.isFinite(tauYears)) return;
    this.store.insert("observations", { class: getClass(classId).id, tau_years: tauYears, changed: changed ? 1 : 0, claim_id: claimId, created_at: now });
  }

  /** Summary for the console: prior vs posterior half-life and survival curves. */
  summary() {
    const horizons = [1 / 365.25, 7 / 365.25, 30 / 365.25, 0.25, 0.5, 1, 2, 3, 5, 10];
    return CLASSES.map((c) => {
      const prior = gammaGrid(c.alpha, priorBeta(c));
      const post = this.grid(c.id);
      const obs = this.store.get("SELECT COUNT(*) AS n, COALESCE(SUM(changed),0) AS changed FROM observations WHERE class=?", c.id) as any;
      const curveTs = curveTimes(c.lifetimeYears);
      return {
        id: c.id, label: c.label, describe: c.describe, rationale: c.rationale, static: !!c.static,
        prior: { alpha: c.alpha, beta: priorBeta(c), lifetime_years: c.lifetimeYears, half_life: halfLife(prior) },
        posterior: { half_life: halfLife(post) },
        observations: { n: Number(obs?.n ?? 0), changed: Number(obs?.changed ?? 0) },
        p_outdated: horizons.map((t) => ({ years: t, prior: pOutdated(prior, t), posterior: pOutdated(post, t) })),
        curve: { t: curveTs, prior: survival(prior, curveTs), posterior: survival(post, curveTs) },
        evidence_recency_days: c.evidenceRecencyDays,
        tavily_topic: c.tavilyTopic,
      };
    });
  }

  reuseWindowMs(classId: string, theta: number): number {
    return reuseWindowYears(this.grid(classId), theta) * 365.25 * 24 * 3600 * 1000;
  }
}

/** Log-spaced curve sample times spanning roughly 0.01×–10× the class lifetime. */
function curveTimes(lifetime: number): number[] {
  const lo = Math.log(Math.max(lifetime * 0.01, 1 / 365.25 / 24));
  const hi = Math.log(Math.min(lifetime * 10, 50));
  return Array.from({ length: 48 }, (_, i) => Math.exp(lo + ((hi - lo) * i) / 47));
}
