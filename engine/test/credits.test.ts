// Tavily free-allowance guard (AD-19): it must refuse rather than risk a paid credit.
import assert from "node:assert/strict";
import test from "node:test";
import { CreditGuard, parseUsage, type AccountUsage, type CreditGuardOptions } from "../src/credits.ts";

const acct = (o: Partial<AccountUsage> = {}): AccountUsage => ({ planUsage: 0, planLimit: 1000, planLimitState: "finite", paygoUsage: 0, paygoLimit: null, plan: "Researcher", keyUsage: 0, keyLimit: null, keyLimitState: "unlimited", ...o });

function guard(o: { usage?: () => Promise<AccountUsage>; today?: number; total?: number; daily?: number; totalCap?: number; now?: () => number; extra?: Partial<CreditGuardOptions> } = {}) {
  let today = o.today ?? 0;
  let total = o.total ?? 0;
  const g = new CreditGuard({
    fetchUsage: o.usage ?? (async () => acct()),
    spentToday: () => today, spentTotal: () => total,
    dailyCap: o.daily ?? 150, totalCap: o.totalCap ?? 700, ceilingFraction: 0.8, refreshMs: 60_000, now: o.now ?? (() => 0), ...(o.extra ?? {}),
  });
  return { g, spend: (n: number) => { today += n; total += n; } };
}

test("parseUsage reads Tavily's /usage body", () => {
  const u = parseUsage({ key: { usage: 3, limit: null }, account: { current_plan: "Researcher", plan_usage: 3, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } });
  assert.deepEqual(u, { planUsage: 3, planLimit: 1000, planLimitState: "finite", paygoUsage: 0, paygoLimit: null, plan: "Researcher", keyUsage: 3, keyLimit: null, keyLimitState: "unlimited" });
  assert.throws(() => parseUsage({ detail: "unauthorized" }));
});

test("the account ceiling is 80% of the plan allowance and counts credits since the last refresh", async () => {
  let calls = 0;
  const { g } = guard({ usage: async () => (calls++, acct({ planUsage: 797 })) });
  assert.equal((await g.reserve(1)).ok, true); // 798
  assert.equal((await g.reserve(2)).ok, true); // 800
  const r = await g.reserve(1);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /guard reached \(800 of the 1000 credits Tavily reports/);
  assert.equal(calls, 1, "usage is cached within the refresh window");
});

test("settle replaces the estimate with the actual credits", async () => {
  const { g } = guard({ usage: async () => acct({ planUsage: 799 }) });
  assert.equal((await g.reserve(1)).ok, true);
  g.settle(1, 0); // the call cost nothing (e.g. an extract that failed)
  assert.equal((await g.reserve(1)).ok, true);
  assert.equal((await g.reserve(1)).ok, false);
});

test("fails closed: unreadable usage, pay-as-you-go usage, unknown plan limit", async () => {
  for (const [usage, re] of [
    [async () => { throw new Error("HTTP 500"); }, /could not be read/],
    [async () => acct({ paygoUsage: 1 }), /pay-as-you-go/],
    [async () => acct({ planLimit: null, planLimitState: "missing" }), /plan limit is unknown/],
    [async () => acct({ keyLimit: 10, keyLimitState: "finite", keyUsage: 8 }), /API-key credit ceiling/],
  ] as const) {
    const r = await guard({ usage }).g.reserve(1);
    assert.equal(r.ok, false);
    assert.match((r as any).reason, re);
  }
});

test("daily and lifetime engine caps apply before the account check", async () => {
  let fetched = false;
  const usage = async () => ((fetched = true), acct());
  assert.match(((await guard({ usage, today: 150 }).g.reserve(1)) as any).reason, /Daily/);
  assert.match(((await guard({ usage, total: 700 }).g.reserve(1)) as any).reason, /Lifetime/);
  assert.equal(fetched, false);
});

test("concurrent reservations cannot jointly overshoot the ceiling", async () => {
  const { g } = guard({ usage: async () => (await new Promise((r) => setTimeout(r, 5)), acct({ planUsage: 795 })) });
  const rs = await Promise.all(Array.from({ length: 20 }, () => g.reserve(1)));
  assert.equal(rs.filter((r) => r.ok).length, 5);
});

test("usage is re-read after the refresh window", async () => {
  let t = 0;
  let used = 0;
  const { g } = guard({ now: () => t, usage: async () => acct({ planUsage: used }) });
  assert.equal((await g.reserve(1)).ok, true);
  used = 800; // spent elsewhere (e.g. a probe script)
  t = 61_000;
  assert.equal((await g.reserve(1)).ok, false);
});

test("a lagging Tavily counter cannot erase locally counted credits", async () => {
  let t = 0;
  const { g } = guard({ now: () => t, usage: async () => acct({ planUsage: 790 }) }); // counter never moves
  for (let i = 0; i < 10; i++) {
    assert.equal((await g.reserve(1)).ok, true);
    t += 61_000; // forces a refresh that still reports 790
  }
  assert.equal((await g.reserve(1)).ok, false);
  assert.equal(g.used(), 800);
});

test("after one good reading, a rate-limited /usage keeps the guard counting locally", async () => {
  let t = 0;
  let fail = false;
  const { g } = guard({ now: () => t, usage: async () => { if (fail) throw new Error("Tavily /usage HTTP 429"); return acct({ planUsage: 798 }); } });
  assert.equal((await g.reserve(1)).ok, true); // 799
  fail = true;
  t = 61_000;
  assert.equal((await g.reserve(1)).ok, true); // 800, from the earlier reading + local count
  assert.equal((await g.reserve(1)).ok, false);
  assert.match(g.status().last_error ?? "", /429/);
});

test("the engine's persisted lifetime spend is a floor after a restart", async () => {
  const { g } = guard({ total: 600, totalCap: 10000, usage: async () => acct({ planUsage: 0 }) }); // counter lagging at 0
  assert.equal((await g.reserve(1)).ok, true);
  assert.equal(g.used(), 600);
});

// ---- AD-34: provider allowance (A) is provider data; the lifetime (B) and daily (C) caps are config.

const body = (account: Record<string, unknown>, key: Record<string, unknown> = { usage: 0, limit: null }) => ({ key, account: { current_plan: "Researcher", paygo_usage: 0, paygo_limit: null, ...account } });

test("parseUsage keeps whatever allowance Tavily reports, including plan plus add-on totals", () => {
  for (const limit of [1000, 4000, 9000, 15000, 100000]) {
    const u = parseUsage(body({ plan_usage: 131, plan_limit: limit }));
    assert.equal(u.planLimit, limit);
    assert.equal(u.planLimitState, "finite");
    assert.equal(u.planUsage, 131);
  }
});

test("parseUsage: missing, unlimited and invalid allowances are never numbers", () => {
  const cases: [unknown, string][] = [[undefined, "missing"], [null, "missing"], ["unlimited", "unlimited"], [-1, "invalid"], [0, "invalid"], ["abc", "invalid"], [12.5, "invalid"]];
  for (const [v, state] of cases) {
    const acc: Record<string, unknown> = { plan_usage: 5 };
    if (v !== undefined) acc.plan_limit = v;
    const u = parseUsage(body(acc));
    assert.equal(u.planLimit, null, `plan_limit ${String(v)}`);
    assert.equal(u.planLimitState, state, `plan_limit ${String(v)}`);
  }
  assert.equal(parseUsage(body({ plan_limit: 1000 })).planUsage, null, "a missing plan_usage is not read as 0");
});

test("key-level limits are kept apart from the account allowance", () => {
  const unlimitedKey = parseUsage(body({ plan_usage: 10, plan_limit: 9000 }, { usage: 4, limit: null }));
  assert.deepEqual([unlimitedKey.keyLimit, unlimitedKey.keyLimitState, unlimitedKey.planLimit], [null, "unlimited", 9000]);
  const cappedKey = parseUsage(body({ plan_usage: 10, plan_limit: 9000 }, { usage: 4, limit: 50 }));
  assert.deepEqual([cappedKey.keyLimit, cappedKey.keyLimitState, cappedKey.planLimit], [50, "finite", 9000]);
});

test("the account guard follows the reported allowance; the lifetime and daily caps never do", async () => {
  for (const limit of [1000, 9000, 40000]) {
    const { g } = guard({ usage: async () => acct({ planLimit: limit, planUsage: 131 }), daily: 150, totalCap: 700 });
    assert.equal((await g.reserve(1)).ok, true);
    const s = g.status();
    assert.equal(s.provider.allowance, limit, "A: as reported");
    assert.equal(s.account_ceiling, Math.floor(limit * 0.8), "account guard: a share of A");
    assert.equal(s.total_cap, 700, "B unchanged by A");
    assert.equal(s.daily_cap, 150, "C unchanged by A");
    assert.equal(s.provider.remaining, limit - 131);
  }
  // A 9,000-credit allowance still cannot take the engine past its own lifetime cap.
  const big = guard({ usage: async () => acct({ planLimit: 9000, planUsage: 131 }), total: 700, totalCap: 700, daily: 1e6 });
  assert.match(((await big.g.reserve(1)) as any).reason, /Lifetime engine credit cap/);
  // ...or past its daily cap.
  const day = guard({ usage: async () => acct({ planLimit: 9000, planUsage: 131 }), today: 150, daily: 150, totalCap: 1e6 });
  assert.match(((await day.g.reserve(1)) as any).reason, /Daily/);
});

test("a key-level limit binds even when the account allowance is larger", async () => {
  const { g } = guard({ usage: async () => acct({ planLimit: 9000, planUsage: 100, keyLimit: 50, keyLimitState: "finite", keyUsage: 40 }) });
  assert.match(((await g.reserve(1)) as any).reason, /API-key credit ceiling/);
  assert.equal(g.status().provider.allowance, 9000, "the account allowance is still shown as the account's");
  assert.equal(g.status().provider.key?.limit, 50);
});

test("unknown or unlimited allowance: usage shown, no maximum, no remaining, paid calls refused", async () => {
  for (const state of ["missing", "unlimited", "invalid"] as const) {
    const { g } = guard({ usage: async () => acct({ planLimit: null, planLimitState: state, planUsage: 131 }) });
    const r = await g.reserve(1);
    assert.equal(r.ok, false);
    const p = g.status().provider;
    assert.deepEqual([p.used, p.allowance, p.remaining, p.remaining_conservative, p.allowance_state, p.state], [131, null, null, null, state, "ok"]);
  }
});

test("usage states: off, pending, ok, stale by age, stale after a failed refresh, unavailable", async () => {
  assert.equal(new CreditGuard({ fetchUsage: null, spentToday: () => 0, spentTotal: () => 0, dailyCap: 1, totalCap: 1, ceilingFraction: 0.8, refreshMs: 1, now: () => 0 }).usageState(), "off");
  let t = 1;
  let fail = false;
  const { g } = guard({ now: () => t, usage: async () => { if (fail) throw new Error("HTTP 500"); return acct({ planUsage: 5 }); }, extra: { staleMs: 600_000, failBackoffMs: 1000 } });
  assert.equal(g.usageState(), "pending");
  await g.refresh();
  assert.equal(g.usageState(), "ok");
  assert.equal(g.providerUsage().fetched_at, 1, "last successful refresh time");
  t = 600_002;
  assert.equal(g.usageState(), "stale", "older than staleMs");
  t = 70_000; // back inside staleMs, past the 60 s cache
  assert.equal(g.usageState(), "ok");
  fail = true;
  await g.refresh();
  assert.equal(g.usageState(), "stale", "the last read failed, so the shown reading is old");
  assert.match(g.providerUsage().last_error ?? "", /500/);
  assert.equal(g.providerUsage().used, 5, "the last good reading is kept");
  const never = guard({ usage: async () => { throw new Error("HTTP 401"); } });
  await never.g.refresh();
  assert.equal(never.g.usageState(), "unavailable");
  assert.equal(never.g.providerUsage().allowance, null);
});

test("/usage rate limits: cached reads, Retry-After honoured, manual refresh throttled", async () => {
  let t = 1;
  let calls = 0;
  let mode: "ok" | "429" = "ok";
  const usage = async () => {
    calls++;
    if (mode === "429") throw Object.assign(new Error("Tavily /usage HTTP 429 (rate limited)"), { status: 429, retryAfterMs: 300_000 });
    return acct({ planUsage: 10 });
  };
  const { g } = guard({ now: () => t, usage, extra: { failBackoffMs: 1000, manualMinMs: 120_000 } });
  await g.refresh();
  await g.refresh();
  assert.equal(calls, 1, "a fresh reading is served from cache");
  assert.equal((await g.refresh({ manual: true })).attempted, true, "manual refresh bypasses the cache");
  t += 1000;
  assert.equal((await g.refresh({ manual: true })).attempted, false, "second manual refresh within 120 s is refused");
  assert.equal(calls, 2);
  mode = "429";
  t += 120_000;
  await g.refresh({ manual: true });
  assert.equal(calls, 3);
  assert.ok(g.providerUsage().retry_after_until, "the Retry-After window is reported");
  t += 200_000; // still inside Retry-After (300 s), past the manual and failure intervals
  assert.equal((await g.refresh({ manual: true })).attempted, false);
  assert.equal((await g.reserve(1)).ok, true, "the earlier reading plus local counting still guards spend");
  assert.equal(calls, 3, "no /usage call inside the Retry-After window");
  mode = "ok";
  t += 101_000;
  await g.refresh();
  assert.equal(calls, 4, "reads resume after the window");
  assert.equal(g.usageState(), "ok");
});

test("pay-as-you-go stays refused whatever the allowance", async () => {
  const { g } = guard({ usage: async () => acct({ planLimit: 9000, planUsage: 9000, paygoUsage: 1, paygoLimit: 100 }) });
  assert.match(((await g.reserve(1)) as any).reason, /pay-as-you-go/);
});

test("a failed first read (gateway still starting) does not block paid calls for the full backoff", async () => {
  let t = 1;
  let up = false;
  const { g } = guard({ now: () => t, usage: async () => { if (!up) throw new Error("Tavily /usage unreachable"); return acct({ planUsage: 10 }); } });
  await g.refresh(); // engine start, gateway not up yet
  assert.equal(g.usageState(), "unavailable");
  up = true;
  t += 6_000;
  assert.equal((await g.reserve(1)).ok, true, "retried within seconds, not after 120 s");
});
