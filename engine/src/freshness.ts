// Freshness mathematics (AD-09). Pure functions, no I/O.
//
// A. Expected lifespan of a class: λ ~ Gamma(α, β) per year; half-life ln2/λ, shown with a
//    credible interval from the λ distribution.
// B. P(outdated after Δt) = E_λ[1 − e^{−λΔt}]. For the Gamma prior this is the Lomax CDF
//    1 − (β/(β+Δt))^α. We evaluate it on a 1-D log-spaced λ grid so that the same code path
//    handles the prior and the posterior after verification outcomes are observed.
// Observations are interval-censored Poisson events (Cho & Garcia-Molina 2003): a claim known
// true at time 0 and checked after τ years either changed (1 − e^{−λτ}) or not (e^{−λτ}).

export type Grid = { lambda: Float64Array; w: Float64Array };
export type Observation = { tauYears: number; changed: boolean };

const N = 720;
const LOG_MIN = Math.log(1e-9);
const LOG_MAX = Math.log(1e5);
const LAMBDA = (() => {
  const a = new Float64Array(N);
  for (let i = 0; i < N; i++) a[i] = Math.exp(LOG_MIN + ((LOG_MAX - LOG_MIN) * i) / (N - 1));
  return a;
})();

function normalise(logw: Float64Array): Float64Array {
  let max = -Infinity;
  for (const v of logw) if (v > max) max = v;
  const w = new Float64Array(logw.length);
  let s = 0;
  for (let i = 0; i < logw.length; i++) {
    w[i] = Math.exp(logw[i] - max);
    s += w[i];
  }
  for (let i = 0; i < w.length; i++) w[i] /= s;
  return w;
}

/** Log-density of Gamma(α, β) for u = ln λ (uniform grid in u), up to a constant. */
function priorLog(alpha: number, beta: number): Float64Array {
  if (!(alpha > 0) || !(beta > 0)) throw new RangeError("alpha and beta must be positive");
  const lw = new Float64Array(N);
  for (let i = 0; i < N; i++) lw[i] = alpha * Math.log(LAMBDA[i]) - beta * LAMBDA[i];
  return lw;
}

export function gammaGrid(alpha: number, beta: number, obs: Observation[] = []): Grid {
  const lw = priorLog(alpha, beta);
  for (const o of obs) {
    if (!(o.tauYears > 0) || !Number.isFinite(o.tauYears)) continue;
    for (let i = 0; i < N; i++) {
      const x = LAMBDA[i] * o.tauYears;
      // log(1 − e^{−x}) computed stably for small x
      lw[i] += o.changed ? (x < 1e-6 ? Math.log(x) : Math.log(-Math.expm1(-x))) : -x;
    }
  }
  return { lambda: LAMBDA, w: normalise(lw) };
}

/** P(at least one change within dt years). dt <= 0 gives 0. */
export function pOutdated(g: Grid, dtYears: number): number {
  if (!(dtYears > 0)) return 0;
  let p = 0;
  for (let i = 0; i < N; i++) p += g.w[i] * -Math.expm1(-g.lambda[i] * dtYears);
  return Math.min(1, Math.max(0, p));
}

/** Analytic Lomax marginal for the prior (used to test the grid). */
export function lomax(alpha: number, beta: number, dtYears: number): number {
  if (!(dtYears > 0)) return 0;
  return 1 - Math.pow(beta / (beta + dtYears), alpha);
}

/** Smallest dt (years) at which P(outdated) reaches theta: the claim's reuse window. */
export function reuseWindowYears(g: Grid, theta: number): number {
  if (!(theta > 0 && theta < 1)) throw new RangeError("theta must be in (0,1)");
  let lo = 0;
  let hi = 1e-6;
  while (pOutdated(g, hi) < theta && hi < 1e7) hi *= 2;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (pOutdated(g, mid) < theta) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Quantiles of λ under the grid distribution. */
export function lambdaQuantiles(g: Grid, qs: number[]): number[] {
  const out: number[] = [];
  for (const q of qs) {
    let c = 0;
    let v = g.lambda[N - 1];
    for (let i = 0; i < N; i++) {
      c += g.w[i];
      if (c >= q) {
        v = g.lambda[i];
        break;
      }
    }
    out.push(v);
  }
  return out;
}

export type HalfLife = { median: number; lo: number; hi: number };

/** Half-life ln2/λ in years: median and 90% credible interval. */
export function halfLife(g: Grid): HalfLife {
  const [l05, l50, l95] = lambdaQuantiles(g, [0.05, 0.5, 0.95]);
  return { median: Math.LN2 / l50, lo: Math.LN2 / l95, hi: Math.LN2 / l05 };
}

export function meanLambda(g: Grid): number {
  let m = 0;
  for (let i = 0; i < N; i++) m += g.w[i] * g.lambda[i];
  return m;
}

/** Survival curve S(t) = 1 − P(outdated) at the given times (years). */
export function survival(g: Grid, ts: number[]): number[] {
  return ts.map((t) => 1 - pOutdated(g, t));
}

export const YEAR_MS = 365.25 * 24 * 3600 * 1000;
export const yearsBetween = (a: number, b: number) => (b - a) / YEAR_MS;
