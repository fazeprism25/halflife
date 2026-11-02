// Freshness model, as-of dates, evidence rules and text checks: the deterministic core.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cutoffAsOf, explicitAsOf, modelCutoff, normaliseModel, parsePartialDate } from "../src/asof.ts";
import { CLASSES, getClass, priorBeta } from "../src/classes.ts";
import { evidenceLevel } from "../src/evidence.ts";
import { gammaGrid, halfLife, lomax, pOutdated, reuseWindowYears } from "../src/freshness.ts";
import { domainOf, locate, quoteOccurs, sentences, siteOf } from "../src/text.ts";
import { NOW } from "./fakes.ts";

const DAY = 24 * 3600 * 1000;

test("grid P(outdated) matches the analytic Lomax marginal for every class prior", () => {
  for (const c of CLASSES) {
    const g = gammaGrid(c.alpha, priorBeta(c));
    for (const mult of [0.01, 0.1, 0.5, 1, 3]) {
      const dt = c.lifetimeYears * mult;
      const exact = lomax(c.alpha, priorBeta(c), dt);
      assert.ok(Math.abs(pOutdated(g, dt) - exact) < 2e-3, `${c.id} dt=${dt}: grid ${pOutdated(g, dt)} vs ${exact}`);
    }
  }
});

test("P(outdated) is 0 at dt<=0, monotone in dt, bounded by 1", () => {
  const g = gammaGrid(2, 8);
  assert.equal(pOutdated(g, 0), 0);
  assert.equal(pOutdated(g, -1), 0);
  let prev = 0;
  for (const dt of [0.01, 0.1, 1, 5, 50, 500]) {
    const p = pOutdated(g, dt);
    assert.ok(p >= prev && p <= 1);
    prev = p;
  }
});

test("observations move the posterior in the right direction", () => {
  const c = getClass("org.leadership");
  const prior = gammaGrid(c.alpha, priorBeta(c));
  const changed = gammaGrid(c.alpha, priorBeta(c), Array.from({ length: 10 }, () => ({ tauYears: 1, changed: true })));
  const stable = gammaGrid(c.alpha, priorBeta(c), Array.from({ length: 10 }, () => ({ tauYears: 3, changed: false })));
  assert.ok(pOutdated(changed, 1) > pOutdated(prior, 1) + 0.2, "frequent changes should raise risk");
  assert.ok(pOutdated(stable, 1) < pOutdated(prior, 1), "stability should lower risk");
  assert.ok(halfLife(changed).median < halfLife(prior).median);
});

test("all-change and no-change observation sets stay well-defined (MLE instability avoided)", () => {
  for (const obs of [[{ tauYears: 0.5, changed: true }], [{ tauYears: 0.5, changed: false }], []]) {
    const g = gammaGrid(1.5, 10, obs);
    const hl = halfLife(g);
    assert.ok(Number.isFinite(hl.median) && hl.lo <= hl.median && hl.median <= hl.hi);
  }
});

test("reuse window is where P(outdated) reaches theta, and shrinks for volatile classes", () => {
  const ceo = gammaGrid(getClass("org.leadership").alpha, priorBeta(getClass("org.leadership")));
  const price = gammaGrid(getClass("market.price").alpha, priorBeta(getClass("market.price")));
  const t = reuseWindowYears(ceo, 0.2);
  assert.ok(Math.abs(pOutdated(ceo, t) - 0.2) < 1e-3);
  assert.ok(reuseWindowYears(price, 0.2) * 365.25 < 1, "a price claim should be reusable for under a day");
  assert.ok(t > 0.5, "a CEO claim should be reusable for months");
});

test("historical facts are effectively never outdated", () => {
  const c = getClass("historical.fact");
  assert.ok(pOutdated(gammaGrid(c.alpha, priorBeta(c)), 30) < 0.01);
});

test("partial dates parse to the interval they denote and reject nonsense", () => {
  assert.deepEqual(parsePartialDate("2024", NOW), { lo: Date.UTC(2024, 0, 1), hi: Date.UTC(2025, 0, 1) - 1 });
  assert.deepEqual(parsePartialDate("2024-02", NOW), { lo: Date.UTC(2024, 1, 1), hi: Date.UTC(2024, 2, 1) - 1 });
  assert.equal(parsePartialDate("2024-02-30", NOW), null);
  assert.equal(parsePartialDate("2024-13", NOW), null);
  assert.equal(parsePartialDate("July 2024", NOW), null);
  assert.equal(parsePartialDate("3024", NOW), null);
  assert.equal(explicitAsOf("2030-01", NOW), null, "future as-of dates are rejected");
});

test("model cutoffs: known models get a sourced interval, unknown ones an explicit assumption", () => {
  assert.equal(normaliseModel("openai/gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(modelCutoff("openai/gpt-4o-mini")?.cutoff, "2023-10");
  assert.equal(modelCutoff("gpt-4.1-nano")?.cutoff, "2024-06");
  const known = cutoffAsOf("openai/gpt-4o", NOW);
  assert.equal(known.kind, "model_cutoff");
  assert.ok(known.source && known.hi === Date.UTC(2023, 10, 1) - 1);
  const unknown = cutoffAsOf("ollama/qwen3:8b", NOW);
  assert.equal(unknown.kind, "assumed");
  assert.ok(unknown.hi < NOW && unknown.lo < unknown.hi);
});

test("evidence level rules", () => {
  const base = { asOfLo: NOW - 900 * DAY, now: NOW, recencyDays: 365 };
  const recent = NOW - 30 * DAY;
  const strong = evidenceLevel({ ...base, verdict: "superseded", citations: [
    { site: "reuters.com", publishedAt: recent, stance: "refutes", quoteValid: true },
    { site: "apnews.com", publishedAt: null, stance: "refutes", quoteValid: true },
  ] });
  assert.equal(strong.level, "strong");
  const moderate = evidenceLevel({ ...base, verdict: "current", citations: [{ site: "a.com", publishedAt: recent, stance: "supports", quoteValid: true }] });
  assert.equal(moderate.level, "moderate");
  const weakOld = evidenceLevel({ ...base, verdict: "current", citations: [{ site: "a.com", publishedAt: NOW - 800 * DAY, stance: "supports", quoteValid: true }] });
  assert.equal(weakOld.level, "weak");
  const conflicted = evidenceLevel({ ...base, verdict: "current", citations: [
    { site: "a.com", publishedAt: recent, stance: "supports", quoteValid: true },
    { site: "b.com", publishedAt: recent, stance: "supports", quoteValid: true },
    { site: "c.com", publishedAt: recent, stance: "refutes", quoteValid: true },
  ] });
  assert.equal(conflicted.level, "weak");
  const fakeQuotes = evidenceLevel({ ...base, verdict: "superseded", citations: [{ site: "a.com", publishedAt: recent, stance: "refutes", quoteValid: false }] });
  assert.equal(fakeQuotes.level, "none");
  assert.equal(evidenceLevel({ ...base, verdict: "unverifiable", citations: [] }).level, "none");
  const sameSite = evidenceLevel({ ...base, verdict: "current", citations: [
    { site: "a.com", publishedAt: null, stance: "supports", quoteValid: true },
    { site: "a.com", publishedAt: null, stance: "supports", quoteValid: true },
  ] });
  assert.equal(sameSite.level, "weak", "two pages of one site are not independent");
  // Superseded: an older page still quoting the old value is consistent with a change (Netflix case).
  const changed = [
    { site: "a.com", publishedAt: recent, stance: "refutes" as const, quoteValid: true },
    { site: "b.com", publishedAt: NOW - 60 * DAY, stance: "refutes" as const, quoteValid: true },
    { site: "old.com", publishedAt: NOW - 700 * DAY, stance: "supports" as const, quoteValid: true },
  ];
  const sup = evidenceLevel({ ...base, verdict: "superseded", citations: changed });
  assert.equal(sup.level, "strong");
  assert.ok(sup.reasons.some((r) => /1 older source still states the old value/.test(r)));
  // ...but not for "contradicted" (never true), nor when the supporting source is newer or undated.
  assert.equal(evidenceLevel({ ...base, verdict: "contradicted", citations: changed }).level, "weak");
  const newerOld = evidenceLevel({ ...base, verdict: "superseded", citations: [changed[0], changed[1], { ...changed[2], publishedAt: NOW - DAY }] });
  assert.equal(newerOld.level, "weak");
  assert.ok(newerOld.reasons.includes("1 verified quote points the other way"));
  assert.equal(evidenceLevel({ ...base, verdict: "superseded", citations: [changed[0], changed[1], { ...changed[2], publishedAt: null }] }).level, "weak");
});

test("locate finds spans despite whitespace/case/quote variants and maps to original offsets", () => {
  const hay = "Today,  Satya Nadella is the “CEO”\nof Microsoft.";
  const r = locate(hay, 'satya nadella is the "CEO" of microsoft');
  assert.ok(r);
  assert.equal(hay.slice(r![0], r![1]), "Satya Nadella is the “CEO”\nof Microsoft");
  assert.equal(locate(hay, "Tim Cook is the CEO"), null);
});

test("quoteOccurs rejects paraphrases and too-short quotes", () => {
  const src = "On June 5, 2023, Linda Yaccarino took over as chief executive of Twitter.";
  assert.ok(quoteOccurs(src, "Linda Yaccarino took over as chief executive"));
  assert.ok(quoteOccurs(src, "  linda   yaccarino took over AS chief executive of twitter.  "));
  assert.ok(!quoteOccurs(src, "Linda Yaccarino became CEO of Twitter"));
  assert.ok(!quoteOccurs(src, "Twitter"));
});

test("sentences keep offsets and do not split decimals or abbreviations", () => {
  const t = "Python 3.12 is the latest. Dr. Smith leads it! Is it? Yes.";
  const s = sentences(t);
  assert.deepEqual(s.map((x) => x.text), ["Python 3.12 is the latest.", "Dr. Smith leads it!", "Is it?", "Yes."]);
  for (const x of s) assert.equal(t.slice(x.start, x.end), x.text);
});

test("site grouping for independence", () => {
  assert.equal(siteOf("https://www.bbc.co.uk/news/x"), "bbc.co.uk");
  assert.equal(siteOf("https://edition.cnn.com/a"), "cnn.com");
  assert.equal(domainOf("not a url"), "");
});
