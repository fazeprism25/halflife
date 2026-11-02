# Halflife Technical Feasibility Report

**Date:** 2026-11-02 · **Sprint scope:** remove architectural uncertainty before implementation. No product code was written.

**Bifrost under test:** `transports/v2.4.0`, commit `e869c3f`. It pins:
- `core v1.14.1`
- `framework v1.11.1`
- `plugins/semanticcache v1.7.4`

Every source-code claim below was checked against these released versions. I also read `main` at `a98fb35`, but `main` does **not** compile against the published modules (see §2), so `main` is not a valid build target.

**Evidence labels**

| Label | Meaning |
|---|---|
| **[SRC]** | Verified by reading Bifrost source code (file:line given) |
| **[EXP]** | Verified by a reproducible experiment in `experiments/feasibility/` (result file given) |
| **[DOC]** | Supported by official documentation only |
| **[ASM]** | Assumed but not verified |

---

## 0. Executive summary

**Halflife is feasible as a Bifrost plugin without modifying Bifrost core.** Every capability the product needs exists on a supported extension point, and most were proven live:

- inspecting and modifying responses
- per-request cache TTL
- asynchronous verification
- cache invalidation
- streaming capture
- graceful degradation

**Five findings change the plan from the research report:**

1. **Plugin placement is a real trade-off.**
   - A plugin placed `post_builtin` (the default) **can set the semantic-cache TTL**, but its LLM hooks **never run on cache hits**.
   - A plugin placed `pre_builtin` **sees cache hits**, but **cannot influence the TTL**: its post-hook runs after the cache has already written the entry.
   - Halflife uses `post_builtin` and covers cache hits through the HTTP transport hooks, which do run on hits. [EXP]
2. **Plugins cannot register their own HTTP routes.**
   - Plugin HTTP hooks run only on inference routes [SRC].
   - An unknown path such as `/halflife/*` falls through to the UI catch-all [EXP].
   - The supported way to expose Halflife's API through Bifrost is a **Relay**, `/relay/halflife/*`. It is virtual-key gated, route-allowlisted and strips caller credentials. Proven live. [EXP]
3. **Bifrost Relays can govern Tavily spend.**
   - A relay priced at `$0.001/call + $0.008 × usage.credits` charged a virtual key's budget.
   - After a $0.05 budget was used up, the 4th call got a `402 budget_exceeded`. [EXP]
   - Bifrost's own docs name Tavily as the motivating relay example [DOC].
   - This is the strongest "Bifrost meaningfully contributes" story available. The research report did not know about Relays.
4. **For streamed responses, cache TTL is locked at the first chunk** [SRC]. A TTL derived from the full answer text cannot apply to streams. Streams need a prompt-level TTL decision in `PreLLMHook`, or async invalidation after verification.
5. **A panic inside a plugin hook fails that user request with HTTP 500.** Bifrost recovers and stays up, but the request is lost [EXP]. Halflife must recover all panics itself.

**Not verified in this sprint:**

- **Live Tavily behaviour.** No Tavily key is available. A ready-to-run probe exists: `experiments/feasibility/tavily_probe.mjs`.
- **Live LLM verification quality.** No hosted LLM key is available. Local Ollama loaded once, then failed on host RAM pressure.

The plugin experiments therefore used a **clearly labelled mock upstream** that speaks the OpenAI wire format. Bifrost's real OpenAI provider adapter, SSE parser, plugin pipeline and semantic cache all ran unchanged; only the model's text was canned.

---

## 1. Verified Bifrost integration capabilities

### 1.1 Plugin model

**Interfaces [SRC]** (`core/schemas/plugin.go`)
- `LLMPlugin` (`:408`): `PreRequestHook`, `PreLLMHook`, `PostLLMHook`.
- `HTTPTransportPlugin` (`:295`):
  - `HTTPTransportPreAuthHook` and `HTTPTransportPreHook`
  - `HTTPTransportPostHook`
  - `HTTPTransportResponseHeadersHook`
  - `HTTPTransportStreamChunkHook`
- Also present: `MCPPlugin`, `ObservabilityPlugin` (`Inject`, called asynchronously after the response is written, `:574`).

**Loading [SRC]** (`framework/plugins/soloader.go`)
- Custom plugins are Go `.so` files loaded with `plugin.Open`.
- Only `GetName` and `Cleanup` are required. `Init(config)` and every hook, including `Inject` at `:225`, are optional symbols.

**Execution order [SRC]** (`plugin.go:243-265`)
- Order: `HTTPTransportPreHook` → `PreRequestHook` → `PreLLMHook` (per attempt) → provider → `PostLLMHook` (reverse order) → `HTTPTransportPostHook` → `ResponseHeadersHook` → `StreamChunkHook` (per chunk).
- Placement groups sort `pre_builtin` → builtin → `post_builtin` (`transports/bifrost-http/lib/config.go` `SortAndRebuildPlugins`). Custom plugins default to `post_builtin`.

**Lifecycle [SRC][EXP]**
- If `Init` fails, Bifrost logs it, marks the plugin `error` in `/api/plugins`, and **keeps serving traffic** (`server/plugins.go` `loadCustomPlugins`; `results/failures.json` → `plugin_init_failure`).

**Configuration [SRC][EXP]**
- Plugin entries in `config.json` look like `{name, path, enabled, placement, order, config}`. `config` is passed to `Init`.

### 1.2 Answers to the ten questions

**Q1. Can Halflife inspect model responses before they reach the client?** **Yes [EXP].**
- `PostLLMHook` receives the full `BifrostResponse` before serialization.
- The text the probe captured equalled the text the client received (`captured_equals_delivered: true`).
- The hook cost **37 µs**. Source: `results/inspect_modify_async.json`.

**Q2. Can it inspect and modify responses?** **Yes [EXP].**
- Mutating `ChatResponse.Choices[i].Message.Content` in `PostLLMHook` reached the client.
- Headers can be set on both buffered and streamed responses via `HTTPTransportResponseHeadersHook`. The `x-halflife-report` header was observed on both.
- For streams, the final chunk's content can be modified in `HTTPTransportStreamChunkHook`; the appended note reached the client.

**Q3. Can it start asynchronous verification without blocking the response?** **Yes [EXP].**
- A bounded worker pool started in `Init` processed jobs enqueued from `PostLLMHook`.
- The report status was `queued` when the response arrived and `done` 1,502 ms later. Response latency was unaffected.
- `ObservabilityPlugin.Inject` is a second, purpose-built async hook (bounded semaphore, 5 s default timeout) [SRC, not tested].

**Q4. Can it keep claim-level metadata?** **Yes, in plugin-owned state [EXP].**
- Bifrost's guidance: never put request-sized data in `BifrostContext`; keep IDs in ctx and the data in a manager keyed by ID [SRC: repo `AGENTS.md`, `framework/streaming/accumulator.go` pattern].
- **Bifrost's request-id is not yet set during the transport hooks** [EXP]. The probe's first build got an empty report ID. Halflife must create its own correlation ID in `HTTPTransportPreHook`. That value is visible in every later LLM and transport hook [EXP].
- **Gotcha [EXP]:** context values shared between two separately built `.so` plugins must use primitive types. Two builds have distinct Go types, so struct type assertions silently fail.

**Q5. Can it set the semantic-cache TTL per request?** **Yes, with placement and streaming constraints [SRC][EXP].**
- `semanticcache` reads `CacheTTLKey = "semantic_cache-ttl"` (a `time.Duration`) from ctx at write time, inside its `PostLLMHook` (`plugins/semanticcache@v1.7.4/main.go:249,765,972`).
- The key is not in Bifrost's reserved-key list, so plugins may write it (`core/schemas/context.go:20-60`).
- **`post_builtin` works.** The probe set 4 s. The entry was a hit at +0.8 s and a miss at +5.8 s, while the control entry (default 5 min) was still a hit at +5.8 s.
- **`pre_builtin` does not work.** Its post-hook runs after the cache write, so the entry set to 4 s was still a hit at +5 s. Source: `results/cache_ttl_post.json`, `results/cache_ttl_pre.json`.
- `CacheNoStoreKey` (`semantic_cache-no_store`) is read the same way, so Halflife can refuse to cache high-risk answers outright [SRC].
- **Streams:** the cache locks `expires_at` at the first chunk (`main.go:140-145`). The TTL must be decided before any content is known, in `PreLLMHook` from the prompt, or corrected later by invalidation [SRC].

**Q6. Can it invalidate an existing cached response?** **Yes [EXP].**
- Halflife reads `extra_fields.cache_debug.cache_id` from the response body in `HTTPTransportPostHook`, which runs after `semanticcache` has stamped it.
- The async worker then called `DELETE /api/cache/clear/{id}` and got `200 "Cache cleared successfully"`. The next identical request was a miss.
- **Constraint [EXP]:** once a config store and governance are enabled, `/api/*` requires admin auth or the `X-Bifrost-Setup-Token`. Halflife therefore needs an admin credential to invalidate.
- An in-process call to `ClearCacheForCacheID` is not available to a `.so` plugin, which has no handle on the cache plugin instance [SRC].

**Q7. Can it expose its own API endpoints through a supported mechanism?**
- **Not as plugin routes.** `TransportInterceptorMiddleware` is attached only to inference routes (`server/server.go:3768`).
  - An HTTP pre-hook can short-circuit an *inference* request with its own body [EXP], but that is a hack, not an API surface.
  - `GET /halflife/reports` returned the UI stub through the `/{filepath:*}` catch-all [EXP].
- **Yes, via a Relay.**
  - `/relay/halflife/health` forwarded to the Halflife service only with a valid virtual key. Without one the result was `401`; with one, `200`.
  - Unlisted routes got `404`, and the caller's `Authorization` header was stripped before forwarding.
  - Source: `results/relay.json`.
- A plugin-hosted sidecar listener also works (the probe served `:9091`) [EXP]. It is outside Bifrost's governance unless placed behind a relay.

**Q8. Can it run without modifying Bifrost core?** **Yes [EXP].**
- Both probe plugins were built against unmodified `transports/v2.4.0` and loaded from `config.json`.
- Requirements:
  - A **dynamically linked** gateway build. The official image is static (`transports/Dockerfile`), and static binaries cannot `plugin.Open`.
  - The plugin built inside the transports module so dependency versions match exactly.
  - A unique package path per `.so`. Loading a second `.so` built from the same path failed with `plugin already loaded` [EXP].
- The official `maximhq/bifrost` Docker image can therefore **not** load our plugin as-is. We ship our own Dockerfile that builds Bifrost from the release tag.

**Q9. What happens when Halflife is unavailable?** [EXP] (`results/failures.json`)

| Failure | Effect on inference |
|---|---|
| Plugin `Init` fails or `.so` fails to load | None. Gateway serves normally; plugin marked `error`. |
| Verifier/engine unreachable | None. Request 200 in 269 ms; report marked `failed` with reason. |
| Panic inside async worker (recovered) | None. Report `failed`. |
| Async queue full | None. Jobs dropped and counted (2 of 6 dropped with queue size 2). |
| **Panic inside a hook** | **That request returns 500.** Gateway stays up. Halflife must `recover()` in every hook. |
| Halflife API down (relay upstream) | Only `/relay/halflife/*` fails; inference unaffected [ASM, follows from relay isolation]. |

**Q10. How can it handle streaming safely?** [EXP] (`results/streaming.json`)
- `PostLLMHook` is called per chunk, and `bifrost.IsFinalChunk(ctx)` marks the end [SRC `core/utils.go:650`].
- The probe accumulated deltas in a plugin-owned map keyed by correlation ID. Its reconstructed text matched the client's stream exactly, and the report reached `done` after the stream ended.
- Headers commit before the body, so only the **report ID**, not a verdict, can go in stream headers.
- Annotations can be appended to the final chunk, shown live.
- **Synchronous verification of a stream** would need holding the stream. Bifrost has a pause/resume stream gate (`framework/streaming/gate.go`), but I did **not** verify it is usable from a custom `.so` [unverified].
- **Decision:** streams get async verification, a report ID header, an optional trailing note, and cache invalidation if the verdict is bad.

### 1.3 Overhead

[EXP] (`results/overhead.json`), measured on the Docker Desktop loopback:
- Cache-hit round trip through the gateway with both probe plugins loaded: **p50 3 ms, p95 13 ms**.
- Probe `PostLLMHook` on misses: **37 µs**.

These figures include Docker port forwarding on Windows. Bifrost's sub-10 ms plugin budget [DOC: contributing guide] is comfortably met by the inline path.

---

## 2. Unsupported or uncertain capabilities

| Item | Status |
|---|---|
| Plugin-registered HTTP routes | **Not supported** [SRC]. Use a Relay. |
| LLM hooks on cache hits for `post_builtin` plugins | **Not called** [EXP]. Use `HTTPTransportPostHook` (body has `cache_debug`) and the headers hook. |
| TTL from `pre_builtin` placement | **Ineffective** [EXP]. |
| Content-derived TTL for streamed responses | **Not possible** [SRC]. TTL is locked at the first chunk. |
| Loading the plugin into the official static Docker image | **Not possible** [SRC/DOC]. Needs a dynamic build. |
| Building on native Windows | **Not supported** [DOC]. Go plugins are Linux/macOS only; we build in Docker. |
| Building from `main` | **Broken** against published modules: `account.go:198 global.CACertPEM undefined` [EXP]. Use release tags. |
| Holding a stream for synchronous verification | **Uncertain**. Stream gate exists; plugin access unverified. |
| Relay Logs rows | **Uncertain**. Budgets were charged, but `/api/relay-logs` returned 0 rows in the test even with the logging plugin active. Needs investigation; not blocking. |
| `ObservabilityPlugin.Inject` as the async trigger | Supported for `.so` [SRC]; **not tested**. |
| WASM plugins | Deprecated [DOC]; not considered. |

---

## 3. Technical proof results

**Files**
- Plugin: `experiments/feasibility/probe/main.go`
- Build: `experiments/feasibility/Dockerfile` (`golang:1.27.3-bookworm`, dynamic gateway, plugin built inside the transports module)
- Configs: `experiments/feasibility/configs/*/config.json`
- Runner: `node experiments/feasibility/run.mjs [experiment]`
- Raw results: `experiments/feasibility/results/*.json`

| # | Experiment | Result | Evidence |
|---|---|---|---|
| 1 | Working Bifrost installation | ✅ v2.4.0 dynamic build in Docker, healthy in ~5 s | build + every run |
| 2 | Minimal supported plugin | ✅ 2 `.so` probes (pre/post placement) loaded via `config.json`, status `active` | `gateway-logs-last.txt` |
| 3 | Response inspection | ✅ exact text captured, 37 µs | `inspect_modify_async.json` |
| 4 | Response modification | ✅ body marker delivered; stream final chunk modified | `inspect_modify_async.json`, `streaming.json` |
| 5 | Per-request cache TTL | ✅ `post_builtin`; ❌ `pre_builtin` (expected and explained) | `cache_ttl_post.json`, `cache_ttl_pre.json` |
| 5b | Adaptive TTL from content | ✅ heuristic set 5 s on a volatile answer | `cache_ttl_post.json` |
| 5c | Async invalidation | ✅ `DELETE /api/cache/clear/{id}` → next request miss | `cache_ttl_post.json` |
| 6 | Async verification | ✅ queued → done in 1.5 s, response unaffected | `inspect_modify_async.json` |
| 7 | Failure handling | ✅ all failure modes isolated except in-hook panic (500 for that request) | `failures.json` |
| 8 | Streaming compatibility | ✅ capture, final-chunk annotation, report header, async completion | `streaming.json` |
| 9 | Relay as Halflife API surface | ✅ VK-gated, route allowlist, credential stripping | `relay.json` |
| 10 | Relay budget enforcement on credit-priced upstream | ✅ 3 × $0.017 > $0.05 → 4th call `402 budget_exceeded` | `relay.json` |
| 11 | Freshness data source sanity check (Wikidata) | ⚠️ data exists but is biased (see §4) | `wikidata_*.json` |

**Honesty notes**
- The upstream "model" in experiments 3–10 is a mock that tags every answer with `[MOCK UPSTREAM]`. It shows the plugin plumbing works, not that verification is accurate.
- The relay budget test used a mock Tavily-shaped endpoint returning `usage.credits: 2`, not Tavily.
- No result was hard-coded; every value came from a live request.

**Issues met and fixed during the sprint**
- `main` does not compile against the published modules; switched to the release tag.
- The Ollama key needs `ollama_key_config.url`.
- Bifrost's SSRF guard blocks private provider IPs until `network_config.allow_private_network: true` is set.
- A duplicate plugin package path is refused (`plugin already loaded`).
- Cross-plugin ctx struct types don't match.
- Budgets are separate `governance.budgets[]` entities linked by `virtual_key_id`, not a field on the key.
- Docker's VM filesystem went read-only under host memory pressure and corrupted image layers. Fixed with a restart and a no-cache rebuild.

---

## 4. Freshness model proposal

The research report's "half-life" idea is kept, but stated precisely. Three quantities are **computed and displayed separately**.

### A. Expected information lifespan (property of a claim *class*)
- Each claim is mapped to a class `c`: a predicate type such as `org.ceo`, `software.latest_version`, `asset.price`, `office.head_of_government`, `event.historical`.
- Changes in a class are modelled as a Poisson process with rate `λ_c`. From the rate:
  - survival `S(t)=e^{−λt}`
  - mean lifetime `1/λ`
  - half-life `ln2/λ`
- `λ_c` is uncertain and carries a Gamma(α_c, β_c) distribution.
- Basis:
  - Web change-frequency estimation (Cho & Garcia-Molina, *Estimating Frequency of Change*, ACM TOIT 2003) is Poisson-based.
  - Later work reports Poisson as a reasonable but imperfect fit; Google observed ~20% of pages with regular hourly patterns instead ([survey, arXiv 1901.02660](https://arxiv.org/pdf/1901.02660); [online estimators, arXiv 2009.08142](https://arxiv.org/pdf/2009.08142)).
  - Real-world change is highly skewed across properties, so per-class rates are necessary ([Shrinivasan & Razniewski, *How Stable is Knowledge Base Knowledge?*, arXiv 2211.00989](https://arxiv.org/abs/2211.00989), [DOC]).
- Limitation: a constant-rate model ignores scheduled changes (elections, release trains). Those classes get an explicit schedule rule instead of λ.

### B. Probability the claim is outdated *now* (claim × time)
- Inputs:
  - `t_asof`: an explicit date in the text ("as of July 2024"), else the date of the last Halflife verification, else the generating model's knowledge cutoff.
  - `Δt = now − t_asof`.
- With λ ~ Gamma(α,β): `P_out = 1 − (β/(β+Δt))^α`, the Lomax marginal. Parameter uncertainty widens the estimate instead of hiding it.
- **Model knowledge cutoffs are not in Bifrost's model catalog** [SRC: no cutoff field in `framework/modelcatalog`]. Halflife keeps a small, cited `model → cutoff` table and falls back to "unknown". An unknown cutoff yields an interval, not a point.

### C. Confidence in verification evidence (property of the *evidence*)
- Features:
  - independent domains
  - evidence `published_date > t_asof`
  - agreement versus contradiction between sources
  - authoritative-domain match
  - a quoted supporting span returned with the LLM verdict
  - extraction success
- **Until calibrated, it is reported as an ordinal level** (strong / moderate / weak / none) defined by explicit, unit-tested rules. It is never shown as a percentage.

### What the LLM does and does not do
- It returns **categorical, checkable outputs only**:
  - claim span
  - class label from a closed list
  - extracted as-of date
  - check-worthiness
  - verdict (current / superseded / contradicted / unverifiable) with a quoted evidence span
- **It never produces λ, `P_out` or confidence numbers.** That avoids presenting an uncalibrated LLM-generated number as science.

### Where λ comes from: deterministic, empirical and learned, combined

| Source | Role | Trade-off |
|---|---|---|
| Curated class table (versioned, each prior with a stated rationale) | Initial α, β | Transparent and testable; coarse |
| Wikidata statement durations (qualifiers P580/P582) | Empirical bounds for some classes | **Biased, see below** |
| Halflife's own verification outcomes | Online Bayesian update | Gets better with traffic; noisy labels |

**Wikidata check (CEO, P169) [EXP]** (`results/wikidata_*.json`)
- 2,794 closed tenures have a mean of **8.5 years**. That figure ignores censoring.
- The censored exponential MLE, treating 4,240 open tenures as still running, gives a mean of **24.5 years**.
- The truth lies in between: many "open" Wikidata statements are themselves stale, with no end date ever recorded.
- **Conclusion:** Wikidata can bound priors but must not be treated as ground truth. That justifies a prior-plus-learning design rather than a fixed table. Head-of-government (P6) returned 19,032 closed terms, but the class mixes national and local offices and would need filtering.

### Learning from verification outcomes
- Each verified claim gives `(c, τ, I)`:
  - `τ` = time since last known true
  - `I` = 1 if superseded or contradicted
- This is exactly the interval-censored Poisson observation of Cho & Garcia-Molina. The MLE solves `Σ I_j τ_j/(e^{λτ_j}−1) = Σ(1−I_j)τ_j`.
- That MLE is unstable when there are no changes or only changes ([2009.08142](https://arxiv.org/pdf/2009.08142)). We therefore use a **1-D grid posterior** with the Gamma prior, which is cheap and always defined.
- **Only verdicts with strong or moderate evidence update λ**, which limits label noise from LLM errors.
- **Reuse:** a verified claim stays valid while `P_out(now − verified_at) < θ`, i.e. for `t* = β((1−θ)^{−1/α} − 1)`. This reuse window is also the cache-TTL cap for responses containing that claim.

### Calibration and evaluation
- Brier score and a reliability curve for `P_out` against labelled outcomes:
  - FreshQA fast-changing and slow-changing questions
  - a hand-labelled set of answers from an older-cutoff model
- Verdict accuracy per evidence level must be monotone (strong > moderate > weak).
- Until this is done, the UI labels `P_out` as **"estimated (uncalibrated)"**.

---

## 5. Tavily integration design

All Tavily facts here are [DOC]; none were tested live because no key was available.

**Relevant capabilities** ([search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract), [crawl](https://docs.tavily.com/documentation/api-reference/endpoint/crawl), [best practices](https://docs.tavily.com/documentation/best-practices/best-practices-search))
- **Search** supports:
  - `topic` (general, news, finance) and `start_date` / `end_date` / `time_range`
  - `include_published_date` (beta)
  - `filter_by_published_date`, which also drops *undated* results, so we do **not** use it by default
  - `max_age_hours`, which is fetch freshness, distinct from publish date
  - `include_domains` with a `prefer` mode, `exact_match`, `chunks_per_source` (1–3), `include_usage`
- **Extract** takes 1–20 URLs. A `query` reranks chunks (1–5 per source). Failures arrive in `failed_results` even on HTTP 200.
- **Crawl and Map** return **no dates**. They are not useful for freshness checks; reserved for a future knowledge-base audit.
- **Research** costs 4–110 credits (mini) or 15–250 (pro). Opt-in "deep audit" only.

**Verification ladder** (each step only if the previous one is inconclusive)

| Tier | Action | Cost |
|---|---|---|
| T0 | Evidence cache: same normalised claim, within its reuse window `t*` | 0 credits |
| T1 | `search`, `basic`, topic by class, `start_date = t_asof` (since the model last knew), `include_published_date`, `max_results 5`, `chunks_per_source 2`, preferred domains per class | 1 credit |
| T2a | `extract` top 2 URLs with `query = claim` (passage-level evidence) | ≤1 credit per 5 successful URLs [DOC; rounding unverified] |
| T2b | or `search advanced` when T1 had no dated evidence | 2 credits |
| T3 | `research mini`, only when the user requests a deep audit | 4–110 credits |

**Routed through Bifrost**
- All Tavily calls go through a **Bifrost Relay** (`/relay/tavily/search`, `/relay/tavily/extract`).
- The relay holds the Tavily key, prices calls at `$0.008 × usage.credits`, charges the Halflife virtual key's budget, and returns `402` when exhausted. The mechanism was proven against a mock [EXP].
- Halflife treats a `402` or a Tavily `432/433` as verdict `unverifiable: budget`, never as an error to the user.

**Is ordinary search plus targeted extract enough?** [ASM, to be measured]
- Expected yes for single-fact claims (office holders, versions, prices, rankings). Snippets plus one extract usually contain the current value and a date.
- Research is justified only for multi-hop claims.
- `tavily_probe.mjs` measures exactly this: dated-result coverage with and without `start_date`, credits used, and extract success. It runs as soon as a key is provided.

**Rate limits** [DOC]: 100 RPM on a dev key (search and extract), 1,000 on production. The engine uses a token bucket at 80% of the limit and honours `Retry-After`.

---

## 6. Cost estimates

Prices are [DOC] Tavily; the rates below are assumptions [ASM].

| Item | Assumption | Credits | USD (pay-as-you-go $0.008/credit) |
|---|---|---|---|
| Per checked claim | T1 always; 30% escalate to advanced (+2); 40% extract (+1) | ≈ 2.0 | ≈ $0.016 |
| Per response | ~5 claims extracted, ~1.5 above risk threshold after triage | ≈ 3 | ≈ $0.024 |
| With evidence cache | 30% T0 hit rate at demo-scale repetition | ≈ 2.1 | ≈ $0.017 |

**Budget fit**
- Free tier: 1,000 credits per month ≈ **330 verified responses**.
- Planned use: evaluation (~250 claims ≈ 500 credits) plus development and demo (≈ 400).
- That fits the free tier with little margin. The $30 / 4,000-credit plan is needed **only if** evaluation grows beyond about 300 claims. Don't buy until the probe shows actual credits per claim.

**LLM tokens per response** [ASM]
- One extraction-plus-classification call: ~600 input + ~300 output tokens.
- One verdict call per checked claim: ~1,500 input (evidence) + ~150 output.
- Total for 1.5 claims: ~3k input + ~0.5k output tokens.
- With a small hosted model this is a fraction of a cent. **Exact USD depends on the chosen model's price and is computed once a provider is selected** (not guessed here).
- Through local Ollama the marginal cost is $0, but it competes for RAM on this machine (§10).

**Bifrost:** open source, $0.

---

## 7. Latency estimates

| Path | Added latency | Basis |
|---|---|---|
| Inline plugin work (pre-filter, enqueue, headers, TTL) | ~40 µs measured; target < 1 ms | [EXP] 37 µs probe hook |
| Cache hit through gateway | p50 3 ms / p95 13 ms (Docker on Windows) | [EXP] |
| Async verification (off the response path) | ~3–8 s per response | [ASM] LLM extraction ~0.5–2 s + Tavily basic search ~1–2 s + optional extract (default timeout 10 s) + verdict ~0.5–2 s. **Unmeasured until keys are available** |
| Opt-in synchronous verify (`x-halflife-mode: verify`) | Same 3–8 s added to the response | [ASM] |
| Local Ollama qwen3:8b | 55 s cold load, then ~16 tok/s generation, measured once | [EXP] only one successful run |

---

## 8. Failure-handling strategy

Derived from the §1 Q9 experiments.

1. **Fail-open by default.** Any Halflife failure leaves the original response untouched and marks the report `unverified` with a reason.
2. **`recover()` in every exported hook.** An unrecovered panic costs the user a 500 [EXP].
3. **Bounded queue with load shedding.** Drop and count; never block the hook [EXP].
4. **Engine timeouts.** Per call: LLM 10 s, Tavily search 8 s, extract 12 s. Total job budget 30 s.
5. **Budget exhaustion** (Bifrost 402, Tavily 432/433) becomes verdict `unverifiable: budget`. No retries.
6. **Rate limiting** (Tavily 429 / `Retry-After`) is handled by a token bucket plus delayed requeue, at most 2 times.
7. **Provider outage for verification LLM calls** is handled by Bifrost fallbacks on the engine's virtual key: hosted primary, then a second provider or local Ollama.
8. **Loop prevention.** The engine's own LLM calls go back through Bifrost, so the plugin skips requests carrying the engine's virtual key / `x-halflife-internal`. Required, not optional [ASM: design].
9. **Fail-closed mode** (`block`) is opt-in per virtual key, for regulated deployments only.

---

## 9. Security considerations

- **Secrets**
  - The Tavily key lives only in the Bifrost relay credential (`env.TAVILY_API_KEY`). The engine never holds it.
  - LLM keys stay in Bifrost provider config.
  - The admin token for cache invalidation is passed via env, is never logged, and is redacted in reports.
  - The experiment used only obviously fake local tokens (`*-local-only`).
- **Prompt injection from web evidence**
  - Evidence is wrapped as quoted data with provenance.
  - Verdict output is schema-constrained (closed enum plus a quote that must appear in the evidence, checked in code).
  - Evidence text is never executed or followed as instructions.
- **Confidential traffic**
  - A per-virtual-key policy `local_only` routes classification to Ollama and disables external search.
  - In that mode only metadata leaves the gateway. The UI shows "not verified (confidential)".
- **SSRF**
  - Bifrost blocks private targets by default [EXP]. We enable `allow_private_network` only for the Ollama provider.
  - The relay `base_url` is fixed, and callers cannot redirect it [DOC][EXP: unlisted route 404].
- **Admin surface**
  - With a config store, `/api/*` requires admin auth or a setup token [EXP]. Production deployments must set dashboard auth.
  - The engine gets a narrowly scoped credential.
- **Data retention**
  - Response text stored for reports is truncated and subject to a TTL.
  - The logging plugin's `disable_content_logging` per virtual key is respected [SRC: schema field].
- **Supply chain:** pinned Bifrost release tag, pinned Go and Node versions, no `main` builds.

---

## 10. Local environment assessment

[EXP] (`results/environment.json`)

| Item | Finding | Impact |
|---|---|---|
| OS / CPU / RAM | Windows 11, 16 threads, **15.2 GB RAM** | RAM is the binding constraint |
| GPU | RTX 3060 Laptop, 6 GB VRAM | Enough for an 8B Q4 model when host RAM is free |
| WSL2 | Installed; Ubuntu distro (no Go/gcc) | Not needed; Docker is used |
| Docker Desktop | Installed (29.6.2); stopped initially; WSL VM ≈ 7.9 GB | Works. Under memory pressure its disk went read-only once and corrupted layers |
| Go (Windows) | 1.26.5 | Bifrost needs 1.27.3; builds run in a `golang:1.27.3` container. No host install required |
| Node | 24.16.0 | Fine for engine and console |
| Ollama | 0.40.13, `qwen3:8b` | Loaded once (55 s cold). Later failed: host free RAM fell to 0.9–1.7 GB with Docker + builds |
| API keys | **None set** (Tavily, OpenAI, Anthropic, Gemini, Groq, OpenRouter) | Blocks live verification tests |

**Can the machine run the stack?** **Yes, with one constraint.**
- Bifrost + plugin + engine + console fit comfortably.
- Running Docker builds **and** an 8B local model at the same time does not.
- Mitigations:
  1. Use a hosted LLM as primary for verification.
  2. Use Ollama only for the confidential-mode demo, with Docker builds finished first.
  3. Optionally use a smaller local model (e.g. a ~1–2B model) for confidential classification. Its quality is unverified.

---

## 11. Recommended architecture

```
Client ──► Bifrost (dynamic build, v2.4.0 tag) ───────────────► LLM providers
            │  semantic_cache (builtin)                         (fallbacks, VK budgets)
            │  halflife plugin (.so, post_builtin)
            │    HTTPTransportPreHook   corr-id, mode flags, skip internal traffic
            │    PreLLMHook (streams)   prompt-level volatility → CacheTTL / NoStore
            │    PostLLMHook            capture text (stream: accumulate), cheap pre-filter,
            │                           TTL/NoStore for non-streams, enqueue job (bounded)
            │    HTTPTransportPostHook  read cache_id (also on cache hits) → link report
            │    ResponseHeadersHook    x-halflife-report, x-halflife-status (from store)
            │    StreamChunkHook        optional trailing note on final chunk
            │    every hook: recover(); fail-open
            │
            ├─ /relay/tavily/*   ──► Tavily  (credential in Bifrost, priced by usage.credits, VK budget)
            └─ /relay/halflife/* ──► Halflife engine API (VK-gated: /check, /reports, console)

Halflife engine (one service, TypeScript/Node 24)
  job intake (from plugin) → claim extraction + classification (LLM via Bifrost, engine VK)
  → freshness model (class priors + learned λ) → triage under credit budget
  → evidence ladder (Tavily via Bifrost relay) → verdict (schema-checked) → store
  → actions: cache invalidation (Bifrost admin API), λ posterior update
  SQLite: claims, evidence, verdicts, class posteriors, reports
  Serves the operator console (static SPA)
```

**Why this shape instead of the alternatives considered**

| Alternative | Verdict |
|---|---|
| Everything inside the `.so` (engine in plugin) | Rejected. Heavy dependencies (SQLite driver, HTTP clients) must match host versions exactly, risking `.so` conflicts on every Bifrost upgrade. A crash or leak takes the gateway down with it. The upstream bar is minimal plugin cost. |
| Plugin-hosted sidecar listener (proven to work) | Development fallback only. It is ungoverned unless placed behind a relay, and ties engine lifecycle to gateway reloads. |
| `pre_builtin` placement | Rejected. Loses TTL control [EXP]. Cache-hit visibility is recovered via transport hooks instead. |
| Two plugins (pre and post) | Unnecessary once transport hooks cover hits. Adds the `.so` duplicate-path and type-identity pitfalls [EXP]. |
| `ObservabilityPlugin.Inject` as the job trigger | Credible alternative (purpose-built, post-wire, bounded) [SRC]. Kept as plan B; not tested. |
| Standalone verifier with no gateway integration | Fails the Bifrost-contribution requirement and loses cache/TTL/governance coupling. |

**Two deployables** (Bifrost with the plugin, and the engine) are justified: different languages, different failure domains, different scaling. The console is served by the engine, so there is no third app.

---

## 12. Required infrastructure and credentials

| Need | Why | Where to configure | Status |
|---|---|---|---|
| **Tavily API key** | Live verification; the `tavily_probe.mjs` cost and latency measurements | Env `TAVILY_API_KEY` on the Bifrost container → relay `credential: env.TAVILY_API_KEY` | **Missing (blocking for live verification)** |
| **One hosted LLM provider key** (any Bifrost-supported provider) | Claim extraction and verdicts with reliable latency; RAM rules out local-only | Env on the Bifrost container, referenced as `env.<NAME>` in provider config | **Missing (blocking for quality evaluation)** |
| Second provider key (optional) | Shows fallback during outages | Same | Optional |
| Docker Desktop | Dynamic Bifrost build and runtime | Installed | ✅ |
| Ollama + small model | Confidential/local mode demo | Installed (`qwen3:8b`) | ✅ (RAM-limited) |
| Bifrost setup token / admin auth | Cache invalidation and admin API once the config store is on | `setup_token: env.BIFROST_SETUP_TOKEN` | Generated locally; no purchase |
| Paid Tavily plan | **Not needed yet.** Free 1,000 credits/month covers about 330 verified responses | — | Revisit after the probe |

Keys must be supplied as environment variables, never written into `config.json`, reports or logs.

---

## 13. Technical risks (updated)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Verification accuracy (false "superseded") unknown | High until measured | High | Evaluation harness on FreshQA plus a hand-labelled set before UI polish; conservative thresholds; abstain verdict |
| Tavily `published_date` coverage too low for date reasoning | Medium | High | Probe measures coverage; fall back to dates parsed from extracted text; evidence level drops to weak |
| `.so` version lock on Bifrost upgrades | Certain (by design) | Medium | Pin `transports/v2.4.0`; build in Docker; document the rebuild |
| Judges expect the official image to work | Medium | Low | One-command `docker compose up` with our dynamic build |
| Streams can't get content-derived TTL | Certain | Medium | Prompt-level TTL in `PreLLMHook` plus async invalidation (proven) |
| Host RAM (Docker + local LLM) | High | Medium | Hosted LLM primary; Ollama only for the confidential demo |
| Loop: engine's LLM calls re-enter the plugin | Certain if unhandled | High | Skip by engine VK / internal header; unit test |
| Relay Logs not populating | Medium | Low | Investigate; budgets already work |
| LLM verdict prompt injection from web pages | Medium | Medium | Quote-must-exist check, closed enum, evidence as data |
| Calibration needs labelled data we don't have yet | High | Medium | Ship `P_out` as "uncalibrated" with interval; label 150–250 claims in the evaluation week |

---

## 14. Updated implementation roadmap (Nov 3 → Nov 15)

| Dates | Work | Exit criterion |
|---|---|---|
| **Nov 3** | Receive keys; run `tavily_probe.mjs`; measure dated-result coverage, credits/claim, latency. Repo scaffold: `plugin/` (Go), `engine/` (TS), `deploy/` (Dockerfile, compose, `config.json`). | Measured Tavily numbers replace §6/§7 assumptions |
| **Nov 4–5** | Plugin v1: corr-id, recover/fail-open, capture (stream + non-stream), bounded enqueue to engine, TTL/NoStore, headers, internal-traffic skip. Go unit tests and a race test; benchmark. | Plugin ≤ 100 µs p95 inline; all §1 Q9 failure cases covered by tests |
| **Nov 5–7** | Engine core: extraction/classification (structured output via Bifrost), class table + Lomax `P_out`, triage, Tavily ladder via relay, schema-checked verdicts, SQLite store, `/check` API. | End-to-end live verification of a real stale answer |
| **Nov 8–9** | Evaluation harness: FreshQA subset plus hand-labelled set; precision/recall for "superseded", Brier/reliability for `P_out`, credits/response, latency. Prompt iteration. | Published numbers in README |
| **Nov 9** | Learning loop: grid posterior per class; reuse window `t*`; cache invalidation on bad verdict. | Posterior updates visible in store; invalidation test |
| **Nov 10–12** | Console (engine-served SPA): live stream, response inspector with claim timeline, policy per VK, metrics. | Usable demo flow; empty/error/loading states |
| **Nov 12** | **Feature freeze.** Confidential mode (Ollama), relay budgets in demo. | — |
| **Nov 13** | Hardening: chaos tests (engine down, Tavily 429/432, provider outage → fallback), security pass. | All failure tests green |
| **Nov 14** | Docs: README, architecture, upstream proposal (plugin + docs PR outline), one-command compose, demo video. | Fresh-clone reproduction works |
| **Nov 15** | Buffer and submission. | — |

**Explicitly deferred:** stream holding for synchronous verification, Research API deep audits, knowledge-base crawling, multi-tenant SaaS.

---

### Reproducing this sprint

```
# from experiments/
docker build -f feasibility/Dockerfile -t halflife-feasibility:dev .
node feasibility/run.mjs inspect_modify_async cache_ttl_post cache_ttl_pre streaming failures relay overhead
# with a key in the environment:
node feasibility/tavily_probe.mjs > feasibility/results/tavily.json
```

The Bifrost sources are in `experiments/vendor/` (`bifrost` = `main` at `a98fb35`, used for reading; `bifrost-v2.4.0` = the build target). They are untracked third-party code; delete them freely.
