# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are not yet tagged; the engine and plugin both report `0.1.0`. Detailed per-session notes are in [`research/IMPLEMENTATION_LOG.md`](research/IMPLEMENTATION_LOG.md).

## [Unreleased]

### Changed (2026-11-03): collapsible sidebar with Traffic (AD-35)
- The navigation rail and the Inspector's Traffic drawer are now one sidebar. It is collapsed by default and opened from a menu button in a slim top bar; the page uses the full width while it is collapsed.
- Desktop (≥ 1100 px): the sidebar docks beside the page and the choice is remembered. Narrower screens: a modal overlay that closes with ✕, Escape, a click outside, a navigation link or choosing a report.
- Traffic (the latest 100 reports) is a section of the sidebar that expands and collapses on its own, is live on every page, and is opened directly with `T`. The Traffic toolbar above the report is removed; newer/older buttons moved into the report header.
- The Claim explorer's filter control no longer overflows phone screens.

### Changed (2026-11-03): Tavily account usage from the provider (AD-34)
- System shows the account's usage and allowance exactly as Tavily's `GET /usage` reports them (`account.plan_usage`, `account.plan_limit`), with remaining credits only when both are valid. It also shows the last successful refresh, Current/Stale/Unavailable states, and the key-level counter separately. A **Refresh** button is limited to one read per 2 minutes.
- No allowance is assumed. When Tavily does not report a finite allowance, only usage is shown and paid searches are refused.
- Halflife's lifetime and daily limits are shown separately and never follow the provider allowance.
- The engine reads `/usage` at start and every 5 minutes, honours `Retry-After`, and retries soon after a failed first read.

### Changed (2026-11-03): Inspector Traffic drawer (AD-33)

- The Inspector's report list ("Traffic") is no longer a permanent left column. It is an overlay drawer opened from a **Traffic** button in a slim toolbar (or `T`), and closed with its close button, Escape, a click outside it, or by choosing a report. The report and claim detail now use the full workspace width.
- Keyboard: focus moves into the drawer and returns to the toggle; the rest of the console is inert while it is open; arrow keys, Home and End move between reports. Report rows and the close button now show a focus ring.
- The toolbar shows the selected report's position ("3 of 8") with newer/older buttons, and marks new reports that arrived while the drawer was closed.
- Phone and tablet widths: the drawer is fixed to the viewport, leaving a strip to tap; the toolbar sticks to the top. Reduced motion turns off the slide.
- Tests: `engine/test/console-ui.test.mjs`, 12 checks in headless Edge/Chrome against the TEST FIXTURE engine.

### Verified (2026-11-03): ChatGPT extension on real chatgpt.com

- The operator ran the extension in their own signed-in browser on chatgpt.com: it recognised the live page, its checks reached the local engine, and the results appeared in the console. No code change was needed.

### Added (2026-11-03): ChatGPT browser extension (AD-32)

- `extension/`: an opt-in Manifest V3 extension for chatgpt.com and chat.openai.com.
  - A **Check freshness** action on completed answers, with a compact in-page result.
  - A popup: connection, pause, recent checks, diagnostics.
  - A replaceable ChatGPT platform adapter.
- Engine `/v1/extension/*`:
  - pairing codes and origin-bound, revocable tokens
  - strict validation, dedup by message id and content hash
  - per-minute and daily limits, a kill switch and an estimate-only mode
  - `learn:false`, retention and deletion
  - activity, claims and trends queries
- Additive SQLite migration: `reports.client_ref/content_hash/client_id/client_meta`, table `extension_tokens`.
- Console: a **ChatGPT** section with Activity, Claim explorer, Trends and Extension (settings, privacy, deletion).
- Tests: 11 engine tests, 8 adapter tests in headless Edge/Chrome, 6 end-to-end tests that load the real extension via CDP. TEST FIXTURE engine server: `engine/test/fixture-server.ts`.

### Current state (2026-11-02)

- Feature-complete hackathon prototype, verified end to end with real DeepSeek and Tavily.
- Tests: 54 engine tests, 21 Go plugin tests with `-race`, 13 integration checks — all passing.
- Not production-ready: single node, SQLite, not load-tested, outdated-probability score uncalibrated.
- Licensed under Apache-2.0. Published at <https://github.com/fazeprism25/halflife> on 2026-11-02. Not deployed; the hackathon entry is submitted separately.

### Added (publication preparation)

- `LICENSE` (Apache License 2.0, official text), `NOTICE` and `THIRD_PARTY_NOTICES.md` (provenance and dependency audit, Bifrost and FreshQA attribution).
- Sanitised console screenshots in `docs/assets/screenshots/`: local clock times and the time zone are blanked out, and nothing else is changed.
- README licence and acknowledgements sections.

### Not included in the repository (kept locally by the maintainer)

- The original demo screenshots (`deploy/demo/backup/`). They showed local times and the time zone.
- FreshQA-derived files that reproduce questions and answers verbatim: `eval/freshqa-set.json`, the raw `eval/results/freshqa-*.json` runs and `eval/results/latest-freshqa.md`. The dataset carries no stated licence.
- The pre-release local history was replaced by a single root commit built from the sanitised tree, so none of these files appear in the published history.

## 2026-11-02 — initial repository

Development happened in five working sessions on 2026-11-02, before version control was introduced; this is the first commit of that work.

### Added

- **Bifrost plugin** (`plugin/`, Go): six hooks; lexical triage from shared cues; cache TTL caps and `no-store`; bounded asynchronous hand-off with retry; synchronous `verify` mode with annotation; response headers; heartbeat; panic recovery and fail-open behaviour; loop prevention with a secret internal token.
- **Engine** (`engine/`, Node 24, zero dependencies): LLM claim extraction and classification into 18 classes with span validation and a labelled heuristic fallback; Gamma–Poisson freshness model with reuse windows and grid-posterior learning; Tavily verification ladder (reuse, search, extract) through a Bifrost relay; quote-verified verdicts; ordinal evidence levels; cache invalidation and scheduled expiry through the Bifrost cache admin API; SQLite storage; REST API, SSE and console hosting.
- **Console** (`engine/console/`): inspector, check/playground, freshness-model and system views.
- **Spend controls:** per-answer, daily and lifetime credit caps; Tavily free-allowance guard (`CreditGuard`) reading account usage through a free relay route and counting locally; script-side `preflight`/`reconcile` guard and ledger.
- **Request options** on `/v1/check`: `verify: false` (assess-only) and `learn: false`.
- **Deployment:** gateway Dockerfile building Bifrost `transports/v2.4.0` from source at a verified commit; engine Dockerfile; Compose stack; config renderer writing `env.NAME` references only; `setup.mjs` secret generator.
- **DeepSeek** as the reference LLM through Bifrost's native provider, thinking disabled for judge calls.
- **Tests:** engine unit/integration tests; Go plugin tests and benchmarks; Docker integration suite with labelled test fixtures; live scripts for Tavily, DeepSeek and the gateway.
- **Evaluation:** hand-labelled v1/v2 sets; FreshQA builder, runner, scorer and hand adjudications; results in `eval/results/`.
- **Demo:** script, runner and backup screenshots.
- **Documentation:** README, `docs/` (architecture, installation, development, security, evaluation), contributing guide, this changelog; research notes, architecture decisions (AD-01 to AD-28) and implementation log in `research/`.

### Fixed during development (selected; see the implementation log)

- Plugin triage cost reduced from 579 µs to tens of µs per request by keyword-gating and windowing regexes.
- Duplicate stream notes from Bifrost's two final chunks.
- Inferred replacement values reported without a supporting quote (AD-20).
- Inconsistent handling of past-dated claims (AD-21).
- Older sources stating the old value counted as conflicting evidence for "superseded" (AD-24).
- "Superseded" verdicts with a change date in the future (AD-25).
- Console honesty fixes: weak evidence labelled as such, accurate headlines, no fake cache invalidations for `no-store` answers, local timestamps with zone (AD-27).
- Evaluation traffic biasing the learned class model; 79 evaluation-derived observations removed (AD-23).
