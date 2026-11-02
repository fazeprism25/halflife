// Halflife extension service worker (MV3).
//
// The only part of the extension that talks to the network, and only to the configured Halflife
// engine on a loopback address. It holds the pairing token in its own IndexedDB: content scripts
// run in the ChatGPT page's origin and cannot read it (they *can* read chrome.storage.local, which
// therefore only holds non-secret settings).
//
// Messages are accepted only from this extension's own content scripts on ChatGPT pages and its
// own popup. Content scripts send data fields only, never URLs; every URL is built here.

const DEFAULT_ENGINE = "http://127.0.0.1:8090";
const CHAT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"];
const ID_RE = /^hl_[a-f0-9]{8,40}$/;
const LIMITS = { answer: 60000, question: 4000 };

// ------------------------------------------------------------------ token store (IndexedDB)

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("halflife", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("kv", mode);
    const r = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}
const getToken = () => kv("readonly", (s) => s.get("token")).then((v) => (typeof v === "string" ? v : null));
const setToken = (t) => kv("readwrite", (s) => s.put(t, "token"));
const clearToken = () => kv("readwrite", (s) => s.delete("token"));

// ------------------------------------------------------------------ settings (non-secret)

async function settings() {
  const s = await chrome.storage.local.get({ engineUrl: DEFAULT_ENGINE, paused: false, paired: false });
  return { engineUrl: normaliseEngineUrl(s.engineUrl) || DEFAULT_ENGINE, paused: !!s.paused, paired: !!s.paired };
}

/** Loopback http only; path, query and credentials are dropped. Returns null when not allowed. */
function normaliseEngineUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname) || u.username || u.password) return null;
    return `http://${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ engine calls

class EngineError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind; // offline | unpaired | paused | limit | invalid | server
    this.status = status;
  }
}

async function engine(path, { method = "GET", body, timeout = 8000, auth = true } = {}) {
  const { engineUrl } = await settings();
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth) {
    const token = await getToken();
    if (!token) throw new EngineError("unpaired", "Not connected to Halflife. Open the extension and pair it with your Halflife console.");
    headers.authorization = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(engineUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), credentials: "omit", cache: "no-store", redirect: "error" });
  } catch (e) {
    const timedOut = e && e.name === "TimeoutError";
    throw new EngineError("offline", timedOut ? `Halflife at ${engineUrl} did not respond in time.` : `Halflife isn't reachable at ${engineUrl}. Is the engine running?`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.ok) return data;
  const msg = (data && typeof data.error === "string" && data.error.slice(0, 300)) || `HTTP ${res.status}`;
  if (res.status === 401 && auth) {
    await clearToken();
    await chrome.storage.local.set({ paired: false });
    throw new EngineError("unpaired", "This browser's Halflife connection was revoked or has expired. Pair it again from the extension.", 401);
  }
  if (res.status === 403) throw new EngineError("paused", msg, 403);
  if (res.status === 429) throw new EngineError("limit", msg, 429);
  if (res.status === 400 || res.status === 413 || res.status === 415) throw new EngineError("invalid", msg, res.status);
  throw new EngineError("server", msg, res.status);
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ message handling

const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);

/** Validates the content script's payload and builds the engine request from it. */
async function buildCheck(p) {
  if (!p || typeof p !== "object") throw new EngineError("invalid", "malformed request");
  const answer = str(p.answer, LIMITS.answer);
  if (!answer || !answer.trim()) throw new EngineError("invalid", p.answer && p.answer.length > LIMITS.answer ? `This answer is longer than ${LIMITS.answer.toLocaleString()} characters, the most Halflife checks at once.` : "This answer has no text to check.");
  // Long questions are truncated, not dropped: the engine accepts at most LIMITS.question characters.
  const question = typeof p.question === "string" && p.question.trim() ? p.question : null;
  const messageId = p.message_id && /^[A-Za-z0-9:._-]{1,200}$/.test(p.message_id) ? p.message_id : undefined;
  const model = p.model && /^[A-Za-z0-9._:-]{1,100}$/.test(p.model) ? p.model : undefined;
  const conv = p.conversation_id && /^[0-9a-f-]{36}$/.test(p.conversation_id) ? await sha256Hex("chatgpt:" + p.conversation_id) : undefined;
  return {
    platform: "chatgpt", answer,
    ...(question ? { question: question.length > LIMITS.question ? question.slice(0, LIMITS.question - 1) + "…" : question } : {}),
    ...(messageId ? { message_id: messageId } : {}), ...(model ? { model } : {}), ...(conv ? { conversation_hash: conv } : {}),
    ...(p.force === true ? { force: true } : {}),
  };
}

function fromChatTab(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
  try {
    return CHAT_ORIGINS.includes(new URL(sender.url).origin);
  } catch {
    return false;
  }
}
// Only this extension's own pages can have a chrome-extension://<own id>/popup/ URL (content
// scripts report the page's URL), so the URL alone identifies the popup, also when opened as a tab.
const fromPopup = (sender) => sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL("popup/"));

const handlers = {
  // ---- content script (ChatGPT tab)
  async "hl.state"() {
    const s = await settings();
    return { paused: s.paused, paired: s.paired };
  },
  async "hl.check"(msg) {
    const s = await settings();
    if (s.paused) throw new EngineError("paused", "Halflife is paused. Resume it from the extension.");
    return engine("/v1/extension/checks", { method: "POST", body: await buildCheck(msg.payload), timeout: 15000 });
  },
  async "hl.poll"(msg) {
    if (!ID_RE.test(String(msg.id))) throw new EngineError("invalid", "bad id");
    return engine(`/v1/extension/checks/${msg.id}`);
  },
  async "hl.open"(msg) {
    const { engineUrl } = await settings();
    const path = ID_RE.test(String(msg.id)) ? `/#/activity/${msg.id}` : "/#/activity";
    await chrome.tabs.create({ url: engineUrl + path });
    return { ok: true };
  },
};

const popupHandlers = {
  async "hl.status"() {
    const s = await settings();
    if (!s.paired) return { ...s, connection: "unpaired" };
    try {
      const [status, recent] = await Promise.all([engine("/v1/extension/status", { timeout: 4000 }), engine("/v1/extension/checks?limit=6", { timeout: 4000 })]);
      return { ...s, connection: "connected", status, recent: recent.checks };
    } catch (e) {
      return { ...(await settings()), connection: e.kind === "unpaired" ? "unpaired" : "offline", error: e.message };
    }
  },
  async "hl.pair"(msg) {
    const url = normaliseEngineUrl(msg.engineUrl);
    if (!url) throw new EngineError("invalid", "The Halflife address must be http://127.0.0.1:<port> or http://localhost:<port>.");
    const code = String(msg.code || "").toUpperCase().replace(/[\s-]/g, "");
    if (!/^[A-Z2-9]{8}$/.test(code)) throw new EngineError("invalid", "A pairing code has 8 letters and digits.");
    await chrome.storage.local.set({ engineUrl: url });
    const r = await engine("/v1/extension/pair", { method: "POST", body: { code }, auth: false });
    if (!r || typeof r.token !== "string" || !r.token.startsWith("hlx_")) throw new EngineError("server", "Unexpected pairing response.");
    await setToken(r.token);
    await chrome.storage.local.set({ paired: true });
    return { ok: true };
  },
  async "hl.disconnect"() {
    try {
      await engine("/v1/extension/token", { method: "DELETE", timeout: 3000 });
    } catch {
      /* offline: the local token is still removed; revoke it from the console as well */
    }
    await clearToken();
    await chrome.storage.local.set({ paired: false });
    return { ok: true };
  },
  async "hl.setPaused"(msg) {
    await chrome.storage.local.set({ paused: msg.paused === true });
    return { paused: msg.paused === true };
  },
  async "hl.open"(msg) {
    return handlers["hl.open"](msg);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const type = msg && typeof msg.type === "string" ? msg.type : "";
  const table = fromChatTab(sender) ? handlers : fromPopup(sender) ? popupHandlers : null;
  const fn = table && Object.hasOwn(table, type) ? table[type] : null;
  if (!fn) return false;
  fn(msg).then(
    (data) => reply({ ok: true, data }),
    (e) => reply({ ok: false, error: { kind: e.kind || "server", message: e.message || String(e), status: e.status || 0 } }),
  );
  return true; // async reply
});

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(["engineUrl"]);
  if (!s.engineUrl) await chrome.storage.local.set({ engineUrl: DEFAULT_ENGINE, paused: false, paired: !!(await getToken()) });
});
