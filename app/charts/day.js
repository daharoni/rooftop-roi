/* =============================================================================
 * charts/day.js — a typical weekday, hour by hour, plus the week of load
 * reshaping on the Loads tab.
 *
 * The day chart stacks who served the house (solar / battery / grid) as areas
 * and draws production, export and flexible load as lines over the top: the
 * stack answers "where did my kWh come from", the lines answer "what did the
 * array and the car do", and both share one kWh axis.  The tariff period in
 * force is a ribbon under the axis rather than a second scale.
 * ========================================================================== */

import { $, el, clear, T, alpha } from "../ui/dom.js";
import { fmtNum, fmtPct } from "../ui/format.js";
import { draw, baseOpts, legendHTML } from "./base.js";

const PERIOD_NAMES = { on: "On-peak", mid: "Mid-peak", off: "Off-peak", super_off: "Super-off-peak" };
const periodColors = () => ({ on: T.s8, mid: T.s2, off: T.s4, super_off: T.s3 });

export function renderTypicalDay({ day, schedule, flexLabel }) {
  if (!day || !day.hours) return;
  const hours = day.hours;
  const labels = hours.map((h) => String(h.hour).padStart(2, "0"));
  const pvToLoad = hours.map((h) => Math.min(h.pv || 0, h.load || 0));

  draw("c-day", {
    type: "line",
    data: {
      labels,
      datasets: [
        area("Load served by solar", pvToLoad, T.s4),
        area("by battery", hours.map((h) => h.discharge || 0), T.s3),
        area("by the grid", hours.map((h) => h.gridImport || 0), T["ink-3"], 0.4),
        line("Solar produced", hours.map((h) => h.pv || 0), T.s2),
        line("Exported", hours.map((h) => h.gridExport || 0), T.s1, [4, 3]),
        line(flexLabel || "Flexible load", hours.map((h) => h.flex ?? h.ev ?? 0), T.s7),
      ],
    },
    options: baseOpts({
      scales: {
        y: { stacked: false, beginAtZero: true, ticks: { callback: (v) => v + " kWh" } },
      },
      plugins: {
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmtNum(c.parsed.y, 2) + " kWh" } },
      },
    }),
  });

  legendHTML("l-day", [
    { label: "Load served by solar", color: alpha(T.s4, 0.55) },
    { label: "by battery", color: alpha(T.s3, 0.55) },
    { label: "by the grid", color: alpha(T["ink-3"], 0.4) },
    { label: "Solar produced", color: T.s2, line: true },
    { label: "Exported", color: T.s1, line: true },
    { label: flexLabel || "Flexible load", color: T.s7, line: true },
  ]);

  draw("c-soc", {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Battery state of charge", data: hours.map((h) => (h.soc || 0) * 100),
        borderColor: T.s3, backgroundColor: alpha(T.s3, 0.12), fill: true, borderWidth: 2,
      }],
    },
    options: baseOpts({
      scales: { y: { min: 0, max: 100, ticks: { stepSize: 50, callback: (v) => v + "%" } } },
      plugins: { tooltip: { callbacks: { label: (c) => " state of charge: " + c.parsed.y.toFixed(0) + "%" } } },
    }),
  });

  const ribbon = $("period-ribbon");
  if (ribbon && schedule) {
    clear(ribbon);
    const cols = periodColors();
    for (const p of schedule) {
      ribbon.appendChild(el("span", {
        title: PERIOD_NAMES[p] || p,
        style: `flex:1;background:${cols[p] || T.grid}`,
      }));
    }
  }

  const table = $("t-day");
  if (!table) return;
  clear(table);
  table.appendChild(el("thead", {}, [el("tr", {}, [
    "Hour", "Load", "Flexible", "Solar", "Batt in", "Batt out", "Import", "Export", "SOC",
  ].map((h, i) => el(i === 0 ? "th" : "th.n", { text: h })))]));
  table.appendChild(el("tbody", {}, hours.map((h) => el("tr", {}, [
    el("td.n", { text: String(h.hour).padStart(2, "0") + ":00" }),
    ...[h.load, h.flex ?? h.ev, h.pv, h.charge, h.discharge, h.gridImport, h.gridExport]
      .map((v) => el("td.n", { text: fmtNum(v || 0, 2) })),
    el("td.n", { text: fmtPct(h.soc || 0, 0) }),
  ]))));
}

function area(label, data, color, a = 0.55) {
  return {
    label, data, borderColor: "transparent", backgroundColor: alpha(color, a),
    fill: "origin", stack: "served", borderWidth: 0, pointRadius: 0, tension: 0.2,
  };
}

function line(label, data, color, dash) {
  return {
    label, data, borderColor: color, backgroundColor: "transparent", fill: false,
    borderWidth: 2, borderDash: dash, pointRadius: 0, tension: 0.2,
  };
}

/**
 * The Loads tab's before/after: one typical week of household draw, as
 * recorded and as rescheduled.  Energy is conserved exactly, so the two
 * curves enclose the same area — what moves is when.
 */
export function renderWeek({ before, after, hourLabels }) {
  if (!before || !after) return;
  const labels = hourLabels || before.map((_, i) => (i % 24 === 12 ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Math.floor(i / 24)] : ""));
  draw("c-week", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "As recorded", data: before, borderColor: alpha(T["ink-3"], 0.9), borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0.2 },
        { label: "As scheduled", data: after, borderColor: T.s1, backgroundColor: alpha(T.s1, 0.12), borderWidth: 2, pointRadius: 0, fill: true, tension: 0.2 },
      ],
    },
    options: baseOpts({
      scales: {
        x: { ticks: { autoSkip: false, font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { callback: (v) => v + " kWh" } },
      },
      plugins: { tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmtNum(c.parsed.y, 2) + " kWh" } } },
    }),
  });
  legendHTML("l-week", [
    { label: "As recorded", color: alpha(T["ink-3"], 0.9), line: true },
    { label: "As scheduled", color: T.s1, line: true },
  ]);
}

export default { renderTypicalDay, renderWeek };
