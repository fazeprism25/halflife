# Evaluation

This page describes how Halflife was evaluated, the exact results, and what the results do **not** show. The design rationale is AD-28 in [`research/ARCHITECTURE_DECISIONS.md`](../research/ARCHITECTURE_DECISIONS.md).

> **FreshQA data is not redistributed in this repository.** The dataset's spreadsheets carry no stated licence, so the snapshot CSVs, the sampled set (`eval/freshqa-set.json`), the raw FreshQA runs and the generated per-item report (`eval/results/latest-freshqa.md`) are kept out of version control. The figures below are copied exactly from that report. The scripts to rebuild everything are included; see [Reproducing](#reproducing).

All runs took place on **2026-11-02** against the real stack: Bifrost v2.4.0 with the Halflife plugin, the engine, **DeepSeek `deepseek-flash`** (thinking off) as the only judge model, and **live Tavily** search through the Bifrost relay. Nothing in these runs was mocked.

## What is measured

Halflife makes two separable decisions, and they are evaluated separately:

1. **Detection** — is a claim time-sensitive (able to go out of date)? This decides whether it is ever checked.
2. **Verification** — given a time-sensitive claim and live evidence, is it still current?

It is **not** a general fact-checking evaluation. Time-invariant claims are never checked, and every verification item below was a correct answer at some date. The outdated-probability score (P(outdated now)) was **not** evaluated for calibration.

## Data: FreshQA

[FreshQA](https://github.com/freshllms/freshqa) (Vu et al., 2023, *FreshLLMs: Refreshing Large Language Models with Search Engine Augmentation*, arXiv:2310.03214) is a question set with answers maintained over time, each labelled `never-changing`, `slow-changing` or `fast-changing`. Two public snapshots were used:

| Snapshot | Spreadsheet ID | SHA-256 of the CSV export |
|---|---|---|
| 2024-02-26 | `1V6nIxVTI9tqZ-wfgK-uFuUPiGEa1Zmnz53OeGbaNtO0` | `7a2c79e7b4d09bdd383513b70a8f40ccea45d7e5bbf3fb085d02582b5df4ebf1` |
| 2026-04-21 | `1_8mi-yuK30mvoDJu1KQXD6ODem7MKMcIgVAwDSzJkjM` | `3769244f66bb2666fe5160c8cc235339b7c54c61fc88d360995aa91d4c904789` |

The FreshQA GitHub repository's code is Apache-2.0, but the spreadsheets themselves carry no explicit licence statement, so none of the dataset's content is committed here (see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). To obtain the data, export each spreadsheet as CSV (`https://docs.google.com/spreadsheets/d/<ID>/export?format=csv`) and save the files as `eval/data/freshqa/freshqa-2024-02-26.csv` and `eval/data/freshqa/freshqa-2026-04-21.csv`. Then compare their SHA-256 with the table above (`freshqa-build.mjs` records the hashes in the set it writes, but does not refuse a mismatch). The maintainers may have edited the live spreadsheets since; a different export gives a different hash and possibly a different set.

### Set construction (`eval/freshqa-build.mjs`, deterministic)

- Questions are matched across snapshots by normalised text (IDs were renumbered between versions). Items are sampled by a seeded hash (`halflife-freshqa-2026-11-02`).
- **No hand-written statements.** Each item is FreshQA's question (sent as `question`) plus one of its answers verbatim (sent as `text`) through the real `/v1/check` path.
- **Part A (detection), 100 items:** 50 never-changing, 25 slow-changing, 25 fast-changing, from the TEST split with valid premises. Ground truth: `fact_type` of the 2026-04-21 snapshot.
- **Part B (known stale), 30 items:** the 2024-02-26 answer to a question whose answer changed by 2026-04-21 (no answer string in common).
- **Part C (current at snapshot), 30 items:** the 2026-04-21 answer to the same questions. Known current **only on 2026-04-21**.
- 52 of the 106 changed items were excluded before sampling: those with date-relative questions ("this year", "how old"), yes/no answers or vague answers. The generated `eval/freshqa-set.json` lists them.

### Integrity rules

- Any "stale" verdict on a C item is adjudicated by hand from sources found independently of Tavily, recorded in `eval/freshqa-adjudications.json`. "Unclear" is never counted as correct.
- A B answer that became true again (B-482, Wimbledon: Czech Republic again in 2026) is excluded rather than counted.
- Replacement values count as right only if they match the snapshot or an adjudicated later change.
- Precision is also reported in the **worst case**, treating every unadjudicated item as wrong.
- Evaluation traffic is sent with `learn: false` so it does not bias the class model (AD-23).

## Results

### A. Detection (assess-only, 0 Tavily credits, 153,082 DeepSeek tokens)

| Metric | Value |
|---|---|
| Items | 100 |
| No claim extracted (not scored) | 7 |
| Time-sensitive precision / recall / F1 | **85.5% / 97.9% / 91.3%** |
| Time-invariant correctly left unchecked (specificity) | 82.2% |
| TP / FP / FN / TN | 47 / 8 / 1 / 37 |

- **False negative (1):** "most recent award … (2025)" for LeCun/Hinton/Bengio was classified as a historical fact — the real risk, since it would never be checked.
- **False positives (8):** never-changing questions treated as time-sensitive, e.g. "capital of Massachusetts". These cost a search; they do not produce a wrong verdict.
- **No claim (7):** mostly yes/no answers, which contain no extractable statement.

### B/C. Verification (live; 59 Tavily credits, 268,235 DeepSeek tokens)

29 B items (after excluding B-482) and 30 C items. Abstentions — `unverifiable`, `not_checked`, or triaged time-invariant — are not counted as correct.

| Counting | B: stale / judged current / abstained | C: current / later change confirmed / false positive / unadjudicated / abstained | Stale precision | Stale recall (decided / all B) | Coverage B / C |
|---|---|---|---|---|---|
| **Strict (≥ moderate evidence)** | 23 / 1 / 5 | 11 / 8 / 1 / 1 / 9 | **95.8%** (worst case 92.0%) | 95.8% / 79.3% | 82.8% / 70.0% |
| Including weak evidence | 26 / 1 / 2 | 12 / 8 / 1 / 4 / 5 | 96.3% (worst case 83.9%) | 96.3% / 89.7% | 93.1% / 83.3% |

- **Later changes caught (8):** C answers that were current at the snapshot but had changed by 2026-11-02, each confirmed by independent web search: 2026 NBA champion (Knicks), 2026 Stanley Cup (Hurricanes), Miss World 2026, UK prime minister (Starmer → Burnham, making Starmer the most recent former PM), IJCAI 2026 venue (Bremen), Haaland's UCL goals, the latest Patch Tuesday, and the Premier League leader.
- **False positive (1), C-434:** the judge treated a film releasing on 2026-11-25 as already released. The engine now discards `superseded` verdicts dated in the future (AD-25); a rerun of B-434 and C-434 after the fix returned `unverifiable [future_change]` for both. **The headline numbers above include this error**; the rerun is reported separately and not merged.
- **False negative (1), B-229:** "1 successful SLS flight" was judged current; the evidence said 2. The judge read a count as "at least one". This class of error is not guarded in code.
- **Replacement values** on the 26 B claims judged stale: 10 match the 2026-04-21 answer, 7 differ because the answer changed again later (adjudicated), **2 are wrong** (adjudicated), 1 differs and is not adjudicated, 6 omitted because no verified quote states a value.
- Decided verdicts by evidence level: B strong 20, moderate 5, weak 3; C strong 16, moderate 5, weak 4.
- "Current" verdicts on C were taken as agreeing with the snapshot; they were not all re-verified (four were spot-checked).
- **Cost and latency:** 1.04 Tavily credits per searched claim; about 4.5k DeepSeek tokens per checked claim; latency p50 3.9 s, p95 7.9 s per item.

### Earlier hand-labelled sets (`eval/labelled.mjs`)

Labels were written and committed before the runs.

| Set | Result | Interpretation |
|---|---|---|
| v1, 40 items (leadership, office holders, prices, rates, versions, sports, static) | 36 decided, all correct (`eval/results/latest-v1.md`) | **saturated**: well-known changes; do not read as general accuracy |
| v2, 15 harder items | the first run exposed two failure modes — inferred replacement values (AD-20) and inconsistent handling of past-dated claims (AD-21) — both fixed; `eval/results/latest-v2.md` is the post-fix rerun (12 items scored, 6 decided) | a regression and failure-finding set, not a benchmark |

## Limitations of this evaluation

- **Small samples.** 100 detection items and 59 verification items. Confidence intervals are wide; a handful of items moves the percentages by several points.
- **One judge model.** Only `deepseek-flash` with thinking off was evaluated. `deepseek-v4-pro` and other providers are untested.
- **Adjudication was not independent.** Disputed items were adjudicated by the AI coding assistant that built the system, using web searches independent of Tavily, with sources recorded in `eval/freshqa-adjudications.json`. No independent human reviewed them.
- **Selected, not natural, data.** B items were chosen *because* their answers changed, so the stale base rate is far higher than in real traffic. These numbers say nothing about precision at realistic base rates.
- **Calibration not measured.** P(outdated now) is uncalibrated. A calibration study would need a random sample of claims from real traffic with verified outcomes.
- **Ground-truth noise.** FreshQA labels the question, not the extracted claim; some answers are ambiguous (counts, rankings that change hourly) and some may be wrong.
- **Time-bound.** Results depend on what the web said on 2026-11-02 and on Tavily's index that day; a rerun later will differ.
- **Single run.** No repeated runs were made to measure variance from the LLM or search.

## Reproducing

First obtain the two FreshQA CSVs (see [Data](#data-freshqa)). Then, with the stack running and keys configured (see [INSTALLATION.md](INSTALLATION.md)):

```bash
node eval/freshqa-build.mjs               # → eval/freshqa-set.json (deterministic for the same CSVs)
node eval/freshqa-run.mjs --part A        # detection, assess-only: 0 Tavily credits
node eval/freshqa-run.mjs --part BC       # verification: ≤ 2 credits per item, checked by the spend guard first
node eval/freshqa-score.mjs               # → eval/results/latest-freshqa.md
node eval/run.mjs --set v1                # hand-labelled sets (v1 or v2)
```

`--only id,id` restricts a run to specific items; `--tag name` writes a separately named rerun that the scorer lists but does not merge. The scorer reads the newest raw runs in `eval/results/` together with `eval/freshqa-adjudications.json` (committed). Re-scoring the original raw runs reproduced `latest-freshqa.md` exactly, apart from its generation timestamp. That check was run on 2026-11-02, before the raw runs were withdrawn from the repository, and they remain with the maintainer. A new live run will differ from the original (see limitations), and adjudications are keyed to the original run's item IDs and outcomes.
