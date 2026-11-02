# Screenshots

Captured from the running local stack at commit `a2a296e` (engine image rebuilt from that commit), in a real, headed Microsoft Edge 156 window with a fresh profile. The browser's time zone was set to UTC, so every time shown is UTC. Dark theme (the console follows the system theme). Desktop shots are 1440 × 900 CSS px; the tablet shot is 1024 × 768; the phone shot is 390 × 844 at 2× pixel density.

**Data provenance.** Unless marked TEST FIXTURE, the screenshots show real reports stored by the local engine: answers from DeepSeek through the Bifrost gateway and Tavily evidence, produced during development runs, and one real chatgpt.com answer checked with the extension. Nothing was edited or blanked after capture. Third-party page titles and quotes appear as the product shows them; see [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).

| File | Shows | Data |
|---|---|---|
| `01-inspector-claim-report.png` | Inspector, sidebar collapsed: a two-claim answer; Node.js 22 superseded (strong evidence), React 19 current; cache entry invalidated | real |
| `02-sidebar-expanded.png` | the navigation sidebar docked open on desktop | real |
| `03-traffic-flyout-desktop.png` | Traffic (latest 100 reports) open to the right of the docked sidebar | real |
| `04-traffic-flyout-tablet.png` | 1024 px: overlay sidebar with Traffic beside it | real |
| `05-traffic-sheet-phone.png` | 390 px phone: Traffic as a full-screen sheet with a labelled Close button | real |
| `06-claim-panel-evidence.png` | claim panel of a `verify`-mode report: superseded, current value, timeline, the three measures, evidence rules and quote-verified sources (clipped to the panel) | real |
| `07-freshness-model.png` | Freshness model: half-life per class, prior vs posterior for one class | real |
| `08-system-integrations.png` | System: gateway, plugin, judge, Tavily, cache and playground status; daily spend | real |
| `09-system-tavily-usage-and-limits.png` | System: Tavily account usage exactly as `/usage` reports it, and Halflife's separate lifetime, daily and account-guard limits | real |
| `10-chatgpt-activity.png` | ChatGPT → Activity: one real check from chatgpt.com | real |
| `11-chatgpt-claim-explorer.png` | ChatGPT → Claim explorer: the claims of that check with sources | real |
| `12-chatgpt-trends.png` | ChatGPT → Trends: real aggregates (only one check, so sparse) | real |
| `13-chatgpt-extension-settings.png` | ChatGPT → Extension: the paired browser, pairing codes, limits | real |
| `14-extension-fixture-result.png` | the real unpacked extension's result under an answer | **TEST FIXTURE** page and scripted engine (0 tokens, 0 credits) |
| `15-extension-fixture-popup.png` | the extension popup after that check | **TEST FIXTURE** |

The TEST FIXTURE shots use a local page with ChatGPT's message markup (banner on the page; not chatgpt.com) and `engine/test/fixture-server.ts`, mirroring `extension/test/e2e.test.mjs`. A screenshot of the extension on real chatgpt.com was not taken, because it would show a personal signed-in account.

The screenshots that predate the collapsible sidebar (captured 2026-11-02, with local times blanked) were removed in the same change; they showed a layout that no longer exists.
