# Halflife: Project State

_Last updated: 2026-11-02 (session 9: published on GitHub). The persistent source of truth: a fresh session reads this file, then `NEXT_SESSION.md`._

## Repository (sessions 6–9)

- **Public repository: <https://github.com/fazeprism25/halflife>** (published 2026-11-02, session 9). Branch `main`, tracking `origin/main`.
  - History: the parentless root commit `f42d3bf` "Initial public release: Halflife freshness verification platform", then record updates. The pre-release commits were replaced (session 8); the old history is backed up privately outside the repository and pruned from it.
  - Commit identity: repository-local `user.email` is the account's GitHub noreply address (`<id>+<login>@users.noreply.github.com`); global git config unchanged. Commit timestamps are written in UTC (`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` with `+0000`).
  - **Not deployed; the hackathon entry is not submitted** (the operator submits separately).
- **Licence: Apache-2.0** (operator-approved). `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md` are added. The provenance audit found no blocking issue (AD-31).
- Contents and exclusions: AD-29, amended by AD-31.
  - Withdrawn from version control in session 7 (kept on disk): the original screenshots, and the FreshQA-derived verbatim files (set, raw runs, `latest-freshqa.md`).
  - Sanitised screenshots are in `docs/assets/screenshots/`.
- **History:** resolved (AD-31). The published history contains only the sanitised tree.
- **Pre-publication audit (session 9):** 119 files; secret scan 0 values (7 known placeholders); no private paths tracked; LICENSE (official text), NOTICE, THIRD_PARTY_NOTICES and the 7 sanitised screenshots present; links OK; engine 54/54; no personal email, local path or zone in tracked text or commit metadata. GitHub detects Apache-2.0 and renders the README.
- Documentation: `README.md` (rewritten), `docs/ARCHITECTURE.md`, `docs/INSTALLATION.md`, `docs/DEVELOPMENT.md`, `docs/SECURITY.md`, `docs/EVALUATION.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `research/README.md`, `experiments/README.md`.
- Pre-commit checks (session 6): engine 54/54, Go plugin 21/21 with `-race` (0 races; hooks 42 µs/op, triage 30 µs/op), FreshQA scorer reproduces `latest-freshqa.md`, secret scan of staged files 0 hits, clean export of the staged tree passes setup + engine tests + link check. Integration suite **not** re-run this session (no code changes since its 13/13 pass in session 5).

## Objective

Halflife is a freshness intelligence layer for LLM applications. Its premise: every factual claim has a different expiration rate, and AI systems should know when to verify it again.

- **Bifrost Problem 04:** a production-quality extension using supported extension points (a Go `.so` plugin plus Relays).
- **Tavily Problem 06:** find stale factual claims in LLM output, verify them against current information, and give claim-level freshness assessments.

## Hackathon

- Geek Room Global AI Hackathon 2026.
- **Submission deadline: 2026-11-15.** Judging: 2026-11-29.
- Both technologies must contribute meaningfully. Six judging criteria, assumed equally weighted.
- The official problem-statement wording has not been confirmed from a public page (research report §1).

## Implementation status

| Area | Status | Evidence |
|---|---|---|
| Bifrost plugin (`plugin/`) | **Done, v0.1.0** | 21 Go tests pass with `-race` (re-run session 5, 0 races); 43 µs/request across all hooks (57 µs session 2) |
| Claim extraction and classification | **Done.** LLM path with validation, plus a labelled heuristic fallback | engine tests |
| Freshness model (A/B/C, learning) | **Done.** Gamma–Poisson grid, reuse window, ordinal evidence rules | engine tests check the grid against analytic Lomax for all 18 classes |
| Tavily verification | **Done, live-verified** (T0/T1/T2, quote verification, value grounding AD-20) | real Tavily via relay: 63 credits this session |
| Evidence storage | **Done** (`node:sqlite`) | |
| Claim-level reporting and API | **Done** (`/v1/check`, `/v1/reports`, `/v1/classes`, `/v1/status`, SSE) | |
| Cache policy | **Done:** TTL caps, no-store, invalidate stale, expire at reuse window | integration: a real Bifrost cache entry was invalidated |
| Background verification | **Done** (bounded queue, concurrency, job budget, restart recovery) | |
| Relay governance | **Done:** Tavily metered per credit; 402 at budget exhaustion; engine API VK-gated | integration |
| Console | **Done, audited with real data (session 5):** 7 correctness fixes (AD-27): weak-evidence labels, honest headlines, no fake invalidations for no-store, timestamps with zone, reused counts, guard panel | headless Edge screenshots; `deploy/demo/backup/` |
| Deployment | **Done:** `setup.mjs` plus compose; config rendered from the keys present | integration suite builds from scratch |
| Hosted LLM: **DeepSeek via Bifrost's native provider** | **Live-verified** (AD-17). Judge `deepseek/deepseek-flash`, thinking off | `live-deepseek.json` 6/6; about 3.5k tokens per checked claim |
| **Tavily free-allowance guard** | **Done** (AD-19): engine `CreditGuard` plus script `spend-guard.mjs`; ceiling 800 of 1000, 200 reserved | 10 unit tests; ledger `deploy/test/results/spend-ledger.jsonl` |
| Tests | **54 engine, 21 plugin (`-race`), 13 integration: all pass** (session 5) | `deploy/test/results/integration.json`, `plugin-test-2026-11-02.log` |
| **Real LLM + Tavily run** | **DONE** (session 4): live scripts, gateway end to end with 5 prompt types, cache policy live | `deploy/test/results/live-*.json` |
| Tavily MCP (dev tooling) | **Decided: not connected** (AD-18) | duplicates WebSearch/WebFetch/curl plus the scripted API probes |
| Evaluation harness | **v1/v2 + FreshQA done** (AD-28): detection 100 items (assess-only), verification 59 items with hand adjudication. Calibration not done | `eval/results/latest-freshqa.md` |
| Demo | **Script + runner + backup transcript and stills done.** Video NOT recorded | `research/DEMO_SCRIPT.md`, `deploy/demo/` |
| Submission write-up | **Draft done**, not submitted | `research/SUBMISSION.md` |

## Measured results (live, 2026-11-02)

**FreshQA (session 5; `eval/results/latest-freshqa.md`)**
- **Detection** (100 items, assess-only, 0 credits): precision 85.5%, recall 97.9%, F1 0.91.
  - FN 1: "most recent award … (2025)" was classified historical.
  - FP 8: never-changing questions such as "capital of Massachusetts". These cost a search, not a wrong verdict.
  - No claim extracted for 7, mostly yes/no answers.
- **Verification** (29 B known-stale + 30 C snapshot-current; ≥ moderate evidence):
  - Stale precision 95.8% (worst case 92.0%).
  - Recall 95.8% of decided, 79.3% of all B.
  - Coverage 83% (B) and 70% (C).
  - Including weak evidence: precision 96.3% (worst case 83.9%), recall 89.7% of all B.
- **8 changes after the snapshot were caught**, each confirmed by independent web search: the 2026 NBA (Knicks) and NHL (Hurricanes) champions, Miss World 2026, Starmer → Burnham, the IJCAI 2026 venue, Haaland's UCL goals, Patch Tuesday, the Premier League leader.
- **Judge errors found:**
  - C-434, a future date treated as past. Now discarded in code (AD-25).
  - B-229, a count read as "at least one" (FN).
- **Replacement values (26):** 10 match the dataset, 7 confirmed later changes, 2 wrong, 1 unadjudicated, 6 omitted.
- **Cost:** 59 credits (1.04 per searched claim), about 4.5k tokens per checked claim, p50 3.9 s, p95 7.9 s.

**Earlier sets**
- **v1, 40 items:** 36 decided, all correct; saturated, because the set is easy.
- **v2, 15 hard items:** found AD-20 and AD-21, both fixed.

**Spend**
- **Tavily:** 129 of 1000 credits. That is 128 by the engine (62 in session 4, about 66 in session 5) plus 1 direct call. Ceiling 800; pay-as-you-go 0.
  - Tavily's own counter read 0–3 all day: it lags hours, not minutes.
- **DeepSeek:** balance $5.89 → $5.82, so about $0.07 actual. Dev budget $1.

## Known limitations

- **Static claims are not checked:** Halflife detects staleness, not factual errors in time-invariant claims (AD-21).
- **P(outdated) is uncalibrated.** FreshQA measured detection and verification, not calibration.
- **Replacement values are weaker than verdicts:** 2 of 26 were wrong in FreshQA. Token grounding can't tell "up to Node.js 26" from "latest is 26" (AD-20).
- **The judge can make date or quantity reasoning errors.** The future-change guard covers one class (AD-25); the count error (B-229) is not covered.
- **Tavily `published_date` is unreliable** for evergreen and SEO pages. The `/usage` counter lags by hours and returns 429s; the guard counts locally (AD-19).
- **Learning:**
  - Eval traffic now sends `learn:false`; the 79 past eval observations were removed (AD-23).
  - Repeated demo prompts can still add near-duplicate observations.
- **Streams:** the TTL is decided from the prompt only; verification is async only.
- **DeepSeek:**
  - Its cutoff is unpublished, so the as-of range is wide (6–36 months).
  - Thinking is on by default: a client that omits `thinking: disabled` with a small `max_tokens` can get empty content. Halflife reports this as `skipped; no-text`.
  - It's unverified whether the Bifrost VK dollar budget meters DeepSeek.
- **Bifrost UI** is a stub page (the UI build is skipped).
- **Single-node engine with SQLite;** not load-tested.
- **Compose takes provider keys from the shell environment before `deploy/.env`.** This machine has `DEEPSEEK_API_KEY` exported.
- **Disk:** 4.5 GB free on C:. Rebuild only the engine image.

## Current priorities (in order)

1. **Record the demo video** (needs a human with a screen recorder; follow `research/DEMO_SCRIPT.md`).
2. **Confirm the official Problem 04 and 06 wording and rubric,** then finalise `research/SUBMISSION.md`. Submit by 2026-11-15, but only when the operator authorises it.
3. **Optional quality:**
   - a quantity/count guard in the verdict check (the B-229 class)
   - prefer authoritative sources for `current_value`
   - a judge comparison with `deepseek-v4-pro` on the FreshQA errors
4. **Operator decisions pending:**
   - GitHub publication itself, which needs explicit authorisation
   - (Licence, the FreshQA CSVs, the transcript and the screenshots were decided in session 7; the history in session 8.)
5. **Optional:** an upstream proposal for Bifrost (plugin plus relay pattern).
