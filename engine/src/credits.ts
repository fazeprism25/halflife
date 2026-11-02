// Hard application-side ceiling on Tavily credit consumption (AD-19), plus the provider
// account-usage reading the console shows (AD-34).
//
// Three separate concepts, never derived from one another:
//   A. PROVIDER ACCOUNT ALLOWANCE: what Tavily's GET /usage reports for the authenticated
//      account (account.plan_usage / account.plan_limit). Read, cached, displayed. It is
//      provider data, never a configured default.
//   B. HALFLIFE LIFETIME CEILING: HALFLIFE_TOTAL_CREDIT_CAP, summed over the engine's own
//      spend ledger. Configuration only.
//   C. HALFLIFE DAILY LIMIT: HALFLIFE_DAILY_CREDIT_CAP. Configuration only.
// A never changes B or C. A larger provider allowance never lets the engine spend more than B
// and C allow; it only moves the separate account guard below.
//
// Before every paid search/extract the guard checks, and refuses (verdict limitation "budget")
// if any would be exceeded or cannot be established:
//   1. C, the daily cap
//   2. B, the lifetime cap
//   3. the ACCOUNT GUARD: floor(A × fraction), checked against Tavily's own /usage counter
//      (read through the Bifrost relay, so the engine never holds the key). Tavily's counter lags
//      (measured 2026-11-02: minutes to hours), so the guard uses max(Tavily's counter, the
//      counter at first read + every credit reserved locally since, the engine's lifetime spend).
//      If account usage cannot be read, if any pay-as-you-go usage is reported, or if the
//      allowance is not a finite reported number, the guard fails CLOSED.
// Reservations are serialised, so concurrent claims cannot jointly overshoot.
//
// /usage is rate-limited (Tavily docs: 10 requests per 10 minutes per key; 429 with an optional
// Retry-After header). Readings are cached for refreshMs; failures back off; a 429's Retry-After
// is honoured; manual refreshes have their own minimum interval.

/** State of a reported limit. Only "finite" is a number the engine may compute with. */
export type LimitState = "finite" | "unlimited" | "missing" | "invalid";

export type AccountUsage = {
  /** account.plan_usage: credits used on the account this billing cycle; null when not reported. */
  planUsage: number | null;
  /** account.plan_limit, only when it is a finite positive number (see planLimitState). */
  planLimit: number | null;
  planLimitState: LimitState;
  paygoUsage: number;
  paygoLimit: number | null;
  plan: string | null;
  /** key.usage / key.limit: the API KEY's own counter and cap. Not the account's. */
  keyUsage: number;
  keyLimit: number | null;
  keyLimitState: LimitState;
};

export type CreditGuardOptions = {
  /** Reads Tavily's account usage; null disables the account check (test search only). */
  fetchUsage: (() => Promise<AccountUsage>) | null;
  spentToday: () => number;
  spentTotal: () => number;
  dailyCap: number;
  totalCap: number;
  /** Share of the reported allowance the account guard lets the engine reach (the rest is reserve). */
  ceilingFraction: number;
  /** Cache lifetime of a good reading. */
  refreshMs: number;
  now: () => number;
  /** A reading older than this is shown as stale (default 3 × refreshMs). */
  staleMs?: number;
  /** Minimum wait after a failed read (default 120 s), unless Retry-After says longer. */
  failBackoffMs?: number;
  /** Minimum interval between manual (console) refreshes (default 120 s). */
  manualMinMs?: number;
};

export type Reservation = { ok: true } | { ok: false; reason: string };

export type UsageState = "off" | "pending" | "ok" | "stale" | "unavailable";

export class CreditGuard {
  private o: CreditGuardOptions;
  private account: AccountUsage | null = null;
  private accountAt = 0;
  private attemptAt = 0;
  private manualAt = 0;
  private retryUntil = 0;
  /** Tavily's counter at the first successful read, and credits reserved/settled since. */
  private base: number | null = null;
  private local = 0;
  private lastError: string | null = null;
  private lastErrorAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private inflight: Promise<void> | null = null;

  constructor(o: CreditGuardOptions) {
    this.o = o;
  }

  private get staleMs() { return this.o.staleMs ?? this.o.refreshMs * 3; }
  private get failBackoffMs() { return this.o.failBackoffMs ?? 120_000; }
  private get manualMinMs() { return this.o.manualMinMs ?? 120_000; }

  /** Reserve n credits before a paid call. Serialised. */
  reserve(n: number): Promise<Reservation> {
    const p = this.chain.then(() => this.reserveNow(n));
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Record the actual credits a call consumed (replaces the reserved estimate). */
  settle(reserved: number, actual: number) {
    this.local = Math.max(0, this.local + actual - reserved);
  }

  /**
   * Reads /usage if the cached reading is due, respecting the failure backoff and Retry-After.
   * `manual` (the console's Refresh button) skips the cache but has its own minimum interval.
   * Single-flight; never throws. Returns whether a read was attempted.
   */
  async refresh(opts: { manual?: boolean } = {}): Promise<{ attempted: boolean; reason?: string }> {
    if (!this.o.fetchUsage) return { attempted: false, reason: "account check is off" };
    const now = this.o.now();
    if (now < this.retryUntil) return { attempted: false, reason: `Tavily asked to wait (Retry-After) until ${new Date(this.retryUntil).toISOString()}` };
    if (opts.manual) {
      if (this.manualAt && now - this.manualAt < this.manualMinMs) return { attempted: false, reason: `manual refresh is limited to one per ${Math.round(this.manualMinMs / 1000)} s (Tavily allows 10 /usage reads per 10 minutes)` };
    } else if (this.account && now - this.accountAt <= this.o.refreshMs) {
      return { attempted: false, reason: "cached reading is fresh" };
    }
    // After a failure: with an earlier reading the guard can keep counting locally, so wait the full
    // backoff; with none, every paid call is refused, so retry soon (e.g. the gateway was still
    // starting when the engine made its first read). A 429's Retry-After is honoured above.
    const backoff = this.account ? this.failBackoffMs : Math.min(this.failBackoffMs, 5_000);
    if (this.attemptAt && this.lastErrorAt === this.attemptAt && now - this.attemptAt < backoff) {
      return { attempted: false, reason: "backing off after a failed read" };
    }
    if (opts.manual) this.manualAt = now;
    if (!this.inflight) this.inflight = this.readNow().finally(() => { this.inflight = null; });
    await this.inflight;
    return { attempted: true };
  }

  private async readNow() {
    const fetchUsage = this.o.fetchUsage!;
    this.attemptAt = this.o.now();
    try {
      const a = await fetchUsage();
      this.account = a;
      this.accountAt = this.o.now();
      if (this.base == null && a.planUsage != null) this.base = a.planUsage;
      this.lastError = null;
      this.lastErrorAt = 0;
    } catch (e) {
      this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
      this.lastErrorAt = this.attemptAt;
      const ra = Number((e as any)?.retryAfterMs);
      if ((e as any)?.status === 429 || /429/.test(this.lastError)) {
        this.retryUntil = this.attemptAt + Math.max(Number.isFinite(ra) && ra > 0 ? ra : 0, this.failBackoffMs);
      }
    }
  }

  /** Conservative account usage: Tavily's (lagging) counter or our own count, whichever is higher. */
  used(): number | null {
    if (!this.account || this.account.planUsage == null || this.base == null) return null;
    // The engine's own lifetime spend is a lower bound too (it survives restarts; the base doesn't).
    return Math.max(this.account.planUsage, this.base + this.local, this.o.spentTotal());
  }

  /** The account guard: a share of the provider-reported allowance; null when there is none. */
  ceiling(): number | null {
    const a = this.account;
    if (!a || a.planLimitState !== "finite" || a.planLimit == null) return null;
    return Math.floor(a.planLimit * this.o.ceilingFraction);
  }

  usageState(): UsageState {
    if (!this.o.fetchUsage) return "off";
    if (!this.account) return this.lastError ? "unavailable" : "pending";
    const old = this.o.now() - this.accountAt > this.staleMs;
    const failedSince = this.lastErrorAt > this.accountAt;
    return old || failedSince ? "stale" : "ok";
  }

  /** Provider account usage (A) as the console shows it. Numbers only where they are reliable. */
  providerUsage() {
    const a = this.account;
    const allowance = a && a.planLimitState === "finite" ? a.planLimit : null;
    const used = a?.planUsage ?? null;
    const est = this.used();
    return {
      source: "Tavily GET /usage (account.plan_usage, account.plan_limit), via the Bifrost relay",
      state: this.usageState(),
      fetched_at: this.accountAt || null,
      attempted_at: this.attemptAt || null,
      retry_after_until: this.retryUntil > this.o.now() ? this.retryUntil : null,
      last_error: this.lastError,
      last_error_at: this.lastErrorAt || null,
      cache_ms: this.o.refreshMs,
      stale_after_ms: this.staleMs,
      manual_min_ms: this.manualMinMs,
      plan: a?.plan ?? null,
      used,
      allowance,
      allowance_state: a ? a.planLimitState : null,
      remaining: allowance != null && used != null ? Math.max(0, allowance - used) : null,
      estimated_used: est,
      remaining_conservative: allowance != null && est != null ? Math.max(0, allowance - est) : null,
      paygo: a ? { used: a.paygoUsage, limit: a.paygoLimit } : null,
      key: a ? { used: a.keyUsage, limit: a.keyLimitState === "finite" ? a.keyLimit : null, limit_state: a.keyLimitState } : null,
    };
  }

  status() {
    return {
      account: this.account,
      account_checked_at: this.accountAt || null,
      account_check: this.o.fetchUsage ? "on" : "off",
      ceiling_fraction: this.o.ceilingFraction,
      account_ceiling: this.ceiling(),
      estimated_account_used: this.used(),
      reserved_since_start: this.local,
      daily_cap: this.o.dailyCap,
      total_cap: this.o.totalCap,
      spent_today: this.o.spentToday(),
      spent_total: this.o.spentTotal(),
      last_error: this.lastError,
      provider: this.providerUsage(),
    };
  }

  private async reserveNow(n: number): Promise<Reservation> {
    if (this.o.spentToday() + n > this.o.dailyCap) return { ok: false, reason: "Daily verification credit cap reached; claim not checked." };
    if (this.o.spentTotal() + n > this.o.totalCap) return { ok: false, reason: "Lifetime engine credit cap reached; claim not checked." };
    if (!this.o.fetchUsage) return { ok: true };

    await this.refresh();
    // With an earlier reading, a failed refresh (e.g. 429) keeps the guard counting locally on top
    // of it, which stays conservative; with none it refuses.
    if (!this.account) return { ok: false, reason: `Tavily account usage could not be read (${this.lastError ?? "not read yet"}); paid search refused so spend stays inside the free allowance.` };
    const a = this.account;
    if (a.paygoUsage > 0) return { ok: false, reason: `Tavily reports pay-as-you-go usage (${a.paygoUsage}); paid search refused.` };
    if (a.planUsage == null) return { ok: false, reason: "Tavily did not report account usage (plan_usage); paid search refused." };
    const ceiling = this.ceiling();
    if (ceiling == null) return { ok: false, reason: `Tavily plan limit is unknown (${a.planLimitState}); paid search refused.` };
    const used = this.used() as number;
    const keyUsed = Math.max(a.keyUsage, used - a.planUsage + a.keyUsage);
    if (a.keyLimitState === "finite" && a.keyLimit != null && keyUsed + n > Math.floor(a.keyLimit * this.o.ceilingFraction)) {
      return { ok: false, reason: "Tavily API-key credit ceiling reached; claim not checked." };
    }
    if (a.keyLimitState === "invalid") return { ok: false, reason: "Tavily reported an unreadable API-key limit; paid search refused." };
    if (used + n > ceiling) {
      return { ok: false, reason: `Tavily account guard reached (${ceiling} of the ${a.planLimit} credits Tavily reports; the rest is reserved); claim not checked.` };
    }
    this.local += n;
    return { ok: true };
  }
}

/**
 * Classifies a reported limit. `nullMeans` is what an explicit null means for that field:
 * Tavily documents key.limit null as unlimited; account.plan_limit is documented as an integer
 * with no null meaning, so a null there is treated as missing.
 */
function limitOf(v: any, nullMeans: "unlimited" | "missing"): { value: number | null; state: LimitState } {
  if (v === undefined) return { value: null, state: "missing" };
  if (v === null) return { value: null, state: nullMeans };
  if (typeof v === "string" && /^unlimited$/i.test(v.trim())) return { value: null, state: "unlimited" };
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return { value: null, state: "invalid" };
  return { value: n, state: "finite" };
}

const count = (v: any): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Parses Tavily's GET /usage body. Throws when the shape is not recognised. */
export function parseUsage(j: any): AccountUsage {
  const acc = j?.account;
  const key = j?.key;
  if (!acc || typeof acc !== "object") throw new Error("usage response has no account object");
  const plan = limitOf(acc.plan_limit, "missing");
  const keyLim = limitOf(key?.limit, "unlimited");
  const paygoLim = limitOf(acc.paygo_limit, "missing");
  return {
    planUsage: count(acc.plan_usage),
    planLimit: plan.value,
    planLimitState: plan.state,
    // A missing pay-as-you-go counter reads as 0: the guard still refuses on plan exhaustion first.
    paygoUsage: count(acc.paygo_usage) ?? 0,
    paygoLimit: paygoLim.value,
    plan: typeof acc.current_plan === "string" ? acc.current_plan : null,
    keyUsage: count(key?.usage) ?? 0,
    keyLimit: keyLim.value,
    keyLimitState: key && typeof key === "object" ? keyLim.state : "missing",
  };
}
