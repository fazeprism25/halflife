# Next Session

_Read `PROJECT_STATE.md` first, then this file. Updated in session 9 (2026-11-02): published on GitHub._

## Session 9 summary (publication)
- **Public repository:** <https://github.com/fazeprism25/halflife> (public, default branch `main`, Apache-2.0 detected, no Actions workflows).
- Root commit recreated with the GitHub noreply identity (repository-local config) and UTC timestamps: `f42d3bf73602d3e52d46cb01bcec9faec29c8ea1`. Record updates follow as a second commit.
- **Committing from now on:** keep timestamps in UTC, e.g. `GIT_AUTHOR_DATE="$(date -u +%s) +0000" GIT_COMMITTER_DATE="$(date -u +%s) +0000" git commit …`. A plain `git commit` stamps the local offset.
- **Still needs the operator:** record the demo video; confirm the official problem wording; submit the entry (the operator does this). Optionally replace "The Halflife authors" in `NOTICE`.

## Session 8 summary (clean history)
- **Operator decision:** replace the local history with one clean root commit (AD-31 option (a)).
- **Done:** old history backed up privately outside the repository (verified bundle plus `.git` copy); tree audited; orphan commit "Initial public release: Halflife freshness verification platform" on `main`, no parent; old branch deleted, reflogs expired, unreachable objects pruned. `git log` shows the hash.
- Then published in session 9 (see above).

## Session 7 summary (publication preparation)
- **Operator decisions:** Apache-2.0; FreshQA CSVs excluded; demo transcript private; screenshots only with the time zone removed.
- **Done:**
  - `LICENSE` (official text), `NOTICE`, `THIRD_PARTY_NOTICES.md`.
  - Sanitised screenshots in `docs/assets/screenshots/`: clock times and the zone are blanked; the originals in `deploy/demo/backup/` are now gitignored.
  - FreshQA-derived verbatim files withdrawn and gitignored: set, raw runs, `latest-freshqa.md`.
  - README, EVALUATION, CONTRIBUTING, CHANGELOG and the research notes updated; AD-31.
- **Commit:** a second local commit (119 tracked files). Both pre-release commits were replaced in session 8.
- To rebuild the FreshQA files on this machine: they are still on disk (gitignored), so `node eval/freshqa-score.mjs` works here.

## Session 6 summary (repository)
- `git init -b main`; one local commit, "Initial commit: Halflife freshness verification platform", 122 files. **No remote. Not pushed.** (Replaced in session 8.)
- Docs written: README rewrite, `docs/{ARCHITECTURE,INSTALLATION,DEVELOPMENT,SECURITY,EVALUATION}.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `research/README.md`, `experiments/README.md`. Decisions AD-29 (what is committed) and AD-30 (licence recommendation).
- The session 6 approval items (licence, FreshQA CSVs, demo transcript, screenshots) were decided in session 7; see above.
- **Remaining issues:** the integration suite was not re-run in session 6 (no code changed); there is no CI.

## State in one paragraph
The product is feature-complete and verified with real services:
- The console was audited against real reports, and 8 display or correctness bugs were fixed (AD-27).
- A reproducible FreshQA evaluation is done (AD-28): detection P/R 85.5% / 97.9%; verification stale precision 95.8% at ≥ moderate evidence, with every disputed item adjudicated with sources.
- The demo script, the runner and backup material exist. The transcript and the original stills are private; sanitised stills are in `docs/assets/screenshots/`.
- A submission draft is written.

Quality gate passed: 54 engine tests, 21 Go tests with `-race`, 13 integration checks, a clean setup from a copied tree, and 0 secrets in files. **Published on GitHub (<https://github.com/fazeprism25/halflife>); nothing has been submitted or deployed.**

## Spending (absolute; AD-19)
- **Tavily: 129 of 1000 credits used** (engine 128 + 1 direct). The ceiling is 800 and the 200-credit reserve is untouched. Pay-as-you-go 0. **Tavily stays at $0.**
  - The engine's **daily cap is 150 and 128 were used on 2026-11-02**, so the cap resets the next day.
- **DeepSeek:** about $0.07 actual of the $1 dev budget (balance $5.82). Never top up.
- **Every live script must use `preflight` / `reconcile`** from `deploy/test/spend-guard.mjs`.
  - Tavily's `/usage` counter lags **hours**; trust `/relay/halflife/v1/status` → `spend.total_credits` plus the ledger.
- **Final demo only:** `HALFLIFE_TAVILY_CEILING_FRACTION=0.95` in `deploy/.env`, then restart the engine.
- Never print `.env` values. Check key lengths only.

## Environment gotchas (all seen this session)
- **Disk:** 4.5 GB free on C:. Rebuild only the engine: `docker compose -f deploy/docker-compose.yml build config && … up -d --no-build`.
- **Console changes** can be hot-copied: `docker cp engine/console/. halflife-engine-1:/app/engine/console/`. Rebuild before you finish.
- **Headless Edge screenshots:**
  - Use a fresh `--user-data-dir` per shot (the console is served with `max-age=300`).
  - Write into the scratchpad: a path with spaces silently fails.
  - Use PowerShell `Start-Process … -Wait`.
- **`docker cp` with host paths: use PowerShell.** Git Bash mangles `/c/...`.
- **Never edit regexes through shell heredocs.** It happened again this session (a literal backspace). Use the Edit tool, or a Node script written with the Write tool.
- **Integration suite** (port 8080):
  1. `docker compose -f deploy/docker-compose.yml stop`
  2. `NO_BUILD=1 node deploy/test/integration.mjs`
  3. `up -d --no-build`
- **Go tests:** `docker build -f deploy/gateway.Dockerfile --target plugin-test --no-cache-filter plugin-test --progress=plain .` The filter is needed, or Docker replays the cached test layer without running it.
- **The shell environment exports `DEEPSEEK_API_KEY`.** Compose prefers it over `deploy/.env`.
- **DeepSeek defaults to thinking:** clients must send `thinking: {type: "disabled"}`, or small `max_tokens` budgets return empty content.

## Exact next actions
1. **Record the demo video. Needs the human operator** (no screen recorder or Chrome extension was available to the agent).
   - Run `node deploy/demo/run-demo.mjs` once to warm up. Then record the steps of `research/DEMO_SCRIPT.md` in the console with Xbox Game Bar (Win+Alt+R).
   - Verifications done on 2026-11-02 are reused within their windows (0 credits). Step 2b (NBA champion) forces a fresh search.
2. **Confirm the official Problem 04 and 06 wording and the rubric.** Needs the operator; there is no public page. Then update the mapping tables in `research/SUBMISSION.md`.
3. **Optional engineering**, cheapest first:
   - a quantity/count guard (FreshQA B-229: "1 SLS flight" judged current while the evidence said 2)
   - re-judge the FreshQA error items with `HALFLIFE_LLM_MODEL=deepseek/deepseek-v4-pro`, using `--only` and `--tag`; at most 10 credits
   - authoritative-source preference for `current_value`
   - observation de-duplication by `norm_key`
4. **Repository:** published at <https://github.com/fazeprism25/halflife> (session 9). Before every push, re-run the secret scan on `git ls-files` and commit with UTC timestamps.
5. **Before submission:**
   - Re-run `node eval/freshqa-score.mjs`. Then make sure the numbers in `README.md`, `SUBMISSION.md` and `DEMO_SCRIPT.md` match `eval/results/latest-freshqa.md`.
   - **Submit only with explicit operator authorisation.** Deadline 2026-11-15.

## Important files (new this session)
- **Evaluation:**
  - `eval/freshqa-{lib,build,run,score}.mjs`
  - `eval/freshqa-set.json`
  - `eval/freshqa-adjudications.json`
  - `eval/data/freshqa/*.csv`
  - `eval/results/latest-freshqa.md`
  - Raw runs: `eval/results/freshqa-{A,BC,rerun-futurechange}-*.json`
- **Demo:**
  - `research/DEMO_SCRIPT.md`
  - `deploy/demo/run-demo.mjs`
  - `deploy/demo/results/demo-2026-11-02T16-04-21-277Z.md`
  - `deploy/demo/backup/01…07-*.png`
- **Submission:** `research/SUBMISSION.md`
- **Decisions:** AD-23 to AD-28 in `research/ARCHITECTURE_DECISIONS.md`
- **Logs and backups:**
  - `deploy/test/results/plugin-test-2026-11-02.log`
  - DB backup: `engine/data/backup-before-eval-obs-removal.db` (gitignored)

## Decisions awaiting validation
- **θ = 0.2:** almost every time-sensitive claim with an unknown as-of date crosses it (47 of 47 in FreshQA). θ only filters claims whose as-of date is recent. It's fine for cost at demo scale.
- **Judge: flash vs Pro.** Flash made 2 reasoning errors on 59 FreshQA items (dates, counts). Pro is untested.
- **P(outdated) is still uncalibrated.** FreshQA B/C items are selected, so they can't calibrate it. Calibration would need a random sample of claims from real traffic.
