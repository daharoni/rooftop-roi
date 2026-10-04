/* =============================================================================
 * billform.js — twelve monthly kWh figures instead of a meter file.
 *
 * For the visitor who has a paper bill but no Green Button download.  The form
 * only gathers and validates; turning twelve numbers into an hourly series is
 * the synthesiser's job, and main.js owns that call.  Validation is inline
 * (one .field-error line) because an alert() on a public page reads as a bug.
 * ========================================================================== */

import { el, clear } from "./dom.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Blank is not zero: an empty cell is an error, a typed 0 is a month away. */
function parseKwh(text) {
  const t = String(text).trim().replace(/,/g, "");
  if (t === "") return NaN;
  return Number(t);
}

const roundKwh = (v) => Math.round(v * 10) / 10;

/**
 * renderBillForm(host, { onSubmit(spec), onBack, onSplit(annual) -> number[12], seasonalSplit })
 * spec = { monthlyKwh: number[12], zip, ev, pool }.
 * `seasonalSplit` (the integrator's shaped split) wins over `onSplit`; with neither,
 * the annual total is divided evenly.
 */
export function renderBillForm(host, options = {}) {
  const { onSubmit, onBack } = options;
  const split = options.seasonalSplit || options.onSplit
    || ((annual) => Array.from({ length: 12 }, () => annual / 12));

  const cells = MONTHS.map((m, i) => el("input", {
    type: "text", inputMode: "numeric", id: "bill-m" + i, placeholder: "kWh", autocomplete: "off",
    "aria-label": m + " kWh",
  }));
  const every = el("input", { type: "text", inputMode: "numeric", id: "bill-every", placeholder: "kWh", autocomplete: "off" });
  const yearly = el("input", { type: "text", inputMode: "numeric", id: "bill-annual", placeholder: "kWh per year", autocomplete: "off" });
  const zip = el("input", { type: "text", id: "bill-zip", inputMode: "numeric", pattern: "[0-9]{5}", placeholder: "91301", maxLength: 5, autocomplete: "postal-code" });
  const ev = el("input", { type: "checkbox", id: "bill-ev" });
  const pool = el("input", { type: "checkbox", id: "bill-pool" });
  const error = el("p.field-error", { role: "alert", hidden: true });

  const fail = (msg, focus) => {
    error.textContent = msg;
    error.hidden = false;
    if (focus && focus.focus) focus.focus();
    return null;
  };
  const ok = () => { error.hidden = true; error.textContent = ""; };

  function fillAll(values) { values.forEach((v, i) => { cells[i].value = String(roundKwh(v)); }); ok(); }

  function applyEvery() {
    const v = parseKwh(every.value);
    if (!Number.isFinite(v) || v < 0) return fail("Enter one monthly figure in kWh, like 650.", every);
    fillAll(Array(12).fill(v));
  }
  function applyYearly() {
    const v = parseKwh(yearly.value);
    if (!Number.isFinite(v) || v <= 0) return fail("Enter your yearly total in kWh, like 9000.", yearly);
    const out = split(v);
    if (!Array.isArray(out) || out.length !== 12) return fail("Could not spread that total across the year.", yearly);
    fillAll(out);
  }

  function collect() {
    const kwh = [];
    for (let i = 0; i < 12; i++) {
      const v = parseKwh(cells[i].value);
      if (!Number.isFinite(v) || v < 0) return fail(`${MONTHS[i]} needs a number of kWh, zero or more.`, cells[i]);
      kwh.push(v);
    }
    if (!kwh.some((v) => v > 0)) return fail("At least one month has to use some electricity.", cells[0]);
    const z = zip.value.trim();
    if (!/^\d{5}$/.test(z)) return fail("Enter a 5-digit ZIP code so we can find your utility and your sun.", zip);
    ok();
    return { monthlyKwh: kwh, zip: z, ev: ev.checked, pool: pool.checked };
  }

  function submit() {
    const spec = collect();
    if (spec && onSubmit) onSubmit(spec);
  }

  const enter = (fn) => (e) => { if (e.key === "Enter") { e.preventDefault(); fn(); } };
  cells.forEach((c) => c.addEventListener("keydown", enter(submit)));
  zip.addEventListener("keydown", enter(submit));
  every.addEventListener("keydown", enter(applyEvery));
  yearly.addEventListener("keydown", enter(applyYearly));
  // Clear a stale error as soon as the person starts correcting it.
  for (const n of [...cells, zip]) n.addEventListener("input", () => { if (!error.hidden) ok(); });

  clear(host);
  host.appendChild(el("div.billform", {}, [
    el("div.dropzone-title", { text: "Type in twelve monthly bills" }),
    el("p.dropzone-note", { text: "Read the kWh used off each bill, one box per month, most recent twelve." }),

    el("div.bill-helpers", {}, [
      el("div.bill-helper", {}, [
        el("label.field-lab", { htmlFor: "bill-every", text: "Same every month" }),
        el("div.field-row", {}, [every, el("button.btn", { type: "button", text: "Fill all", on: { click: applyEvery } })]),
      ]),
      el("div.bill-helper", {}, [
        el("label.field-lab", { htmlFor: "bill-annual", text: "I only know my yearly total" }),
        el("div.field-row", {}, [yearly, el("button.btn", { type: "button", text: "Spread it", on: { click: applyYearly } })]),
      ]),
    ]),

    el("div.bill-grid", {}, MONTHS.map((m, i) => el("div.bill-cell", {}, [
      el("label", { htmlFor: "bill-m" + i, text: m }),
      cells[i],
    ]))),

    el("div.bill-zip", {}, [
      el("label.field-lab", { htmlFor: "bill-zip", text: "ZIP code" }),
      zip,
    ]),

    el("div.bill-checks", {}, [
      el("label.bill-check", { htmlFor: "bill-ev" }, [ev, " We charge an EV at home"]),
      el("label.bill-check", { htmlFor: "bill-pool" }, [pool, " We have a pool pump"]),
    ]),

    el("p.ctl-note", {
      text: "Bills give a rougher answer than a Green Button file. A bill says how much you used each month "
        + "but not when, so the hour-by-hour shape is estimated, and the battery and time-of-use results "
        + "lean on that estimate. Add a meter file later for the real thing.",
    }),

    error,

    el("div.bill-actions", {}, [
      el("button.btn.btn-primary.btn-lg", { type: "button", text: "Build my year", on: { click: submit } }),
      el("button.btn-link", { type: "button", text: "Back", on: { click: () => { if (onBack) onBack(); } } }),
    ]),
  ]));

  return { focus: () => cells[0].focus(), collect };
}

export default { renderBillForm };
