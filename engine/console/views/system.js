// System: integration health, plugin counters, spend against caps, policy. Real values only;
// anything not configured says so.
import { ago, api, clear, h, icon, pct } from "../lib.js";

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
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, h("strong", {}, `${spent} of ${cap} Tavily credits`), h("span", { class: "muted mono", style: { fontSize: "12px" } }, s.spend.today.day)),
        h("div", { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(cap), "aria-valuenow": String(spent) }, h("i", { style: { width: `${Math.min(100, cap ? (spent / cap) * 100 : 0)}%` } })),
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

  // The free-allowance guard (AD-19): every paid Tavily call must fit under all three limits.
  function guardPanel(sp) {
    const g = sp.guard;
    if (!g) return null;
    const acct = g.account;
    const line = (label, value, note) => h("div", { class: "guard-row" }, h("span", { class: "muted" }, label), h("span", { class: "mono" }, value), note ? h("span", { class: "muted", style: { fontSize: "12px" } }, note) : null);
    return h("div", {},
      h("div", { class: "section-label" }, "Tavily free-allowance guard"),
      h("div", { class: "panel" },
        line("Engine credits, lifetime", `${g.spent_total} of ${g.total_cap ?? "∞"}`, "from the engine's spend ledger"),
        line("Engine credits, today", `${g.spent_today} of ${g.daily_cap}`),
        g.account_check !== "on"
          ? line("Account ceiling", "check off", "HALFLIFE_TAVILY_ACCOUNT_GUARD is disabled; only the engine caps apply")
          : acct
            ? line("Account ceiling", `${g.estimated_account_used} of ${g.account_ceiling} used`, `${pct(g.ceiling_fraction)} of the ${acct.planLimit}-credit ${acct.plan ?? ""} plan; the rest is reserved. Counter read ${ago(g.account_checked_at)}, plus ${g.reserved_since_start} credits counted locally since (Tavily's counter lags).`)
            : line("Account ceiling", `${pct(g.ceiling_fraction)} of plan`, "Tavily's usage counter is read before the next paid call. If it cannot be read, the guard refuses the call."),
        acct && acct.paygoUsage ? h("p", { class: "error" }, `Pay-as-you-go usage reported (${acct.paygoUsage}): all paid calls are refused.`) : null,
        g.last_error ? h("p", { class: "error", style: { fontSize: "12px" } }, `Last guard refusal or read error: ${g.last_error}`) : null,
        h("p", { class: "muted", style: { fontSize: "12.5px", margin: "6px 0 0" } }, "A claim refused by any limit is reported as \"not checked: budget\". It is never retried and never given a verdict.")));
  }

  load();
  const t = setInterval(load, 5000);
  return () => clearInterval(t);
}
