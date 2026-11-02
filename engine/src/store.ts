// Persistence (node:sqlite, built into Node 24). One file, WAL mode. Text stored for reports
// is truncated by the plugin and the API; a retention sweep deletes old reports.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL,              -- gateway | api | playground
  mode TEXT NOT NULL,
  model TEXT,
  prompt TEXT,
  text TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  stream INTEGER NOT NULL DEFAULT 0,
  vk_fingerprint TEXT,
  cache_id TEXT,
  cache_hit INTEGER,
  ttl_set TEXT,
  triage_groups TEXT,                -- JSON array (plugin lexical triage)
  status TEXT NOT NULL,              -- queued | running | done | failed | linked
  stage TEXT,
  error TEXT,
  extraction TEXT,                   -- llm | heuristic
  extraction_note TEXT,
  linked_report_id TEXT,
  credits REAL NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  summary TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS reports_cache ON reports(cache_id);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  statement TEXT NOT NULL,
  class TEXT NOT NULL,
  subject TEXT, attribute TEXT, value TEXT,
  time_sensitive INTEGER NOT NULL,
  as_of_kind TEXT NOT NULL, as_of_lo INTEGER NOT NULL, as_of_hi INTEGER NOT NULL, as_of_label TEXT NOT NULL, as_of_source TEXT,
  p_lo REAL NOT NULL, p_hi REAL NOT NULL,
  hl_median REAL, hl_lo REAL, hl_hi REAL,
  triage TEXT NOT NULL,              -- verify | low_risk | static | cap | budget | reused
  search_query TEXT,
  verdict TEXT,                      -- current | superseded | contradicted | unverifiable | NULL (not checked)
  current_value TEXT, changed_on TEXT, explanation TEXT,
  evidence_level TEXT, level_reasons TEXT,
  limitation_kind TEXT, limitation TEXT,
  tiers TEXT, credits REAL NOT NULL DEFAULT 0,
  verified_at INTEGER, reuse_until INTEGER,
  reused_from TEXT,
  norm_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_report ON claims(report_id, idx);
CREATE INDEX IF NOT EXISTS claims_norm ON claims(norm_key, verified_at DESC);
CREATE TABLE IF NOT EXISTS evidence (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  eid TEXT NOT NULL,
  url TEXT NOT NULL, domain TEXT, site TEXT, title TEXT,
  published_at INTEGER, content TEXT, score REAL, tier TEXT,
  stance TEXT, quote TEXT, quote_valid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (claim_id, eid)
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class TEXT NOT NULL,
  tau_years REAL NOT NULL,
  changed INTEGER NOT NULL,
  claim_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS obs_class ON observations(class);
CREATE TABLE IF NOT EXISTS cache_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL,
  cache_id TEXT NOT NULL,
  action TEXT NOT NULL,              -- invalidate_stale | expire_reuse_window
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL,              -- pending | done | failed | skipped
  reason TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS cache_due ON cache_actions(status, due_at);
CREATE TABLE IF NOT EXISTS spend (
  day TEXT PRIMARY KEY,
  credits REAL NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  extracts INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export type Row = Record<string, any>;

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  get(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  /** Insert or merge a column set into a table by primary key `id`. */
  upsertReport(r: Row) {
    const cols = Object.keys(r);
    const sql = `INSERT INTO reports (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
      ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c}=excluded.${c}`).join(",")}`;
    this.run(sql, ...cols.map((c) => r[c]));
  }

  updateReport(id: string, patch: Row) {
    const cols = Object.keys(patch).filter((c) => patch[c] !== undefined);
    if (!cols.length) return;
    this.run(`UPDATE reports SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`, ...cols.map((c) => patch[c]), id);
  }

  insert(table: string, r: Row) {
    const cols = Object.keys(r);
    this.run(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...cols.map((c) => r[c]));
  }

  kvGet(k: string): any {
    const r = this.get("SELECT v FROM kv WHERE k=?", k);
    return r ? JSON.parse(r.v) : undefined;
  }
  kvSet(k: string, v: unknown) {
    this.run("INSERT INTO kv (k,v,updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at", k, JSON.stringify(v), Date.now());
  }

  addSpend(day: string, d: { credits?: number; searches?: number; extracts?: number; llm_calls?: number; tokens?: number }) {
    this.run(
      `INSERT INTO spend (day,credits,searches,extracts,llm_calls,tokens) VALUES (?,?,?,?,?,?)
       ON CONFLICT(day) DO UPDATE SET credits=credits+excluded.credits, searches=searches+excluded.searches,
       extracts=extracts+excluded.extracts, llm_calls=llm_calls+excluded.llm_calls, tokens=tokens+excluded.tokens`,
      day, d.credits ?? 0, d.searches ?? 0, d.extracts ?? 0, d.llm_calls ?? 0, d.tokens ?? 0,
    );
  }

  spendTotal(): number {
    return Number(this.get("SELECT COALESCE(SUM(credits),0) AS c FROM spend")?.c ?? 0);
  }

  spendFor(day: string): Row {
    return this.get("SELECT * FROM spend WHERE day=?", day) ?? { day, credits: 0, searches: 0, extracts: 0, llm_calls: 0, tokens: 0 };
  }

  /** Delete reports older than the retention window. */
  sweep(olderThanMs: number): number {
    return Number(this.run("DELETE FROM reports WHERE created_at < ?", Date.now() - olderThanMs).changes);
  }
}
