// Engine configuration from the environment. Secrets are read here and never logged; the
// status API reports only whether each one is present.

import fs from "node:fs";

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  bifrostUrl: string;
  engineVK: string;
  demoVK: string;
  internalToken: string;
  ingestToken: string;
  relayToken: string;
  consoleToken: string;
  adminToken: string;
  llmModel: string;
  llmFallbacks: string[];
  /** Provider-specific request fields for the judge model (e.g. DeepSeek thinking off). */
  llmExtraBody: Record<string, unknown>;
  tavilyEnabled: boolean;
  playgroundModels: string[];
  theta: number;
  maxVerifyPerResponse: number;
  dailyCreditCap: number;
  /** Lifetime credits the engine may spend (sum of its spend ledger). */
  totalCreditCap: number;
  /** Share of the Tavily plan allowance usable before the guard refuses (the rest is reserve). */
  tavilyCeilingFraction: number;
  /** Check Tavily account usage (GET /usage via the relay) before paid calls. Fails closed. */
  tavilyAccountGuard: boolean;
  concurrency: number;
  queueMax: number;
  llmTimeoutMs: number;
  searchTimeoutMs: number;
  extractTimeoutMs: number;
  jobBudgetMs: number;
  /** The semantic cache's configured TTL (the plugin only ever lowers it). */
  cacheTTLSeconds: number;
  retentionDays: number;
};

function num(v: string | undefined, def: number, lo: number, hi: number): number {
  const n = v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Request fields for the judge model. runtime.json carries them per provider prefix
 * ({"deepseek": {"thinking": {"type": "disabled"}}}). HALFLIFE_LLM_EXTRA_BODY (a JSON object)
 * replaces them for whatever model is configured. Invalid JSON is ignored.
 */
export function extraBodyFor(model: string, perProvider: unknown, override: string | undefined): Record<string, unknown> {
  if (override) {
    try {
      const o = JSON.parse(override);
      if (isObj(o)) return o;
    } catch {
      /* ignored: fall through to the rendered default */
    }
  }
  const provider = model.split("/")[0];
  return isObj(perProvider) && isObj(perProvider[provider]) ? perProvider[provider] : {};
}

/** Defaults rendered by deploy/render-config.mjs from which credentials exist (no secrets). */
function runtimeDefaults(env: NodeJS.ProcessEnv): Record<string, any> {
  const f = env.HALFLIFE_RUNTIME_FILE;
  if (!f || !fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const rt = runtimeDefaults(input);
  const env: NodeJS.ProcessEnv = {
    HALFLIFE_LLM_MODEL: rt.llm_model,
    HALFLIFE_PLAYGROUND_MODELS: Array.isArray(rt.playground_models) ? rt.playground_models.join(",") : undefined,
    HALFLIFE_TAVILY_ENABLED: rt.tavily_enabled === true ? "1" : undefined,
    HALFLIFE_CACHE_TTL_SECONDS: rt.cache_ttl_seconds !== undefined ? String(rt.cache_ttl_seconds) : undefined,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== "")),
  };
  return {
    host: env.HOST ?? "0.0.0.0",
    port: num(env.PORT, 8090, 1, 65535),
    dataDir: env.HALFLIFE_DATA_DIR ?? "./data",
    bifrostUrl: (env.BIFROST_URL ?? "http://localhost:8080").replace(/\/+$/, ""),
    engineVK: env.HALFLIFE_ENGINE_VK ?? "",
    demoVK: env.HALFLIFE_DEMO_VK ?? "",
    internalToken: env.HALFLIFE_INTERNAL_TOKEN ?? "",
    ingestToken: env.HALFLIFE_INGEST_TOKEN ?? "",
    relayToken: env.HALFLIFE_RELAY_TOKEN ?? "",
    consoleToken: env.HALFLIFE_CONSOLE_TOKEN ?? "",
    adminToken: env.BIFROST_ADMIN_TOKEN ?? "",
    llmModel: env.HALFLIFE_LLM_MODEL ?? "",
    llmFallbacks: list(env.HALFLIFE_LLM_FALLBACKS),
    llmExtraBody: extraBodyFor(env.HALFLIFE_LLM_MODEL ?? "", rt.llm_extra_body, env.HALFLIFE_LLM_EXTRA_BODY),
    tavilyEnabled: env.HALFLIFE_TAVILY_ENABLED === "1" || env.HALFLIFE_TAVILY_ENABLED === "true",
    playgroundModels: list(env.HALFLIFE_PLAYGROUND_MODELS),
    theta: num(env.HALFLIFE_THETA, 0.2, 0.01, 0.99),
    maxVerifyPerResponse: num(env.HALFLIFE_MAX_VERIFY_PER_RESPONSE, 3, 0, 20),
    dailyCreditCap: num(env.HALFLIFE_DAILY_CREDIT_CAP, 150, 0, 100000),
    totalCreditCap: num(env.HALFLIFE_TOTAL_CREDIT_CAP, 700, 0, 100000),
    tavilyCeilingFraction: num(env.HALFLIFE_TAVILY_CEILING_FRACTION, 0.8, 0, 0.95),
    tavilyAccountGuard: env.HALFLIFE_TAVILY_ACCOUNT_GUARD !== "0" && env.HALFLIFE_TAVILY_ACCOUNT_GUARD !== "false",
    concurrency: num(env.HALFLIFE_CONCURRENCY, 2, 1, 16),
    queueMax: num(env.HALFLIFE_QUEUE_MAX, 200, 1, 10000),
    llmTimeoutMs: num(env.HALFLIFE_LLM_TIMEOUT_MS, 20000, 1000, 120000),
    searchTimeoutMs: num(env.HALFLIFE_SEARCH_TIMEOUT_MS, 10000, 1000, 60000),
    extractTimeoutMs: num(env.HALFLIFE_EXTRACT_TIMEOUT_MS, 15000, 1000, 60000),
    jobBudgetMs: num(env.HALFLIFE_JOB_BUDGET_MS, 45000, 5000, 300000),
    cacheTTLSeconds: num(env.HALFLIFE_CACHE_TTL_SECONDS, 300, 1, 30 * 24 * 3600),
    retentionDays: num(env.HALFLIFE_RETENTION_DAYS, 14, 1, 3650),
  };
}
