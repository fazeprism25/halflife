// Check: send a prompt through the Bifrost gateway (exactly like an application would, so the
// Halflife plugin handles it), or paste any answer for analysis. Stages stream live.
import { api, clear, h, icon } from "../lib.js";

const EXAMPLES = [
  "Who is the CEO of Twitter, and how many employees does it have?",
  "What is the latest stable version of Python and when was it released?",
  "Who is the current UK prime minister?",
  "What is the federal funds rate right now?",
];

export function renderCheck(root, { onEngineEvent }) {
  let status = null;
  let mode = "gateway";
  let watching = null;
  const stages = h("ol", { class: "stages" });
  const result = h("div");
  const formHost = h("div");

  root.append(
    h("header", { class: "page-head" }, h("div", {}, h("h1", {}, "Check"), h("p", {}, "Send a prompt through the gateway, or paste an answer to analyse."))),
    h("div", { class: "page-body" }, h("div", { class: "pad" },
      h("div", { class: "check-grid" },
        formHost,
        h("aside", { class: "panel" }, h("h2", {}, "Pipeline"), h("p", {}, "Live progress for the current check."), stages, result),
      ))),
  );
  resetStages();

  function resetStages(active = null, failed = false) {
    const list = [["capture", "Answer captured"], ["extract", "Claims extracted and classified"], ["assess", "Freshness estimated, risky claims selected"], ["verify", "Verified against live sources"], ["done", "Report ready"]];
    const order = list.map((x) => x[0]);
    const ai = active ? order.indexOf(active) : -1;
    clear(stages);
    list.forEach(([k, label], i) => {
      const s = failed && i === ai ? "failed" : i < ai || (active === "done" && i === ai) ? "done" : i === ai ? "active" : "idle";
      stages.append(h("li", { class: "stage", "data-s": s }, h("span", { class: "pip" }), h("span", {}, label), h("span", { class: "mono muted", style: { fontSize: "11px" } }, s === "done" ? "✓" : "")));
    });
  }

  function renderForm() {
    clear(formHost);
    const seg = h("div", { class: "segmented", role: "group", "aria-label": "Input" },
      h("button", { type: "button", "aria-pressed": String(mode === "gateway"), onclick: () => ((mode = "gateway"), renderForm()) }, "Prompt via gateway"),
      h("button", { type: "button", "aria-pressed": String(mode === "text"), onclick: () => ((mode = "text"), renderForm()) }, "Paste an answer"));
    formHost.append(h("div", { style: { marginBottom: "16px" } }, seg));
    formHost.append(mode === "gateway" ? gatewayForm() : textForm());
  }

  function gatewayForm() {
    const pg = status?.integrations?.playground;
    if (status && !pg?.configured) return h("div", { class: "notice" }, icon("alert"), "The playground needs HALFLIFE_DEMO_VK (created by deploy/setup.mjs). Paste an answer instead, or configure it.");
    if (status && !pg.models.length) return h("div", { class: "notice" }, icon("alert"), "No model is available: add an LLM provider key to deploy/.env and restart.");
    const prompt = h("textarea", { class: "input", name: "prompt", rows: 4, required: true, maxlength: 4000, placeholder: "Ask something whose answer changes over time…" });
    const model = h("select", { class: "input", name: "model" }, (pg?.models ?? []).map((m) => h("option", { value: m }, m)));
    let verify = false;
    const modeSeg = h("div", { class: "segmented", role: "group", "aria-label": "Mode" });
    const drawMode = () => {
      clear(modeSeg).append(
        h("button", { type: "button", "aria-pressed": String(!verify), onclick: () => ((verify = false), drawMode()) }, "Async"),
        h("button", { type: "button", "aria-pressed": String(verify), onclick: () => ((verify = true), drawMode()) }, "Verify before reply"));
    };
    drawMode();
    const err = h("p", { class: "error", role: "alert" });
    const btn = h("button", { class: "btn", type: "submit" }, "Send through gateway", icon("arrow"));
    const form = h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      resetStages("capture");
      clear(result);
      try {
        const r = await api("/v1/playground", { method: "POST", body: { prompt: prompt.value, model: model.value, mode: verify ? "verify" : "async" } });
        showGatewayResult(r);
        if (r.report_id) watch(r.report_id);
      } catch (ex) {
        err.textContent = ex.message;
        resetStages("capture", true);
      } finally {
        btn.disabled = false;
      }
    } },
      h("label", { class: "field" }, h("span", {}, "Prompt"), prompt),
      h("div", { class: "examples" }, EXAMPLES.map((x) => h("button", { class: "chip", type: "button", onclick: () => (prompt.value = x) }, x))),
      h("div", { class: "form-row" }, h("label", { class: "field", style: { minWidth: "240px" } }, h("span", {}, "Model"), model), h("div", { class: "field" }, h("span", {}, "Halflife mode"), modeSeg)),
      h("p", { class: "muted", style: { fontSize: "12.5px", margin: 0 } }, "The request goes to Bifrost with the demo application's virtual key. The Halflife plugin handles it like any other traffic. In verify mode the reply waits for the verdict and carries a freshness note if a claim is outdated."),
      h("div", {}, btn), err);
    return form;
  }

  function textForm() {
    const text = h("textarea", { class: "input", name: "text", rows: 9, required: true, maxlength: 20000, placeholder: "Paste an LLM answer…" });
    const question = h("input", { class: "input", name: "question", maxlength: 2000, placeholder: "Optional: the question it answered" });
    const model = h("input", { class: "input", name: "model", maxlength: 200, placeholder: "e.g. openai/gpt-4o-mini" });
    const asOf = h("input", { class: "input", name: "as_of", pattern: "\\d{4}(-\\d{2}(-\\d{2})?)?", placeholder: "YYYY or YYYY-MM" });
    const err = h("p", { class: "error", role: "alert" });
    const btn = h("button", { class: "btn", type: "submit" }, "Analyse", icon("arrow"));
    return h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      resetStages("capture");
      clear(result);
      try {
        const r = await api("/v1/check", { method: "POST", body: { text: text.value, question: question.value || undefined, model: model.value || undefined, as_of: asOf.value || undefined } });
        watch(r.id);
      } catch (ex) {
        err.textContent = ex.message;
        resetStages("capture", true);
      } finally {
        btn.disabled = false;
      }
    } },
      h("label", { class: "field" }, h("span", {}, "Answer"), text),
      h("label", { class: "field" }, h("span", {}, "Question"), question),
      h("div", { class: "form-row" },
        h("label", { class: "field", style: { flex: "1 1 220px" } }, h("span", {}, "Generating model (sets the knowledge cutoff)"), model),
        h("label", { class: "field", style: { flex: "0 1 160px" } }, h("span", {}, "As-of date"), asOf)),
      h("div", {}, btn), err);
  }

  function showGatewayResult(r) {
    clear(result).append(
      h("div", { class: "section-label" }, "Gateway reply"),
      h("p", { style: { whiteSpace: "pre-wrap", fontSize: "13px", margin: "0 0 8px" } }, r.answer),
      h("dl", { class: "kv", style: { gridTemplateColumns: "130px 1fr", fontSize: "12px" } },
        ...Object.entries(r.headers).flatMap(([k, v]) => [h("dt", { class: "mono" }, k.replace("x-halflife-", "")), h("dd", { class: "mono" }, v)]),
        h("dt", { class: "mono" }, "latency"), h("dd", { class: "mono" }, `${r.latency_ms} ms`),
        h("dt", { class: "mono" }, "cache"), h("dd", { class: "mono" }, r.cache ? (r.cache.cache_hit ? "hit" : "miss") : "—")),
    );
  }

  function watch(id) {
    watching = id;
    resetStages("extract");
    const link = h("p", { style: { marginTop: "12px" } }, h("a", { href: `#/inspector/${id}` }, "Open report ", h("span", { class: "mono" }, id), " →"));
    result.append(link);
    // Poll once in case the report already finished before the event stream caught it.
    setTimeout(() => api(`/v1/reports/${id}`).then((r) => watching === id && progress(r.status, r.stage)).catch(() => {}), 400);
  }

  function progress(st, stage) {
    if (st === "done" || st === "linked") resetStages("done");
    else if (st === "failed") resetStages("verify", true);
    else if (st === "running" && stage) resetStages(stage);
  }

  const off = onEngineEvent((e) => {
    if (e.type === "report" && e.id === watching) progress(e.status, e.stage);
  });

  api("/v1/status").then((s) => {
    status = s;
    renderForm();
  }).catch(() => renderForm());
  renderForm();
  return () => off();
}
