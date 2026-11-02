// Halflife platform adapter: ChatGPT (chatgpt.com, chat.openai.com).
//
// Everything ChatGPT-specific lives here. content.js only talks to the adapter interface:
//   responses(doc)            → [{ key, el, anchor, messageId }]   one entry per assistant turn
//   isGenerating(doc)         → boolean                            any answer still streaming
//   isComplete(resp, doc)     → boolean                            safe to analyse this one
//   answerText(resp)          → string
//   questionFor(resp, doc)    → Promise<string|null>               the user turn just before it
//   modelSlug(resp)           → string|null
//   conversationId(location)  → string|null
//
// DOM selectors are not a stable API. Three layouts are read, newest knowledge last:
//   A. legacy:  [data-message-author-role] + data-message-id (inside section/article turn shells)
//   B. 2026-09: "search units" [data-chatgpt-search-unit-key$=":assistant"] with
//               data-chatgpt-selection-message-id (observed by the Apache-2.0
//               dialoguesai/chatgpt-shadow-extension; re-implemented here, not copied)
//   C. turn shells only: [data-turn="assistant"] (virtualised, or role attributes renamed)
// The first layout that finds assistant messages wins. When none matches, no button is shown:
// a missing button is a safe failure; a wrong extraction is not.
(function () {
  "use strict";

  const ROLE = "[data-message-author-role]";
  const UNIT = "[data-chatgpt-search-unit-key]";
  const TURN = 'section[data-turn], article[data-turn], [data-testid^="conversation-turn-"]';
  const MARKDOWN = '.markdown, [data-markdown-text-style], [data-message-content]';
  const GENERATING = [
    '[data-testid="stop-button"]',
    'button[data-testid*="stop-streaming"]',
    ".result-streaming",
    '[data-is-streaming="true"]',
  ].join(",");
  const STREAM_STATE = /stream|progress|pending|generat|running/i;
  const HOST_ATTR = "data-halflife-host";

  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) || "" : "");
  const normText = (s) => String(s || "").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  function turnOf(el) {
    return el.closest(TURN);
  }

  function roleOfTurn(turn) {
    const t = attr(turn, "data-turn").toLowerCase();
    if (t === "user" || t === "assistant") return t;
    const inner = turn.querySelector(ROLE);
    if (inner) return attr(inner, "data-message-author-role").toLowerCase();
    const unit = turn.querySelector(UNIT);
    if (unit) return unitRole(unit);
    if (turn.querySelector("[data-user-message-bubble]")) return "user";
    return "";
  }

  function unitRole(unit) {
    const m = attr(unit, "data-chatgpt-search-unit-key").match(/:(user|assistant)$/i);
    if (m) return m[1].toLowerCase();
    const tagged = attr(unit, "data-conversation-role") || attr(unit.querySelector("[data-conversation-role]"), "data-conversation-role");
    if (tagged) return tagged.toLowerCase();
    return unit.querySelector("[data-user-message-bubble]") ? "user" : "";
  }

  function unitMessageId(unit) {
    const own = attr(unit, "data-chatgpt-selection-message-id") || attr(unit.querySelector("[data-chatgpt-selection-message-id]"), "data-chatgpt-selection-message-id");
    return own || attr(unit, "data-chatgpt-search-message-ids").trim().split(/\s+/)[0] || "";
  }

  const topLevel = (els, sel) => els.filter((el) => !(el.parentElement && el.parentElement.closest(sel)));

  /** Assistant message elements, grouped into one entry per turn (a turn can hold several
   *  assistant parts when tools are used; the answer is all of them, the id is the last one's). */
  function responses(doc) {
    let parts = [];
    let layout = "";
    const legacy = Array.from(doc.querySelectorAll('[data-message-author-role="assistant"]'));
    if (legacy.length) {
      layout = "A";
      parts = legacy.map((el) => ({ el, id: attr(el, "data-message-id") }));
    } else {
      const units = topLevel(Array.from(doc.querySelectorAll(UNIT)), UNIT).filter((u) => unitRole(u) === "assistant");
      if (units.length) {
        layout = "B";
        parts = units.map((el) => ({ el, id: unitMessageId(el) }));
      } else {
        const turns = Array.from(doc.querySelectorAll(TURN)).filter((t) => attr(t, "data-turn") === "assistant" && t.querySelector(MARKDOWN));
        layout = "C";
        parts = turns.map((el) => ({ el, id: attr(el, "data-turn-id") || attr(el, "data-message-id") }));
      }
    }
    const groups = new Map();
    for (const p of parts) {
      const container = (layout !== "C" && turnOf(p.el)) || p.el;
      const g = groups.get(container) || { container, parts: [] };
      g.parts.push(p);
      groups.set(container, g);
    }
    return Array.from(groups.values()).map((g) => {
      const last = g.parts[g.parts.length - 1];
      const messageId = sanitizeId(last.id) || null;
      return { key: messageId || null, el: last.el, parts: g.parts.map((p) => p.el), container: g.container, anchor: g.container, messageId, layout };
    });
  }

  function sanitizeId(id) {
    const s = String(id || "").trim();
    return /^[A-Za-z0-9:._-]{1,200}$/.test(s) ? s : "";
  }

  function isGenerating(doc) {
    if (doc.querySelector(GENERATING)) return true;
    return Array.from(doc.querySelectorAll("[data-talvt-turn-state]")).some((n) => STREAM_STATE.test(attr(n, "data-talvt-turn-state")));
  }

  /** Complete = has text, carries no streaming marker itself, and is not the last answer while
   *  the page is still generating. content.js adds a text-stability double read on click. */
  function isComplete(resp, doc) {
    if (resp.parts.some((p) => p.matches(".result-streaming, [data-is-streaming='true']") || p.querySelector(".result-streaming, [data-is-streaming='true']"))) return false;
    if (!answerText(resp)) return false;
    if (isGenerating(doc)) {
      const all = responses(doc);
      if (all.length && all[all.length - 1].container === resp.container) return false;
    }
    return true;
  }

  function textOfPart(el) {
    // Skip our own UI, and text inside a nested search unit (a duplicate rendering of a message).
    const roots = Array.from(el.querySelectorAll(MARKDOWN)).filter((r) => {
      if (r.closest(`[${HOST_ATTR}]`)) return false;
      const u = r.closest(UNIT);
      return !u || u === el || !el.contains(u) || u.contains(el);
    });
    const top = topLevel(roots, MARKDOWN);
    const read = (n) => (typeof n.innerText === "string" && n.innerText !== "" ? n.innerText : n.textContent);
    if (top.length) return normText(top.map(read).join("\n\n"));
    // No markdown root: read the element, minus buttons and our own UI.
    const clone = el.cloneNode(true);
    clone.querySelectorAll(`button, svg, nav, [${HOST_ATTR}], .sr-only`).forEach((n) => n.remove());
    return normText(clone.textContent);
  }

  function answerText(resp) {
    return normText(resp.parts.map(textOfPart).filter(Boolean).join("\n\n"));
  }

  function userText(turnOrUnit) {
    const msg = turnOrUnit.matches && turnOrUnit.matches('[data-message-author-role="user"]') ? turnOrUnit : turnOrUnit.querySelector('[data-message-author-role="user"]');
    const scope = msg || turnOrUnit.querySelector("[data-user-message-bubble]") || turnOrUnit;
    const body = scope.querySelector(".whitespace-pre-wrap") || scope.querySelector(MARKDOWN) || scope;
    const clone = body.cloneNode(true);
    clone.querySelectorAll(`button, svg, [${HOST_ATTR}], .sr-only`).forEach((n) => n.remove());
    return normText(clone.textContent);
  }

  /** The user message immediately before this answer, and nothing else. */
  function previousUser(resp, doc) {
    // Ordered candidates of either role, in document order.
    let items;
    if (resp.layout === "B") items = topLevel(Array.from(doc.querySelectorAll(UNIT)), UNIT).map((u) => ({ el: u, role: unitRole(u) }));
    else {
      const turns = Array.from(doc.querySelectorAll(TURN));
      items = turns.length
        ? turns.map((t) => ({ el: t, role: roleOfTurn(t) }))
        : Array.from(doc.querySelectorAll(ROLE)).map((m) => ({ el: m, role: attr(m, "data-message-author-role").toLowerCase() }));
    }
    const own = resp.layout === "B" ? resp.el : resp.container;
    const idx = items.findIndex((i) => i.el === own || i.el.contains(own) || own.contains(i.el));
    for (let i = idx - 1; i >= 0; i--) {
      if (items[i].role === "user") return items[i].el;
      if (items[i].role === "assistant") return null; // another answer in between: no question for this one
    }
    return null;
  }

  // rAF does not fire in background tabs, so it is raced against a timer.
  const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function scrollParent(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement;
  }

  /** Virtualised threads keep empty turn shells off-screen. If the question turn is empty,
   *  bring it into view briefly to hydrate it, read it, and restore the scroll position. */
  async function questionFor(resp, doc) {
    const turn = previousUser(resp, doc);
    if (!turn) return null;
    let text = userText(turn);
    if (text) return text;
    const scroller = scrollParent(turn);
    const top = scroller ? scroller.scrollTop : 0;
    try {
      turn.scrollIntoView({ block: "center", behavior: "instant" });
      for (let i = 0; i < 12 && !text; i++) {
        await frame();
        await sleep(50);
        text = userText(turn);
      }
    } finally {
      if (scroller) scroller.scrollTop = top;
    }
    return text || null;
  }

  function modelSlug(resp) {
    for (let i = resp.parts.length - 1; i >= 0; i--) {
      const p = resp.parts[i];
      const s = attr(p, "data-message-model-slug") || attr(p.querySelector("[data-message-model-slug]"), "data-message-model-slug");
      if (/^[A-Za-z0-9._:-]{1,100}$/.test(s)) return s;
    }
    return null;
  }

  function conversationId(loc) {
    const m = String(loc.pathname || "").match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
    return m ? m[1].toLowerCase() : null;
  }

  const adapter = {
    id: "chatgpt",
    hosts: ["chatgpt.com", "chat.openai.com"],
    supports: (loc) => adapter.hosts.includes(loc.hostname),
    responses, isGenerating, isComplete, answerText, questionFor, modelSlug, conversationId,
  };
  const g = typeof globalThis !== "undefined" ? globalThis : window;
  g.HalflifeAdapters = Object.assign(g.HalflifeAdapters || {}, { chatgpt: adapter });
})();
