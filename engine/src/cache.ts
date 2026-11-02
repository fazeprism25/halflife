// Freshness-aware cache actions on Bifrost's semantic cache (AD-11).
//   invalidate_stale     a claim in the cached answer was judged superseded/contradicted
//   expire_reuse_window  the answer's earliest claim reuse window ends before the cache TTL
// Actions persist in SQLite and run from a timer, so they survive engine restarts.

import type { Store } from "./store.ts";

export type CacheDeps = {
  bifrostUrl: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
  onDone?: (row: { report_id: string; action: string; status: string; result: string }) => void;
};

export class CacheActions {
  private store: Store;
  private deps: CacheDeps;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(store: Store, deps: CacheDeps) {
    this.store = store;
    this.deps = deps;
  }

  schedule(reportId: string, cacheId: string, action: "invalidate_stale" | "expire_reuse_window", dueAt: number, reason: string) {
    // One pending action per cache entry: the earliest wins.
    const existing = this.store.get("SELECT id, due_at FROM cache_actions WHERE cache_id=? AND status='pending'", cacheId);
    if (existing) {
      if (dueAt < Number(existing.due_at)) {
        this.store.run("UPDATE cache_actions SET due_at=?, action=?, reason=?, report_id=? WHERE id=?", dueAt, action, reason, reportId, existing.id);
      }
      return;
    }
    this.store.insert("cache_actions", { report_id: reportId, cache_id: cacheId, action, due_at: dueAt, status: "pending", reason, created_at: Date.now() });
  }

  start(intervalMs = 5000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      const due = this.store.all("SELECT * FROM cache_actions WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 20", now);
      for (const row of due) {
        const r = await this.clear(String(row.cache_id));
        this.store.run("UPDATE cache_actions SET status=?, result=?, done_at=? WHERE id=?", r.ok ? "done" : "failed", r.result, Date.now(), row.id);
        this.deps.onDone?.({ report_id: row.report_id, action: row.action, status: r.ok ? "done" : "failed", result: r.result });
        n++;
      }
    } finally {
      this.busy = false;
    }
    return n;
  }

  /** DELETE /api/cache/clear/{id}. A 404 means the entry already expired: also success. */
  async clear(cacheId: string): Promise<{ ok: boolean; result: string }> {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(cacheId)) return { ok: false, result: "invalid cache id" };
    const f = this.deps.fetchImpl ?? fetch;
    try {
      const headers: Record<string, string> = {};
      if (this.deps.adminToken) headers["X-Bifrost-Setup-Token"] = this.deps.adminToken;
      const res = await f(`${this.deps.bifrostUrl}/api/cache/clear/${encodeURIComponent(cacheId)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(5000) });
      const body = (await res.text()).slice(0, 200);
      if (res.ok) return { ok: true, result: `HTTP ${res.status}` };
      if (res.status === 404) return { ok: true, result: "entry already gone (404)" };
      if (res.status === 401 || res.status === 403) return { ok: false, result: `Bifrost refused the admin credential (HTTP ${res.status})` };
      return { ok: false, result: `HTTP ${res.status} ${body}` };
    } catch (e) {
      return { ok: false, result: `unreachable: ${(e as Error).message}` };
    }
  }
}
