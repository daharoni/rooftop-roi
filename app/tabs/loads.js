/* =============================================================================
 * tabs/loads.js — the flexible loads, and when they are allowed to happen.
 *
 * A detected load is a card: what the detector found, how confident it is, and
 * the schedule controls that move it.  Energy is conserved exactly — a week's
 * kWh is a week's kWh whatever the schedule — so the chart at the bottom is a
 * genuine before/after of timing, not of consumption.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card, kv } from "../ui/blocks.js";
import { fmtKwh, fmtNum, fmtPct, fmtHour } from "../ui/format.js";
import { renderWeek } from "../charts/day.js";

export const id = "loads";
export const label = "Loads";

export const PRESETS = {
  ev2:  { kind: "ev", name: "Second EV", annualKwh: 3000, maxKW: 7.7, mode: "spread", window: [9, 16] },
  pool: { kind: "pool", name: "Pool pump", annualKwh: 2400, maxKW: 1.5, mode: "spread", window: [10, 16] },
  hpwh: { kind: "custom", name: "Heat-pump water heater", annualKwh: 1400, maxKW: 4.5, mode: "spread", window: [10, 16] },
  laundry: { kind: "custom", name: "Laundry", annualKwh: 600, maxKW: 3, mode: "spread", window: [10, 17] },
};

export function rail(state) {
  return [
    { group: "The rest of the house", open: true, items: [
      { path: "baseLoadScale", kind: "range", label: "Everything else, vs. today", min: 0.5, max: 2, step: 0.05, pct: 0,
        note: "Scales the household load left after the flexible loads below are taken out — a bigger family, "
          + "a heat pump swap, a lighter year." },
    ] },
    { group: "Add a load", open: true, items: [
      { path: "ui.addPreset", kind: "select", label: "Preset", opts: [
        { v: "", t: "Choose…" },
        { v: "ev2", t: "Second EV — 3,000 kWh/yr" },
        { v: "pool", t: "Pool pump — 2,400 kWh/yr" },
        { v: "hpwh", t: "Heat-pump water heater — 1,400 kWh/yr" },
        { v: "laundry", t: "Laundry — 600 kWh/yr" },
        { v: "custom", t: "Something else" },
      ] },
    ] },
    { group: "Comparison", open: true, items: [
      { path: "ui.basis", kind: "select", label: "Compare the bill against", opts: [
        { v: "sameFlex", t: "No system, same load schedule" },
        { v: "asRecorded", t: "Today's actual bill" }] },
    ] },
  ];
}

export function mount(pane) {
  clear(pane);

  pane.appendChild(card({
    id: "loads-cards-card",
    title: "Flexible loads",
    tag: { id: "loads-count-tag", text: "—" },
    sub: "Loads big enough and schedulable enough to move into the sun. The detector reads them out of your "
      + "meter history; anything it missed you can add by hand.",
    body: [el("div.loadcards", { id: "loadcards" })],
  }));

  pane.appendChild(card({
    id: "loads-week-card",
    title: "A typical week, before and after",
    sub: "The same energy, redistributed. The dotted line is what your meter recorded; the filled line is what "
      + "the simulation charges you for.",
    body: [
      el("div.chart-box", { style: "height:230px" }, [el("canvas", { id: "c-week" })]),
      el("div.legend", { id: "l-week" }),
      el("p.note", { id: "week-note" }),
    ],
  }));
}

export function render(state, ctx) {
  const host = clear($("loadcards"));
  const tag = $("loads-count-tag");
  const flex = state.flex || [];

  if (tag) {
    const detected = flex.filter((f) => f.source === "detected").length;
    tag.textContent = flex.length
      ? `${flex.length} total · ${detected} detected`
      : "none yet";
  }

  if (!flex.length) {
    host.appendChild(el("p.note", {
      text: "Nothing flexible was detected in your meter history, and you have not added anything. "
        + "Solar still pays for itself against the load you have — flexible loads just make it pay more.",
    }));
  }

  for (const load of flex) host.appendChild(loadCard(load, state, ctx));
  host.appendChild(addCard(ctx));

  if (ctx.week) {
    renderWeek({ before: ctx.week.before, after: ctx.week.after, hourLabels: ctx.week.labels });
    const note = $("week-note");
    if (note) {
      note.textContent = `Week of ${ctx.week.label}. `
        + `${fmtKwh(ctx.week.totalBefore, 1)} recorded, ${fmtKwh(ctx.week.totalAfter, 1)} scheduled — `
        + (Math.abs(ctx.week.totalBefore - ctx.week.totalAfter) < 0.05
          ? "the same energy, moved."
          : "the difference is the scaling you applied above.");
    }
  }
}

/** The empty slot at the end of the row: what else this house could be told to do. */
function addCard(ctx) {
  const options = [
    ["ev2", "Second EV", "3,600 kWh/yr, same schedule as the first"],
    ["pool", "Pool pump", "0.5 kW for 8 hours a day"],
    ["hpwh", "Heat-pump water heater", "4 kWh/day, heated at midday"],
    ["laundry", "Laundry and dishwasher", "3 kWh/day, moved off the evening peak"],
  ];
  return el("div.loadcard.loadcard-add", {}, [
    el("div.loadcard-head", {}, [el("strong", { text: "Add a load" })]),
    el("p.ctl-note", { text: "Anything you could run at a different hour. Add it, then reschedule it like the rest." }),
    el("div", { style: "display:flex;flex-direction:column;gap:6px" }, options.map(([id, name, detail]) =>
      el("button.btn", { type: "button", style: "text-align:left", on: { click: () => ctx.actions.addPreset(id) } }, [
        el("strong", { text: name }),
        el("span", { style: "color:var(--ink-3)", text: " — " + detail }),
      ]))),
  ]);
}

function loadCard(load, state, ctx) {
  const s = load.schedule || {};
  const set = (path, v) => ctx.actions.updateFlex(load.id, path, v);
  const det = load.detection;

  const facts = [];
  if (det) {
    if (det.sessions) facts.push(["Sessions", `${det.sessions.length} · ${fmtNum(det.sessions.length / Math.max(1, (ctx.weeks || 52)), 2)}/week`]);
    if (det.sessions && det.sessions.length) {
      const med = median(det.sessions.map((x) => x.kwh));
      facts.push(["Median session", fmtKwh(med, 1)]);
    }
    if (det.chargerKW) facts.push(["Charger", fmtNum(det.chargerKW, 1) + " kW inferred"]);
    if (det.confidence !== undefined) facts.push(["Confidence", fmtPct(det.confidence, 0)]);
  }
  facts.push(["Energy", fmtKwh(load.annualKwh * (load.scale ?? 1), 0) + "/yr"]);

  const spread = s.mode === "spread";

  return el("div.loadcard", {}, [
    el("div.loadcard-head", {}, [
      el("strong", { text: load.name }),
      el("span.tag" + (load.source === "detected" ? ".tag-good" : ""), { text: load.source === "detected" ? "detected" : "added" }),
    ]),
    kv(facts),
    el("div.loadcard-ctls", {}, [
      row("When it runs", el("select", { on: { change: (e) => set("schedule.mode", e.target.value) } }, [
        el("option", { value: "asRecorded", text: "As recorded", selected: !spread }),
        el("option", { value: "spread", text: "Spread over N days, in daylight", selected: spread }),
      ])),
      spread ? slider("Days a week", s.daysPerWeek ?? 5, 1, 7, 1, (v) => set("schedule.daysPerWeek", v), (v) => `${v} of 7`) : null,
      spread ? slider("Share in daylight", s.daylightFraction ?? 0.9, 0, 1, 0.05, (v) => set("schedule.daylightFraction", v), (v) => fmtPct(v, 0)) : null,
      spread ? slider("Window starts", s.window?.[0] ?? 8, 5, 14, 1,
        (v) => set("schedule.window", [v, Math.max(v + 1, s.window?.[1] ?? 15)]), fmtHour) : null,
      spread ? slider("Window ends", s.window?.[1] ?? 15, 10, 21, 1,
        (v) => set("schedule.window", [Math.min(v - 1, s.window?.[0] ?? 8), v]), fmtHour) : null,
      slider("Power cap", s.maxKW ?? 8, 0.5, 19.2, 0.1, (v) => set("schedule.maxKW", v), (v) => fmtNum(v, 1) + " kW"),
      slider("Scale", load.scale ?? 1, 0.25, 2, 0.05, (v) => set("scale", v), (v) => fmtPct(v, 0) + " of today"),
      spread ? el("label.switch", {}, [
        el("input", { type: "checkbox", checked: s.followSolar !== false,
          on: { change: (e) => set("schedule.followSolar", e.target.checked) } }),
        el("span", { text: "Weight the window by the solar shape" }),
      ]) : null,
      load.source === "manual"
        ? el("button.btn.btn-danger", { type: "button", text: "Remove this load", on: { click: () => ctx.actions.removeFlex(load.id) } })
        : null,
    ]),
  ]);
}

function row(labelText, control) {
  return el("div.ctl", {}, [el("div.ctl-head", {}, [el("label", { text: labelText })]), control]);
}

function slider(labelText, value, min, max, step, onInput, fmt) {
  const val = el("span.ctl-val", { text: fmt(value) });
  return el("div.ctl", {}, [
    el("div.ctl-head", {}, [el("label", { text: labelText }), val]),
    el("input", {
      type: "range", min, max, step, value,
      "aria-label": labelText,
      on: { input: (e) => { val.textContent = fmt(Number(e.target.value)); onInput(Number(e.target.value)); } },
    }),
  ]);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

export default { id, label, rail, mount, render, PRESETS };
