# Halflife evaluation — v1-2026-11-02

Run 2026-11-02T15:15:14.714Z · judge `deepseek/deepseek-flash` (thinking off) · real Tavily via the Bifrost relay · labels pre-registered in `eval/labelled.mjs`.

| Metric | Value |
|---|---|
| Items | 40 |
| Decided (coverage) | 36 (90.0%) |
| Accuracy on decided | 100.0% |
| Stale precision / recall | 100.0% / 100.0% (tp 25, fp 0, fn 0; stale judged current: 0) |
| Brier, P(outdated) midpoint (uncalibrated prior, n=36) | 0.204 |
| Credits total / per searched claim | 4 / 1 |
| Static items that spent credits | 0 |
| Latency p50 / p95 / max (ms) | 1066 / 4171 / 5191 |
| Tavily credits (run, local count) / DeepSeek tokens | 4 / 71147 |

## Accuracy by evidence level

| Level | n | correct |
|---|---|---|
| strong | 32 | 32 (100.0%) |
| moderate | 3 | 3 (100.0%) |
| weak | 1 | 1 (100.0%) |

## By category

| Category | n | decided | correct |
|---|---|---|---|
| leadership | 9 | 9 | 9 |
| office | 8 | 8 | 8 |
| version | 6 | 6 | 6 |
| price | 5 | 5 | 5 |
| rate | 3 | 3 | 3 |
| sport | 3 | 3 | 3 |
| status | 2 | 2 | 2 |
| static | 4 | 0 | 0 |

## Items

| id | label | pred | triage/verdict/level | credits | note |
|---|---|---|---|---|---|
| lead-01 | stale | stale | reused/superseded/strong | 0 |  |
| lead-02 | stale | stale | reused/superseded/strong | 0 | now: Lip-Bu Tan |
| lead-03 | stale | stale | verify/superseded/strong | 1 | now: Brian Niccol |
| lead-04 | stale | stale | reused/superseded/strong | 0 | now: Neal Mohan |
| lead-05 | current | current | reused/current/strong | 0 |  |
| lead-06 | current | current | reused/current/strong | 0 |  |
| lead-07 | current | current | reused/current/strong | 0 |  |
| lead-08 | stale | stale | reused/superseded/strong | 0 |  |
| lead-09 | current | current | reused/current/strong | 0 |  |
| office-01 | stale | stale | reused/superseded/strong | 0 | now: Donald Trump |
| office-02 | stale | stale | reused/superseded/strong | 0 | now: Andy Burnham |
| office-03 | stale | stale | reused/superseded/strong | 0 | now: Friedrich Merz |
| office-04 | stale | stale | reused/superseded/strong | 0 | now: Mark Carney |
| office-05 | stale | stale | reused/superseded/strong | 0 |  |
| office-06 | current | current | reused/current/strong | 0 |  |
| office-07 | current | current | reused/current/strong | 0 |  |
| office-08 | stale | stale | reused/superseded/strong | 0 | now: Sanae Takaichi |
| ver-01 | stale | stale | reused/superseded/strong | 0 | now: 3.15 |
| ver-02 | current | current | reused/current/strong | 0 |  |
| ver-03 | stale | stale | reused/superseded/moderate | 0 | now: Node.js 24 |
| ver-04 | stale | stale | reused/superseded/strong | 0 | now: iOS 27.2 |
| ver-05 | stale | stale | reused/superseded/strong | 0 | now: iPhone 18 Pro / iPhone 18 Pro Max / iPhone Duo |
| ver-06 | stale | stale | reused/superseded/strong | 0 | now: 7.3 |
| price-01 | current | current | reused/current/strong | 0 |  |
| price-02 | stale | stale | verify/superseded/weak | 1 | now: $19.99 per month |
| price-03 | stale | stale | reused/superseded/strong | 0 | now: $15.99 per month |
| price-04 | stale | stale | reused/superseded/strong | 0 | now: $12.99 per month |
| price-05 | current | current | reused/current/strong | 0 |  |
| rate-01 | stale | stale | verify/superseded/strong | 1 | now: 3.75%-4% |
| rate-02 | stale | stale | reused/superseded/strong | 0 | now: 2.50% |
| rate-03 | current | current | reused/current/strong | 0 |  |
| sport-01 | stale | stale | reused/superseded/strong | 0 | now: Inter Miami |
| sport-02 | stale | stale | reused/contradicted/moderate | 0 | now: D Gukesh |
| sport-03 | current | current | reused/current/strong | 0 |  |
| status-01 | stale | stale | verify/contradicted/strong | 1 |  |
| status-02 | stale | stale | reused/superseded/moderate | 0 | now: Sweden is a full member of NATO |
| static-01 | current | abstain | static/–/– | 0 |  |
| static-02 | current | abstain | static/–/– | 0 |  |
| static-03 | current | abstain | static/–/– | 0 |  |
| static-04 | current | abstain | static/–/– | 0 |  |
