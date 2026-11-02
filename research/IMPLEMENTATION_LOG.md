# Halflife: Implementation Log

Newest first. Every entry records what was done, the files touched, the tests run with their results, and any bugs.

---

## 2026-11-03, session 11 (Inspector Traffic drawer, AD-33; real-chatgpt.com result; push)

- **Operator report:** the ChatGPT extension was tested on real chatgpt.com in the operator's signed-in browser. It recognised the answers, its checks reached the local engine, and the results appeared in the console. No adapter change was needed. Recorded in `CHATGPT_EXTENSION.md` §5, AD-32, `SUBMISSION.md` and `extension/README.md`. The checklist items were not reported one by one (Local Network Access not separately confirmed).
- **Dashboard (AD-33):** the Inspector's permanent Traffic column became an overlay drawer.
  - `engine/console/views/inspector.js`:
    - toolbar with the **Traffic** toggle (count, new-report dot), the position ("n of N") and newer/older buttons
    - drawer (`role="dialog"`, `aria-modal`) and a viewport scrim
    - `setDrawer()` makes the toolbar, report and nav rail `inert` while open, and moves focus in and back
    - Escape, the `T` shortcut, arrow/Home/End keys in the list; choosing a report closes the drawer
    - the cleanup removes the document listener, `inert` and the scroll-lock class, so other pages are unaffected
  - `engine/console/styles.css`: the `.inspector` grid became a column (toolbar + detail); drawer, scrim, toolbar and pill styles; `--scrim` and `--shadow-overlay` tokens in the light and both dark blocks; reduced motion; the ≤ 980 px rules (fixed drawer, sticky toolbar, scroll lock) replace the old stacked list.
  - `engine/console/lib.js`: icons `panel`, `chevron-up`, `chevron-down`.
  - **Accessibility fix found on the way:** `.feed-item` used `all: unset` after the global `:focus-visible` rule, so report rows had no focus ring. Rows and the new close button now get one.
- **New test:** `engine/test/console-ui.test.mjs`, 12 checks with real input events (CDP mouse and key events) in headless Edge, against `fixture-server.ts --seed` (0 spend):
  - closed by default and full width
  - overlay without reflow, focus in, console inert
  - Escape, scrim, rail-click and close-button dismissal, with focus restored
  - `T`, arrow keys and Enter
  - newer/older
  - new-report mark
  - 390 px and 820 px layouts with no horizontal scroll
  - light and dark tokens
  - navigating away leaves nothing inert, and every other route still renders
  - Two first-run failures were test-harness issues: `clientWidth` excludes the scrollbar, and CDP Enter needs `text: "\r"`.
  - A shell edit put a literal carriage return in the test file again; fixed with a Node script (see the environment gotchas).
- **Visual review:** screenshots at 1440, 820 and 390 px, in light and dark (`HALFLIFE_UI_SHOTS`). Two refinements came from it: the scrim now covers the nav rail, and the toggle count is a pill.
- **Docs:**
  - `SUBMISSION.md`: tests 54 → 65 engine plus 14 extension and 12 console UI; AD range to AD-33; a ChatGPT extension section; limitations 8–9
  - README (tests, console line, screenshot note), `docs/DEVELOPMENT.md` (test table), `CHANGELOG.md`, `extension/README.md`
- **Tests run this session (final code):**
  - engine 65/65 (`cd engine && npm test`)
  - extension 14/14 (`node --test "extension/test/*.test.mjs"`)
  - console UI 12/12 (`node --test engine/test/console-ui.test.mjs`)
  - import check clean
  - Integration (13/13) and plugin (21/21) were **not** re-run: no engine server, plugin or deploy code changed, only console static files.
- **Not done:** the running Docker stack still serves the previous console (no rebuild or hot-copy this session). See `NEXT_SESSION.md`.
- **Git:** one new commit for this session on top of `62e6de5`, with UTC timestamps; `566f561`, `62e6de5` and this commit were pushed to `origin/main` with the operator's authorisation. Nothing was amended, deployed or submitted.

## 2026-11-03, session 10 (ChatGPT browser extension, AD-32)

### Request
An opt-in ChatGPT extension that sends one user-selected answer to the existing engine. It needs four dashboard pages (Activity, Claim explorer, Trends, Extension settings), security and privacy controls, and tests. No deployment, no store publication, no submission, and $0 Tavily.

### Research
- Three reference extensions were inspected through the GitHub API: their source, licences and manifests. The comparison is in `research/CHATGPT_EXTENSION.md` §1.
- Key fact: ChatGPT dropped `data-message-author-role` in late September 2026, according to the Apache-2.0 shadow extension's October code.
- Chrome documentation: content scripts can't make cross-origin fetches, so the service worker does. Local Network Access was not verified for extension service workers; it is a manual item.
- Branded Chrome and Edge 156 ignore `--load-extension`. CDP `Extensions.loadUnpacked` works (probed).

### Done
- **Engine:**
  - `engine/src/extension.ts`: pairing, tokens, checks, the compact view, console queries, deletion and retention, and the HTTP routes.
  - `store.ts`: additive migration.
  - `pipeline.ts`: the `extension` source, client fields, `client` in the report view.
  - `server.ts`: loopback-only extension routes ahead of the generic caller check; console routes in the console-only section.
  - `main.ts`: extension sweep.
- **Extension** (`extension/`):
  - manifest (MV3)
  - `src/adapters/chatgpt.js` (layouts A, B and C; streaming; virtualised questions)
  - `src/content.js` (closed shadow UI, page-theme aware, debounced scan with a maximum wait, stability re-read, polling, context-loss handling, diagnostics)
  - `src/background.js` (IndexedDB token, sender and payload validation, URL building, error mapping)
  - popup (pairing, status, pause, recent checks, diagnostics, disconnect)
  - icons (`scripts/make-icons.mjs`)
  - README
- **Console:** `views/{activity,claims,trends,extension,ext-common}.js`, a "ChatGPT" nav group, styles.
- **Tests:**
  - `engine/test/extension.test.ts` (11)
  - `extension/test/adapter.test.mjs` (8, headless browser with fixture DOMs)
  - `extension/test/e2e.test.mjs` (6: real extension via CDP, fixture page as https://chatgpt.com, fixture engine)
  - `extension/test/cdp.mjs`
  - `engine/test/fixture-server.ts` (TEST FIXTURE engine for visual review and e2e)
- **Docs:**
  - README section, SECURITY section, THIRD_PARTY_NOTICES attribution, CHANGELOG
  - AD-32
  - `research/CHATGPT_EXTENSION.md`

### Bugs found and fixed during the session
1. `activity()` computed `at_risk` but did not return it (engine test).
2. The adapter read text inside nested search units twice (adapter test).
3. **The scan was a pure debounce.** While an answer streamed, the buttons for earlier answers never appeared (e2e). Fix: a 1 s maximum wait.
4. **The mutation filter dropped attribute records.** `every` over an empty node list is true, so streaming-attribute flips were ignored (code review). Fix: only childList records made entirely of our own hosts are ignored.
5. **The in-page card followed the OS theme instead of ChatGPT's.** Light page with a dark OS gave illegible text (screenshot). Fix: html class, then background luminance, then the page's `color-scheme`.
6. The popup rendered "nullnull" because `Element.append(null)` writes "null" (screenshot).
7. The popup sender check required "no tab", which would refuse the popup opened as a tab. The URL alone identifies it.
8. Claim explorer wording: "none evidence", and "Verified" for unverifiable claims. Also, source links are now restricted to http(s).
9. Questions over 16,000 characters were dropped instead of truncated.

### Tests
- **Engine:** 65/65 (54 existing plus 11 new).
- **Extension:** 14/14 (adapter 8, e2e 6) in headless Edge 156.0.4314.58.
- **Integration:** 13/13 against real Bifrost v2.4.0, the real plugin and the rebuilt engine image (fixture upstreams, provider keys blanked, 0 spend).
- **Go plugin:** not re-run (no plugin change).
- **Live smoke test** against the running stack (assess-only):
  - One real DeepSeek extraction through Bifrost (claims `org.leadership` plus `historical.fact`), 0 Tavily credits. The engine total stayed at 128.
  - The smoke check was deleted and its token revoked afterwards. Live verification was restored to on.
- **Migration on the live database:** 308 reports kept, 4 columns and `extension_tokens` added. Backup: `engine/data/backup-before-extension-migration.db` (gitignored, integrity ok).
- **Visual review:** headless Edge screenshots (dark) of the four new pages, the in-ChatGPT card and the popup. These are review material in the scratchpad, not committed.

### Spend
- Tavily: 0 this session; engine lifetime 128 of the 700 cap, account ceiling 800.
- DeepSeek: one extraction call, well under $0.01.

### Not done or not verified
- **Not tested on real chatgpt.com.** That needs the operator's signed-in browser; see the manual checklist in `research/CHATGPT_EXTENSION.md` §5.
- **Local Network Access** behaviour in real Chrome is unverified.
- `research/SUBMISSION.md` still quotes the session 9 test counts; left for the submission pass.

### Commit (operator-authorised; no push)
- **Audit before committing:**
  - full diff reviewed; the changes to tracked files are limited to the extension wiring
  - secret, personal-data, local-path and time-zone scan of all 40 files: clean
  - nothing from `engine/data/`, `.env` or test results staged
- **Tests re-run:** engine 65/65 and extension 14/14.
- **Integration not repeated:** it rebuilds the stack. The running engine image's `src/` and `console/` are byte-identical to the commit, so the earlier 13/13 run covers this code.
- **Commit:** `566f5616bfde491f1f48faea6965972459ad20ca` on `main`, UTC author and committer dates, repository-local noreply identity. A second commit records it in the four context files.
- **Not pushed, deployed, published or submitted.**

---

## 2026-11-02, session 9 (published on GitHub)

### Operator authorisation
Use the GitHub noreply identity, recreate the root commit, create a public repository `halflife`, push, and provide the URL. Not authorised: submission, deployment, uploading private material.

### Done
- `gh auth status`: logged in as `fazeprism25`; the account id came from `GET /user`. The token lacks the `user` scope, so `/user/emails` was unavailable; the address follows GitHub's documented noreply format (`<id>+<login>@users.noreply.github.com`) from the API-reported id. Set in the repository-local config only.
- Root commit recreated from the identical tree (`5b144b2`) with UTC timestamps: `f42d3bf73602d3e52d46cb01bcec9faec29c8ea1`, no parent, 119 files. The previous root was pruned; the private backup from session 8 is untouched.
- Created <https://github.com/fazeprism25/halflife> (public, description set, no homepage, no remote README/licence/.gitignore). Pushed `main` with upstream tracking.

### Checks
- Before publishing: secret scan 0 values (7 known placeholders); forbidden-path check empty; LICENSE sha256 matches the official text; 7 screenshots; links OK; engine 54/54; personal email, local paths and the zone offset absent from tracked text and commit metadata.
- After pushing: `git ls-remote` = local HEAD; the API reports visibility public, default branch `main`, licence Apache-2.0, README detected, 1 commit with no parents, 119 blobs; anonymous HTTP 200.
- Found and fixed: AD-13 cited `engine/test/fakes/`; the file is `engine/test/fakes.ts`.

---

## 2026-11-02, session 8 (history replaced by a single root commit)

### Operator decision
Replace the local git history with one clean root commit built from the sanitised tree (option (a) of AD-31).

### Done
- **Preserved first**, outside the repository: a `git bundle --all` (verified, complete history), a copy of the old `.git` directory (fsck clean), the uncommitted `NEXT_SESSION.md` diff, and the old file list and log.
- **Audited the tree** before rewriting: no original screenshots, FreshQA-derived verbatim files, databases, `.env` files, transcript, spend ledger, balances, logs or machine inventory tracked; each category confirmed ignored with `git check-ignore`. The seven sanitised screenshots are byte-identical to the versions verified in session 7.
- **New history:** an orphan branch committed with the current tree and renamed to `main`. The commit has no parent. The old branch was deleted, the reflogs expired and unreachable objects pruned, so `git rev-list --all` counts 1 commit.
- Research notes, AD-31 and `CHANGELOG.md` updated; old commit hashes removed from the notes. The new commit's hash is not written into the tree (a commit cannot contain its own hash); see `git log`.

### Tests and checks
- Secret scan of all tracked files: 0 secret values; the 7 pattern hits are the known placeholders.
- Zone, local-path and personal-identifier scans of tracked text: 0 hits.
- Engine tests and doc links: see the session 8 report (run before committing).

---

## 2026-11-02, session 7 (Apache-2.0; provenance audit; sanitised screenshots; publication preparation)

### Operator decisions
Apache-2.0; FreshQA CSVs stay excluded; demo transcript private; screenshots only with the time zone removed.

### Provenance and licence audit (AD-31)
- **Code:**
  - `git grep` for copyright, SPDX, "licensed under", "adapted/derived/based on" and paste-site markers: none in code.
  - Compared normalised lines (>30 chars) against Bifrost v2.4.0's example plugins: only the hook signatures and the `core/schemas` import are shared, as the interface requires.
- **Console:** hand-written SVG icons; fonts referenced by name, none bundled; no external URLs.
- **Dependencies:**
  - Engine: 0 npm packages.
  - Plugin, via `core/schemas`: sonic (Apache-2.0); mcp-go, gjson/sjson and fasthttp (MIT); x/net (BSD-3).
  - Bifrost is Apache-2.0 (H3 Labs Inc.). Its own notices list MPL-2.0 deps in the gateway binary.
  - None of these is redistributed by the repository.
- **Data:**
  - The FreshQA repo is Apache-2.0 but contains only notebooks; the data is in Google Sheets with no stated licence. Checked the GitHub page and a web search; no official licensed copy found.
  - Five tracked files reproduced FreshQA questions and answers verbatim (`freshqa-set.json`, the A, BC and two rerun raw JSONs, `latest-freshqa.md`). They were withdrawn from version control and are kept on disk.
  - `freshqa-adjudications.json` holds our own notes only; kept.
  - Wikidata feasibility aggregates are CC0.
- **Result:** no blocking conflict for licensing Halflife's own code.
  - Added `LICENSE`: the official text, sha256 `cfc7749b…3d30`, identical to apache.org's.
  - Added `NOTICE` ("Copyright 2026 The Halflife authors") and `THIRD_PARTY_NOTICES.md`. Citation authors checked against arXiv.

### Screenshots
- The originals in `deploy/demo/backup/` are withdrawn and gitignored, and kept on disk unchanged.
- Sanitised copies are in `docs/assets/screenshots/`, made with System.Drawing (a C# helper in the session scratchpad):
  - **Report header (01–05):** time and zone blanked, the date kept.
  - **Feed clock times:** blanked, 12 rows per shot. Rows were detected by their text signature (8 px tall, x 232–281, muted grey). Each fill uses the row's own background, so the selected row stays correct.
  - **Partial bottom row (02, 03):** a timestamp at y 1096–1098 was missed by the first pass and fixed.
  - **06:** "updated HH:MM:SS" time blanked.
  - **07:** unchanged (no times).
- **Verification:**
  - A programmatic re-scan found no timestamp-signature rows and no ink right of the header date.
  - Visual checks of 01, 02 and the 06 crop.
  - PNG chunks: no tEXt, iTXt, tIME or eXIf.
- **Found and fixed:** research notes quoted the zone and local clock times in text (AD-29, AD-31 drafts, the session 6 log entry). Removed. The pre-release history still contained them until session 8.

### Docs
README (licence, acknowledgements, screenshot path, FreshQA note), `docs/EVALUATION.md` (data not redistributed, inline snapshot hashes, rebuild steps), `CONTRIBUTING.md` (Apache-2.0 contribution terms, private-material rules), `CHANGELOG.md`, `research/README.md`, `research/DEMO_SCRIPT.md`, AD-30 status, AD-31.

### Tests and checks
- `cd engine && npm test`: **54/54 PASS**. `check-imports.mjs`: clean.
- Go plugin and integration suites: **not re-run** (no code changed in sessions 6–7; last results 21/21 with `-race` in session 6, and 13/13 in session 5).
- Secret scan of all tracked files after staging: 0 secret values. Pattern hits were only the known placeholders (`sk-bf-feasibility-local-only`, `Bearer env.HALFLIFE_RELAY_TOKEN`).
- Time-zone scan of tracked text (the zone string in its usual notations, and local clock times): 0 after the fixes.
- Clean export of the staged tree: `setup.mjs` OK, engine 54/54, doc links OK (README, CONTRIBUTING, CHANGELOG, THIRD_PARTY_NOTICES, docs, research/README, DEMO_SCRIPT, experiments/README), `docker compose config` valid; FreshQA-derived files and original screenshots absent.
- Doc link check, and a clean-export check of the staged tree: see the final line of this entry.

### Open
- **History:** the pre-release commits contained the original screenshots, the FreshQA-derived files and the textual zone mentions. Resolved in session 8 by a single root commit.

---

## 2026-11-02, session 6 (git repository; public documentation; licence research)

### Repository
- `git init -b main` (no repository existed). Global git identity used as configured; no git config changed. No remote created; nothing pushed.
- New `.gitignore` (AD-29) and `.gitattributes` (LF normalisation). 120+ files staged; excluded: `deploy/.env`, `engine/data/` (DB + backup), `.build/`, `deploy/test/results/`, `deploy/demo/results/`, raw v1/v2 runs, the 2-item FreshQA smoke run, FreshQA CSVs, `experiments/vendor/` (2.5 GB), feasibility logs and `environment.json`.
- One commit: "Initial commit: Halflife freshness verification platform", 122 files. (This pre-release history was replaced by a single root commit in session 8.)
- Final staged-file scan (122 files): 0 secret values; 6 pattern hits, all known placeholders (`sk-bf-feasibility-local-only`, `Bearer env.HALFLIFE_RELAY_TOKEN`); no personal identifiers. Clean export of the staged tree: `setup.mjs` OK, engine 54/54, doc links OK, scorer runs, `docker compose config` valid.

### Documentation
- `README.md` rewritten for an unfamiliar developer: problem, three separate measures (freshness risk / verdict / evidence confidence), Bifrost/Tavily/DeepSeek integration, setup, API, tests, demo, cost controls, security, evaluation with caveats, limitations, structure, licence status. Removed an inaccurate "tested in CI-style integration" (there is no CI) and corrected "Tavily counter lags by minutes" to hours.
- New: `docs/ARCHITECTURE.md`, `docs/INSTALLATION.md`, `docs/DEVELOPMENT.md`, `docs/SECURITY.md`, `docs/EVALUATION.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `research/README.md`, `experiments/README.md`.
- Every claim was checked against code: header names (`plugin/main.go`), routes and auth (`engine/src/server.ts`), env defaults (`engine/src/config.ts`, compose), relay routes (`render-config.mjs`), DB file name, console token flow, CSP, constant-time token compare, integration-suite isolation (project `halflife-it`, provider keys blanked).
- Found while documenting: `render-config.mjs` reads `HALFLIFE_OLLAMA_MODEL` but Compose doesn't pass it (default `qwen3:8b` applies). Ollama path untested; documented as such. Only DeepSeek has been verified live among providers.

### Licence research (AD-30)
- Bifrost: Apache-2.0; MPL-2.0 Go deps compiled into the gateway binary (THIRD_PARTY_NOTICES). FreshQA repo: Apache-2.0; sheet data has no stated terms (checked the GitHub README). Recommendation Apache-2.0; not applied.

### Tests and checks
- `cd engine && npm test`: **54/54 PASS**; `check-imports.mjs`: clean.
- Plugin: `docker build -f deploy/gateway.Dockerfile --target plugin-test --no-cache-filter plugin-test`: **21/21 PASS with `-race`**, 0 data races; `BenchmarkInlineHooks` 41.7 µs/op (30 allocs), `BenchmarkTriage` 30.0 µs/op.
- `node eval/freshqa-score.mjs`: output identical to the committed `latest-freshqa.md` except the timestamp (original restored).
- Integration suite: **not re-run** (no code changes since session 5's 13/13; it would stop the running stack).
- Secret scan (script in the session scratchpad; prints no values): all `.env` values, shell provider keys, `tvly-`/`sk-`/private-key/AWS/GitHub-token patterns, the operator's email and home path. Before staging: hits only in `deploy/.env` (ignored) and fake `sk-bf-feasibility-local-only` placeholders in `experiments/feasibility`. Staged files: see the final check in this entry.
- Screenshots viewed one by one: no secrets; they show the local time zone (handled in session 7).

---

## 2026-11-02, session 5 (console audit; FreshQA evaluation; demo; submission draft; quality gate)

### Console audit with real data (headless Edge, fresh profile per shot: `max-age=300` caching hid changes at first)
**Bugs found and fixed** (AD-27):
1. The headline "1 checked, 0 unverifiable" was shown for a superseded/weak claim. New `headlineFor()`, `summary_version 3`; old reports are re-headlined at startup from their stored claims.
2. "Cache TTL set" always showed "—": the view read `r.ttl_set`, but the API returns `r.cache.ttl_set`.
3. Weak-evidence verdicts looked as confident as strong ones. Now "Possibly superseded / Likely current · weak evidence", and report badges match.
4. "Current" badge shown while at-risk claims were unchecked: the check order is fixed.
5. A UTC date was shown next to a local time. Now `stamp()` gives local time with the zone.
6. No-store answers showed "invalidate stale · done · HTTP 200" for entries Bifrost never stored. The engine now takes no cache action for no-store.
7. "Checked live" counted reused verifications: the reused count is now shown.
8. My own regression, caught by screenshot: `original` was not in scope in `cacheSection`, so every report detail failed.

**Additions:**
- per-report tokens
- the guard panel on the System page
- "latest 100" feed label
- a tooltip on Tavily dates
- empty-state example uses DeepSeek

### Engine changes
- `evidence.ts` (AD-24): for superseded, older sources stating the old value don't count as conflict. Grammar fix: "points".
- `verify.ts` (AD-26): numeric current values fall back to any verified refuting quote; names get no fallback.
- `verify.ts` (AD-25): superseded with `changed_on` in the future → unverifiable, limitation `future_change`. `pipeline.ts`: T0 reuse skips such stored verdicts.
- `pipeline.ts` and `server.ts` (AD-23): `/v1/check` takes `verify:false` (assess-only) and `learn:false`.
- `pipeline.ts`: the summary records tokens, `possibly_stale`, `weak_current` and `assess_only`.
- **Data fix:** the DB was backed up to `engine/data/backup-before-eval-obs-removal.db`, then the 79 learning observations from API (evaluation) reports were deleted; 12 remain.

### FreshQA evaluation (AD-28)
- **Data:** `eval/data/freshqa/freshqa-{2024-02-26,2026-04-21}.csv`, exported from the public sheets. Hashes are in `eval/freshqa-set.json`.
- **New files:**
  - `eval/freshqa-lib.mjs`: CSV parser
  - `eval/freshqa-build.mjs`: deterministic set
  - `eval/freshqa-run.mjs`: `--part A|BC`, `--tag` for reruns
  - `eval/freshqa-score.mjs`
  - `eval/freshqa-adjudications.json`
- **Runs:**
  - A: 100 items, 0 credits, 153k tokens.
  - BC: 60 items, 59 credits, 268k tokens.
  - Rerun of the 2 future-change items after the fix: 2 credits.
- **Adjudication:** by independent WebSearch, not Tavily. Confirmed the 2026 NBA (Knicks), NHL (Hurricanes), Miss World (Mola), Starmer → Burnham, Emmy comedy (Widow's Bay), Wimbledon 2026 (Nosková, Czech: B-482 changed back), and the Hexed release date 2026-11-25.
- Results are in PROJECT_STATE.

### Demo
- `research/DEMO_SCRIPT.md`: every fact was checked by independent search.
- `deploy/demo/run-demo.mjs`: guarded.
  - **First rehearsal failed in the runner:** DeepSeek returned empty content because `thinking` was not disabled and `max_tokens` was 300. The plugin reported `skipped; no-text`; the runner now sends `thinking: disabled` and handles skipped requests.
- Backup:
  - transcript `deploy/demo/results/demo-2026-11-02T16-04-21-277Z.md`
  - stills `deploy/demo/backup/*.png`
  - No video: no Chrome extension was connected and no recorder is available.

### Submission
- `research/SUBMISSION.md`: draft covering the description, problem, architecture, AI-use disclosure, impact, Problem 04/06 mapping, differentiation and the list of unproven items. Not submitted.

### Spend guard
- `spend-guard.mjs` `reconcile()` printed "run used N Tavily credits" from the counter delta. Tavily's counter lags by hours (it read 3 → 0 → 3 during the session), so the message misattributed spend. It now prints the engine's local count and a lagging `tavily_counter_delta`.

### Quality gate
- `cd engine && npm test`: **54/54 PASS**. New tests cover AD-23 to AD-27 and the headlines.
- Plugin: `docker build … --target plugin-test --no-cache-filter plugin-test` → **21/21 PASS with `-race`**, 0 data races. Benchmark: hooks 43 µs/op, triage 28 µs/op. Log: `deploy/test/results/plugin-test-2026-11-02.log`.
- `NO_BUILD=1 node deploy/test/integration.mjs`: **13/13 PASS**.
- **Clean setup:** the tree was copied without `.env`, data or results; `node deploy/setup.mjs`, `npm test` (54/54) and `docker compose -p halflife-clean up --build` (cached) all worked; both containers healthy; the console returned 200.
  - `DEEPSEEK_API_KEY` came from the shell environment, which takes precedence in Compose. The run was therefore "LLM, no Tavily", and correctly reported "Live search is not configured … not checked".
  - Torn down with `down -v`.
- **Secret scan:** 134 files checked for the 8 `.env` secret values and the key patterns `tvly-`, `sk-` and private-key headers. **0 hits.** There is no git repository, so nothing is committed.
- **Guards active:** account check on, ceiling 0.8 (code clamps it at 0.95), daily cap 150, lifetime cap 700, no overrides in `.env`.

### Errors this session
- A heredoc stripped regex backslashes again (`/(d),…/` became `/(d),…/` with a literal backspace). It was caught by a test print, and fixed with a Node script written by the Write tool.
- `docker cp` from Git Bash mangled `/c/...` paths: use PowerShell for `docker cp` with host paths.
- Edge `--screenshot` into a path containing spaces silently wrote nothing: capture to the scratchpad, then copy.

---

## 2026-11-02, session 4 (first real DeepSeek + Tavily runs; credit guard; evaluation v1/v2)

### Accounts (free endpoints only; no keys printed)
- **Tavily** (`GET /usage`):
  - plan **Researcher** (free), `plan_limit` 1000/month, usage 0 at start
  - `paygo_usage` 0, `paygo_limit` null, key limit null
  - The assumed 8,000 credits do not exist on this account.
- **DeepSeek** (`GET /user/balance`):
  - available, $5.89 topped-up, $0 granted
  - `/models` lists `deepseek-flash` (V4.1-Flash) and `deepseek-v4-pro`
  - The key authenticated on the first try.

### Changes
- **New `engine/src/credits.ts`:** `CreditGuard`. Daily cap, lifetime cap, and account ceiling = floor(plan_limit × 0.8), fail-closed, lag-tolerant, 429-tolerant, serialised (AD-19).
- `tavily.ts`: `usage()` via `GET /relay/tavily/usage`. `render-config.mjs`: the new free relay route.
- `verify.ts`:
  - async `reserveCredits`, plus `settleCredits` with actual credits
  - `current_value_quote` grounding with `valueInQuote()` (AD-20)
- `prompts.ts`: verdict schema gets `current_value_quote`; the prompt says not to infer values; extraction gets the tense rule (AD-21).
- `pipeline.ts`: the guard is wired in; claims are verified concurrently (AD-22).
- `main.ts`: `instrumentSearch` now passes `usage` through.
  - **Bug found:** the guard showed `account_check: off` live, because the wrapper dropped the method. Caught from `/v1/status` before any spend.
- `store.ts` `spendTotal()`. `server.ts`: `/v1/status` spend has `total_credits`, `total_tokens` and the guard status.
- Compose and `.env.example`: `HALFLIFE_TOTAL_CREDIT_CAP`, `HALFLIFE_TAVILY_CEILING_FRACTION`, `HALFLIFE_TAVILY_ACCOUNT_GUARD`.
- Fixtures: `GET /tavily/usage` [TEST FIXTURE]; the verdict fixtures carry `current_value_quote`. `integration.mjs`: `NO_BUILD=1`.
- **New scripts:**
  - `deploy/test/spend-guard.mjs`: preflight and reconcile, ledger `results/spend-ledger.jsonl`
  - `deploy/test/live-tavily.mjs`
  - `deploy/test/live-e2e.mjs`
  - `eval/labelled.mjs`: v1 has 40 items, v2 has 15; labels pre-registered
  - `eval/run.mjs`
- `live-deepseek.mjs`: guarded.

### Live results (all real services; nothing fixture)
- **Tavily minimal** (`results/live-tavily.json`):
  - Search through the relay: HTTP 200 in 1.27 s, 5 results, all with `published_date`, all valid URLs, 1 credit reported.
  - Extract of 1 URL: 352 ms, 1 ok, **0 credits** reported.
  - Quality: the top results for "latest stable Python release" were SEO pages with stale content but 2025 dates.
- **DeepSeek live script** (`results/live-deepseek.json`): **6/6 PASS**.
  - **Auth and inference:** 1.14 s, thinking off, 12 tokens, no reasoning returned.
  - **Thinking on:** 1.68 s, 21 reasoning tokens.
  - **Structured output:** `json_schema` → `json_object` via Bifrost, parsed, exact quotes, 262 tokens, 1.0 s.
  - **`/v1/check`, 3 claims:** 17.8 s, 3 LLM calls, 2 credits. Twitter and Python → superseded/strong with verified quotes; Hastings → static.
  - **Allow-list:** an unknown model gets 403 from Bifrost and is never sent upstream.
- **End to end through the gateway** (`results/live-e2e.json`), real DeepSeek answers:
  - Stable claims: triaged static, 0 credits.
  - ChatGPT Plus $20: current/strong.
  - YouTube Premium $13.99: **superseded**/strong; it rose to $15.99 in April 2026.
  - Intel/Lip-Bu Tan and Starbucks/Niccol: current/strong.
  - Node 22: **superseded**; React 19: current (19.3).
  - India population ≈ 1.45 B: current/strong (sources say 1.476 B; the judge is lenient on "approximately").
  - **Cache policy:**
    - Price answer marked no-store by the plugin, and the stale entry invalidated (HTTP 200).
    - Version entry invalidated.
    - Rerun: leadership was a cache hit linked in 4 ms; the others reused T0 at 0 credits.
- **Evaluation v1** (40 items, fresh run `eval/results/run-2026-11-02T15-10-55-300Z.json`):
  - **40/40 verdicts correct** under the first scoring; under the corrected scoring, 36 decided, 36 correct, 4 static abstentions.
  - Stale P/R 1.0/1.0 (tp 25).
  - Evidence levels: strong 30, moderate 3, weak 3, all correct.
  - 33 credits (1.0 per searched claim; T2 extract used twice all session).
  - p50 5.5 s, p95 11.0 s.
  - Brier of the P(outdated) midpoint: 0.27 (uncalibrated prior).
  - 142k DeepSeek tokens.
  - **The set is easy:** well-known changes, so verdict accuracy saturates.
  - **Current values:** 21 reported.
    - Several are events after the labeller's knowledge, each backed by multiple dated major outlets: Andy Burnham as UK PM from 20 Jul 2026; an ECB hike to 2.50% on 10 Sep 2026; the Fed at 3.75–4%; Linux 7.3; iPhone 18 Pro.
    - "iOS 27.2" is **doubtful**: from a page dated 2022, while endoflife.date says 27.0.1.
    - "iPhone Duo" is unverified.
    - "Pope Leo XIV" was omitted by the grounding check (over-strict).
- **Evaluation v2** (15 harder items), first run:
  - 3 wrong-valued static facts were triaged static and **not checked**. This is a scope boundary (AD-21); the scorer was fixed to count them as abstentions.
  - 2 of 3 past-dated claims were judged superseded (inconsistent); fixed with the tense rule.
  - ChatGPT $25: contradicted/strong.
  - 5 recent-but-current claims: all current/strong.
  - Ambiguous: Amazon length → unverifiable (good); Tokyo 37 M → current/**weak**; Everest → static.
  - After the fixes, the scoped claims are static at 0 credits. Regression check: "As of early 2023, Dorsey **is** CEO" is still checked, and is now `contradicted`.

### Spend (actual)
- **Tavily:** 63 credits this session (62 by the engine plus 1 direct), 6.3% of the allowance. Account ceiling 800; pay-as-you-go 0.
  - The Tavily counter still showed 0 at the end because of the lag; the local ledger is authoritative.
- **DeepSeek:** about 200 calls, about 357k tokens. Balance $5.89 → $5.86, so **about $0.03 actual**; the guard's bound is $0.38.
- Measured unit costs, v1 fresh run: about 3.5k tokens and 1.0 credit per checked claim, that is, about $0.001 DeepSeek plus 1 Tavily credit.

### Tests
- `cd engine && npm test`: **48/48 PASS**. New: 10 credit-guard tests, plus the value-grounding test.
- `NO_BUILD=1 node deploy/test/integration.mjs`: **13/13 PASS**. The live stack has to be stopped first, because port 8080 is shared.
- Plugin (Go): unchanged, not re-run (last result 21/21).

### Errors seen
1. A transient Node `fetch` connect timeout to api.deepseek.com (curl was fine). Fixed by one retry in the guard's free reads.
2. Tavily `/usage` 429s. The first e2e script crashed at reconcile, and its 4 reports were recovered from the engine store; the run is labelled RECOVERED in `live-e2e.json`.
3. Shell escaping corrupted three edits: a regex with a literal CR, and `p` lost. Caught by `node --check` and the tests. Use the Edit tool for any regex or escape edit.

---

## 2026-11-02, session 3 (DeepSeek through Bifrost; Tavily MCP decision)

### Research (sources: Bifrost source at `transports/v2.4.0`; api-docs.deepseek.com)
- **Bifrost v2.4.0 has a native `deepseek` provider** (`core/providers/deepseek/deepseek.go`):
  - base URL `https://api.deepseek.com`
  - bearer auth
  - OpenAI-compatible `/chat/completions`, with an optional Anthropic-compatible endpoint
  - `max_completion_tokens` mapped to `max_tokens`
  - **`json_schema` automatically downgraded to `json_object`** with the schema injected into a system message (`openai/chat.go`)
  - extra body params passed through
  - thinking forced off only for forced `tool_choice`
- **DeepSeek models** (pricing page): `deepseek-flash` (V4.1-Flash) and `deepseek-v4-pro`.
  - Both: 1M context, thinking on by default, JSON output.
  - JSON mode: `json_object` only, the prompt must contain "json", and content may come back blank.
- **Decision record:** AD-17 (model choice, thinking off, limitations) and AD-18 (Tavily MCP not connected).

### Changes
- `deploy/render-config.mjs`:
  - new `deepseek` provider entry: `env.DEEPSEEK_API_KEY`, judge `deepseek/deepseek-flash`, playground `deepseek/deepseek-flash`
  - explicit allow-list `deepseek-flash, deepseek-v4-pro`
  - `runtime.json.llm_extra_body` holds the per-provider judge request fields (DeepSeek: `thinking: disabled`)
  - in fixture mode, the native DeepSeek provider is aimed at the fixture
- `engine/src/llm.ts`:
  - `extraBody` merged into requests; it cannot override `model` or `messages`
  - the format step-down now happens only on format-related 400s; before, any 400 permanently degraded the format
  - 429 honours `Retry-After` (clamped to 0.5–5 s)
  - 402 carries the upstream message ("Insufficient Balance" vs a VK budget)
  - blank content is reported as "model returned empty content" and retried once
- `engine/src/config.ts`: `llmExtraBody` via `extraBodyFor()`, from runtime.json or a `HALFLIFE_LLM_EXTRA_BODY` JSON override.
- `engine/src/main.ts`: passes `extraBody` to the client.
- `deploy/docker-compose.yml`: `DEEPSEEK_API_KEY`, `HALFLIFE_LLM_FALLBACKS` (previously not forwarded) and `HALFLIFE_LLM_EXTRA_BODY`.
- `deploy/setup.mjs`: template lists `DEEPSEEK_API_KEY`. An existing `.env` gains empty placeholders for `TAVILY_API_KEY` and `DEEPSEEK_API_KEY`; the local `.env` got `DEEPSEEK_API_KEY=` (empty).
- **New** `deploy/.env.example`: every variable, documented; no values.
- **New** `deploy/test/live-deepseek.mjs`: the live check (auth, inference, thinking comparison, structured output, engine extraction and verification via the relay, allow-list refusal). It never prints `.env` values and writes `deploy/test/results/live-deepseek.json`.
- `deploy/test/fixtures.mjs` and `integration.mjs`: the fixture records the DeepSeek-path request; new check 9.
- `README.md`: DeepSeek quickstart, test counts.

### Tests
- `cd engine && npm test`: **37/37 PASS** (35 existing plus 2 new).
  - The 429 test checks one retry, that the extra body is sent, and that the format is not stepped down.
  - Blank content is retried.
  - A context-length 400 does not degrade later calls.
  - 402 Insufficient Balance gives `budget`.
  - `extraBodyFor` handles defaults, overrides and invalid JSON.
- `node deploy/test/integration.mjs`: **13/13 PASS** (12 existing plus the new DeepSeek wire check).
  - On the real Bifrost v2.4.0 binary, the upstream DeepSeek request had `response_format: json_object`, `thinking: disabled`, model `deepseek-flash` (prefix stripped), `max_tokens: 300`, a bearer key, and 2 system messages (the schema instruction was injected).
- **Plugin:** Go code unchanged, so the plugin tests were not re-run (last result 21/21).
- **Live DeepSeek run: NOT DONE.** `DEEPSEEK_API_KEY` is still empty in `deploy/.env`.

### Environment
- Docker Desktop was not running. It was started from `%LOCALAPPDATA%\Programs\DockerDesktop`.
- C: has 10.08 GB free.

---

## 2026-11-02, session 2 (build start)

### Environment incident
- **What happened:** a Docker build filled C: to 0 MB, and Docker Desktop crashed.
- **What I did, with the user's approval:**
  - ran `docker builder prune -af`
  - removed the images `halflife-feasibility:dev` and swebench
- **State afterwards:**
  - The host had about 4.9 GB free, dropping to about 2.9 GB after rebuilds.
  - `docker_data.vhdx` stays at 18.4 GB. It won't shrink without admin compaction, but it has free space inside.
- **Rule:** check free space before heavy builds (`Get-PSDrive C`).

### Plugin (`plugin/`, Go, built inside Bifrost `transports/v2.4.0`)
- **Files:**
  - `config.go`: config parsing with clamps; secrets come from the env vars named in the config
  - `triage.go`: shared lexical cues, keyword-gated and windowed RE2
  - `state.go`: a bounded per-request store with a sweeper
  - `ingest.go`: a bounded queue, workers, one retry, the sync verify call and a heartbeat
  - `main.go`: all hooks
  - `plugin_test.go`
- **Hook responsibilities:** per AD-05. The job is enqueued in `HTTPTransportPostHook`, which for streams runs after the last chunk (verified in the source, `handlers/inference.go` `runCompleter`).
- **Tests:** `docker build -f deploy/gateway.Dockerfile --target plugin-test .`
  - **21/21 PASS with `-race`**; `go vet` clean.
  - Coverage includes: config validation, cue compile and triage, keyword-gate equivalence, UTF-8 truncation, state bounds and sweep, the non-stream flow (TTL only ever lowered, headers, ingest payload, VK fingerprint without a secret), no-store for prices, the internal-token skip (forged token rejected), `mode off`, non-chat paths, cache-hit body read and link, no enqueue on upstream errors, stream accumulation with a single note across duplicate finish chunks, verify mode (no-store plus annotation, then link-only), the verify timeout failing open, engine down, queue-full drop without blocking, panic recovery that passes the response through, hooks before `Init`, and 50 concurrent requests.
- **Benchmark (Docker, 4 CPUs):**
  - All hooks for one request: **57 µs/op**, 30 allocs.
  - Triage on 672 bytes of cue-dense text: 36 µs.
- **Bug fixed:** the first version cost 579 µs/op, because case-insensitive `\b` regexes scanned the whole text.
  - Fix part 1: per-group `keywords` in `shared/temporal-cues.json` gate the regexes.
  - Fix part 2: regexes run only in ±100-byte windows around keyword hits.
  - Equivalence with full scanning is tested.
- **Bug avoided:** the probe appended the stream note twice, because Bifrost emits two chunks with `finish_reason`. The fix is a state guard, which is tested.

### Engine (`engine/`, Node 24, zero dependencies)
- **Files** (all in `src/`):
  - `classes.ts`: 18 classes with priors and rationale
  - `freshness.ts`: Gamma grid, P(outdated), reuse window, half-life
  - `asof.ts`: dates and cited model cutoffs
  - `text.ts`: locate, quote check, sentences, sites
  - `evidence.ts`: ordinal level rules
  - `llm.ts`: the Bifrost LLM client, with structured-output step-down
  - `tavily.ts`: the relay client with error mapping
  - `prompts.ts`
  - `extract.ts`: LLM extraction, validation, heuristic fallback
  - `verify.ts`: T1/T2 ladder, verdict, quote verification
  - `store.ts`: `node:sqlite`
  - `learn.ts`: class posteriors
  - `cache.ts`: Bifrost cache actions
  - `events.ts`
  - `pipeline.ts`: the orchestrator
  - `server.ts`: API, auth, SSE, playground, static
  - `main.ts`
- **Tests** (`npm test`): **35/35 PASS**.
  - `model.test.ts`: math against analytic Lomax for every class; dates; cutoffs; evidence rules; text checks.
  - `pipeline.test.ts`:
    - the full flow: extraction → strong evidence → learning → cache invalidation
    - cache-hit linking
    - T0 reuse
    - no search, or no LLM, gives labelled limitations
    - heuristic fallback
    - verify and budget caps
    - 402 handling
    - fabricated quotes give `unverifiable`
    - verify-mode annotation
    - the loop guard
    - input validation
    - reuse-window cache expiry
  - `http.test.ts`: auth scopes; 415/400/413; console token; path traversal; LLM client headers, step-down, 402 and timeout; Tavily relay request shape and error mapping.
- **Bugs fixed:**
  - The λ grid lower bound truncated the static-definition prior. Fix: the grid now spans 1e-9 to 1e5 with 720 points.
  - A claim with retrieved evidence but no judge model was marked `unverifiable`. It is now `not_checked` with `limitation=no_judge`.

### Deploy (`deploy/`)
- **Files:**
  - `gateway.Dockerfile`: clones the Bifrost tag and checks the commit hash; dynamic build; `plugin-test` target; non-root runtime.
  - `engine.Dockerfile`
  - `render-config.mjs`: Bifrost `config.json` built from which keys are present, with `env.` references only.
  - `setup.mjs`: generates `deploy/.env` secrets.
  - `docker-compose.yml`
  - `test/fixtures.mjs`: TEST FIXTURE upstreams.
- **Integration** (`node deploy/test/integration.mjs`): **12/12 PASS** against real Bifrost v2.4.0, the real plugin and the real engine, with TEST FIXTURE upstreams.
  - Checks covered:
    - plugin active
    - stale answer → superseded verdict with strong evidence via the relay API
    - real cache entry invalidated, and the next request is a miss
    - cache hit linked with no LLM spend
    - stream report text equals the client text
    - verify mode adds an annotation and no-store
    - loop prevention
    - relay VK gating and route allow-list (engine refuses a request with no credential)
    - `/v1/check` via the relay
    - Tavily relay metered per credit, with 402 once a $0.01 budget is spent
    - engine stopped → inference still 200
    - plugin heartbeat
  - Results: `deploy/test/results/integration.json`.
- **Bugs found by the integration test:**
  1. `allowed_models: ["*"]` defers to Bifrost's model catalog (`framework/modelcatalog` `IsModelAllowedForProvider`), so the fixture's invented model names got 403 `model_blocked`. Fix: fixture mode lists them explicitly.
  2. `/api/governance/budgets` reads the config-store DB, which lags the in-memory usage, so `current_usage` showed 0. The test now proves enforcement directly, with a tiny-budget, fixture-only VK and a 402.

### Console (`engine/console/`)
- **Files:** `index.html`, `styles.css`, `lib.js`, `app.js`, `views/{inspector,check,model,system}.js`. Vanilla ES modules, strict CSP, light and dark tokens.
- **Status palette:** current = good, superseded = critical, contradicted = serious, at-risk-unchecked = warning. Always shown with an icon and a label.
- **Views:**
  - Inspector: feed, answer with claim spans, claim list, gateway and cache panel; claim panel with timeline, A/B/C measures and quote-verified sources.
  - Check: prompt via the gateway (async or verify), or paste text; live stages.
  - Freshness model: log-scale half-life chart for all classes, plus survival curve and table per class.
  - System: integration health, plugin counters, spend meter, policy.
- **Visual review:** headless Edge screenshots, since the Chrome extension wasn't connected.
- **Fixes after review:**
  - brand link colour
  - figures strip wrapping
  - claims table replaced by a list
  - selected-span outline
  - `minmax(0,1fr)` to stop overflow
  - pluralisation
  - cache actions filtered by report
  - integration health persisted across restarts
- **Note:** headless Edge clamps the window to about 500px wide, so a 390px screenshot looks clipped. At 600px the narrow layout fits.
