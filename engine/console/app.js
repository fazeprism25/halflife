// Halflife console entry: routing, sidebar, live connection, theme, auth.
import { api, clear, h, setConsoleToken, subscribe } from "./lib.js";
import { createTraffic } from "./traffic.js";
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

// ---------------------------------------------------------------- sidebar (AD-35)
// Collapsed by default. Two modes, chosen by width:
//   docked  (≥ DOCK_PX): a column beside the page; opening it narrows the page. Non-modal, so no
//           outside-click or Escape dismissal; the open/closed choice is remembered.
//   overlay (< DOCK_PX): a modal panel over the page. The page is inert while it is open; it
//           closes with ✕, Escape, a click outside, or by choosing a report. Always starts closed.
const DOCK_PX = 1100;
const PREF_KEY = "halflife.sidebar";
const shell = document.getElementById("shell");
const sidebar = document.getElementById("sidebar");
const menuBtn = document.getElementById("menu-btn");
const menuLabel = document.getElementById("menu-label");
const menuNew = document.getElementById("menu-new");
const scrim = document.getElementById("sidebar-scrim");
const topbar = document.querySelector(".topbar");
const dockQuery = matchMedia(`(min-width: ${DOCK_PX}px)`);
let sidebarOpen = false;
const mode = () => (dockQuery.matches ? "docked" : "overlay");
const readPref = () => {
  try {
    return localStorage.getItem(PREF_KEY) === "open";
  } catch {
    return false;
  }
};
const writePref = (open) => {
  try {
    localStorage.setItem(PREF_KEY, open ? "open" : "closed");
  } catch {}
};

function applySidebar() {
  const m = mode();
  shell.dataset.mode = m;
  shell.dataset.sidebar = sidebarOpen ? "open" : "closed";
  sidebar.dataset.open = String(sidebarOpen);
  scrim.dataset.open = String(sidebarOpen && m === "overlay");
  menuBtn.setAttribute("aria-expanded", String(sidebarOpen));
  menuLabel.textContent = sidebarOpen ? "Hide navigation" : "Show navigation";
  menuBtn.title = menuLabel.textContent;
  const modal = sidebarOpen && m === "overlay";
  if (modal) {
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
  } else {
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
  }
  for (const el of [main, topbar]) el.toggleAttribute("inert", modal);
  document.documentElement.classList.toggle("sidebar-modal", modal);
  traffic?.visibilityChanged();
}

function openSidebar({ focus = "nav" } = {}) {
  const was = sidebarOpen;
  sidebarOpen = true;
  if (mode() === "docked") writePref(true);
  applySidebar();
  if (focus === "traffic") {
    traffic.setExpanded(true);
    if (!traffic.focusSelected()) document.getElementById("traffic-toggle").focus();
  } else if (focus === "nav" && (!was || mode() === "overlay")) {
    (sidebar.querySelector('#nav a[aria-current="page"]') ?? sidebar.querySelector("#nav a")).focus();
  }
}

function closeSidebar({ restoreFocus = true } = {}) {
  if (!sidebarOpen) return;
  const hadFocus = sidebar.contains(document.activeElement);
  sidebarOpen = false;
  if (mode() === "docked") writePref(false);
  applySidebar();
  if (restoreFocus && (hadFocus || mode() === "overlay")) menuBtn.focus();
}

menuBtn.addEventListener("click", () => (sidebarOpen ? closeSidebar() : openSidebar()));
document.getElementById("sidebar-close").addEventListener("click", () => closeSidebar());
scrim.addEventListener("click", () => closeSidebar());
// Crossing the breakpoint: an overlay never carries over as a docked column or the reverse;
// docked width restores the remembered choice, overlay width starts closed.
dockQuery.addEventListener("change", () => {
  sidebarOpen = mode() === "docked" ? readPref() : false;
  applySidebar();
});
// In overlay mode, following a navigation link closes the panel.
document.getElementById("nav").addEventListener("click", (e) => {
  if (e.target.closest("a") && mode() === "overlay") closeSidebar({ restoreFocus: false });
});

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape" && sidebarOpen && mode() === "overlay") {
    e.preventDefault();
    closeSidebar();
  } else if ((e.key === "t" || e.key === "T") && !e.target.closest?.("input, textarea, select, [contenteditable]")) {
    e.preventDefault();
    openSidebar({ focus: "traffic" });
  }
});

// ---------------------------------------------------------------- Traffic (in the sidebar)
let currentView = null;
let inspectorSelect = null;
const traffic = createTraffic({
  onEngineEvent,
  isVisible: () => sidebarOpen,
  onPick: (id) => {
    if (currentView === "inspector" && inspectorSelect) inspectorSelect(id);
    else location.hash = `#/inspector/${id}`;
    if (mode() === "overlay") closeSidebar();
  },
});
document.addEventListener("halflife:traffic-new", (e) => {
  const fresh = e.detail && !sidebarOpen;
  menuBtn.dataset.new = String(Boolean(fresh));
  menuNew.textContent = fresh ? ", new reports in Traffic" : "";
});
const inspectorHooks = {
  traffic,
  register: (fn) => {
    inspectorSelect = fn;
    return () => {
      if (inspectorSelect === fn) inspectorSelect = null;
    };
  },
};

// ---------------------------------------------------------------- routing
let cleanup = null;
const routes = {
  inspector: renderInspector, check: renderCheck, model: renderModel, system: renderSystem,
  activity: renderActivity, claims: renderClaims, trends: renderTrends, extension: renderExtension,
};

function route() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, "") || "inspector").split("/");
  const view = routes[name] ? name : "inspector";
  for (const a of document.querySelectorAll("#nav a")) {
    if (a.dataset.route === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  cleanup?.();
  clear(main);
  currentView = view;
  if (view !== "inspector") traffic.setSelected(null);
  cleanup = routes[view](main, { params: rest, onEngineEvent, ...(view === "inspector" ? { inspector: inspectorHooks } : {}) }) ?? null;
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

// Start: docked width restores the remembered choice; otherwise collapsed.
sidebarOpen = mode() === "docked" && readPref();
applySidebar();
// Probe auth once so a token prompt appears immediately if needed.
api("/v1/status").catch(() => {});
route();
