// Hard application-side ceiling on Tavily credit consumption (AD-19).
//
// The engine may only spend free-plan credits. Before every paid search/extract it checks
// three limits, and refuses the call (verdict limitation "budget") if any would be exceeded
// or cannot be established:
//   1. daily engine cap (HALFLIFE_DAILY_CREDIT_CAP)
//   2. lifetime engine cap, summed over the engine's own spend ledger (HALFLIFE_TOTAL_CREDIT_CAP)
//   3. the ACCOUNT ceiling: floor(plan_limit × fraction), checked against Tavily's own
//      /usage counter (read through the Bifrost relay, so the engine still never holds the
//      key). Tavily's counter lags by minutes (measured 2026-11-02: still 0 more than a minute
//      after a 1-credit search), so the guard uses max(Tavily's counter, the counter at first
//      read + every credit reserved locally since). If account usage cannot
//      be read, if any pay-as-you-go usage is reported, or if the plan has no finite limit,
//      the guard fails CLOSED.
// Reservations are serialised, so concurrent claims cannot jointly overshoot.

export type AccountUsage = {
  planUsage: number;
  planLimit: number | null;
  paygoUsage: number;
  paygoLimit: number | null;
  plan: string | null;
  keyUsage: number;
  keyLimit: number | null;
};

export type CreditGuardOptions = {
  /** Reads Tavily's account usage; null disables the account check (test search only). */
  fetchUsage: (() => Promise<AccountUsage>) | null;
  spentToday: () => number;
  spentTotal: () => number;
  dailyCap: number;
  totalCap: number;
  /** Share of the plan allowance development and evaluation may use (the rest is reserve). */
  ceilingFraction: number;
  refreshMs: number;
  now: () => number;
};

export type Reservation = { ok: true } | { ok: false; reason: string };

export class CreditGuard {
  private o: CreditGuardOptions;
  private account: AccountUsage | null = null;
  private accountAt = 0;
  /** Tavily's counter at the first successful read, and credits reserved/settled since. */
  private base: number | null = null;
  private local = 0;
  private lastError: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: CreditGuardOptions) {
    this.o = o;
  }

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

  /** Conservative account usage: Tavily's (lagging) counter or our own count, whichever is higher. */
  used(): number | null {
    if (!this.account || this.base == null) return null;
    // The engine's own lifetime spend is a lower bound too (it survives restarts; the base doesn't).
    return Math.max(this.account.planUsage, this.base + this.local, this.o.spentTotal());
  }

  ceiling(): number | null {
    const lim = this.account?.planLimit;
    if (lim == null || !Number.isFinite(lim) || lim <= 0) return null;
    return Math.floor(lim * this.o.ceilingFraction);
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
    };
  }

  private async reserveNow(n: number): Promise<Reservation> {
    if (this.o.spentToday() + n > this.o.dailyCap) return { ok: false, reason: "Daily verification credit cap reached; claim not checked." };
    if (this.o.spentTotal() + n > this.o.totalCap) return { ok: false, reason: "Lifetime engine credit cap reached; claim not checked." };
    if (!this.o.fetchUsage) return { ok: true };

    if (!this.account || this.o.now() - this.accountAt > this.o.refreshMs) {
      try {
        this.account = await this.o.fetchUsage();
        this.accountAt = this.o.now();
        if (this.base == null) this.base = this.account.planUsage;
        this.lastError = null;
      } catch (e) {
        this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        // /usage is itself rate-limited (HTTP 429 seen 2026-11-02). With an earlier reading the
        // guard keeps counting locally on top of it, which stays conservative; with none it
        // refuses.
        if (!this.account) return { ok: false, reason: `Tavily account usage could not be read (${this.lastError}); paid search refused so spend stays inside the free allowance.` };
        this.accountAt = this.o.now();
      }
    }
    const a = this.account;
    if (a.paygoUsage > 0) return { ok: false, reason: `Tavily reports pay-as-you-go usage (${a.paygoUsage}); paid search refused.` };
    const ceiling = this.ceiling();
    if (ceiling == null) return { ok: false, reason: "Tavily plan limit is unknown; paid search refused." };
    const used = this.used() as number;
    const keyUsed = Math.max(a.keyUsage, used - a.planUsage + a.keyUsage);
    if (a.keyLimit != null && keyUsed + n > Math.floor(a.keyLimit * this.o.ceilingFraction)) {
      return { ok: false, reason: "Tavily API-key credit ceiling reached; claim not checked." };
    }
    if (used + n > ceiling) {
      return { ok: false, reason: `Tavily free-allowance ceiling reached (${ceiling} of ${a.planLimit} credits; the rest is reserved); claim not checked.` };
    }
    this.local += n;
    return { ok: true };
  }
}

/** Parses Tavily's GET /usage body. Throws when the shape is not recognised. */
export function parseUsage(j: any): AccountUsage {
  const acc = j?.account;
  const key = j?.key;
  if (!acc || typeof acc !== "object") throw new Error("usage response has no account object");
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const lim = (v: any) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    planUsage: num(acc.plan_usage),
    planLimit: lim(acc.plan_limit),
    paygoUsage: num(acc.paygo_usage),
    paygoLimit: lim(acc.paygo_limit),
    plan: typeof acc.current_plan === "string" ? acc.current_plan : null,
    keyUsage: num(key?.usage),
    keyLimit: lim(key?.limit),
  };
}
