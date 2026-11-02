# Security

Halflife is a hackathon prototype intended to run **locally** on a developer machine. It has not had an external security review and is not hardened for exposure to untrusted networks. This document states what it does protect, what it stores, and where the trust boundaries are.

## Reporting a vulnerability

There is no security contact or bug bounty yet. Do not open a public issue with exploit details; contact the repository owner privately (for example through their GitHub profile) and allow time to respond.

## Secrets

| Secret | Created by | Held by | Purpose |
|---|---|---|---|
| `TAVILY_API_KEY`, `DEEPSEEK_API_KEY` (and other provider keys) | you | gateway container environment only | upstream API access |
| `HALFLIFE_INGEST_TOKEN` | `setup.mjs` | gateway (plugin) and engine | plugin → engine ingest |
| `HALFLIFE_INTERNAL_TOKEN` | `setup.mjs` | gateway (plugin) and engine | marks the engine's own LLM calls so the plugin skips them |
| `HALFLIFE_RELAY_TOKEN` | `setup.mjs` | gateway and engine | Bifrost injects it on `/relay/halflife/*` so the engine can identify relayed calls |
| `BIFROST_ADMIN_TOKEN` | `setup.mjs` | gateway and engine | Bifrost setup/admin API, used by the engine for cache invalidation |
| `HALFLIFE_ENGINE_VK`, `HALFLIFE_DEMO_VK` | `setup.mjs` | gateway, engine, scripts | Bifrost virtual keys with daily dollar budgets |
| `HALFLIFE_CONSOLE_TOKEN` | you (optional) | engine | console access |

Handling rules implemented in the code:
- All secrets live in `deploy/.env` (gitignored, created with mode 600 where supported) or your shell environment. `deploy/.env.example` contains placeholders only.
- The rendered Bifrost `config.json` contains `env.NAME` references, never secret values (`deploy/render-config.mjs`).
- The engine **never receives provider or Tavily keys**; Tavily is reached only through the Bifrost relay, which holds the key.
- Scripts print variable names, never values. `setup.mjs` prints names only. The integration suite generates throwaway secrets and blanks all provider keys.
- Token comparisons in the engine use constant-time equality.
- Virtual keys seen by the plugin are stored only as a short SHA-256 fingerprint.
- The integration test log is redacted before it is written.

Before committing, scan for secrets (the repository was scanned for the literal `.env` values and common key patterns before the initial commit). Remember that **Compose reads provider keys from the shell environment before `deploy/.env`**.

## Data handled and stored

| Data | Where | Retention |
|---|---|---|
| Prompts and answers passing through the gateway (truncated), extracted claims, verdicts, evidence excerpts and URLs, spend | engine SQLite, Docker volume `engine-data` | reports older than `HALFLIFE_RETENTION_DAYS` (default 14) are deleted by a sweep; learning observations and the spend ledger are kept |
| Bifrost request logs and governance state | gateway SQLite (`logs.db`, `config.db`), volume `gateway-data` | Bifrost's own behaviour; `config.db` is recreated on each start |
| Cached answers | Bifrost semantic cache (in-memory vector store) | until TTL, invalidation or restart |

Data leaving the machine:
- Prompts and answers go to the configured **LLM provider** (application traffic, and Halflife's extraction and verdict calls).
- Claim text (as search queries) and source URLs go to **Tavily**.
- Nothing is sent anywhere else. There is no telemetry.

Do not route confidential or personal data through Halflife unless your agreements with the LLM provider and Tavily allow it. A local Ollama provider can be configured (`HALFLIFE_OLLAMA_URL`) for extraction and verdicts, but this path is untested end to end, and verification still sends claim text to Tavily.

## Network exposure

- Compose binds the gateway (8080) and the engine/console (8090) to **127.0.0.1** only.
- **The console has no authentication unless `HALFLIFE_CONSOLE_TOKEN` is set.** Any process on the machine that can reach port 8090 can read every stored report and use the playground (which spends against the demo virtual key's budget). Set the token if the machine is shared, and never publish port 8090.
- The console is served with a strict Content Security Policy and rejects path traversal for static files.
- Engine API routes are separated by caller: the plugin can only ingest and heartbeat; relayed callers get the read and `/v1/check` routes; only the console gets `/v1/events` and `/v1/playground`. Requests with no valid credential get 401.
- The relay exposes only an allow-listed set of engine routes and requires a virtual key with the relay grant.

## Browser extension (AD-32)

- **What leaves the browser:** only after the user clicks **Check freshness**, and only to a loopback engine address. The request holds:
  - that answer
  - the user message before it
  - ChatGPT's message id and the model slug
  - SHA-256 of the conversation id

  There is no background capture and no telemetry, and the extension never reads ChatGPT's session token.
- **Pairing:** the console (authenticated) creates a one-time 8-character code valid for 10 minutes. The extension exchanges it from its `chrome-extension://` origin for a random 256-bit token. The engine stores only the token's SHA-256 and the origin.
- **Origin binding:** a request with a different `Origin` is refused.
- **Loopback only:** `/v1/extension/*` is served only for a loopback `Host` header (DNS-rebinding defence). Through the Bifrost relay those routes return 403.
- **Token scope:** create checks, read its own checks, minimal status. Nothing else.
- **Token storage:** the service worker's IndexedDB, not `chrome.storage.local`, which content scripts running in the ChatGPT page can read.
- **Server-side limits:** strict schema with unknown fields refused, answer ≤ 60,000 characters, question ≤ 4,000, per-minute and daily limits, a kill switch, and an estimate-only mode (0 search credits).
- **Data:** extension checks can be deleted individually or all at once, and expire after their own retention period (default 30 days). Revoke a browser from the console or with **Disconnect** in the popup.
- **Residual risks:**
  - Another local process that obtains the token can submit checks. The token is the secret; the origin check only stops web pages.
  - Without `HALFLIFE_CONSOLE_TOKEN`, any local process can create pairing codes, like every other console route.

## Threat boundaries

| Threat | Mitigation | Residual risk |
|---|---|---|
| Prompt injection in answers or web pages steering the judge | text and evidence passed as delimited, untrusted JSON data; outputs schema-validated; spans must occur in the answer and quotes in the source; verdicts without verified quotes discarded | a judge can still choose a misleading but genuine quote; verdicts are advisory |
| Fabricated evidence or replacement values | quote verification in code; replacement values require a verified quote that states them | grounding is token-based and can accept a quote that contains the value in another sense (AD-20) |
| Clients bypassing Halflife by forging the internal header | the header must carry the secret internal token | anyone with the token can bypass analysis |
| Runaway spend | per-answer, daily, lifetime and account-level Tavily guards; Bifrost VK dollar budgets; fail-closed guard | the guard relies on local counting because Tavily's counter lags; deleting the engine volume resets the lifetime count |
| Plugin failure affecting inference | every hook recovers panics and fails open; bounded queue drops instead of blocking | none observed in tests; not load-tested |
| Supply chain | zero npm dependencies in the engine; Bifrost cloned at a pinned tag and commit hash checked; base images pinned by tag | base images are pinned by tag, not digest; Bifrost's own Go dependencies are trusted as published |
| Secrets in the repository | `.gitignore` excludes `.env`, data, logs and local results; pre-commit scan | manual process; no automated secret scanning in CI (there is no CI) |

## Out of scope

Multi-tenant isolation, authentication of end users, encryption at rest of the SQLite databases, TLS between containers, rate limiting of the console, and hardening for internet exposure.
