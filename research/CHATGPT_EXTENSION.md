# ChatGPT extension: research and architecture (session 10, 2026-11-03)

This note covers the opt-in Halflife browser extension for ChatGPT: the user picks one assistant answer, and Halflife checks the claims in it.

The decision record is AD-32 in `ARCHITECTURE_DECISIONS.md`. The code is in `extension/`, plus the engine routes in `engine/src/extension.ts`.

## 1. Reference projects (source and licences inspected via the GitHub API, 2026-11-03)

| | dialoguesai/chatgpt-shadow-extension | maks-bond/chatgpt-conversation-exporter | kappilyadav/chatgpt-exporter |
|---|---|---|---|
| **Licence** | Apache-2.0 | **None** (all rights reserved by default) | MIT |
| **Purpose** | Mirrors every chat into local storage; optional sync to its own server | Exports the open conversation (Markdown, JSON, text) | Exports to PDF, DOCX, Markdown and more; bulk export |
| **MV3 shape** | SW + 2 classic content scripts + popup; `storage`, `unlimitedStorage`, `identity` | Content script + popup; `activeTab`, `downloads`, `clipboardWrite` (narrowest) | SW + 25 content scripts + options page; `externally_connectable` to its website |
| **Extraction** | **DOM.** Reads two layouts: legacy `[data-message-author-role]`, and the **late-September 2026** "search unit" layout `[data-chatgpt-search-unit-key$=":assistant"]` with `data-chatgpt-selection-message-id` | DOM turn shells `section[data-turn-id][data-turn]`; falls back to `/backend-api/conversation/{id}` using the **session access token** | **Backend API first** (`/api/auth/session` → bearer token → `/backend-api/conversation/{id}`); DOM fallback |
| **Message identity** | ChatGPT's message id; otherwise `role:index:hash(collapsed text)` | `data-message-id`, turn index | API node ids |
| **Streaming** | Global: `[data-testid="stop-button"]` present, or `[data-talvt-turn-state]` matching stream, progress or pending. A false "settled" costs one resend | n/a (manual export) | n/a |
| **Virtualisation** | MutationObserver plus debounce; captures what is hydrated | Documents that off-screen turns are **empty shells**; scrolls each into view, then restores the scroll position | Avoided by using the API |
| **Selection UI** | None (captures everything) | None | Floating panel |
| **Server comms** | `chrome.runtime.sendMessage` to the SW, which does the network calls | none | none |

**Useful patterns, adopted (re-implemented, not copied):**
- **Layered selectors, legacy first, new layout as fallback** (shadow). This is the most current DOM knowledge available. Its 2026-10 code says `data-message-author-role` disappeared in late September 2026.
- **Streaming = stop button present OR a turn-state attribute that matches stream/progress** (shadow), plus our own **text-stability double read**.
- **Empty turn shells under virtualisation** (maks): the question turn may be dehydrated. Scroll it into view briefly, then restore the scroll position.
- **Content-hash fallback ids from whitespace-collapsed text** (shadow).
- **Network only in the service worker** (shadow; also the Chrome guidance).

**Rejected:**
- **Reading ChatGPT's session access token and calling `/backend-api`** (maks fallback, kappilyadav primary). It handles the user's ChatGPT credential and fetches the whole conversation. That breaks "no unrelated conversation history" and is far more privilege than needed.
- `unlimitedStorage`, `identity`, `downloads`, `externally_connectable`, remote update checks (shadow fetches `raw.githubusercontent.com`).

**Licence compliance:** no code was copied from any of the three projects. maks-bond has no licence, so its code must not be reused at all; we only learned observed DOM facts from its notes. The shadow (Apache-2.0) ideas are re-implemented, and attribution for the DOM knowledge is given in `THIRD_PARTY_NOTICES.md` as a courtesy.

## 2. Platform facts checked (Chrome docs, 2026-11-03)

- **Cross-origin fetches:** content scripts can't make them even with host permissions. The service worker can, if `host_permissions` covers the target. Content scripts must send minimal input, never a URL, and the SW builds the URL (developer.chrome.com, "Cross-origin network requests").
- **Local Network Access:** this gates *web page* requests from public sites to local or loopback addresses. Our request comes from the extension service worker, not the chatgpt.com page. Third-party sources say extension contexts with host permission are not prompted. **This was not verified in a real browser.** It is a manual-test item.
- **Content-script storage:** content scripts can read `chrome.storage.local` by default. A compromised ChatGPT renderer could therefore read anything kept there. So the pairing token is kept in the **service worker's own IndexedDB** (extension origin), which content scripts can't reach.

## 3. Architecture (summary of AD-32)

```
ChatGPT tab                          extension service worker              Halflife engine (127.0.0.1:8090)
┌──────────────────────────┐  msg   ┌───────────────────────────┐  HTTP   ┌─────────────────────────────┐
│ adapter (chatgpt.js)     │──────▶ │ validates sender + schema │ ──────▶ │ /v1/extension/* (scoped     │
│ finds completed answers  │ check  │ holds token (IndexedDB)   │ Bearer  │  bearer token, origin-bound)│
│ shadow-DOM button        │◀────── │ builds every URL itself   │ ◀────── │ → engine.accept(source=     │
│ compact result           │ result │ pause / disconnect        │         │   "extension", learn:false) │
└──────────────────────────┘        └───────────────────────────┘         │ → same pipeline: Bifrost LLM│
                                                                          │   + Tavily relay + guards   │
                                                                          └─────────────────────────────┘
```

- **One engine.** Checks go through `Engine.accept`, with the same extraction, freshness model, Bifrost-routed judge, Tavily relay, credit guard and per-response cap.
- **Learning is off for extension checks** (`learn:false`). The user picks which answers to check, and selected traffic biases class change rates (AD-23).
- **Pairing:** the console creates a one-time 8-character code (valid 10 minutes). The extension exchanges it for a 32-byte token. The engine stores only `sha256(token)` and the extension origin it was claimed from. Every later request must present that token from that same `chrome-extension://` origin. Tokens can be revoked from the console or by "Disconnect" in the extension.
- **Scope:** an extension token can only create checks, read **its own** extension checks, and read a minimal status. It can't read gateway traffic, the event stream, the playground or settings.
- **Limits (server side):** answer ≤ 60,000 characters, question ≤ 4,000, body ≤ 256 KB. A per-minute rate limit and a daily check limit come from settings. Settings also hold the server-side kill switch ("accept checks") and a live-verification toggle; with verification off, checks are assess-only and spend 0 credits.
- **Dedup:** `client_ref = chatgpt:<message id>`, plus `content_hash = sha256(normalised answer)`.
  - Same ref and same hash: the existing report is returned (no spend).
  - Same ref with a different hash (edited, or re-rendered after streaming): a new report.
  - A regenerated answer gets a new message id, so it is a new report.
- **Retention:** extension reports have their own retention (default 30 days) on top of the global sweep. The user can delete one report or all extension data.

## 4. What leaves the browser, and when

Only after the user clicks **Check freshness** on one answer, and only to the configured loopback engine URL. The request contains:
- the text of that one answer
- the user message directly before it
- the ChatGPT message id
- the model slug, if the page shows one
- the conversation id from the URL, hashed with SHA-256 in the extension

Nothing else is sent: no other messages, page content, titles, account data or cookies. There is no telemetry. The engine then sends extracted claims to the judge model through Bifrost, and search queries to Tavily through the Bifrost relay, exactly as for gateway traffic.

## 5. Verification status (session 10)

**Automated, passing:**
- **Engine:** 65/65 tests. That is the 54 existing ones plus 11 in `engine/test/extension.test.ts`, covering:
  - pairing, origin binding and brute-force withdrawal
  - token scope and the loopback Host check
  - learn:false
  - duplicates, edits and force
  - strict validation and size limits
  - kill switch, assess-only, per-minute and daily limits
  - connection isolation and revocation
  - activity, claims and trends views
  - deletion and retention
  - the assessment mapping
  - migration of an old database
- **Extension:** 14/14, i.e. adapter 8/8 and end-to-end 6/6. The end-to-end run uses the real unpacked extension in headless Edge 156, a TEST FIXTURE ChatGPT page served as `https://chatgpt.com`, and the real engine HTTP server with scripted model and search.
- **Integration:** 13/13 against real Bifrost v2.4.0, the real plugin and the rebuilt engine image. No regression.
- **Live smoke test** against the running stack:
  - One assess-only check went through the real path: real DeepSeek extraction via Bifrost, classes `org.leadership` and `historical.fact`, 0 Tavily credits.
  - The live database migrated in place: 308 reports kept, 4 columns and the token table added. It was backed up first to `engine/data/backup-before-extension-migration.db` (gitignored).
  - The smoke check was deleted and its token revoked afterwards.

**Real browser on chatgpt.com (session 11, 2026-11-03): passed, operator-reported.** The operator loaded the extension unpacked in their own signed-in browser and used it on chatgpt.com. It recognised the live answers, its checks reached the local engine, and the results appeared in the console's ChatGPT pages. No adapter change was needed. The result was reported as a whole, not item by item, so the checklist below is kept for re-testing after ChatGPT redesigns; items 8 to 10 (themes, pause/engine-stopped, Local Network Access) were not separately confirmed.

**Manual checklist (needs a human with a signed-in ChatGPT account):**
1. Load `extension/` unpacked in Chrome or Edge and pair it (see `extension/README.md`).
2. On chatgpt.com, open an existing conversation. The popup's diagnostics line should report a layout and the number of answers. **If it says "no ChatGPT answers recognised", the DOM has changed and the adapter needs updating.**
3. A **Check freshness** button appears under each finished answer, and not under one that is still being written. It appears once that answer finishes.
4. Click it on an answer with a dated fact. A compact result appears. **Open in Halflife** opens the console's Activity page on it.
5. In the console, check that the question shown is the message directly before that answer and nothing else.
6. In a long conversation, scroll far up, check an old answer, and confirm its question was captured.
7. Regenerate an answer and check the new version. It should be a separate check.
8. Switch ChatGPT between light and dark themes. The card should stay legible in both.
9. Pause from the popup: the buttons disappear. Resume: they return. Then stop the engine and check that a clear "isn't reachable" message appears.
10. Chrome's Local Network Access: confirm that no permission prompt appears. The requests come from the extension service worker, not the page.
