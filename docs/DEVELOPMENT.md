# Development

How to work on Halflife: layout, the test suites, live checks against real services, and debugging.

## Repository layout for developers

| Path | Language | Notes |
|---|---|---|
| `engine/src/*.ts` | TypeScript run directly by Node 24 | **erasable syntax only**: no `enum`, `namespace` or constructor parameter properties; imports use explicit `.ts` extensions (AD-03) |
| `engine/test/*.test.ts` | `node:test` | `fakes.ts` holds test-only fakes, labelled as such |
| `engine/console/` | vanilla ES modules | no build step; served by the engine |
| `plugin/*.go` | Go | compiled inside Bifrost's `transports` module; stdlib + `core/schemas` only |
| `deploy/` | Node scripts, Dockerfiles, Compose | `render-config.mjs` is the single place that writes Bifrost config |
| `eval/` | Node scripts | evaluation sets, runners, scorer |
| `shared/temporal-cues.json` | JSON | cue groups used by both plugin and engine — changing it affects both |

There are **no npm dependencies** anywhere: no `npm install` step. Keep it that way unless there is a strong reason (record it as an architecture decision).

## Test suites

| Suite | Command | Needs | Spend |
|---|---|---|---|
| Engine (75 tests) | `cd engine && npm test` | Node 24 | none |
| Extension (8 adapter + 6 end-to-end) | `node --test "extension/test/*.test.mjs"` | Node 24, Edge or Chrome, openssl | none (test fixtures) |
| Console UI (13 checks: collapsible sidebar and Traffic, keyboard, live updates, desktop/tablet/phone layouts, themes, System provider usage states) | `node --test engine/test/console-ui.test.mjs` | Node 24, Edge or Chrome | none (test fixtures) |
| Engine import check | `node engine/scripts/check-imports.mjs` | Node 24 | none |
| Plugin (21 Go tests with `-race`, `go vet`, benchmarks) | `docker build -f deploy/gateway.Dockerfile --target plugin-test --no-cache-filter plugin-test --progress=plain .` | Docker | none |
| Integration (13 end-to-end checks) | `node deploy/test/integration.mjs` | Docker, port 8080 free | none (test fixtures) |

Notes:
- **`--no-cache-filter plugin-test` matters.** Without it Docker may replay the cached test layer and print old results without running the tests.
- The integration suite builds the images, starts the real gateway, plugin and engine with `deploy/test/fixtures.mjs` standing in for the LLM provider and Tavily (every fixture output is marked `[TEST FIXTURE]`, domains are `example.*`), runs its checks, and tears the stack down. It uses a separate Compose project (`halflife-it`) with freshly generated secrets and **blanks all provider keys**, so your real keys and your normal stack's volumes are never touched. Results go to `deploy/test/results/integration.json` and a redacted log (both gitignored). Set `NO_BUILD=1` to reuse already-built images.
- If your normal stack is running, stop it first (`docker compose -f deploy/docker-compose.yml stop`), then start it again afterwards with `up -d --no-build`.

What the integration suite covers: plugin active; stale answer → superseded verdict through the relay API; a real Bifrost cache entry invalidated and the next request a miss; cache hit linked with no LLM spend; stream report text equals client text; verify mode annotation and `no-store`; loop prevention; relay VK gating and route allow-list; `/v1/check` via the relay; Tavily relay metered per credit with 402 when a tiny budget is spent; engine stopped → inference still 200; plugin heartbeat; DeepSeek provider wire behaviour (JSON-schema downgrade, thinking passthrough) against the fixture.

## Live checks (real services; spend credits)

These call real DeepSeek and Tavily through the running stack. Each one calls `preflight()` from `deploy/test/spend-guard.mjs` before starting — which refuses if the planned worst case would cross the Tavily ceiling — and `reconcile()` afterwards, which appends actual spend to a local ledger (`deploy/test/results/spend-ledger.jsonl`, gitignored).

```bash
node deploy/test/live-tavily.mjs       # 1 search + 1 extract through the relay (≤ 2 credits)
node deploy/test/live-deepseek.mjs     # auth, structured output, /v1/check end to end (≤ 6 credits)
node deploy/test/live-e2e.mjs          # 5 prompt types through the gateway (≤ 6 credits each)
node deploy/demo/run-demo.mjs          # the demo steps, with a transcript
```

Evaluation runners are described in [EVALUATION.md](EVALUATION.md).

**Rules for live work:**
- Never print key values; check a key by its length only.
- Tavily's own usage counter lags by hours. Trust the engine's `/v1/status` → `spend` and the ledger, not the dashboard.
- Never enable Tavily pay-as-you-go; the guard refuses to spend if any pay-as-you-go usage appears.

## Running the engine without Docker

For quick iteration on the engine alone:

```bash
cd engine
npm start            # node src/main.ts, listens on :8090, data in engine/data/ (gitignored)
```

Without a gateway (`BIFROST_URL`, default `http://localhost:8080`) and tokens, the engine runs in a degraded mode: no LLM (heuristic extraction), no Tavily (claims "not checked"), and API callers other than the console are rejected. This is useful for console and pipeline work; use the Compose stack for anything involving the gateway.

## Iterating on the stack

```bash
# rebuild only the engine image (fast) and restart
docker compose -f deploy/docker-compose.yml build config
docker compose -f deploy/docker-compose.yml up -d --no-build

# rebuild everything (gateway compile takes minutes)
docker compose -f deploy/docker-compose.yml up -d --build
```

The `config` and `engine` services share the `halflife-engine:local` image, so building `config` rebuilds the engine. For console-only changes you can copy files into the running container (it serves `max-age=300`, so hard-refresh):

```powershell
docker cp engine/console/. halflife-engine-1:/app/engine/console/
```

Rebuild the image before you finish, so the image matches the source.

## Debugging

| Need | How |
|---|---|
| Engine logs | `docker logs -f halflife-engine-1` |
| Gateway and plugin logs | `docker logs -f halflife-gateway-1` (plugin lines are prefixed `[halflife]`) |
| Current status, spend, guard state | console **System** page, or `GET /relay/halflife/v1/status` |
| A specific report | console **Inspector**, or `GET /relay/halflife/v1/reports/{id}` (ID from the `x-halflife-report` header) |
| Rendered Bifrost config | `docker compose -f deploy/docker-compose.yml logs config` shows which providers, Tavily and judge model were detected; the file itself is `/bifrost/config.json` in the `bifrost-config` volume and contains only `env.NAME` references |
| Engine database | the `engine-data` volume (`/data/halflife.db` in the container); inspect read-only with `node:sqlite` or any SQLite client, and back it up before modifying |

## Coding conventions

- Small, explicit modules; no frameworks. Keep the plugin's per-request work in microseconds and allocation-light (there are benchmarks).
- Every plugin hook must recover panics and fail open.
- Anything the LLM returns must be validated in code before it is used; no LLM-produced numbers enter the model (AD-09).
- Never fabricate a result: when a dependency is missing or a limit is hit, report a labelled limitation (`not_checked`, `unverifiable` with a reason).
- Test-only behaviour lives under `engine/test/` or `deploy/test/` and is labelled.
- Decisions go into `research/ARCHITECTURE_DECISIONS.md`; notable changes and test results into `research/IMPLEMENTATION_LOG.md` and `CHANGELOG.md`.
- **Do not edit files containing regular expressions through shell heredocs**; escaping has silently corrupted backslashes in this project before. Use an editor.
