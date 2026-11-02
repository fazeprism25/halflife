// Tavily free-allowance guard (AD-19): it must refuse rather than risk a paid credit.
import assert from "node:assert/strict";
import test from "node:test";
import { CreditGuard, parseUsage, type AccountUsage } from "../src/credits.ts";

const acct = (o: Partial<AccountUsage> = {}): AccountUsage => ({ planUsage: 0, planLimit: 1000, paygoUsage: 0, paygoLimit: null, plan: "Researcher", keyUsage: 0, keyLimit: null, ...o });

function guard(o: { usage?: () => Promise<AccountUsage>; today?: number; total?: number; daily?: number; totalCap?: number; now?: () => number } = {}) {
  let today = o.today ?? 0;
  let total = o.total ?? 0;
  const g = new CreditGuard({
    fetchUsage: o.usage ?? (async () => acct()),
    spentToday: () => today, spentTotal: () => total,
    dailyCap: o.daily ?? 150, totalCap: o.totalCap ?? 700, ceilingFraction: 0.8, refreshMs: 60_000, now: o.now ?? (() => 0),
  });
  return { g, spend: (n: number) => { today += n; total += n; } };
}

test("parseUsage reads Tavily's /usage body", () => {
  const u = parseUsage({ key: { usage: 3, limit: null }, account: { current_plan: "Researcher", plan_usage: 3, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } });
  assert.deepEqual(u, { planUsage: 3, planLimit: 1000, paygoUsage: 0, paygoLimit: null, plan: "Researcher", keyUsage: 3, keyLimit: null });
  assert.throws(() => parseUsage({ detail: "unauthorized" }));
});

test("the account ceiling is 80% of the plan allowance and counts credits since the last refresh", async () => {
  let calls = 0;
  const { g } = guard({ usage: async () => (calls++, acct({ planUsage: 797 })) });
  assert.equal((await g.reserve(1)).ok, true); // 798
  assert.equal((await g.reserve(2)).ok, true); // 800
  const r = await g.reserve(1);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /ceiling reached \(800 of 1000/);
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
    [async () => acct({ planLimit: null }), /plan limit is unknown/],
    [async () => acct({ keyLimit: 10, keyUsage: 8 }), /API-key credit ceiling/],
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
