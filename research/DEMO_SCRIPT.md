# Halflife — Demo Script (≈ 5 minutes)

_Written 2026-11-02 (session 5). Every fact shown below was checked independently of the Tavily evidence that produced the verdict; the sources are listed under "Fact checks"._

## Before the demo (10 minutes ahead)

1. `docker compose -f deploy/docker-compose.yml up -d` (no rebuild). Wait for both containers to be `healthy` (`docker ps`).
2. Open the console at http://localhost:8090. Open **System**: Bifrost reachable, plugin "Reporting", judge and Tavily "Working".
3. Spend check: System → "Tavily account usage" (as Tavily reports it) and "Halflife spending limits". Engine credits must leave room for at least 20 credits today (the daily cap is 150).
4. **Optional, to show fresh Tavily calls on stage instead of reused verifications:** verifications are reused for their reuse window (T0, 0 credits). If the prompts below were run within the last few days, expect "reused verification, 0 credits". That is correct behaviour and worth saying out loud. For a guaranteed live search, use the ad-lib prompt in step 2b.
5. Rehearse with `node deploy/demo/run-demo.mjs`. It runs every step below through the real stack and writes a transcript to `deploy/demo/results/`.
6. Final-demo spend only: if the account guard (80% of the allowance Tavily reports; 800 of 1,000 on 2026-11-03) is close, set `HALFLIFE_TAVILY_CEILING_FRACTION=0.95` in `deploy/.env` and restart the engine (AD-19). Never enable Tavily pay-as-you-go.

## Script

**0. One sentence (15 s).** "LLM answers mix facts that never change with facts that expire in weeks. Halflife sits inside the Bifrost gateway, finds the claims that are likely to be outdated, checks them live with Tavily, and fixes the gateway's cache accordingly."

**1. Time-invariant facts cost nothing (30 s).** Console → Check → "Prompt via gateway", Async:
> Answer in one short sentence each: In what year was the Battle of Hastings fought? What is the chemical symbol for gold?

Show: two claims, both "Not time-sensitive", **0 Tavily credits**. Say: "Halflife checks freshness, not general truth. A time-invariant claim is never sent to search."

**2. Verify-before-reply (60 s).** Check → **Verify before reply**:
> In one short sentence: who is the current prime minister of the United Kingdom?

DeepSeek answers "Keir Starmer" (its training predates the change). The reply comes back with a Halflife note: *superseded; current: Andy Burnham*, citing a source. Show the response headers in the Check panel: `x-halflife-status: verified; 1 of 1 claim outdated`, `x-halflife-ttl: no-store`. Open the report: verified quotes from NPR / Georgetown (July 2026), evidence **strong**, timeline with the change on 2026-07-20.
Say: "The quote is checked in code against the fetched page. A verdict without a verified quote is discarded."

**2b. Ad-lib with a guaranteed fresh search (optional, ~1 credit).** Verify mode:
> In one short sentence: which team won the most recent NBA championship?

Expected: a pre-2026 champion → superseded by the New York Knicks (June 2026). Any other outcome is shown as it comes. Do not pre-announce the result.

**3. Claim-level verdicts on one answer (45 s).** Async:
> In two short sentences: how much does a ChatGPT Plus subscription cost per month in USD, and how much does a YouTube Premium individual plan cost per month in the US?

Show: claim 1 (ChatGPT Plus $20) **Current**; claim 2 (YouTube Premium $13.99) **Superseded**, rose to $15.99 in April 2026. Point at the separate measures: A half-life of the class, B P(outdated) labelled *estimated · uncalibrated*, C evidence level (ordinal, never a percentage). The plugin marked this answer `no-store` inline (price cue) in about 57 µs, before any verification.

**4. Cache invalidation (45 s).** Async:
> In two short sentences: what is the latest major version of Node.js, and what is the latest major version of the React library?

DeepSeek says Node.js 22 → **superseded** (Node.js 26 is current); React 19 → **current**. "Gateway & cache" shows the answer was cached with the default TTL and then `invalidate stale · done · HTTP 200`: Halflife deleted the stale entry from Bifrost's semantic cache through the cache admin API. Send the same prompt again: Bifrost cache **miss**, so no user receives the stale cached answer.

**5. Cache hit reuses the analysis (30 s).** Send twice:
> In one short sentence each: who is the CEO of Intel, and who is the CEO of Starbucks?

The second answer is a Bifrost **cache hit** in a few ms; the report is "linked" to the original analysis: **0 LLM calls, 0 Tavily credits**.

**6. Cost controls (30 s).** System page: engine credits today vs daily cap, lifetime vs cap, and the account guard (80% of the free 1,000-credit plan, the rest reserved; Tavily's own counter lags, so the guard also counts locally). Per-report spend is on every report. Say: "If any limit is reached, claims are marked 'not checked: budget'. They are never given a verdict and never retried."

**7. Close (15 s).** "On a FreshQA-based evaluation, detection recall was 98% at 85% precision, and verification precision was 96% on decided items. It is a freshness checker, not a general fact-checker."

## What to say if asked (limitations, do not hide)

- P(outdated) is an uncalibrated prior. The verdict comes from evidence, not from that number.
- Wrong time-invariant facts ("The Burj Khalifa is 900 m") are out of scope: never checked.
- Replacement values are shown only when a verified quote states them. They are less reliable than verdicts: 2 of 26 were wrong in the FreshQA run.
- Tavily `published_date` can be wrong for evergreen pages; the console shows it as "dated", with a tooltip.
- DeepSeek's knowledge cutoff is unpublished, so the as-of range for its answers is wide (6–36 months).

## If the live demo fails

1. Gateway or engine down: `docker compose -f deploy/docker-compose.yml up -d`; inference still works while the engine is down (fail-open is tested).
2. Network / Tavily / DeepSeek outage: switch to the **recorded run**. It is labelled as a recording, never presented as live:
   - Transcript of a real run: `deploy/demo/results/demo-2026-11-02T16-04-21-277Z.md` (every report ID, header, quote and URL). Kept private: local to the maintainer, not in the repository.
   - Console stills from that session: originals in `deploy/demo/backup/` (private); sanitised copies, with clock times and time zone blanked, in `docs/assets/screenshots/`.
   - A screen-recorded video is **not yet made** (no screen recorder was available to the agent). Record one with Xbox Game Bar (Win+Alt+R) while running steps 1–6.
3. Budget refusal on stage ("not checked: budget"): that is the cost guard working. Show it on the System page.

## Fact checks (independent of Tavily; web search on 2026-11-02)

| Claim in demo | Fact | Sources |
|---|---|---|
| UK PM | Starmer resigned (announced 2026-06-22); Andy Burnham PM from July 2026 | michiganpublic.org 2026-06-22 (NPR); kstp.com (AP) |
| NBA champion (2b) | Knicks beat Spurs 4-1, Game 5 on 2026-06-13 | nba.com 2026 Finals collection; kjzz.com |
| YouTube Premium | Individual $13.99 → $15.99, effective 2026-04-10 (existing subscribers from June) | 9to5google.com 2026-04-10; techcrunch.com 2026-04-10 |
| ChatGPT Plus | $20/month, unchanged through mid-2026 (secondary sources only) | tech.co; chatai.guide |
| Node.js | Node.js 26 released 2026-05-05 (Current); Node 22 is maintenance LTS | inmotionhosting.com; tech-insider.org |
| React | React 19 is the latest major (19.x) | react.dev/versions (cited by the engine) |
| Intel CEO | Lip-Bu Tan since 2025-03-18, still CEO Sept 2026 | Intel newsroom; unifygtm.com |
| Starbucks CEO | Brian Niccol, on the 2026-10-29 earnings call | finance.yahoo.com; vermoegenszentrum.ch |
