# Halflife for ChatGPT (browser extension)

This extension adds a **Check freshness** action under each completed ChatGPT answer. When you click it, that one answer goes to **your own local Halflife engine**. The engine runs its normal pipeline:
- claim extraction
- freshness estimate
- live verification through Bifrost's Tavily relay, within the existing credit guard

A compact result appears under the answer. The full analysis is in the Halflife console under **ChatGPT → Activity**.

- **Manifest V3.** Supports `chatgpt.com` and `chat.openai.com`. Tested in Chromium-based browsers (Edge and Chrome).
- **No dependencies, no build step.** Not published to any extension store.
- **Opt-in per answer.** Nothing is read or sent until you click.

## Install (developer mode)

1. Start Halflife (`docker compose -f deploy/docker-compose.yml up -d`). Then open the console at <http://localhost:8090> and go to **ChatGPT → Extension**.
2. Open `chrome://extensions` or `edge://extensions` and turn on **Developer mode**. Choose **Load unpacked** and select this `extension/` folder.
3. Click **Create pairing code** in the console. Open the extension popup and enter:
   - the console address, `http://127.0.0.1:8090`
   - the code (valid once, for 10 minutes)
4. In ChatGPT, click **Check freshness** under an answer.

## What leaves the browser, and when

| When | What | Where |
|---|---|---|
| You click **Check freshness** | That answer's text; the user message directly before it; ChatGPT's message id; the model slug if the page shows one; SHA-256 of `chatgpt:<conversation id>` | Your engine on `127.0.0.1` or `localhost` only |
| While the check runs | Its report id, to poll its status | Same |
| You open the popup | Status request, recent checks of this browser's connection | Same |

Nothing else is sent:
- no other messages, drafts, titles, page HTML, cookies or account data
- no ChatGPT session token (the extension never reads it)
- no background capture and no telemetry

The engine then sends extracted claims to the judge model through Bifrost, and search queries to Tavily through the Bifrost relay, as it does for any other traffic. **Provider API keys never reach the browser.**

## How it works

```
content script (ChatGPT tab)          service worker                     Halflife engine
  adapters/chatgpt.js  ── DOM ──▶      validates sender + payload  ──▶   /v1/extension/checks
  content.js (button, shadow UI)       holds token (IndexedDB)            → Engine.accept(source="extension",
                       ◀── result ──   builds every URL itself     ◀──      learn:false) → same pipeline
```

- **`src/adapters/chatgpt.js`** holds everything ChatGPT-specific: selectors, message ids, the streaming state, and the virtualised-thread handling. It reads three DOM layouts, and none of them is assumed permanent:
  - **A:** legacy `data-message-author-role`
  - **B:** the September 2026 "search unit" layout
  - **C:** turn shells
  - If none matches, no button appears. Adding another platform means adding another adapter.
- **`src/content.js`** handles the UI and the check flow:
  - It shows the button only on **completed** answers. While ChatGPT is generating, the last answer gets none.
  - On click it reads the text twice, 600 ms apart, and refuses if the text changed.
  - The UI lives in a closed shadow root, so ChatGPT's styles and ours never interact. It follows ChatGPT's own light or dark theme.
- **`src/background.js`** is the only network caller, and only to a loopback engine address.
  - The pairing token lives in the service worker's IndexedDB, which content scripts (running in the page's origin) can't read.
  - Messages are accepted only from this extension's content scripts on ChatGPT and from its popup.
- **`popup/`** has four parts:
  - connection status and pairing
  - today's and total checks
  - pause/resume (pausing hides every button and sends nothing)
  - recent checks, a diagnostics line (which layout was recognised and how many answers; counts only), and disconnect

## Security model

- **Permissions:** `storage` plus host access to ChatGPT and to `http://127.0.0.1` and `http://localhost`. Nothing else: no `tabs`, `scripting`, `cookies`, `webRequest` or `externally_connectable`.
- **Pairing:** a one-time code from the authenticated console is exchanged for a random 256-bit token. The engine stores only its SHA-256, bound to this extension's `chrome-extension://` origin.
- **Origin binding:** a request carrying a different `Origin` is refused, even with a valid token.
- **Loopback only:** extension routes are served only for a loopback `Host` header (DNS-rebinding defence).
- **Scope:** a token can create checks, read **its own** checks and read a minimal status. It can't read gateway traffic, the event stream, settings, or other connections' checks.
- **Server-side limits:**
  - strict schema (unknown fields are refused)
  - answer ≤ 60,000 characters, question ≤ 4,000, body ≤ 256 KB
  - per-minute and per-day check limits
  - a kill switch, and an estimate-only mode (0 search credits)
- **Duplicates:** the same message with the same text returns the saved analysis and spends nothing. Edited or regenerated text is a new check.
- **Revocation:** disconnect from the popup, or revoke from the console. Checks can be deleted one at a time or all at once, and have their own retention period (default 30 days).

## Tests

```bash
node --test "extension/test/*.test.mjs"          # adapter (8) + end-to-end (6); needs Edge or Chrome, and openssl for e2e
```

- **`test/adapter.test.mjs`** runs the unmodified adapter in headless Edge or Chrome against **test-fixture DOMs**. It covers:
  - layouts A and B
  - streaming markers
  - turn-state attributes
  - virtualised question shells (hydrated by scrolling, scroll restored)
  - unrelated turns
  - unsafe ids
  - unknown layouts
  - 50,000-character answers
- **`test/e2e.test.mjs`** loads the **real unpacked extension** via CDP `Extensions.loadUnpacked`. Branded Chrome and Edge 137+ ignore `--load-extension`.
  - The ChatGPT stand-in is a test-fixture page served as `https://chatgpt.com` through host-resolver mapping and a throwaway certificate.
  - The engine is the real HTTP server with a scripted model and search (`engine/test/fixture-server.ts`).
  - It covers: pairing through the popup, buttons only on completed answers, exactly what is sent, the compact result, duplicate selection after a reload, pause/resume, and the engine being unavailable.
  - Set `HALFLIFE_E2E_SHOTS=<dir>` to save screenshots.

**Not covered automatically:** the live chatgpt.com page. Its DOM changes without notice, and testing it needs a signed-in account. See the manual checklist in `research/CHATGPT_EXTENSION.md`.

## Limitations

- **DOM-based by design.** A ChatGPT redesign can hide the button until the adapter is updated. The popup's diagnostics line shows when no answers are recognised.
- **Text only.** Images, files, canvas documents and code-interpreter output are not checked. Tables and lists are read as plain text.
- **Questions can be missing.** If the question turn can't be hydrated, the answer is checked without it, and the console says so.
- **Not tested on real chatgpt.com by the automated suite.** See above.
- **Chromium only.** The service worker and CDP test setup are Chromium-specific; Firefox has not been tried.

The icons are generated by `scripts/make-icons.mjs` (no dependencies).
