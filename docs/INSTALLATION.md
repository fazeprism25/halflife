# Installation

This guide takes a clean machine to a running Halflife stack: the Bifrost gateway with the Halflife plugin, and the Halflife engine with its console.

## 1. Prerequisites

| Requirement | Version / notes |
|---|---|
| Docker Engine with **Compose v2** | Docker Desktop on Windows (WSL 2 backend) or macOS; Docker Engine + `docker compose` plugin on Linux |
| **Node.js 24+** | Runs `deploy/setup.mjs`, the engine tests and the scripts. The engine uses Node 24's native TypeScript type stripping and `node:sqlite`; older versions will not work. |
| Git | to clone the repository |
| Disk | about **5 GB free** for the first build (Go toolchain image, Bifrost module cache and build cache) |
| Memory | 8 GB+ recommended; the Go build is limited to 3 parallel packages (`GOFLAGS=-p=3`) to fit Docker Desktop on a 16 GB host |
| Network | the gateway build clones `https://github.com/maximhq/bifrost.git`; at runtime the gateway calls your LLM provider and `api.tavily.com` |

You do **not** need Go installed on the host: the gateway and plugin are compiled inside the `golang:1.27.3-bookworm` image. Native Windows cannot build Go plugins in any case.

### Accounts and keys (optional but needed for live verification)

| Key | Where | Used for |
|---|---|---|
| `TAVILY_API_KEY` | <https://app.tavily.com> | live evidence search and extract |
| `DEEPSEEK_API_KEY` | <https://platform.deepseek.com/api_keys> | claim extraction and verdicts (the account needs a positive balance, otherwise DeepSeek returns HTTP 402) |

Without keys the stack still starts: without an LLM key extraction falls back to a labelled rule-based extractor and no verdicts are made; without a Tavily key risky claims are reported as "not checked". Other providers (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`) are supported by the config renderer but have **not** been tested live in this project.

## 2. Get the code

```bash
git clone <repository-url> halflife
cd halflife
```

## 3. Create `deploy/.env`

```bash
node deploy/setup.mjs
```

This creates `deploy/.env` (mode 600 where the filesystem supports it) with freshly generated local secrets — ingest, internal and relay tokens, the Bifrost admin token, and two virtual keys — plus empty placeholders for provider keys. It prints variable **names only**. Running it again keeps existing values and adds any that are missing.

Open `deploy/.env` in an editor and set:

```dotenv
TAVILY_API_KEY=<your Tavily key>
DEEPSEEK_API_KEY=<your DeepSeek key>
```

`deploy/.env.example` documents every variable; the most useful optional ones are listed in [section 6](#6-configuration-reference). Never commit `deploy/.env` (it is gitignored).

> **Shell variables win.** Compose interpolates `${DEEPSEEK_API_KEY:-}` etc. from your shell environment **before** `deploy/.env`. If a provider key is exported in your shell, that value is used even if `deploy/.env` is empty or different. Unset it (`unset DEEPSEEK_API_KEY` in bash, `Remove-Item Env:DEEPSEEK_API_KEY` in PowerShell) if that is not what you want.

## 4. Build and start

### Windows (PowerShell)

```powershell
# Docker Desktop must be running (WSL 2 backend)
node deploy/setup.mjs
notepad deploy\.env                      # add TAVILY_API_KEY and DEEPSEEK_API_KEY
docker compose -f deploy/docker-compose.yml up --build -d
docker ps                                # wait until halflife-gateway-1 and halflife-engine-1 are "healthy"
```

Windows notes:
- Check free space first: `Get-PSDrive C`. A full disk during the build can crash Docker Desktop; `docker builder prune` frees build cache.
- If you use Git Bash, prefer PowerShell for `docker cp` with host paths (Git Bash rewrites `/c/...` paths).

### Linux / macOS (bash or zsh)

```bash
node deploy/setup.mjs
${EDITOR:-nano} deploy/.env              # add TAVILY_API_KEY and DEEPSEEK_API_KEY
docker compose -f deploy/docker-compose.yml up --build -d
docker ps                                # wait for both containers to be "healthy"
```

On Linux, run Docker as a user in the `docker` group or prefix with `sudo`. On Apple Silicon the images build for `arm64` natively; this configuration has only been exercised on x86-64 (Windows + WSL 2).

The first build clones Bifrost at tag `transports/v2.4.0`, verifies the commit (`e869c3f`), and compiles the gateway and the plugin; expect several minutes. Later starts use the cache.

## 5. Verify the installation

| Check | How |
|---|---|
| Engine health | `curl http://localhost:8090/v1/health` → `{"ok":true,...}` |
| Gateway health | `curl http://localhost:8080/health` |
| Console | open <http://localhost:8090> → **System** page: Bifrost "Reachable", plugin "Reporting", judge model and Tavily "Working" once used |
| End-to-end | send a prompt from the console's **Check** page, or use the `curl` examples in the [README](../README.md#usage) |

To confirm the live DeepSeek setup end to end (spends a few cents of DeepSeek and up to 6 Tavily credits, guarded):

```bash
node deploy/test/live-deepseek.mjs
```

## 6. Configuration reference

Set these in `deploy/.env` (or your shell). Defaults in parentheses.

| Variable | Purpose |
|---|---|
| `TAVILY_API_KEY`, `DEEPSEEK_API_KEY`, … | provider credentials, held by the gateway only |
| `HALFLIFE_LLM_MODEL` (from first key present; `deepseek/deepseek-flash` with DeepSeek) | judge model for extraction and verdicts |
| `HALFLIFE_LLM_FALLBACKS` | comma-separated Bifrost fallback models |
| `HALFLIFE_LLM_EXTRA_BODY` | JSON object replacing the judge's provider-specific request fields (default for DeepSeek: thinking disabled) |
| `HALFLIFE_PLAYGROUND_MODELS` | models offered on the console Check page |
| `HALFLIFE_DEFAULT_MODE` (`async`) | plugin mode when the request has no `x-halflife-mode` header |
| `HALFLIFE_CACHE_TTL_SECONDS` (`3600`) | Bifrost cache TTL; the plugin only ever lowers it |
| `HALFLIFE_DAILY_CREDIT_CAP` (`150`) | engine Tavily credits per day |
| `HALFLIFE_TOTAL_CREDIT_CAP` (`700`) | engine Tavily credits, lifetime |
| `HALFLIFE_TAVILY_CEILING_FRACTION` (`0.8`, max `0.95`) | share of the Tavily plan allowance the guard allows |
| `HALFLIFE_TAVILY_ACCOUNT_GUARD` (`1`) | read Tavily `/usage` before paid calls; fail closed |
| `HALFLIFE_ENGINE_BUDGET_USD` (`2`), `HALFLIFE_DEMO_BUDGET_USD` (`1`) | Bifrost daily dollar budgets on the engine and demo virtual keys |
| `HALFLIFE_CONSOLE_TOKEN` (empty) | require this token for console API calls (the console prompts for it) |
| `HALFLIFE_OLLAMA_URL` | add a local Ollama provider (e.g. `http://host.docker.internal:11434`); untested end to end |

Engine-only tuning variables (`HALFLIFE_THETA`, `HALFLIFE_MAX_VERIFY_PER_RESPONSE`, `HALFLIFE_CONCURRENCY`, `HALFLIFE_RETENTION_DAYS`, timeouts) are read in `engine/src/config.ts`; to use them with Compose, add them to the `engine` service's `environment` block.

After changing `deploy/.env`, recreate the containers so the config is re-rendered:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate
```

## 7. Stop, reset, uninstall

```bash
docker compose -f deploy/docker-compose.yml down        # stop; keeps reports and gateway state
docker compose -f deploy/docker-compose.yml down -v     # also deletes the volumes (all reports, learning, spend ledger)
docker image rm halflife-gateway:local halflife-engine:local
```

Note that `down -v` deletes the engine's persistent spend ledger, which the lifetime credit cap is computed from. The Tavily account guard still reads the account counter, but keep this in mind if you rely on the lifetime cap.

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `required variable HALFLIFE_INGEST_TOKEN is missing … run node deploy/setup.mjs first` | `deploy/.env` missing; run `node deploy/setup.mjs` |
| Build fails or Docker crashes mid-build | out of disk or memory; free space (`docker builder prune`), close memory-heavy apps, retry |
| `Bifrost ref transports/v2.4.0 is not commit e869c3f` | upstream tag moved; do not bypass the check without reviewing the change |
| Replies are empty with DeepSeek and the report says `skipped; no-text` | DeepSeek thinking used the token budget; send `"thinking":{"type":"disabled"}` or raise `max_tokens` |
| Console shows Tavily "not configured" | no `TAVILY_API_KEY` reached the `config` service; check `deploy/.env` and recreate |
| Claims show `not checked: budget` | a spend limit was reached (System page shows which); this is by design |
| HTTP 402 from DeepSeek | the DeepSeek account balance is exhausted |
| Console changes not visible | it is served with `max-age=300`; hard-refresh |
