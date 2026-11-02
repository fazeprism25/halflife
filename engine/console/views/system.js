// System: integration health, plugin counters, spend against caps, policy. Real values only;
// anything not configured says so.
import { ago, api, clear, h, icon, pct, stamp } from "../lib.js";

export function renderSystem(root) {
  const body = h("div", { class: "pad" });
  root.append(
    h("header", { class: "page-head" }, h("div", {}, h("h1", {}, "System"), h("p", {}, "Integrations, gateway plugin health, spend and policy.")), h("span", { class: "muted mono", id: "sys-updated", style: { fontSize: "12px" } })),
    h("div", { class: "page-body" }, body),
  );

  async function load() {
    try {
      const s = await api("/v1/status");
      render(s);
    } catch (e) {
      if (e.status !== 401) clear(body).append(h("p", { class: "error" }, `Could not load status: ${e.message}`));
    }
  }

  function row(title, sub, state, detail) {
    return h("div", { class: "status-row" }, h("div", {}, h("h3", {}, title), h("div", { class: "sub" }, sub)), h("div", {}, state), h("div", {}, detail));
  }
  const ok = (label = "Operational") => h("span", { class: "badge tone-good" }, icon("check"), label);
  const warn = (label) => h("span", { class: "badge tone-warning" }, icon("alert"), label);
  const bad = (label) => h("span", { class: "badge tone-critical" }, icon("cross"), label);
  const off = (label = "Not configured") => h("span", { class: "badge tone-neutral" }, icon("dot"), label);

  function render(s) {
    const i = s.integrations;
    document.getElementById("sys-updated").textContent = `updated ${new Date(s.now).toLocaleTimeString([], { hour12: false })}`;
    const p = i.plugin;
    const spent = Number(s.spend.today.credits ?? 0);
    const cap = s.spend.cap_credits;
    clear(body).append(
      h("div", { class: "section-label", style: { marginTop: 0 } }, "Integrations"),
      h("div", { class: "status-list" },
        row("Bifrost gateway", i.bifrost.url, i.bifrost.reachable === null ? off("Checking") : i.bifrost.reachable ? ok("Reachable") : bad("Unreachable"),
          h("span", { class: "secondary" }, i.bifrost.reachable ? `health checked ${ago(i.bifrost.checked_at)}` : i.bifrost.error ?? "")),
        row("Halflife plugin", "Go .so inside Bifrost, post_builtin", !p ? warn("No heartbeat") : p.stale ? warn("Heartbeat stale") : ok("Reporting"),
          p ? h("div", {},
            h("div", { class: "secondary" }, `v${p.plugin_version} · last heartbeat ${ago(p.at)} · queue ${p.queue_depth}/${p.queue_size} · tracking ${p.tracked} requests`),
            h("div", { class: "counters" }, Object.entries(p.counters ?? {}).map(([k, v]) => h("div", {}, h("span", { class: "muted" }, k.replace(/_/g, " ")), h("span", { class: "mono" }, String(v)))))) : h("span", { class: "secondary" }, "The plugin has not contacted the engine. Check that the gateway is running with the Halflife plugin and HALFLIFE_INGEST_TOKEN.")),
        row("Judge model", "Claim extraction and verdicts, called through Bifrost", !i.llm.configured ? off() : i.llm.last_error_at && (!i.llm.last_ok_at || i.llm.last_error_at > i.llm.last_ok_at) ? warn("Last call failed") : ok(i.llm.last_ok_at ? "Working" : "Configured"),
          h("div", { class: "secondary" }, i.llm.configured ? h("span", {}, h("span", { class: "mono" }, i.llm.model), i.llm.last_ok_at ? ` · last success ${ago(i.llm.last_ok_at)}` : " · not used yet") : "Without a model, claims are extracted by rules and no verdicts are made.",
            i.llm.last_error ? h("div", { class: "error", style: { fontSize: "12px" } }, `${ago(i.llm.last_error_at)}: ${i.llm.last_error}`) : null)),
        row("Tavily search", i.search.via, !i.search.configured ? off() : i.search.last_error_at && (!i.search.last_ok_at || i.search.last_error_at > i.search.last_ok_at) ? warn("Last call failed") : ok(i.search.last_ok_at ? "Working" : "Configured"),
          h("div", { class: "secondary" }, i.search.configured ? (i.search.last_ok_at ? `last success ${ago(i.search.last_ok_at)}` : "not used yet") : "Without TAVILY_API_KEY, at-risk claims are assessed but not verified.",
            i.search.last_error ? h("div", { class: "error", style: { fontSize: "12px" } }, `${ago(i.search.last_error_at)}: ${i.search.last_error}`) : null)),
        row("Cache control", "Bifrost semantic cache admin API", i.cache_admin.configured ? ok("Configured") : off(), h("span", { class: "secondary" }, "Stale cached answers are invalidated; answers expire at their claims' reuse window.")),
        row("Playground", "Prompts sent as a demo application", i.playground.configured && i.playground.models.length ? ok("Ready") : off(), h("span", { class: "secondary mono" }, i.playground.models.join(", ") || "—")),
      ),
      h("div", { class: "section-label" }, "Spend today"),
      h("div", { class: "panel" },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, h("strong", {}, `${spent} of ${cap} Tavily credits (Halflife daily limit)`), h("span", { class: "muted mono", style: { fontSize: "12px" } }, s.spend.today.day)),
        h("div", { class: "meter", role: "meter", "aria-label": "Credits used against the daily limit", "aria-valuemin": "0", "aria-valuemax": String(cap), "aria-valuenow": String(spent) }, h("i", { style: { width: `${Math.min(100, cap ? (spent / cap) * 100 : 0)}%` } })),
        h("p", { class: "muted", style: { fontSize: "12.5px", margin: "6px 0 0" } }, `${s.spend.today.searches} searches · ${s.spend.today.extracts} extracts · ${s.spend.today.llm_calls} LLM calls · ${Number(s.spend.today.tokens).toLocaleString()} tokens. The engine stops verifying at its daily cap; Bifrost separately enforces the engine virtual key's dollar budget on the Tavily relay (HTTP 402).`)),
      guardPanel(s.spend),
      h("div", { class: "section-label" }, "Policy"),
      h("dl", { class: "kv" },
        h("dt", {}, "Verify threshold"), h("dd", {}, `claims with P(outdated) ≥ ${pct(s.policy.theta)}`),
        h("dt", {}, "Per response"), h("dd", {}, `at most ${s.policy.max_verify_per_response} claims verified, riskiest first`),
        h("dt", {}, "Daily credit cap"), h("dd", {}, String(s.policy.daily_credit_cap)),
        h("dt", {}, "Concurrency"), h("dd", {}, `${s.policy.concurrency} jobs · queue ${s.queue.depth}/${s.queue.max} · active ${s.queue.active}`),
        h("dt", {}, "Cache TTL default"), h("dd", {}, `${s.policy.cache_ttl_seconds}s (the plugin only lowers it)`)),
      h("div", { class: "section-label" }, "Totals"),
      h("dl", { class: "kv" },
        h("dt", {}, "Reports"), h("dd", { class: "mono" }, String(s.counts.reports)),
        h("dt", {}, "Claims"), h("dd", { class: "mono" }, `${s.counts.claims} (${s.counts.checked} checked live)`),
        h("dt", {}, "Learning outcomes"), h("dd", { class: "mono" }, String(s.counts.observations)),
        h("dt", {}, "Cache actions"), h("dd", { class: "mono" }, `${s.counts.cache_actions_done} done · ${s.counts.cache_actions_pending} scheduled`)),
    );
  }

  // A (provider account usage) and B/C (Halflife's own limits) are shown apart, never mixed (AD-34).
  function guardPanel(sp) {
    const g = sp.guard;
    if (!g) return null;
    return h("div", {},
      h("div", { class: "section-label" }, "Tavily account usage"),
      usagePanel(g.provider, g.account_check === "on" ? refresh : null, refreshNote),
      h("div", { class: "section-label" }, "Halflife spending limits"),
      limitsPanel(g));
  }

  let refreshing = false;
  let refreshNote = "";
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const r = await api("/v1/usage/refresh", { method: "POST" });
      refreshNote = r.attempted ? "" : `Not refreshed: ${r.reason}.`;
    } catch (e) {
      refreshNote = `Refresh failed: ${e.message}`;
    } finally {
      refreshing = false;
      await load();
    }
  }

  load();
  const t = setInterval(load, 5000);
  return () => clearInterval(t);
}

const n = (v) => Number(v).toLocaleString();
const STATE = {
  ok: ["tone-good", "check", "Current"],
  stale: ["tone-warning", "alert", "Stale"],
  unavailable: ["tone-critical", "cross", "Unavailable"],
  pending: ["tone-neutral", "dot", "Not read yet"],
  off: ["tone-neutral", "dot", "Check off"],
};
const ALLOWANCE_WHY = {
  missing: "Tavily's usage response did not include an account allowance (plan_limit)",
  unlimited: "Tavily reports no finite account allowance",
  invalid: "Tavily returned an account allowance Halflife cannot read",
};
const guardLine = (label, value, note) => h("div", { class: "guard-row" }, h("span", { class: "muted" }, label), h("span", { class: "mono" }, value), note ? h("span", { class: "muted", style: { fontSize: "12px" } }, note) : null);

/**
 * A. Provider account usage, exactly as Tavily's GET /usage reports it (AD-34). It never shows a
 * maximum or a remaining balance the provider did not report. Exported for the UI test.
 */
export function usagePanel(u, onRefresh, note = "") {
  const [tone, ic, label] = STATE[u?.state] ?? STATE.pending;
  const head = h("div", { class: "usage-head" },
    h("span", { class: `badge ${tone}`, "data-usage-state": u?.state ?? "pending" }, icon(ic), label),
    onRefresh ? h("button", { class: "btn-ghost btn-small", type: "button", onclick: (e) => { e.currentTarget.disabled = true; onRefresh(); } }, "Refresh") : null);
  if (!u || u.state === "off") {
    return h("div", { class: "panel usage-panel" }, head, h("p", { class: "muted usage-text" }, "Account usage is not read: HALFLIFE_TAVILY_ACCOUNT_GUARD is disabled or live search is not configured. Only Halflife's own limits apply."));
  }
  const has = u.used != null;
  const finite = has && u.allowance != null;
  const figure = finite ? `${n(u.used)} of ${n(u.allowance)} credits used` : has ? `${n(u.used)} credits used` : u.state === "unavailable" ? "Usage could not be read" : "Usage not read yet";
  return h("div", { class: "panel usage-panel" }, head,
    h("div", { class: "usage-main" }, h("strong", { class: "usage-figure" }, figure), u.plan ? h("span", { class: "muted" }, `${u.plan} plan`) : null),
    finite ? h("div", { class: "meter", role: "meter", "aria-label": "Tavily account credits used", "aria-valuemin": "0", "aria-valuemax": String(u.allowance), "aria-valuenow": String(u.used) }, h("i", { style: { width: `${Math.min(100, (u.used / u.allowance) * 100)}%` } })) : null,
    finite ? h("p", { class: "usage-text", "data-remaining": String(u.remaining) }, h("span", { class: "mono" }, n(u.remaining)), " remaining by Tavily's counter",
      u.remaining_conservative != null && u.remaining_conservative < u.remaining ? h("span", { class: "muted" }, ` · at most ${n(u.remaining_conservative)}, counting credits Halflife spent that the counter does not show yet`) : null) : null,
    has && !finite ? h("p", { class: "usage-text", "data-allowance": "unavailable" }, `Account allowance unavailable: ${ALLOWANCE_WHY[u.allowance_state] ?? "it was not reported"}. No maximum or remaining balance is shown, and Halflife refuses paid searches until a finite allowance is reported.`) : null,
    guardLine("Last successful refresh", u.fetched_at ? ago(u.fetched_at) : "never", u.fetched_at ? `${stamp(u.fetched_at)}. Cached ${Math.round(u.cache_ms / 60000)} min; marked stale after ${Math.round(u.stale_after_ms / 60000)} min or a failed read.` : null),
    u.state === "stale" ? h("p", { class: "usage-text warn-text" }, "These figures are from the last successful read and may be out of date.") : null,
    u.last_error ? h("p", { class: "error", style: { fontSize: "12px" } }, `Last read failed${u.last_error_at ? ` ${ago(u.last_error_at)}` : ""}: ${u.last_error}`, u.retry_after_until ? `. Tavily asked to wait until ${stamp(u.retry_after_until)}.` : "") : null,
    u.key ? guardLine("This API key", u.key.limit != null ? `${n(u.key.used)} of ${n(u.key.limit)}` : `${n(u.key.used)} used`, `Key-level counter, separate from the account. Key limit: ${u.key.limit != null ? n(u.key.limit) : u.key.limit_state === "unlimited" ? "none set" : "not reported"}.`) : null,
    u.paygo ? guardLine("Pay-as-you-go", `${n(u.paygo.used)} used`, u.paygo.used > 0 ? "Pay-as-you-go usage is reported, so Halflife refuses every paid search." : "Halflife never enables it, and refuses paid searches if any is reported.") : null,
    note ? h("p", { class: "muted", style: { fontSize: "12px" } }, note) : null,
    h("p", { class: "muted usage-text" }, "Shown exactly as Tavily's /usage API returns it (account.plan_usage and account.plan_limit). Credits the Tavily dashboard shows that this response does not include, such as add-on credits, are not counted. The counter can lag actual requests by hours."),
  );
}

/** B, C and the account guard. Operator configuration; the provider allowance never changes B or C. */
export function limitsPanel(g) {
  const acct = g.account;
  const finiteCap = g.total_cap != null && Number.isFinite(g.total_cap);
  return h("div", { class: "panel limits-panel" },
    guardLine("Lifetime ceiling", `${n(g.spent_total)} of ${finiteCap ? n(g.total_cap) : "∞"}`, "HALFLIFE_TOTAL_CREDIT_CAP, over the engine's spend ledger. Set by the operator; not derived from the provider allowance."),
    guardLine("Daily limit", `${n(g.spent_today)} of ${n(g.daily_cap)}`, "HALFLIFE_DAILY_CREDIT_CAP (UTC day). Set by the operator; not derived from the provider allowance."),
    g.account_check !== "on"
      ? guardLine("Account guard", "off", "HALFLIFE_TAVILY_ACCOUNT_GUARD is disabled; only the two limits above apply.")
      : g.account_ceiling != null
        ? guardLine("Account guard", `${n(g.estimated_account_used)} of ${n(g.account_ceiling)}`, `${pct(g.ceiling_fraction)} of the ${n(acct.planLimit)} credits Tavily reports; the rest is a reserve. Uses Tavily's counter or Halflife's own count, whichever is higher (${g.reserved_since_start} credits counted locally since start).`)
        : guardLine("Account guard", "refusing", `${pct(g.ceiling_fraction)} of the provider allowance, which is ${acct ? "not reported as a finite number" : "not read yet"}. Paid searches are refused until it is.`),
    acct && acct.paygoUsage ? h("p", { class: "error" }, `Pay-as-you-go usage reported (${acct.paygoUsage}): all paid calls are refused.`) : null,
    g.last_error ? h("p", { class: "error", style: { fontSize: "12px" } }, `Last guard refusal or read error: ${g.last_error}`) : null,
    h("p", { class: "muted", style: { fontSize: "12.5px", margin: "6px 0 0" } }, "Every paid Tavily call must fit under all three. A claim refused by any of them is reported as \"not checked: budget\"; it is never retried and never given a verdict. Halflife never raises these limits or enables pay-as-you-go on its own."));
}
