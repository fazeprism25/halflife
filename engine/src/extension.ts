// Browser-extension integration (AD-32).
//
// The extension never talks to Bifrost or Tavily and never holds a provider key. It sends one
// user-selected answer to the engine, which runs the normal pipeline (Engine.accept) with
// source "extension" and learn:false.
//
// Trust model
//   pairing   The console (authenticated) creates a one-time code. The extension's service worker
//             claims it from its chrome-extension:// origin and receives a random bearer token.
//             Only sha256(token) is stored, bound to that origin.
//   requests  Bearer token. If an Origin header is present it must equal the bound origin, so a
//             web page holding a leaked token is still refused. Host must be a loopback name
//             (DNS-rebinding defence for the unauthenticated pairing route).
//   scope     The token can create checks, read its own checks and read a minimal status. Nothing
//             else: no gateway traffic, events, playground, settings or deletion of other data.

import crypto from "node:crypto";
import type http from "node:http";
import { getClass } from "./classes.ts";
import { sha, type Engine } from "./pipeline.ts";
import type { Row, Store } from "./store.ts";
import { clip } from "./text.ts";

export const EXT_LIMITS = { answer: 60_000, question: 4_000, messageId: 200, model: 100 };
export const PLATFORMS = ["chatgpt"] as const;
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_MAX_FAILURES = 10; // per window; then every outstanding code is withdrawn
const ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const DAY_MS = 24 * 3600 * 1000;
/** A claim judged outdated with at least moderate evidence (the same rule as the report summary). */
const STALE_C = "c.verdict IN ('superseded','contradicted') AND c.evidence_level IN ('strong','moderate')";

export type ExtSettings = {
  /** Server-side kill switch: when false every new check is refused. */
  accept_checks: boolean;
  /** false: checks are assess-only (claims and freshness estimates, no live search, 0 credits). */
  live_verification: boolean;
  /** Extension checks older than this are deleted (on top of the global retention). */
  retention_days: number;
  daily_limit: number;
  per_minute_limit: number;
};
export const DEFAULT_EXT_SETTINGS: ExtSettings = { accept_checks: true, live_verification: true, retention_days: 30, daily_limit: 50, per_minute_limit: 6 };

export class ExtError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Connection = { id: string; origin: string };

/** Overall assessment of one checked answer, from the engine's own summary (no new scoring). */
export type Assessment = "outdated" | "possibly_outdated" | "unverified" | "current" | "low_risk" | "no_time_sensitive" | "no_claims";

export function assessmentOf(s: Row | null): Assessment | null {
  if (!s || typeof s.claims !== "number") return null;
  if (s.claims === 0) return "no_claims";
  if (s.time_sensitive === 0) return "no_time_sensitive";
  if (s.stale > 0) return "outdated";
  if (s.possibly_stale > 0) return "possibly_outdated";
  const uncheckedAtRisk = Math.max(0, (s.at_risk ?? 0) - (s.checked ?? 0));
  if (uncheckedAtRisk > 0 || (s.verdicts?.unverifiable ?? 0) > 0 || (s.weak_current ?? 0) > 0) return "unverified";
  if ((s.checked ?? 0) > 0) return "current";
  return "low_risk";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const collapse = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export class ExtensionService {
  store: Store;
  engine: Engine;
  now: () => number;
  private codes = new Map<string, { expires: number; label: string }>();
  private failures: number[] = [];
  private recent = new Map<string, number[]>();

  constructor(store: Store, engine: Engine, now: () => number = Date.now) {
    this.store = store;
    this.engine = engine;
    this.now = now;
  }

  // ---------------------------------------------------------------- settings

  settings(): ExtSettings {
    const s = this.store.kvGet("extension_settings");
    return { ...DEFAULT_EXT_SETTINGS, ...(isObj(s) ? s : {}) } as ExtSettings;
  }

  updateSettings(patch: unknown): ExtSettings {
    if (!isObj(patch)) throw new ExtError(400, "settings must be an object");
    const s = this.settings();
    const bools = ["accept_checks", "live_verification"] as const;
    const ints: Record<string, [number, number]> = { retention_days: [1, 365], daily_limit: [0, 1000], per_minute_limit: [1, 60] };
    for (const [k, v] of Object.entries(patch)) {
      if ((bools as readonly string[]).includes(k)) {
        if (typeof v !== "boolean") throw new ExtError(400, `${k} must be true or false`);
        (s as any)[k] = v;
      } else if (k in ints) {
        const [lo, hi] = ints[k];
        if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw new ExtError(400, `${k} must be an integer from ${lo} to ${hi}`);
        (s as any)[k] = v;
      } else throw new ExtError(400, `unknown setting: ${k}`);
    }
    this.store.kvSet("extension_settings", s);
    return s;
  }

  // ---------------------------------------------------------------- pairing and tokens

  createPairingCode(label?: unknown): { code: string; expires_at: number } {
    const now = this.now();
    for (const [c, v] of this.codes) if (v.expires < now) this.codes.delete(c);
    if (this.codes.size >= 5) throw new ExtError(429, "too many outstanding pairing codes; wait for them to expire");
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    this.codes.set(code, { expires: now + PAIR_TTL_MS, label: typeof label === "string" ? clip(label.trim(), 60) : "" });
    return { code, expires_at: now + PAIR_TTL_MS };
  }

  /** Exchange a one-time code for a token bound to the calling extension origin. */
  claim(body: unknown, origin: string | undefined): { token: string; connection_id: string } {
    if (!origin || !ORIGIN_RE.test(origin)) throw new ExtError(403, "pairing must come from a browser extension");
    const code = isObj(body) && typeof body.code === "string" ? body.code.toUpperCase().replace(/[\s-]/g, "") : "";
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < PAIR_TTL_MS);
    const entry = this.codes.get(code);
    if (!entry || entry.expires < now) {
      this.failures.push(now);
      if (this.failures.length >= PAIR_MAX_FAILURES) this.codes.clear(); // brute-force guard
      throw new ExtError(401, "pairing code is invalid or expired");
    }
    this.codes.delete(code); // one-time
    const token = "hlx_" + crypto.randomBytes(32).toString("base64url");
    const id = "ext_" + crypto.randomBytes(6).toString("hex");
    this.store.insert("extension_tokens", { id, token_hash: sha(token), origin, label: entry.label || null, created_at: now, last_used_at: null, revoked_at: null });
    return { token, connection_id: id };
  }

  /** The connection for a bearer token, or null. Refuses a token presented from another origin. */
  authenticate(token: string, origin: string | undefined): Connection | null {
    if (!token.startsWith("hlx_") || token.length > 100) return null;
    const row = this.store.get("SELECT id, origin FROM extension_tokens WHERE token_hash=? AND revoked_at IS NULL", sha(token));
    if (!row) return null;
    if (origin && origin !== row.origin) return null;
    this.store.run("UPDATE extension_tokens SET last_used_at=? WHERE id=?", this.now(), row.id);
    return { id: row.id, origin: row.origin };
  }

  revoke(id: string): boolean {
    return Number(this.store.run("UPDATE extension_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", this.now(), id).changes) > 0;
  }

  connections(): Row[] {
    return this.store.all(
      `SELECT t.id, t.origin, t.label, t.created_at, t.last_used_at, t.revoked_at,
              (SELECT COUNT(*) FROM reports r WHERE r.source='extension' AND r.client_id=t.id) AS checks
       FROM extension_tokens t ORDER BY t.created_at DESC LIMIT 50`,
    );
  }

  // ---------------------------------------------------------------- checks

  /** Validates one check request strictly; unknown fields are refused. */
  parseCheck(body: unknown) {
    if (!isObj(body)) throw new ExtError(400, "body must be a JSON object");
    const allowed = new Set(["platform", "message_id", "question", "answer", "model", "conversation_hash", "force"]);
    for (const k of Object.keys(body)) if (!allowed.has(k)) throw new ExtError(400, `unexpected field: ${k}`);
    const platform = body.platform;
    if (typeof platform !== "string" || !(PLATFORMS as readonly string[]).includes(platform)) throw new ExtError(400, "unsupported platform");
    if (typeof body.answer !== "string") throw new ExtError(400, "answer is required");
    const answer = collapse(body.answer);
    if (!answer) throw new ExtError(400, "answer is empty");
    if (answer.length > EXT_LIMITS.answer) throw new ExtError(413, `answer exceeds ${EXT_LIMITS.answer} characters`);
    let question: string | null = null;
    if (body.question !== undefined && body.question !== null) {
      if (typeof body.question !== "string") throw new ExtError(400, "question must be a string");
      question = collapse(body.question);
      if (question.length > EXT_LIMITS.question) throw new ExtError(413, `question exceeds ${EXT_LIMITS.question} characters`);
      if (!question) question = null;
    }
    const opt = (k: string, re: RegExp, what: string): string | null => {
      const v = body[k];
      if (v === undefined || v === null || v === "") return null;
      if (typeof v !== "string" || !re.test(v)) throw new ExtError(400, `${k} must be ${what}`);
      return v;
    };
    const messageId = opt("message_id", /^[A-Za-z0-9:._-]{1,200}$/, "an id of up to 200 characters [A-Za-z0-9:._-]");
    const model = opt("model", /^[A-Za-z0-9._:-]{1,100}$/, "a model slug of up to 100 characters");
    const conversationHash = opt("conversation_hash", /^[a-f0-9]{64}$/, "a hex SHA-256");
    if (body.force !== undefined && typeof body.force !== "boolean") throw new ExtError(400, "force must be true or false");
    const contentHash = sha(platform + "\n" + answer);
    return { platform, answer, question, messageId, model, conversationHash, force: body.force === true, contentHash, ref: messageId ? `${platform}:${messageId}` : `${platform}:hash:${contentHash.slice(0, 24)}` };
  }

  check(body: unknown, conn: Connection): { status: number; body: Row } {
    const c = this.parseCheck(body);
    const s = this.settings();
    if (!s.accept_checks) throw new ExtError(403, "checks are paused in Halflife (Extension settings)");
    if (!c.force) {
      // Duplicate selection of the same message with the same text: return the existing analysis.
      const prior = this.store.get(
        "SELECT id FROM reports WHERE source='extension' AND client_ref=? AND content_hash=? AND status!='failed' ORDER BY created_at DESC LIMIT 1",
        c.ref, c.contentHash,
      );
      if (prior) return { status: 200, body: { ...this.compact(prior.id)!, duplicate: true } };
    }
    const now = this.now();
    const times = (this.recent.get(conn.id) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= s.per_minute_limit) throw new ExtError(429, `rate limit: at most ${s.per_minute_limit} checks per minute`);
    const startOfDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const today = Number(this.store.get("SELECT COUNT(*) AS n FROM reports WHERE source='extension' AND created_at>=?", startOfDay)?.n ?? 0);
    if (today >= s.daily_limit) throw new ExtError(429, `daily limit reached: ${s.daily_limit} checks per day (Extension settings)`);
    times.push(now);
    this.recent.set(conn.id, times);
    const r = this.engine.accept({
      text: c.answer, prompt: c.question, model: c.model ? `chatgpt/${c.model}` : "chatgpt",
      assess_only: !s.live_verification, learn: false, mode: "api",
      client: { ref: c.ref, content_hash: c.contentHash, id: conn.id, meta: { platform: c.platform, message_id: c.messageId, model: c.model, conversation_hash: c.conversationHash, question_missing: c.question === null } },
    }, "extension");
    return { status: 202, body: { ...this.compact(r.id)!, duplicate: false } };
  }

  /** The compact result the extension shows inside ChatGPT. */
  compact(id: string, connId?: string): Row | null {
    const r = this.store.get("SELECT id, status, stage, error, created_at, finished_at, summary, client_id FROM reports WHERE id=? AND source='extension'", id);
    if (!r || (connId && r.client_id !== connId)) return null;
    const s = r.summary ? JSON.parse(r.summary) : null;
    const done = r.status === "done" && s && typeof s.claims === "number";
    return {
      id: r.id, status: r.status, stage: r.stage, error: r.status === "failed" ? r.error : null,
      created_at: r.created_at, finished_at: r.finished_at,
      assessment: done ? assessmentOf(s) : null,
      headline: done ? s.headline : null,
      live_verification: s ? s.assess_only !== true : null,
      counts: done ? {
        claims: s.claims, time_sensitive: s.time_sensitive, at_risk: s.at_risk, checked: s.checked,
        outdated: s.stale, possibly_outdated: s.possibly_stale, not_checked: s.not_checked,
        current: s.verdicts.current, superseded: s.verdicts.superseded, contradicted: s.verdicts.contradicted, unverifiable: s.verdicts.unverifiable,
      } : null,
      dashboard_path: `/#/activity/${r.id}`,
    };
  }

  recentFor(connId: string, limit: number): Row[] {
    const rows = this.store.all("SELECT id FROM reports WHERE source='extension' AND client_id=? ORDER BY created_at DESC LIMIT ?", connId, Math.min(20, Math.max(1, limit)));
    return rows.map((r) => this.compact(r.id)!).map((c) => ({ ...c, question: this.preview(c.id) }));
  }

  private preview(id: string): string | null {
    const r = this.store.get("SELECT prompt, text FROM reports WHERE id=?", id);
    return r ? clip(r.prompt ?? r.text, 120) : null;
  }

  statusFor(conn: Connection): Row {
    const s = this.settings();
    const startOfDay = Date.UTC(new Date(this.now()).getUTCFullYear(), new Date(this.now()).getUTCMonth(), new Date(this.now()).getUTCDate());
    return {
      ok: true, connection_id: conn.id,
      accept_checks: s.accept_checks, live_verification: s.live_verification,
      verification_available: { judge: !!this.engine.llm, search: !!this.engine.search },
      checks_today: Number(this.store.get("SELECT COUNT(*) AS n FROM reports WHERE source='extension' AND created_at>=?", startOfDay)?.n ?? 0),
      daily_limit: s.daily_limit,
      total_checks: Number(this.store.get("SELECT COUNT(*) AS n FROM reports WHERE source='extension' AND client_id=?", conn.id)?.n ?? 0),
    };
  }

  // ---------------------------------------------------------------- console views

  activity(limit: number, before?: number): Row[] {
    const rows = this.store.all(
      `SELECT id, created_at, status, stage, error, model, summary, client_meta, substr(prompt,1,300) AS question, substr(text,1,300) AS answer,
              (SELECT COUNT(*) FROM claims c WHERE c.report_id=r.id AND c.time_sensitive=1 AND c.p_hi >= ?) AS at_risk
       FROM reports r WHERE source='extension' AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
      this.engine.cfg.theta, before ?? Number.MAX_SAFE_INTEGER, Math.min(200, Math.max(1, limit)),
    );
    return rows.map((r) => {
      const s = r.summary ? JSON.parse(r.summary) : null;
      return {
        id: r.id, created_at: r.created_at, status: r.status, stage: r.stage, error: r.error, model: r.model,
        question: r.question, answer: r.answer, meta: r.client_meta ? JSON.parse(r.client_meta) : {}, at_risk: Number(r.at_risk ?? 0),
        assessment: r.status === "done" ? assessmentOf(s) : null, summary: s,
      };
    });
  }

  claims(q: { verdict?: string | null; cls?: string | null; text?: string | null; limit?: number }): Row[] {
    const where = ["r.source='extension'"];
    const args: any[] = [];
    switch (q.verdict) {
      case "outdated": where.push(STALE_C); break;
      case "current": case "superseded": case "contradicted": case "unverifiable": where.push("c.verdict=?"); args.push(q.verdict); break;
      case "unchecked": where.push("c.verdict IS NULL AND c.time_sensitive=1"); break;
      case "static": where.push("c.time_sensitive=0"); break;
    }
    if (q.cls && /^[a-z0-9_.-]{1,60}$/.test(q.cls)) {
      where.push("c.class=?");
      args.push(q.cls);
    }
    if (q.text) {
      where.push("c.statement LIKE ? ESCAPE '\\'");
      args.push(`%${clip(q.text, 100).replace(/[\\%_]/g, (m) => "\\" + m)}%`);
    }
    const rows = this.store.all(
      `SELECT c.*, r.created_at AS report_created_at, substr(r.prompt,1,200) AS question
       FROM claims c JOIN reports r ON r.id=c.report_id WHERE ${where.join(" AND ")}
       ORDER BY r.created_at DESC, c.idx LIMIT ?`,
      ...args, Math.min(300, Math.max(1, q.limit ?? 100)),
    );
    return rows.map((c) => ({
      id: c.id, report_id: c.report_id, report_created_at: c.report_created_at, question: c.question,
      text: c.text, statement: c.statement, class: { id: c.class, label: getClass(c.class).label },
      time_sensitive: !!c.time_sensitive, triage: c.triage,
      p_outdated: { lo: c.p_lo, hi: c.p_hi, calibrated: false },
      half_life_years: { median: c.hl_median, lo: c.hl_lo, hi: c.hl_hi },
      as_of_label: c.as_of_label,
      verdict: c.verdict, evidence_level: c.evidence_level, current_value: c.current_value, changed_on: c.changed_on,
      explanation: c.explanation, verified_at: c.verified_at, reused_from: c.reused_from,
      limitation: c.limitation ? { kind: c.limitation_kind, message: c.limitation } : null,
      sources: this.store.all("SELECT url, site, title, published_at, stance, quote FROM evidence WHERE claim_id=? AND quote_valid=1 ORDER BY published_at DESC LIMIT 5", c.id),
    }));
  }

  trends(days: number): Row {
    const n = Math.min(365, Math.max(1, Math.round(days)));
    const now = this.now();
    const end = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) + DAY_MS;
    const start = end - n * DAY_MS;
    const dayExpr = "strftime('%Y-%m-%d', r.created_at/1000, 'unixepoch')";
    const perDay = this.store.all(
      `SELECT ${dayExpr} AS day, COUNT(DISTINCT r.id) AS responses,
              COUNT(c.id) AS claims,
              SUM(CASE WHEN c.time_sensitive=1 AND c.p_hi >= ? THEN 1 ELSE 0 END) AS at_risk,
              SUM(CASE WHEN ${STALE_C} THEN 1 ELSE 0 END) AS outdated
       FROM reports r LEFT JOIN claims c ON c.report_id=r.id
       WHERE r.source='extension' AND r.created_at >= ? AND r.created_at < ? GROUP BY day ORDER BY day`,
      this.engine.cfg.theta, start, end,
    );
    const byDay = new Map(perDay.map((d) => [d.day, d]));
    const series = Array.from({ length: n }, (_, i) => {
      const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
      const d = byDay.get(day);
      return { day, responses: Number(d?.responses ?? 0), claims: Number(d?.claims ?? 0), at_risk: Number(d?.at_risk ?? 0), outdated: Number(d?.outdated ?? 0) };
    });
    const range = "r.source='extension' AND r.created_at >= ? AND r.created_at < ?";
    const classes = this.store.all(
      `SELECT c.class, COUNT(*) AS outdated FROM claims c JOIN reports r ON r.id=c.report_id
       WHERE ${range} AND ${STALE_C} GROUP BY c.class ORDER BY outdated DESC LIMIT 8`,
      start, end,
    ).map((r) => ({ class: r.class, label: getClass(r.class).label, outdated: Number(r.outdated) }));
    const o = this.store.get(
      `SELECT COUNT(*) AS claims,
        SUM(CASE WHEN c.verdict='current' THEN 1 ELSE 0 END) AS current,
        SUM(CASE WHEN c.verdict='superseded' THEN 1 ELSE 0 END) AS superseded,
        SUM(CASE WHEN c.verdict='contradicted' THEN 1 ELSE 0 END) AS contradicted,
        SUM(CASE WHEN c.verdict='unverifiable' THEN 1 ELSE 0 END) AS unverifiable,
        SUM(CASE WHEN c.verdict IS NULL AND c.time_sensitive=1 THEN 1 ELSE 0 END) AS not_checked,
        SUM(CASE WHEN c.time_sensitive=0 THEN 1 ELSE 0 END) AS not_time_sensitive
       FROM claims c JOIN reports r ON r.id=c.report_id WHERE ${range}`,
      start, end,
    ) ?? {};
    const outcomes = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v ?? 0)]));
    return { days: n, start, end, series, classes, outcomes };
  }

  // ---------------------------------------------------------------- deletion and retention

  deleteReport(id: string): boolean {
    return Number(this.store.run("DELETE FROM reports WHERE id=? AND source='extension'", id).changes) > 0;
  }

  deleteAll(): number {
    return Number(this.store.run("DELETE FROM reports WHERE source='extension'").changes);
  }

  sweep(): number {
    const days = this.settings().retention_days;
    return Number(this.store.run("DELETE FROM reports WHERE source='extension' AND created_at < ?", this.now() - days * DAY_MS).changes);
  }
}

// ------------------------------------------------------------------ HTTP

export const isLoopbackHost = (host: string | undefined) => !!host && LOOPBACK_HOST.test(host);

type Send = (res: http.ServerResponse, status: number, body: unknown) => void;
type ReadJSON = (req: http.IncomingMessage) => Promise<any>;

/** Routes reachable with an extension token (and the unauthenticated pairing claim). */
export async function extensionRoute(
  ext: ExtensionService, req: http.IncomingMessage, res: http.ServerResponse, p: string, m: string, url: URL,
  conn: Connection, send: Send, readJSON: ReadJSON,
): Promise<void> {
  if (p === "/v1/extension/status" && m === "GET") return send(res, 200, ext.statusFor(conn));
  if (p === "/v1/extension/checks" && m === "POST") {
    const r = ext.check(await readJSON(req), conn);
    return send(res, r.status, r.body);
  }
  if (p === "/v1/extension/checks" && m === "GET") return send(res, 200, { checks: ext.recentFor(conn.id, Number(url.searchParams.get("limit") ?? 8) || 8) });
  const cm = /^\/v1\/extension\/checks\/(hl_[a-f0-9]{8,40})$/.exec(p);
  if (cm && m === "GET") {
    const v = ext.compact(cm[1], conn.id);
    return v ? send(res, 200, v) : send(res, 404, { error: "check not found" });
  }
  if (p === "/v1/extension/token" && m === "DELETE") {
    ext.revoke(conn.id);
    return send(res, 200, { revoked: true });
  }
  return send(res, 404, { error: "not found" });
}

/** Console routes for the extension pages (activity, claims, trends, settings, data control). */
export async function extensionConsoleRoute(
  ext: ExtensionService, req: http.IncomingMessage, res: http.ServerResponse, p: string, m: string, url: URL,
  send: Send, readJSON: ReadJSON,
): Promise<boolean> {
  const qp = url.searchParams;
  if (p === "/v1/extension/activity" && m === "GET") {
    const before = qp.get("before");
    send(res, 200, { checks: ext.activity(Number(qp.get("limit") ?? 50) || 50, before ? Number(before) : undefined) });
  } else if (p === "/v1/extension/claims" && m === "GET") {
    send(res, 200, { claims: ext.claims({ verdict: qp.get("verdict"), cls: qp.get("class"), text: qp.get("q"), limit: Number(qp.get("limit") ?? 100) || 100 }) });
  } else if (p === "/v1/extension/trends" && m === "GET") {
    send(res, 200, ext.trends(Number(qp.get("days") ?? 30) || 30));
  } else if (p === "/v1/extension/settings" && m === "GET") {
    send(res, 200, { settings: ext.settings(), connections: ext.connections() });
  } else if (p === "/v1/extension/settings" && m === "PUT") {
    send(res, 200, { settings: ext.updateSettings(await readJSON(req)) });
  } else if (p === "/v1/extension/pairing-codes" && m === "POST") {
    const body = await readJSON(req);
    send(res, 201, ext.createPairingCode(body?.label));
  } else if (/^\/v1\/extension\/connections\/ext_[a-f0-9]{12}$/.test(p) && m === "DELETE") {
    const ok = ext.revoke(p.split("/").pop()!);
    send(res, ok ? 200 : 404, ok ? { revoked: true } : { error: "connection not found or already revoked" });
  } else if (/^\/v1\/extension\/reports\/hl_[a-f0-9]{8,40}$/.test(p) && m === "DELETE") {
    const ok = ext.deleteReport(p.split("/").pop()!);
    send(res, ok ? 200 : 404, ok ? { deleted: 1 } : { error: "extension check not found" });
  } else if (p === "/v1/extension/reports" && m === "DELETE") {
    if (qp.get("confirm") !== "all") send(res, 400, { error: "add ?confirm=all to delete every extension check" });
    else send(res, 200, { deleted: ext.deleteAll() });
  } else return false;
  return true;
}
