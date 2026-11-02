# Halflife: Architecture Decisions

Each entry: decision, why, alternatives considered or rejected. Decisions marked **[EXP]** were proven by the feasibility sprint (`research/HALFLIFE_FEASIBILITY_REPORT.md`, `experiments/feasibility/`). Don't revisit them without new evidence.

---

## AD-01 Build target: Bifrost `transports/v2.4.0`, dynamic build in Docker [EXP]
- **Why:** `main` does not compile against the published modules. Go plugins need a dynamically linked host and identical dependency versions, so the plugin is compiled *inside* the transports module (`deploy/gateway.Dockerfile`).
- **Rejected:** the official `maximhq/bifrost` image, which is static and cannot `plugin.Open`; building on native Windows, where Go plugins are unsupported.

## AD-02 Two deployables: Go plugin `.so` plus a Node engine
- **Plugin** (`plugin/`): inline, microsecond-scale work only. It handles correlation IDs, lexical triage, cache TTL, capture, bounded async hand-off and headers.
- **Engine** (`engine/`): extraction, classification, freshness model, Tavily evidence, verdicts, storage, API, console.
- **Why:** a crash or leak in heavy code must not take down the gateway. `.so` dependencies must match the host exactly, so the plugin is kept to `core/schemas` and the stdlib.
- **Rejected:** the engine inside the `.so`; a plugin-hosted sidecar listener (it works, but sits outside governance).

## AD-03 Engine runtime: Node 24 with native type stripping, zero npm dependencies
- **Why:**
  - Node 24 runs `.ts` directly (erasable syntax only) and ships `node:sqlite` and `node:test`. Both were verified on this machine on 2026-11-02.
  - With zero dependencies there is no supply-chain surface, no build step and no install step for judges.
- **Constraint:** no `enum`, `namespace` or constructor parameter properties. Imports use explicit `.ts` extensions.
- **Rejected:** Python, a second language beside Go with no benefit; Express or Fastify, which aren't needed; Prisma or other ORMs.

## AD-04 Plugin placement `post_builtin`; cache hits handled in transport hooks [EXP]
- **Why:** only `post_builtin` can set `semantic_cache-ttl`. LLM hooks don't run on hits, but `HTTPTransportPostHook`, `ResponseHeadersHook` and `StreamChunkHook` do.

## AD-05 Where each hook does its work
| Hook | Work |
|---|---|
| `HTTPTransportPreHook` | Create the correlation ID (Bifrost's request-id is not set yet [EXP]). Read the mode header. Skip internal traffic. Capture the last user prompt. |
| `PreLLMHook` | **Streams only:** prompt-level lexical triage, then TTL / no-store. The TTL is locked at the first chunk [EXP]. |
| `PostLLMHook` | Non-streams: response-level lexical triage, then TTL / no-store. Capture the text. Optional synchronous verify. |
| `HTTPTransportPostHook` | Non-streams: read `cache_debug` (id, hit) from the body, then enqueue the ingest job. This is the only hook that sees text, cache_id and hit status together. |
| `HTTPTransportStreamChunkHook` | Accumulate stream text, which works on hits too. At the final chunk, enqueue the job once. |
| `ResponseHeadersHook` | `x-halflife-report`, `x-halflife-triage`, `x-halflife-ttl`, `x-halflife-cache`. |

- **Why the job is enqueued in `HTTPTransportPostHook`:** the probe had to sleep 300 ms to catch `cache_id` when it enqueued from `PostLLMHook`.
- **Bug seen in the probe:** the final-chunk note was appended twice. The stream hook must act **once** per request, guarded by state.

## AD-06 Every hook is wrapped in `recover()` and fails open [EXP]
- An unrecovered panic in a hook returns a 500 for that request.
- Errors are counted and exposed. The original response is never altered on failure.

## AD-07 Engine API is exposed through Bifrost Relays [EXP]
- `/relay/halflife/*`: VK-gated with a route allowlist. Bifrost injects `Authorization: Bearer env.HALFLIFE_RELAY_TOKEN`, so the engine can tell relayed calls apart.
- `/relay/tavily/*`: Bifrost holds `env.TAVILY_API_KEY` (bearer) and prices calls at `usage.credits × $0.008` against the engine VK budget, returning 402 when the budget is exhausted [EXP with mock].
- The engine **never holds the Tavily key**.
- **Plugin → engine ingest** is a direct call on the internal Docker network, authenticated with `HALFLIFE_INGEST_TOKEN`. It must not traverse the gateway, or it would re-enter the gateway.

## AD-08 Loop prevention
- The engine's own LLM calls through Bifrost carry `x-halflife-internal: <HALFLIFE_INTERNAL_TOKEN>`. The plugin skips those requests.
- The header alone is not enough: the token must match, so clients cannot opt out silently by forging it.

## AD-09 Freshness model keeps three quantities separate (Feasibility §4)
- **A. Expected lifespan** of a claim *class*: a Poisson change rate λ with a Gamma(α, β) prior. Shown as a half-life with a credible interval.
- **B. P(outdated now)** for a claim: the Gamma-Poisson (Lomax) marginal `1 − (β/(β+Δt))^α`. Δt runs from the claim's as-of date: an explicit date in the text, else the model's knowledge cutoff (as a range), else unknown.
- **C. Evidence confidence:** an ordinal level (strong / moderate / weak / none) from explicit, unit-tested rules. **Never shown as a percentage.**
- **The LLM produces only categorical, checkable fields:**
  - spans, which must be exact substrings
  - a class from a closed list
  - dates
  - verdict enums
  - quotes, which must occur in the evidence
- **No LLM-produced numbers enter the model.**
- **Learning:** a 1-D grid posterior over λ per class, updated only by verdicts with strong or moderate evidence. One code path: the grid also represents the prior, and is tested against the analytic Lomax.
- P(outdated) is labelled **"estimated, uncalibrated"** until the evaluation harness has run.
- **Rejected:**
  - LLM-produced probability or confidence numbers
  - a fixed class table with no learning
  - raw Wikidata durations as ground truth, which are biased [EXP]

## AD-10 Verification ladder and spend control
- **T0:** evidence cache (same normalised claim and class, inside the reuse window). Costs 0 credits.
- **T1:** Tavily `search` (basic, `include_published_date`, topic by class, 5 results). Costs 1 credit.
- **T2:** `extract` on the top 2 URLs with `query = claim`, only if T1 had no quotable passage. Costs about 1 credit.
- **Triage:** only claims with P(outdated) ≥ θ (default 0.2), at most N per response (default 3), are verified.
- **Caps:** a daily engine credit cap (default 150), plus the Bifrost VK budget on the relay.
- **Budget errors:** a 402 from Bifrost or a 432/433 from Tavily becomes verdict `unverifiable` (reason `budget`). There are no retries.
- **Rejected:** Tavily Research by default (4–250 credits); Crawl and Map (no dates).

## AD-11 Cache policy
1. **Inline (plugin):** lexical cue triage from `shared/temporal-cues.json` caps the TTL per cue group (for example prices at 2 min, versions at 1 h). It can set no-store.
2. **After verification (engine):**
   - A `superseded` or `contradicted` verdict with at least moderate evidence invalidates the entry immediately (`DELETE /api/cache/clear/{id}`).
   - Otherwise the engine schedules invalidation at the response's **reuse window** `t* = min over claims of the time when P(outdated since verification) reaches θ`, if that comes earlier than the entry's TTL.
   - Schedules persist in SQLite.
3. **Cache hits:** linked to the original analysis by `cache_id`, with no re-spend.

## AD-12 Prompt-injection posture
- Response text and web evidence are passed as JSON data inside clearly delimited fields, with an explicit instruction that they are untrusted.
- Output is schema-validated in code:
  - an enum mismatch, a missing span or a missing quote **drops the item**
  - verdicts whose quotes aren't found are downgraded to `unverifiable`
- Evidence text is truncated per source.

## AD-13 No mocks in the product path
- Test-only fakes live in `engine/test/fakes/` and `deploy/test/`. Every output they produce is labelled `"fake": true` / `[TEST FIXTURE]`.
- When a provider is not configured, the product says so ("Tavily not configured, claims not verified"). It never fabricates a verdict.
- The heuristic extractor is a real, documented, rule-based method, used when no LLM is configured, and is labelled `extraction: heuristic`.

## AD-14 Console served by the engine (vanilla ES modules, no framework, no build)
- **Why:** zero dependencies, instant load, full control of typography and interaction. A small `h()` helper keeps the DOM code tidy.
- Live updates use SSE from `/v1/events`.
- **Rejected:** React or Vite (build step and dependency weight); Bifrost UI customisation (not an extension point).

## AD-15 Deploy config rendered from the credentials present
- `deploy/render-config.mjs` runs as a one-shot compose service. It writes the Bifrost `config.json` with `env.NAME` references only, plus the engine's `runtime.json` (default judge and playground models, and whether Tavily is enabled).
- The gateway entrypoint copies the rendered config and deletes `config.db` on start, so `config.json` is always the source of truth. Trade-off: governance usage counters reset on restart.
- **Rejected:** a hand-maintained `config.json`, which would break when keys are absent; writing secrets into the config.

## AD-16 Integration tests use labelled fixtures, not mocks inside the product
- `deploy/test/fixtures.mjs` speaks the OpenAI and Tavily wire formats and runs only under the compose profile `test`. It is enabled only when `HALFLIFE_FIXTURE_UPSTREAM` is set. Every output is marked `[TEST FIXTURE]`, and its domains are `example.*`.
- Fixture mode lists explicit model names, because Bifrost's `"*"` allow-list consults its model catalog.

## AD-17 Hosted LLM: DeepSeek through Bifrost's native provider (session 3, 2026-11-02)
- **Provider:** Bifrost v2.4.0 ships `core/providers/deepseek`. It uses the base URL `https://api.deepseek.com`, sends the key as `Authorization: Bearer`, and speaks the OpenAI-compatible `/chat/completions` endpoint. Config: `providers.deepseek.keys[].value = env.DEEPSEEK_API_KEY`, and models are addressed as `deepseek/<model>`. No custom provider or direct DeepSeek call was needed. All Halflife LLM traffic still goes through Bifrost.
- **Models (DeepSeek pricing page, read 2026-11-02):**
  - `deepseek-flash` (DeepSeek-V4.1-Flash-1017): 1M context, $0.15/M tokens in (cache miss), $0.60/M out at off-peak rates; peak rates are 2×. Concurrency limit 2500.
  - `deepseek-v4-pro`: about 4.4× the price ($0.66 in / $1.98 out off-peak), concurrency limit 500.
  - The legacy name `deepseek-v4-flash` is still accepted, but it is served by V4.1-Flash.
- **Decision: both tasks use `deepseek-flash` with thinking disabled.**
  - **Extraction and classification:** span copying plus a closed class list. Thinking adds latency and cost, and gains nothing on this kind of task.
  - **Verdicts:** bounded to the given evidence. Every quote is checked in code (AD-12), and a wrong verdict without a verified quote is discarded anyway.
  - **Why not thinking:** DeepSeek's thinking mode is on by default (effort high), and it ignores `temperature`. Determinism (`temperature: 0`) and the 20 s LLM timeout and 45 s job budget favour non-thinking.
  - **Why not Pro by default:** about 4× the cost and a lower concurrency limit, for a task that the code already guards.
- **Override:** `HALFLIFE_LLM_MODEL=deepseek/deepseek-v4-pro` switches the judge. `HALFLIFE_LLM_FALLBACKS` sets Bifrost fallbacks. `HALFLIFE_LLM_EXTRA_BODY` (JSON) replaces the request fields, for example to re-enable thinking at low effort.
- **Revisit:** after the evaluation harness has run. If verdict accuracy per evidence level is poor, try Pro for verdicts only. That would need a second LLM handle in `verify.ts`; it is not built yet.
- **How thinking is turned off:**
  - `render-config.mjs` writes `runtime.json.llm_extra_body = {deepseek: {thinking: {type: "disabled"}}}`.
  - The engine merges the fields for its judge model's provider into each request body (`BifrostLLM.extraBody`). The model field cannot be overridden this way.
  - Bifrost puts unknown body fields into `ExtraParams`, and the DeepSeek provider passes them through. The integration test proves this.
- **Structured output:** DeepSeek accepts only `response_format: json_object`, and needs the word "json" in the prompt.
  - Bifrost's DeepSeek path (`openai/chat.go` `downgradeJSONSchemaToJSONObject`) rewrites `json_schema` to `json_object` and injects the schema as a system instruction that contains "json".
  - So the engine keeps sending strict `json_schema`, and no 400 step-down is triggered. This is verified on the wire by integration check 9.
- **Allow-list:** the DeepSeek VK provider configs list `deepseek-flash` and `deepseek-v4-pro` explicitly, not `"*"`. The `"*"` path consults Bifrost's model catalog (see AD-16), which may not know current DeepSeek names.
- **DeepSeek limitations and how Halflife handles them:**
  - **Blank JSON-mode content** ("may contain only spaces", `finish_reason` stop): this is a parse error, retried once. If it fails again, extraction falls back to the labelled heuristic, and the verdict becomes a labelled limitation.
  - **402 Insufficient Balance:** mapped to a `budget` limitation carrying the upstream message, so it is distinguishable from the Bifrost VK budget. It is never retried.
  - **429 rate limit:** one retry, honouring `Retry-After` clamped to 0.5–5 s.
  - **5xx or overload:** one retry, then a fallback model if `HALFLIFE_LLM_FALLBACKS` is set.
  - **Other 400s** (such as context length) no longer step the structured-output format down for every later call. Only a format-related 400 does.
  - **Knowledge cutoff:** DeepSeek publishes no knowledge cutoff for V4.1-Flash. The only figure found (May 2025) comes from an unofficial aggregator. `asof.ts` lists only cited cutoffs, so DeepSeek answers get the labelled "unknown cutoff: assumed 6–36 months" range. Explicit dates in the text still take precedence.
  - **Unverified:** whether Bifrost's model catalog has pricing for `deepseek-flash`, which the VK dollar budget needs to meter LLM spend. To be checked in the live run.

## AD-18 Tavily MCP for development: not connected (session 3, 2026-11-02)
- **Question:** would a Tavily MCP server for the coding agent materially improve development, on top of the production Tavily API that goes through the Bifrost relay?
- **Decision: no. The link was not requested.**
- **Research is already covered:**
  - WebSearch and WebFetch handled docs, competitors and API changes this session (DeepSeek pricing and guides, model cutoff).
  - For source-of-truth questions, `curl` against GitHub raw/API at the pinned tag was more authoritative than any search. It showed the DeepSeek provider's real behaviour.
- **Product search is already covered:** testing what Halflife actually relies on (`published_date` coverage, `topic: news`, extract quality) must use the product's exact parameters and be reproducible. `experiments/feasibility/tavily_probe.mjs`, the live script and the planned evaluation harness do that with the existing `TAVILY_API_KEY`. MCP calls would be ad hoc, unrecorded, and would spend from the same credit pool.
- **What MCP would add:** Tavily-ranked results with `published_date`, and raw-content extract/crawl in the agent loop. WebFetch only returns model-summarised pages, but raw pages are already one `curl` away, and scripted Tavily calls give the ranked, dated view in a recorded form.
- **Cost of connecting:** Tavily's hosted MCP URL normally carries the API key as a query parameter, so passing it into the agent session is itself a credential exposure.
- **Revisit if:** web research becomes the bottleneck. For example, WebSearch is US-only and failed once this session on a docs host. Another trigger: the evaluation needs large, interactive Tavily exploration that scripts make awkward.

## AD-19 Tavily free-allowance guard (session 4, 2026-11-02)
- **Constraint:** Tavily spend must stay at exactly $0. The account is the free **Researcher** plan: 1,000 credits per month, `paygo_limit: null`, and pay-as-you-go usage 0. It is not 8,000 credits as first assumed. These facts come from `GET https://api.tavily.com/usage`, which is free.
- **Decision:** a hard, application-side ceiling in two layers.
  1. **Engine** (`engine/src/credits.ts`, `CreditGuard`). Before every paid search or extract it checks:
     - the daily cap (150)
     - the lifetime engine cap (`HALFLIFE_TOTAL_CREDIT_CAP`, 700, summed from the persistent spend ledger)
     - the **account ceiling**, `floor(plan_limit × 0.8)` = 800, against Tavily's own counter, read through a new free relay route `GET /relay/tavily/usage` (the engine still never holds the key)
  2. **Scripts** (`deploy/test/spend-guard.mjs`). `preflight({plannedCredits})` refuses to start a run unless the planned worst case fits under the same ceiling. `reconcile()` appends actual consumption to `deploy/test/results/spend-ledger.jsonl`.
- **The 20% reserve:** 200 credits are held back for the final demo and for unexpected testing. To spend the reserve, raise `HALFLIFE_TAVILY_CEILING_FRACTION`. It is clamped to 0.95 in code, so the guard can never allow the full allowance.
- **Fails closed when:**
  - usage has never been read
  - any pay-as-you-go usage is reported
  - the plan limit is unknown
  - a key-level limit would be exceeded
- **Measured facts that shaped it (live, 2026-11-02):**
  - **The counter lags.** `/usage` still showed 0 about 25 minutes after the first credit, with 60+ credits spent by then. So "used" is `max(Tavily counter, first reading + every credit reserved locally, the engine's lifetime spend)`. Never the counter alone.
  - **`/usage` is rate-limited.** Repeated 429s were seen after a handful of calls. After one good reading, the engine keeps counting locally on top of it, and refreshes every 5 minutes. The scripts fall back to the last ledger reading (under 24 h old), or refuse.
  - Reservations are **serialised**, so concurrent claims cannot jointly overshoot. This is tested.
- **DeepSeek budget:** a development budget of $1.00. The guard bounds it by `max(balance delta, engine tokens × $1.20/M)`, which is the peak output rate. The bound is deliberately pessimistic: $0.38 bounded vs $0.03 actual after this session. The balance moves in $0.01 steps.
- **Rejected:**
  - Trusting Tavily's 432/433 errors, which happen at the plan limit, after the reserve is gone.
  - Relying on the Bifrost VK dollar budget alone. It resets daily and doesn't know the account total.

## AD-20 A new value is reported only if a verified quote states it (session 4)
- **Found live:** for "As of early 2023, Jack Dorsey is the CEO of Twitter", the judge returned `current_value: "Elon Musk (CEO of X)"`. Its verified quotes said only that Musk *bought* Twitter. The value was an inference, and at that point a wrong one: Yaccarino was CEO from 2023 to 2025.
- **Decision:**
  - The verdict schema gains `current_value_quote {evidence_id, quote}`.
  - Code reports `current_value` only if that quote occurs in the source **and** contains the value. For numbers, every number in the value must appear in the quote ("$15.99 per month" is grounded by "$15.99/month"). For names, every word must.
  - Otherwise the value is omitted, and `level_reasons` records `current value "…" omitted: no verified quote states it`.
  - The verdict itself is unaffected; it is still governed by the AD-12 quote rules.
- **Known limits:**
  - Token grounding cannot tell "up to Node.js 26" from "the latest is Node.js 26".
  - Among valid quotes, the judge may pick a less authoritative source: live, it picked "iOS 27.2" from a page dated 2022 over endoflife.date's 27.0.1.
  - It is sometimes over-strict: "Pope Leo XIV" was omitted once.

## AD-21 Temporal scope: tense decides; static claims are not checked (session 4)
- **Found in eval v2:** the judge handled past-dated claims inconsistently. "In 2023, Sunak was PM" came back current; "As of 2021, the latest Python was 3.10" came back superseded.
- **Decision:**
  - **Past tense about an explicitly dated past state** ("In 2023, X was…", "As of 2021, the latest version was…") is a historical record. It is extracted as `historical.fact` / not time-sensitive, triaged `static`, and spends 0 credits.
  - **Present tense qualified by a date** ("As of 2023, X is the CEO") still asserts the present, so it keeps its topical class and is checked. Live, it is now judged `contradicted` for Dorsey, which is the precise verdict.
  - The rule lives in the extraction prompt.
- **Scope boundary, stated explicitly:** a static claim is **not checked**. Halflife measures *freshness*. It does not detect factual errors in claims that cannot go out of date ("The Burj Khalifa is 900 m"). The evaluation scores static triage as an **abstention**, not as "current". The first v1 run scored it as "current"; this was corrected after v2.

## AD-22 Claims of one response are verified concurrently (session 4)
- **Why:** measured live, two claims verified sequentially took 11–21 s.
- **How:** `Promise.all` over at most `maxVerifyPerResponse` (3) claims. Credit reservations are serialised by `CreditGuard`, and store writes are synchronous.
- **Result:** fresh single-claim checks measured p50 5.5 s, p95 11 s; most of that is the DeepSeek verdict plus Tavily search.

## AD-23 Request options `verify: false` (assess-only) and `learn: false` (session 5, 2026-11-02)
- **`verify: false` on `/v1/check`:** extraction and the freshness estimate run, but at-risk claims are marked `not_checked` with limitation `assess_only`. No search, no verdict, 0 Tavily credits. Used for the FreshQA detection run; also a product feature (a risk estimate before spending).
- **`learn: false`:** verdicts are reported normally but never become learning observations.
- **Why `learn: false` exists:** evaluation sets are selected (FreshQA part B was chosen *because* the answers changed), so their verdicts bias the class change rates upward. Found after the FreshQA run: 79 of 91 observations came from evaluation reports (51 "changed"). Both eval runners now send `learn: false`.
- **Clean-up done:** the 79 evaluation-derived observations were deleted after a backup (`engine/data/backup-before-eval-obs-removal.db`, gitignored). 12 gateway-derived observations remain.
- **Known limit:** repeated demo prompts with slightly different wording can still add near-duplicate observations.

## AD-24 Evidence rule: older sources stating the old value don't conflict with "superseded" (session 5)
- **Found in the console audit:** "Netflix Standard $15.49" was judged superseded with three 2026 sources stating $19.99. The level was still **weak**, because one 2024 page still quoted $15.49 and counted as "pointing the other way".
- **Decision:** for `superseded` only, a supporting quote dated *before* the newest dated refuting quote is expected (the claim was true, then changed). It is reported as "N older sources still state the old value, which is consistent with a change", and is not counted as opposition.
- **Unchanged:** an undated supporting quote, or one dated on or after the newest refutation, still counts against the verdict. `contradicted` (never true) keeps every opposing quote. Unit-tested.

## AD-25 A "superseded" verdict whose change is dated in the future is discarded (session 5)
- **Found in FreshQA (C-434):** "Zootopia 2 is the most recent WDAS film" was judged superseded by *Hexed*, releasing 2026-11-25. The judge wrote that this date was "before today's date"; today was 2026-11-02. This is a date-arithmetic error by the LLM.
- **Decision:** in code, `verdict = superseded` with `changed_on` after today → `unverifiable`, limitation `future_change`. This triggers the normal T2 retry (at most 1 credit).
- The T0 reuse lookup also never reuses a stored superseded verdict whose `changed_on` is still in the future.
- **Verified live:** rerun of B-434 and C-434 → both `unverifiable [future_change]` (`eval/results/freshqa-rerun-futurechange-*.json`).

## AD-26 Numeric replacement values may be grounded by any verified refuting quote (session 5)
- **Found in the console audit:** YouTube Premium "$15.99 per month" was omitted even though a verified quote said "$15.99/month for an individual plan". The judge had pointed `current_value_quote` at a different item.
- **Decision:**
  - The judge's own value quote is tried first.
  - For values containing a digit (prices, versions, counts) **only**, any verified *refuting* citation that contains every number is accepted.
- **Names get no fallback:** "Elon Musk bought Twitter" contains both name tokens but does not say Musk is CEO. The existing AD-20 test keeps guarding this case.

## AD-27 Console and cache-action honesty rules (session 5 audit)
- **No cache action for `no-store` answers.** Bifrost never stored the entry, and a DELETE of a missing entry returns 200. Before, the console showed "invalidate stale · done · HTTP 200" for answers that were never cached.
- **Weak evidence is never shown like strong evidence:**
  - superseded or contradicted with weak evidence → "Possibly superseded · weak evidence" (warning tone)
  - current with weak evidence → "Likely current · weak evidence"
  - report badge "Possibly outdated" / "Likely current"
  - **Why this is the rule:** the engine itself doesn't invalidate or count such claims (stale requires ≥ moderate).
- **Headlines** (`headlineFor`, `summary_version 3`):
  - name the actual verdict counts ("1 checked: 1 unverifiable", not "1 checked, 0 unverifiable" for a superseded claim)
  - never say "all current" while at-risk claims went unchecked
  - weak stale is "possibly outdated"
  - Stored reports are re-headlined at startup from their stored claims. Verdicts and levels are never altered.
- **Other display rules:**
  - Event timestamps are local time with the zone named. Before, a UTC date was shown next to a local time.
  - "Checked live" says how many claims were reused (no new search).
  - The feed says "latest 100" when truncated.
  - Tavily publication dates carry a tooltip that they can be wrong.
- **Per-report tokens** are recorded in the summary and shown with the credits.
- **The System page shows the free-allowance guard:**
  - lifetime and daily engine credits against their caps
  - the account ceiling and the local count
  - pay-as-you-go refusal
  - the last refusal or read error

## AD-28 FreshQA evaluation design (session 5)
- **Data:** two public FreshQA snapshots (2024-02-26, 2026-04-21), exported as CSV, sha256 recorded. Matched by normalised question text, because IDs were renumbered between versions. `eval/freshqa-build.mjs` is deterministic (seeded hash order).
- **No hand-written statements:** each item is FreshQA's question (passed as `question`) plus one answer verbatim (passed as `text`), through the real `/v1/check` path.
- **Two questions, scored separately:**
  - **A, detection:** FreshQA `fact_type` is the ground truth; run assess-only.
  - **B/C, verification:**
    - B is the 2024 answer to questions whose answer changed by 2026-04-21: known stale.
    - C is the 2026-04-21 answer: current at the snapshot only.
- **Integrity rules:**
  - Any stale verdict on C is adjudicated by hand from sources found independently of Tavily (`eval/freshqa-adjudications.json`). "Unclear" is never counted correct.
  - A B answer that became true again ("changed_back", Wimbledon) is excluded, not counted.
  - Replacement values count as right only if they match the snapshot or an adjudicated later change.
  - Precision is also reported in the worst case (every unadjudicated item wrong).
- **Rejected:**
  - Writing claim statements by hand, which adds labeller bias.
  - Treating snapshot answers as current in November 2026.
  - Scoring time-invariant claims as "current". AD-21 keeps them as abstentions.

## AD-29 Repository contents: what is committed and what stays local (session 6, 2026-11-02)
- **Decision:** one git repository (branch `main`) holding source, tests, docs, research notes, evaluation inputs and the evaluation evidence needed to reproduce the published numbers. Excluded by `.gitignore`:
  - **secrets:** `deploy/.env` and any `.env` other than `.env.example`
  - **local state:** `engine/data/` (SQLite DB and its backup), any `*.db`
  - **logs and machine-local output:** `.build/`, `*.log`, `deploy/test/results/` (integration/live results, spend ledger, DeepSeek balance baseline), `deploy/demo/results/` (demo transcripts), raw v1/v2 runs `eval/results/run-*.json`, the 2-item FreshQA smoke run
  - **third-party data and sources:** the FreshQA snapshot CSVs (`eval/data/freshqa/*.csv`), the Bifrost clones in `experiments/vendor/` (~2.5 GB)
  - **machine-specific:** `experiments/feasibility/results/environment.json`, feasibility build and gateway logs
- **Kept as evaluation evidence:** the FreshQA raw runs the scorer reads (`freshqa-A-…15-50-18`, `freshqa-BC-…`, both reruns), `latest-freshqa.md`, `latest-v1.md`, `latest-v2.md`, `freshqa-set.json`, `freshqa-adjudications.json`. Verified: `node eval/freshqa-score.mjs` on the committed files reproduces `latest-freshqa.md` exactly except its timestamp.
- **Screenshots** `deploy/demo/backup/*.png` are committed: genuine console captures, checked visually for secrets (none). They showed the local time zone (superseded by AD-31: originals withdrawn, sanitised copies published).
- **FreshQA CSVs excluded** because the FreshQA GitHub repository is Apache-2.0 but the Google Sheets data carries no explicit licence statement. `freshqa-set.json` (the 160 sampled items, verbatim questions and answers, with source, citation and hashes) is committed; that is a small excerpt with attribution. Revisit if the dataset authors state data terms.
- **`.gitattributes`** normalises text to LF, because files are copied into Linux containers.
- **Rejected:** committing everything (logs and ledgers hold account balances and are noisy); committing nothing generated (the published evaluation numbers would not be reproducible); vendoring Bifrost (2.5 GB; the gateway build clones the pinned tag instead).

## AD-30 Licence: not selected; recommendation recorded, operator decides (session 6)
- **Status:** superseded in session 7. The operator approved Apache-2.0, and it is applied (AD-31). The original status was: no `LICENSE` file.
- **Facts checked:** Bifrost is Apache-2.0 (its `LICENSE`, read at `transports/v2.4.0`); its `THIRD_PARTY_NOTICES.md` lists MPL-2.0 Go dependencies (`hashicorp/go-version`, parts of `cyphar/filepath-securejoin`) compiled into the gateway binary, used unmodified. The plugin imports only `bifrost/core/schemas` and the Go stdlib. The engine has zero npm dependencies. FreshQA repository: Apache-2.0; sheet data: no stated terms. Base images: `golang`, `node`, `debian` (not redistributed by the repo).
- **Recommendation: Apache-2.0.** Same licence as Bifrost, so the plugin can be proposed upstream without relicensing; includes an explicit patent grant; permissive for hackathon judges and users. MIT would also be compatible but lacks the patent grant and differs from upstream.
- **Concerns to resolve before choosing:**
  1. The hackathon's rules may impose licence or IP terms on submissions; not checked (no public rules page found).
  2. Publishing built images (not planned) would distribute Bifrost and its MPL-2.0 dependencies: Apache-2.0 NOTICE and MPL-2.0 source-availability obligations would then apply.
  3. AI-assisted authorship (disclosed in `SUBMISSION.md`) does not block licensing, but the operator should be comfortable asserting copyright over the code.

## AD-31 Publication preparation: Apache-2.0 applied; private and FreshQA-derived material withdrawn (session 7, 2026-11-02)
- **Operator decisions (session 7):** licence Apache-2.0; FreshQA CSVs stay excluded; the demo transcript stays private; screenshots are published only with the time zone removed.
- **Licence applied:** `LICENSE` is the official Apache-2.0 text, byte-identical to apache.org/licenses/LICENSE-2.0.txt (sha256 `cfc7749b…3d30`). The appendix placeholder is left as published. Copyright and attribution are in `NOTICE` ("Copyright 2026 The Halflife authors"). `THIRD_PARTY_NOTICES.md` holds the provenance and dependency inventory.
- **Provenance audit (no blocking issue):**
  - No copied third-party code. The only lines shared with Bifrost's example plugins are the plugin-interface hook signatures and the `core/schemas` import. No licence headers or "adapted from" markers.
  - No bundled fonts, icons or libraries. Console icons are hand-written SVG paths, and fonts are referenced by name only.
  - The engine has 0 npm dependencies.
  - The plugin links `core/schemas` → sonic (Apache-2.0), mcp-go, gjson, sjson and fasthttp (MIT), and `x/net` (BSD-3), all at build time only.
  - Bifrost's MPL-2.0 dependencies matter only if built images are distributed.
  - Wikidata aggregates are CC0.
- **Supersedes part of AD-29:** FreshQA-derived files that reproduce questions and answers verbatim are withdrawn from version control, because the sheet data has no stated licence. Affected: `eval/freshqa-set.json`, `eval/results/freshqa-*.json` and `eval/results/latest-freshqa.md`. This applies the operator's CSV decision consistently. They stay on disk and are gitignored.
  - Kept: `eval/freshqa-adjudications.json` (our own notes and URLs).
  - The docs report the aggregate figures and explain how to rebuild.
  - **Cost:** a clean clone can no longer re-score the original runs.
- **Screenshots:** the originals (`deploy/demo/backup/`) are withdrawn and gitignored. Sanitised copies are in `docs/assets/screenshots/`.
  - Blanked: the report-header time and zone (the date is kept), every feed clock time, and the System page's "updated HH:MM:SS".
  - Fills use the surrounding background colour; nothing else is altered.
  - **Why also the clock times:** local feed times can be matched against UTC timestamps recorded in committed files, which would reveal the zone. Do not quote local clock times or the zone in any committed file.
  - Verified programmatically (no timestamp-signature rows remain) and visually. The PNGs carry no text or time metadata chunks.
- **History (resolved in session 8):** the two pre-release local commits still contained the original screenshots, the FreshQA-derived files and text naming the zone. The operator chose option (a): the local history was replaced by a single parentless root commit built from the sanitised tree.
  - The old history is preserved privately outside the repository (a verified git bundle plus a copy of the old `.git`). It is not reachable from any ref, and the old objects were pruned from this repository.
  - Rejected: (b) publishing as-is and accepting the exposure.
