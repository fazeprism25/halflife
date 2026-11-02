// Extension settings: connection status and pairing, installation, explicit opt-in controls,
// privacy (exactly what leaves the browser), and retention and deletion of extension data.
import { ago, api, clear, h, icon, stamp } from "../lib.js";
import { confirmButton, pageHead } from "./ext-common.js";

export function renderExtension(root) {
  const body = h("div", { class: "pad" });
  let disposed = false;
  let codeTimer = 0;
  root.append(pageHead("Extension", "Connect the Halflife browser extension for ChatGPT and control what it may do."), h("div", { class: "page-body" }, body));

  async function load() {
    try {
      const [cfg, status] = await Promise.all([api("/v1/extension/settings"), api("/v1/status")]);
      if (!disposed) render(cfg, status);
    } catch (e) {
      if (e.status !== 401) clear(body).append(h("p", { class: "error" }, `Could not load extension settings: ${e.message}`));
    }
  }

  function render({ settings: s, connections }, status) {
    const active = connections.filter((c) => !c.revoked_at);
    const verifyReady = status.integrations.llm.configured && status.integrations.search.configured;
    clear(body).append(
      // ------------------------------------------------ connection
      h("div", { class: "section-label first" }, "Connection"),
      h("div", { class: "panel" },
        h("div", { class: "ext-conn-head" },
          active.length ? h("span", { class: "badge tone-good" }, icon("check"), `${active.length} browser${active.length === 1 ? "" : "s"} connected`) : h("span", { class: "badge tone-neutral" }, icon("dot"), "No browser connected"),
          !s.accept_checks ? h("span", { class: "badge tone-warning" }, icon("alert"), "New checks paused") : null),
        active.length ? h("table", { class: "data-table conn-table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Connection"), h("th", {}, "Paired"), h("th", {}, "Last used"), h("th", { class: "num" }, "Checks"), h("th", {}))),
          h("tbody", {}, active.map((c) => h("tr", {},
            h("td", {}, h("div", { class: "mono" }, c.id), h("div", { class: "muted mono small", title: c.origin }, c.label || c.origin.replace("chrome-extension://", "extension ").slice(0, 26) + "…")),
            h("td", { title: stamp(c.created_at) }, ago(c.created_at)),
            h("td", {}, c.last_used_at ? ago(c.last_used_at) : "never"),
            h("td", { class: "num" }, String(c.checks)),
            h("td", { class: "cell-end" }, confirmButton("Disconnect", "Click again", async () => {
              await api(`/v1/extension/connections/${c.id}`, { method: "DELETE" });
              load();
            })))))) : null,
        pairingBlock()),

      // ------------------------------------------------ install
      h("div", { class: "section-label" }, "Install the extension"),
      h("div", { class: "panel" },
        h("ol", { class: "steps" },
          h("li", {}, "Open ", h("code", {}, "chrome://extensions"), " (or ", h("code", {}, "edge://extensions"), ") and turn on ", h("b", {}, "Developer mode"), "."),
          h("li", {}, "Choose ", h("b", {}, "Load unpacked"), " and select the ", h("code", {}, "extension/"), " folder of the Halflife repository."),
          h("li", {}, "Pin Halflife, open its popup, and enter the address of this console (", h("code", {}, location.origin), ") with a pairing code from above."),
          h("li", {}, "In ChatGPT, click ", h("b", {}, "Check freshness"), " under an answer. The result appears under it and here in ", h("a", { href: "#/activity" }, "ChatGPT activity"), ".")),
        h("p", { class: "muted small" }, "The extension is not published to any store. It supports chatgpt.com and chat.openai.com, and only talks to a Halflife engine on 127.0.0.1 or localhost.")),

      // ------------------------------------------------ opt-in controls
      h("div", { class: "section-label" }, "Checks"),
      h("form", { class: "panel settings-form", onsubmit: (e) => e.preventDefault() },
        toggle("accept_checks", s.accept_checks, "Accept checks from the extension", "Off: every new check is refused, whatever the extension says. Existing results stay readable."),
        toggle("live_verification", s.live_verification, "Verify against live sources", verifyReady
          ? "On: at-risk claims are searched through Bifrost's Tavily relay, within the same credit guard as all traffic (AD-19). Off: claims are extracted and estimated only, with 0 search credits."
          : "Search or the judge model is not configured on this engine, so checks are estimated only regardless of this setting."),
        number("daily_limit", s.daily_limit, "Checks per day", 0, 1000, "Across all connected browsers (UTC day)."),
        number("per_minute_limit", s.per_minute_limit, "Checks per minute", 1, 60, "Per browser."),
        h("p", { class: "muted small" }, "Learning is always off for extension checks: you choose which answers to check, and that selection would bias the class change rates.")),

      // ------------------------------------------------ privacy
      h("div", { class: "section-label" }, "Privacy: what leaves the browser"),
      h("div", { class: "panel privacy" },
        h("ul", {},
          h("li", {}, h("b", {}, "Nothing, until you click Check freshness."), " There is no background capture, no automatic checking and no telemetry."),
          h("li", {}, "On click, the extension sends ", h("b", {}, "that one answer"), ", the user message directly before it, ChatGPT's message id, the model name if shown, and a SHA-256 hash of the conversation id. Nothing else from the page."),
          h("li", {}, "It sends them only to this engine, on a loopback address, with a token issued by pairing. The token is kept where ChatGPT's page cannot read it."),
          h("li", {}, "Halflife then sends extracted claims to the judge model through Bifrost, and search queries to Tavily through the Bifrost relay, as it does for gateway traffic. Provider keys never reach the browser."),
          h("li", {}, "The extension can be paused from its popup. Pausing hides every button and sends nothing."))),

      // ------------------------------------------------ data
      h("div", { class: "section-label" }, "Data retention and deletion"),
      h("div", { class: "panel" },
        number("retention_days", s.retention_days, "Keep extension checks for (days)", 1, 365, `Older checks are deleted automatically. The engine-wide retention also applies.`),
        h("div", { class: "row-actions" },
          confirmButton("Delete all extension checks", "Click again to delete everything", async () => {
            const r = await api("/v1/extension/reports?confirm=all", { method: "DELETE" });
            flash(`${r.deleted} check${r.deleted === 1 ? "" : "s"} deleted.`);
            load();
          }, "btn-ghost danger")),
        h("p", { class: "muted small" }, "Deletes every answer, claim and source stored from the extension. Gateway traffic is not affected. Individual checks can be deleted from ChatGPT activity.")),
    );
  }

  function pairingBlock() {
    const out = h("div", { class: "pair-out", "aria-live": "polite" });
    const btn = h("button", { class: "btn", type: "button", onclick: async () => {
      btn.disabled = true;
      try {
        const r = await api("/v1/extension/pairing-codes", { method: "POST", body: {} });
        showCode(out, r);
      } catch (e) {
        clear(out).append(h("p", { class: "error" }, e.message));
      } finally {
        btn.disabled = false;
      }
    } }, "Create pairing code");
    return h("div", { class: "pair" }, h("div", {}, btn, h("p", { class: "muted small" }, "A code works once, for one browser, and expires after 10 minutes.")), out);
  }

  function showCode(out, r) {
    clearInterval(codeTimer);
    const code = `${r.code.slice(0, 4)}-${r.code.slice(4)}`;
    const left = h("span", { class: "muted mono small" });
    const tick = () => {
      const s = Math.max(0, Math.round((r.expires_at - Date.now()) / 1000));
      left.textContent = s ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "expired";
      if (!s) clearInterval(codeTimer);
    };
    tick();
    codeTimer = setInterval(tick, 1000);
    clear(out).append(h("div", { class: "pair-code mono", "aria-label": `Pairing code ${r.code.split("").join(" ")}` }, code), left);
  }

  function toggle(key, value, label, help) {
    const input = h("input", { type: "checkbox", checked: value, onchange: () => save({ [key]: input.checked }, input) });
    return h("label", { class: "setting" }, h("span", {}, h("b", {}, label), h("span", { class: "muted small" }, help)), input);
  }

  function number(key, value, label, min, max, help) {
    const input = h("input", { class: "input num-input", type: "number", min, max, step: 1, value, onchange: () => {
      const v = Number(input.value);
      if (!Number.isInteger(v) || v < min || v > max) {
        flash(`${label}: enter a whole number from ${min} to ${max}.`, true);
        input.value = value;
        return;
      }
      save({ [key]: v }, input);
    } });
    return h("label", { class: "setting" }, h("span", {}, h("b", {}, label), h("span", { class: "muted small" }, help)), input);
  }

  async function save(patch, input) {
    input.disabled = true;
    try {
      await api("/v1/extension/settings", { method: "PUT", body: patch });
      flash("Saved.");
    } catch (e) {
      flash(e.message, true);
      load();
    } finally {
      input.disabled = false;
    }
  }

  function flash(text, error = false) {
    let el = document.getElementById("ext-flash");
    if (!el) {
      el = h("div", { id: "ext-flash", class: "flash", role: "status" });
      document.body.append(el);
    }
    el.textContent = text;
    el.dataset.error = String(error);
    el.dataset.show = "true";
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.dataset.show = "false"), 2400);
  }

  load();
  return () => {
    disposed = true;
    clearInterval(codeTimer);
  };
}
