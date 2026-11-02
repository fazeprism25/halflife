// Engine entry point: wires configuration, providers, store, pipeline and HTTP server.
//   node engine/src/main.ts

import path from "node:path";
import { CacheActions } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { Bus } from "./events.ts";
import { BifrostLLM, type LLM } from "./llm.ts";
import { ExtensionService } from "./extension.ts";
import { Engine } from "./pipeline.ts";
import { VERSION, createServer, type Health } from "./server.ts";
import { Store } from "./store.ts";
import { TavilyViaBifrost, type Search } from "./tavily.ts";

const cfg = loadConfig();
const store = new Store(path.join(cfg.dataDir, "halflife.db"));
const bus = new Bus();
const health: Health = {
  llm: { configured: false, model: null, last_ok_at: null, last_error: null, last_error_at: null },
  search: { configured: false, last_ok_at: null, last_error: null, last_error_at: null },
  bifrost: { reachable: null, checked_at: null, error: null },
};

// Last success/error times survive restarts (kept in the store; no secrets involved).
const saved = store.kvGet("health") ?? {};
for (const k of ["last_ok_at", "last_error", "last_error_at"] as const) {
  if (saved.llm?.[k] !== undefined) (health.llm as any)[k] = saved.llm[k];
  if (saved.search?.[k] !== undefined) (health.search as any)[k] = saved.search[k];
}
const persistHealth = () => store.kvSet("health", { llm: health.llm, search: health.search });

const warnings: string[] = [];
let llm: LLM | null = null;
if (cfg.llmModel && cfg.engineVK && cfg.internalToken) {
  llm = instrumentLLM(new BifrostLLM({ bifrostUrl: cfg.bifrostUrl, model: cfg.llmModel, virtualKey: cfg.engineVK, internalToken: cfg.internalToken, fallbacks: cfg.llmFallbacks, extraBody: cfg.llmExtraBody, timeoutMs: cfg.llmTimeoutMs }));
  health.llm.configured = true;
  health.llm.model = cfg.llmModel;
} else if (cfg.llmModel) {
  // Without the internal token the plugin would analyse the engine's own calls (a loop).
  warnings.push("HALFLIFE_LLM_MODEL is set but HALFLIFE_ENGINE_VK or HALFLIFE_INTERNAL_TOKEN is missing: LLM disabled");
}
let search: Search | null = null;
if (cfg.tavilyEnabled && cfg.engineVK) {
  search = instrumentSearch(new TavilyViaBifrost({ bifrostUrl: cfg.bifrostUrl, virtualKey: cfg.engineVK, searchTimeoutMs: cfg.searchTimeoutMs, extractTimeoutMs: cfg.extractTimeoutMs }));
  health.search.configured = true;
}
if (!cfg.ingestToken) warnings.push("HALFLIFE_INGEST_TOKEN is not set: the gateway plugin cannot deliver answers");

const cache = new CacheActions(store, {
  bifrostUrl: cfg.bifrostUrl,
  adminToken: cfg.adminToken,
  onDone: (r) => bus.emit({ type: "cache", ...r }),
});
const engine = new Engine({ cfg, store, llm, search, bus, cache });
cache.start();

function instrumentLLM(inner: LLM): LLM {
  return {
    model: inner.model,
    kind: inner.kind,
    async json(req, signal) {
      try {
        const r = await inner.json(req, signal);
        health.llm.last_ok_at = Date.now();
        persistHealth();
        return r;
      } catch (e) {
        health.llm.last_error = (e as Error).message.slice(0, 300);
        health.llm.last_error_at = Date.now();
        persistHealth();
        throw e;
      }
    },
  };
}

function instrumentSearch(inner: Search): Search {
  const wrap = async <T>(p: Promise<T>): Promise<T> => {
    try {
      const r = await p;
      health.search.last_ok_at = Date.now();
      persistHealth();
      return r;
    } catch (e) {
      health.search.last_error = (e as Error).message.slice(0, 300);
      health.search.last_error_at = Date.now();
      persistHealth();
      throw e;
    }
  };
  // usage is passed through so the credit guard (AD-19) can read the account counter.
  return { kind: inner.kind, search: (p, s) => wrap(inner.search(p, s)), extract: (u, q, s) => wrap(inner.extract(u, q, s)), ...(inner.usage ? { usage: () => inner.usage!() } : {}) };
}

async function probeBifrost() {
  try {
    const r = await fetch(`${cfg.bifrostUrl}/health`, { signal: AbortSignal.timeout(3000) });
    health.bifrost = { reachable: r.ok, checked_at: Date.now(), error: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    health.bifrost = { reachable: false, checked_at: Date.now(), error: (e as Error).message.slice(0, 200) };
  }
}
void probeBifrost();
setInterval(() => void probeBifrost(), 15000).unref();
const ext = new ExtensionService(store, engine);
setInterval(() => {
  store.sweep(cfg.retentionDays * 24 * 3600 * 1000);
  ext.sweep(); // extension checks have their own, user-set retention (AD-32)
}, 3600_000).unref();

const server = createServer({ cfg, engine, store, health, ext });
server.listen(cfg.port, cfg.host, () => {
  console.log(`[engine] halflife ${VERSION} listening on ${cfg.host}:${cfg.port}`);
  console.log(`[engine] bifrost=${cfg.bifrostUrl} llm=${llm ? cfg.llmModel : "off"} search=${search ? "tavily via relay" : "off"} cache_admin=${cfg.adminToken ? "on" : "off"} playground=${cfg.demoVK ? "on" : "off"}`);
  for (const w of warnings) console.warn(`[engine] warning: ${w}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  cache.stop();
  server.close();
  const t = setTimeout(() => process.exit(0), 5000);
  engine.drain().finally(() => {
    clearTimeout(t);
    store.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
