# Architecture

This document describes the components of Halflife as implemented, how data flows between them, where the integration boundaries are, and the decisions that shaped them. The authoritative, numbered decision record with alternatives considered is [`research/ARCHITECTURE_DECISIONS.md`](../research/ARCHITECTURE_DECISIONS.md) (AD-01 to AD-28); this page summarises it and links to the decisions by number.

## Components

```
                 ┌──────────────────────────── docker compose (project "halflife") ───────────────────────────┐
                 │                                                                                             │
 Client ──HTTP──►│  gateway  (Bifrost v2.4.0 built from source, port 8080)                                    │
 (x-bf-vk)       │   ├─ providers: deepseek (+ others if keys present)  ───────────────────────────────────────┼──► LLM provider
                 │   ├─ plugin semantic_cache (exact match, chromem vector store)                              │
                 │   ├─ plugin halflife (.so, post_builtin) ── ingest (internal network, token) ──┐            │
                 │   ├─ relay /relay/tavily/*   (holds TAVILY_API_KEY, per-credit pricing) ─────────┼───────────┼──► api.tavily.com
                 │   └─ relay /relay/halflife/* (bearer injected, route allow-list) ──┐             │            │
                 │                                                                    ▼             ▼            │
 Browser ──────► │  engine  (Node 24, port 8090)  API · pipeline · SQLite · console                           │
 (console)       │   └─ calls back into the gateway for LLM (/v1/chat/completions), Tavily (/relay/tavily),   │
                 │      and cache admin (/api/cache/clear/{id})                                               │
                 │                                                                                             │
                 │  config  (one-shot)  renders Bifrost config.json + engine runtime.json from keys present  │
                 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Component | Location | Responsibility |
|---|---|---|
| **Gateway** | `deploy/gateway.Dockerfile` | Bifrost `transports/v2.4.0` (commit `e869c3f`, verified at build) compiled as a dynamically linked binary so it can load Go plugins. Bifrost's web UI is replaced by a stub page. |
| **Plugin** | `plugin/` | Inline work only: correlation IDs, lexical triage, cache TTL / `no-store`, text capture, bounded asynchronous hand-off, response headers, synchronous `verify` mode. |
| **Engine** | `engine/src/` | Extraction, classification, freshness model, verification, evidence rating, learning, cache actions, storage, HTTP API, SSE, console hosting. |
| **Console** | `engine/console/` | Operator UI served by the engine. |
| **Config renderer** | `deploy/render-config.mjs` | One-shot Compose service; writes Bifrost `config.json` with `env.NAME` references only, and the engine's `runtime.json` (default judge model, playground models, whether Tavily is enabled). |
| **Shared cues** | `shared/temporal-cues.json` | Lexical cue groups with keywords, regexes and TTL caps, used by the plugin (and the engine's heuristic extractor). |

### Why two deployables (AD-02)

A Go plugin runs inside the gateway process; a crash, leak or slow call there affects all traffic, and its dependencies must match the host's exactly. So the plugin is restricted to the Go standard library plus `bifrost/core/schemas` and does only microsecond-scale work (measured: all hooks for one request ≈ 42 µs, triage ≈ 30 µs on cue-dense text, in Docker with 4 CPUs). Everything slow, stateful or network-bound lives in the engine.

## Plugin: hook responsibilities (AD-04, AD-05, AD-06)

The plugin is registered with `placement: post_builtin`, which is the only placement that can set the semantic cache's TTL key.

| Hook | Work |
|---|---|
| `HTTPTransportPreHook` | Create the correlation/report ID; read `x-halflife-mode`; skip internal engine traffic (valid internal token only); capture the last user prompt. |
| `PreLLMHook` | Streams only: prompt-level triage → TTL / `no-store` (the TTL is locked at the first chunk). |
| `PostLLMHook` | Non-streams: answer-level triage → TTL / `no-store`; capture the answer; in `verify` mode, call the engine synchronously and annotate a stale reply. |
| `HTTPTransportPostHook` | Non-streams: read the cache id and hit status from the response, then enqueue the ingest job. This is the only hook that sees text, cache id and hit status together. |
| `HTTPTransportStreamChunkHook` | Accumulate streamed text (also on cache hits); enqueue once at the final chunk. |
| `HTTPTransportResponseHeadersHook` | Set `x-halflife-report`, `-mode`, `-ttl`, `-triage`, `-cache`, `-status`. |

Every hook recovers panics and passes the original response through unchanged. The hand-off queue is bounded and drops jobs (counted) rather than blocking. If the engine is down, inference is unaffected (tested in both the Go tests and the integration suite). A heartbeat reports plugin counters to the engine.

## Engine pipeline

`engine/src/pipeline.ts` orchestrates one report:

1. **Accept** (`/v1/ingest` from the plugin, or `/v1/check`) → validate input, create a report, queue it (bounded queue, `HALFLIFE_CONCURRENCY` workers, per-job time budget).
2. **Extract and classify** (`extract.ts`, `prompts.ts`, `llm.ts`). The judge model returns JSON (schema-validated): claim spans that must be exact substrings of the answer, a class from a closed list of 18 (`classes.ts`), an optional stated as-of date, and a time-sensitivity flag. Items failing validation are dropped. Past-tense statements about an explicitly dated past state are classified `historical.fact` (AD-21). If no LLM is configured, a labelled rule-based extractor is used (`extraction: heuristic`).
3. **As-of date** (`asof.ts`): explicit date in the text → previous verification → the generating model's *cited* knowledge cutoff → a labelled assumption (unknown cutoff: 6–36 months). It is always an interval.
4. **Freshness risk** (`freshness.ts`): see the model below. Claims with P(outdated) ≥ θ (default 0.2) are *at risk*; at most `HALFLIFE_MAX_VERIFY_PER_RESPONSE` (default 3), riskiest first, are verified, concurrently (AD-22).
5. **Verification ladder** (`verify.ts`, `tavily.ts`, AD-10):
   - **T0** reuse a stored verdict for the same normalised claim and class inside its reuse window (0 credits; never reuses a superseded verdict whose change date is in the future).
   - **T1** Tavily search (basic, published dates, topic by class, 5 results).
   - **T2** Tavily extract on the top 2 URLs, only if T1 yielded no verifiable quote.
   - Credits are reserved through `CreditGuard` (`credits.ts`) before each paid call (AD-19).
6. **Verdict.** The judge returns `current | superseded | contradicted | unverifiable`, quotes with evidence IDs, an optional change date, and an optional replacement value with its own supporting quote. Code then:
   - drops quotes not found in the source text; a verdict with no verified quote becomes `unverifiable` (AD-12);
   - discards `superseded` with a change date after today → `unverifiable [future_change]` (AD-25);
   - reports a replacement value only if a verified quote contains it (AD-20; numeric values may be grounded by any verified refuting quote, AD-26).
7. **Evidence level** (`evidence.ts`): `strong | moderate | weak | none` from explicit rules — number of verified quotes, independent sites, recency after the as-of date, conflicting sources (older sources still stating the old value do not count against `superseded`, AD-24).
8. **Learning** (`learn.ts`): verdicts with strong or moderate evidence become interval-censored observations that update the class's λ posterior on a grid. Requests with `learn: false` never do (AD-23).
9. **Cache action** (`cache.ts`, AD-11, AD-27): `superseded`/`contradicted` with ≥ moderate evidence → delete the cache entry now via the Bifrost cache admin API; otherwise schedule deletion at the reuse window if that is earlier than the entry's TTL. No action for answers marked `no-store`. Schedules persist in SQLite. Cache hits are linked to the original report and cost nothing.
10. **Store and publish** (`store.ts`, `events.ts`): reports, claims, evidence, observations, cache actions, spend and key–value state in `node:sqlite`; SSE events to the console. A retention sweep deletes reports older than `HALFLIFE_RETENTION_DAYS` (default 14).

## Freshness model (AD-09)

- **Class change rate:** changes to a claim of class *c* follow a Poisson process with rate λ, uncertain: λ ~ Gamma(α, β). Priors are versioned in `classes.ts`, each with a written rationale. Shown as a half-life with a 90% interval.
- **P(outdated now)** for a claim with age Δt since its as-of date: the Gamma–Poisson (Lomax) marginal `1 − (β/(β+Δt))^α`, evaluated on a 720-point λ grid (1e-9 to 1e5 per year). Because the as-of date is an interval, the result is a range. The grid is tested against the analytic Lomax for all 18 classes.
- **Reuse window:** after a verification, the time at which P(outdated since verification) reaches θ.
- **Calibration:** none. The priors are hand-set, the posterior has been updated by few observations (12 gateway-derived after evaluation observations were removed), and the evaluation did not measure calibration. It is labelled *estimated · uncalibrated* everywhere it is shown.

## Integration boundaries

| Boundary | Direction | Authentication | Notes |
|---|---|---|---|
| Client → gateway | inbound | Bifrost virtual key (`x-bf-vk`) | demo VK has a daily dollar budget |
| Plugin → engine `/v1/ingest`, `/v1/plugin/heartbeat` | internal Docker network | `HALFLIFE_INGEST_TOKEN` (bearer) | must not traverse the gateway (would re-enter it) |
| Relay → engine `/v1/*` | via gateway | Bifrost injects `HALFLIFE_RELAY_TOKEN`; caller needs a VK with the relay grant | route allow-list in `render-config.mjs` |
| Engine → gateway LLM | via gateway | engine VK + `x-halflife-internal` token | plugin skips these requests only if the token matches (AD-08) |
| Engine → Tavily | via `/relay/tavily` | engine VK; Bifrost holds the Tavily key | per-credit pricing, 402 on budget exhaustion |
| Engine → cache admin | via gateway | `BIFROST_ADMIN_TOKEN` | `DELETE /api/cache/clear/{id}` |
| Browser → console | localhost:8090 | `x-halflife-console` header; token only if `HALFLIFE_CONSOLE_TOKEN` is set | console-only routes: `/v1/events`, `/v1/playground` |
| Gateway → providers / Tavily | outbound internet | provider keys from the gateway's environment | |

## Deployment

`deploy/docker-compose.yml` defines `config` (one-shot renderer), `gateway`, `engine`, and a `fixtures` service under the `test` profile. Named volumes: `bifrost-config` (rendered config), `gateway-data` (Bifrost SQLite stores), `engine-data` (engine SQLite). On every start the gateway copies the rendered config and deletes its `config.db`, so `config.json` is always the source of truth (trade-off: governance usage counters reset on restart; AD-15).

## Design decisions in brief

| Decision | Reason | AD |
|---|---|---|
| Build Bifrost from source at a pinned tag | Go plugins need a dynamic host and identical dependency versions | AD-01 |
| Node 24 with zero npm dependencies | No build or install step, no supply-chain surface; native TS stripping, `node:sqlite` | AD-03 |
| Engine API exposed through Bifrost Relays | Reuses Bifrost's VK governance; engine never holds the Tavily key | AD-07 |
| LLM produces no numbers | Spans, enums, dates and quotes can be checked in code; numbers cannot | AD-09 |
| Quotes verified in code; replacement values need a quote | Prevent fabricated or inferred evidence from becoming a verdict | AD-12, AD-20 |
| Static claims are abstentions, not "current" | Halflife measures freshness, not general truth | AD-21 |
| Application-side Tavily allowance guard | Spend must stay inside the free plan; Tavily's counter lags | AD-19 |
| Integration tests use labelled fixtures | Reproducible without credentials; no mocks in the product path | AD-13, AD-16 |
| DeepSeek `deepseek-flash`, thinking off | Cost, latency and determinism; outputs are verified in code anyway | AD-17 |
