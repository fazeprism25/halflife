# Halflife: Project State

_Last updated: 2026-11-03 (session 11: Inspector Traffic drawer, real-chatgpt.com result, push). The persistent source of truth: a fresh session reads this file, then `NEXT_SESSION.md`._

## Session 11: Traffic drawer (AD-33), real-browser result, pushed

- **Dashboard:** the Inspector's report list ("Traffic") is now an overlay drawer, closed by default, opened from a **Traffic** toolbar button or `T`. It closes with ✕, Escape, a click outside, or by choosing a report. The report and claim detail use the full width. The toolbar has the position plus newer/older buttons, and a dot for new reports. Responsive: the drawer is fixed to the viewport at ≤ 980 px. No new dependency. Files: `engine/console/views/inspector.js`, `styles.css`, `lib.js`.
- **ChatGPT extension on real chatgpt.com: passed (operator-reported, 2026-11-03).** It recognised the live answers, its checks reached the local engine, and the results appeared in the console. No code change was needed. The checklist items were not reported one by one; Local Network Access was not separately confirmed.
- **Tests (final code, this session):**
  - engine 65/65
  - extension 14/14
  - **console UI 12/12** (new: `node --test engine/test/console-ui.test.mjs`, headless Edge, TEST FIXTURE engine, 0 spend)
  - import check clean
  - Integration 13/13 (session 10) and plugin 21/21 (session 5) were not re-run: only console static files changed.
- **Docs:** `SUBMISSION.md` (65 engine tests; ChatGPT extension section; limitations), README, `docs/DEVELOPMENT.md`, `CHANGELOG.md`, `extension/README.md`, `CHATGPT_EXTENSION.md` §5, AD-32 status, AD-33.
- **Git:** `566f561` (extension), `62e6de5` (notes) and the session 11 commit "Add Inspector Traffic drawer and record ChatGPT real-browser test" (UTC timestamps, noreply identity) were pushed to `origin/main` with operator authorisation. Check with `git log --oneline origin/main -3`. Nothing amended, deployed or submitted.
- **Running Docker stack:** it still serves the session 10 console. The drawer is not there until the console is hot-copied or the engine image is rebuilt (see `NEXT_SESSION.md`).

## Session 10: ChatGPT browser extension (AD-32), committed `566f561` (pushed in session 11)

- **What:** an opt-in MV3 extension (`extension/`), engine routes `/v1/extension/*` (`engine/src/extension.ts`), and four console pages under "ChatGPT": Activity, Claim explorer, Trends, Extension. Design and research: `research/CHATGPT_EXTENSION.md`.
- **Verified:**
  - engine 65/65
  - extension 14/14 (adapter 8 + e2e 6, real unpacked extension in headless Edge via CDP, fixture ChatGPT page, fixture engine)
  - integration 13/13 (real Bifrost and plugin, rebuilt engine image)
  - live assess-only smoke test (real DeepSeek extraction, 0 Tavily)
  - live database migrated in place (backup `engine/data/backup-before-extension-migration.db`)
- **Not verified:** real chatgpt.com (needs the operator's signed-in browser; checklist in `CHATGPT_EXTENSION.md` §5) and Chrome Local Network Access behaviour.
- **Running stack:** the engine image was rebuilt and restarted with this code, so the console at :8090 already has the new pages. Extension settings are at their defaults (accept on, live verification on, 50 a day, 6 a minute, 30-day retention). There are no paired browsers.
- **Git:** committed locally on `main` as `566f5616bfde491f1f48faea6965972459ad20ca` (UTC timestamps, noreply identity), followed by a commit recording it in these notes. At the end of session 10 it was not pushed; **both were pushed in session 11** (see above). Not deployed or submitted.
- **Pre-commit audit (operator-authorised):**
  - secret, personal-data, local-path and time-zone scan of all 40 files: clean
  - nothing from `engine/data/`, `.env` or test results staged
  - engine 65/65 and extension 14/14 re-run
  - the running engine image's `src/` and `console/` are byte-identical to the commit, so the session 10 integration run (13/13) covers this code

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
| ChatGPT extension (AD-32) | **Done; works on real chatgpt.com** (operator-tested, session 11) | 11 engine + 8 adapter + 6 e2e tests (session 10, re-run session 11) |
| Inspector Traffic drawer (AD-33) | **Done** (session 11) | 12 console UI checks in headless Edge; screenshots at 1440/820/390 px, light and dark |
| Tests | **65 engine, 21 plugin (`-race`), 13 integration, 14 extension, 12 console UI: all pass** (engine, extension and console UI re-run in session 11; integration in session 10; plugin in session 5, unchanged since) | `deploy/test/results/integration.json`, `plugin-test-2026-11-02.log` |
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

0. **Done in session 11:** the real-chatgpt.com test (operator) and the push. Remaining, optional:
   - add the extension to the demo script
   - refresh the running stack's console, so the drawer is live at :8090
   - re-take the sanitised screenshots: they predate the drawer

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
