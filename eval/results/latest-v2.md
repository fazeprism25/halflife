# Halflife evaluation — v2-2026-11-02

Run 2026-11-02T15:15:45.746Z · judge `deepseek/deepseek-flash` (thinking off) · real Tavily via the Bifrost relay · labels pre-registered in `eval/labelled.mjs`.

| Metric | Value |
|---|---|
| Items | 12 |
| Decided (coverage) | 6 (50.0%) |
| Accuracy on decided | 100.0% |
| Stale precision / recall | 100.0% / 25.0% (tp 1, fp 0, fn 3; stale judged current: 0) |
| Brier, P(outdated) midpoint (uncalibrated prior, n=6) | 0.032 |
| Credits total / per searched claim | 0 / null |
| Static items that spent credits | 0 |
| Latency p50 / p95 / max (ms) | 887 / 1136 / 1136 |
| Tavily credits (run, local count) / DeepSeek tokens | 3 / 32925 |

## Accuracy by evidence level

| Level | n | correct |
|---|---|---|
| strong | 6 | 6 (100.0%) |

## By category

| Category | n | decided | correct |
|---|---|---|---|
| wrong-value | 4 | 1 | 1 |
| recent-current | 5 | 5 | 5 |
| time-scoped | 3 | 0 | 0 |

## Items

| id | label | pred | triage/verdict/level | credits | note |
|---|---|---|---|---|---|
| v2-wrong-01 | stale | abstain | static/–/– | 0 |  |
| v2-wrong-02 | stale | abstain | static/–/– | 0 |  |
| v2-wrong-03 | stale | abstain | static/–/– | 0 |  |
| v2-wrong-04 | stale | stale | reused/contradicted/strong | 0 | now: $20/month |
| v2-recent-01 | current | current | reused/current/strong | 0 |  |
| v2-recent-02 | current | current | reused/current/strong | 0 |  |
| v2-recent-03 | current | current | reused/current/strong | 0 |  |
| v2-recent-04 | current | current | reused/current/strong | 0 |  |
| v2-recent-05 | current | current | reused/current/strong | 0 |  |
| v2-scoped-01 | current | abstain | static/–/– | 0 |  |
| v2-scoped-02 | current | abstain | static/–/– | 0 |  |
| v2-scoped-03 | current | abstain | static/–/– | 0 |  |
| v2-amb-01 | ambiguous | abstain | verify/unverifiable/none | 2 |  |
| v2-amb-02 | ambiguous | current | verify/current/weak | 1 |  |
| v2-amb-03 | ambiguous | abstain | static/–/– | 0 |  |
