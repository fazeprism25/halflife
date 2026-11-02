# Research Report: Geek Room Global AI Hackathon 2026

**Date:** 2026-11-02 (build days 2 to 15 remain; submission is due Nov 15)
**Status:** Research phase. No implementation yet.

**Epistemic labels used throughout**
- **[V] Verified**: read in official docs or a primary source during this research. A link is given.
- **[S] Secondary**: comes from a third-party write-up. Plausible, but not confirmed against the primary source.
- **[A] Assumption or conclusion**: our own reasoning. Treat it as a hypothesis.

---

## 1. Hackathon requirement analysis

**Source note:** I could not find a public event page for "Geek Room Global AI Hackathon 2026" that lists the Bifrost and Tavily tracks. Every requirement below comes from the operator's brief. **We should confirm the official problem statement PDF or page before submission**, especially the exact Problem 04 and 06 wording and how judges score them.

What the brief requires (paraphrased from it):
- We must pick **one Bifrost problem (01 to 04) plus Problem 06 (Tavily)**. One integrated product that covers both is allowed.
- **Both Tavily and Bifrost must "meaningfully contribute."** A thin API call will hurt the scores for Use of AI and Technical execution.
- There are six judging criteria. No weights are published, so we assume they are equal **[A]**.

**Hard requirements for Problem 06**
1. Claim identification.
2. Freshness detection.
3. Live verification.
4. Freshness scoring.

**Hard requirements for each Bifrost problem**

| Problem | Requirements | Our risk read [A] |
|---|---|---|
| 01 Coding agent | Outage/rate-limit resilience, spend limits, local-only confidential repos, approvals | Crowded market: OpenCode, Aider, Cline, Claude Code. Bifrost already covers resilience and budgets, and Code Mode already claims token savings. The only work left is differentiation. |
| 02 Agent benchmarking | Framework independence, repeatability, metrics, fault injection, trace comparison | Very crowded: Langfuse, Braintrust, LangSmith, Phoenix, inspect_ai, plus AgentChaos and ReliabilityBench in research. |
| 03 Pentest agent | Organiser lab only, scope enforcement, reporting | Depends on organiser lab access we have not been given. A scope violation could disqualify us, and the Tavily link is weak. |
| **04 Bifrost feature** | Real operational problem, supported extension points, reproducible integration, tests and docs, upstream-ready | **Pairs naturally with 06** (see below). The work is measurable and reviewable. |

**Implication [A]:** The strongest submission is one where the Tavily problem *is* the Bifrost feature, so neither integration is bolted on. Of the four problems, only Problem 04 allows this cleanly.

---

## 2. Bifrost technical research

**What it is [V]:** Bifrost is an open-source AI gateway written in Go by Maxim. It exposes one OpenAI-compatible API in front of 20+ providers, with roughly 9.3k GitHub stars. It runs either as an HTTP gateway with a web UI or as an embedded Go SDK. Links: [repo](https://github.com/maximhq/bifrost), [docs](https://docs.getbifrost.ai/overview).

**Relevant capabilities [V]**
- Fallbacks across providers and keys, plus load balancing.
- Governance with virtual keys, budgets and rate limits at the key, team and customer level.
- Semantic caching.
- MCP gateway features: Agent Mode, Code Mode, tool filtering.
- Observability through Prometheus, OpenTelemetry and Datadog.
- Local providers: Ollama, vLLM, SGL.
- Guardrails: 15 options. Only Patronus is marked for hallucination detection. **None mention web grounding or freshness.** ([guardrails](https://docs.getbifrost.ai/enterprise/guardrails))

**Repository layout [V]**
- `core/`: providers, schemas, `bifrost.go`
- `framework/`: configstore, logstore, vectorstore
- `transports/bifrost-http`
- `ui/`
- `plugins/`, with in-tree plugins: `compat, governance, jsonparser, logging, maxim, mocker, modelcatalogresolver, otel, prompts, routing, semanticcache, telemetry`

**Plugin extension points [V]** ([writing plugins](https://docs.getbifrost.ai/plugins/writing-plugin), [getting started](https://docs.getbifrost.ai/plugins/getting-started))
- Lifecycle: `Init(config)`, `GetName()`, `Cleanup()`.
- HTTP transport hooks: `HTTPTransportPreAuthHook`, `HTTPTransportPreHook`, `HTTPTransportPostHook`, `HTTPTransportResponseHeadersHook`, `HTTPTransportStreamChunkHook`.
- LLM hooks: `PreRequestHook` (routing), `PreLLMHook` (per attempt, and can short-circuit), `PostLLMHook` (can rewrite the response or error, and controls `AllowFallbacks`).
- MCP hooks: `PreMCPHook` and `PostMCPHook` (per tool call), plus connection hooks.
- `HTTPTransportPreHook` can short-circuit with its own response. **A plugin can therefore serve its own API routes inside the gateway [A, inferred from the documented semantics; verify in the spike].**

**Constraints that matter to us [V]**
- **Go `.so` plugins only work on Linux and macOS. They do not work on Windows.** The operator's machine is Windows 11, so we need WSL2 or Docker.
- A plugin must match Bifrost's exact Go and dependency versions, and cross-compilation is not supported.
- WASM plugins are deprecated, and "webhook-based plugins" are being introduced to replace them.
- The upstream contributing guide asks for:
  - one folder per plugin with `main.go`, `plugin_test.go`, `README.md` and `go.mod`
  - more than 90% unit test coverage, integration tests and concurrency tests
  - **under about 10 ms of added latency**
  - configurable resource limits and built-in metrics

  Source: [contributing guide](https://www.getmaxim.ai/docs/bifrost/contributing/plugin.md).

**Semantic cache behaviour (the key gap) [V]** ([semantic caching](https://docs.getbifrost.ai/features/semantic-caching))
- Freshness is purely time-based, with a default TTL of 5 minutes.
- TTL can be overridden per request with `x-bf-cache-ttl`.
- Invalidation is manual: by ID or by key.
- The docs describe no mechanism for detecting that upstream facts have changed, so **a cached answer is served until its TTL expires even if it is now wrong.**

**Open issues [V]:** There are 582 open issues ([issues](https://github.com/maximhq/bifrost/issues)). They are dominated by provider-conversion bugs such as Bedrock, Anthropic and Vertex streaming quirks. I found **no open issue or plugin for factuality, freshness or web grounding.** This is a gap, but it also means there is no demonstrated demand from Bifrost users **[A]**.

**Code Mode [V]:** Bifrost reports up to 92.8% fewer input tokens on its own benchmark ([code mode](https://docs.getbifrost.ai/mcp/code-mode)). This weakens a Problem 01 pitch, because Bifrost already owns the "token efficiency via the gateway" story.

---

## 3. Tavily technical research

All facts in this section are **[V]**.

**Search** ([docs](https://docs.tavily.com/documentation/api-reference/endpoint/search))
- Parameters:
  - `search_depth` (ultra-fast, fast, basic, advanced) and `topic` (general, news, finance)
  - **Time filters:** `time_range`, `start_date` and `end_date`, `include_published_date`, `filter_by_published_date`
  - **`max_age_hours`** (whether Tavily serves cached or live results), `include_domains` with a `prefer` mode, `exact_match`, `include_usage`
- Each result includes `published_date`. Tavily calls this its best estimate and marks it beta for some topics.
- **Why this matters:** Tavily natively exposes **time as a query dimension**, which is exactly what freshness verification needs.

**Extract** ([docs](https://docs.tavily.com/documentation/api-reference/endpoint/extract))
- Takes 1 to 20 URLs per call.
- Optional `query` reranks the extracted chunks (`chunks_per_source` 1 to 5).
- Failures are reported separately in `failed_results`, even on HTTP 200.

**Research** ([docs](https://docs.tavily.com/documentation/api-reference/endpoint/research))
- Runs asynchronously (returns 201 pending) or as an SSE stream.
- Supports `output_schema` for structured output and `mini`/`pro` models.
- Costs 4 to 110 credits on mini and 15 to 250 on pro. **Too expensive for per-claim use.** Reserve it for deep audits.

**Crawl and Map**
- Map costs 1 credit per 10 pages. Crawl costs map plus extract.
- Useful for auditing a whole knowledge base, which is a stretch feature, not core.

**Pricing** ([credits](https://docs.tavily.com/documentation/api-credits))
- Credit costs: basic search 1, advanced search 2, extract 1 per 5 URLs.
- Free tier: 1,000 credits per month.
- Paid plans: $30 for 4k credits; pay-as-you-go at $0.008 per credit.

**Rate limits** ([rate limits](https://docs.tavily.com/documentation/rate-limits))

| Endpoint | Dev key | Prod key |
|---|---|---|
| Search and Extract | 100 RPM | 1,000 RPM |
| Crawl | 100 RPM | 100 RPM |
| Research | 20 RPM | 20 RPM |

Error codes: 429 means rate limited and comes with `Retry-After`; 432 and 433 mean the plan or usage limit is exhausted.

**Cost model per verified response [A]**
- Assume we triage to about 3 time-sensitive claims, run 3 basic searches, then extract once.
- That is about 4 credits, or roughly 3 cents at the pay-as-you-go rate.
- **Triage is therefore a core economic requirement, not an optimisation.** Verifying every sentence of every response would be prohibitively expensive at gateway scale.

---

## 4. Market research

### Who has stale-answer pain, and how badly [A, informed by sources]

- **Any LLM app answering questions about the world.** Every model has a training cutoff, and its knowledge of fast-moving facts goes stale from that point on.
  - Research confirms the problem is measurable: FreshQA ([repo](https://github.com/freshllms/freshqa), updated weekly, last update April 2026 [V]), DyKnow, FreshBench and LLMLagBench ([arXiv 2511.12116](https://arxiv.org/abs/2511.12116)).
- **Answers change at different rates, and this is the most useful finding.** RecencyQA ([arXiv 2603.16544](https://arxiv.org/abs/2603.16544), March 2026 [V]) annotates 4,031 questions with *how often their answers change* and *whether that rate depends on context*.
  - It finds LLMs do worst on fast-changing, non-stationary questions.
  - Its critique is that existing benchmarks reduce validity to "current vs outdated," a binary choice. **This is the conceptual gap we would productise.**
- **RAG and support bots.** These pick up staleness from their own knowledge bases.
  - A secondary source reports outdated web content feeding AI misinformation about brands ([letsdatascience](https://letsdatascience.com/news/outdated-blogs-fuel-ai-hallucinations-and-harm-brands-952011a5)) **[S]**.
  - The Air Canada chatbot ruling is the well-known liability precedent for wrong bot answers **[S, widely reported]**.
- **Gateway and platform teams.** These teams run cached LLM traffic, and Bifrost's cache has no correctness signal, only a TTL [V].

### How often does it happen? [A]
For any app taking real-world questions, a meaningful share involves time-varying facts such as prices, office holders, versions, rankings, laws and schedules. **I found no reliable published estimate of what share of production LLM traffic is time-sensitive, and we should not invent one.** Our own evaluation (section 26) can measure it on a sample.

### What people use today
- Generic hallucination and groundedness detectors:
  - Cleanlab TLM: a trust score, not web-grounded **[S]**
  - Patronus Lynx
  - Galileo
  - Langfuse LLM-as-judge evaluators ([langfuse](https://langfuse.com/resources/engineering/hallucination-detection.md))
  - vLLM HaluGate: token-level groundedness at the router ([blog](https://vllm.ai/blog/2025-12-14-halugate))
- Open-source fact-checking pipelines:
  - Loki / OpenFactVerification, which uses Serper search ([review](https://www.themoonlight.io/review/loki-an-open-source-tool-for-fact-verification))
  - OpenFactCheck ([arXiv](https://arxiv.org/html/2408.11832v3))
  - SAFE, FActScore, FacTool, RARR
- Search vendors' DIY fact-checker cookbooks, e.g. Parallel plus Cerebras ([Parallel blog](https://parallel.ai/blog/cerebras-fact-checker), [OpenAI cookbook](https://developers.openai.com/cookbook/articles/gpt-oss/build-your-own-fact-checker-cerebras)).
- **Implication:** a generic "extract claims, search, judge true or false" pipeline is now a cookbook demo, not a product.

---

## 5. Competitor analysis (for the recommended direction)

| Product | What it does | Gap relative to our direction |
|---|---|---|
| Cleanlab TLM [S] | Uncertainty-based trust score per response | Not web-verified, no temporal model; a single score, not claim-level |
| Patronus (incl. in Bifrost guardrails) [V/S] | Hallucination and groundedness judge | Checks against the provided context, not current-world truth; no freshness |
| Langfuse / Phoenix / Braintrust evaluators [V/S] | Offline or sampled LLM-as-judge | Observability after the fact; no live web, no enforcement in the request path |
| vLLM HaluGate [V] | Token-level unsupported-claim detection in a router | Groundedness to context; ships with the vLLM router, not Bifrost; no web |
| Loki, OpenFactCheck, SAFE [V] | Claim decomposition plus search verification | Research tools; treat truth as timeless; no volatility model, no gateway, no cache coupling |
| Parallel/Exa fact-check cookbooks [V] | DIY pipelines | Demos, not infrastructure; same timeless assumption |
| Context7 (Upstash) [S] | Version-specific library docs for coding agents | Solves stale *code APIs* by retrieval at prompt time; does not detect stale output |
| Bifrost semantic cache [V] | Time-to-live caching | No signal that a cached fact has changed |

**Positioning [A]:** No tool we found does **(a)** *temporal* verification, meaning "was this true, is it still true, and when will it likely stop being true," **(b)** inside the gateway request path, and **(c)** feed that back into cache lifetime. Each piece exists somewhere, but nobody combines them.

---

## 6. Previous hackathon winner analysis

**Honesty note:** Searches turned up thin primary material on judges' reasoning.
- The one detailed winners list I read was UiPath AgentHack 2026 ([forum](https://forum.uipath.com/t/here-are-the-uipath-agenthack-2026-winners/5766658)): 1,400 builders, 333 submissions, 31 finalists [V].
- A Towards Data Science write-up of the Great Agent Hack 2025 returned 403 and was not read.

**Observed patterns [V from the UiPath list, interpretation A]**
- **Narrow, named, operational problems win**, as opposed to general assistants. Examples: FlakeWarden for flaky tests, SelfHeal QA, a "Pre-Flight Check for Enterprise AI Workflows," and a pharma quality watchtower.
- **Testing and reliability tooling is over-represented among winners.** Judges with engineering backgrounds reward things that make AI systems trustworthy.
- **Best Demo was judged on a live finale, not the video**, and the same team (InsureIQ) won its track. Live demo quality matters a lot.
- **Sponsor-native integration is rewarded**, for example a "Best Cross-Platform Integration" prize.
- "Chaos Monkey for agents" ideas already appear as hackathon entries (Saboteur on lablab.ai [V]). **Agent-reliability tooling is no longer novel as a category.**

**General patterns from experience [A, not sourced]**
1. A one-sentence problem the judge has felt personally.
2. A live, unscripted "before/after" moment.
3. Visible technical depth: a number the team measured, not a claim.
4. Sponsor tech used in a way the sponsor would want to show off.
5. Polish in the first 30 seconds.

---

## 7. Seventeen product opportunities

Each opportunity lists the Bifrost track it pairs with.

1. **Freshness layer for LLM traffic**, working name *Halflife* (04+06). A Bifrost plugin that detects time-sensitive claims in responses, estimates each claim's *half-life* (how long it is likely to stay true), verifies at-risk claims with Tavily's time filters, scores freshness, and can annotate, repair or block responses. It also drives semantic-cache TTL.
2. **Standalone stale-answer API plus a browser extension** (06, with Bifrost as plain routing). It checks ChatGPT and Claude answers in the browser.
3. **Freshness-aware semantic cache only** (04+06). Volatility-adaptive TTL and fact-change invalidation for Bifrost's cache.
4. **Stale-API detector for coding agents** (01+06). It flags generated code that uses deprecated or removed library APIs by checking current docs and changelogs (Tavily map and extract). The agent runs through Bifrost with budgets and local models.
5. **Temporal-robustness benchmark for agents** (02+06). Measures how agents handle facts that changed after their cutoff.
6. **Chaos proxy benchmark** (02). Uses the Bifrost mocker for fault injection across any framework, with Tavily as a tool target.
7. **Pentest agent with live CVE and exploit intel freshness** (03+06).
8. **Knowledge-base staleness auditor** (06+04). Crawls company docs and help centres with Tavily crawl and map, and flags statements contradicted by current sources.
9. **Vertical freshness guard for regulated answers** (06). Covers areas such as drug guidance, tax thresholds and interest rates, with authoritative-domain allowlists.
10. **System-prompt and few-shot fact linter** (04+06). Finds stale facts hard-coded in prompts, such as "the current CEO is…".
11. **Temporal-need router** (04+06). A `PreRequestHook` detects that a *question* needs post-cutoff knowledge and routes it to retrieval-augmented generation via Tavily, or to a newer model, *before* generation.
12. **Living answers / answer recall** (06+04). Previously served answers are re-verified on their half-life schedule, and the app is notified via webhook when one becomes false.
13. **Gateway cost-optimiser for research agents** (04+06). Chooses between Tavily depth levels and LLM size per query under a budget.
14. **MCP tool-result freshness and provenance plugin** (04). `PostMCPHook` stamps tool outputs with an as-of date and flags stale cached tool data.
15. **Course and textbook content freshness checker** (06). Aimed at educators.
16. **Bifrost traffic record, replay and diff tool** (04/02). Replays logged traffic against new models and diffs the answers.
17. **Brand-truth monitor** (06). Tracks what LLMs say about a company and which of those facts are outdated. It sits next to the "generative engine optimisation" tool market; competitors were not verified.

---

## 8. Weighted evaluation matrix

**Weights and rationale [A]**

| Weight | Dimension | Why |
|---|---|---|
| 20% | **Innovation** | First judging criterion; also where cookbook fact-checkers fail |
| 15% | **Problem significance and impact** | Judging criterion |
| 15% | **Feasibility in 13 days with high polish** | Covers Technical execution; an unfinished project loses |
| 10% | **AI necessity** | "Use of AI" criterion: is AI doing irreplaceable work? |
| 15% | **Demo and UX potential** | "User experience" criterion; live finales decide winners |
| 10% | **Scalability and production potential** | Judging criterion |
| 7.5% | **Bifrost integration quality** | Explicitly required to be meaningful |
| 7.5% | **Tavily integration quality** | Explicitly required to be meaningful |

**Scores (1 to 5) [A]**

| # | Idea | Innov | Impact | Feas | AI | Demo | Scale | Bifrost | Tavily | **Weighted** |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Halflife freshness layer | 5 | 4 | 4 | 5 | 4 | 5 | 5 | 5 | **4.55** |
| 11 | Temporal-need router | 4 | 4 | 4 | 4 | 3 | 4 | 5 | 4 | 3.93 |
| 12 | Living answers | 5 | 3 | 3 | 4 | 4 | 4 | 3 | 5 | 3.90 |
| 4 | Stale-API detector (coding) | 4 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | 3.85 |
| 3 | Freshness cache only | 4 | 3 | 4 | 3 | 3 | 4 | 5 | 4 | 3.65 |
| 8 | KB staleness auditor | 3 | 4 | 4 | 4 | 4 | 4 | 2 | 5 | 3.70 |
| 14 | MCP tool freshness | 4 | 3 | 4 | 3 | 2 | 4 | 5 | 3 | 3.43 |
| 17 | Brand-truth monitor | 3 | 4 | 4 | 4 | 4 | 4 | 2 | 4 | 3.63 |
| 9 | Vertical regulated guard | 3 | 5 | 3 | 4 | 3 | 3 | 2 | 4 | 3.38 |
| 10 | Prompt fact linter | 4 | 2 | 5 | 3 | 3 | 3 | 4 | 4 | 3.48 |
| 5 | Temporal agent benchmark | 4 | 3 | 3 | 3 | 3 | 3 | 4 | 4 | 3.33 |
| 2 | Browser-extension checker | 2 | 3 | 4 | 4 | 4 | 3 | 1 | 4 | 3.08 |
| 6 | Chaos proxy benchmark | 2 | 4 | 3 | 2 | 3 | 4 | 4 | 2 | 2.95 |
| 13 | Research cost optimiser | 3 | 3 | 3 | 3 | 2 | 3 | 4 | 4 | 3.00 |
| 16 | Replay and diff | 3 | 3 | 4 | 2 | 3 | 3 | 4 | 1 | 2.98 |
| 7 | Pentest + CVE freshness | 3 | 4 | 2 | 4 | 4 | 3 | 3 | 2 | 3.15 |
| 15 | Course freshness | 2 | 3 | 4 | 4 | 3 | 2 | 1 | 4 | 2.85 |

These scores are judgement calls, not measurements. The ranking is only robust where the gaps are large.

---

## 9. Elimination of weaker candidates

| Idea | Reason eliminated |
|---|---|
| 2, 15 | A thin wrapper; Bifrost is decorative, failing the "meaningful contribution" test. |
| 6, 5, 16 | Category is crowded: Langfuse, Braintrust, LangSmith, inspect_ai, AgentChaos, ReliabilityBench ([arXiv 2601.06112](https://arxiv.org/pdf/2601.06112)), and hackathon "chaos monkey" entries already exist. Tavily would be shoehorned in. |
| 7 | Blocked on organiser lab access, and a scope violation is catastrophic. Weak Tavily role, since the lab cannot touch public systems while CVE lookups are public. |
| 9, 15, 17 | Vertical or go-to-market bets with weak Bifrost roles. They fit better as **demo scenarios** for #1 than as products. |
| 3, 10, 14, 11, 12 | Strong but **partial**. Each is a natural *feature* of #1, so they are folded into it as scope options rather than competing. |
| 13 | Low demo value; an optimisation, not a product. |

The real contest is between **#1 Halflife**, **#4 Stale-API detector** and **#8 KB staleness auditor**.

---

## 10. Top three opportunities

1. **Halflife.** A gateway-native freshness layer: detect, estimate half-life, verify, score, then act (annotate, repair, set cache TTL). Pairs Problems 04 and 06.
2. **Stale-API detector for coding agents.** Detects deprecated APIs in generated diffs against live docs, inside a budgeted, approval-gated coding agent. Pairs Problems 01 and 06.
3. **Knowledge-base staleness auditor.** Crawls a docs site and flags outdated statements with evidence. Pairs Problem 06 with Bifrost as routing and budget layer.

---

## 11. Detailed comparison of the finalists

| | Halflife (04+06) | Stale-API coding agent (01+06) | KB auditor (06) |
|---|---|---|---|
| Satisfies both tracks natively | **Yes.** The Tavily problem *is* the Bifrost feature. | Partly. 01's four mandatory items (outages, spend, local repos, approvals) are a large surface unrelated to freshness. | Weak on Bifrost: routing and budgets only. |
| Mandatory-requirement load | Moderate. 06 has four items; 04 needs tests, docs and upstream readiness. | **Heavy.** A full coding agent plus four 01 constraints plus 06. | Light. |
| Direct competitor strength | Weak to moderate. Fact-checkers exist, but none are temporal and gateway-native. | **Strong.** Context7 already attacks stale APIs at retrieval time, and coding agents are a crowded space with 160k-star incumbents. | Moderate. Docs-quality tools and GEO tools exist. |
| Innovation story | "Facts have half-lives" is a new primitive, the gateway enforces it, and the cache uses it. | Detecting deprecated APIs after generation is useful but incremental. | Familiar. |
| Demo | Same prompt through raw Bifrost vs Halflife; live claim-level timeline; cache expires itself early because a fact is volatile. | Agent writes code, flags a deprecated call, fixes it. Good, but slow to demo live. | Crawl animation and a list of stale pages. Static. |
| Scalability | Infrastructure: every request through a gateway, policy per virtual key, upstream to a 9k-star project. | A developer tool. | A SaaS audit tool. |
| Feasibility risk | Go plugin builds; latency budget; Tavily `published_date` quality. | Agent reliability across real repos; the long tail of local models. | Low. |

**Verdict:** Halflife wins on innovation, on how naturally it fits both tracks, and on scalability. The stale-API idea is reused as a **demo scenario**: Halflife flags "the latest version of library X is…" claims in ordinary chat answers.

---

## 12. Final recommendation

**Build Halflife: a freshness layer for LLM traffic, delivered as a Bifrost plugin plus a verification engine and an operator console.**

The pitch in one sentence: *Every fact an LLM states has a half-life. Halflife sits in your AI gateway, spots the claims that are likely to have expired, checks them against the live web, and stops stale answers before your users see them, with no change to application code.*

---

## 13. Why it deserves to win [A]

**Innovation**
- It moves from "is this true?" to **"is this still true, and for how long?"**
- The temporal model is grounded in current research (RecencyQA, FreshQA, DyKnow). Existing products treat truth as timeless.

**Technical execution**
- A real Go plugin on documented Bifrost hooks, with the upstream contributor bar (tests, benchmarks, latency budget, metrics).
- A measured evaluation on public freshness datasets.

**Impact**
- Every LLM product with real-world questions has this problem.
- The gateway placement means one deployment protects every app behind it.

**Use of AI**
- AI is necessary at each stage: claim decomposition, temporal and volatility classification, evidence-conditioned verdicts with supersession detection ("X was CEO, but Y has been since March"), and grounded repair.
- Tavily's time-filtered search is the live-truth backbone.

**User experience**
- A console that makes an invisible risk visible: claim timelines, evidence with dates, a freshness score with a breakdown.

**Scalability**
- Policy per virtual key, triage-first cost control, async mode, and cache coupling.
- A credible upstream contribution.

---

## 14. Why existing products do not already solve this

1. **Groundedness tools check against provided context, not the live world.** Patronus, HaluGate and RAG evaluators work this way. A response can be perfectly grounded in a stale document.
2. **Uncertainty scores do not catch confident staleness.** Cleanlab TLM is an example: a model can be highly confident about a fact that was true at its cutoff. **[A]**
3. **Web fact-checkers are timeless and offline.** Loki, OpenFactCheck, SAFE and the cookbooks have no notion of volatility, as-of dates or supersession. They are not in the request path and are not cost-triaged.
4. **Bifrost's own cache and guardrails have no freshness signal** [V].
5. **I found no product that combines these.** That is evidence of a gap, but not proof. A stealth or enterprise feature could exist that I did not find.

---

## 15. Target users

- **Primary: platform and AI-infrastructure engineers** running Bifrost or another gateway for multiple internal LLM apps. They want a policy they can switch on centrally.
- **Secondary: product teams** shipping answer-bots in time-sensitive domains such as fintech, travel, e-commerce, developer tools and news. They call the `/check` API directly or through the gateway.
- **Tertiary: AI quality and eval teams** that want freshness metrics on sampled traffic.

---

## 16. Core value proposition

Halflife catches answers that *used to be* true. It is a drop-in feature of your gateway that tells you, per claim, how likely it is to have expired, what the web says now, and as of when. It can fix the answer automatically, and it costs a few Tavily credits only on the claims that actually need checking.

---

## 17. Product differentiation

1. **Claim half-life model.** Each claim is classified by:
   - temporal type: static, slow-changing, fast-changing, real-time, or event-anchored
   - expected change interval
   - stationarity

   Combined with the generating model's knowledge cutoff (from Bifrost's model catalog where available, otherwise a maintained table), this yields a **prior staleness risk** *before* any search.
2. **Triage-first verification.** Only claims whose risk crosses a policy threshold are sent to Tavily. This is the token and credit efficiency story, and we can measure it as credits saved against verifying everything.
3. **Time-aware evidence.** Searches use Tavily's `start_date`, `time_range` and `include_published_date`, and verdicts reason over *dated* evidence. Possible verdicts:
   - current
   - superseded (with the new value and the date of change)
   - unverifiable
   - contradicted
4. **Gateway-native actions per virtual key:**
   - `annotate`: response headers plus a report ID
   - `repair`: regenerate with evidence and citations, through Bifrost so fallbacks and budgets apply
   - `warn`: append a notice
   - `block`
5. **Freshness-aware caching.** Cache TTL is capped at the shortest half-life among the response's claims. Volatile answers expire in minutes, static answers last hours.
6. **(Stretch) Living answers.** At-risk served answers are re-verified on their half-life schedule, and a webhook fires when one flips.

---

## 18. Proposed user experience

**Operator console** (a single web app, served from the plugin's own routes or alongside it)

1. **Live traffic stream.** Each response appears as a row with a freshness score ring and a count of risky claims. Filters: virtual key, verdict, model.
2. **Response inspector (the hero screen).**
   - The answer text with claims highlighted in place, coloured by verdict.
   - Clicking a claim opens a panel with:
     - its temporal type and estimated half-life
     - **a timeline**: model cutoff, evidence publication dates, the date the fact changed, and today
     - evidence cards: source, date, quoted passage
     - the reasoning trace
   - A "Repaired answer" diff view.
3. **Playground.** Paste any LLM output, or send a prompt through Bifrost to a chosen model (for example an older-cutoff model), and watch the pipeline stream stage by stage: extract, classify, triage, search, verdict, score.
4. **Policy page.** Per-virtual-key mode (annotate, repair, warn, block), risk threshold, credit budget per day, allowed and preferred domains, and the local-model-only option for confidential traffic.
5. **Metrics.** Share of traffic that is time-sensitive, stale rate by model, credits spent vs saved by triage, and added latency at p50 and p95.

**Design direction [A]**
- An editorial, instrument-like look: monospace dates, a restrained palette, and colour reserved for verdict semantics.
- Timelines as the signature visual, which is what makes the product memorable.
- No chat-bubble UI.
- Explicit loading, empty and error states, for example "Tavily rate-limited, retrying in 4s" and "Claim unverifiable: no dated evidence".

**Developer experience**
- Enable it with a `config.json` entry.
- Per-request opt-in with `x-halflife-mode: verify`.
- Response headers: `x-halflife-score`, `x-halflife-report`.
- `POST /halflife/v1/check {text, model?, as_of?}` for apps outside the gateway.

---

## 19. Technical feasibility

**Known and feasible [V and A]**
- The hook points we need exist:
  - `PostLLMHook` for response inspection and rewriting
  - `PreLLMHook` for cache and route hints
  - HTTP transport hooks to expose API routes
- Tavily covers time-filtered search and extraction.
- Bifrost routes our own LLM calls, which can be local through Ollama.

**Must be verified in a day-1 spike [A, unverified]**
1. Building a custom-plugin Bifrost on WSL2 or Docker (Go `.so` does not work on Windows). The alternative is an in-tree plugin in a fork, registered in the HTTP transport. That is also the upstream-contribution form.
2. Whether a plugin can influence the semantic cache's TTL at write time. Options are a context value or header set before `semanticcache`'s post-hook runs, and the hook ordering needs checking. If not possible, fall back to calling the cache's clear-by-ID API once a volatile entry is detected.
3. Whether `HTTPTransportPreHook` short-circuiting is a clean way to serve `/halflife/*` routes. Fallback: a small sidecar HTTP server started in `Init`.
4. Streaming responses: verify after stream completion (`PostLLMHook` on the final chunk, or `StreamChunkHook` accumulation), and annotate via a trailing chunk or report ID. **Repair is not possible on streams; this is a documented limitation.**

**Latency [A]**
- Full verification takes seconds: an LLM pass plus Tavily round-trips.
- Because the upstream bar is about 10 ms of added latency, the **default mode is async**. The response passes through immediately with a report ID, and verification runs in a bounded worker pool.
- Synchronous `verify` and `repair` are opt-in per key or request, for high-stakes paths.
- The inline cost of async mode is just a heuristic pre-filter (regex and temporal-marker scan) plus an enqueue, which should fit within milliseconds. **We will benchmark this.**

---

## 20. Proposed architecture

```
Client app ──► Bifrost (bifrost-http)
                 │  PreLLMHook:  attach policy (from virtual key), opt-in headers
                 │  ── provider call (fallbacks, budgets, keys: native Bifrost) ──
                 │  PostLLMHook: fast pre-filter → enqueue job → set headers
                 │               (sync mode: run pipeline inline, may repair)
                 │  HTTPTransportPreHook: serves /halflife/* (API + console)
                 ▼
        Halflife engine (Go, inside the plugin module)
          1. Claim extraction ─────► LLM via Bifrost (small/fast model, or Ollama for confidential keys)
          2. Temporal classifier ──► same call (structured output): type, half-life, as-of hints
          3. Risk prior = f(half-life, model cutoff, elapsed time, hedges)
          4. Triage under credit budget
          5. Evidence: Tavily Search (time filters, published dates) → optional Extract on top URLs
          6. Verdict + supersession ─► LLM via Bifrost, evidence-conditioned, cites passages
          7. Freshness score (claim → response aggregation), cache-TTL hint
          8. Action: annotate / repair (regenerate via Bifrost with evidence) / warn / block
        Store: SQLite (reports, claims, evidence, verdicts); evidence cache keyed by normalised claim+date window
        Console: React/Vite SPA embedded with go:embed
```

**Technology choices [A]**
- **Go:** required by Bifrost plugins, and it keeps one deployable.
- **SQLite:** zero operations work; the framework logstore can come later.
- **React + Vite SPA:** a static console embedded in the binary, so there is no second server.
- **One extraction-and-classification LLM call per response,** with structured JSON output, to keep tokens low.
- **Verdicts** are batched per claim group.

**Freshness score [A, to be refined]**
- Claim score = (1 − staleness risk) for unverified claims, or a verdict-based value (current ≈ 1, superseded ≈ 0, unverifiable discounted by risk), weighted by the claim's importance in the answer.
- The response score takes the minimum over critical claims, blended with a weighted mean.
- The formula is fully explained in the UI, with no black-box number.

**Security [A]**
- Tavily and provider keys live only in Bifrost config or env.
- Confidential virtual keys force local-model classification and a "no external search" option. In that mode only claim text could leave the network, and the mode must be explicit.
- Prompt-injection risk from web evidence is mitigated by treating evidence as quoted data in the verdict prompt and by schema-constrained output.

---

## 21. Bifrost integration strategy

Bifrost usage is substantive in both directions:

1. **As the host:** a production-grade plugin using `PreLLMHook`, `PostLLMHook` and HTTP transport hooks, written to the upstream contributor bar (tests, benchmarks, README, config schema, metrics), packaged under `plugins/halflife`.
2. **As the engine's own LLM layer:** every LLM call Halflife makes goes back through Bifrost. That gives:
   - fallbacks during provider outages
   - its own budget-capped virtual key, so verification can never overspend
   - Ollama routing for confidential keys
3. **Coupled with native features:** policy is set per virtual key, the semantic cache gets TTL hints, and metrics go to the telemetry and Prometheus pipeline.
4. **Upstream path:** open a discussion or issue with maximhq proposing "freshness-aware caching / factual freshness plugin" before submission. The demo uses a fork with reproducible Docker build instructions.

---

## 22. Tavily integration strategy

- **Search is the core verification primitive.** Each triaged claim gets one or two generated queries with:
  - `topic` chosen by claim type (news, finance or general)
  - `start_date` set to the model's cutoff, which asks "has anything changed since the model learned this?"
  - `include_published_date`
  - `max_age_hours` tuned to the claim's half-life (live for real-time claims, cached results acceptable for slow ones)
  - `include_domains` with `prefer` for authoritative sources when policy defines them
- **Extract on demand.** When snippets are inconclusive, extract the top two or three URLs with `query` set to the claim, for passage-level evidence.
- **Research is reserved for "deep audit"** of a single report, opt-in and budgeted.
- **Credit governance:**
  - a per-key daily credit budget
  - an evidence cache: the same normalised claim within its half-life window costs 0 credits
  - `include_usage` to account for actual spend
  - 429/432 handling with `Retry-After` and a graceful "unverified, budget exhausted" verdict
- **Plan need [A]:** the free 1,000 credits allow roughly 250 verified responses at about 4 credits each. That is enough for development but tight for evaluation and demos. **We will likely need a paid or sponsor-provided key.**

---

## 23. Initial feature scope

**Must have (MVP, required to submit)**
1. Claim extraction plus temporal classification (half-life and type) in one structured call.
2. Risk prior with model-cutoff awareness, and triage under a budget.
3. Tavily time-aware verification with dated evidence; verdicts current, superseded, contradicted or unverifiable.
4. Freshness scoring at claim and response level, with an explanation.
5. Bifrost plugin with async annotate mode plus sync verify and repair modes; headers and report IDs.
6. `/check` API.
7. Console: playground, response inspector with timeline, report list.
8. Tests: unit, integration against a real Bifrost, concurrency; latency benchmark; README and config docs.
9. Evaluation harness on FreshQA plus a held-out labelled set; published numbers.

**Should have**
- Freshness-aware cache TTL.
- Per-virtual-key policy UI.
- Local-model mode.
- Metrics page.

**Could have (only if ahead of schedule)**
- Living-answer re-verification with webhooks.
- `PreRequestHook` temporal-need router.

**Won't have**
- Browser extension, multi-tenant SaaS, auth beyond Bifrost's own, or crawling whole knowledge bases.

---

## 24. Main technical risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Go plugin build or version-lock friction; Windows host | High | Day-1 spike in Docker or WSL2; prefer an in-tree plugin in a pinned fork |
| Hook semantics (cache TTL coupling, route serving) differ from docs | Medium | Spike on day 1–2; fallbacks defined in §19 |
| Tavily `published_date` missing or inaccurate (beta) | Medium | Treat missing dates as weaker evidence; fall back to dates extracted from page text; reflect this in confidence |
| LLM verdict errors (false "superseded") | Medium | Evidence-quote requirement, an abstain option, an evaluation harness, a conservative default threshold |
| Latency in sync mode | High (by nature) | Async default; parallel searches; a stated latency budget per mode |
| Credit exhaustion during demo | Medium | Evidence cache, budget caps, a clearly labelled **recorded demo fixture** as backup |
| Judges see it as "just a fact-checker" | Medium | Lead with the half-life and timeline concept plus the gateway and cache story; show triage savings numerically |
| Scope creep | High | Feature freeze on Nov 12 |

---

## 25. Development timeline (Nov 2 to 15)

| Dates | Work |
|---|---|
| **Nov 2–3** | Spike: build Bifrost from source in Docker/WSL2, register a hello-world plugin, prove `PostLLMHook` rewrite, route serving and cache TTL influence. Get API keys. Freeze architecture. |
| **Nov 4–5** | Engine core in Go: extraction and classification prompt with schema, risk prior, Tavily client (retry, budget, cache), verdict prompt, scoring. Unit tests. |
| **Nov 6** | Plugin wiring: async queue, sync and repair modes, headers, `/check` API, SQLite store. Integration test against a real Bifrost. |
| **Nov 7–8** | Evaluation harness: FreshQA plus a labelled set of about 100 answers from an older-cutoff model. Measure precision and recall of stale detection, triage savings, latency. Iterate prompts. |
| **Nov 9–11** | Console: design system, playground with streamed stages, inspector with timeline, reports, policy, metrics. Empty, loading and error states. |
| **Nov 12** | Cache TTL coupling, local-model mode. **Feature freeze.** |
| **Nov 13** | Hardening: concurrency tests, benchmarks, failure paths (Tavily 429/432, provider outage through fallbacks), security review. |
| **Nov 14** | Docs (README, architecture, upstream proposal), Docker compose for one-command reproduction, demo video. |
| **Nov 15** | Buffer and submission. |

---

## 26. Testing and validation strategy

**Unit tests**
- Scoring math, risk prior, triage budget, Tavily client retry and backoff and 432 handling (mock HTTP), schema validation of LLM output.
- Target more than 90% coverage on the plugin package, per the upstream guide.

**Integration tests**
- A real Bifrost with the mocker plugin or Ollama as the provider, plus recorded Tavily responses.
- Separately, a small live smoke test gated behind an env var.

**Concurrency and performance**
- Go race detector.
- Benchmark of added latency in async mode, published as p50/p95.

**Quality evaluation (the credibility centrepiece)**
- Datasets:
  - **FreshQA** fast-changing and slow-changing questions, answered by an older-cutoff model and by a newer one
  - a hand-labelled set
  - RecencyQA labels to validate the volatility classifier
- Metrics:
  - stale-claim detection precision and recall
  - verdict accuracy
  - **credits per response with and without triage**
  - repair success rate

  These are published in the README and shown in the console.
- **Honesty rule:** no results are hard-coded. Any fixtures are labelled "recorded."

---

## 27. Demonstration strategy

A three-minute arc [A]:

1. **Hook (20 s).** "Ask any model who leads company X, or what the latest version of framework Y is. It answers confidently, from the world as it was at its cutoff."
2. **Before (30 s).** An unmodified app sends a prompt through Bifrost to a model. The stale answer is served and then cached for 5 minutes.
3. **Turn on Halflife (one config line) (60 s).** The same request now goes through Halflife:
   - the inspector lights up claims
   - the timeline shows "model cutoff → fact changed on [date] (source, quote) → today"
   - verdict: superseded
   - the repaired answer streams in with citations
   - a "Live" badge shows these are real Tavily calls
4. **Infrastructure depth (45 s).**
   - The policy differs per virtual key.
   - A confidential key runs classification on local Ollama.
   - The cache TTL shrinks automatically for a volatile answer.
   - A provider outage is simulated and fallback keeps verification running.
   - The credit meter shows triage skipped most claims.
5. **Proof (25 s).** Evaluation numbers on FreshQA, latency benchmark, test count, and the upstream proposal link.

**Backup:** a clearly labelled recorded run, in case of network failure during a live judging session.

---

## Information needed from the operator before building

1. **Development environment:** confirm WSL2 or Docker Desktop is available on this Windows machine. Go plugins cannot run natively on Windows.
2. **API keys:**
   - a Tavily key (and whether the hackathon provides credits beyond the 1,000 free ones)
   - at least one LLM provider key (preferably two, to demonstrate fallback)
   - whether Ollama can run locally
3. **Official problem-statement page:** a link to the official Problem 04 and 06 wording and judging rubric, to confirm our reading.

## Sources

- Bifrost: [repo](https://github.com/maximhq/bifrost) · [docs overview](https://docs.getbifrost.ai/overview) · [writing plugins](https://docs.getbifrost.ai/plugins/writing-plugin) · [plugins getting started](https://docs.getbifrost.ai/plugins/getting-started) · [semantic caching](https://docs.getbifrost.ai/features/semantic-caching) · [guardrails](https://docs.getbifrost.ai/enterprise/guardrails) · [code mode](https://docs.getbifrost.ai/mcp/code-mode) · [plugin contributing guide](https://www.getmaxim.ai/docs/bifrost/contributing/plugin.md) · [issues](https://github.com/maximhq/bifrost/issues) · [plugins dir](https://github.com/maximhq/bifrost/tree/main/plugins)
- Tavily: [search](https://docs.tavily.com/documentation/api-reference/endpoint/search) · [extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) · [research](https://docs.tavily.com/documentation/api-reference/endpoint/research) · [credits](https://docs.tavily.com/documentation/api-credits) · [rate limits](https://docs.tavily.com/documentation/rate-limits)
- Research: [RecencyQA arXiv 2603.16544](https://arxiv.org/abs/2603.16544) · [LLMLagBench 2511.12116](https://arxiv.org/abs/2511.12116) · [DyKnow](https://arxiv.org/html/2404.08700v3) · [FreshQA](https://github.com/freshllms/freshqa) · [OpenFactCheck](https://arxiv.org/html/2408.11832v3) · [Loki](https://www.themoonlight.io/review/loki-an-open-source-tool-for-fact-verification) · [ReliabilityBench](https://arxiv.org/pdf/2601.06112)
- Market and competitors: [Cleanlab TLM](https://cleanlab.ai/blog/trustworthy-language-model) · [Langfuse hallucination eval](https://langfuse.com/resources/engineering/hallucination-detection.md) · [vLLM HaluGate](https://vllm.ai/blog/2025-12-14-halugate) · [Parallel fact-checker](https://parallel.ai/blog/cerebras-fact-checker) · [OpenAI cookbook fact-checker](https://developers.openai.com/cookbook/articles/gpt-oss/build-your-own-fact-checker-cerebras) · [Context7 guide](https://mcp.directory/blog/context7-mcp-complete-guide-2026) · [AgentChaos write-up](https://www.developersdigest.tech/blog/agentchaos-fault-injection-agent-robustness) · [Saboteur (lablab)](https://lablab.ai/submissions/o1obck4y3zzcr7kuq6eq6n2j) · [coding agent comparison](https://insiderllm.com/guides/local-alternatives-claude-code-2026/) · [outdated content and brands](https://letsdatascience.com/news/outdated-blogs-fuel-ai-hallucinations-and-harm-brands-952011a5)
- Hackathons: [UiPath AgentHack 2026 winners](https://forum.uipath.com/t/here-are-the-uipath-agenthack-2026-winners/5766658)
