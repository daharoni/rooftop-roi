/* =============================================================================
 * existing.js — the two questions a household with solar already on the roof
 * has to answer before the battery-only model can run.
 *
 * The meter file says the house exports, but not how big the array is or which
 * net-metering agreement it is on, and both change the answer: the array size
 * rebuilds the household's own usage (import − export + what the panels made),
 * and the agreement sets what an exported kWh is worth.  The form only gathers
 * and validates; main.js owns what happens next.  Validation is inline, never
 * an alert.
 * ========================================================================== */

import { el, clear } from "./dom.js";

export const KW_MIN = 0.5;
export const KW_MAX = 50;

/** "6,4" and " 6.4 kW" both mean 6.4; blank is not zero. */
export function parseKw(text) {
  const t = String(text == null ? "" : text).trim().replace(/,/g, ".").replace(/\s*kw\s*$/i, "");
  if (t === "") return NaN;
  return Number(t);
}

/** null when the value is usable, else the sentence to show. */
export function kwProblem(v) {
  if (!Number.isFinite(v)) return "Enter the size of your existing array in kW, like 6.4.";
  if (v < KW_MIN || v > KW_MAX) return `Enter a size between ${KW_MIN} and ${KW_MAX} kW.`;
  return null;
}

export const SINCE_MIN = 1995;
export const TERM_YEARS = 20;

/** "2016" is a year; blank, "2016.5" and "last year" are not. NaN for anything else. */
export function parseYear(text) {
  const t = String(text == null ? "" : text).trim();
  return /^\d{4}$/.test(t) ? Number(t) : NaN;
}

/** null when usable, else the sentence to show. `now` is the current calendar year. */
export function sinceProblem(v, now = new Date().getFullYear()) {
  if (!Number.isInteger(v) || v < SINCE_MIN || v > now) return `Enter a year from ${SINCE_MIN} to ${now}, like 2019.`;
  return null;
}

/**
 * renderExistingForm(host, { onSubmit({ kwDc, nem, since }), onCancel, initial: { kwDc, nem, since } })
 * nem is "nem2" (the default) or "nem1".
 */
export function renderExistingForm(host, options = {}) {
  const { onSubmit, onCancel } = options;
  const initial = options.initial || {};

  const kw = el("input", {
    type: "text", inputMode: "decimal", id: "existing-kw", placeholder: "6.4", autocomplete: "off",
    "aria-describedby": "existing-kw-note",
  });
  if (Number.isFinite(initial.kwDc) && initial.kwDc > 0) kw.value = String(initial.kwDc);
  const nem = el("select", { id: "existing-nem" }, [
    el("option", { value: "nem2", text: "NEM 2 (most systems installed 2016 to April 2023)" }),
    el("option", { value: "nem1", text: "NEM 1 (installed before 2016 or so)" }),
  ]);
  nem.value = initial.nem === "nem1" ? "nem1" : "nem2";
  const now = new Date().getFullYear();
  const defaultSince = () => (nem.value === "nem1" ? 2013 : 2019);
  const since = el("input", {
    type: "text", inputMode: "numeric", id: "existing-since", autocomplete: "off", maxLength: 4,
    "aria-describedby": "existing-since-note existing-since-ended",
  });
  since.value = String(Number.isInteger(initial.since) ? initial.since : defaultSince());
  let sinceTyped = Number.isInteger(initial.since);
  const ended = el("p.ctl-note", { id: "existing-since-ended", hidden: true,
    text: "That agreement has already ended, so the whole plan is priced under Net Billing." });
  const showEnded = () => {
    const v = parseYear(since.value);
    ended.hidden = !(Number.isInteger(v) && v >= SINCE_MIN && v <= now && v + TERM_YEARS <= now);
  };
  showEnded();
  const error = el("p.field-error", { role: "alert", hidden: true });

  const ok = () => { error.hidden = true; error.textContent = ""; };
  const fail = (msg, field = kw) => { error.textContent = msg; error.hidden = false; field.focus(); return null; };

  function collect() {
    const v = parseKw(kw.value);
    const why = kwProblem(v);
    if (why) return fail(why);
    const yr = parseYear(since.value);
    const yWhy = sinceProblem(yr, now);
    if (yWhy) return fail(yWhy, since);
    ok();
    return { kwDc: Math.round(v * 100) / 100, nem: nem.value === "nem1" ? "nem1" : "nem2", since: yr };
  }
  function submit() {
    const spec = collect();
    if (spec && onSubmit) onSubmit(spec);
  }

  kw.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  since.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  kw.addEventListener("input", () => { if (!error.hidden) ok(); });
  since.addEventListener("input", () => { sinceTyped = true; if (!error.hidden) ok(); showEnded(); });
  nem.addEventListener("change", () => { if (!sinceTyped) { since.value = String(defaultSince()); showEnded(); } });

  clear(host);
  host.appendChild(el("div.existing-form", {}, [
    el("div", {}, [
      el("label.field-lab", { htmlFor: "existing-kw", text: "Size of the solar you already have, in kW DC" }),
      el("div.field-row", {}, [kw, el("span", { text: "kW" })]),
      el("p.ctl-note", {
        id: "existing-kw-note",
        text: "It is on your interconnection paperwork or the installer's contract. "
          + "Panel count times panel watts, divided by 1000, is close enough.",
      }),
    ]),
    el("div", {}, [
      el("label.field-lab", { htmlFor: "existing-nem", text: "Which net metering plan you are on" }),
      nem,
      el("p.ctl-note", {
        text: "Your bill or the utility's permission-to-operate letter names it. Not sure? NEM 2 is the usual answer.",
      }),
    ]),
    el("div", {}, [
      el("label.field-lab", { htmlFor: "existing-since", text: "Year it was switched on" }),
      el("div.field-row", {}, [since]),
      el("p.ctl-note", {
        id: "existing-since-note",
        text: "NEM 1 and NEM 2 last 20 years from the day the utility let the array switch on. "
          + "After that the same panels are billed under Net Billing.",
      }),
      ended,
    ]),
    error,
    el("div.existing-actions", {}, [
      el("button.btn.btn-primary", { type: "button", text: "Model a battery", on: { click: submit } }),
      el("button.btn", { type: "button", text: "Cancel", on: { click: () => { if (onCancel) onCancel(); } } }),
    ]),
  ]));

  return { focus: () => kw.focus(), collect };
}

export default { renderExistingForm, parseKw, kwProblem, parseYear, sinceProblem, KW_MIN, KW_MAX };
