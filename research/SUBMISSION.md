# Halflife — Submission Draft

_Draft for the Geek Room Global AI Hackathon 2026 (deadline 2026-11-15). Written 2026-11-02, session 5. Not submitted. Numbers come from `eval/results/latest-freshqa.md`, `latest-v1.md`, `latest-v2.md` and the live scripts' results in `deploy/test/results/`._

## One line

**Halflife is a freshness layer for LLM traffic, built into the Bifrost AI gateway. It finds the claims in an answer that are likely to have gone out of date, verifies them live with Tavily, and acts on the gateway's cache.**

## Problem

An LLM answer mixes facts with very different shelf lives. "The Battle of Hastings was in 1066" never expires. "YouTube Premium costs $13.99" expired in April 2026. "Keir Starmer is the UK prime minister" expired in July 2026. Models answer all three with the same confidence, from training data that is months or years old.

The gateway makes it worse. A semantic cache serves yesterday's answer for hours without knowing which parts of it can go stale. Checking every answer against the web is slow and costly, and checking none of them ships outdated facts to users.

The operational question is: **which claims in this answer are likely outdated, which of those are worth a live check, and what should the gateway do about the result?**

## What Halflife does

For every answer passing through Bifrost:

1. **Inline, in the gateway (Go plugin, ~57 µs per request, fail-open):**
   - lexical triage of the prompt and answer (prices, versions, office holders, "latest", "current" …)
   - lowers the cache TTL for volatile answers and marks price answers `no-store`
   - hands the answer to the engine asynchronously, or synchronously in `verify` mode
2. **Engine (Node 24, zero dependencies):**
   - extracts claims and classifies each into one of 18 classes (an LLM via Bifrost, schema-validated; every span must occur in the answer)
   - estimates P(outdated) from the class's change rate (Gamma–Poisson model) and the claim's as-of date
   - verifies only the risky claims (P ≥ 0.2, at most 3 per answer) with Tavily, called through a Bifrost relay that holds the key and meters credits
   - asks the judge for a verdict (current / superseded / contradicted / unverifiable) with quotes, and checks every quote against the fetched text in code
   - rates the evidence on an ordinal scale (strong / moderate / weak / none) from explicit rules
3. **Back in the gateway:**
   - invalidates a cached answer once a claim in it is confirmed outdated
   - expires a cached answer when its claims' reuse window ends
   - links cache hits to the original analysis at no cost
   - in `verify` mode, annotates the reply with the outdated claim and its source, and never caches it
4. **Console:** a live report feed, each answer with its claims highlighted in place, a claim panel with timeline, sources, verified quotes and the three separate measures, the class model, and spend against every limit.

## Technical architecture

```
Client ──► Bifrost v2.4.0 (OpenAI-compatible) ───────────────────────► LLM providers (DeepSeek)
            │ semantic_cache
            │ halflife plugin (.so, post_builtin)  triage · TTL / no-store · capture · hand-off · headers
            ├─ /relay/tavily/*    ──► Tavily  (key held by Bifrost; priced per credit; VK budget → 402)
            └─ /relay/halflife/*  ──► Halflife engine API (VK-gated, route allow-list)

Halflife engine: extract + classify (LLM via Bifrost) → freshness model → triage → Tavily ladder
  (T0 reuse · T1 search · T2 extract) → schema-checked verdict, quotes verified in code
  → evidence level → learning → cache actions (Bifrost cache admin API) · SQLite · REST · SSE · console
```

**Bifrost extension points used** (no fork of Bifrost):
- a Go `.so` plugin built against `transports/v2.4.0`, using six hooks: `HTTPTransportPreHook`, `PreLLMHook`, `PostLLMHook`, `HTTPTransportPostHook`, `HTTPTransportStreamChunkHook`, `ResponseHeadersHook`
- Relays for Tavily (key custody, per-credit pricing, budget enforcement) and for the engine API (virtual-key gating)
- the semantic-cache TTL context key, and the cache admin API for invalidation
- the native DeepSeek provider for all LLM traffic, including Halflife's own (loop-guarded by a secret internal token)

**Design decisions that matter** (full record: `research/ARCHITECTURE_DECISIONS.md`):
- The language model never produces a number. It returns spans, a class from a closed list, dates, a verdict enum and quotes, all checked in code.
- A verdict whose quotes cannot be found in the sources is discarded (AD-12). A replacement value is shown only when a verified quote states it (AD-20).
- A "superseded" verdict whose change date lies in the future is discarded (AD-25).
- Spend is bounded in three layers: per answer, per day and lifetime in the engine; the account allowance (80% of the free plan, checked before every paid call); and the Bifrost virtual-key budget (AD-19).

## Use of AI (runtime) and AI-usage disclosure (development)

**At runtime**, AI does two jobs that rules cannot do well:
- **Claim extraction and classification:** splitting free text into atomic claims, resolving what "it" refers to, and deciding whether a claim can go out of date.
- **Verdicts:** reading search results and deciding whether they show the claim is still true, changed, or was never true.

Both use `deepseek/deepseek-flash` (thinking off) through Bifrost. Everything the model returns is validated in code. Tavily provides the live evidence.

**During development**, the project was built with an AI coding assistant (Claude Code, Anthropic). It wrote most of the code, tests and documentation under the operator's direction. It also ran the evaluations, and did the evaluation adjudications by independent web search; each is recorded with sources in `eval/freshqa-adjudications.json`. Design decisions, measured results and errors are logged in `research/IMPLEMENTATION_LOG.md`.

## Results

All numbers come from real DeepSeek and real Tavily calls. Nothing is mocked.

**FreshQA evaluation** (`eval/results/latest-freshqa.md`). Two public FreshQA snapshots (2024-02-26 and 2026-04-21); items are the dataset's questions and answers verbatim.

| Measure | Result |
|---|---|
| **Detection:** time-sensitive vs time-invariant, 100 items, assess-only | precision 85.5%, recall 97.9%, F1 0.91. 1 miss; 8 never-changing items flagged (costs a search, not a wrong verdict); 7 with no claim extracted |
| **Verification:** 29 known-stale answers (B) + 30 answers current at the 2026-04-21 snapshot (C), ≥ moderate evidence | stale precision **95.8%** (worst case 92.0% if the unadjudicated item were wrong), recall 95.8% of decided, 79.3% of all B; coverage 83% (B) / 70% (C) |
| Same, including weak evidence | precision 96.3% (worst case 83.9%), recall 89.7% of all B |
| Answers that changed after the snapshot, caught as outdated | 8 of the C items, each confirmed by independent search (2026 NBA and NHL champions, Miss World, UK PM …) |
| Replacement values on stale claims (26) | 10 match the dataset, 7 confirmed newer changes, **2 wrong**, 1 unadjudicated, 6 omitted |
| Cost | 59 Tavily credits for 60 items (1.04 per searched claim); about 4.5k DeepSeek tokens per checked claim; latency p50 3.9 s, p95 7.9 s |

**Hand-labelled sets:** v1 (40 items) 36/36 decided correct (easy set, saturated); v2 (15 hard items) exposed two failure modes that are now fixed (AD-20, AD-21).

**Gateway:** plugin overhead 57 µs per request (benchmark, all hooks); cache hit linked to the original analysis in 4–5 ms with 0 credits; a stale cache entry invalidated live (HTTP 200).

## Impact

- **For application teams on Bifrost:** answers about prices, versions, office holders and rankings stop being served stale from the cache. Volatile answers get short TTLs automatically. Confirmed-stale entries are deleted, and verify mode can annotate a reply before the user sees it.
- **Cost-proportional:** time-invariant claims cost nothing (in the FreshQA detection set, 37 of 45 never-changing answers with a claim were correctly left unchecked). Verified claims are reused for their reuse window at 0 credits, and at most 3 claims per answer are searched. Nearly every time-sensitive claim with an unknown as-of date crosses the threshold (all 47 changing-fact answers flagged time-sensitive in FreshQA), so θ mainly filters claims whose as-of date is recent. Measured cost is about 1 Tavily credit plus about $0.001 of DeepSeek per checked claim.
- **Auditability:** every verdict carries verified quotes, dates and an evidence level, and the console shows why a claim was or was not checked.

## Requirement mapping

### Bifrost Problem 04: a production-quality feature using supported extension points

| Requirement (from the brief; official wording unconfirmed) | Evidence | Status |
|---|---|---|
| Real operational problem | Stale answers served from cache, and LLM outdated knowledge (Problem section). | Argued; demo |
| Supported extension points only | Go plugin `.so` (6 hooks), Relays, semantic-cache TTL key, cache admin API, native DeepSeek provider. No Bifrost source changes. | **Done** |
| Reproducible integration | `deploy/setup.mjs` plus Docker Compose. The gateway image clones the pinned tag and checks the commit hash. | Done; clean-setup check, see "Unproven" |
| Tests | 54 engine tests; 21 Go plugin tests with `-race`; 13 end-to-end integration checks on the real Bifrost binary (fixture upstreams, labelled) | **Done** |
| Fails safe | Every hook recovers panics and passes the response through; bounded queue; engine down → inference unaffected (integration check) | **Done** |
| Docs | README, `.env.example`, architecture decisions (AD-01–AD-28), implementation log | Done |
| Upstream-ready | Plugin depends only on `core/schemas` and the stdlib. **No upstream PR or proposal written yet.** | **Partial** |

### Tavily Problem 06: claim-level freshness verification

| Requirement | Evidence | Status |
|---|---|---|
| Claim identification | LLM extraction with span validation; heuristic fallback when no LLM | **Done** (FreshQA: claims extracted for 93 of 100 answers) |
| Freshness detection | 18-class model plus as-of date → P(outdated); tense rule for dated past statements | **Done** (FreshQA detection recall 97.9%, precision 85.5%) |
| Live verification | Tavily search via a Bifrost relay, extract fallback, quotes verified in code | **Done** (FreshQA stale precision 95.8% on decided items) |
| Freshness scoring | Three separate measures: class half-life (A), P(outdated now) (B), evidence level (C) | Done; **B is uncalibrated** (labelled as such) |
| Tavily contributes meaningfully | Every verdict rests on Tavily evidence; topic chosen per class; `published_date` feeds the evidence rules | Done |

## Differentiation (defensible claims only)

- **Freshness, not truth.** Halflife does not claim to detect general factual errors. It decides which claims can go out of date, how likely they are to have done so, and whether current evidence confirms a change. Wrong time-invariant facts are explicitly out of scope and never checked (AD-21).
- **Inside the gateway, acting on the cache.** Generic fact-checkers verify text after the fact. Halflife changes what the gateway caches and serves: TTLs, no-store, invalidation, reuse windows.
- **Spend proportional to risk.** A per-class change model decides what is worth a search. Static claims cost nothing, and verified claims are reused.
- **No model-made numbers.** Probabilities come from an explicit model, and evidence levels from explicit rules. The LLM's outputs are categorical and checked in code.

## Unproven or open (state these honestly)

1. **The official Problem 04 and 06 wording and rubric have not been confirmed** from a public page; the mapping above follows the operator's brief.
2. **P(outdated) is not calibrated.** The priors are reasoned assumptions; FreshQA measured detection, not calibration.
3. **Upstream contribution:** no Bifrost PR or proposal written.
4. **Scale:** a single engine node with SQLite. The plugin was tested with 50 concurrent requests; the engine was not load-tested.
5. **Bifrost UI:** the gateway image ships a stub UI page (the Node UI build is skipped for disk and RAM).
6. **DeepSeek dollar metering by the Bifrost VK budget** is unverified (catalog pricing for `deepseek-flash`); DeepSeek spend is bounded by the engine's own guard instead.
7. **Evaluation size:** 100 detection and 59 verification items, judged by one model (`deepseek-flash`). Adjudications were made by the same AI assistant that built the system, with sources recorded, but not by an independent human.
8. **Demo video:** not recorded yet; transcript and stills of a real run exist.
