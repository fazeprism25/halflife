// Renders the Bifrost config.json and the engine's runtime defaults from which credentials are
// PRESENT in the environment. It never reads or writes a secret value: every credential in the
// output is an `env.NAME` reference that Bifrost resolves at runtime.
//
//   node deploy/render-config.mjs <out-dir>     (run by the `config` service in docker-compose)

import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "/bifrost";
const env = process.env;
const has = (k) => typeof env[k] === "string" && env[k].trim() !== "";

// Provider → key env var, default judge model, playground models (older knowledge cutoffs make
// stale answers easy to demonstrate; see engine/src/asof.ts for the cited cutoffs).
const PROVIDERS = [
  { id: "openai", key: "OPENAI_API_KEY", judge: "openai/gpt-4.1-mini", playground: ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"] },
  // DeepSeek (Bifrost's native provider, base URL https://api.deepseek.com). The judge runs
  // non-thinking: Halflife's calls are bounded extraction and quote-grounded classification, and
  // thinking mode (on by default upstream) ignores temperature and costs latency inside the job
  // budget (ARCHITECTURE_DECISIONS AD-17). The models are listed explicitly rather than "*", so the
  // allow-list doesn't depend on Bifrost's model catalog knowing the current DeepSeek names.
  {
    id: "deepseek", key: "DEEPSEEK_API_KEY", judge: "deepseek/deepseek-flash", playground: ["deepseek/deepseek-flash"],
    models: ["deepseek-flash", "deepseek-v4-pro"], judgeRequest: { thinking: { type: "disabled" } },
  },
  { id: "anthropic", key: "ANTHROPIC_API_KEY", judge: "anthropic/claude-haiku-4-5", playground: ["anthropic/claude-haiku-4-5"] },
  { id: "gemini", key: "GEMINI_API_KEY", judge: "gemini/gemini-2.5-flash", playground: ["gemini/gemini-2.0-flash", "gemini/gemini-2.5-flash"] },
  { id: "groq", key: "GROQ_API_KEY", judge: "groq/llama-3.3-70b-versatile", playground: ["groq/llama-3.3-70b-versatile"] },
  { id: "openrouter", key: "OPENROUTER_API_KEY", judge: "openrouter/openai/gpt-4.1-mini", playground: ["openrouter/openai/gpt-4o-mini"] },
  { id: "mistral", key: "MISTRAL_API_KEY", judge: "mistral/mistral-small-latest", playground: ["mistral/mistral-small-latest"] },
];

const fixture = has("HALFLIFE_FIXTURE_UPSTREAM") ? env.HALFLIFE_FIXTURE_UPSTREAM.replace(/\/+$/, "") : null;
const providers = {};
const present = [];
for (const p of PROVIDERS) {
  if (!has(p.key)) continue;
  present.push(p);
  providers[p.id] = {
    keys: [{ name: `${p.id}-primary`, value: `env.${p.key}`, weight: 1, models: ["*"] }],
    network_config: { default_request_timeout_in_seconds: 120, max_retries: 1 },
  };
}
if (has("HALFLIFE_OLLAMA_URL")) {
  providers.ollama = {
    keys: [{ name: "local-ollama", weight: 1, models: ["*"], ollama_key_config: { url: env.HALFLIFE_OLLAMA_URL } }],
    network_config: { default_request_timeout_in_seconds: 300, max_retries: 0, allow_private_network: true },
  };
}
if (fixture) {
  // TEST FIXTURE ONLY (deploy/test): an OpenAI-wire-compatible scripted upstream. Every answer it
  // produces is marked [TEST FIXTURE]. Never enabled unless HALFLIFE_FIXTURE_UPSTREAM is set.
  providers.openai = {
    keys: [{ name: "test-fixture", value: "fixture-not-a-secret", weight: 1, models: ["*"] }],
    network_config: { base_url: `${fixture}/openai`, allow_private_network: true, default_request_timeout_in_seconds: 30, max_retries: 0 },
  };
  // TEST FIXTURE ONLY: Bifrost's native DeepSeek provider aimed at the fixture, so the integration
  // test can assert what the provider sends (json_schema downgrade, thinking passthrough, auth).
  providers.deepseek = {
    keys: [{ name: "test-fixture", value: "fixture-not-a-secret", weight: 1, models: ["*"] }],
    network_config: { base_url: `${fixture}/deepseek`, allow_private_network: true, default_request_timeout_in_seconds: 30, max_retries: 0 },
  };
}

const tavily = has("TAVILY_API_KEY") || !!fixture;
const providerIds = Object.keys(providers);
// "*" defers to Bifrost's model catalog (framework/modelcatalog IsModelAllowedForProvider), which does
// not know the fixture's invented model names, so fixture mode lists them explicitly.
const allowedModels = (id) => (fixture && id === "openai" ? ["fixture-gpt-4o-mini", "fixture-judge"] : PROVIDERS.find((p) => p.id === id)?.models ?? ["*"]);
const providerConfigs = providerIds.map((id) => ({ provider: id, allowed_models: allowedModels(id), key_ids: ["*"], weight: 1 }));
const cacheTTL = Number(env.HALFLIFE_CACHE_TTL_SECONDS ?? 3600);

const config = {
  $schema: "https://www.getbifrost.ai/schema",
  client: { enable_logging: true, drop_excess_requests: false },
  config_store: { enabled: true, type: "sqlite", config: { path: "/data/config.db" } },
  logs_store: { enabled: true, type: "sqlite", config: { path: "/data/logs.db" } },
  vector_store: { enabled: true, type: "chromem", config: {} },
  providers,
  plugins: [
    {
      // Exact-match (direct) caching: dimension 1 and no embedding provider, so semantically
      // "similar" prompts never share an answer.
      enabled: true, name: "semantic_cache",
      config: { dimension: 1, ttl: `${cacheTTL}s`, default_cache_key: "halflife", vector_store_namespace: "Halflife" },
    },
    {
      enabled: true, name: "halflife", path: "/opt/bifrost/halflife.so", placement: "post_builtin",
      config: {
        engine_url: "http://engine:8090",
        ingest_token_env: "HALFLIFE_INGEST_TOKEN",
        internal_token_env: "HALFLIFE_INTERNAL_TOKEN",
        default_mode: env.HALFLIFE_DEFAULT_MODE || "async",
        cache_ttl_seconds: cacheTTL,
        annotate_verified: true,
        stream_note: env.HALFLIFE_STREAM_NOTE === "1",
      },
    },
  ],
  relays: [
    {
      name: "halflife",
      description: "Halflife freshness API (claim-level reports, /v1/check)",
      base_url: "http://engine:8090",
      auth: { type: "bearer" },
      credential: { value: "env.HALFLIFE_RELAY_TOKEN" },
      usage: { cost_per_request: 0 },
      routes: [
        { method: "GET", path: "/v1/health" },
        { method: "GET", path: "/v1/status" },
        { method: "GET", path: "/v1/classes" },
        { method: "GET", path: "/v1/reports" },
        { method: "GET", path: "/v1/reports/*" },
        { method: "POST", path: "/v1/check" },
      ],
      network: { timeout_seconds: 90 },
    },
    ...(tavily
      ? [{
          name: "tavily",
          description: "Tavily search/extract for claim verification. Priced per Tavily credit; budget enforced per virtual key.",
          base_url: fixture ? `${fixture}/tavily` : "https://api.tavily.com",
          auth: { type: "bearer" },
          credential: { value: fixture ? "fixture-not-a-secret" : "env.TAVILY_API_KEY" },
          usage: { cost_per_request: 0, units_path: "usage.credits", cost_per_unit: 0.008 },
          // GET /usage is free (no credits); the engine's credit guard reads it before paid calls (AD-19).
          routes: [{ method: "POST", path: "/search" }, { method: "POST", path: "/extract" }, { method: "GET", path: "/usage" }],
          network: { timeout_seconds: 30 },
        }]
      : []),
  ],
  setup_token: "env.BIFROST_ADMIN_TOKEN",
  governance: {
    virtual_keys: [
      {
        id: "vk-halflife-engine", name: "halflife-engine", value: "env.HALFLIFE_ENGINE_VK",
        description: "Halflife engine: extraction/verdict LLM calls and Tavily relay",
        provider_configs: providerConfigs,
        relay_grants: tavily ? [{ relay_name: "tavily" }] : [],
      },
      {
        id: "vk-halflife-demo", name: "halflife-demo-app", value: "env.HALFLIFE_DEMO_VK",
        description: "Example application traffic (console playground) and Halflife API access",
        provider_configs: providerConfigs,
        relay_grants: [{ relay_name: "halflife" }],
      },
      ...(fixture
        ? [{
            // TEST FIXTURE ONLY: a tiny-budget key that proves Bifrost meters Tavily credits.
            id: "vk-halflife-budget-probe", name: "halflife-budget-probe", value: "env.HALFLIFE_DEMO_VK_PROBE",
            description: "integration test: relay budget enforcement", provider_configs: [], relay_grants: [{ relay_name: "tavily" }],
          }]
        : []),
    ],
    budgets: [
      ...(fixture ? [{ id: "budget-halflife-budget-probe", max_limit: 0.01, reset_duration: "1d", virtual_key_id: "vk-halflife-budget-probe" }] : []),
      { id: "budget-halflife-engine", max_limit: Number(env.HALFLIFE_ENGINE_BUDGET_USD ?? 2), reset_duration: "1d", virtual_key_id: "vk-halflife-engine" },
      { id: "budget-halflife-demo", max_limit: Number(env.HALFLIFE_DEMO_BUDGET_USD ?? 1), reset_duration: "1d", virtual_key_id: "vk-halflife-demo" },
    ],
  },
};

const judgeDefault = fixture ? "openai/fixture-judge" : present[0]?.judge ?? (providers.ollama ? `ollama/${env.HALFLIFE_OLLAMA_MODEL || "qwen3:8b"}` : "");
const runtime = {
  llm_model: env.HALFLIFE_LLM_MODEL || judgeDefault,
  playground_models: env.HALFLIFE_PLAYGROUND_MODELS
    ? env.HALFLIFE_PLAYGROUND_MODELS.split(",").map((s) => s.trim()).filter(Boolean)
    : fixture ? ["openai/fixture-gpt-4o-mini"] : present.flatMap((p) => p.playground).concat(providers.ollama ? [`ollama/${env.HALFLIFE_OLLAMA_MODEL || "qwen3:8b"}`] : []),
  // Per-provider request fields for the engine's own judge calls (keyed by model prefix).
  llm_extra_body: Object.fromEntries(present.filter((p) => p.judgeRequest).map((p) => [p.id, p.judgeRequest])),
  tavily_enabled: tavily,
  cache_ttl_seconds: cacheTTL,
  providers: providerIds,
  fixture_mode: !!fixture,
};

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "config.json"), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(out, "runtime.json"), JSON.stringify(runtime, null, 2));
console.log(`[config] providers=${providerIds.join(",") || "none"} tavily=${tavily} judge=${runtime.llm_model || "none"} fixture=${!!fixture}`);
if (!providerIds.length) console.log("[config] no LLM provider key found: Halflife will use rule-based extraction and cannot judge verdicts");
if (!tavily) console.log("[config] TAVILY_API_KEY not set: claims will be assessed but not verified against live sources");
