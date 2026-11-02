// HTTP API and console host.
//
// Callers and how they authenticate:
//   plugin   POST /v1/ingest, /v1/plugin/heartbeat     Bearer HALFLIFE_INGEST_TOKEN (internal network)
//   relay    /relay/halflife/v1/* via Bifrost          Bearer HALFLIFE_RELAY_TOKEN (injected by Bifrost; VK-gated)
//   extension /v1/extension/*                         Bearer hlx_… token from pairing (AD-32), bound to the
//                                                      extension origin; loopback Host only; own checks only
//   console  same-origin browser requests              x-halflife-console header (custom header ⇒ CORS
//                                                      preflight ⇒ cross-site requests are blocked); value
//                                                      must equal HALFLIFE_CONSOLE_TOKEN when one is set

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLASS_TABLE_VERSION } from "./classes.ts";
import type { Config } from "./config.ts";
import { ExtError, ExtensionService, extensionConsoleRoute, extensionRoute, isLoopbackHost } from "./extension.ts";
import { InputError, type Engine } from "./pipeline.ts";
import type { Store } from "./store.ts";

export const VERSION = "0.1.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, "../console");
const MAX_BODY = 256 * 1024;

export type Health = {
  llm: { configured: boolean; model: string | null; last_ok_at: number | null; last_error: string | null; last_error_at: number | null };
  search: { configured: boolean; last_ok_at: number | null; last_error: string | null; last_error_at: number | null };
  bifrost: { reachable: boolean | null; checked_at: number | null; error: string | null };
};

export type ServerDeps = { cfg: Config; engine: Engine; store: Store; health: Health; fetchImpl?: typeof fetch; ext?: ExtensionService };

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

type Caller = "plugin" | "relay" | "console";

function caller(req: http.IncomingMessage, cfg: Config): Caller | null {
  const b = bearer(req);
  if (b && cfg.ingestToken && safeEq(b, cfg.ingestToken)) return "plugin";
  if (b && cfg.relayToken && safeEq(b, cfg.relayToken)) return "relay";
  const c = req.headers["x-halflife-console"];
  if (typeof c === "string" && c) {
    if (cfg.consoleToken ? safeEq(c, cfg.consoleToken) : true) return "console";
  }
  return null;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJSON(req: http.IncomingMessage): Promise<any> {
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("application/json")) throw new HttpError(415, "content-type must be application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra });
  res.end(data);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html"; // SPA routes
  const file = path.resolve(CONSOLE_DIR, "." + rel);
  if (!file.startsWith(CONSOLE_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ...SECURITY_HEADERS,
  });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

export function createServer(d: ServerDeps): http.Server {
  const { cfg, engine, store, health } = d;
  const f = d.fetchImpl ?? fetch;
  const ext = d.ext ?? new ExtensionService(store, engine);
  let pluginBeat: any = store.kvGet("plugin_heartbeat") ?? null;

  const route = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://engine");
    const p = url.pathname;
    const m = req.method ?? "GET";

    if (p === "/v1/health" && m === "GET") return send(res, 200, { ok: true, service: "halflife-engine", version: VERSION });

    if (!p.startsWith("/v1/")) {
      if (serveStatic(req, res, p)) return;
      return send(res, 404, { error: "not found" });
    }

    // -------------------------------------------------- browser extension (AD-32)
    if (p.startsWith("/v1/extension/")) {
      if (!isLoopbackHost(req.headers.host)) return send(res, 403, { error: "extension routes are served on loopback only" });
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      if (p === "/v1/extension/pair" && m === "POST") return send(res, 201, ext.claim(await readJSON(req), origin));
      const b = bearer(req);
      if (b.startsWith("hlx_")) {
        const conn = ext.authenticate(b, origin);
        if (!conn) return send(res, 401, { error: "extension token is invalid or revoked" });
        return extensionRoute(ext, req, res, p, m, url, conn, send, readJSON);
      }
    }

    const who = caller(req, cfg);
    if (!who) return send(res, 401, { error: "unauthorized" });

    // -------------------------------------------------- plugin
    if (p === "/v1/ingest" && m === "POST") {
      if (who !== "plugin") return send(res, 403, { error: "ingest is for the gateway plugin" });
      const body = await readJSON(req);
      const r = engine.accept(body, "gateway");
      if (body.sync === true && r.status === "queued") {
        try {
          await engine.runNow(r.id);
        } catch (e) {
          if (!(e instanceof InputError)) throw e;
        }
        return send(res, 200, engine.syncResult(r.id));
      }
      return send(res, 202, r);
    }
    if (p === "/v1/plugin/heartbeat" && m === "POST") {
      if (who !== "plugin") return send(res, 403, { error: "forbidden" });
      const body = await readJSON(req);
      pluginBeat = { at: Date.now(), plugin_version: String(body.plugin_version ?? ""), queue_depth: Number(body.queue_depth ?? 0), queue_size: Number(body.queue_size ?? 0), tracked: Number(body.tracked ?? 0), counters: typeof body.counters === "object" && body.counters ? body.counters : {}, started_at: body.started_at ?? null };
      store.kvSet("plugin_heartbeat", pluginBeat);
      return send(res, 204, {});
    }
    if (who === "plugin") return send(res, 403, { error: "forbidden" });

    // -------------------------------------------------- api (relay + console)
    if (p === "/v1/check" && m === "POST") {
      const body = await readJSON(req);
      const r = engine.accept({ text: body.text, prompt: body.question ?? body.prompt, model: body.model, as_of: body.as_of, assess_only: body.verify === false, learn: body.learn === false ? false : undefined, mode: "api", sync: body.wait === true }, who === "console" ? "playground" : "api");
      if (body.wait === true) {
        try {
          await engine.runNow(r.id);
        } catch (e) {
          if (!(e instanceof InputError)) throw e;
          return send(res, 202, { id: r.id, status: "queued", note: e.message });
        }
        return send(res, 200, engine.reportView(r.id));
      }
      return send(res, 202, r);
    }
    if (p === "/v1/reports" && m === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("before");
      return send(res, 200, { reports: engine.listReports(Number.isFinite(limit) ? limit : 50, before ? Number(before) : undefined) });
    }
    const rm = /^\/v1\/reports\/(hl_[a-f0-9]{8,40})$/.exec(p);
    if (rm && m === "GET") {
      const v = engine.reportView(rm[1]);
      return v ? send(res, 200, v) : send(res, 404, { error: "report not found" });
    }
    if (p === "/v1/classes" && m === "GET") return send(res, 200, { version: CLASS_TABLE_VERSION, theta: cfg.theta, classes: engine.model.summary() });
    if (p === "/v1/status" && m === "GET") return send(res, 200, status());

    // -------------------------------------------------- console only
    if (who !== "console") return send(res, 404, { error: "not found" });
    if (p === "/v1/events" && m === "GET") return events(req, res);
    if (p === "/v1/playground" && m === "POST") return playground(await readJSON(req), res);
    if (p.startsWith("/v1/extension/") && (await extensionConsoleRoute(ext, req, res, p, m, url, send, readJSON))) return;
    return send(res, 404, { error: "not found" });
  };

  function status() {
    const day = new Date().toISOString().slice(0, 10);
    const counts = store.get(`SELECT (SELECT COUNT(*) FROM reports) AS reports, (SELECT COUNT(*) FROM claims) AS claims,
      (SELECT COUNT(*) FROM claims WHERE verdict IS NOT NULL) AS checked, (SELECT COUNT(*) FROM observations) AS observations,
      (SELECT COUNT(*) FROM cache_actions WHERE status='done') AS cache_actions_done, (SELECT COUNT(*) FROM cache_actions WHERE status='pending') AS cache_actions_pending`);
    return {
      version: VERSION, now: Date.now(),
      policy: { theta: cfg.theta, max_verify_per_response: cfg.maxVerifyPerResponse, daily_credit_cap: cfg.dailyCreditCap, concurrency: cfg.concurrency, cache_ttl_seconds: cfg.cacheTTLSeconds },
      integrations: {
        bifrost: { url: cfg.bifrostUrl, ...health.bifrost },
        llm: health.llm,
        search: { ...health.search, via: "Bifrost relay /relay/tavily" },
        plugin: pluginBeat ? { ...pluginBeat, stale: Date.now() - pluginBeat.at > 60_000 } : null,
        cache_admin: { configured: !!cfg.adminToken },
        playground: { configured: !!cfg.demoVK, models: playgroundModels() },
      },
      spend: { today: store.spendFor(day), cap_credits: cfg.dailyCreditCap, total_credits: store.spendTotal(), total_tokens: Number(store.get("SELECT COALESCE(SUM(tokens),0) AS t FROM spend")?.t ?? 0),total_cap_credits: cfg.totalCreditCap, guard: engine.credits.status() },
      queue: { depth: engine.queueDepth, active: engine.activeJobs, max: cfg.queueMax },
      counts,
    };
  }

  function playgroundModels(): string[] {
    return cfg.playgroundModels.length ? cfg.playgroundModels : cfg.llmModel ? [cfg.llmModel] : [];
  }

  function events(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...SECURITY_HEADERS });
    res.write(": connected\n\n");
    const off = engine.bus.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const beat = setInterval(() => res.write(": keepalive\n\n"), 15000);
    req.on("close", () => {
      off();
      clearInterval(beat);
    });
  }

  /** Sends a prompt through Bifrost exactly as an application would (demo VK, no internal token),
   *  so the Halflife plugin observes it like any other traffic. */
  async function playground(body: any, res: http.ServerResponse) {
    if (!cfg.demoVK) return send(res, 409, { error: "playground is not configured (HALFLIFE_DEMO_VK)" });
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt || prompt.length > 4000) return send(res, 400, { error: "prompt must be 1–4000 characters" });
    const models = playgroundModels();
    const model = typeof body.model === "string" && models.includes(body.model) ? body.model : models[0];
    if (!model) return send(res, 409, { error: "no playground model configured" });
    const mode = body.mode === "verify" ? "verify" : "async";
    const t0 = performance.now();
    let r: Response;
    try {
      r = await f(`${cfg.bifrostUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bf-vk": cfg.demoVK, "x-halflife-mode": mode },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 600 }),
        signal: AbortSignal.timeout(mode === "verify" ? 90000 : 60000),
      });
    } catch (e) {
      return send(res, 502, { error: `gateway unreachable: ${(e as Error).message}` });
    }
    const text = await r.text();
    const ms = Math.round(performance.now() - t0);
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (k.startsWith("x-halflife-")) headers[k] = v;
    });
    if (!r.ok) return send(res, 502, { error: j?.error?.message ?? `gateway returned HTTP ${r.status}`, status: r.status, headers, latency_ms: ms });
    return send(res, 200, {
      report_id: headers["x-halflife-report"] ?? null,
      answer: j?.choices?.[0]?.message?.content ?? "",
      model: j?.model ?? model,
      headers, latency_ms: ms,
      cache: j?.extra_fields?.cache_debug ?? null,
    });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError || e instanceof InputError || e instanceof ExtError ? e.status : 500;
      if (status === 500) console.error("[engine] request failed:", e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "internal error" : e.message });
      else res.end();
    });
  });
}
