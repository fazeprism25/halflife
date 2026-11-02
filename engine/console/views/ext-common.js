// Shared pieces for the ChatGPT-extension pages (activity, claims, trends, extension).
// Every value comes from the engine's extension API; nothing is computed that the engine did
// not decide, except the freshness score, whose definition is shown wherever it appears.
import { h, icon } from "../lib.js";

/** Overall assessment → label, tone and icon (same tone tokens as claim verdicts). */
export const ASSESSMENT = {
  outdated: { label: "Outdated", tone: "critical", icon: "replace" },
  possibly_outdated: { label: "Possibly outdated", tone: "warning", icon: "alert" },
  unverified: { label: "Not fully verified", tone: "warning", icon: "alert" },
  current: { label: "Current", tone: "good", icon: "check" },
  low_risk: { label: "Low risk", tone: "neutral", icon: "dot" },
  no_time_sensitive: { label: "Not time-sensitive", tone: "neutral", icon: "dot" },
  no_claims: { label: "No claims", tone: "neutral", icon: "dot" },
};

export function assessmentBadge(a, status) {
  if (status === "failed") return h("span", { class: "badge tone-critical" }, icon("cross"), "Failed");
  if (status && status !== "done") return h("span", { class: "badge tone-neutral" }, h("span", { class: "spinner", "aria-hidden": "true" }), "In progress");
  const s = ASSESSMENT[a] ?? { label: "Unknown", tone: "neutral", icon: "question" };
  return h("span", { class: `badge tone-${s.tone}` }, icon(s.icon), s.label);
}

/** Freshness score: time-sensitive claims confirmed current with at least moderate evidence,
 *  out of all time-sensitive claims. Outdated, weakly supported and unchecked claims count
 *  against it. Reported as a fraction, never as a calibrated probability. */
export function freshnessScore(s) {
  if (!s || typeof s.claims !== "number" || !s.time_sensitive) return null;
  const confirmed = Math.max(0, (s.verdicts?.current ?? 0) - (s.weak_current ?? 0));
  return { confirmed, of: s.time_sensitive };
}
export const SCORE_HELP = "Freshness score: time-sensitive claims confirmed current with at least moderate evidence, out of all time-sensitive claims in the answer. Outdated, weakly supported and unchecked claims count against it.";

export function scoreText(s) {
  const f = freshnessScore(s);
  return f ? `${f.confirmed}/${f.of}` : "—";
}

export function figure(value, label, title) {
  return h("div", { class: "figure", title }, h("b", {}, String(value)), h("span", {}, label));
}

/** A two-step destructive button: the first click arms it for 5 s (no browser dialogs). */
export function confirmButton(label, armedLabel, onConfirm, cls = "btn-ghost btn-small danger") {
  let armed = 0;
  const b = h("button", { class: cls, type: "button" }, label);
  b.addEventListener("click", async () => {
    if (!armed) {
      b.textContent = armedLabel;
      b.dataset.armed = "true";
      armed = setTimeout(() => {
        armed = 0;
        b.textContent = label;
        delete b.dataset.armed;
      }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.disabled = true;
    try {
      await onConfirm();
    } finally {
      b.disabled = false;
      b.textContent = label;
      delete b.dataset.armed;
    }
  });
  return b;
}

export function pageHead(title, sub, ...right) {
  return h("header", { class: "page-head" }, h("div", {}, h("h1", {}, title), h("p", {}, sub)), right.length ? h("div", { class: "head-actions" }, right) : null);
}

export const short = (s, n) => (!s ? "" : s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
