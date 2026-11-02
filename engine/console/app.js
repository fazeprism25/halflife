// Halflife console entry: routing, live connection, theme, auth.
import { api, clear, h, setConsoleToken, subscribe } from "./lib.js";
import { renderActivity } from "./views/activity.js";
import { renderCheck } from "./views/check.js";
import { renderClaims } from "./views/claims.js";
import { renderExtension } from "./views/extension.js";
import { renderInspector } from "./views/inspector.js";
import { renderModel } from "./views/model.js";
import { renderSystem } from "./views/system.js";
import { renderTrends } from "./views/trends.js";

const main = document.getElementById("main");
const listeners = new Set();
export const onEngineEvent = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

let cleanup = null;
const routes = {
  inspector: renderInspector, check: renderCheck, model: renderModel, system: renderSystem,
  activity: renderActivity, claims: renderClaims, trends: renderTrends, extension: renderExtension,
};

function route() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, "") || "inspector").split("/");
  const view = routes[name] ? name : "inspector";
  for (const a of document.querySelectorAll("#nav a")) a.toggleAttribute("aria-current", a.dataset.route === view) && a.setAttribute("aria-current", "page");
  cleanup?.();
  clear(main);
  cleanup = routes[view](main, { params: rest, onEngineEvent }) ?? null;
}

window.addEventListener("hashchange", route);
window.addEventListener("halflife:unauthorized", () => {
  cleanup?.();
  cleanup = null;
  clear(main).append(
    h("form", { class: "auth panel", onsubmit: (e) => {
      e.preventDefault();
      setConsoleToken(new FormData(e.target).get("token"));
      location.reload();
    } },
      h("h2", {}, "Console token required"),
      h("p", {}, "This engine was started with HALFLIFE_CONSOLE_TOKEN. Enter it to continue; it is kept in this browser only."),
      h("label", { class: "field" }, h("span", {}, "Token"), h("input", { class: "input", name: "token", type: "password", required: true, autocomplete: "off" })),
      h("div", { style: { marginTop: "14px" } }, h("button", { class: "btn", type: "submit" }, "Continue")),
    ),
  );
});

// Live connection indicator + fan-out of engine events to views.
const live = document.getElementById("live");
const liveLabel = document.getElementById("live-label");
subscribe(
  (e) => {
    for (const l of listeners) l(e);
    if (e.type === "report" && (e.status === "queued" || e.status === "linked")) bumpCount();
  },
  (state) => {
    live.dataset.state = state;
    liveLabel.textContent = state === "live" ? "Live" : "Reconnecting";
  },
);

let unseen = 0;
function bumpCount() {
  if (location.hash.startsWith("#/inspector") || location.hash === "") return;
  unseen++;
  document.getElementById("nav-count").textContent = String(unseen);
}
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#/inspector")) {
    unseen = 0;
    document.getElementById("nav-count").textContent = "";
  }
});

// Theme: system → light → dark, remembered per browser.
const themeBtn = document.getElementById("theme");
const THEMES = ["system", "light", "dark"];
function applyTheme(t) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
  themeBtn.textContent = `Theme: ${t}`;
}
let theme = "system";
try {
  theme = localStorage.getItem("halflife.theme") || "system";
} catch {}
applyTheme(theme);
themeBtn.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try {
    localStorage.setItem("halflife.theme", theme);
  } catch {}
  applyTheme(theme);
});

// Probe auth once so a token prompt appears immediately if needed.
api("/v1/status").catch(() => {});
route();
